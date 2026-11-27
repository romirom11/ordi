/**
 * Connecting an MCP client by signing in, as the person's own agent: the
 * consent page offers it, the code carries it, the exchange checks it again
 * and issues the agent's token. Connecting the same client again for the
 * same target replaces the earlier OAuth token instead of adding one.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb, schema, eq, sql } from '@ordi/db';
import { PERSONAL_AGENT_PERMISSIONS } from '@ordi/shared';
import { app, resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { setupWorkspace, type Workspace } from './agents-helpers';

const REDIRECT = 'http://127.0.0.1:33418/callback';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let ws: Workspace;
let agentId: string;

const owner = () => reqAs(users.owner!.cookie);

function bearer(raw: string) {
  const headers = { authorization: `Bearer ${raw}`, 'content-type': 'application/json' };
  return {
    get: (path: string) => app.request(`/api/v1${path}`, { headers }),
    post: (path: string, body?: unknown) => app.request(`/api/v1${path}`, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined }),
  };
}

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

function pkce() {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

let registrations = 0;
async function registerClient(name: string, redirect = REDIRECT): Promise<string> {
  const res = await app.request('/api/v1/oauth/register', {
    method: 'POST',
    // Its own address each: registration is rate-limited per address, and this file registers many.
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': `10.9.0.${++registrations}` },
    body: JSON.stringify({ redirect_uris: [redirect], client_name: name }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

async function approve(cookie: string, clientId: string, actAs?: 'me' | 'agent', redirect = REDIRECT) {
  const { verifier, challenge } = pkce();
  const res = await reqAs(cookie).post('/oauth/approve', {
    clientId, redirectUri: redirect, codeChallenge: challenge, codeChallengeMethod: 'S256',
    ...(actAs ? { actAs } : {}),
  });
  return { res, verifier };
}

async function exchange(clientId: string, code: string, verifier: string, redirect = REDIRECT) {
  return app.request('/api/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, client_id: clientId }),
  });
}

/** The whole dance for one signed-in person; returns the access token. */
async function connect(cookie: string, clientId: string, actAs?: 'me' | 'agent', redirect = REDIRECT): Promise<string> {
  const { res, verifier } = await approve(cookie, clientId, actAs, redirect);
  expect(res.status).toBe(200);
  const code = new URL(((await res.json()) as { redirectTo: string }).redirectTo).searchParams.get('code')!;
  const tokenRes = await exchange(clientId, code, verifier, redirect);
  expect(tokenRes.status).toBe(200);
  return ((await tokenRes.json()) as { access_token: string }).access_token;
}

async function commentAuthor(raw: string, text: string) {
  const res = await bearer(raw).post(`/tasks/${ws.taskId}/comments`, { body: doc(text) });
  expect(res.status).toBe(201);
  const created = (await res.json()) as { id: string };
  const [row] = await getDb().db.select({ authorId: schema.comments.authorId, via: schema.comments.via })
    .from(schema.comments).where(eq(schema.comments.id, created.id));
  return row;
}

async function tokenWorks(raw: string): Promise<boolean> {
  return (await bearer(raw).get(`/tasks/${ws.taskId}`)).status === 200;
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  ws = await setupWorkspace(users, 'OAG');
  const created = await owner().post('/my-agent', { name: 'Jarvis' });
  expect(created.status).toBe(201);
  agentId = (await json(created)).id;
});

describe('choosing who the client works as', () => {
  it('the consent page learns about the person\'s own agent, and only theirs', async () => {
    const clientId = await registerClient('Claude Code');
    const info = await json(owner().get(`/oauth/client?client_id=${clientId}`));
    expect(info.myAgent).toEqual({ name: 'Jarvis', isActive: true });
    // Someone without an agent is offered only themselves.
    const other = await json(reqAs(users.manager!.cookie).get(`/oauth/client?client_id=${clientId}`));
    expect(other.myAgent).toBeNull();
  });

  it('as my agent: the token is the agent\'s, and what it writes says which client', async () => {
    const clientId = await registerClient('Claude Code');
    const raw = await connect(users.owner!.cookie, clientId, 'agent');

    const [row] = await getDb().db.select().from(schema.apiTokens).where(eq(schema.apiTokens.prefix, raw.slice(0, 12)));
    expect(row).toMatchObject({ userId: agentId, name: 'Claude Code', oauthClientId: clientId, readOnly: false });
    expect(row!.scopes).toEqual(PERSONAL_AGENT_PERMISSIONS);
    // The My agent card's default lifetime, not forever.
    const days = (row!.expiresAt!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90);

    expect(await commentAuthor(raw, 'Picked this up.')).toEqual({ authorId: agentId, via: 'Claude Code' });

    // It is listed with the agent's clients, not among the person's own tokens.
    const mine = await json(owner().get('/my-agent'));
    expect(mine.agent.tokens).toEqual(expect.arrayContaining([expect.objectContaining({ id: row!.id, name: 'Claude Code', oauth: true })]));
    const personal = (await json(owner().get('/auth/tokens'))).data.map((t: { id: string }) => t.id);
    expect(personal).not.toContain(row!.id);
  });

  it('as me: the token is the person\'s, as before – also when the page does not say', async () => {
    const clientId = await registerClient('Cursor');
    const explicit = await connect(users.owner!.cookie, clientId, 'me');
    expect(await commentAuthor(explicit, 'Written as me.')).toMatchObject({ authorId: users.owner!.userId });

    const legacyClient = await registerClient('Old consent page');
    const omitted = await connect(users.owner!.cookie, legacyClient);
    const [row] = await getDb().db.select().from(schema.apiTokens).where(eq(schema.apiTokens.prefix, omitted.slice(0, 12)));
    expect(row).toMatchObject({ userId: users.owner!.userId, name: 'Old consent page (OAuth)', expiresAt: null });
  });

  it('as my agent without one is refused', async () => {
    const clientId = await registerClient('Codex');
    const { res } = await approve(users.manager!.cookie, clientId, 'agent');
    expect(res.status).toBe(404);
  });
});

describe('the agent is checked again at the exchange', () => {
  it('a code bound to someone else\'s agent is refused', async () => {
    // Nothing the approve route accepts names an agent; a code that names
    // one not the approver's (a row written some other way) still fails.
    const clientId = await registerClient('Claude Code');
    const { verifier, challenge } = pkce();
    const code = `forged-${randomBytes(16).toString('hex')}`;
    await getDb().db.insert(schema.oauthAuthCodes).values({
      id: ulid(), code, clientId, userId: users.manager!.userId, agentUserId: agentId,
      codeChallenge: challenge, redirectUri: REDIRECT, expiresAt: new Date(Date.now() + 60_000),
    });
    const res = await exchange(clientId, code, verifier);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    const theirs = await getDb().db.select().from(schema.apiTokens).where(eq(schema.apiTokens.oauthClientId, clientId));
    expect(theirs).toEqual([]);
  });

  it('a code naming the approver\'s own agent cannot be stretched to another agent kind', async () => {
    // A team bot owned by the approver is not "their agent".
    const bot = await json(owner().post('/external-agents', { name: 'Team bot' }));
    const clientId = await registerClient('Claude Code');
    const { verifier, challenge } = pkce();
    const code = `forged-${randomBytes(16).toString('hex')}`;
    await getDb().db.insert(schema.oauthAuthCodes).values({
      id: ulid(), code, clientId, userId: users.owner!.userId, agentUserId: bot.id,
      codeChallenge: challenge, redirectUri: REDIRECT, expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await exchange(clientId, code, verifier)).status).toBe(400);
  });

  it('an agent switched off between approve and exchange gets no token', async () => {
    const clientId = await registerClient('Claude Code');
    const { res, verifier } = await approve(users.owner!.cookie, clientId, 'agent');
    expect(res.status).toBe(200);
    const code = new URL(((await res.json()) as { redirectTo: string }).redirectTo).searchParams.get('code')!;
    expect((await owner().post('/my-agent/disable')).status).toBe(200);
    try {
      const tokenRes = await exchange(clientId, code, verifier);
      expect(tokenRes.status).toBe(400);
      expect(((await tokenRes.json()) as { error: string }).error).toBe('invalid_grant');
      // ...and while it is off, approving as it is refused outright.
      expect((await approve(users.owner!.cookie, clientId, 'agent')).res.status).toBeGreaterThanOrEqual(400);
      expect((await json(owner().get(`/oauth/client?client_id=${clientId}`))).myAgent).toEqual({ name: 'Jarvis', isActive: false });
    } finally {
      expect((await owner().post('/my-agent/enable')).status).toBe(200);
    }
  });

  it('an agent\'s token, or any API token, cannot approve a consent', async () => {
    const clientId = await registerClient('Claude Code');
    const agentToken = await connect(users.owner!.cookie, clientId, 'agent');
    const { challenge } = pkce();
    const body = { clientId, redirectUri: REDIRECT, codeChallenge: challenge, codeChallengeMethod: 'S256', actAs: 'agent' };
    expect((await bearer(agentToken).post('/oauth/approve', body)).status).toBe(403);
    expect((await bearer(agentToken).post('/oauth/approve', { ...body, actAs: 'me' })).status).toBe(403);
    const personToken = await connect(users.owner!.cookie, await registerClient('Some client'), 'me');
    expect((await bearer(personToken).post('/oauth/approve', body)).status).toBe(403);
  });
});

describe('connecting the same client again', () => {
  it('replaces the earlier OAuth token for that target, and nothing else', async () => {
    const { db } = getDb();
    // Clients register afresh on reconnect: a new client id under the same name.
    const first = await connect(users.owner!.cookie, await registerClient('Codex CLI'), 'agent');
    const asMe = await connect(users.owner!.cookie, await registerClient('Codex CLI'), 'me');
    const otherClient = await connect(users.owner!.cookie, await registerClient('Zed'), 'agent');
    const handMadeForAgent = (await json(owner().post('/my-agent/tokens', { client: 'Codex CLI', expiresInDays: 30 }))).token as string;
    const handMadeForMe = (await json(owner().post('/auth/tokens', { name: 'Codex CLI (OAuth)', scopes: ['projects.read'], readOnly: true }))).token as string;
    for (const raw of [first, asMe, otherClient, handMadeForAgent]) expect(await tokenWorks(raw)).toBe(true);

    const second = await connect(users.owner!.cookie, await registerClient('Codex CLI'), 'agent');
    expect(await tokenWorks(second)).toBe(true);
    expect(await tokenWorks(first)).toBe(false);
    // The person's own connection of that client, another client, and tokens
    // made by hand all keep working.
    expect(await tokenWorks(asMe)).toBe(true);
    expect(await tokenWorks(otherClient)).toBe(true);
    expect(await tokenWorks(handMadeForAgent)).toBe(true);

    // As me, again: the person's earlier connection goes, the agent's stays.
    const asMeAgain = await connect(users.owner!.cookie, await registerClient('Codex CLI'), 'me');
    expect(await tokenWorks(asMeAgain)).toBe(true);
    expect(await tokenWorks(asMe)).toBe(false);
    expect(await tokenWorks(second)).toBe(true);
    // A hand-made token is never an OAuth one, whatever it is called.
    expect(await tokenWorks(handMadeForMe)).toBe(true);

    const live = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, agentId));
    expect(live.filter((t) => !t.revokedAt && t.name === 'Codex CLI').length).toBe(2); // the OAuth one and the hand-made one
  });

  it('a look-alike client under the same name does not cut off the real one', async () => {
    const real = await connect(users.owner!.cookie, await registerClient('Claude Desktop'), 'agent');
    // Someone registers a client called the same, sending codes to their own host.
    const evilRedirect = 'https://evil.example.com/cb';
    const lookAlike = await connect(users.owner!.cookie, await registerClient('Claude Desktop', evilRedirect), 'agent', evilRedirect);
    expect(await tokenWorks(lookAlike)).toBe(true);
    expect(await tokenWorks(real)).toBe(true);
    // The real client reconnecting on another loopback port is still the same client.
    const otherPort = 'http://127.0.0.1:47001/callback';
    const again = await connect(users.owner!.cookie, await registerClient('Claude Desktop', otherPort), 'agent', otherPort);
    expect(await tokenWorks(again)).toBe(true);
    expect(await tokenWorks(real)).toBe(false);
    expect(await tokenWorks(lookAlike)).toBe(true);
  });

  it('a person\'s pile of OAuth tokens from before the upgrade is cleared by the next consent', async () => {
    const { db } = getDb();
    const clientId = await registerClient('Claude');
    const legacy: string[] = [];
    const insert = async (name: string) => {
      const raw = `ordi_${randomBytes(18).toString('base64url')}`;
      await db.insert(schema.apiTokens).values({
        id: ulid(), userId: users.manager!.userId, name,
        hash: createHash('sha256').update(raw).digest('hex'), prefix: raw.slice(0, 12), scopes: ['projects.read'],
      });
      return raw;
    };
    // What an approval always left behind: an oauth.authorize entry just before the token.
    const approved = () => db.insert(schema.activityLog).values({
      id: ulid(), entityType: 'user', entityId: users.manager!.userId, actorId: users.manager!.userId,
      actorType: 'user', action: 'oauth.authorize', diff: { client: 'Claude' },
    });
    for (let i = 0; i < 3; i++) { await approved(); legacy.push(await insert('Claude (OAuth)')); }
    const handMade = await insert('Claude');
    // Made by hand, under the very name OAuth gives, with no approval behind it.
    const handMadeSuffix = await insert('Claude (OAuth)');
    await db.update(schema.apiTokens).set({ createdAt: new Date(Date.now() - 86_400_000) })
      .where(eq(schema.apiTokens.prefix, handMadeSuffix.slice(0, 12)));
    const unknownClient = await insert('Gone client (OAuth)');
    // What the migration does to the rows an upgrade finds.
    const migration = readFileSync(fileURLToPath(new URL('../../../../packages/db/drizzle/0052_oauth_connect_as_agent.sql', import.meta.url)), 'utf8');
    const backfill = migration.split('--> statement-breakpoint').find((st) => st.includes('UPDATE "api_tokens"'))!;
    await db.execute(sql.raw(backfill));
    const tied = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, users.manager!.userId));
    expect(tied.filter((t) => t.oauthClientId === clientId)).toHaveLength(3);
    for (const raw of [...legacy, handMade, handMadeSuffix, unknownClient]) expect(await tokenWorks(raw)).toBe(true);

    const fresh = await connect(users.manager!.cookie, await registerClient('Claude'));
    expect(await tokenWorks(fresh)).toBe(true);
    for (const raw of legacy) expect(await tokenWorks(raw)).toBe(false);
    expect(await tokenWorks(handMade)).toBe(true);
    expect(await tokenWorks(handMadeSuffix)).toBe(true);
    expect(await tokenWorks(unknownClient)).toBe(true);
  });
});

describe('races and changes between approve and exchange', () => {
  async function approved(cookie: string, clientId: string, actAs?: 'me' | 'agent') {
    const { res, verifier } = await approve(cookie, clientId, actAs);
    expect(res.status).toBe(200);
    return { code: new URL(((await res.json()) as { redirectTo: string }).redirectTo).searchParams.get('code')!, verifier };
  }

  it('one code redeemed twice at once gives one token', async () => {
    const clientId = await registerClient('Racer');
    const { code, verifier } = await approved(users.owner!.cookie, clientId, 'agent');
    const results = await Promise.all([exchange(clientId, code, verifier), exchange(clientId, code, verifier), exchange(clientId, code, verifier)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
  });

  it('two reconnects of the same client at once leave one live token', async () => {
    const { db } = getDb();
    for (const actAs of ['me', 'agent'] as const) {
      const a = await registerClient(`Twin ${actAs}`);
      const b = await registerClient(`Twin ${actAs}`);
      const [ca, cb] = [await approved(users.owner!.cookie, a, actAs), await approved(users.owner!.cookie, b, actAs)];
      const results = await Promise.all([exchange(a, ca.code, ca.verifier), exchange(b, cb.code, cb.verifier)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const rows = await db.select().from(schema.apiTokens).innerJoin(schema.oauthClients, eq(schema.oauthClients.id, schema.apiTokens.oauthClientId))
        .where(eq(schema.oauthClients.name, `Twin ${actAs}`));
      expect(rows.filter((r) => !r.api_tokens.revokedAt)).toHaveLength(1);
    }
  });

  it('a consent given before the agent was switched off is gone once it is back on', async () => {
    const clientId = await registerClient('Claude Code');
    const { code, verifier } = await approved(users.owner!.cookie, clientId, 'agent');
    expect((await owner().post('/my-agent/disable')).status).toBe(200);
    expect((await owner().post('/my-agent/enable')).status).toBe(200);
    expect((await exchange(clientId, code, verifier)).status).toBe(400);
  });

  it('an owner deactivated between approve and exchange gets no token for their agent', async () => {
    const sales = reqAs(users.sales!.cookie);
    expect((await sales.post('/my-agent', { name: 'Sales helper' })).status).toBe(201);
    const clientId = await registerClient('Claude Code');
    const asAgent = await approved(users.sales!.cookie, clientId, 'agent');
    const asMe = await approved(users.sales!.cookie, clientId, 'me');
    expect((await owner().post(`/users/${users.sales!.userId}/deactivate`, { reassignTo: users.manager!.userId })).status).toBe(200);
    for (const { code, verifier } of [asAgent, asMe]) {
      const res = await exchange(clientId, code, verifier);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
    }
  });
});
