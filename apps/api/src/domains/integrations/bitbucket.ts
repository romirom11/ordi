/**
 * Bitbucket Cloud integration (PRD §13.1, alongside GitHub).
 *
 * A connection is one Bitbucket workspace reached with a token the admin
 * pastes in ordi – no OAuth consumer to register. Two kinds of token work:
 *
 * - an Atlassian **API token** (account settings → Security → API tokens,
 *   "with scopes", app Bitbucket). The REST API takes it as Basic
 *   `email:token`; git takes it under the static user
 *   `x-bitbucket-api-token-auth`.
 * - a workspace / project / repository **access token** (Bitbucket settings →
 *   Access tokens). The REST API takes it as a Bearer; git under the static
 *   user `x-token-auth`.
 *
 * Which one it is follows from whether an email came with it.
 *
 * Webhooks are not copied by hand: binding a repository to a project
 * registers (or refreshes) a repository webhook through the API, signed with
 * the connection's own secret – Bitbucket sends it back as
 * `X-Hub-Signature: sha256=<hex>`, which the shared git webhook route already
 * verifies.
 *
 * No database or crypto here: the agent workspace imports the API helpers;
 * sealing credentials lives in bitbucket-sync.ts.
 */
import type { EventType } from '@ordi/shared';
import { env } from '../../env';
import type { GitCandidate } from './git-links';

export const BITBUCKET_API = 'https://api.bitbucket.org/2.0';
export const BITBUCKET_WEB = 'https://bitbucket.org';

/** What a Bitbucket connection keeps (AES-GCM encrypted) in `git_connections.credentials`. */
export interface BitbucketCredentials {
  type: 'bitbucket';
  token: string;
  /** Present for an Atlassian API token, absent for an access token. */
  email?: string;
}

/** The events a registered webhook subscribes to – exactly what the webhook route understands. */
export const BITBUCKET_WEBHOOK_EVENTS = [
  'repo:push',
  'pullrequest:created',
  'pullrequest:updated',
  'pullrequest:fulfilled',
  'pullrequest:rejected',
] as const;

const WEBHOOK_DESCRIPTION = 'ordi';

/** The endpoint every registered Bitbucket webhook points at. */
export function bitbucketWebhookUrl(): string {
  return `${env.apiUrl}/api/v1/integrations/git/bitbucket/webhook`;
}

/** `Authorization` for REST calls. */
export function bitbucketAuthHeader(creds: Pick<BitbucketCredentials, 'token' | 'email'>): string {
  return creds.email
    ? `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString('base64')}`
    : `Bearer ${creds.token}`;
}

/** The static git username Bitbucket expects alongside the token. */
export function bitbucketGitUser(creds: Pick<BitbucketCredentials, 'email'>): string {
  return creds.email ? 'x-bitbucket-api-token-auth' : 'x-token-auth';
}

export class BitbucketApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** A readable reason for a failed call: the token problems an admin can actually fix. */
function describeFailure(status: number, what: string, detail: string): string {
  if (status === 401) return `Bitbucket rejected the credentials while ${what} – check the token (and the email for an API token)`;
  if (status === 403) return `The Bitbucket token is missing a permission needed for ${what}${detail ? `: ${detail}` : ''}`;
  if (status === 404) return `Bitbucket found nothing while ${what} – check the workspace slug and that the token can see it`;
  return `Bitbucket request failed while ${what} (${status})${detail ? `: ${detail}` : ''}`;
}

async function bbFetch<T>(
  creds: Pick<BitbucketCredentials, 'token' | 'email'>,
  url: string,
  what: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(url.startsWith('http') ? url : `${BITBUCKET_API}${url}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: bitbucketAuthHeader(creds),
      Accept: 'application/json',
      ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      'User-Agent': 'ordi',
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as { error?: { message?: string; detail?: string } };
      detail = data.error?.detail ?? data.error?.message ?? '';
    } catch { /* not JSON */ }
    throw new BitbucketApiError(describeFailure(res.status, what, detail), res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** `workspace/slug` → the API path segment, each half escaped. */
function repoPath(fullName: string): string {
  const [workspace = '', slug = ''] = fullName.split('/');
  return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
}

export interface BitbucketRepo { externalId: string; fullName: string; defaultBranch: string }

/** Every repository in the workspace the token can see (paginated, capped at 500, most recently updated first). */
export async function listBitbucketRepos(
  creds: Pick<BitbucketCredentials, 'token' | 'email'>,
  workspace: string,
): Promise<BitbucketRepo[]> {
  const out: BitbucketRepo[] = [];
  let next: string | undefined = `/repositories/${encodeURIComponent(workspace)}?pagelen=100&sort=-updated_on`;
  for (let page = 0; next && page < 5; page++) {
    const data: {
      values?: Array<{ uuid?: string; full_name?: string; mainbranch?: { name?: string } | null }>;
      next?: string;
    } = await bbFetch(creds, next, 'listing repositories');
    for (const r of data.values ?? []) {
      if (!r.uuid || !r.full_name) continue;
      out.push({ externalId: r.uuid, fullName: r.full_name, defaultBranch: r.mainbranch?.name ?? 'main' });
    }
    next = data.next;
  }
  return out;
}

/**
 * Make sure the repository has an ordi webhook carrying the current secret
 * and events. Idempotent: an existing hook on our URL is updated in place
 * (its secret may be stale after a reconnect), otherwise one is created.
 */
export async function ensureBitbucketWebhook(
  creds: Pick<BitbucketCredentials, 'token' | 'email'>,
  fullName: string,
  secret: string,
  url = bitbucketWebhookUrl(),
): Promise<'created' | 'updated'> {
  const base = `${repoPath(fullName)}/hooks`;
  const body = {
    description: WEBHOOK_DESCRIPTION,
    url,
    active: true,
    secret,
    events: [...BITBUCKET_WEBHOOK_EVENTS],
  };
  const list = await bbFetch<{ values?: Array<{ uuid?: string; url?: string }> }>(
    creds, `${base}?pagelen=100`, `reading the webhooks of ${fullName}`,
  );
  const existing = (list.values ?? []).find((h) => h.url === url && h.uuid);
  if (existing) {
    await bbFetch(creds, `${base}/${encodeURIComponent(existing.uuid!)}`, `updating the webhook of ${fullName}`, { method: 'PUT', body });
    return 'updated';
  }
  await bbFetch(creds, base, `registering a webhook on ${fullName}`, { method: 'POST', body });
  return 'created';
}

/**
 * Open a pull request from `head` into `base`, or return the open one that
 * already exists for that branch. Null when Bitbucket refuses – the push
 * already happened, so the run is not failed over it.
 */
export async function openBitbucketPullRequest(
  creds: Pick<BitbucketCredentials, 'token' | 'email'>,
  fullName: string,
  pr: { head: string; base: string; title: string; body: string },
): Promise<string | null> {
  const base = `${repoPath(fullName)}/pullrequests`;
  try {
    const q = encodeURIComponent(`source.branch.name="${pr.head.replace(/"/g, '\\"')}" AND state="OPEN"`);
    const existing = await bbFetch<{ values?: Array<{ links?: { html?: { href?: string } } }> }>(
      creds, `${base}?q=${q}`, `looking up pull requests on ${fullName}`,
    );
    const href = existing.values?.[0]?.links?.html?.href;
    if (href) return href;
  } catch { /* fall through to creating one */ }
  const created = await bbFetch<{ links?: { html?: { href?: string } } }>(
    creds, base, `opening a pull request on ${fullName}`,
    {
      method: 'POST',
      body: {
        title: pr.title,
        description: pr.body,
        source: { branch: { name: pr.head } },
        destination: { branch: { name: pr.base } },
        close_source_branch: false,
      },
    },
  );
  return created.links?.html?.href ?? null;
}

/* ─────────────────────────── webhook payloads ─────────────────────────── */

function personName(p: any): string | null {
  if (!p || typeof p !== 'object') return null;
  return p.display_name ?? p.nickname ?? p.username ?? null;
}

/** `Jane Doe <jane@x.io>` → `Jane Doe`. */
function rawAuthorName(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  return raw.replace(/\s*<[^>]*>\s*$/, '').trim() || null;
}

const PR_STATE: Record<string, string> = { OPEN: 'open', MERGED: 'merged', DECLINED: 'closed', SUPERSEDED: 'closed' };

/**
 * The pieces of a Bitbucket delivery that may name tasks: pushed branches and
 * their commits (`repo:push`), and pull requests (`pullrequest:*`). The event
 * comes from the `X-Event-Key` header – the payload itself does not say.
 */
export function bitbucketCandidates(eventKey: string | null, payload: any): GitCandidate[] {
  const out: GitCandidate[] = [];
  const actor = personName(payload?.actor);

  if (eventKey === 'repo:push') {
    const changes = Array.isArray(payload?.push?.changes) ? payload.push.changes : [];
    for (const change of changes) {
      const next = change?.new;
      if (!next || next.type !== 'branch' || typeof next.name !== 'string') continue;
      const branch: string = next.name;
      const isCreate = change?.created === true || change?.old == null;
      out.push({
        text: branch, type: 'branch',
        event: isCreate ? 'git.branch_created' : null,
        state: null, title: branch,
        url: typeof next.links?.html?.href === 'string' ? next.links.html.href : null,
        externalRef: branch, author: actor,
      });
      const commits = Array.isArray(change?.commits) ? change.commits : [];
      for (const cm of commits) {
        const msg: unknown = cm?.message;
        if (typeof msg !== 'string' || !msg) continue;
        out.push({
          text: msg, type: 'commit', event: null, state: null,
          title: msg.split('\n')[0]?.slice(0, 200) ?? null,
          url: typeof cm?.links?.html?.href === 'string' ? cm.links.html.href : null,
          externalRef: String(cm?.hash ?? '').slice(0, 40) || msg.slice(0, 40),
          author: personName(cm?.author?.user) ?? rawAuthorName(cm?.author?.raw),
        });
      }
    }
    return out;
  }

  const pr = payload?.pullrequest;
  if (eventKey?.startsWith('pullrequest:') && pr && typeof pr === 'object') {
    let event: EventType | null = null;
    let state = PR_STATE[String(pr.state ?? '').toUpperCase()] ?? 'open';
    if (eventKey === 'pullrequest:created') { event = 'git.pr_opened'; state = 'open'; }
    else if (eventKey === 'pullrequest:fulfilled') { event = 'git.pr_merged'; state = 'merged'; }
    else if (eventKey === 'pullrequest:rejected') { event = 'git.pr_closed'; state = 'closed'; }
    else if (eventKey !== 'pullrequest:updated') return out; // comments, approvals: nothing to link
    const sourceBranch = typeof pr.source?.branch?.name === 'string' ? pr.source.branch.name : '';
    out.push({
      // The source branch rides along: Bitbucket titles a PR after its last
      // commit, so the task key is often only in the branch name.
      text: `${pr.title ?? ''}\n${pr.description ?? ''}\n${sourceBranch}`, type: 'pr', event, state,
      title: typeof pr.title === 'string' ? pr.title : null,
      url: typeof pr.links?.html?.href === 'string' ? pr.links.html.href : null,
      externalRef: String(pr.id ?? ''),
      author: personName(pr.author) ?? actor,
    });
  }
  return out;
}
