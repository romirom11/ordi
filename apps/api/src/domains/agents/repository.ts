/**
 * The repository a run works in, with a token that can clone and push.
 *
 * On the API side, not the worker's: minting an installation token needs
 * the GitHub App's private key, and a legacy connection keeps its token
 * encrypted with ENCRYPTION_KEY. The worker receives the finished binding
 * through its backend and never sees either.
 */
import { getDb, schema, eq } from '@ordi/db';
import { decrypt } from '../../lib/crypto';
import { githubAppConfigured, installationToken } from '../integrations/github-app';
import type { RepoBinding } from './workspace';

const { projectRepositories, gitRepositories, gitConnections } = schema;

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
