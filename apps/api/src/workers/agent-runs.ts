/**
 * Agent run worker (plan 2026-09-05-001, R14, R16, R26-R35): claims due
 * runs, prepares a checkout, drives the runtime adapter, streams events,
 * publishes the branch and reports back. It runs inside the API process or
 * as a process of its own; the only difference is the RunBackend it is
 * given, and nothing here touches the database, the encryption key or any
 * other secret of the API's - this is the process that executes code the
 * model wrote, so it holds only what the run in front of it needs.
 */
import { hostname } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { env } from '../env';
import { logger } from '../lib/logger';
import { SERVER_VERSION } from '../version';
import type { ClaimedRun, PublishOutcome, RunBackend } from '../domains/agents/run-backend';
import { runtimeAdapter, type RuntimeEvent, type RuntimeMcpServer, type RuntimeOutcome } from '../domains/agents/runtime';
import { allowedToolsFor, DISALLOWED_TOOLS } from '../domains/agents/runtime/tools';
import {
  cleanupWorkspace, explainPushError, harnessDir, prepareWorkspace, pruneTaskDirs, publishWorkspace, readPullRequestTemplate,
  SESSION_RETENTION_DAYS, type Workspace,
} from '../domains/agents/workspace';

const POLL_MS = 3_000;
const HEARTBEAT_MS = 15_000;
const QUOTA_RETRY_DEFAULT_MS = 30 * 60_000;
const PRUNE_MS = 6 * 60 * 60_000;

export const workerId = `${hostname()}:${process.pid}`;
const inFlight = new Set<string>();

/** Execute one claimed run end to end. Exported for tests, which inject a runtime adapter and a git runner. */
export async function executeRun(backend: RunBackend, claimed: ClaimedRun): Promise<void> {
  const runId = claimed.id;
  inFlight.add(runId);
  let ws: Workspace | null = null;
  // A checkout whose push failed holds commits nobody else has: keep it for the retry.
  let keepCheckout = false;
  // Outside the checkout, so nothing of it ends up in the agent's commits,
  // and per task rather than per run: the session transcript written here
  // is what a follow-up or a retry resumes.
  const configDir = harnessDir(claimed.taskId);
  // Liveness from claim to finish: a slow clone or push must not look like a
  // dead worker to the stale-run sweep.
  const liveness = setInterval(() => { void backend.touch(runId).catch(() => {}); }, 30_000);
  const log = (message: string) => backend.event(runId, 'log', { message });
  try {
    const bundle = await backend.prepare(runId);
    const { profile, agent, task, project, credentials } = bundle;
    if (!credentials.length) {
      await backend.fail(runId, 'No active Claude credential; connect one under Settings → Agents');
      return;
    }

    const runtime = runtimeAdapter(bundle.runtime);
    // A new branch gets an English name from the cheapest model, whatever
    // language the task is written in; transliteration is the fallback.
    let suggestedSlug: string | null = null;
    if (!claimed.branch) {
      await mkdir(configDir, { recursive: true });
      suggestedSlug = await runtime.suggestBranchSlug({
        title: task.title, description: task.description.slice(0, 1500),
        credential: { kind: credentials[0]!.kind, secret: credentials[0]!.secret }, configDir,
      }).catch(() => null);
    }
    ws = await prepareWorkspace({
      taskId: task.id, projectId: project.id, projectKey: project.key, taskNumber: task.number, taskTitle: task.title,
      existingBranch: claimed.branch ?? null, suggestedSlug, agentName: agent.name, agentEmail: agent.email, repo: bundle.repo,
    });
    await log(ws.repo ? `${ws.reused ? 'Continuing the previous run\'s unpushed checkout of' : 'Checked out'} ${ws.repo.fullName} on ${ws.branch}` : 'No repository linked; working in a scratch directory');

    const started = await backend.start(runId, {
      branch: ws.branch, reused: Boolean(ws.reused), repoFullName: ws.repo?.fullName ?? null,
      pullRequestTemplate: ws.repo ? await readPullRequestTemplate(ws.dir) : null,
    });
    if (!started) return; // cancelled during preparation
    const token = started.token;
    const ref = `${project.key}-${task.number}`;
    const base = backend.apiBase();
    const mcpServers: Record<string, RuntimeMcpServer> = {
      // alwaysLoad: the brief tells the agent to call get_task first, so the
      // tools must be in the prompt on turn 1 rather than behind tool search.
      ordi: { type: 'http', url: `${base}/mcp`, headers: { Authorization: `Bearer ${token}` }, alwaysLoad: true },
    };
    for (const slug of bundle.connectors) {
      mcpServers[slug] = { type: 'http', url: `${base}/mcp-connectors/${slug}/mcp`, headers: { Authorization: `Bearer ${token}` } };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), profile.maxRunMinutes * 60_000);
    const cancelPoll = setInterval(async () => {
      if (await backend.cancelRequested(runId).catch(() => false)) controller.abort(new Error('cancelled'));
    }, 5_000);

    let outcome: RuntimeOutcome | null = null;
    let usedCredentialId: string | null = null;
    let resume = claimed.sessionId ?? null;
    let prompt = started.prompt;
    /** One runtime event into the run log. */
    const recordEvent = async (event: RuntimeEvent): Promise<void> => {
      switch (event.type) {
        case 'init':
          await backend.progress(runId, { sessionId: event.sessionId });
          await backend.event(runId, 'init', { sessionId: event.sessionId, model: event.model, mcpServers: event.mcpServers });
          break;
        case 'assistant': if (event.text || event.toolUses.length) await backend.event(runId, 'assistant', { text: event.text.slice(0, 8000), toolUses: event.toolUses.map((t) => ({ id: t.id, name: t.name })) }); break;
        case 'tool_use': await backend.event(runId, 'tool_use', { toolUseId: event.toolUseId, name: event.name, input: truncate(event.input) }); break;
        case 'tool_result': await backend.event(runId, 'tool_result', { toolUseId: event.toolUseId, text: event.text.slice(0, 2000), isError: event.isError }); break;
        case 'rate_limit': await backend.event(runId, 'rate_limit', { status: event.status, resetsAt: epochToIso(event.resetsAt), limitType: event.limitType }); break;
        case 'log': await backend.event(runId, 'log', { message: event.message }); break;
      }
    };
    const workspace = ws;
    /** Try the credential chain once; the last outcome is returned. */
    const attempt = async (): Promise<RuntimeOutcome> => {
      let last: RuntimeOutcome | null = null;
      for (const cred of credentials) {
        usedCredentialId = cred.id;
        await log(`Starting ${bundle.runtime} with credential ${cred.id === credentials[0]!.id ? '(primary)' : '(fallback)'}`);
        last = await runtime.run({
          prompt, systemAppend: started.systemAppend, cwd: workspace.dir, configDir, credential: { kind: cred.kind, secret: cred.secret },
          model: profile.model, mcpServers, maxTurns: profile.maxTurns,
          maxBudgetUsd: cred.kind === 'api_key' && profile.maxBudgetUsd != null ? profile.maxBudgetUsd : null,
          resume, allowedTools: allowedToolsFor(Object.keys(mcpServers)), disallowedTools: DISALLOWED_TOOLS,
          // A failed log write (a DB blip, a payload Postgres rejects, the
          // API unreachable for a moment) must not end the agent's session:
          // the line is lost, the run goes on.
          onEvent: async (event) => {
            try {
              await recordEvent(event);
            } catch (e) {
              logger.warn({ err: e, runId, eventType: event.type }, 'run event not recorded');
            }
          },
          signal: controller.signal,
        });
        if (last.sessionId) resume = last.sessionId;
        if (last.status !== 'rate_limited') break;
        await log(`Credential ${cred.id} is rate limited${credentials.indexOf(cred) < credentials.length - 1 ? ', switching to the fallback' : ''}`);
      }
      return last!;
    };
    try {
      outcome = await attempt();
      // The session to resume is gone (another worker's disk, a pruned or
      // rebuilt volume): start over on the branch instead of failing.
      if (sessionLost(outcome) && claimed.sessionId) {
        await log(`Session ${claimed.sessionId} is not on this worker; starting a fresh one on the same branch`);
        resume = null;
        prompt = started.promptIfSessionLost;
        outcome = await attempt();
      }
    } finally {
      clearTimeout(timer);
      clearInterval(cancelPoll);
    }

    const refreshRepo = () => backend.repository(runId);
    // A run that stops early (limit, timeout, cancel, error) must not lose
    // what the agent already did: the branch is pushed without a pull
    // request, and a retry continues on it with the same session.
    const preserveWork = async (): Promise<PublishOutcome> => {
      try {
        const kept = await publishWorkspace(workspace, { ref, title: task.title, summary: '', existingPrUrl: claimed.prUrl ?? null, openPullRequest: false, refreshRepo });
        if (kept.pushed) await log(`Pushed ${kept.commits ?? 'the'} commit(s) of unfinished work to ${workspace.branch}`);
        return { pushed: kept.pushed, prUrl: kept.prUrl, commits: kept.commits, error: null };
      } catch (e) {
        keepCheckout = true;
        const why = explainPushError((e as Error).message);
        await backend.event(runId, 'error', { message: `Could not push unfinished work: ${why}` });
        return { pushed: false, prUrl: null, commits: null, error: why };
      }
    };
    const aborted = controller.signal.aborted
      ? ((controller.signal.reason as Error | undefined)?.message === 'timeout' ? 'timeout' : 'cancelled')
      : null;

    let publish: PublishOutcome | null = null;
    if (aborted || outcome.status === 'failed' || outcome.status === 'rate_limited') {
      publish = await preserveWork();
    } else if (outcome.status === 'succeeded') {
      const summary = outcome.report?.summary?.trim() || outcome.message?.trim() || 'Done.';
      try {
        const published = await publishWorkspace(workspace, {
          ref, title: task.title, summary, existingPrUrl: outcome.report?.prUrl ?? claimed.prUrl ?? null,
          verification: outcome.report?.verification ?? null, risks: outcome.report?.risks ?? null,
          taskUrl: bundle.taskUrl, refreshRepo,
        });
        if (published.pushed) await log(`Pushed ${published.commits ?? 'the'} commit(s) to ${workspace.branch}${published.prUrl ? `; pull request ${published.prUrl}` : ''}`);
        else if (workspace.repo) await log('No commits to push');
        publish = { pushed: published.pushed, prUrl: published.prUrl, commits: published.commits, error: null };
      } catch (e) {
        keepCheckout = true;
        const why = explainPushError((e as Error).message);
        await backend.event(runId, 'error', { message: `Publishing the branch failed: ${why}` });
        publish = { pushed: false, prUrl: null, commits: null, error: why };
      }
    }

    if (!aborted && outcome.status === 'rate_limited') {
      // The parked run resumes the same session on the same branch when the window resets.
      const retryAt = new Date(outcome.retryAt ?? Date.now() + QUOTA_RETRY_DEFAULT_MS);
      await backend.park(runId, {
        retryAt: retryAt.toISOString(), reason: outcome.error ?? 'Provider rate limit',
        sessionId: outcome.sessionId, branch: publish?.pushed ? workspace.branch : null,
      });
      return;
    }
    await backend.finish(runId, { outcome, usedCredentialId, aborted, publish, branch: workspace.branch });
  } catch (e) {
    logger.error({ err: e, runId }, 'agent run crashed');
    await backend.fail(runId, (e as Error).message).catch((err) => logger.error({ err, runId }, 'could not report the crashed run'));
  } finally {
    clearInterval(liveness);
    inFlight.delete(runId);
    await cleanupWorkspace(claimed.taskId, { keepCheckout }).catch(() => {});
  }
}

/** The runtime could not find the transcript it was asked to resume. */
function sessionLost(outcome: RuntimeOutcome): boolean {
  return outcome.status === 'failed' && /no conversation found/i.test(outcome.error ?? '');
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

/** One poll: claim what fits, start it in the background. */
export async function pollOnce(backend: RunBackend): Promise<number> {
  const free = env.agentWorkerConcurrency - inFlight.size;
  if (free <= 0) return 0;
  const claimed = await backend.claim(workerId, free);
  for (const run of claimed) void executeRun(backend, run);
  return claimed.length;
}

export function startAgentRunsWorker(backend: RunBackend): () => void {
  let stopped = false;
  let runtimeAvailable = false;
  const beat = () => backend.heartbeat({
    workerId, concurrency: env.agentWorkerConcurrency, running: inFlight.size, runtimeAvailable, version: SERVER_VERSION,
  });
  void runtimeAdapter('claude_code').available().then((a) => { runtimeAvailable = a.ok; if (!a.ok) logger.warn({ error: a.error }, 'claude runtime unavailable'); });
  void mkdir(env.agentWorkDir, { recursive: true }).catch((e) => logger.warn({ err: e, dir: env.agentWorkDir }, 'agent work dir unavailable'));
  const poll = setInterval(() => { if (!stopped) pollOnce(backend).catch((e) => logger.error({ err: e }, 'agent worker poll failed')); }, POLL_MS);
  const heartbeat = setInterval(() => { if (!stopped) beat().catch((e) => logger.warn({ err: e }, 'agent worker heartbeat failed')); }, HEARTBEAT_MS);
  const prune = setInterval(() => { if (!stopped) pruneSessions().catch(() => {}); }, PRUNE_MS);
  void beat().catch((e) => logger.warn({ err: e }, 'agent worker heartbeat failed'));
  void pruneSessions().catch(() => {});
  logger.info({ workerId, concurrency: env.agentWorkerConcurrency, api: backend.apiBase() }, 'agent run worker started');
  return () => {
    stopped = true;
    clearInterval(poll);
    clearInterval(heartbeat);
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
