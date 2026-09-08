/**
 * Run workspaces against real git (plan 2026-09-05-001, R26, R28): clone
 * from a bare repository over file://, the task branch, what gets staged
 * (tracked edits and new sources, never node_modules, .env, build output),
 * the push, and a second run continuing the same branch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, schema } from '@ordi/db';
import { resetDb, seedRolesAndUsers } from './helpers';
import { setupWorkspace, type Workspace } from './agents-helpers';
import { prepareWorkspace, publishWorkspace, cleanupWorkspace, setGitRunner, checkoutDir, redactGitError, explainPushError } from '../domains/agents/workspace';
import { encrypt } from '../lib/crypto';
import { env } from '../env';

const execFileAsync = promisify(execFile);

let ws: Workspace;
let root: string;
let bare: string;

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: { PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  return stdout;
}

beforeAll(async () => {
  await resetDb();
  root = await mkdtemp(join(tmpdir(), 'ordi-ws-'));
  env.agentWorkDir = join(root, 'work');
  await mkdir(env.agentWorkDir, { recursive: true });
  // origin: bare repo with one commit on main, at file://<root>/acme/real.git
  bare = join(root, 'acme', 'real.git');
  await mkdir(bare, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main', bare], root);
  const seed = join(root, 'seed');
  await git(['clone', bare, seed], root);
  await writeFile(join(seed, 'README.md'), '# real\n');
  await writeFile(join(seed, '.gitignore'), 'ignored.txt\n');
  await git(['add', '-A'], seed);
  await git(['commit', '-m', 'init'], seed);
  await git(['push', 'origin', 'main'], seed);

  const users = await seedRolesAndUsers();
  ws = await setupWorkspace(users, 'WSG');
  const { db } = getDb();
  const connId = '01JWSGCONN000000000000000A';
  await db.insert(schema.gitConnections).values({
    id: connId, provider: 'gitea', instanceUrl: `file://${root}`, credentials: encrypt(JSON.stringify({ token: 'local' })), webhookSecret: 'w', status: 'connected',
  });
  const repoId = '01JWSGREPO000000000000000A';
  await db.insert(schema.gitRepositories).values({ id: repoId, connectionId: connId, externalId: '1', fullName: 'acme/real', defaultBranch: 'main' });
  await db.insert(schema.projectRepositories).values({ projectId: ws.projectId, repositoryId: repoId });
  setGitRunner(null);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe('workspace with real git', () => {
  it('clones, stages only real work, pushes the task branch, and a later run continues it', async () => {
    const input = { taskId: ws.taskId, projectId: ws.projectId, projectKey: 'WSG', taskNumber: 1, taskTitle: 'Real git', agentName: 'Claude', agentEmail: 'claude@test.local' };
    const w = await prepareWorkspace(input);
    expect(w.repo?.fullName).toBe('acme/real');
    const branch = w.branch!;
    expect(branch).toMatch(/wsg-1-real-git$/);
    expect(w.dir).toBe(checkoutDir(ws.taskId));
    expect((await git(['rev-parse', '--abbrev-ref', 'HEAD'], w.dir)).trim()).toBe(branch);

    // The agent's work: a tracked edit, a new source file, and junk of every kind.
    await writeFile(join(w.dir, 'README.md'), '# real\n\nchanged\n');
    await mkdir(join(w.dir, 'src'), { recursive: true });
    await writeFile(join(w.dir, 'src', 'new.ts'), 'export const x = 1;\n');
    await mkdir(join(w.dir, 'node_modules', 'left'), { recursive: true });
    await writeFile(join(w.dir, 'node_modules', 'left', 'index.js'), '');
    await mkdir(join(w.dir, 'dist'), { recursive: true });
    await writeFile(join(w.dir, 'dist', 'out.js'), '');
    await writeFile(join(w.dir, '.env'), 'SECRET=1\n');
    await writeFile(join(w.dir, '.env.local'), 'SECRET=2\n');
    await writeFile(join(w.dir, 'build.log'), 'noise\n');
    await writeFile(join(w.dir, 'ignored.txt'), 'gitignored\n');

    const published = await publishWorkspace(w, { ref: 'WSG-1', title: 'Real git', summary: 'did it', existingPrUrl: null });
    expect(published).toMatchObject({ pushed: true, commits: 1, prUrl: null }); // no PR API for a non-GitHub provider

    const files = (await git(['ls-tree', '-r', '--name-only', branch], bare)).trim().split('\n').sort();
    expect(files).toEqual(['.gitignore', 'README.md', 'src/new.ts']);
    expect(await git(['log', '-1', '--format=%s', branch], bare)).toContain('WSG-1: Real git');
    expect(await git(['log', '-1', '--format=%an <%ae>', branch], bare)).toContain('Claude <claude@test.local>');
    await cleanupWorkspace(ws.taskId);

    // A follow-up run finds the branch on origin and continues on it.
    const again = await prepareWorkspace({ ...input, existingBranch: w.branch, taskTitle: 'Renamed since' });
    expect(again.branch).toBe(branch);
    expect((await git(['log', '-1', '--format=%s'], again.dir)).trim()).toBe('WSG-1: Real git');
    // Nothing new: no commit is made, the branch is still the one commit ahead of main.
    const idle = await publishWorkspace(again, { ref: 'WSG-1', title: 'Renamed since', summary: '', existingPrUrl: null, openPullRequest: false });
    expect(idle).toMatchObject({ pushed: true, commits: 1 });
    expect((await git(['log', '--format=%s', branch], bare)).trim().split('\n')).toHaveLength(2);
    // Unfinished work goes in as a WIP commit without a pull request.
    await writeFile(join(again.dir, 'src', 'more.ts'), 'export const y = 2;\n');
    const wip = await publishWorkspace(again, { ref: 'WSG-1', title: 'Renamed since', summary: '', existingPrUrl: null, openPullRequest: false });
    expect(wip).toMatchObject({ pushed: true, commits: 2 });
    expect(await git(['log', '-1', '--format=%s', branch], bare)).toContain('WIP WSG-1');
    await cleanupWorkspace(ws.taskId);
  }, 30_000);

  it('a refused push keeps the checkout, leaks no token, and the next run continues in it', async () => {
    const input = { taskId: ws.taskId, projectId: ws.projectId, projectKey: 'WSG', taskNumber: 2, taskTitle: 'Refused push', agentName: 'Claude', agentEmail: 'claude@test.local' };
    const w = await prepareWorkspace(input);
    expect(w.reused).toBeUndefined();
    await writeFile(join(w.dir, 'src.txt'), 'work worth keeping\n');
    // origin refuses every push, the way a read-only installation does.
    const hook = join(bare, 'hooks', 'pre-receive');
    await writeFile(hook, '#!/bin/sh\necho "remote: Permission to acme/real denied to ordi[bot]." >&2\nexit 1\n');
    await chmod(hook, 0o755);
    let failure: Error | null = null;
    try {
      await publishWorkspace(w, { ref: 'WSG-2', title: 'Refused push', summary: '', existingPrUrl: null });
    } catch (e) { failure = e as Error; }
    expect(failure).not.toBeNull();
    expect(failure!.message).toContain('Permission to acme/real denied');
    expect(failure!.message).not.toContain('basic eC1hY2Nlc3M');
    expect(failure!.message).not.toMatch(/basic [A-Za-z0-9+/=]{20,}/);
    expect(failure!.message).not.toContain('local');
    expect(failure!.message).toContain('[redacted]');
    expect(explainPushError(failure!.message)).toContain('Retry');

    // The worker keeps the checkout; the next run for the task continues in it.
    await cleanupWorkspace(ws.taskId, { keepCheckout: true });
    await expect(stat(join(w.dir, '.git'))).resolves.toBeTruthy();
    const again = await prepareWorkspace({ ...input, existingBranch: w.branch });
    expect(again.reused).toBe(true);
    expect((await git(['log', '-1', '--format=%s'], again.dir)).trim()).toBe('WSG-2: Refused push');
    // Access fixed: the same commits go out.
    await rm(hook);
    const published = await publishWorkspace(again, { ref: 'WSG-2', title: 'Refused push', summary: '', existingPrUrl: null });
    expect(published).toMatchObject({ pushed: true, commits: 1 });
    expect(await git(['log', '-1', '--format=%s', again.branch!], bare)).toContain('WSG-2: Refused push');
    // Pushed now: a later run clones afresh instead of reusing.
    await cleanupWorkspace(ws.taskId, { keepCheckout: true });
    const fresh = await prepareWorkspace({ ...input, existingBranch: w.branch });
    expect(fresh.reused).toBeUndefined();
    await cleanupWorkspace(ws.taskId);
  }, 30_000);

  it('redactGitError strips the header, its base64 payload and the raw token', () => {
    const repo = { repositoryId: 'r', fullName: 'acme/real', defaultBranch: 'main', provider: 'github', instanceUrl: null, token: 'ghs_secret_token_value', htmlUrl: 'https://github.com' };
    const encoded = Buffer.from('x-access-token:ghs_secret_token_value').toString('base64');
    const message = `Command failed: git -c http.extraheader=AUTHORIZATION: basic ${encoded} push -u origin b\nremote: denied ${encoded} ghs_secret_token_value`;
    const out = redactGitError(message, repo);
    expect(out).not.toContain(encoded);
    expect(out).not.toContain('ghs_secret_token_value');
    expect(out).toContain('AUTHORIZATION: basic [redacted]');
    expect(redactGitError(message, null)).toBe(message);
  });
});
