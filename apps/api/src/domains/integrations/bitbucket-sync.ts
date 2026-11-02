/**
 * The database side of the Bitbucket integration: connections keyed by
 * workspace, and the webhooks of repositories bound to projects.
 */
import { ulid } from 'ulid';
import { getDb, schema, eq, and, inArray } from '@ordi/db';
import { decrypt, encrypt, generateToken } from '../../lib/crypto';
import { logger } from '../../lib/logger';
import { ensureBitbucketWebhook, listBitbucketRepos, type BitbucketCredentials } from './bitbucket';
import { syncInstallationRepos } from './github-app';

/** Seal credentials for `git_connections.credentials`. */
export function sealBitbucketCredentials(creds: Omit<BitbucketCredentials, 'type'>): string {
  const value: BitbucketCredentials = { type: 'bitbucket', token: creds.token, ...(creds.email ? { email: creds.email } : {}) };
  return encrypt(JSON.stringify(value));
}

/** Open the stored blob; null when it is unreadable (rotated ENCRYPTION_KEY, legacy shape). */
export function openBitbucketCredentials(stored: unknown): BitbucketCredentials | null {
  try {
    const parsed = JSON.parse(decrypt(stored as string)) as Partial<BitbucketCredentials>;
    if (!parsed.token) return null;
    return { type: 'bitbucket', token: parsed.token, ...(parsed.email ? { email: parsed.email } : {}) };
  } catch {
    return null;
  }
}

/**
 * Create the connection for a workspace, or hand the existing one the new
 * token (a reconnect after rotating it). The workspace is the identity, so a
 * reconnect keeps repository rows, project bindings and task links. Throws
 * BitbucketApiError when the token cannot list the workspace.
 */
export async function connectBitbucketWorkspace(input: {
  workspace: string; token: string; email?: string; userId: string | null;
}): Promise<{ id: string; created: boolean; repos: number }> {
  const creds: BitbucketCredentials = { type: 'bitbucket', token: input.token, ...(input.email ? { email: input.email } : {}) };
  // Proves the token before anything is stored.
  const repos = await listBitbucketRepos(creds, input.workspace);

  const { db } = getDb();
  const [existing] = await db.select({ id: schema.gitConnections.id }).from(schema.gitConnections)
    .where(and(eq(schema.gitConnections.provider, 'bitbucket'), eq(schema.gitConnections.accountLogin, input.workspace)));
  let id: string;
  if (existing) {
    id = existing.id;
    await db.update(schema.gitConnections)
      .set({ credentials: sealBitbucketCredentials(creds), status: 'connected' })
      .where(eq(schema.gitConnections.id, id));
  } else {
    id = ulid();
    await db.insert(schema.gitConnections).values({
      id,
      provider: 'bitbucket',
      instanceUrl: null,
      credentials: sealBitbucketCredentials(creds),
      // Registered on every repository webhook; Bitbucket signs deliveries with it.
      webhookSecret: generateToken(),
      accountLogin: input.workspace,
      status: 'connected',
      createdBy: input.userId,
    });
  }
  await syncInstallationRepos(id, repos);
  return { id, created: !existing, repos: repos.length };
}

export type HookResult =
  | { status: 'ok'; fullName: string }
  | { status: 'skipped' }
  | { status: 'failed'; fullName: string; error: string };

/**
 * Register (or refresh) the ordi webhook on a repository when it belongs to
 * a Bitbucket connection. Never throws: binding a repository must not fail
 * because the token lacks the webhook scope – the caller reports the reason.
 */
export async function ensureBitbucketHook(repositoryId: string): Promise<HookResult> {
  const { db } = getDb();
  const [row] = await db.select({
    fullName: schema.gitRepositories.fullName,
    provider: schema.gitConnections.provider,
    credentials: schema.gitConnections.credentials,
    webhookSecret: schema.gitConnections.webhookSecret,
  }).from(schema.gitRepositories)
    .innerJoin(schema.gitConnections, eq(schema.gitConnections.id, schema.gitRepositories.connectionId))
    .where(eq(schema.gitRepositories.id, repositoryId));
  if (!row || row.provider !== 'bitbucket') return { status: 'skipped' };
  const creds = openBitbucketCredentials(row.credentials);
  if (!creds) return { status: 'failed', fullName: row.fullName, error: 'Stored Bitbucket credentials are invalid – reconnect the workspace' };
  try {
    await ensureBitbucketWebhook(creds, row.fullName, row.webhookSecret);
    return { status: 'ok', fullName: row.fullName };
  } catch (e) {
    const error = e instanceof Error ? e.message : 'Bitbucket request failed';
    logger.warn({ repository: row.fullName, err: error }, 'bitbucket webhook registration failed');
    return { status: 'failed', fullName: row.fullName, error };
  }
}

/** Refresh the webhooks of every repository of the connection that is bound to a project. */
export async function ensureBitbucketHooksForConnection(connectionId: string): Promise<HookResult[]> {
  const { db } = getDb();
  const repos = await db.select({ id: schema.gitRepositories.id }).from(schema.gitRepositories)
    .where(eq(schema.gitRepositories.connectionId, connectionId));
  if (repos.length === 0) return [];
  const bound = await db.selectDistinct({ id: schema.projectRepositories.repositoryId })
    .from(schema.projectRepositories)
    .where(inArray(schema.projectRepositories.repositoryId, repos.map((r) => r.id)));
  const out: HookResult[] = [];
  for (const r of bound) out.push(await ensureBitbucketHook(r.id));
  return out;
}
