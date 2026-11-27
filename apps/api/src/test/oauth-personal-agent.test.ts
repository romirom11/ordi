/**
 * Connecting an MCP client by signing in, as the person's own agent: the
 * consent page offers it, the code carries it, the exchange checks it again
 * and issues the agent's token. Every consent is a connection of its own:
 * signing in again keeps the earlier ones, and the scheduled clean-up
 * revokes those never used or long idle – and nothing else.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb, schema, eq, sql } from '@ordi/db';
import { runOAuthTokenCleanup } from '../workers/scheduled';
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

let exchanges = 0;
async function exchange(clientId: string, code: string, verifier: string, redirect = REDIRECT) {
  return app.request('/api/v1/oauth/token', {
    method: 'POST',
    // Its own address each: the token endpoint is rate-limited per address too.
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `10.8.${Math.floor(++exchanges / 250)}.${exchanges % 250}` },
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
  it('keeps every earlier connection, for both targets', async () => {
    // Clients register afresh on reconnect: a new client id under the same
    // name. A laptop and a server each sign in; neither cuts the other off.
    const laptop = await connect(users.owner!.cookie, await registerClient('Codex CLI'), 'agent');
    const laptopAsMe = await connect(users.owner!.cookie, await registerClient('Codex CLI'), 'me');
    const server = await connect(users.owner!.cookie, await registerClient('Codex CLI'), 'agent');
    const serverAsMe = await connect(users.owner!.cookie, await registerClient('Codex CLI'), 'me');
    // The same machine on another loopback port, the same registration twice.
    const otherPort = 'http://127.0.0.1:47001/callback';
    const clientId = await registerClient('Codex CLI', otherPort);
    const again = await connect(users.owner!.cookie, clientId, 'agent', otherPort);
    const againSame = await connect(users.owner!.cookie, clientId, 'agent', otherPort);
    for (const raw of [laptop, laptopAsMe, server, serverAsMe, again, againSame]) expect(await tokenWorks(raw)).toBe(true);
  });

  it('a person\'s OAuth tokens from before the upgrade are tied to their client, and kept by the next consent', async () => {
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
    // A look-alike registered after those tokens were issued cannot have issued them.
    await new Promise((r) => setTimeout(r, 5));
    await registerClient('Claude', 'https://evil.example.com/cb');
    // What the migration does to the rows an upgrade finds.
    const migration = readFileSync(fileURLToPath(new URL('../../../../packages/db/drizzle/0052_oauth_connect_as_agent.sql', import.meta.url)), 'utf8');
    const backfill = migration.split('--> statement-breakpoint').find((st) => st.includes('UPDATE "api_tokens"'))!;
    await db.execute(sql.raw(backfill));
    const tied = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, users.manager!.userId));
    expect(tied.filter((t) => t.oauthClientId === clientId)).toHaveLength(3);
    // Only the tied ones are the clean-up's to judge.
    for (const raw of [handMade, handMadeSuffix, unknownClient]) {
      expect(tied.find((t) => t.prefix === raw.slice(0, 12))!.oauthClientId).toBeNull();
    }

    const fresh = await connect(users.manager!.cookie, await registerClient('Claude'));
    for (const raw of [fresh, ...legacy, handMade, handMadeSuffix, unknownClient]) expect(await tokenWorks(raw)).toBe(true);
  });
});

describe('the clean-up of unused sign-ins', () => {
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  const { db } = getDb();
  const rowOf = async (raw: string) => (await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.prefix, raw.slice(0, 12))))[0]!;
  const age = async (raw: string, { created, used }: { created: number; used: number | null }) => {
    await db.update(schema.apiTokens).set({
      createdAt: new Date(Date.now() - created),
      lastUsedAt: used === null ? null : new Date(Date.now() - used),
    }).where(eq(schema.apiTokens.prefix, raw.slice(0, 12)));
  };
  /** Every token of the test that is still live, so earlier tests' tokens do not count. */
  const revokedOf = async (raws: string[]) => {
    const out: Record<string, boolean> = {};
    for (const raw of raws) out[raw] = !!(await rowOf(raw)).revokedAt;
    return out;
  };

  it('revokes OAuth tokens never used within a day or idle for 90 days, and nothing else', async () => {
    const clientId = await registerClient('Claude Code');
    // Issued through the sign-in, for the person and for their agent.
    const neverUsedMe = await connect(users.owner!.cookie, clientId, 'me');
    const neverUsedAgent = await connect(users.owner!.cookie, clientId, 'agent');
    const idleMe = await connect(users.owner!.cookie, clientId, 'me');
    const idleAgent = await connect(users.owner!.cookie, clientId, 'agent');
    const freshUnused = await connect(users.owner!.cookie, clientId, 'me');
    const usedRecently = await connect(users.owner!.cookie, clientId, 'agent');
    const usedLongAgo = await connect(users.owner!.cookie, clientId, 'me');
    // Every other kind of token, all as old and unused as can be.
    const handMade = (await json(owner().post('/auth/tokens', { name: 'Claude Code (OAuth)', scopes: ['projects.read'], readOnly: true }))).token as string;
    const myAgentCard = (await json(owner().post('/my-agent/tokens', { client: 'Claude Code', expiresInDays: null }))).token as string;
    const bot = await json(owner().post('/external-agents', { name: 'Cleanup bot' }));
    const teamBot = (await json(owner().post(`/external-agents/${bot.id}/tokens`, { name: 'CI', expiresInDays: null }))).token as string;
    const agentRun = `ordi_${randomBytes(18).toString('base64url')}`;
    await db.insert(schema.apiTokens).values({
      id: ulid(), userId: agentId, name: 'agent run 01TEST', hash: createHash('sha256').update(agentRun).digest('hex'),
      prefix: agentRun.slice(0, 12), scopes: ['projects.read'],
    });

    await age(neverUsedMe, { created: 25 * HOUR, used: null });
    await age(neverUsedAgent, { created: 25 * HOUR, used: null });
    await age(idleMe, { created: 200 * DAY, used: 91 * DAY });
    await age(idleAgent, { created: 95 * DAY, used: 91 * DAY });
    await age(freshUnused, { created: 23 * HOUR, used: null });
    await age(usedRecently, { created: 200 * DAY, used: 2 * DAY });
    await age(usedLongAgo, { created: 200 * DAY, used: 89 * DAY });
    for (const raw of [handMade, myAgentCard, teamBot, agentRun]) await age(raw, { created: 400 * DAY, used: null });
    for (const raw of [neverUsedMe, idleMe, usedRecently]) expect(await tokenWorks(raw)).toBe(true);
    // tokenWorks touched those three: put them back where the test needs them.
    await age(neverUsedMe, { created: 25 * HOUR, used: null });
    await age(idleMe, { created: 200 * DAY, used: 91 * DAY });
    await age(usedRecently, { created: 200 * DAY, used: 2 * DAY });

    const before = new Date();
    const result = await runOAuthTokenCleanup();
    expect(result.revoked).toBeGreaterThanOrEqual(4);
    expect(await revokedOf([neverUsedMe, neverUsedAgent, idleMe, idleAgent])).toEqual({
      [neverUsedMe]: true, [neverUsedAgent]: true, [idleMe]: true, [idleAgent]: true,
    });
    expect(await revokedOf([freshUnused, usedRecently, usedLongAgo, handMade, myAgentCard, teamBot, agentRun])).toEqual({
      [freshUnused]: false, [usedRecently]: false, [usedLongAgo]: false,
      [handMade]: false, [myAgentCard]: false, [teamBot]: false, [agentRun]: false,
    });
    for (const raw of [neverUsedMe, neverUsedAgent, idleMe, idleAgent]) expect(await tokenWorks(raw)).toBe(false);
    // The team bot is in no project, so it cannot open the task either way: its row says it is live.
    for (const raw of [freshUnused, usedRecently, usedLongAgo, handMade, myAgentCard, agentRun]) expect(await tokenWorks(raw)).toBe(true);

    // One activity entry per token, on the agent or the person, by the system.
    const entries = await db.select().from(schema.activityLog)
      .where(sql`${schema.activityLog.action} = 'token_revoked' and ${schema.activityLog.actorType} = 'system' and ${schema.activityLog.createdAt} >= ${before.toISOString()}`);
    const byToken = new Map(entries.map((e) => [(e.diff as { tokenId: string }).tokenId, e]));
    expect(byToken.get((await rowOf(neverUsedMe)).id)).toMatchObject({ entityType: 'user', entityId: users.owner!.userId, diff: { client: 'Claude Code', reason: 'never_used', oauth: true } });
    expect(byToken.get((await rowOf(neverUsedAgent)).id)).toMatchObject({ entityType: 'agent', entityId: agentId, diff: { client: 'Claude Code', reason: 'never_used' } });
    expect(byToken.get((await rowOf(idleMe)).id)).toMatchObject({ entityType: 'user', diff: { reason: 'idle' } });
    expect(byToken.get((await rowOf(idleAgent)).id)).toMatchObject({ entityType: 'agent', diff: { reason: 'idle' } });
    for (const raw of [freshUnused, usedRecently, usedLongAgo]) expect(byToken.has((await rowOf(raw)).id)).toBe(false);

    // Running it again finds nothing more to do.
    const entriesBefore = entries.length;
    await runOAuthTokenCleanup();
    const after = await db.select().from(schema.activityLog)
      .where(sql`${schema.activityLog.action} = 'token_revoked' and ${schema.activityLog.actorType} = 'system' and ${schema.activityLog.createdAt} >= ${before.toISOString()}`);
    expect(after.length).toBe(entriesBefore);
  });

  it('a client that only connects and lists its tools has used its sign-in', async () => {
    const raw = await connect(users.owner!.cookie, await registerClient('Claude Code'), 'me');
    await age(raw, { created: 25 * HOUR, used: null });
    // The MCP endpoint checks the token before it needs the node server.
    const res = await app.request('/api/v1/mcp', {
      method: 'POST', headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(501);
    // The touch is fire-and-forget: wait for it to land.
    for (let i = 0; i < 50 && !(await rowOf(raw)).lastUsedAt; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await rowOf(raw)).lastUsedAt).not.toBeNull();
    await runOAuthTokenCleanup();
    expect(await tokenWorks(raw)).toBe(true);
  });

  it('the panel groups sign-ins by client', async () => {
    const clientId = await registerClient('Grouped client');
    await connect(users.manager!.cookie, clientId, 'me');
    await connect(users.manager!.cookie, await registerClient('Grouped client'), 'me');
    const handMade = await json(reqAs(users.manager!.cookie).post('/auth/tokens', { name: 'Grouped client (OAuth)', scopes: ['projects.read'], readOnly: true }));
    const list = (await json(reqAs(users.manager!.cookie).get('/auth/tokens'))).data as { id: string; name: string; client: string | null }[];
    expect(list.filter((t) => t.client === 'Grouped client')).toHaveLength(2);
    expect(list.find((t) => t.id === handMade.id)!.client).toBeNull();
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

  it('two sign-ins of the same client at once both get a working token', async () => {
    const { db } = getDb();
    for (const actAs of ['me', 'agent'] as const) {
      const a = await registerClient(`Twin ${actAs}`);
      const b = await registerClient(`Twin ${actAs}`);
      const [ca, cb] = [await approved(users.owner!.cookie, a, actAs), await approved(users.owner!.cookie, b, actAs)];
      const results = await Promise.all([exchange(a, ca.code, ca.verifier), exchange(b, cb.code, cb.verifier)]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      const rows = await db.select().from(schema.apiTokens).innerJoin(schema.oauthClients, eq(schema.oauthClients.id, schema.apiTokens.oauthClientId))
        .where(eq(schema.oauthClients.name, `Twin ${actAs}`));
      expect(rows.filter((r) => !r.api_tokens.revokedAt)).toHaveLength(2);
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

  it('a person who leaves and comes back within a code\'s lifetime finds their pending sign-in gone', async () => {
    const clientId = await registerClient('Claude Code');
    const pending = await approved(users.hr!.cookie, clientId, 'me');
    expect((await owner().post(`/users/${users.hr!.userId}/deactivate`, { reassignTo: users.manager!.userId })).status).toBe(200);
    expect((await owner().post(`/users/${users.hr!.userId}/reactivate`)).status).toBe(200);
    expect((await exchange(clientId, pending.code, pending.verifier)).status).toBe(400);
  });
});

describe('what the client gets', () => {
  it('the agent\'s token comes with its lifetime and is held to what a personal agent may do', async () => {
    const clientId = await registerClient('Claude Code');
    const { res, verifier } = await approve(users.owner!.cookie, clientId, 'agent');
    const code = new URL(((await res.json()) as { redirectTo: string }).redirectTo).searchParams.get('code')!;
    const grant = (await (await exchange(clientId, code, verifier)).json()) as { access_token: string; token_type: string; expires_in: number };
    expect(grant).toMatchObject({ token_type: 'bearer', expires_in: 90 * 86_400 });
    // Its owner may do these; the agent may not.
    expect((await bearer(grant.access_token).get('/invoices')).status).toBe(403);
    expect((await bearer(grant.access_token).get('/users')).status).toBe(403);
    expect(await tokenWorks(grant.access_token)).toBe(true);
  });

  it('a client registering with a blank name is still named', async () => {
    const res = await app.request('/api/v1/oauth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.9.1.1' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: '  ' }),
    });
    const body = (await res.json()) as { client_id: string; client_name: string };
    expect(body.client_name).toBe('MCP client');
    const raw = await connect(users.owner!.cookie, body.client_id, 'agent');
    expect(await commentAuthor(raw, 'Unnamed client at work.')).toEqual({ authorId: agentId, via: 'MCP client' });
  });
});
