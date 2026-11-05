/**
 * Project secrets in agent runs (plan 2026-11-05-001, U4, R21-R29).
 *
 * A secret switched on for agents reaches the run's environment, by variable
 * name, and nowhere else: not the prompt, not the run log, not what the run
 * writes back to ordi, and not a pushed branch.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { getDb, schema, eq, and } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json, app } from './helpers';
import {
  setupWorkspace, createAgent, addProjectMember, addCredential, drainOutbox, runsForTask, eventsForRun, type Workspace,
} from './agents-helpers';
import { setRuntimeAdapter, type RuntimeAdapter, type RuntimeOutcome, type RuntimeRunInput, type RuntimeUsage } from '../domains/agents/runtime';
import { withExtraEnv } from '../domains/agents/runtime/types';
import { setGitRunner, type GitRunner } from '../domains/agents/workspace';
import { executeRun } from '../workers/agent-runs';
import { localRunBackend, toClaimedRun } from '../domains/agents/run-service';
import { claimRuns } from '../domains/agents/runs';
import { env } from '../env';

const KEY = 'sk_test_51SuperSecretStripeKey';
const PASSWORD = 'adm1n-Panel-Pa55word';

let ws: Workspace;
let agentId: string;
let restore: (() => void) | null = null;
const usage: RuntimeUsage = { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, costUsd: 0, turns: 1, durationMs: 1 };
const done: RuntimeOutcome = {
  status: 'succeeded', sessionId: 's', message: 'Done', error: null, usage, retryAt: null,
  report: { status: 'done', summary: 'Done.', verification: null, risks: null, prUrl: null, branch: null, question: null },
};

function adapter(run: (input: RuntimeRunInput) => Promise<RuntimeOutcome>): RuntimeAdapter {
  return {
    runtime: 'claude_code',
    available: async () => ({ ok: true, version: 'test', error: null }),
    verify: async () => ({ ok: true, error: null, model: 'test' }),
    suggestBranchSlug: async () => null,
    run,
  };
}

/** A git runner with one commit ahead whose patch is `patch`; records whether it pushed. */
function fakeGit(patch = 'fix: retry\n+const key = process.env.STRIPE_TEST;\n', pushed: string[][] = [], logs: string[][] = []): GitRunner {
  return async (args) => {
    if (args.includes('log')) logs.push(args);
    if (args[0] === 'clone') { await mkdir(args[args.length - 1]!, { recursive: true }); return { stdout: '', stderr: '' }; }
    if (args[0] === 'rev-list') return { stdout: '1\n', stderr: '' };
    if (args.includes('log')) return { stdout: patch, stderr: '' };
    if (args[0] === 'push') pushed.push(args);
    return { stdout: '', stderr: '' };
  };
}

async function linkRepository(projectId: string): Promise<void> {
  const { db } = getDb();
  const { encrypt } = await import('../lib/crypto');
  await db.insert(schema.gitConnections).values({ id: '01JCONNSECRETS000000000000', provider: 'github', credentials: encrypt(JSON.stringify({ token: 'ghp_repo_token_secret' })), webhookSecret: 'w', status: 'connected' }).onConflictDoNothing();
  await db.insert(schema.gitRepositories).values({ id: '01JREPOSECRETS000000000000', connectionId: '01JCONNSECRETS000000000000', externalId: '9', fullName: 'acme/app', defaultBranch: 'main' }).onConflictDoNothing();
  await db.insert(schema.projectRepositories).values({ projectId, repositoryId: '01JREPOSECRETS000000000000' }).onConflictDoNothing();
}

async function runTask(title: string, by: 'owner' | 'member' = 'owner'): Promise<{ runId: string }> {
  const owner = reqAs(ws.users[by]!.cookie);
  const { db } = getDb();
  await drainOutbox();
  await db.update(schema.agentRuns).set({ status: 'cancelled' }).where(and(eq(schema.agentRuns.agentUserId, agentId), eq(schema.agentRuns.status, 'queued')));
  const task = await json(owner.post('/tasks', { projectId: ws.projectId, title, statusId: ws.todoStatusId }));
  const t = await json(owner.get(`/tasks/${task.id}`));
  await owner.patch(`/tasks/${task.id}`, { version: t.version, assigneeIds: [agentId] });
  await drainOutbox();
  const [run] = await runsForTask(task.id);
  const [claimed] = await claimRuns('secrets-worker', 1);
  expect(claimed?.id).toBe(run!.id);
  await executeRun(localRunBackend, toClaimedRun(claimed!));
  return { runId: run!.id };
}

const secret = (body: Record<string, unknown>) => reqAs(ws.users.owner!.cookie).post(`/projects/${ws.projectId}/secrets`, {
  environment: 'test', audience: [{ type: 'project' }], ...body,
});

beforeAll(async () => {
  await resetDb();
  env.agentWorkDir = `/tmp/claude-0/ordi-agent-secrets-${process.pid}`;
  await mkdir(env.agentWorkDir, { recursive: true });
  const users = await seedRolesAndUsers();
  ws = await setupWorkspace(users, 'SEC');
  await addCredential(users, { label: 'Primary', secret: 'sk-ant-primary-secret-value', slot: 'primary' });
  agentId = (await createAgent(users, { name: 'Claude', maxRunMinutes: 5 })).id;
  await addProjectMember(users, ws.projectId, agentId);
  await linkRepository(ws.projectId);
  setGitRunner(fakeGit());

  expect((await secret({ name: 'STRIPE_TEST', availableToAgents: true, fields: [{ key: 'api_key', label: 'Secret key', type: 'api_key', value: KEY }] })).status).toBe(201);
  expect((await secret({
    name: 'ADMIN_PANEL', availableToAgents: true,
    fields: [{ key: 'login', label: 'Login', type: 'text', value: 'ops@acme.test' }, { key: 'password', label: 'Password', type: 'password', value: PASSWORD }],
  })).status).toBe(201);
  expect((await secret({ name: 'NOT_FOR_AGENTS', fields: [{ key: 'v', label: 'V', type: 'password', value: 'people-only-secret-value' }] })).status).toBe(201);
  expect((await secret({ name: 'OLD_TRIAL', availableToAgents: true, expiresAt: '2000-01-01', fields: [{ key: 'v', label: 'V', type: 'password', value: 'expired-trial-key-value' }] })).status).toBe(201);
});

afterEach(() => { restore?.(); restore = null; setGitRunner(fakeGit()); });

describe('a run gets its secrets in the environment, by name', () => {
  it('passes switched-on secrets as variables and names them in the rules, never the values', async () => {
    let seen: RuntimeRunInput | null = null;
    restore = setRuntimeAdapter(adapter(async (input) => { seen = input; return done; }));
    const { runId } = await runTask('Charge a test card');

    expect(seen!.extraEnv).toEqual({
      SECRET_STRIPE_TEST: KEY, SECRET_ADMIN_PANEL__LOGIN: 'ops@acme.test', SECRET_ADMIN_PANEL__PASSWORD: PASSWORD,
    });
    expect(seen!.systemAppend).toContain('SECRET_STRIPE_TEST: STRIPE_TEST – Secret key');
    expect(seen!.systemAppend).toContain('SECRET_ADMIN_PANEL__PASSWORD');
    for (const value of [KEY, PASSWORD]) {
      expect(seen!.systemAppend).not.toContain(value);
      expect(seen!.prompt).not.toContain(value);
    }

    const log = JSON.stringify(await eventsForRun(runId));
    expect(log).toContain('Project secrets in the environment: ADMIN_PANEL, STRIPE_TEST');
    expect(log).toContain('Project secret OLD_TRIAL left out: it expired on 2000-01-01');
    expect(log).not.toContain('NOT_FOR_AGENTS');

    // The secret's own trail notes the run.
    const { db } = getDb();
    const [stripe] = await db.select().from(schema.projectSecrets).where(eq(schema.projectSecrets.name, 'STRIPE_TEST'));
    const trail = await db.select().from(schema.activityLog).where(and(eq(schema.activityLog.entityType, 'project_secret'), eq(schema.activityLog.entityId, stripe!.id)));
    expect(trail.some((a) => a.action === 'used_in_run' && (a.diff as any).run.to === runId)).toBe(true);
  });

  it('gives nothing to an agent that is not on the project', async () => {
    const outsider = await createAgent(ws.users, { name: 'Outsider' });
    const { resolveRunSecrets } = await import('../domains/secrets/service');
    const resolved = await resolveRunSecrets({ id: 'x', projectId: ws.projectId, agentUserId: outsider.id, taskId: 'x', requestedBy: ws.users.owner!.userId });
    expect(resolved.vars).toEqual([]);
    expect(resolved.skipped.every((s) => s.reason === 'the agent is not a member of the project')).toBe(true);
  });

  it('never lets a secret replace the runtime\'s own variables or change how programs behave', () => {
    // Only SECRET_ variables pass, so nothing a secret is called can reach PATH, LD_PRELOAD or a proxy.
    expect(withExtraEnv({ PATH: '/usr/bin', HOME: '/h' }, {
      PATH: '/evil', SECRET_STRIPE_TEST: 'x', LD_PRELOAD: '/tmp/x.so', HTTPS_PROXY: 'http://evil', BASH_ENV: '/tmp/x',
    })).toEqual({ PATH: '/usr/bin', HOME: '/h', SECRET_STRIPE_TEST: 'x' });
  });

  it('turns a secret named like a dangerous variable into a harmless one', async () => {
    expect((await secret({ name: 'HTTPS_PROXY', availableToAgents: true, fields: [{ key: 'v', label: 'V', type: 'password', value: 'http://proxy.example' }] })).status).toBe(201);
    let seen: RuntimeRunInput | null = null;
    restore = setRuntimeAdapter(adapter(async (input) => { seen = input; return done; }));
    await runTask('Use the proxy setting');
    expect(seen!.extraEnv!.SECRET_HTTPS_PROXY).toBe('http://proxy.example');
    expect(seen!.extraEnv!.HTTPS_PROXY).toBeUndefined();
    const { db } = getDb();
    await db.delete(schema.projectSecrets).where(eq(schema.projectSecrets.name, 'HTTPS_PROXY'));
  });

  it('hands a restricted secret only to runs started by someone who could open it', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    expect((await owner.post(`/projects/${ws.projectId}/secrets`, {
      name: 'PROD_DB', environment: 'staging', availableToAgents: true,
      audience: [{ type: 'user', id: ws.users.owner!.userId }],
      fields: [{ key: 'url', label: 'URL', type: 'password', value: 'postgres://prod-db-password@x' }],
    })).status).toBe(201);

    let seen: RuntimeRunInput | null = null;
    restore = setRuntimeAdapter(adapter(async (input) => { seen = input; return done; }));
    // `member` works on the project but is outside PROD_DB's audience.
    const byMember = await runTask('Migrate the database', 'member');
    expect(Object.keys(seen!.extraEnv ?? {})).not.toContain('SECRET_PROD_DB');
    expect(seen!.systemAppend).not.toContain('PROD_DB');
    const memberLog = JSON.stringify(await eventsForRun(byMember.runId));
    expect(memberLog).toContain('1 restricted project secret(s) left out');
    expect(memberLog).not.toContain('PROD_DB');

    restore();
    restore = setRuntimeAdapter(adapter(async (input) => { seen = input; return done; }));
    const byOwner = await runTask('Migrate the database again');
    expect(seen!.extraEnv!.SECRET_PROD_DB).toBe('postgres://prod-db-password@x');
    const ownerLog = JSON.stringify(await eventsForRun(byOwner.runId));
    expect(ownerLog).toContain('1 restricted');
    expect(ownerLog).not.toContain('PROD_DB');
    const { db } = getDb();
    await db.delete(schema.projectSecrets).where(eq(schema.projectSecrets.name, 'PROD_DB'));
  });
});

describe('what the run writes back', () => {
  it('redacts a value from the run log and from a comment the agent posts', async () => {
    let taskId = '';
    restore = setRuntimeAdapter(adapter(async (input) => {
      await input.onEvent({ type: 'tool_result', toolUseId: 't1', text: `echo printed ${KEY}`, isError: false });
      // The agent posts through the ordi MCP server, i.e. this API with its run token.
      const auth = (input.mcpServers.ordi!.headers as Record<string, string>).Authorization!;
      taskId = /tasks\/([A-Z0-9]+)/.exec(input.prompt)?.[1] ?? taskId;
      const res = await app.request(`/api/v1/tasks/${taskId}/comments`, {
        method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({ body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: `The admin password is ${PASSWORD}` }] }] } }),
      });
      expect(res.status).toBe(201);
      return done;
    }));
    const owner = reqAs(ws.users.owner!.cookie);
    const task = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Check the admin panel', statusId: ws.todoStatusId }));
    taskId = task.id;
    const t = await json(owner.get(`/tasks/${task.id}`));
    await drainOutbox();
    const { db } = getDb();
    await db.update(schema.agentRuns).set({ status: 'cancelled' }).where(and(eq(schema.agentRuns.agentUserId, agentId), eq(schema.agentRuns.status, 'queued')));
    await owner.patch(`/tasks/${task.id}`, { version: t.version, assigneeIds: [agentId] });
    await drainOutbox();
    const [run] = await runsForTask(task.id);
    const [claimed] = await claimRuns('secrets-worker', 1);
    await executeRun(localRunBackend, toClaimedRun(claimed!));

    const events = JSON.stringify(await eventsForRun(run!.id));
    expect(events).not.toContain(KEY);
    expect(events).toContain('contained a secret value; it was stored as [redacted]');
    const comments = JSON.stringify(await json(owner.get(`/tasks/${task.id}/comments`)));
    expect(comments).not.toContain(PASSWORD);
    expect(comments).toContain('[redacted]');
  });

  it('refuses a write that splits a value across strings, or carries one in an upload', async () => {
    let split = 0;
    let upload = 0;
    let plain = 0;
    restore = setRuntimeAdapter(adapter(async (input) => {
      const auth = (input.mcpServers.ordi!.headers as Record<string, string>).Authorization!;
      const { db } = getDb();
      const [running] = await db.select({ taskId: schema.agentRuns.taskId }).from(schema.agentRuns).where(eq(schema.agentRuns.status, 'running'));
      const taskId = running!.taskId;
      const half = KEY.length / 2;
      split = (await app.request(`/api/v1/tasks/${taskId}/comments`, {
        method: 'POST', headers: { authorization: auth, 'Content-Type': 'Application/JSON' },
        body: JSON.stringify({ body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: KEY.slice(0, half) }, { type: 'text', text: KEY.slice(half) }] }] } }),
      })).status;
      // The same value sent as text/plain with \u escapes: the route would still parse it as JSON.
      const escaped = JSON.stringify({ body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: KEY }] }] } })
        .replace(KEY, [...KEY].map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''));
      plain = (await app.request(`/api/v1/tasks/${taskId}/comments`, {
        method: 'POST', headers: { authorization: auth, 'content-type': 'text/plain' }, body: escaped,
      })).status;
      const form = new FormData();
      form.append('file', new File([`key=${KEY}\n`], 'notes.txt', { type: 'text/plain' }), 'notes.txt');
      upload = (await app.request('/api/v1/attachments', { method: 'POST', headers: { authorization: auth }, body: form })).status;
      return done;
    }));
    const { runId } = await runTask('Write the notes');
    expect(split).toBe(422);
    expect(upload).toBe(422);
    // Parsed as JSON despite its content type, and cleaned: the comment is stored without the value.
    expect(plain).toBe(201);
    const [runRow] = await getDb().db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    const comments = JSON.stringify(await json(reqAs(ws.users.owner!.cookie).get(`/tasks/${runRow!.taskId}/comments`)));
    expect(comments).not.toContain(KEY);
    expect(JSON.stringify(await eventsForRun(runId))).toContain('was refused: it carried a project secret');
  });

  it('refuses to push a branch that carries a value, naming the variable only', async () => {
    const pushed: string[][] = [];
    setGitRunner(fakeGit(`feat: add config\n+STRIPE_KEY = "${KEY}"\n`, pushed));
    restore = setRuntimeAdapter(adapter(async () => done));
    const logs: string[][] = [];
    setGitRunner(fakeGit(`feat: add config\n+STRIPE_KEY = "${KEY}"\n`, pushed, logs));
    const { runId } = await runTask('Add the payment config');
    expect(pushed).toEqual([]);
    // Shown as stored: no repository attributes, drivers or textconv between the scan and the bytes.
    expect(logs[0]).toEqual(expect.arrayContaining(['--no-replace-objects', 'core.attributesFile=/dev/null', '--root', '--text', '--no-textconv', '--no-ext-diff', '-m']));
    const events = JSON.stringify(await eventsForRun(runId));
    expect(events).toContain('contains the value of SECRET_STRIPE_TEST');
    expect(events).not.toContain(KEY);
  });

  it('pushes a branch that only reads the variable', async () => {
    const pushed: string[][] = [];
    setGitRunner(fakeGit('feat: read key\n+const key = process.env.SECRET_STRIPE_TEST;\n', pushed));
    restore = setRuntimeAdapter(adapter(async () => done));
    await runTask('Read the key from the environment');
    expect(pushed.length).toBe(1);
  });
});
