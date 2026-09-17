/**
 * The platform's side of a run (plan 2026-09-05-001, R14, R16, R26-R35):
 * everything a worker needs that lives in the database or behind a secret.
 * Claiming, the bundle of facts and credentials a run starts from, the run
 * token and the brief, the event log, and what a finished run means for the
 * task - the comment, the status move, the follow-up.
 *
 * `localRunBackend` is this module as a RunBackend for the worker inside the
 * API process; the worker routes expose the same functions over HTTP for a
 * worker process that has no database.
 */
import { getDb, schema, eq, sql } from '@ordi/db';
import { docToText, textToDoc } from '@ordi/shared';
import { env } from '../../env';
import { logger } from '../../lib/logger';
import type { Actor } from '../../context';
import { buildAccessContext } from '../../core/access';
import { loadRolePermissions } from '../../core/rbac';
import { loadRuntimeCredential, resolveCredentialChain } from './credentials';
import { secretValues } from './connectors';
import { closeRunConnections } from './gateway';
import { buildRulesOfEngagement, buildTaskBrief, type PromptContext } from './prompt';
import { resolveRepository } from './repository';
import { forgetRunScope, forgetRunSecrets, recordRunEvent, registerRunScope, registerRunSecrets } from './run-events';
import {
  cancelRequested, claimRuns, finishRun, loadRun, newestHumanCommentSince, parkRunForQuota, queueRun,
  recordRunProgress, requeueStaleRuns, startRun, touchRun, type RunRow,
} from './runs';
import type { ClaimedRun, ParkInput, RunBackend, RunBundle, RunReport, RunStart, StartInput, WorkerInfo } from './run-backend';
import * as tasksSvc from '../projects/service';

const { agentProfiles, agentWorkers, users, tasks, projects, taskStatuses, agentConnectors, mcpConnectors } = schema;

const HEARTBEAT_MS = 15_000;
const STALE_RUN_MS = 3 * 60_000;
const QUOTA_RETRY_DEFAULT_MS = 30 * 60_000;

// ── Workers ──

export async function heartbeat(info: WorkerInfo): Promise<void> {
  const { db } = getDb();
  // Rows are keyed by host:pid; a restarted process leaves its old row behind.
  await db.delete(agentWorkers).where(sql`${agentWorkers.lastSeenAt} < now() - interval '10 minutes'`);
  await db.insert(agentWorkers).values({
    id: info.workerId, concurrency: info.concurrency, running: info.running, runtimeAvailable: info.runtimeAvailable, version: info.version,
  }).onConflictDoUpdate({
    target: agentWorkers.id,
    set: { lastSeenAt: new Date(), running: info.running, concurrency: info.concurrency, runtimeAvailable: info.runtimeAvailable, version: info.version },
  });
}

/** Workers not seen for a while are dropped from the status list. */
export async function listWorkers() {
  const { db } = getDb();
  const rows = await db.select().from(agentWorkers);
  const cutoff = Date.now() - 2 * HEARTBEAT_MS - 5_000;
  return rows.map((w) => ({
    id: w.id, startedAt: w.startedAt.toISOString(), lastSeenAt: w.lastSeenAt.toISOString(),
    concurrency: w.concurrency, running: w.running, runtimeAvailable: w.runtimeAvailable, version: w.version,
    online: w.lastSeenAt.getTime() >= cutoff,
  }));
}

// ── Actors and statuses ──

/**
 * An Actor for a user row, so the platform can comment and move status
 * through the services as the agent. The actor type comes from the row: an
 * agent user acts as 'agent' (which the services and consumers treat
 * differently from a person), anyone else as 'user'.
 */
export async function agentActor(userId: string): Promise<Actor> {
  const { db } = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) throw new Error('Agent user not found');
  const permissions = await loadRolePermissions(user.roleId);
  const access = await buildAccessContext(user.id, permissions, false);
  return {
    userId: user.id, actorType: user.actorType === 'agent' ? 'agent' : 'user', roleId: user.roleId, roleName: '', email: user.email, name: user.name,
    locale: user.locale, timezone: user.timezone, readOnly: false, tokenScopes: null, access,
  };
}

/**
 * KTD8: where a finished task lands. ordi has no "in_review" status category
 * (statuses are backlog/todo/in_progress/done/canceled), so "in_review" means
 * the project's review status by name, else the last in-progress status, else
 * nothing – the task then keeps its status and the comment says so.
 */
export async function completionStatus(projectId: string, category: string): Promise<{ id: string; name: string } | null> {
  const { db } = getDb();
  const rows = await db.select({ id: taskStatuses.id, name: taskStatuses.name, category: taskStatuses.category, position: taskStatuses.position })
    .from(taskStatuses).where(eq(taskStatuses.projectId, projectId)).orderBy(taskStatuses.position);
  if (category === 'in_review') {
    const byName = rows.find((s) => s.category !== 'done' && s.category !== 'canceled' && /review|рев'?ю|перевір/i.test(s.name));
    if (byName) return byName;
    const inProgress = rows.filter((s) => s.category === 'in_progress');
    return inProgress.length ? inProgress[inProgress.length - 1]! : null;
  }
  return rows.find((s) => s.category === category) ?? null;
}

async function postComment(actor: Actor, taskId: string, text: string): Promise<void> {
  await tasksSvc.addComment(actor, taskId, { body: textToDoc(text), mentions: [] });
}

// ── The run, from the worker's side ──

export function toClaimedRun(row: RunRow): ClaimedRun {
  return {
    id: row.id, taskId: row.taskId, projectId: row.projectId, agentUserId: row.agentUserId, trigger: row.trigger,
    sessionId: row.sessionId, branch: row.branch, prUrl: row.prUrl, commentId: row.commentId,
  };
}

interface RunSetup {
  run: RunRow;
  profile: typeof agentProfiles.$inferSelect;
  agent: typeof users.$inferSelect;
  task: typeof tasks.$inferSelect;
  project: typeof projects.$inferSelect;
  connectors: { id: string; slug: string; secrets: string | null; status: string }[];
}

async function loadSetup(run: RunRow): Promise<RunSetup> {
  const { db } = getDb();
  const [profile] = await db.select().from(agentProfiles).where(eq(agentProfiles.userId, run.agentUserId));
  const [agent] = await db.select().from(users).where(eq(users.id, run.agentUserId));
  const [task] = await db.select().from(tasks).where(eq(tasks.id, run.taskId));
  const [project] = await db.select().from(projects).where(eq(projects.id, run.projectId));
  if (!profile || !agent || !task || !project) throw new Error('Run setup is incomplete (agent, task or project missing)');
  const grants = await db.select({ id: mcpConnectors.id, slug: mcpConnectors.slug, secrets: mcpConnectors.secrets, status: mcpConnectors.status })
    .from(agentConnectors).innerJoin(mcpConnectors, eq(mcpConnectors.id, agentConnectors.connectorId))
    .where(eq(agentConnectors.agentUserId, run.agentUserId));
  return { run, profile, agent, task, project, connectors: grants.filter((g) => g.status === 'active') };
}

/**
 * Secrets handed to a run at `prepare`, kept until `start` registers them
 * for scrubbing together with the run token. Per process: the replica that
 * prepared the run is the one that starts it.
 */
const secretsPending = new Map<string, string[]>();

export async function claim(workerId: string, limit: number): Promise<ClaimedRun[]> {
  await requeueStaleRuns(new Date(Date.now() - STALE_RUN_MS)).catch((e) => logger.warn({ err: e }, 'stale run sweep failed'));
  const rows = await claimRuns(workerId, limit);
  return rows.map(toClaimedRun);
}

export async function prepare(runId: string): Promise<RunBundle> {
  const run = await loadRun(runId);
  const setup = await loadSetup(run);
  const { profile, agent, task, project } = setup;
  registerRunScope(runId, { projectId: project.id, taskId: task.id });

  const credentials: RunBundle['credentials'] = [];
  for (const id of await resolveCredentialChain(profile)) {
    const cred = await loadRuntimeCredential(id);
    if (cred) credentials.push({ id, kind: cred.kind, secret: cred.secret });
  }
  const repo = await resolveRepository(project.id);
  secretsPending.set(runId, [
    ...credentials.map((c) => c.secret),
    repo?.token ?? '',
    ...setup.connectors.flatMap((c) => secretValues(c)),
  ]);

  return {
    run: toClaimedRun(run),
    runtime: profile.runtime as 'claude_code' | 'codex',
    profile: {
      model: profile.model, maxTurns: profile.maxTurns, maxRunMinutes: profile.maxRunMinutes,
      maxBudgetUsd: profile.maxBudgetUsd != null ? Number(profile.maxBudgetUsd) : null,
      completionCategory: profile.completionCategory, instructions: profile.instructions,
    },
    agent: { id: agent.id, name: agent.name, email: agent.email },
    task: { id: task.id, number: task.number, title: task.title, description: docToText(task.description) },
    project: { id: project.id, key: project.key, name: project.name },
    connectors: setup.connectors.map((c) => c.slug),
    credentials,
    repo,
    taskUrl: `${env.appUrl.replace(/\/$/, '')}/projects/${project.id}/tasks/${task.id}`,
  };
}

export async function start(runId: string, input: StartInput): Promise<RunStart | null> {
  // Written now, not at the end: a worker lost mid-run leaves a row the re-queued run continues from.
  await recordRunProgress(runId, { branch: input.branch });
  const started = await startRun(runId);
  if (!started) {
    secretsPending.delete(runId);
    return null; // cancelled during preparation
  }
  const { profile, agent, task, project, connectors } = await loadSetup(started.run);
  const status = await completionStatus(project.id, profile.completionCategory);
  const ctx: PromptContext = {
    taskId: task.id, ref: `${project.key}-${task.number}`, title: task.title, projectKey: project.key, projectName: project.name,
    completionCategory: profile.completionCategory, completionStatusName: status?.name ?? null,
    branch: input.branch, repoFullName: input.repoFullName, agentName: agent.name, instructions: profile.instructions,
    followUpCommentId: started.run.trigger === 'comment' ? started.run.commentId : null,
    resumedAfterStop: started.run.trigger === 'retry' && Boolean(started.run.sessionId),
    connectorSlugs: connectors.map((c) => c.slug),
    pullRequestTemplate: input.pullRequestTemplate,
  };
  registerRunSecrets(runId, [...(secretsPending.get(runId) ?? []), started.token]);
  secretsPending.delete(runId);
  return {
    token: started.token,
    prompt: await buildTaskBrief(ctx),
    promptIfSessionLost: await buildTaskBrief({ ...ctx, sessionLost: true }),
    systemAppend: buildRulesOfEngagement(ctx),
  };
}

export async function repository(runId: string) {
  const run = await loadRun(runId);
  return resolveRepository(run.projectId);
}

/** Whatever the run held in this process goes when it ends, however it ends. */
async function release(runId: string): Promise<void> {
  secretsPending.delete(runId);
  forgetRunSecrets(runId);
  forgetRunScope(runId);
  await closeRunConnections(runId).catch(() => {});
}

export async function park(runId: string, input: ParkInput): Promise<void> {
  await parkRunForQuota(runId, new Date(input.retryAt), input.reason, { sessionId: input.sessionId, branch: input.branch });
  await release(runId);
}

export async function fail(runId: string, error: string): Promise<void> {
  await recordRunEvent(runId, 'error', { message: error }).catch(() => {});
  await finishRun(runId, { status: 'failed', error }).catch((e) => logger.warn({ err: e, runId }, 'could not record the failed run'));
  await release(runId);
}

/**
 * What a finished run means for the task: the result in the log, a comment
 * from the agent, the status move, the follow-up from a comment written
 * meanwhile. The worker only reports; the platform decides.
 */
export async function finish(runId: string, report: RunReport): Promise<void> {
  try {
    await finalize(runId, report);
  } catch (e) {
    await recordRunEvent(runId, 'error', { message: `Finalizing the run failed: ${(e as Error).message}` }).catch(() => {});
    await finishRun(runId, {
      status: 'failed', error: (e as Error).message, sessionId: report.outcome.sessionId,
      branch: report.publish?.pushed ? report.branch : null,
      usage: { ...report.outcome.usage, credentialId: report.usedCredentialId },
    }).catch((err) => logger.warn({ err, runId }, 'could not record the failed run'));
  } finally {
    await release(runId);
  }
}

async function finalize(runId: string, report: RunReport): Promise<void> {
  const { outcome, usedCredentialId, aborted, publish } = report;
  const run = await loadRun(runId);
  const { profile, agent, task, project } = await loadSetup(run);
  await recordRunEvent(runId, 'result', {
    status: outcome.status, report: outcome.report, message: outcome.message?.slice(0, 4000), error: outcome.error, usage: outcome.usage,
  });
  const actor = await agentActor(agent.id);
  const usage = { ...outcome.usage, credentialId: usedCredentialId };
  // The branch as far as anyone else can see it: pushed, or nothing.
  const pushedBranch = publish?.pushed ? report.branch : null;
  const nextSteps = (branch: string | null, limitHint: string | null): string => [
    branch ? `The work so far is on branch ${branch}; Retry on the task continues from it in the same session.` : 'Retry on the task starts the same session again.',
    limitHint,
  ].filter(Boolean).join(' ');

  if (aborted) {
    const timedOut = aborted === 'timeout';
    const reason = timedOut ? `Stopped after ${profile.maxRunMinutes} minutes` : 'Cancelled';
    await postComment(actor, task.id, `Run stopped: ${reason}. ${nextSteps(pushedBranch, timedOut ? 'Raise "Max run minutes" in the agent profile if the task needs longer.' : null)}`).catch(() => {});
    await finishRun(runId, { status: timedOut ? 'failed' : 'cancelled', error: reason, sessionId: outcome.sessionId, branch: pushedBranch, usage });
    return;
  }

  if (outcome.status === 'rate_limited') {
    // The worker parks these itself; a report anyway is a worker that could not, so park here.
    const retryAt = new Date(outcome.retryAt ?? Date.now() + QUOTA_RETRY_DEFAULT_MS);
    await parkRunForQuota(runId, retryAt, outcome.error ?? 'Provider rate limit', { sessionId: outcome.sessionId, branch: pushedBranch });
    return;
  }

  if (outcome.status === 'failed') {
    const error = outcome.error ?? 'unknown error';
    const limitHint = /max_turns|maximum number of turns/i.test(error)
      ? `The agent used all ${profile.maxTurns} steps ("Max turns" in its profile) before it could report; raise the limit or split the task.`
      : /max_budget/i.test(error) ? 'The run hit "Max budget" in the agent profile.' : null;
    await postComment(actor, task.id, `I could not finish this run: ${error.slice(0, 500)}. ${nextSteps(pushedBranch, limitHint)}`).catch(() => {});
    await finishRun(runId, { status: 'failed', error, sessionId: outcome.sessionId, branch: pushedBranch, usage });
    return;
  }

  if (outcome.status === 'needs_input') {
    const question = outcome.report?.question ?? outcome.report?.summary ?? outcome.message ?? 'I need more information to continue.';
    await postComment(actor, task.id, `I need input before I can continue:\n\n${question}`).catch(() => {});
    await finishRun(runId, { status: 'needs_input', summary: outcome.report?.summary ?? null, sessionId: outcome.sessionId, branch: report.branch, usage });
    // A reply that arrived while we were still working is the answer.
    await queueFollowUp(agent.id, task.id, project.id, runId, run.createdAt, outcome.sessionId, report.branch);
    return;
  }

  // succeeded: the worker has pushed and opened the pull request; comment, move status.
  const summary = outcome.report?.summary?.trim() || outcome.message?.trim() || 'Done.';
  if (publish?.error) {
    await postComment(actor, task.id, `${summary}\n\nI could not push the branch: ${publish.error.slice(0, 900)}`).catch(() => {});
    await finishRun(runId, { status: 'failed', error: `push failed: ${publish.error}`, summary, sessionId: outcome.sessionId, branch: report.branch, usage });
    return;
  }
  const prUrl = publish?.prUrl ?? outcome.report?.prUrl ?? run.prUrl ?? null;
  // The branch and the pull request reach the task as git links through the
  // forge's webhook, the same way a person's do; a task link here was a
  // second copy nothing rendered.
  await postComment(actor, task.id, prUrl ? `${summary}\n\nPull request: ${prUrl}` : summary).catch((e) => logger.warn({ err: e }, 'agent comment failed'));
  const status = await completionStatus(project.id, profile.completionCategory);
  if (status) {
    const [fresh] = await getDb().db.select({ version: tasks.version, statusId: tasks.statusId, category: taskStatuses.category })
      .from(tasks).leftJoin(taskStatuses, eq(taskStatuses.id, tasks.statusId)).where(eq(tasks.id, task.id));
    // A task someone closed while the agent worked stays closed.
    if (fresh && fresh.statusId !== status.id && fresh.category !== 'done' && fresh.category !== 'canceled') {
      await tasksSvc.updateTask(actor, task.id, { statusId: status.id, version: fresh.version }).catch((e) => logger.warn({ err: e }, 'agent status move failed'));
    }
  }
  await finishRun(runId, { status: 'succeeded', summary, sessionId: outcome.sessionId, branch: report.branch, prUrl, usage });
  // R13/R30: a human wrote while we worked (queued or running) – continue in a follow-up.
  await queueFollowUp(agent.id, task.id, project.id, runId, run.createdAt, outcome.sessionId, report.branch);
}

/** R13/R30: a human comment written during the run becomes the next run's prompt. */
async function queueFollowUp(agentUserId: string, taskId: string, projectId: string, parentRunId: string, since: Date | null, sessionId: string | null, branch: string | null): Promise<void> {
  const followUp = await newestHumanCommentSince(taskId, since, agentUserId);
  if (!followUp) return;
  await queueRun({
    agentUserId, taskId, projectId, trigger: sessionId ? 'comment' : 'assigned', requestedBy: followUp.authorId,
    commentId: followUp.id, parentRunId, sessionId, branch,
  });
}

/** The backend for a worker that shares the API's process: the services, called directly. */
export const localRunBackend: RunBackend = {
  apiBase: () => `http://localhost:${env.port}/api/v1`,
  heartbeat,
  claim,
  prepare,
  start,
  progress: (runId, input) => recordRunProgress(runId, input),
  touch: (runId) => touchRun(runId),
  event: (runId, type, payload) => recordRunEvent(runId, type, payload),
  cancelRequested: (runId) => cancelRequested(runId),
  repository,
  park,
  finish,
  fail,
};
