/**
 * Run workspaces (plan 2026-09-05-001, R26, R28): a fresh clone per run under
 * AGENT_WORK_DIR, the task branch checked out, and after a successful run the
 * branch pushed and a pull request opened with the GitHub App installation
 * token. The token never lands in .git/config: every git call that needs it
 * passes it as a one-off extra header.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, stat } from 'node:fs/promises';
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

const defaultGit: GitRunner = async (args, opts) => {
  const full = opts.repo ? ['-c', `http.extraheader=${authHeader(opts.repo)}`, ...args] : args;
  const { stdout, stderr } = await execFileAsync('git', full, {
    cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', HOME: opts.cwd, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo', LANG: 'C' },
  });
  return { stdout, stderr };
};

let git: GitRunner = defaultGit;

/** Test seam. */
export function setGitRunner(next: GitRunner | null): void {
  git = next ?? defaultGit;
}

export function runDir(runId: string): string {
  return join(env.agentWorkDir, runId);
}

export interface PrepareInput {
  runId: string;
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
  const dir = runDir(input.runId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const repo = await resolveRepository(input.projectId);
  if (!repo) return { dir, repo: null, branch: null };

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
  return { dir, repo, branch };
}

export interface PublishResult {
  pushed: boolean;
  prUrl: string | null;
  commits: number;
}

/** R28: commit leftovers, push, open (or find) the pull request. */
export async function publishWorkspace(ws: Workspace, input: {
  ref: string; title: string; summary: string; existingPrUrl: string | null;
}): Promise<PublishResult> {
  if (!ws.repo || !ws.branch) return { pushed: false, prUrl: null, commits: 0 };
  const { repo, branch, dir } = ws;
  const status = await git(['status', '--porcelain'], { cwd: dir });
  if (status.stdout.trim()) {
    await git(['add', '-A'], { cwd: dir });
    await git(['commit', '-m', `${input.ref}: ${input.title}`], { cwd: dir });
  }
  const ahead = await git(['rev-list', '--count', `origin/${repo.defaultBranch}..${branch}`], { cwd: dir }).catch(() => ({ stdout: '0', stderr: '' }));
  const commits = Number(ahead.stdout.trim() || 0);
  if (commits === 0) return { pushed: false, prUrl: input.existingPrUrl, commits: 0 };
  await git(['push', '-u', 'origin', branch], { cwd: dir, repo });
  if (input.existingPrUrl) return { pushed: true, prUrl: input.existingPrUrl, commits };
  if (repo.provider !== 'github') return { pushed: true, prUrl: null, commits };
  const prUrl = await openGithubPullRequest(repo, { head: branch, base: repo.defaultBranch, title: `${input.ref}: ${input.title}`, body: input.summary });
  return { pushed: true, prUrl, commits };
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

export async function cleanupWorkspace(runId: string): Promise<void> {
  const dir = runDir(runId);
  try { await stat(dir); } catch { return; }
  await rm(dir, { recursive: true, force: true }).catch((e) => logger.warn({ err: e, dir }, 'workspace cleanup failed'));
}
