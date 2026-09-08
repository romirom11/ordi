/**
 * Run workspaces (plan 2026-09-05-001, R26, R28): a fresh clone per run under
 * AGENT_WORK_DIR, the task branch checked out, and after a successful run the
 * branch pushed and a pull request opened with the GitHub App installation
 * token. The token never lands in .git/config: every git call that needs it
 * passes it as a one-off extra header.
 *
 * Layout under AGENT_WORK_DIR, keyed by task so a follow-up or a retry finds
 * the previous run's session: `tasks/<taskId>/checkout` is the clone (deleted
 * when the run ends) and `tasks/<taskId>/harness` the runtime's own home with
 * the session transcripts (kept, pruned after SESSION_RETENTION_DAYS).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb, schema, eq } from '@ordi/db';
import { buildBranchName } from '@ordi/shared';
import { env } from '../../env';
import { logger } from '../../lib/logger';
import { decrypt } from '../../lib/crypto';
import { githubApiBase, githubAppConfigured, installationToken } from '../integrations/github-app';

const execFileAsync = promisify(execFile);
const { projectRepositories, gitRepositories, gitConnections } = schema;

export interface RepoBinding {
  repositoryId: string;
  fullName: string;
  defaultBranch: string;
  provider: string;
  instanceUrl: string | null;
  /** Bearer for clone/push and PR creation. */
  token: string;
  /** Web/API base for the provider. */
  htmlUrl: string;
}

export interface Workspace {
  dir: string;
  repo: RepoBinding | null;
  branch: string | null;
  projectId: string;
}

/** The first repository bound to the project, with a usable token, or null. */
export async function resolveRepository(projectId: string): Promise<RepoBinding | null> {
  const { db } = getDb();
  const rows = await db.select({
    repositoryId: gitRepositories.id, fullName: gitRepositories.fullName, defaultBranch: gitRepositories.defaultBranch,
    provider: gitConnections.provider, instanceUrl: gitConnections.instanceUrl, installationId: gitConnections.installationId,
    credentials: gitConnections.credentials, status: gitConnections.status,
  }).from(projectRepositories)
    .innerJoin(gitRepositories, eq(gitRepositories.id, projectRepositories.repositoryId))
    .innerJoin(gitConnections, eq(gitConnections.id, gitRepositories.connectionId))
    .where(eq(projectRepositories.projectId, projectId));
  for (const r of rows) {
    if (r.status !== 'connected') continue;
    if (r.provider === 'github') {
      const htmlUrl = r.instanceUrl ?? 'https://github.com';
      if (r.installationId) {
        const app = await githubAppConfigured();
        if (!app) continue;
        const token = await installationToken(app, r.installationId);
        return { repositoryId: r.repositoryId, fullName: r.fullName, defaultBranch: r.defaultBranch, provider: 'github', instanceUrl: r.instanceUrl, token, htmlUrl };
      }
      const token = legacyToken(r.credentials);
      if (token) return { repositoryId: r.repositoryId, fullName: r.fullName, defaultBranch: r.defaultBranch, provider: 'github', instanceUrl: r.instanceUrl, token, htmlUrl };
      continue;
    }
    const token = legacyToken(r.credentials);
    if (token && r.instanceUrl) {
      return { repositoryId: r.repositoryId, fullName: r.fullName, defaultBranch: r.defaultBranch, provider: r.provider, instanceUrl: r.instanceUrl, token, htmlUrl: r.instanceUrl };
    }
  }
  return null;
}

function legacyToken(credentials: unknown): string | null {
  try {
    const parsed = JSON.parse(decrypt(credentials as string)) as { token?: string };
    return parsed.token ?? null;
  } catch {
    return null;
  }
}

function cloneUrl(repo: RepoBinding): string {
  return `${repo.htmlUrl.replace(/\/$/, '')}/${repo.fullName}.git`;
}

/** `Authorization: basic base64(x-access-token:TOKEN)` – what GitHub expects for app tokens; PATs work the same. */
function authHeader(repo: RepoBinding): string {
  const user = repo.provider === 'github' ? 'x-access-token' : 'oauth2';
  return `AUTHORIZATION: basic ${Buffer.from(`${user}:${repo.token}`).toString('base64')}`;
}

export interface GitRunner {
  (args: string[], opts: { cwd: string; repo?: RepoBinding | null }): Promise<{ stdout: string; stderr: string }>;
}

/**
 * HOME for git is a scratch directory outside every checkout and the global
 * and system config are switched off: a `.gitconfig` in the repository
 * (shipped, or written by the agent) must never steer the platform's own
 * push, which carries the installation token.
 */
const gitHome = join(env.agentWorkDir, '.git-home');

const defaultGit: GitRunner = async (args, opts) => {
  await mkdir(gitHome, { recursive: true });
  const full = opts.repo ? ['-c', `http.extraheader=${authHeader(opts.repo)}`, ...args] : args;
  const { stdout, stderr } = await execFileAsync('git', full, {
    cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? '', HOME: gitHome, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', LANG: 'C',
    },
  });
  return { stdout, stderr };
};

let git: GitRunner = defaultGit;

/** Test seam. */
export function setGitRunner(next: GitRunner | null): void {
  git = next ?? defaultGit;
}

/** Sessions of a task nobody touched for this long are deleted. */
export const SESSION_RETENTION_DAYS = 30;

export function taskDir(taskId: string): string {
  return join(env.agentWorkDir, 'tasks', taskId);
}

export function checkoutDir(taskId: string): string {
  return join(taskDir(taskId), 'checkout');
}

/** HOME / CLAUDE_CONFIG_DIR for the runtime: session transcripts live here. */
export function harnessDir(taskId: string): string {
  return join(taskDir(taskId), 'harness');
}

export interface PrepareInput {
  taskId: string;
  projectId: string;
  projectKey: string;
  taskNumber: number;
  taskTitle: string;
  /** A previous run's branch to continue on (follow-ups). */
  existingBranch?: string | null;
  agentName: string;
  agentEmail: string;
}

/** R26: fresh clone (or an empty scratch dir) with the task branch checked out. */
export async function prepareWorkspace(input: PrepareInput): Promise<Workspace> {
  const dir = checkoutDir(input.taskId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await mkdir(harnessDir(input.taskId), { recursive: true });
  const repo = await resolveRepository(input.projectId);
  if (!repo) return { dir, repo: null, branch: null, projectId: input.projectId };

  const branch = input.existingBranch ?? buildBranchName({ key: input.projectKey, number: input.taskNumber, title: input.taskTitle });
  await git(['clone', '--depth', '50', '--no-single-branch', '--branch', repo.defaultBranch, cloneUrl(repo), dir], { cwd: env.agentWorkDir, repo });
  await git(['config', 'user.name', input.agentName], { cwd: dir });
  await git(['config', 'user.email', input.agentEmail], { cwd: dir });
  // Continue a branch that already exists (follow-up), else start it from the default branch.
  const remote = await git(['ls-remote', '--heads', 'origin', branch], { cwd: dir, repo }).catch(() => ({ stdout: '', stderr: '' }));
  if (remote.stdout.trim()) {
    await git(['fetch', '--depth', '50', 'origin', `${branch}:${branch}`], { cwd: dir, repo });
    await git(['checkout', branch], { cwd: dir });
  } else {
    await git(['checkout', '-b', branch], { cwd: dir });
  }
  return { dir, repo, branch, projectId: input.projectId };
}

export interface PublishResult {
  pushed: boolean;
  prUrl: string | null;
  /** Commits ahead of the default branch; null when git could not tell (the branch was pushed anyway). */
  commits: number | null;
}

/**
 * Left-overs that must never ride into a pull request: dependency and build
 * trees, caches, env files, logs. Tracked files always go in (`git add -u`);
 * untracked ones only when they pass this filter, and not by the hundreds.
 */
const UNWANTED_UNTRACKED = /(^|\/)(node_modules|dist|build|out|coverage|target|__pycache__|\.venv|venv|\.next|\.turbo|\.cache|\.pytest_cache|\.mypy_cache)\/|(^|\/)\.env(\.[^/]*)?$|\.(log|tmp|swp)$|(^|\/)\.DS_Store$/;
const MAX_UNTRACKED = 500;

export interface StageResult {
  staged: boolean;
  skipped: string[];
}

/** Stage what the agent changed: tracked modifications, plus untracked files that are not junk. */
export async function stageChanges(dir: string): Promise<StageResult> {
  await git(['add', '-u'], { cwd: dir });
  const status = await git(['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: dir });
  const untracked = status.stdout.split('\0').filter((l) => l.startsWith('?? ')).map((l) => l.slice(3));
  const skipped = untracked.filter((p) => UNWANTED_UNTRACKED.test(p));
  let keep = untracked.filter((p) => !UNWANTED_UNTRACKED.test(p));
  if (keep.length > MAX_UNTRACKED) {
    logger.warn({ dir, count: keep.length }, 'too many untracked files; none staged');
    skipped.push(...keep);
    keep = [];
  }
  for (let i = 0; i < keep.length; i += 200) {
    await git(['add', '--', ...keep.slice(i, i + 200)], { cwd: dir });
  }
  const staged = await git(['diff', '--cached', '--name-only'], { cwd: dir });
  return { staged: Boolean(staged.stdout.trim()), skipped };
}

/** R28: commit leftovers, push, open (or find) the pull request. */
export async function publishWorkspace(ws: Workspace, input: {
  ref: string; title: string; summary: string; existingPrUrl: string | null;
  /** False preserves work from a run that stopped early: push the branch, open no pull request. */
  openPullRequest?: boolean;
}): Promise<PublishResult> {
  if (!ws.repo || !ws.branch) return { pushed: false, prUrl: null, commits: 0 };
  const { branch, dir } = ws;
  // Installation tokens live an hour and the clone may be older than that by
  // now: take a fresh binding for the push, falling back to the one we have.
  const fresh = await resolveRepository(ws.projectId).catch(() => null);
  const repo = fresh && fresh.repositoryId === ws.repo.repositoryId ? fresh : ws.repo;
  const openPr = input.openPullRequest ?? true;
  const stage = await stageChanges(dir);
  if (stage.skipped.length) logger.info({ dir, skipped: stage.skipped.slice(0, 20), count: stage.skipped.length }, 'untracked files left out of the commit');
  if (stage.staged) {
    await git(['commit', '-m', openPr ? `${input.ref}: ${input.title}` : `WIP ${input.ref}: ${input.title} (run stopped early)`], { cwd: dir });
  }
  const commits = await commitsAhead(dir, repo.defaultBranch, branch);
  if (commits === 0) return { pushed: false, prUrl: input.existingPrUrl, commits: 0 };
  await git(['push', '-u', 'origin', branch], { cwd: dir, repo });
  if (input.existingPrUrl || !openPr) return { pushed: true, prUrl: input.existingPrUrl, commits };
  if (repo.provider !== 'github') return { pushed: true, prUrl: null, commits };
  const prUrl = await openGithubPullRequest(repo, { head: branch, base: repo.defaultBranch, title: `${input.ref}: ${input.title}`, body: input.summary });
  return { pushed: true, prUrl, commits };
}

/**
 * How far the branch is ahead. A failing rev-list (stale default branch
 * name, shallow grafts without a merge base) must not read as "nothing to
 * push": null means unknown, and the caller pushes.
 */
async function commitsAhead(dir: string, defaultBranch: string, branch: string): Promise<number | null> {
  try {
    const ahead = await git(['rev-list', '--count', `origin/${defaultBranch}..${branch}`], { cwd: dir });
    return Number(ahead.stdout.trim() || 0);
  } catch {
    try {
      const ahead = await git(['rev-list', '--count', branch, '--not', '--remotes=origin'], { cwd: dir });
      return Number(ahead.stdout.trim() || 0);
    } catch (e) {
      logger.warn({ err: e, dir, branch }, 'could not count commits ahead; pushing anyway');
      return null;
    }
  }
}

async function openGithubPullRequest(repo: RepoBinding, pr: { head: string; base: string; title: string; body: string }): Promise<string | null> {
  const api = githubApiBase(repo.htmlUrl);
  const headers = { Authorization: `Bearer ${repo.token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'ordi-agents' };
  const owner = repo.fullName.split('/')[0];
  // An open PR for this branch already exists (follow-up on a reviewed branch).
  const existing = await fetch(`${api}/repos/${repo.fullName}/pulls?head=${encodeURIComponent(`${owner}:${pr.head}`)}&state=open`, { headers });
  if (existing.ok) {
    const list = (await existing.json()) as { html_url?: string }[];
    if (list[0]?.html_url) return list[0].html_url;
  }
  const res = await fetch(`${api}/repos/${repo.fullName}/pulls`, {
    method: 'POST', headers,
    body: JSON.stringify({ title: pr.title, head: pr.head, base: pr.base, body: `${pr.body}\n\n_Opened by an ordi agent._` }),
  });
  if (!res.ok) {
    logger.warn({ status: res.status, repo: repo.fullName }, 'pull request creation failed');
    return null;
  }
  const data = (await res.json()) as { html_url?: string };
  return data.html_url ?? null;
}

/** The checkout goes; the harness home stays so the next run can resume the session. */
export async function cleanupWorkspace(taskId: string): Promise<void> {
  const dir = checkoutDir(taskId);
  try { await stat(dir); } catch { return; }
  await rm(dir, { recursive: true, force: true }).catch((e) => logger.warn({ err: e, dir }, 'workspace cleanup failed'));
  // Retention counts from the last run, not from the first transcript write.
  const now = new Date();
  await utimes(taskDir(taskId), now, now).catch(() => {});
}

/** Delete task directories (sessions included) whose last run is older than the cutoff. Returns how many went. */
export async function pruneTaskDirs(olderThan: Date): Promise<number> {
  const root = join(env.agentWorkDir, 'tasks');
  let entries: string[];
  try { entries = await readdir(root); } catch { return 0; }
  let removed = 0;
  for (const name of entries) {
    const dir = join(root, name);
    try {
      const info = await stat(dir);
      if (!info.isDirectory() || info.mtime >= olderThan) continue;
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch (e) {
      logger.warn({ err: e, dir }, 'agent task dir prune failed');
    }
  }
  return removed;
}
