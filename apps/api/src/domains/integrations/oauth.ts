/**
 * GitHub OAuth for git connections (PRD §13.1). The `state` param is an
 * HMAC-signed { userId, exp } payload so the public callback can trust who
 * started the flow without a session. Signed with AUTH_SECRET.
 */
import { timingSafeEqual } from 'node:crypto';
import { env } from '../../env';
import { hmacSha256 } from '../../lib/crypto';

const STATE_TTL_MS = 10 * 60_000; // 10 minutes

export function githubOAuthConfigured(): boolean {
  return Boolean(env.githubOAuthClientId && env.githubOAuthClientSecret);
}

interface StatePayload { userId: string; exp: number }

export function signOAuthState(userId: string): string {
  const payload: StatePayload = { userId, exp: Date.now() + STATE_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = hmacSha256(env.authSecret, body);
  return `${body}.${sig}`;
}

export function verifyOAuthState(state: string | undefined | null): { userId: string } | null {
  if (!state) return null;
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = hmacSha256(env.authSecret, body);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
    if (!payload.userId || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return { userId: payload.userId };
  } catch {
    return null;
  }
}

/** The callback URL registered with the GitHub OAuth app. */
export function githubCallbackUrl(): string {
  return `${env.apiUrl.replace(/\/$/, '')}/api/v1/integrations/git/oauth/callback`;
}

export function buildGithubAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: env.githubOAuthClientId,
    scope: 'repo',
    state,
    redirect_uri: githubCallbackUrl(),
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/** Exchange an OAuth code for an access token. Throws on failure. */
export async function exchangeGithubCode(code: string): Promise<{ token: string; tokenType: string }> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: env.githubOAuthClientId,
      client_secret: env.githubOAuthClientSecret,
      code,
      redirect_uri: githubCallbackUrl(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`github token exchange failed: ${res.status}`);
  const data = (await res.json()) as { access_token?: string; token_type?: string; error?: string };
  if (!data.access_token) throw new Error(`github token exchange error: ${data.error ?? 'no access_token'}`);
  return { token: data.access_token, tokenType: data.token_type ?? 'oauth' };
}

export interface ProviderRepo { externalId: string; fullName: string; defaultBranch: string }

/** List the connected user's repositories (github.com or a GHE instance). */
export async function listGithubRepos(token: string, instanceUrl?: string | null): Promise<ProviderRepo[]> {
  const apiBase = instanceUrl
    ? `${instanceUrl.replace(/\/$/, '')}/api/v3`
    : 'https://api.github.com';
  const res = await fetch(`${apiBase}/user/repos?per_page=100&sort=updated`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'ordi',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`github repos request failed: ${res.status}`);
  const data = (await res.json()) as Array<{ id: number | string; full_name: string; default_branch?: string }>;
  return data.map((r) => ({
    externalId: String(r.id),
    fullName: r.full_name,
    defaultBranch: r.default_branch ?? 'main',
  }));
}
