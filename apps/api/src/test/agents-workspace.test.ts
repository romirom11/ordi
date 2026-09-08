/**
 * Run workspaces against real git (plan 2026-09-05-001, R26, R28): clone
 * from a bare repository over file://, the task branch, what gets staged
 * (tracked edits and new sources, never node_modules, .env, build output),
 * the push, and a second run continuing the same branch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, schema } from '@ordi/db';
import { resetDb, seedRolesAndUsers } from './helpers';
import { setupWorkspace, type Workspace } from './agents-helpers';
import { prepareWorkspace, publishWorkspace, cleanupWorkspace, setGitRunner, checkoutDir } from '../domains/agents/workspace';
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
});
