/**
 * Bitbucket Cloud integration: a workspace connects with a pasted token,
 * binding one of its repositories registers a signed webhook through the API,
 * and the deliveries that webhook sends (push, pull request) link tasks
 * through the same pipeline as GitHub's.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { getDb, schema, eq, and } from '@ordi/db';
import { app, resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import {
  bitbucketCandidates, bitbucketAuthHeader, bitbucketGitUser, bitbucketWebhookUrl,
} from '../domains/integrations/bitbucket';
import { resolveRepository } from '../domains/agents/repository';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;

const REPOS_PAGE = {
  values: [
    { uuid: '{r-1}', full_name: 'acme/site', mainbranch: { name: 'master' } },
    { uuid: '{r-2}', full_name: 'acme/api', mainbranch: { name: 'main' } },
  ],
};

interface Call { url: string; method: string; auth: string | null; body: any }

/** A fake api.bitbucket.org: answers by path, records every call. */
function fakeBitbucket(overrides: Record<string, (call: Call) => Response> = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call: Call = {
      url, method: init?.method ?? 'GET', auth: headers.get('authorization'),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    for (const [pattern, handler] of Object.entries(overrides)) {
      if (url.includes(pattern)) return handler(call);
    }
    if (/\/repositories\/acme\?/.test(url)) return Response.json(REPOS_PAGE);
    if (/\/hooks\?pagelen/.test(url)) return Response.json({ values: [] });
    if (/\/hooks$/.test(url) && call.method === 'POST') return Response.json({ uuid: '{h-1}' }, { status: 201 });
    return new Response('not found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('auth', () => {
  it('an API token goes as Basic email:token, an access token as Bearer', () => {
    expect(bitbucketAuthHeader({ token: 'tok', email: 'a@b.io' })).toBe(`Basic ${Buffer.from('a@b.io:tok').toString('base64')}`);
    expect(bitbucketAuthHeader({ token: 'tok' })).toBe('Bearer tok');
    expect(bitbucketGitUser({ email: 'a@b.io' })).toBe('x-bitbucket-api-token-auth');
    expect(bitbucketGitUser({})).toBe('x-token-auth');
  });
});

describe('payload parsing', () => {
  it('a push yields the branch (created) and each commit', () => {
    const out = bitbucketCandidates('repo:push', {
      actor: { display_name: 'Dev One' },
      push: {
        changes: [{
          created: true, old: null,
          new: { type: 'branch', name: 'feature/BB-1-thing', links: { html: { href: 'https://bitbucket.org/acme/site/branch/feature/BB-1-thing' } } },
          commits: [{ hash: 'abc123', message: 'BB-1 first\n\nbody', author: { raw: 'Dev One <dev@acme.io>' }, links: { html: { href: 'https://bitbucket.org/acme/site/commits/abc123' } } }],
        }],
      },
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ type: 'branch', externalRef: 'feature/BB-1-thing', event: 'git.branch_created', author: 'Dev One' });
    expect(out[1]).toMatchObject({ type: 'commit', externalRef: 'abc123', title: 'BB-1 first', author: 'Dev One' });
  });

  it('a push to an existing branch is not a creation; a tag push is ignored', () => {
    const out = bitbucketCandidates('repo:push', {
      push: {
        changes: [
          { created: false, old: { type: 'branch', name: 'x' }, new: { type: 'branch', name: 'x' }, commits: [] },
          { created: true, old: null, new: { type: 'tag', name: 'v1' } },
        ],
      },
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.event).toBeNull();
  });

  it('pull request events map to opened / merged / declined; updates carry state only', () => {
    const pr = (state: string) => ({ pullrequest: { id: 9, title: 'BB-2 do it', description: '', state, links: { html: { href: 'u' } }, author: { display_name: 'Dev' }, source: { branch: { name: 'feature/BB-2' } } } });
    expect(bitbucketCandidates('pullrequest:created', pr('OPEN'))[0]).toMatchObject({ event: 'git.pr_opened', state: 'open', externalRef: '9' });
    expect(bitbucketCandidates('pullrequest:fulfilled', pr('MERGED'))[0]).toMatchObject({ event: 'git.pr_merged', state: 'merged' });
    expect(bitbucketCandidates('pullrequest:rejected', pr('DECLINED'))[0]).toMatchObject({ event: 'git.pr_closed', state: 'closed' });
    expect(bitbucketCandidates('pullrequest:updated', pr('OPEN'))[0]).toMatchObject({ event: null, state: 'open' });
    expect(bitbucketCandidates('pullrequest:comment_created', pr('OPEN'))).toHaveLength(0);
  });
});

describe('connecting a workspace', () => {
  it('requires integrations.manage', async () => {
    const guest = reqAs(users.guest!.cookie);
    expect((await guest.post('/integrations/bitbucket/connections', { workspace: 'acme', token: 't' })).status).toBe(403);
  });

  it('a rejected token stores nothing and says why', async () => {
    fakeBitbucket({ '/repositories/acme?': () => new Response('{}', { status: 401 }) });
    const owner = reqAs(users.owner!.cookie);
    const res = await owner.post('/integrations/bitbucket/connections', { workspace: 'acme', token: 'bad' });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain('rejected the credentials');
    const { db } = getDb();
    expect(await db.select().from(schema.gitConnections).where(eq(schema.gitConnections.provider, 'bitbucket'))).toHaveLength(0);
  });

  it('a good token creates the connection and syncs the repositories; reconnecting rotates the token in place', async () => {
    const calls = fakeBitbucket();
    const owner = reqAs(users.owner!.cookie);
    const res = await json(owner.post('/integrations/bitbucket/connections', { workspace: 'acme', email: 'admin@acme.io', token: 'tok-1' }));
    expect(res).toMatchObject({ created: true, repos: 2 });
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from('admin@acme.io:tok-1').toString('base64')}`);

    const conns = (await json(owner.get('/integrations/git/connections'))).data as any[];
    expect(conns.find((c) => c.id === res.id)).toMatchObject({ provider: 'bitbucket', accountLogin: 'acme', status: 'connected' });
    const repos = (await json(owner.get(`/integrations/git/repositories?connectionId=${res.id}`))).data as any[];
    expect(repos.map((r) => `${r.fullName}@${r.defaultBranch}`).sort()).toEqual(['acme/api@main', 'acme/site@master']);

    // The picker lists live from Bitbucket through the stored token.
    const live = (await json(owner.get(`/integrations/git/connections/${res.id}/repos`))).data as any[];
    expect(live.map((r) => r.externalId)).toEqual(['{r-1}', '{r-2}']);

    const again = await json(owner.post('/integrations/bitbucket/connections', { workspace: 'acme', token: 'tok-2' }));
    expect(again).toMatchObject({ id: res.id, created: false });
    expect(calls.at(-1)!.auth).toBe('Bearer tok-2');
    const { db } = getDb();
    expect(await db.select().from(schema.gitConnections).where(eq(schema.gitConnections.provider, 'bitbucket'))).toHaveLength(1);
  });
});

describe('binding and deliveries', () => {
  async function setup(key: string) {
    const owner = reqAs(users.owner!.cookie);
    const type = await json(owner.post('/project-types', { name: `BB ${key}`, revenueSource: 'none' }));
    const project = await json(owner.post('/projects', { name: `Bitbucket ${key}`, key, projectTypeId: type.id }));
    const task = await json(owner.post('/tasks', {
      projectId: project.id, title: 'Ship it', priority: 'none', assigneeIds: [], labelIds: [],
    }));
    const { db } = getDb();
    const [conn] = await db.select().from(schema.gitConnections).where(eq(schema.gitConnections.provider, 'bitbucket'));
    const [repo] = await db.select().from(schema.gitRepositories)
      .where(and(eq(schema.gitRepositories.connectionId, conn!.id), eq(schema.gitRepositories.fullName, 'acme/site')));
    return { owner, project, task, conn: conn!, repo: repo! };
  }

  function deliver(secret: string, eventKey: string, payload: unknown, id: string) {
    const body = JSON.stringify(payload);
    return app.request('/api/v1/integrations/git/bitbucket/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-event-key': eventKey,
        'x-request-uuid': id,
        'x-hub-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
      body,
    });
  }

  it('binding a repository registers a webhook signed with the connection secret', async () => {
    const { owner, project, conn, repo } = await setup('BBH');
    const calls = fakeBitbucket();
    const res = await json(owner.post(`/projects/${project.id}/repositories`, { repositoryId: repo.id }));
    expect(res.webhook).toEqual({ status: 'ok' });
    const created = calls.find((c) => c.method === 'POST' && c.url.endsWith('/repositories/acme/site/hooks'));
    expect(created?.body).toMatchObject({
      url: bitbucketWebhookUrl(), active: true, secret: conn.webhookSecret,
      events: ['repo:push', 'pullrequest:created', 'pullrequest:updated', 'pullrequest:fulfilled', 'pullrequest:rejected'],
    });
  });

  it('an existing ordi hook is updated in place, not duplicated', async () => {
    const { owner, project, repo } = await setup('BBU');
    const calls = fakeBitbucket({
      '/hooks?pagelen': () => Response.json({ values: [{ uuid: '{h-9}', url: bitbucketWebhookUrl() }] }),
      '/hooks/%7Bh-9%7D': () => Response.json({ uuid: '{h-9}' }),
    });
    await json(owner.post(`/projects/${project.id}/repositories`, { repositoryId: repo.id }));
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/hooks'))).toBe(false);
    expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/hooks/%7Bh-9%7D'))).toBe(true);
  });

  it('a token without the webhook scope still binds, and the reason comes back', async () => {
    const { owner, project, repo } = await setup('BBF');
    fakeBitbucket({ '/hooks?pagelen': () => new Response('{}', { status: 403 }) });
    const res = await owner.post(`/projects/${project.id}/repositories`, { repositoryId: repo.id });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.webhook.status).toBe('failed');
    expect(body.webhook.error).toContain('missing a permission');
  });

  it('a signed push links the branch and commit; a pull request follows created → fulfilled', async () => {
    const { owner, project, task, conn, repo } = await setup('BBP');
    fakeBitbucket();
    await json(owner.post(`/projects/${project.id}/repositories`, { repositoryId: repo.id }));
    vi.unstubAllGlobals();
    const ref = `BBP-${task.number}`;
    const { db } = getDb();

    const push = await deliver(conn.webhookSecret, 'repo:push', {
      actor: { display_name: 'Dev' },
      repository: { full_name: 'acme/site' },
      push: {
        changes: [{
          created: true, old: null,
          new: { type: 'branch', name: `feature/${ref.toLowerCase()}-ship` },
          commits: [{ hash: 'deadbeef', message: `${ref} ship it`, author: { user: { display_name: 'Dev' } }, links: { html: { href: 'https://bitbucket.org/acme/site/commits/deadbeef' } } }],
        }],
      },
    }, 'bb-push-1');
    expect(push.status).toBe(200);
    let links = await db.select().from(schema.gitLinks).where(eq(schema.gitLinks.taskId, task.id));
    expect(links.map((l) => l.type).sort()).toEqual(['branch', 'commit']);

    const pr = (state: string) => ({
      actor: { display_name: 'Dev' },
      repository: { full_name: 'acme/site' },
      pullrequest: {
        id: 4, title: 'Ship it', description: '', state,
        links: { html: { href: 'https://bitbucket.org/acme/site/pull-requests/4' } },
        author: { display_name: 'Dev' },
        source: { branch: { name: `feature/${ref}-ship` } },
      },
    });
    expect((await deliver(conn.webhookSecret, 'pullrequest:created', pr('OPEN'), 'bb-pr-1')).status).toBe(200);
    expect((await deliver(conn.webhookSecret, 'pullrequest:fulfilled', pr('MERGED'), 'bb-pr-2')).status).toBe(200);
    links = await db.select().from(schema.gitLinks).where(eq(schema.gitLinks.taskId, task.id));
    const prLink = links.find((l) => l.type === 'pr');
    expect(prLink).toMatchObject({ externalRef: '4', state: 'merged', url: 'https://bitbucket.org/acme/site/pull-requests/4' });

    const events = (await db.select({ type: schema.events.type }).from(schema.events)
      .where(eq(schema.events.aggregateId, task.id))).map((e) => e.type).filter((t) => t.startsWith('git.'));
    expect(events.sort()).toEqual(['git.branch_created', 'git.pr_merged', 'git.pr_opened']);
  });

  it('a delivery signed with another secret changes nothing', async () => {
    const { task } = await setup('BBX');
    const res = await deliver('not-the-secret', 'repo:push', {
      repository: { full_name: 'acme/site' },
      push: { changes: [{ created: true, old: null, new: { type: 'branch', name: `BBX-${task.number}` }, commits: [] }] },
    }, 'bb-forged-1');
    expect(res.status).toBe(200);
    const { db } = getDb();
    expect(await db.select().from(schema.gitLinks).where(eq(schema.gitLinks.taskId, task.id))).toHaveLength(0);
  });

  it('agents get a clone binding with Bitbucket\'s git user', async () => {
    const { owner, project, repo } = await setup('BBA');
    fakeBitbucket();
    await json(owner.post(`/projects/${project.id}/repositories`, { repositoryId: repo.id }));
    const binding = await resolveRepository(project.id);
    // The last connect in this file used an access token (no email).
    expect(binding).toMatchObject({
      provider: 'bitbucket', fullName: 'acme/site', defaultBranch: 'master',
      htmlUrl: 'https://bitbucket.org', token: 'tok-2', gitUser: 'x-token-auth',
    });
    expect(binding?.apiUser).toBeUndefined();
  });
});
