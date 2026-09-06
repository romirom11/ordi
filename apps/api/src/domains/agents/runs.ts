/**
 * Agent runs (plan 2026-09-05-001, R12-R16, R27-R33, R50). Queueing, claiming
 * with SKIP LOCKED, the per-run identity token, and the lifecycle that the
 * worker drives. The task page reads runs through the task's own visibility.
 */
import { getDb, schema, eq, and, desc, sql, inArray } from '@ordi/db';
import { ulid } from 'ulid';
import { AGENT_RUN_ACTIVE_STATUSES } from '@ordi/shared';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { generateToken, sha256 } from '../../lib/crypto';
import { writeActivity } from '../../core/activity';
import { emit } from '../../core/events';
import { loadRolePermissions } from '../../core/rbac';
import { assertProject } from '../../core/access';
import { recordRunEvent, listRunEvents } from './run-events';
import type { RuntimeUsage } from './runtime';

const { agentRuns, agentProfiles, apiTokens, users, tasks, comments } = schema;

export type RunRow = typeof agentRuns.$inferSelect;

export interface RunView {
  id: string;
  agentUserId: string;
  agentName: string;
  taskId: string;
  projectId: string;
  trigger: string;
  status: string;
  runtime: string;
  sessionId: string | null;
  parentRunId: string | null;
  requestedBy: string | null;
  commentId: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  branch: string | null;
  prUrl: string | null;
  summary: string | null;
  error: string | null;
  usage: Record<string, unknown>;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

function toView(row: RunRow & { agentName?: string | null }): RunView {
  return {
    id: row.id, agentUserId: row.agentUserId, agentName: row.agentName ?? '', taskId: row.taskId, projectId: row.projectId,
    trigger: row.trigger, status: row.status, runtime: row.runtime, sessionId: row.sessionId, parentRunId: row.parentRunId,
    requestedBy: row.requestedBy, commentId: row.commentId, attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null, branch: row.branch, prUrl: row.prUrl,
    summary: row.summary, error: row.error, usage: (row.usage as Record<string, unknown>) ?? {},
    claimedAt: row.claimedAt?.toISOString() ?? null, startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), version: row.version,
  };
}

export interface QueueRunInput {
  agentUserId: string;
  taskId: string;
  projectId: string;
  trigger: 'assigned' | 'comment' | 'retry' | 'manual';
  requestedBy: string | null;
  commentId?: string | null;
  parentRunId?: string | null;
  /** Session to resume (follow-ups and retries). */
  sessionId?: string | null;
  actorType?: 'user' | 'agent' | 'system' | 'integration';
}

/**
 * Queue a run unless the task already has an active one (R13). Returns the
 * run id, or null when coalesced – the active run's finalizer picks the
 * newer comments up as a follow-up.
 */
export async function queueRun(input: QueueRunInput): Promise<string | null> {
  const { db } = getDb();
  const [profile] = await db.select().from(agentProfiles).where(eq(agentProfiles.userId, input.agentUserId));
  if (!profile) return null;
  const id = ulid();
  try {
    await db.insert(agentRuns).values({
      id, agentUserId: input.agentUserId, taskId: input.taskId, projectId: input.projectId,
      trigger: input.trigger, status: 'queued', runtime: profile.runtime,
      requestedBy: input.requestedBy, commentId: input.commentId ?? null, parentRunId: input.parentRunId ?? null,
      sessionId: input.sessionId ?? null,
    });
  } catch (e) {
    // The partial unique index refuses a second active run per task.
    if ((e as { code?: string }).code === '23505') return null;
    throw e;
  }
  await recordRunEvent(id, 'status', { status: 'queued', trigger: input.trigger });
  await emit({
    type: 'agent.run_queued', aggregateType: 'agent_run', aggregateId: id,
    payload: { runId: id, taskId: input.taskId, projectId: input.projectId, agentUserId: input.agentUserId, trigger: input.trigger, requestedBy: input.requestedBy },
    actorId: input.requestedBy, actorType: input.actorType ?? 'system',
  });
  await writeActivity(db, {
    entityType: 'task', entityId: input.taskId, action: 'agent_run_queued',
    actorId: input.requestedBy, actorType: input.actorType ?? 'system', diff: { runId: id, agentUserId: input.agentUserId, trigger: input.trigger },
  });
  return id;
}

export async function activeRunForTask(taskId: string): Promise<RunRow | null> {
  const { db } = getDb();
  const [row] = await db.select().from(agentRuns)
    .where(and(eq(agentRuns.taskId, taskId), inArray(agentRuns.status, [...AGENT_RUN_ACTIVE_STATUSES])));
  return row ?? null;
}

/**
 * Claim due runs for a worker (R14): queued rows, or waiting_quota rows whose
 * retry time has come, while the agent stays under its concurrency.
 */
export async function claimRuns(workerId: string, limit: number): Promise<RunRow[]> {
  const out: RunRow[] = [];
  // One claim per statement: the per-agent concurrency count must see the
  // previous claim, which a single multi-row UPDATE would not.
  for (let i = 0; i < limit; i++) {
    const [row] = await claimOne(workerId);
    if (!row) break;
    out.push(row);
  }
  return out;
}

async function claimOne(workerId: string): Promise<RunRow[]> {
  const { db } = getDb();
  const rows = await db.execute(sql`
    with due as (
      select r.id
      from agent_runs r
      join agent_profiles p on p.user_id = r.agent_user_id
      join users u on u.id = r.agent_user_id
      where p.enabled and u.is_active
        and (
          (r.status = 'queued' and (r.next_attempt_at is null or r.next_attempt_at <= now()))
          or (r.status = 'waiting_quota' and r.next_attempt_at is not null and r.next_attempt_at <= now())
        )
        and (select count(*) from agent_runs a where a.agent_user_id = r.agent_user_id and a.status in ('claimed', 'running')) < p.concurrency
      order by r.created_at asc
      for update of r skip locked
      limit 1
    )
    update agent_runs as run
    set status = 'claimed', worker_id = ${workerId}, claimed_at = now(), attempts = run.attempts + 1, next_attempt_at = null
    from due
    where run.id = due.id
    returning run.*
  `) as unknown as Record<string, unknown>[];
  if (!rows.length) return [];
  const ids = rows.map((r) => String(r.id));
  return db.select().from(agentRuns).where(inArray(agentRuns.id, ids));
}

/** Mint the per-run identity (R27, KTD4): scope = the agent's role at run start. */
export async function startRun(runId: string): Promise<{ run: RunRow; token: string } | null> {
  const { db } = getDb();
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) throw err.notFound('Run not found');
  // Cancelled while the worker was still preparing the checkout: stay cancelled.
  if (run.status !== 'claimed') return null;
  const [agent] = await db.select().from(users).where(eq(users.id, run.agentUserId));
  if (!agent) throw err.notFound('Agent not found');
  const scopes = [...(await loadRolePermissions(agent.roleId))];
  const raw = `ordi_${generateToken(24)}`;
  const tokenId = ulid();
  await db.insert(apiTokens).values({
    id: tokenId, userId: agent.id, name: `agent run ${runId}`, hash: sha256(raw), prefix: raw.slice(0, 12), scopes, readOnly: false,
  });
  await db.update(agentRuns).set({ status: 'running', startedAt: new Date(), tokenId }).where(eq(agentRuns.id, runId));
  await recordRunEvent(runId, 'status', { status: 'running' });
  await emit({
    type: 'agent.run_started', aggregateType: 'agent_run', aggregateId: runId,
    payload: { runId, taskId: run.taskId, projectId: run.projectId, agentUserId: run.agentUserId },
    actorId: run.agentUserId, actorType: 'agent',
  });
  const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  return { run: after!, token: raw };
}

export async function revokeRunToken(run: Pick<RunRow, 'tokenId'>): Promise<void> {
  if (!run.tokenId) return;
  const { db } = getDb();
  await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, run.tokenId));
}

/** Liveness for the worker: a running row nobody touched for a while belongs to a dead worker. */
export async function touchRun(runId: string): Promise<void> {
  const { db } = getDb();
  await db.update(agentRuns).set({ updatedAt: new Date() }).where(eq(agentRuns.id, runId));
}

export interface FinishRunInput {
  status: 'succeeded' | 'failed' | 'needs_input' | 'cancelled';
  summary?: string | null;
  error?: string | null;
  sessionId?: string | null;
  branch?: string | null;
  prUrl?: string | null;
  usage?: Partial<RuntimeUsage> & { credentialId?: string | null };
}

export async function finishRun(runId: string, input: FinishRunInput): Promise<RunRow> {
  const { db } = getDb();
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) throw err.notFound('Run not found');
  await db.update(agentRuns).set({
    status: input.status, summary: input.summary ?? run.summary, error: input.error ?? null,
    sessionId: input.sessionId ?? run.sessionId, branch: input.branch ?? run.branch, prUrl: input.prUrl ?? run.prUrl,
    usage: { ...(run.usage as Record<string, unknown>), ...(input.usage ?? {}) },
    finishedAt: new Date(),
  }).where(eq(agentRuns.id, runId));
  await revokeRunToken(run);
  await recordRunEvent(runId, 'status', { status: input.status, error: input.error ?? null });
  await emit({
    type: input.status === 'needs_input' ? 'agent.needs_input' : 'agent.run_finished',
    aggregateType: 'agent_run', aggregateId: runId,
    payload: {
      runId, taskId: run.taskId, projectId: run.projectId, agentUserId: run.agentUserId, status: input.status,
      requestedBy: run.requestedBy, prUrl: input.prUrl ?? run.prUrl, error: input.error ?? null, summary: input.summary ?? null,
    },
    actorId: run.agentUserId, actorType: 'agent',
  });
  await writeActivity(db, {
    entityType: 'task', entityId: run.taskId, action: `agent_run_${input.status}`,
    actorId: run.agentUserId, actorType: 'agent', diff: { runId, prUrl: input.prUrl ?? null, error: input.error ?? null },
  });
  const [after] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  return after!;
}

/** R32: park the run until the provider's window resets; the claim query resumes it. */
export async function parkRunForQuota(runId: string, retryAt: Date, reason: string): Promise<void> {
  const { db } = getDb();
  const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
  if (!run) return;
  await revokeRunToken(run);
  await db.update(agentRuns).set({ status: 'waiting_quota', nextAttemptAt: retryAt, error: reason, tokenId: null, workerId: null })
    .where(eq(agentRuns.id, runId));
  await recordRunEvent(runId, 'status', { status: 'waiting_quota', retryAt: retryAt.toISOString(), reason });
}

/** Re-queue a run whose worker vanished (claimed/running rows nobody touched). */
export async function requeueStaleRuns(staleBefore: Date): Promise<number> {
  const { db } = getDb();
  const rows = await db.select().from(agentRuns)
    .where(and(inArray(agentRuns.status, ['claimed', 'running']), sql`${agentRuns.updatedAt} < ${staleBefore.toISOString()}::timestamptz`));
  for (const run of rows) {
    await revokeRunToken(run);
    if (run.attempts >= 3) {
      await finishRun(run.id, { status: 'failed', error: 'The worker running this run stopped responding' });
    } else {
      await db.update(agentRuns).set({ status: 'queued', workerId: null, tokenId: null, claimedAt: null, startedAt: null })
        .where(eq(agentRuns.id, run.id));
      await recordRunEvent(run.id, 'status', { status: 'queued', reason: 'worker lost' });
    }
  }
  return rows.length;
}

// ── Read side ──

export async function loadRun(id: string): Promise<RunRow> {
  const { db } = getDb();
  const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
  if (!row) throw err.notFound('Run not found');
  return row;
}

export async function listRuns(actor: Actor, filter: { taskId?: string; agentUserId?: string; status?: string; limit: number }): Promise<RunView[]> {
  const { db } = getDb();
  const conds = [] as ReturnType<typeof eq>[];
  if (filter.taskId) {
    const [task] = await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, filter.taskId));
    if (!task) throw err.notFound('Task not found');
    await assertProject(actor, task.projectId, 'viewer');
    conds.push(eq(agentRuns.taskId, filter.taskId));
  } else if (!actor.access.permissions.has('agents.manage')) {
    throw err.forbidden('Listing runs across tasks needs agents.manage', 'agents.manage');
  }
  if (filter.agentUserId) conds.push(eq(agentRuns.agentUserId, filter.agentUserId));
  if (filter.status) conds.push(eq(agentRuns.status, filter.status));
  const rows = await db.select({ run: agentRuns, agentName: users.name }).from(agentRuns)
    .leftJoin(users, eq(users.id, agentRuns.agentUserId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(agentRuns.createdAt)).limit(filter.limit);
  return rows.map((r) => toView({ ...r.run, agentName: r.agentName }));
}

export async function getRun(actor: Actor, id: string): Promise<RunView & { events: Awaited<ReturnType<typeof listRunEvents>> }> {
  const { db } = getDb();
  const run = await loadRun(id);
  await assertProject(actor, run.projectId, 'viewer');
  const [agent] = await db.select({ name: users.name }).from(users).where(eq(users.id, run.agentUserId));
  return { ...toView({ ...run, agentName: agent?.name }), events: await listRunEvents(id) };
}

export async function getRunEvents(actor: Actor, id: string, afterSeq: number) {
  const run = await loadRun(id);
  await assertProject(actor, run.projectId, 'viewer');
  return listRunEvents(id, afterSeq);
}

/** R50: cancel needs task write on the project or agents.manage. */
async function assertRunWrite(actor: Actor, run: RunRow): Promise<void> {
  if (actor.access.permissions.has('agents.manage')) {
    await assertProject(actor, run.projectId, 'viewer');
    return;
  }
  await assertProject(actor, run.projectId, 'member');
}

export async function cancelRun(actor: Actor, id: string): Promise<RunView> {
  const run = await loadRun(id);
  await assertRunWrite(actor, run);
  if (!(AGENT_RUN_ACTIVE_STATUSES as readonly string[]).includes(run.status)) throw err.domain('The run is not active');
  const { db } = getDb();
  if (run.status === 'running') {
    // The worker polls for this and aborts; finalization happens there.
    await db.update(agentRuns).set({ error: 'cancel requested' }).where(eq(agentRuns.id, id));
    await recordRunEvent(id, 'status', { status: 'cancel_requested', by: actor.userId });
    return toView((await loadRun(id)));
  }
  await revokeRunToken(run);
  await finishRun(id, { status: 'cancelled', error: 'cancelled' });
  return toView(await loadRun(id));
}

export async function retryRun(actor: Actor, id: string): Promise<RunView> {
  const run = await loadRun(id);
  await assertRunWrite(actor, run);
  if ((AGENT_RUN_ACTIVE_STATUSES as readonly string[]).includes(run.status)) throw err.domain('The run is still active');
  const newId = await queueRun({
    agentUserId: run.agentUserId, taskId: run.taskId, projectId: run.projectId, trigger: 'retry',
    requestedBy: actor.userId, parentRunId: run.id, sessionId: run.sessionId, actorType: actor.actorType,
  });
  if (!newId) throw err.domain('The task already has an active run');
  return toView(await loadRun(newId));
}

/** Is a cancel pending for a running run? Polled by the worker. */
export async function cancelRequested(runId: string): Promise<boolean> {
  const { db } = getDb();
  const [row] = await db.select({ status: agentRuns.status, error: agentRuns.error }).from(agentRuns).where(eq(agentRuns.id, runId));
  return !row || row.status === 'cancelled' || row.error === 'cancel requested';
}

/**
 * Follow-up coalescing (R13, R30): after a run ends, a human comment written
 * while it ran becomes the next run's prompt.
 */
export async function newestHumanCommentSince(taskId: string, since: Date | null, agentUserId: string) {
  const { db } = getDb();
  const rows = await db.select({ id: comments.id, authorId: comments.authorId, createdAt: comments.createdAt })
    .from(comments)
    .where(and(eq(comments.taskId, taskId), sql`${comments.deletedAt} is null`, since ? sql`${comments.createdAt} > ${since.toISOString()}::timestamptz` : sql`true`))
    .orderBy(desc(comments.createdAt)).limit(5);
  return rows.find((r) => r.authorId && r.authorId !== agentUserId) ?? null;
}
