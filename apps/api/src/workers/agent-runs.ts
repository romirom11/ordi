/**
 * Agent run worker (plan 2026-09-05-001, R14, R16, R26-R35). Lives in the
 * API process like the email worker: claims due runs with SKIP LOCKED,
 * prepares a checkout, mints the run token, drives the runtime adapter,
 * streams events, publishes the branch and finalizes the task. Multiple
 * replicas may run it; the claim query and the heartbeat keep them apart.
 */
import { hostname } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb, schema, eq, and, inArray, sql } from '@ordi/db';
import { textToDoc } from '@ordi/shared';
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
  cancelRequested, claimRuns, finishRun, newestHumanCommentSince, parkRunForQuota, queueRun, requeueStaleRuns, startRun, touchRun, type RunRow,
} from '../domains/agents/runs';
import { runtimeAdapter, type RuntimeMcpServer, type RuntimeOutcome } from '../domains/agents/runtime';
import { cleanupWorkspace, prepareWorkspace, publishWorkspace, runDir, type Workspace } from '../domains/agents/workspace';
import * as tasksSvc from '../domains/projects/service';

const { agentProfiles, agentWorkers, users, tasks, projects, taskStatuses, agentConnectors, mcpConnectors } = schema;

const POLL_MS = 3_000;
const HEARTBEAT_MS = 15_000;
const STALE_RUN_MS = 3 * 60_000;
const QUOTA_RETRY_DEFAULT_MS = 30 * 60_000;

export const workerId = `${hostname()}:${process.pid}`;
const inFlight = new Set<string>();

/** An Actor for the agent user, so the worker can comment and move status through the services. */
export async function agentActor(agentUserId: string): Promise<Actor> {
  const { db } = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, agentUserId));
  if (!user) throw new Error('Agent user not found');
  const permissions = await loadRolePermissions(user.roleId);
  const access = await buildAccessContext(user.id, permissions, false);
  return {
    userId: user.id, actorType: 'agent', roleId: user.roleId, roleName: '', email: user.email, name: user.name,
    locale: user.locale, timezone: user.timezone, readOnly: false, tokenScopes: null, access,
  };
}

async function heartbeat(runtimeAvailable: boolean): Promise<void> {
  const { db } = getDb();
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

/** KTD8: the project's status in the agent's completion category, if any. */
async function completionStatus(projectId: string, category: string): Promise<{ id: string; name: string } | null> {
  const { db } = getDb();
  const rows = await db.select({ id: taskStatuses.id, name: taskStatuses.name, category: taskStatuses.category, position: taskStatuses.position })
    .from(taskStatuses).where(eq(taskStatuses.projectId, projectId)).orderBy(taskStatuses.position);
  const exact = rows.find((s) => s.category === category);
  if (exact) return exact;
  return null;
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
  const configDir = join(runDir(runId), '.harness');
  try {
    const setup = await loadSetup(claimed);
    const { profile, agent, task, project } = setup;
    registerRunScope(runId, { projectId: project.id, taskId: task.id });

    const chain = await resolveCredentialChain(profile);
    if (!chain.length) {
      await finishRun(runId, { status: 'failed', error: 'No active Claude credential; connect one under Settings → Agents' });
      return;
    }

    ws = await prepareWorkspace({
      runId, projectId: project.id, projectKey: project.key, taskNumber: task.number, taskTitle: task.title,
      existingBranch: claimed.branch ?? null, agentName: agent.name, agentEmail: agent.email,
    });
    await mkdir(configDir, { recursive: true });
    await recordRunEvent(runId, 'log', { message: ws.repo ? `Checked out ${ws.repo.fullName} on ${ws.branch}` : 'No repository linked; working in a scratch directory' });

    const started = await startRun(runId);
    token = started.token;
    const ref = `${project.key}-${task.number}`;
    const status = await completionStatus(project.id, profile.completionCategory);
    const ctx: PromptContext = {
      taskId: task.id, ref, title: task.title, projectKey: project.key, projectName: project.name,
      completionCategory: profile.completionCategory, completionStatusName: status?.name ?? null,
      branch: ws.branch, repoFullName: ws.repo?.fullName ?? null, agentName: agent.name, instructions: profile.instructions,
      followUpCommentId: claimed.trigger === 'comment' ? claimed.commentId : null,
      connectorSlugs: setup.connectors.map((c) => c.slug),
    };
    const prompt = await buildTaskBrief(ctx);
    const systemAppend = buildRulesOfEngagement(ctx);
    const base = `http://localhost:${env.port}/api/v1`;
    const mcpServers: Record<string, RuntimeMcpServer> = {
      ordi: { type: 'http', url: `${base}/mcp`, headers: { Authorization: `Bearer ${token}` } },
    };
    for (const c of setup.connectors) {
      mcpServers[c.slug] = { type: 'http', url: `${base}/mcp-connectors/${c.slug}/mcp`, headers: { Authorization: `Bearer ${token}` } };
    }
    const runtime = runtimeAdapter(profile.runtime as 'claude_code' | 'codex');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), profile.maxRunMinutes * 60_000);
    const cancelPoll = setInterval(async () => {
      if (await cancelRequested(runId).catch(() => false)) controller.abort(new Error('cancelled'));
      await touchRun(runId).catch(() => {});
    }, 5_000);

    let outcome: RuntimeOutcome | null = null;
    let usedCredentialId: string | null = null;
    let resume = claimed.sessionId ?? null;
    try {
      for (const credentialId of chain) {
        const cred = await loadRuntimeCredential(credentialId);
        if (!cred) continue;
        usedCredentialId = credentialId;
        registerRunSecrets(runId, [cred.secret, token, ws.repo?.token ?? '', ...setup.connectors.flatMap((c) => secretValues(c))]);
        await recordRunEvent(runId, 'log', { message: `Starting ${profile.runtime} with credential ${credentialId === chain[0] ? '(primary)' : '(fallback)'}` });
        outcome = await runtime.run({
          prompt, systemAppend, cwd: ws.dir, configDir, credential: { kind: cred.kind, secret: cred.secret },
          model: profile.model, mcpServers, maxTurns: profile.maxTurns,
          maxBudgetUsd: cred.kind === 'api_key' && profile.maxBudgetUsd != null ? Number(profile.maxBudgetUsd) : null,
          resume, allowedTools: allowedToolsFor(Object.keys(mcpServers)), disallowedTools: DISALLOWED_TOOLS,
          signal: controller.signal,
          onEvent: async (event) => {
            switch (event.type) {
              case 'init': await recordRunEvent(runId, 'init', { sessionId: event.sessionId, model: event.model, mcpServers: event.mcpServers }); break;
              case 'assistant': if (event.text || event.toolUses.length) await recordRunEvent(runId, 'assistant', { text: event.text.slice(0, 8000), toolUses: event.toolUses.map((t) => ({ id: t.id, name: t.name })) }); break;
              case 'tool_use': await recordRunEvent(runId, 'tool_use', { toolUseId: event.toolUseId, name: event.name, input: truncate(event.input) }); break;
              case 'tool_result': await recordRunEvent(runId, 'tool_result', { toolUseId: event.toolUseId, text: event.text.slice(0, 2000), isError: event.isError }); break;
              case 'rate_limit': await recordRunEvent(runId, 'rate_limit', { status: event.status, resetsAt: event.resetsAt, limitType: event.limitType }); break;
              case 'log': await recordRunEvent(runId, 'log', { message: event.message }); break;
            }
          },
        });
        if (outcome.sessionId) resume = outcome.sessionId;
        if (outcome.status !== 'rate_limited') break;
        await recordRunEvent(runId, 'log', { message: `Credential ${credentialId} is rate limited${chain.indexOf(credentialId) < chain.length - 1 ? ', switching to the fallback' : ''}` });
      }
    } finally {
      clearTimeout(timer);
      clearInterval(cancelPoll);
    }

    if (!outcome) {
      await finishRun(runId, { status: 'failed', error: 'No usable credential' });
      return;
    }
    await recordRunEvent(runId, 'result', {
      status: outcome.status, report: outcome.report, message: outcome.message?.slice(0, 4000), error: outcome.error, usage: outcome.usage,
    });

    const actor = await agentActor(agent.id);
    const usage = { ...outcome.usage, credentialId: usedCredentialId };

    if (controller.signal.aborted) {
      const reason = (controller.signal.reason as Error | undefined)?.message === 'timeout'
        ? `Stopped after ${profile.maxRunMinutes} minutes`
        : 'Cancelled';
      await postComment(actor, task.id, `Run stopped: ${reason}.`).catch(() => {});
      await finishRun(runId, { status: reason === 'Cancelled' ? 'cancelled' : 'failed', error: reason, sessionId: outcome.sessionId, usage });
      return;
    }

    if (outcome.status === 'rate_limited') {
      const retryAt = new Date(outcome.retryAt ?? Date.now() + QUOTA_RETRY_DEFAULT_MS);
      await parkRunForQuota(runId, retryAt, outcome.error ?? 'Provider rate limit');
      return;
    }

    if (outcome.status === 'failed') {
      await postComment(actor, task.id, `I could not finish this run: ${(outcome.error ?? 'unknown error').slice(0, 500)}`).catch(() => {});
      await finishRun(runId, { status: 'failed', error: outcome.error ?? 'unknown error', sessionId: outcome.sessionId, usage });
      return;
    }

    if (outcome.status === 'needs_input') {
      const question = outcome.report?.question ?? outcome.report?.summary ?? outcome.message ?? 'I need more information to continue.';
      await postComment(actor, task.id, `I need input before I can continue:\n\n${question}`).catch(() => {});
      await finishRun(runId, { status: 'needs_input', summary: outcome.report?.summary ?? null, sessionId: outcome.sessionId, branch: ws.branch, usage });
      return;
    }

    // succeeded: publish, comment, move status
    const summary = outcome.report?.summary?.trim() || outcome.message?.trim() || 'Done.';
    let prUrl = outcome.report?.prUrl ?? claimed.prUrl ?? null;
    try {
      const published = await publishWorkspace(ws, { ref, title: task.title, summary, existingPrUrl: prUrl });
      prUrl = published.prUrl ?? prUrl;
      if (published.pushed) await recordRunEvent(runId, 'log', { message: `Pushed ${published.commits} commit(s) to ${ws.branch}${prUrl ? `; pull request ${prUrl}` : ''}` });
      else if (ws.repo) await recordRunEvent(runId, 'log', { message: 'No commits to push' });
    } catch (e) {
      await recordRunEvent(runId, 'error', { message: `Publishing the branch failed: ${(e as Error).message}` });
      await postComment(actor, task.id, `${summary}\n\nI could not push the branch: ${(e as Error).message.slice(0, 300)}`).catch(() => {});
      await finishRun(runId, { status: 'failed', error: `push failed: ${(e as Error).message}`, summary, sessionId: outcome.sessionId, branch: ws.branch, usage });
      return;
    }
    if (prUrl) {
      await tasksSvc.addLink(actor, task.id, { url: prUrl, title: 'Pull request' }).catch(() => {});
    }
    await postComment(actor, task.id, prUrl ? `${summary}\n\nPull request: ${prUrl}` : summary).catch((e) => logger.warn({ err: e }, 'agent comment failed'));
    if (status) {
      const [fresh] = await getDb().db.select({ version: tasks.version, statusId: tasks.statusId }).from(tasks).where(eq(tasks.id, task.id));
      if (fresh && fresh.statusId !== status.id) {
        await tasksSvc.updateTask(actor, task.id, { statusId: status.id, version: fresh.version }).catch((e) => logger.warn({ err: e }, 'agent status move failed'));
      }
    }
    await finishRun(runId, { status: 'succeeded', summary, sessionId: outcome.sessionId, branch: ws.branch, prUrl, usage });

    // R13/R30: a human wrote while we worked – continue in a follow-up.
    const followUp = await newestHumanCommentSince(task.id, started.run.startedAt, agent.id);
    if (followUp) {
      await queueRun({
        agentUserId: agent.id, taskId: task.id, projectId: project.id, trigger: 'comment', requestedBy: followUp.authorId,
        commentId: followUp.id, parentRunId: runId, sessionId: outcome.sessionId,
      });
    }
  } catch (e) {
    logger.error({ err: e, runId }, 'agent run crashed');
    await recordRunEvent(runId, 'error', { message: (e as Error).message }).catch(() => {});
    await finishRun(runId, { status: 'failed', error: (e as Error).message }).catch(() => {});
  } finally {
    inFlight.delete(runId);
    forgetRunSecrets(runId);
    forgetRunScope(runId);
    await closeRunConnections(runId).catch(() => {});
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
    await cleanupWorkspace(runId).catch(() => {});
  }
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
  void heartbeat(runtimeAvailable).catch(() => {});
  logger.info({ workerId, concurrency: env.agentWorkerConcurrency }, 'agent run worker started');
  return () => {
    stopped = true;
    clearInterval(poll);
    clearInterval(beat);
  };
}

/** For tests and the status endpoint. */
export function inFlightRunIds(): string[] {
  return [...inFlight];
}

export { and, inArray, sql };
