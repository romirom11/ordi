/**
 * Dispatch and the run lifecycle (plan 2026-09-05-001, R12-R16, R25-R35,
 * R47, R50, R51): an assignment queues a run through the outbox, one active
 * run per task, the worker drives an injected runtime and git runner end to
 * end (token, prompt, mcpServers via the gateway, publish, comment, status,
 * revoke), needs_input and rate limits with a fallback credential, cancel,
 * follow-ups from comments, secret scrubbing and stale-run recovery.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { getDb, schema, eq, and, desc } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import {
  setupWorkspace, createAgent, addProjectMember, addCredential, drainOutbox, runsForTask, eventsForRun, type Workspace,
} from './agents-helpers';
import { setRuntimeAdapter, type RuntimeAdapter, type RuntimeOutcome, type RuntimeRunInput, type RuntimeUsage } from '../domains/agents/runtime';
import { setGitRunner, harnessDir, taskDir, pruneTaskDirs, type GitRunner } from '../domains/agents/workspace';
import { executeRun, completionStatus } from '../workers/agent-runs';
import { claimRuns, requeueStaleRuns, listRuns, cancelRun } from '../domains/agents/runs';
import { env } from '../env';

let ws: Workspace;
let agentId: string;
let primaryId: string;
let restoreAdapter: (() => void) | null = null;

const usage: RuntimeUsage = { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, costUsd: 0.01, turns: 2, durationMs: 100 };

function adapter(run: (input: RuntimeRunInput) => Promise<RuntimeOutcome>): RuntimeAdapter {
  return {
    runtime: 'claude_code',
    available: async () => ({ ok: true, version: 'test', error: null }),
    verify: async () => ({ ok: true, error: null, model: 'test' }),
    run,
  };
}

const done = (report: Partial<NonNullable<RuntimeOutcome['report']>> = {}): RuntimeOutcome => ({
  status: 'succeeded', sessionId: 'sess-42', message: 'Done', error: null, usage, retryAt: null,
  report: { status: 'done', summary: 'Fixed the retry logic and added a test.', prUrl: null, branch: null, question: null, ...report },
});

/** A git runner that records calls and pretends there is one commit ahead. */
function fakeGit(log: string[][] = []): GitRunner {
  return async (args, opts) => {
    log.push(args);
    if (args[0] === 'clone') { await mkdir(args[args.length - 1]!, { recursive: true }); return { stdout: '', stderr: '' }; }
    if (args[0] === 'ls-remote') return { stdout: '', stderr: '' };
    if (args[0] === 'status') return { stdout: '', stderr: '' };
    if (args[0] === 'rev-list') return { stdout: '1\n', stderr: '' };
    if (args[0] === 'push') { expect(opts.repo?.token).toBeTruthy(); return { stdout: '', stderr: '' }; }
    return { stdout: '', stderr: '' };
  };
}

async function linkRepository(projectId: string): Promise<void> {
  const { db } = getDb();
  const { encrypt } = await import('../lib/crypto');
  const connId = '01JCONNTEST00000000000000A';
  await db.insert(schema.gitConnections).values({ id: connId, provider: 'github', credentials: encrypt(JSON.stringify({ token: 'ghp_repo_token_secret' })), webhookSecret: 'w', status: 'connected' }).onConflictDoNothing();
  const repoId = '01JREPOTEST00000000000000A';
  await db.insert(schema.gitRepositories).values({ id: repoId, connectionId: connId, externalId: '1', fullName: 'acme/app', defaultBranch: 'main' }).onConflictDoNothing();
  await db.insert(schema.projectRepositories).values({ projectId, repositoryId: repoId }).onConflictDoNothing();
}

/** Each scenario starts from an empty queue: leftovers of earlier tests are cancelled. */
async function newTask(title: string): Promise<{ id: string; version: number }> {
  const { db } = getDb();
  await drainOutbox();
  for (const status of ['queued', 'waiting_quota', 'claimed'] as const) {
    await db.update(schema.agentRuns).set({ status: 'cancelled' })
      .where(and(eq(schema.agentRuns.agentUserId, agentId), eq(schema.agentRuns.status, status)));
  }
  return json(reqAs(ws.users.owner!.cookie).post('/tasks', { projectId: ws.projectId, title, statusId: ws.todoStatusId }));
}

async function assign(taskId: string, ids: string[]): Promise<void> {
  const owner = reqAs(ws.users.owner!.cookie);
  const t = await json(owner.get(`/tasks/${taskId}`));
  const res = await owner.patch(`/tasks/${taskId}`, { version: t.version, assigneeIds: ids });
  if (res.status !== 200) throw new Error(`assign failed ${res.status} ${await res.text()}`);
  await drainOutbox();
}

async function runToEnd(taskId: string) {
  const [run] = await runsForTask(taskId);
  const [claimed] = await claimRuns('test-worker', 1);
  expect(claimed?.id).toBe(run!.id);
  await executeRun(claimed!);
  const { db } = getDb();
  const [after] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run!.id));
  return after!;
}

beforeAll(async () => {
  await resetDb();
  env.agentWorkDir = `/tmp/claude-0/ordi-agent-tests-${process.pid}`;
  await mkdir(env.agentWorkDir, { recursive: true });
  const users = await seedRolesAndUsers();
  ws = await setupWorkspace(users, 'DSP');
  primaryId = (await addCredential(users, { label: 'Primary', secret: 'sk-ant-primary-secret-value', slot: 'primary' })).id;
  const agent = await createAgent(users, { name: 'Claude', maxRunMinutes: 5, instructions: 'Prefer small diffs.' });
  agentId = agent.id;
  await addProjectMember(users, ws.projectId, agent.id);
  await linkRepository(ws.projectId);
  setGitRunner(fakeGit());
});

afterEach(() => { restoreAdapter?.(); restoreAdapter = null; setGitRunner(fakeGit()); });

describe('dispatch', () => {
  it('queues a run when a task is assigned to an agent, and only one active run per task', async () => {
    const task = await newTask('Queue me');
    await assign(task.id, [agentId]);
    const runs = await runsForTask(task.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'queued', trigger: 'assigned', agentUserId: agentId, requestedBy: ws.users.owner!.userId });
    // The acknowledgement comes with the ack event; a second assignment is coalesced.
    await assign(task.id, []);
    await assign(task.id, [agentId]);
    expect(await runsForTask(task.id)).toHaveLength(1);
    const events = await eventsForRun(runs[0]!.id);
    expect(events[0]!.type).toBe('status');
  });

  it('the events endpoint returns the tail of a long log, and reads forward from ?after=', async () => {
    const { db } = getDb();
    const task = await newTask('Long log');
    await assign(task.id, [agentId]);
    const [run] = await runsForTask(task.id);
    // The ack event is already there; top the run up well past one page.
    const existing = (await eventsForRun(run!.id)).length;
    const total = existing + 620;
    await db.insert(schema.agentRunEvents).values(
      Array.from({ length: total - existing }, (_, i) => ({
        id: ulid(), runId: run!.id, seq: existing + i + 1, type: 'log', payload: { message: `line ${existing + i + 1}` },
      })),
    );
    const owner = reqAs(ws.users.owner!.cookie);
    const tail = (await json(owner.get(`/agent-runs/${run!.id}/events`))).data as { seq: number }[];
    expect(tail).toHaveLength(500);
    expect(tail[0]!.seq).toBe(total - 499);
    expect(tail.at(-1)!.seq).toBe(total);
    const incremental = (await json(owner.get(`/agent-runs/${run!.id}/events?after=${total - 3}`))).data as { seq: number }[];
    expect(incremental.map((e) => e.seq)).toEqual([total - 2, total - 1, total]);
  });

  it('does not dispatch for humans or disabled agents', async () => {
    const task = await newTask('Humans only');
    await assign(task.id, [ws.users.member!.userId]);
    expect(await runsForTask(task.id)).toHaveLength(0);
    const owner = reqAs(ws.users.owner!.cookie);
    const sleepy = await createAgent(ws.users, { name: 'Sleepy' });
    await addProjectMember(ws.users, ws.projectId, sleepy.id);
    await owner.post(`/agents/${sleepy.id}/disable`);
    const other = await newTask('Disabled agent');
    const t = await json(owner.get(`/tasks/${other.id}`));
    // Inactive users are refused as assignees by the picker; going through the API the run must still not appear.
    await owner.patch(`/tasks/${other.id}`, { version: t.version, assigneeIds: [sleepy.id] });
    await drainOutbox();
    expect(await runsForTask(other.id)).toHaveLength(0);
  });

  it('two agents on one task each get their own run', async () => {
    const task = await newTask('Pair');
    const second = await createAgent(ws.users, { name: 'Second' });
    await addProjectMember(ws.users, ws.projectId, second.id);
    await assign(task.id, [agentId, second.id]);
    const runs = await runsForTask(task.id);
    expect(runs.map((r) => r.agentUserId).sort()).toEqual([agentId, second.id].sort());
    const { db } = getDb();
    await db.update(schema.agentRuns).set({ status: 'cancelled' }).where(eq(schema.agentRuns.taskId, task.id));
    await db.update(schema.agentProfiles).set({ enabled: false }).where(eq(schema.agentProfiles.userId, second.id));
  });

  it('a closed task gets no run, whether assigned or commented on', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const task = await newTask('Already done');
    const statuses = (await json(owner.get(`/projects/${ws.projectId}/task-statuses`))).data as { id: string; category: string }[];
    const doneStatus = statuses.find((s) => s.category === 'done')!;
    const t = await json(owner.get(`/tasks/${task.id}`));
    await owner.patch(`/tasks/${task.id}`, { version: t.version, statusId: doneStatus.id });
    await assign(task.id, [agentId]);
    expect(await runsForTask(task.id)).toHaveLength(0);
    await owner.post(`/tasks/${task.id}/comments`, { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reopen?' }] }] } });
    await drainOutbox();
    expect(await runsForTask(task.id)).toHaveLength(0);
  });

  it('an agent cannot cancel or retry runs with its own token', async () => {
    const task = await newTask('Hands off');
    await assign(task.id, [agentId]);
    const [run] = await runsForTask(task.id);
    const { agentActor } = await import('../workers/agent-runs');
    const runsSvc = await import('../domains/agents/runs');
    await expect(cancelRun(await agentActor(agentId), run!.id)).rejects.toMatchObject({ code: 'forbidden' });
    await cancelRun(await agentActor(ws.users.owner!.userId), run!.id);
    await expect(runsSvc.retryRun(await agentActor(agentId), run!.id)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('claim respects per-agent concurrency', async () => {
    const a = await newTask('Conc A');
    const b = await newTask('Conc B');
    await assign(a.id, [agentId]);
    await assign(b.id, [agentId]);
    const first = await claimRuns('w1', 5);
    expect(first).toHaveLength(1); // concurrency 1: the second stays queued
    const second = await claimRuns('w1', 5);
    expect(second).toHaveLength(0);
    const { db } = getDb();
    await db.update(schema.agentRuns).set({ status: 'cancelled' }).where(eq(schema.agentRuns.id, first[0]!.id));
    expect(await claimRuns('w1', 5)).toHaveLength(1);
    await db.update(schema.agentRuns).set({ status: 'cancelled' }).where(and(eq(schema.agentRuns.taskId, b.id)));
  });
});

describe('the worker end to end', () => {
  it('succeeds: token minted with the role scope, brief and rules built, gateway servers wired, branch published, comment posted, status moved, token revoked', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const task = await newTask('Fix the retry logic');
    await assign(task.id, [agentId]);
    let seen: RuntimeRunInput | null = null;
    restoreAdapter = setRuntimeAdapter(adapter(async (input) => {
      seen = input;
      await input.onEvent({ type: 'init', sessionId: 'sess-42', model: 'claude-test', mcpServers: [{ name: 'ordi', status: 'connected' }] });
      await input.onEvent({ type: 'assistant', text: `Using sk-ant-primary-secret-value now`, toolUses: [] });
      await writeFile(`${input.cwd}/fix.txt`, 'fixed');
      return done({ branch: null });
    }));
    const gitLog: string[][] = [];
    setGitRunner(fakeGit(gitLog));

    const run = await runToEnd(task.id);
    expect(run.status).toBe('succeeded');
    expect(run.branch).toMatch(/dsp-\d+-fix-the-retry-logic$/);
    expect(run.usage).toMatchObject({ costUsd: 0.01, turns: 2, credentialId: primaryId });
    expect(run.sessionId).toBe('sess-42');

    // The runtime got the rebuilt input.
    const input = seen!;
    expect(input.credential).toEqual({ kind: 'api_key', secret: 'sk-ant-primary-secret-value' });
    expect(input.prompt).toContain('DSP-');
    expect(input.prompt).toContain('Fix the retry logic');
    expect(input.systemAppend).toContain('Prefer small diffs.');
    expect(input.systemAppend).toMatch(/review/i);
    expect(Object.keys(input.mcpServers)).toEqual(['ordi']);
    expect(input.mcpServers.ordi!.url).toContain('/api/v1/mcp');
    expect(input.allowedTools).toContain('mcp__ordi');
    expect(input.maxTurns).toBe(200);
    expect(input.cwd).toContain(task.id);

    // Git: clone, branch, push with the repo token; the token never reaches the log.
    expect(gitLog.some((a) => a[0] === 'clone')).toBe(true);
    expect(gitLog.some((a) => a[0] === 'checkout' && a[1] === '-b')).toBe(true);
    expect(gitLog.some((a) => a[0] === 'push')).toBe(true);
    const events = await eventsForRun(run.id);
    const dump = JSON.stringify(events);
    expect(dump).not.toContain('sk-ant-primary-secret-value');
    expect(dump).not.toContain('ghp_repo_token_secret');
    expect(dump).toContain('[redacted]');
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['status', 'log', 'init', 'assistant', 'result']));

    // The task: comment from the agent, status moved to review.
    const detail = await json(owner.get(`/tasks/${task.id}?include=comments`));
    expect(detail.statusId).toBe(ws.reviewStatusId);
    const agentComments = (detail.comments as { authorId: string }[]).filter((c) => c.authorId === agentId);
    expect(agentComments.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(agentComments.at(-1))).toContain('Fixed the retry logic');

    // The per-run token is revoked and was scoped to the agent role.
    const { db } = getDb();
    const [tok] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, run.tokenId!));
    expect(tok!.revokedAt).not.toBeNull();
    expect(tok!.scopes).toEqual(expect.arrayContaining(['projects.read', 'projects.write', 'kb.read']));
    expect(tok!.scopes).not.toContain('finance.read');

    // Activity names the agent as the actor.
    const acts = await db.select().from(schema.activityLog).where(and(eq(schema.activityLog.entityId, task.id), eq(schema.activityLog.action, 'agent_run_succeeded')));
    expect(acts[0]!.actorType).toBe('agent');

    // Runs are readable by task viewers with the agent's name.
    const list = await listRuns(await import('../workers/agent-runs').then((m) => m.agentActor(ws.users.member!.userId)), { taskId: task.id, limit: 10 });
    expect(list[0]!.agentName).toBe('Claude');
  });

  it('a needs_input report posts the question and ends the run as needs_input', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const task = await newTask('Ambiguous');
    await assign(task.id, [agentId]);
    restoreAdapter = setRuntimeAdapter(adapter(async () => ({
      status: 'needs_input', sessionId: 's2', message: '', error: null, usage, retryAt: null,
      report: { status: 'needs_input', summary: 'Need the target API version', prUrl: null, branch: null, question: 'Should this target v1 or v2?' },
    })));
    const run = await runToEnd(task.id);
    expect(run.status).toBe('needs_input');
    const detail = await json(owner.get(`/tasks/${task.id}?include=comments`));
    expect(JSON.stringify(detail.comments)).toContain('v1 or v2');
    expect(detail.statusId).toBe(ws.todoStatusId);
    const { db } = getDb();
    const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, ws.users.owner!.userId));
    await drainOutbox();
    const after = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, ws.users.owner!.userId));
    expect(after.some((n) => n.type === 'agent.needs_input')).toBe(true);
    expect(after.length).toBeGreaterThanOrEqual(notes.length);
  });

  it('a rate-limited primary switches to the fallback credential; with none left the run waits for quota', async () => {
    const fallback = await addCredential(ws.users, { label: 'Fallback', secret: 'sk-ant-fallback-secret-value', slot: 'fallback' });
    const task = await newTask('Limited');
    await assign(task.id, [agentId]);
    const secrets: string[] = [];
    restoreAdapter = setRuntimeAdapter(adapter(async (input) => {
      secrets.push(input.credential.secret);
      if (input.credential.secret.includes('primary')) {
        return { status: 'rate_limited', sessionId: null, message: '', error: "You've hit your usage limit", usage, retryAt: Date.now() + 60_000, report: null };
      }
      return done();
    }));
    const run = await runToEnd(task.id);
    expect(run.status).toBe('succeeded');
    expect(secrets).toEqual(['sk-ant-primary-secret-value', 'sk-ant-fallback-secret-value']);
    expect((run.usage as { credentialId: string }).credentialId).toBe(fallback.id);

    // Both limited: park the run until the window resets, token revoked meanwhile.
    const owner = reqAs(ws.users.owner!.cookie);
    await owner.del(`/agent-credentials/${fallback.id}`);
    const parked = await newTask('Parked');
    await assign(parked.id, [agentId]);
    restoreAdapter();
    restoreAdapter = setRuntimeAdapter(adapter(async () => ({ status: 'rate_limited', sessionId: 's-rl', message: '', error: 'limit', usage, retryAt: Date.now() + 3600_000, report: null })));
    const parkedGit: string[][] = [];
    setGitRunner(fakeGit(parkedGit));
    const waiting = await runToEnd(parked.id);
    expect(waiting.status).toBe('waiting_quota');
    expect(waiting.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    // Parked, not abandoned: the work is pushed and the run resumes the same session on the same branch.
    expect(parkedGit.some((a) => a[0] === 'push')).toBe(true);
    expect(waiting.sessionId).toBe('s-rl');
    expect(waiting.branch).toMatch(/dsp-\d+-/);
    const { db } = getDb();
    const [tok] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, agentId)).orderBy(desc(schema.apiTokens.createdAt)).limit(1);
    expect(tok!.revokedAt).not.toBeNull();
    // Not claimable until the retry time.
    expect((await claimRuns('w', 5)).length).toBe(0);
    await db.update(schema.agentRuns).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(schema.agentRuns.id, waiting.id));
    const reclaimed = await claimRuns('w', 5);
    expect(reclaimed.map((r) => r.id)).toContain(waiting.id);
    await db.update(schema.agentRuns).set({ status: 'cancelled' }).where(eq(schema.agentRuns.id, waiting.id));
  });

  it('a failed runtime posts the error and does not move the task', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const task = await newTask('Broken');
    await assign(task.id, [agentId]);
    restoreAdapter = setRuntimeAdapter(adapter(async () => ({ status: 'failed', sessionId: 's3', message: '', error: 'Reached maximum number of turns (60)', usage, retryAt: null, report: null })));
    const gitLog: string[][] = [];
    setGitRunner(fakeGit(gitLog));
    const run = await runToEnd(task.id);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('maximum number of turns');
    // Unfinished work is pushed to the branch, but no pull request is opened.
    expect(gitLog.some((a) => a[0] === 'push')).toBe(true);
    expect(run.branch).toMatch(/dsp-\d+-broken$/);
    expect(run.prUrl).toBeNull();
    const detail = await json(owner.get(`/tasks/${task.id}?include=comments`));
    expect(detail.statusId).toBe(ws.todoStatusId);
    const last = JSON.stringify((detail.comments as unknown[]).at(-1));
    expect(last).toContain('Max turns');
    expect(last).toContain(run.branch);
    // Retry queues a new run that resumes the session; cancel/retry need write on the project.
    const { agentActor } = await import('../workers/agent-runs');
    const memberActor = await agentActor(ws.users.member!.userId);
    const retried = await (await import('../domains/agents/runs')).retryRun(memberActor, run.id);
    expect(retried.trigger).toBe('retry');
    expect(retried.sessionId).toBe('s3');
    expect(retried.parentRunId).toBe(run.id);
    // The retry resumes the session and tells the agent it is continuing.
    let resumed: RuntimeRunInput | null = null;
    restoreAdapter();
    restoreAdapter = setRuntimeAdapter(adapter(async (input) => { resumed = input; return done(); }));
    const [claimed] = await claimRuns('w', 1);
    await executeRun(claimed!);
    expect(resumed!.resume).toBe('s3');
    expect(resumed!.prompt).toContain('Continue');
    expect(resumed!.prompt).toContain('git status');
  });

  it('the harness home survives between runs of a task, so a follow-up can resume the session', async () => {
    const task = await newTask('Remember me');
    await assign(task.id, [agentId]);
    restoreAdapter = setRuntimeAdapter(adapter(async (input) => {
      expect(input.configDir).toBe(harnessDir(task.id));
      await writeFile(`${input.configDir}/transcript.jsonl`, 'hello');
      return done();
    }));
    const first = await runToEnd(task.id);
    expect(first.status).toBe('succeeded');
    // The checkout is gone, the harness home is not.
    await expect(stat(`${taskDir(task.id)}/checkout`)).rejects.toBeTruthy();
    expect(await readFile(`${harnessDir(task.id)}/transcript.jsonl`, 'utf8')).toBe('hello');

    // Retention: a task dir last touched before the cutoff is pruned, a fresh one stays.
    const old = new Date(Date.now() - 40 * 86_400_000);
    await utimes(taskDir(task.id), old, old);
    const other = await newTask('Keep me');
    await mkdir(harnessDir(other.id), { recursive: true });
    expect(await pruneTaskDirs(new Date(Date.now() - 30 * 86_400_000))).toBe(1);
    await expect(stat(taskDir(task.id))).rejects.toBeTruthy();
    await expect(stat(taskDir(other.id))).resolves.toBeTruthy();
  });

  it('a retry whose session is gone starts a fresh one on the same branch instead of failing', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const task = await newTask('Lost session');
    await assign(task.id, [agentId]);
    restoreAdapter = setRuntimeAdapter(adapter(async () => ({ status: 'failed', sessionId: 'gone-1', message: '', error: 'Reached maximum number of turns (200)', usage, retryAt: null, report: null })));
    const first = await runToEnd(task.id);
    expect(first.status).toBe('failed');
    expect(first.branch).toMatch(/dsp-\d+-lost-session$/);

    const { agentActor } = await import('../workers/agent-runs');
    await (await import('../domains/agents/runs')).retryRun(await agentActor(ws.users.owner!.userId), first.id);
    const inputs: RuntimeRunInput[] = [];
    restoreAdapter();
    restoreAdapter = setRuntimeAdapter(adapter(async (input) => {
      inputs.push(input);
      if (input.resume) return { status: 'failed', sessionId: input.resume, message: '', error: `No conversation found with session ID: ${input.resume}`, usage: { ...usage, turns: 0 }, retryAt: null, report: null };
      return { ...done(), sessionId: 'fresh-2' };
    }));
    const [claimed] = await claimRuns('w', 1);
    await executeRun(claimed!);
    const { db } = getDb();
    const [after] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, claimed!.id));
    expect(after!.status).toBe('succeeded');
    expect(after!.sessionId).toBe('fresh-2');
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.resume).toBe('gone-1');
    expect(inputs[1]!.resume).toBeNull();
    // The second attempt gets the full brief plus a pointer at the branch, not the "Continue" brief.
    expect(inputs[1]!.prompt).toContain('# DSP-');
    expect(inputs[1]!.prompt).toContain('Earlier work');
    expect(inputs[1]!.prompt).toContain(first.branch);
    expect(inputs[1]!.prompt).not.toContain('# Continue');
    const events = await eventsForRun(claimed!.id);
    expect(JSON.stringify(events)).toContain('not on this worker');
    const detail = await json(owner.get(`/tasks/${task.id}?include=comments`));
    expect(JSON.stringify((detail.comments as unknown[]).at(-1))).not.toContain('No conversation found');
  });

  it('a push refused with 403 keeps the checkout and tells the user what to fix', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const task = await newTask('Denied');
    await assign(task.id, [agentId]);
    restoreAdapter = setRuntimeAdapter(adapter(async () => done()));
    setGitRunner(async (args, opts) => {
      if (args[0] === 'clone') { await mkdir(args[args.length - 1]!, { recursive: true }); return { stdout: '', stderr: '' }; }
      if (args[0] === 'rev-list') return { stdout: '1\n', stderr: '' };
      if (args[0] === 'push') throw new Error(`Command failed: git push -u origin ${opts.cwd}\nremote: Permission to acme/app.git denied to ordi[bot].\nfatal: unable to access: The requested URL returned error: 403`);
      return { stdout: '', stderr: '' };
    });
    const run = await runToEnd(task.id);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('write access');
    await expect(stat(`${taskDir(task.id)}/checkout`)).resolves.toBeTruthy();
    const detail = await json(owner.get(`/tasks/${task.id}?include=comments`));
    const last = JSON.stringify((detail.comments as unknown[]).at(-1));
    expect(last).toContain('Installed GitHub Apps');
    expect(last).toContain('Retry');
  });

  it('a cancel request aborts a running run', async () => {
    const task = await newTask('Cancel me');
    await assign(task.id, [agentId]);
    const [queued] = await runsForTask(task.id);
    restoreAdapter = setRuntimeAdapter(adapter(async (input) => {
      const { agentActor } = await import('../workers/agent-runs');
      await cancelRun(await agentActor(ws.users.owner!.userId), queued!.id);
      await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }));
      return { status: 'failed', sessionId: null, message: '', error: 'aborted', usage, retryAt: null, report: null };
    }));
    const [claimed] = await claimRuns('w', 1);
    // The worker polls for cancellation every 5s; shorten the wait by racing the poll.
    const started = Date.now();
    await executeRun(claimed!);
    const { db } = getDb();
    const [after] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, queued!.id));
    expect(after!.status).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it('a human comment while the run is in flight becomes a follow-up that resumes the session', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const task = await newTask('Talk to me');
    await assign(task.id, [agentId]);
    restoreAdapter = setRuntimeAdapter(adapter(async () => {
      await owner.post(`/tasks/${task.id}/comments`, { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Also update the docs' }] }] } });
      return done();
    }));
    const run = await runToEnd(task.id);
    expect(run.status).toBe('succeeded');
    const runs = (await runsForTask(task.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ trigger: 'comment', status: 'queued', sessionId: 'sess-42', parentRunId: run.id });

    // The follow-up prompt carries the new comment, not the whole brief, and resumes.
    let followUp: RuntimeRunInput | null = null;
    restoreAdapter();
    restoreAdapter = setRuntimeAdapter(adapter(async (input) => { followUp = input; return done({ summary: 'Docs updated too.' }); }));
    const [claimed] = await claimRuns('w', 1);
    await executeRun(claimed!);
    expect(followUp!.resume).toBe('sess-42');
    expect(followUp!.prompt).toContain('Also update the docs');
    expect(followUp!.prompt).toContain('Follow-up');
  });

  it('a comment written while the run was still queued is not lost', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const task = await newTask('Early bird');
    await assign(task.id, [agentId]);
    await owner.post(`/tasks/${task.id}/comments`, { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Before you start: use v2' }] }] } });
    await drainOutbox();
    expect(await runsForTask(task.id)).toHaveLength(1); // coalesced into the queued run
    restoreAdapter = setRuntimeAdapter(adapter(async () => done()));
    const run = await runToEnd(task.id);
    expect(run.status).toBe('succeeded');
    const runs = (await runsForTask(task.id)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(runs).toHaveLength(2);
    expect(runs[1]).toMatchObject({ trigger: 'comment', status: 'queued', sessionId: 'sess-42', branch: run.branch, parentRunId: run.id });
  });

  it('a comment on an idle task with an agent assignee queues a follow-up run', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const task = await newTask('Idle');
    await assign(task.id, [agentId]);
    restoreAdapter = setRuntimeAdapter(adapter(async () => done()));
    await runToEnd(task.id);
    await owner.post(`/tasks/${task.id}/comments`, { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One more thing' }] }] } });
    await drainOutbox();
    const runs = await runsForTask(task.id);
    expect(runs.filter((r) => r.trigger === 'comment' && r.status === 'queued')).toHaveLength(1);
    // The agent's own comments never trigger it.
    const { agentActor } = await import('../workers/agent-runs');
    const svc = await import('../domains/projects/service');
    await svc.addComment(await agentActor(agentId), task.id, { body: { type: 'doc', content: [] } });
    await drainOutbox();
    expect((await runsForTask(task.id)).filter((r) => r.trigger === 'comment')).toHaveLength(1);
  });

  it('stale running rows are re-queued, and failed after three attempts', async () => {
    const { db } = getDb();
    const task = await newTask('Stale');
    await assign(task.id, [agentId]);
    const [run] = await runsForTask(task.id);
    // updated_at is trigger-maintained, so "stale" is expressed through the cutoff instead.
    await db.update(schema.agentRuns).set({ status: 'running', attempts: 1 }).where(eq(schema.agentRuns.id, run!.id));
    expect(await requeueStaleRuns(new Date(Date.now() + 1000))).toBeGreaterThanOrEqual(1);
    let [after] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run!.id));
    expect(after!.status).toBe('queued');
    await db.update(schema.agentRuns).set({ status: 'running', attempts: 3 }).where(eq(schema.agentRuns.id, run!.id));
    await requeueStaleRuns(new Date(Date.now() + 1000));
    [after] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, run!.id));
    expect(after!.status).toBe('failed');
  });

  it('resolves the review status by name, else the last in-progress status', async () => {
    const status = await completionStatus(ws.projectId, 'in_review');
    expect(status?.id).toBe(ws.reviewStatusId);
  });

  it('a run without any credential fails with a clear reason', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const { db } = getDb();
    await db.update(schema.agentCredentials).set({ status: 'revoked', slot: null });
    const task = await newTask('No key');
    await assign(task.id, [agentId]);
    const run = await runToEnd(task.id);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/credential/i);
    expect((await json(owner.get(`/agents/${agentId}`))).dispatchable).toBe(false);
  });
});
