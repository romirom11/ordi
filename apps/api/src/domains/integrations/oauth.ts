/**
 * GitHub OAuth for git connections (PRD §13.1). The `state` param is an
 * HMAC-signed { userId, exp } payload so the public callback can trust who
 * started the flow without a session. Signed with AUTH_SECRET.
 */
import { timingSafeEqual } from 'node:crypto';
import { env } from '../../env';
import { hmacSha256 } from '../../lib/crypto';
import { runtimeConfig } from '../../lib/runtime-config';

const STATE_TTL_MS = 10 * 60_000; // 10 minutes

export async function githubOAuthConfigured(): Promise<boolean> {
  return Boolean((await runtimeConfig()).github);
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

export async function buildGithubAuthorizeUrl(state: string): Promise<string> {
  const app = (await runtimeConfig()).github;
  const params = new URLSearchParams({
    client_id: app?.clientId ?? '',
    scope: 'repo',
    state,
    redirect_uri: githubCallbackUrl(),
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/** Exchange an OAuth code for an access token. Throws on failure. */
export async function exchangeGithubCode(code: string): Promise<{ token: string; tokenType: string }> {
  const app = (await runtimeConfig()).github;
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: app?.clientId ?? '',
      client_secret: app?.clientSecret ?? '',
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

// ─────────────────────────────────────────────────────────────────────────────
// Slack OAuth v2 (workspace connection). Reuses the same HMAC-signed `state`.
// ─────────────────────────────────────────────────────────────────────────────

/** Bot scopes requested from Slack (read channels + post messages). */
export const SLACK_SCOPES = 'channels:read,groups:read,chat:write';

export async function slackOAuthConfigured(): Promise<boolean> {
  return Boolean((await runtimeConfig()).slack);
}

/** The redirect URL registered with the Slack app. */
export function slackCallbackUrl(): string {
  return `${env.apiUrl.replace(/\/$/, '')}/api/v1/integrations/slack/oauth/callback`;
}

export async function buildSlackAuthorizeUrl(state: string): Promise<string> {
  const app = (await runtimeConfig()).slack;
  const params = new URLSearchParams({
    client_id: app?.clientId ?? '',
    scope: SLACK_SCOPES,
    state,
    redirect_uri: slackCallbackUrl(),
  });
  return `https://slack.com/oauth/v2/authorize?${params.toString()}`;
}

export interface SlackConnectionResult {
  teamId: string;
  teamName: string;
  botToken: string;
  scope: string;
}

/** Exchange an OAuth code for a bot token via oauth.v2.access. Throws on failure. */
export async function exchangeSlackCode(code: string): Promise<SlackConnectionResult> {
  const app = (await runtimeConfig()).slack;
  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: app?.clientId ?? '',
      client_secret: app?.clientSecret ?? '',
      code,
      redirect_uri: slackCallbackUrl(),
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`slack token exchange failed: ${res.status}`);
  const data = (await res.json()) as {
    ok?: boolean; error?: string; access_token?: string; scope?: string;
    team?: { id?: string; name?: string };
  };
  if (!data.ok || !data.access_token) throw new Error(`slack token exchange error: ${data.error ?? 'no access_token'}`);
  return {
    teamId: data.team?.id ?? '',
    teamName: data.team?.name ?? '',
    botToken: data.access_token,
    scope: data.scope ?? '',
  };
}

export interface SlackChannel { id: string; name: string; isPrivate: boolean }

/** List channels via conversations.list (cursor-follow, capped ~600). Throws on API error. */
export async function listSlackChannels(botToken: string): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  let cursor: string | undefined;
  for (let pageNo = 0; pageNo < 3; pageNo++) {
    const params = new URLSearchParams({
      types: 'public_channel,private_channel',
      limit: '200',
      exclude_archived: 'true',
    });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`https://slack.com/api/conversations.list?${params.toString()}`, {
      headers: { Authorization: `Bearer ${botToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`slack conversations.list failed: ${res.status}`);
    const data = (await res.json()) as {
      ok?: boolean; error?: string;
      channels?: Array<{ id: string; name: string; is_private?: boolean }>;
      response_metadata?: { next_cursor?: string };
    };
    if (!data.ok) throw new Error(`slack conversations.list error: ${data.error ?? 'unknown'}`);
    for (const ch of data.channels ?? []) {
      out.push({ id: ch.id, name: ch.name, isPrivate: Boolean(ch.is_private) });
    }
    cursor = data.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out;
}

/** Post a message to a channel via chat.postMessage. Throws on API error. */
export async function postSlackMessage(botToken: string, channel: string, text: string): Promise<void> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${botToken}` },
    body: JSON.stringify({ channel, text }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`slack chat.postMessage failed: ${res.status}`);
  const data = (await res.json()) as { ok?: boolean; error?: string };
  if (!data.ok) throw new Error(`slack chat.postMessage error: ${data.error ?? 'unknown'}`);
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
