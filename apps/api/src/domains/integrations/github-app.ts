/**
 * GitHub App integration (PRD §13.1 "GitHub App, installation у org").
 *
 * The app is created from ordi via the manifest flow: we POST a manifest to
 * GitHub, GitHub creates the app and hands back ALL credentials (app id,
 * private key, webhook secret) through a one-time conversion code – nobody
 * copies a secret by hand, and the webhook URL is registered centrally by
 * GitHub itself. Installing the app on an org/user then arrives as an
 * `installation` webhook, which creates the git connection and syncs its
 * repository list automatically.
 *
 * Auth model: a short-lived RS256 JWT signed with the app private key proves
 * we are the app; exchanging it per installation yields an installation token
 * (1h) used for API calls. Tokens are cached until shortly before expiry.
 * All of it is plain node:crypto + fetch – no SDK dependency.
 */
import { createSign } from 'node:crypto';
import { ulid } from 'ulid';
import { getDb, schema, eq, and } from '@ordi/db';
import { env } from '../../env';
import type { GithubAppConfig } from '../../lib/runtime-config';
import { runtimeConfig } from '../../lib/runtime-config';
import { encrypt, generateToken } from '../../lib/crypto';
import type { ProviderRepo } from './oauth';

/** api.github.com for github.com apps, <host>/api/v3 for GHE ones. */
export function githubApiBase(htmlUrl: string): string {
  try {
    const origin = new URL(htmlUrl).origin;
    return origin === 'https://github.com' ? 'https://api.github.com' : `${origin}/api/v3`;
  } catch {
    return 'https://api.github.com';
  }
}

/** Where GitHub sends both the manifest conversion code and install redirects. */
export function githubAppSetupUrl(): string {
  return `${env.apiUrl}/api/v1/integrations/github-app/setup`;
}

/** The centrally-registered webhook endpoint the manifest declares. */
export function githubAppWebhookUrl(): string {
  return `${env.apiUrl}/api/v1/integrations/git/github/webhook`;
}

/**
 * The app manifest GitHub turns into a real app. Read-only permissions, only
 * the two event families the webhook route understands.
 */
export function buildAppManifest(workspaceName: string): Record<string, unknown> {
  return {
    name: `ordi (${workspaceName})`.slice(0, 34),
    url: env.appUrl,
    hook_attributes: { url: githubAppWebhookUrl(), active: true },
    redirect_url: githubAppSetupUrl(),
    setup_url: githubAppSetupUrl(),
    setup_on_update: false,
    public: false,
    default_permissions: { contents: 'read', metadata: 'read', pull_requests: 'read' },
    default_events: ['push', 'pull_request'],
  };
}

/** Where the manifest form POSTs to: user account or an organization. */
export function manifestActionUrl(state: string, organization?: string): string {
  const base = organization
    ? `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
  return `${base}?state=${encodeURIComponent(state)}`;
}

export interface ManifestConversion {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  htmlUrl: string;
}

/** Exchange the one-time manifest code for the app's full credentials. */
export async function convertManifestCode(code: string): Promise<ManifestConversion> {
  const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ordi' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`github manifest conversion failed: ${res.status}`);
  const data = (await res.json()) as {
    id?: number; slug?: string; pem?: string; webhook_secret?: string; html_url?: string;
  };
  if (!data.id || !data.pem) throw new Error('github manifest conversion returned no credentials');
  return {
    appId: String(data.id),
    slug: data.slug ?? '',
    privateKey: data.pem,
    webhookSecret: data.webhook_secret ?? '',
    htmlUrl: data.html_url ?? `https://github.com/apps/${data.slug ?? ''}`,
  };
}

/** RS256 app JWT (10 min window, 60s clock-drift backdate) – proves "we are the app". */
export function buildAppJwt(appId: string, privateKey: string, nowMs = Date.now()): string {
  const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const now = Math.floor(nowMs / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey).toString('base64url');
  return `${unsigned}.${signature}`;
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** An installation access token, cached until 5 minutes before expiry. */
export async function installationToken(app: GithubAppConfig, installationId: string): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;
  const res = await fetch(
    `${githubApiBase(app.htmlUrl)}/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${buildAppJwt(app.appId, app.privateKey)}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ordi',
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`github installation token failed: ${res.status}`);
  const data = (await res.json()) as { token?: string; expires_at?: string };
  if (!data.token) throw new Error('github installation token missing in response');
  tokenCache.set(installationId, {
    token: data.token,
    expiresAt: data.expires_at ? Date.parse(data.expires_at) : Date.now() + 55 * 60_000,
  });
  return data.token;
}

/** Look an installation up under the app's own JWT – authenticates install redirects. */
export async function getInstallation(app: GithubAppConfig, installationId: string): Promise<{
  id: string; accountLogin: string;
} | null> {
  const res = await fetch(
    `${githubApiBase(app.htmlUrl)}/app/installations/${encodeURIComponent(installationId)}`,
    {
      headers: {
        Authorization: `Bearer ${buildAppJwt(app.appId, app.privateKey)}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ordi',
      },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github installation lookup failed: ${res.status}`);
  const data = (await res.json()) as { id?: number; account?: { login?: string } };
  if (!data.id) return null;
  return { id: String(data.id), accountLogin: data.account?.login ?? '' };
}

/** Every repository the installation can see (paginated, capped at 300). */
export async function listInstallationRepos(app: GithubAppConfig, installationId: string): Promise<ProviderRepo[]> {
  const token = await installationToken(app, installationId);
  const out: ProviderRepo[] = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(
      `${githubApiBase(app.htmlUrl)}/installation/repositories?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ordi',
        },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!res.ok) throw new Error(`github installation repos failed: ${res.status}`);
    const data = (await res.json()) as {
      repositories?: Array<{ id: number | string; full_name: string; default_branch?: string }>;
    };
    const repos = data.repositories ?? [];
    out.push(...repos.map((r) => ({
      externalId: String(r.id),
      fullName: r.full_name,
      defaultBranch: r.default_branch ?? 'main',
    })));
    if (repos.length < 100) break;
  }
  return out;
}

export async function githubAppConfigured(): Promise<GithubAppConfig | null> {
  return (await runtimeConfig()).githubApp;
}

/* ────────────────────────── installation ↔ db sync ────────────────────────── */

/**
 * Create or revive the git connection for an installation. Idempotent: the
 * installation id is the identity, re-installing reuses the row (and thereby
 * keeps repository rows, project bindings and task links intact).
 */
export async function upsertInstallationConnection(params: {
  installationId: string; accountLogin: string; createdBy?: string | null;
}): Promise<string> {
  const { db } = getDb();
  const [existing] = await db.select().from(schema.gitConnections)
    .where(eq(schema.gitConnections.installationId, params.installationId));
  if (existing) {
    await db.update(schema.gitConnections)
      .set({ status: 'connected', accountLogin: params.accountLogin })
      .where(eq(schema.gitConnections.id, existing.id));
    return existing.id;
  }
  const id = ulid();
  await db.insert(schema.gitConnections).values({
    id,
    provider: 'github',
    instanceUrl: null,
    credentials: encrypt(JSON.stringify({ type: 'app' })),
    webhookSecret: generateToken(), // unused for app connections (app-level secret verifies)
    installationId: params.installationId,
    accountLogin: params.accountLogin,
    status: 'connected',
    createdBy: params.createdBy ?? null,
  });
  return id;
}

/** Register the given repos on a connection (insert-only; existing rows kept). */
export async function syncInstallationRepos(connectionId: string, repos: ProviderRepo[]): Promise<number> {
  const { db } = getDb();
  let added = 0;
  for (const repo of repos) {
    const [existing] = await db.select({ id: schema.gitRepositories.id })
      .from(schema.gitRepositories)
      .where(and(
        eq(schema.gitRepositories.connectionId, connectionId),
        eq(schema.gitRepositories.externalId, repo.externalId),
      ));
    if (existing) {
      await db.update(schema.gitRepositories)
        .set({ fullName: repo.fullName, defaultBranch: repo.defaultBranch })
        .where(eq(schema.gitRepositories.id, existing.id));
    } else {
      await db.insert(schema.gitRepositories).values({
        id: ulid(),
        connectionId,
        externalId: repo.externalId,
        fullName: repo.fullName,
        defaultBranch: repo.defaultBranch,
      });
      added += 1;
    }
  }
  return added;
}
