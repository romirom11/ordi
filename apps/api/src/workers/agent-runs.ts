/**
 * Agent run worker (plan 2026-09-05-001, R14, R16, R26-R35). Lives in the
 * API process like the email worker: claims due runs with SKIP LOCKED,
 * prepares a checkout, mints the run token, drives the runtime adapter,
 * streams events, publishes the branch and finalizes the task. Multiple
 * replicas may run it; the claim query and the heartbeat keep them apart.
 */
import { hostname } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { getDb, schema, eq, and, inArray, sql } from '@ordi/db';
import { docToText, textToDoc } from '@ordi/shared';
import { env } from '../env';
import { logger } from '../lib/logger';
import { SERVER_VERSION } from '../version';
import type { Actor } from '../context';
import { buildAccessContext } from '../core/access';
import { loadRolePermissions } from '../core/rbac';
import { loadRuntimeCredential, resolveCredentialChain } from '../domains/agents/credentials';
import { secretValues } from '../domains/agents/connectors';
import { closeRunConnections } from '../domains/agents/gateway';
import { allowedToolsFor, buildRulesOfEngagement, buildTaskBrief, DISALLOWED_TOOLS, type PromptContext } from '../domains/agents/prompt';
import { forgetRunScope, forgetRunSecrets, recordRunEvent, registerRunScope, registerRunSecrets } from '../domains/agents/run-events';
import {
  cancelRequested, claimRuns, finishRun, newestHumanCommentSince, parkRunForQuota, queueRun, recordRunProgress, requeueStaleRuns, startRun, touchRun, type RunRow,
} from '../domains/agents/runs';
import { runtimeAdapter, type RuntimeMcpServer, type RuntimeOutcome } from '../domains/agents/runtime';
import { cleanupWorkspace, explainPushError, harnessDir, prepareWorkspace, pruneTaskDirs, publishWorkspace, SESSION_RETENTION_DAYS, type Workspace } from '../domains/agents/workspace';
import * as tasksSvc from '../domains/projects/service';

const { agentProfiles, agentWorkers, users, tasks, projects, taskStatuses, agentConnectors, mcpConnectors } = schema;

const POLL_MS = 3_000;
const HEARTBEAT_MS = 15_000;
const STALE_RUN_MS = 3 * 60_000;
const QUOTA_RETRY_DEFAULT_MS = 30 * 60_000;
const PRUNE_MS = 6 * 60 * 60_000;

export const workerId = `${hostname()}:${process.pid}`;
const inFlight = new Set<string>();

/**
 * An Actor for a user row, so the worker can comment and move status through
 * the services as the agent. The actor type comes from the row: an agent user
 * acts as 'agent' (which the services and consumers treat differently from a
 * person), anyone else as 'user'.
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

async function heartbeat(runtimeAvailable: boolean): Promise<void> {
  const { db } = getDb();
  // Rows are keyed by host:pid; a restarted process leaves its old row behind.
  await db.delete(agentWorkers).where(sql`${agentWorkers.lastSeenAt} < now() - interval '10 minutes'`);
  await db.insert(agentWorkers).values({
    id: workerId, concurrency: env.agentWorkerConcurrency, running: inFlight.size, runtimeAvailable, version: SERVER_VERSION,
  }).onConflictDoUpdate({
    target: agentWorkers.id,
    set: { lastSeenAt: new Date(), running: inFlight.size, concurrency: env.agentWorkerConcurrency, runtimeAvailable, version: SERVER_VERSION },
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

async function postComment(actor: Actor, taskId: string, text: string): Promise<void> {
  await tasksSvc.addComment(actor, taskId, { body: textToDoc(text), mentions: [] });
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
 * Execute one claimed run end to end. Exported for tests, which inject a
 * runtime adapter and a git runner.
 */
export async function executeRun(claimed: RunRow): Promise<void> {
  const runId = claimed.id;
  inFlight.add(runId);
  let ws: Workspace | null = null;
  let token: string | null = null;
  // A checkout whose push failed holds commits nobody else has: keep it for the retry.
  let keepCheckout = false;
  // Outside the checkout, so nothing of it ends up in the agent's commits,
  // and per task rather than per run: the session transcript written here
  // is what a follow-up or a retry resumes.
  const configDir = harnessDir(claimed.taskId);
  // Liveness from claim to finish: a slow clone or push must not look like a
  // dead worker to requeueStaleRuns.
  const liveness = setInterval(() => { void touchRun(runId).catch(() => {}); }, 30_000);
  try {
    const setup = await loadSetup(claimed);
    const { profile, agent, task, project } = setup;
    registerRunScope(runId, { projectId: project.id, taskId: task.id });

    const chain = await resolveCredentialChain(profile);
    if (!chain.length) {
      await finishRun(runId, { status: 'failed', error: 'No active Claude credential; connect one under Settings → Agents' });
      return;
    }

    const runtime = runtimeAdapter(profile.runtime as 'claude_code' | 'codex');
    // A new branch gets an English name from the cheapest model, whatever
    // language the task is written in; transliteration is the fallback.
    let suggestedSlug: string | null = null;
    if (!claimed.branch) {
      const cred = await loadRuntimeCredential(chain[0]!);
      if (cred) {
        await mkdir(configDir, { recursive: true });
        suggestedSlug = await runtime.suggestBranchSlug({
          title: task.title, description: docToText(task.description).slice(0, 1500), credential: { kind: cred.kind, secret: cred.secret }, configDir,
        }).catch(() => null);
      }
    }
    ws = await prepareWorkspace({
      taskId: task.id, projectId: project.id, projectKey: project.key, taskNumber: task.number, taskTitle: task.title,
      existingBranch: claimed.branch ?? null, suggestedSlug, agentName: agent.name, agentEmail: agent.email,
    });
    await recordRunEvent(runId, 'log', { message: ws.repo ? `${ws.reused ? 'Continuing the previous run\'s unpushed checkout of' : 'Checked out'} ${ws.repo.fullName} on ${ws.branch}` : 'No repository linked; working in a scratch directory' });
    // Written now, not at the end: a worker lost mid-run leaves a row the re-queued run continues from.
    await recordRunProgress(runId, { branch: ws.branch });

    const started = await startRun(runId);
    if (!started) return; // cancelled during preparation
    token = started.token;
    const ref = `${project.key}-${task.number}`;
    const status = await completionStatus(project.id, profile.completionCategory);
    const ctx: PromptContext = {
      taskId: task.id, ref, title: task.title, projectKey: project.key, projectName: project.name,
      completionCategory: profile.completionCategory, completionStatusName: status?.name ?? null,
      branch: ws.branch, repoFullName: ws.repo?.fullName ?? null, agentName: agent.name, instructions: profile.instructions,
      followUpCommentId: claimed.trigger === 'comment' ? claimed.commentId : null,
      resumedAfterStop: claimed.trigger === 'retry' && Boolean(claimed.sessionId),
      connectorSlugs: setup.connectors.map((c) => c.slug),
    };
    let prompt = await buildTaskBrief(ctx);
    const systemAppend = buildRulesOfEngagement(ctx);
    const base = `http://localhost:${env.port}/api/v1`;
    const mcpServers: Record<string, RuntimeMcpServer> = {
      // alwaysLoad: the brief tells the agent to call get_task first, so the
      // tools must be in the prompt on turn 1 rather than behind tool search.
      ordi: { type: 'http', url: `${base}/mcp`, headers: { Authorization: `Bearer ${token}` }, alwaysLoad: true },
    };
    for (const c of setup.connectors) {
      mcpServers[c.slug] = { type: 'http', url: `${base}/mcp-connectors/${c.slug}/mcp`, headers: { Authorization: `Bearer ${token}` } };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), profile.maxRunMinutes * 60_000);
    const cancelPoll = setInterval(async () => {
      if (await cancelRequested(runId).catch(() => false)) controller.abort(new Error('cancelled'));
    }, 5_000);

    let outcome: RuntimeOutcome | null = null;
    let usedCredentialId: string | null = null;
    let resume = claimed.sessionId ?? null;
    /** Try the credential chain once; the last outcome is returned (null when no credential loads). */
    const workspace = ws;
    const runToken = started.token;
    const attempt = async (): Promise<RuntimeOutcome | null> => {
      let last: RuntimeOutcome | null = null;
      for (const credentialId of chain) {
        const cred = await loadRuntimeCredential(credentialId);
        if (!cred) continue;
        usedCredentialId = credentialId;
        registerRunSecrets(runId, [cred.secret, runToken, workspace.repo?.token ?? '', ...setup.connectors.flatMap((c) => secretValues(c))]);
        await recordRunEvent(runId, 'log', { message: `Starting ${profile.runtime} with credential ${credentialId === chain[0] ? '(primary)' : '(fallback)'}` });
        last = await runtime.run({
          prompt, systemAppend, cwd: workspace.dir, configDir, credential: { kind: cred.kind, secret: cred.secret },
          model: profile.model, mcpServers, maxTurns: profile.maxTurns,
          maxBudgetUsd: cred.kind === 'api_key' && profile.maxBudgetUsd != null ? Number(profile.maxBudgetUsd) : null,
          resume, allowedTools: allowedToolsFor(Object.keys(mcpServers)), disallowedTools: DISALLOWED_TOOLS,
          signal: controller.signal,
          onEvent: async (event) => {
            switch (event.type) {
              case 'init':
                await recordRunProgress(runId, { sessionId: event.sessionId });
                await recordRunEvent(runId, 'init', { sessionId: event.sessionId, model: event.model, mcpServers: event.mcpServers });
                break;
              case 'assistant': if (event.text || event.toolUses.length) await recordRunEvent(runId, 'assistant', { text: event.text.slice(0, 8000), toolUses: event.toolUses.map((t) => ({ id: t.id, name: t.name })) }); break;
              case 'tool_use': await recordRunEvent(runId, 'tool_use', { toolUseId: event.toolUseId, name: event.name, input: truncate(event.input) }); break;
              case 'tool_result': await recordRunEvent(runId, 'tool_result', { toolUseId: event.toolUseId, text: event.text.slice(0, 2000), isError: event.isError }); break;
              case 'rate_limit': await recordRunEvent(runId, 'rate_limit', { status: event.status, resetsAt: epochToIso(event.resetsAt), limitType: event.limitType }); break;
              case 'log': await recordRunEvent(runId, 'log', { message: event.message }); break;
            }
          },
        });
        if (last.sessionId) resume = last.sessionId;
        if (last.status !== 'rate_limited') break;
        await recordRunEvent(runId, 'log', { message: `Credential ${credentialId} is rate limited${chain.indexOf(credentialId) < chain.length - 1 ? ', switching to the fallback' : ''}` });
      }
      return last;
    };
    try {
      outcome = await attempt();
      // The session to resume is gone (another worker's disk, a pruned or
      // rebuilt volume): start over on the branch instead of failing.
      if (outcome && sessionLost(outcome) && claimed.sessionId) {
        await recordRunEvent(runId, 'log', { message: `Session ${claimed.sessionId} is not on this worker; starting a fresh one on the same branch` });
        resume = null;
        prompt = await buildTaskBrief({ ...ctx, sessionLost: true });
        outcome = await attempt();
      }
    } finally {
      clearTimeout(timer);
      clearInterval(cancelPoll);
    }

    if (!outcome) {
      await finishRun(runId, { status: 'failed', error: 'No usable credential' });
      return;
    }
    // A run that stops early (limit, timeout, cancel, error) must not lose
    // what the agent already did: the branch is pushed without a pull
    // request, and a retry continues on it with the same session.
    const preserveWork = async (): Promise<string | null> => {
      try {
        const kept = await publishWorkspace(ws!, { ref, title: task.title, summary: '', existingPrUrl: claimed.prUrl ?? null, openPullRequest: false });
        if (kept.pushed) await recordRunEvent(runId, 'log', { message: `Pushed ${kept.commits ?? 'the'} commit(s) of unfinished work to ${ws!.branch}` });
        return kept.pushed ? ws!.branch : null;
      } catch (e) {
        keepCheckout = true;
        await recordRunEvent(runId, 'error', { message: `Could not push unfinished work: ${explainPushError((e as Error).message)}` });
        return null;
      }
    };
    const nextSteps = (branch: string | null, limitHint: string | null): string => [
      branch ? `The work so far is on branch ${branch}; Retry on the task continues from it in the same session.` : 'Retry on the task starts the same session again.',
      limitHint,
    ].filter(Boolean).join(' ');

    // From here on a throw (a DB blip, the agent user gone) still keeps the work.
    try {
    await recordRunEvent(runId, 'result', {
      status: outcome.status, report: outcome.report, message: outcome.message?.slice(0, 4000), error: outcome.error, usage: outcome.usage,
    });
    const actor = await agentActor(agent.id);
    const usage = { ...outcome.usage, credentialId: usedCredentialId };

    if (controller.signal.aborted) {
      const timedOut = (controller.signal.reason as Error | undefined)?.message === 'timeout';
      const reason = timedOut ? `Stopped after ${profile.maxRunMinutes} minutes` : 'Cancelled';
      const branch = await preserveWork();
      await postComment(actor, task.id, `Run stopped: ${reason}. ${nextSteps(branch, timedOut ? 'Raise "Max run minutes" in the agent profile if the task needs longer.' : null)}`).catch(() => {});
      await finishRun(runId, { status: timedOut ? 'failed' : 'cancelled', error: reason, sessionId: outcome.sessionId, branch, usage });
      return;
    }

    if (outcome.status === 'rate_limited') {
      const retryAt = new Date(outcome.retryAt ?? Date.now() + QUOTA_RETRY_DEFAULT_MS);
      // The parked run resumes the same session on the same branch when the window resets.
      const branch = await preserveWork();
      await parkRunForQuota(runId, retryAt, outcome.error ?? 'Provider rate limit', { sessionId: outcome.sessionId, branch });
      return;
    }

    if (outcome.status === 'failed') {
      const error = outcome.error ?? 'unknown error';
      const branch = await preserveWork();
      const limitHint = /max_turns|maximum number of turns/i.test(error)
        ? `The agent used all ${profile.maxTurns} steps ("Max turns" in its profile) before it could report; raise the limit or split the task.`
        : /max_budget/i.test(error) ? 'The run hit "Max budget" in the agent profile.' : null;
      await postComment(actor, task.id, `I could not finish this run: ${error.slice(0, 500)}. ${nextSteps(branch, limitHint)}`).catch(() => {});
      await finishRun(runId, { status: 'failed', error, sessionId: outcome.sessionId, branch, usage });
      return;
    }

    if (outcome.status === 'needs_input') {
      const question = outcome.report?.question ?? outcome.report?.summary ?? outcome.message ?? 'I need more information to continue.';
      await postComment(actor, task.id, `I need input before I can continue:\n\n${question}`).catch(() => {});
      await finishRun(runId, { status: 'needs_input', summary: outcome.report?.summary ?? null, sessionId: outcome.sessionId, branch: ws.branch, usage });
      // A reply that arrived while we were still working is the answer.
      await queueFollowUp(agent.id, task.id, project.id, runId, started.run.createdAt, outcome.sessionId, ws.branch);
      return;
    }

    // succeeded: publish, comment, move status
    const summary = outcome.report?.summary?.trim() || outcome.message?.trim() || 'Done.';
    let prUrl = outcome.report?.prUrl ?? claimed.prUrl ?? null;
    try {
      const published = await publishWorkspace(ws, {
        ref, title: task.title, summary, existingPrUrl: prUrl,
        verification: outcome.report?.verification ?? null, risks: outcome.report?.risks ?? null,
        taskUrl: `${env.appUrl.replace(/\/$/, '')}/projects/${project.id}/tasks/${task.id}`,
      });
      prUrl = published.prUrl ?? prUrl;
      if (published.pushed) await recordRunEvent(runId, 'log', { message: `Pushed ${published.commits ?? 'the'} commit(s) to ${ws.branch}${prUrl ? `; pull request ${prUrl}` : ''}` });
      else if (ws.repo) await recordRunEvent(runId, 'log', { message: 'No commits to push' });
    } catch (e) {
      keepCheckout = true;
      const why = explainPushError((e as Error).message);
      await recordRunEvent(runId, 'error', { message: `Publishing the branch failed: ${why}` });
      await postComment(actor, task.id, `${summary}\n\nI could not push the branch: ${why.slice(0, 900)}`).catch(() => {});
      await finishRun(runId, { status: 'failed', error: `push failed: ${why}`, summary, sessionId: outcome.sessionId, branch: ws.branch, usage });
      return;
    }
    if (prUrl) {
      await tasksSvc.addLink(actor, task.id, { url: prUrl, title: 'Pull request' }).catch(() => {});
    }
    await postComment(actor, task.id, prUrl ? `${summary}\n\nPull request: ${prUrl}` : summary).catch((e) => logger.warn({ err: e }, 'agent comment failed'));
    if (status) {
      const [fresh] = await getDb().db.select({ version: tasks.version, statusId: tasks.statusId, category: taskStatuses.category })
        .from(tasks).leftJoin(taskStatuses, eq(taskStatuses.id, tasks.statusId)).where(eq(tasks.id, task.id));
      // A task someone closed while the agent worked stays closed.
      if (fresh && fresh.statusId !== status.id && fresh.category !== 'done' && fresh.category !== 'canceled') {
        await tasksSvc.updateTask(actor, task.id, { statusId: status.id, version: fresh.version }).catch((e) => logger.warn({ err: e }, 'agent status move failed'));
      }
    }
    await finishRun(runId, { status: 'succeeded', summary, sessionId: outcome.sessionId, branch: ws.branch, prUrl, usage });

    // R13/R30: a human wrote while we worked (queued or running) – continue in a follow-up.
    await queueFollowUp(agent.id, task.id, project.id, runId, started.run.createdAt, outcome.sessionId, ws.branch);
    } catch (e) {
      const branch = await preserveWork();
      await recordRunEvent(runId, 'error', { message: `Finalizing the run failed: ${(e as Error).message}` }).catch(() => {});
      await finishRun(runId, { status: 'failed', error: (e as Error).message, sessionId: outcome.sessionId, branch, usage: { ...outcome.usage, credentialId: usedCredentialId } });
    }
  } catch (e) {
    logger.error({ err: e, runId }, 'agent run crashed');
    await recordRunEvent(runId, 'error', { message: (e as Error).message }).catch(() => {});
    await finishRun(runId, { status: 'failed', error: (e as Error).message }).catch(() => {});
  } finally {
    clearInterval(liveness);
    inFlight.delete(runId);
    forgetRunSecrets(runId);
    forgetRunScope(runId);
    await closeRunConnections(runId).catch(() => {});
    await cleanupWorkspace(claimed.taskId, { keepCheckout }).catch(() => {});
  }
}

/** The runtime could not find the transcript it was asked to resume. */
function sessionLost(outcome: RuntimeOutcome): boolean {
  return outcome.status === 'failed' && /no conversation found/i.test(outcome.error ?? '');
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

/** The SDK reports reset times in epoch seconds; the log wants an instant it can format. */
function epochToIso(value: number | null): string | null {
  if (!value) return null;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString();
}

function truncate(value: unknown): unknown {
  const text = JSON.stringify(value ?? null);
  if (text.length <= 2000) return value;
  return { truncated: text.slice(0, 2000) };
}

/** One poll: recover stale runs, claim what fits, start them in the background. */
export async function pollOnce(): Promise<number> {
  await requeueStaleRuns(new Date(Date.now() - STALE_RUN_MS)).catch((e) => logger.warn({ err: e }, 'stale run sweep failed'));
  const free = env.agentWorkerConcurrency - inFlight.size;
  if (free <= 0) return 0;
  const claimed = await claimRuns(workerId, free);
  for (const run of claimed) void executeRun(run);
  return claimed.length;
}

export function startAgentRunsWorker(): () => void {
  let stopped = false;
  let runtimeAvailable = false;
  void runtimeAdapter('claude_code').available().then((a) => { runtimeAvailable = a.ok; if (!a.ok) logger.warn({ error: a.error }, 'claude runtime unavailable'); });
  void mkdir(env.agentWorkDir, { recursive: true }).catch((e) => logger.warn({ err: e, dir: env.agentWorkDir }, 'agent work dir unavailable'));
  const poll = setInterval(() => { if (!stopped) pollOnce().catch((e) => logger.error({ err: e }, 'agent worker poll failed')); }, POLL_MS);
  const beat = setInterval(() => { if (!stopped) heartbeat(runtimeAvailable).catch(() => {}); }, HEARTBEAT_MS);
  const prune = setInterval(() => { if (!stopped) pruneSessions().catch(() => {}); }, PRUNE_MS);
  void heartbeat(runtimeAvailable).catch(() => {});
  void pruneSessions().catch(() => {});
  logger.info({ workerId, concurrency: env.agentWorkerConcurrency }, 'agent run worker started');
  return () => {
    stopped = true;
    clearInterval(poll);
    clearInterval(beat);
    clearInterval(prune);
  };
}

/** Task directories (checkout leftovers and session transcripts) untouched for SESSION_RETENTION_DAYS go. */
export async function pruneSessions(): Promise<number> {
  const removed = await pruneTaskDirs(new Date(Date.now() - SESSION_RETENTION_DAYS * 86_400_000));
  if (removed) logger.info({ removed }, 'agent task dirs pruned');
  return removed;
}

/** For tests and the status endpoint. */
export function inFlightRunIds(): string[] {
  return [...inFlight];
}

export { and, inArray, sql };
