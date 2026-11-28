/**
 * Profile → MCP & API lists, in one place, every client that can act for a
 * person: clients connected as them (signed in through the browser, or given
 * a token by hand when they have no browser) and their own agent's clients.
 * Each person sees only their own and their own agent's – never anyone
 * else's – and tokens for scripts stay apart from the connections.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json, app } from './helpers';
import { sha256 } from '../lib/crypto';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
const owner = () => reqAs(users.owner!.cookie);
const member = () => reqAs(users.member!.cookie);

const bearer = (raw: string) => ({
  get: (path: string) => app.request(`/api/v1${path}`, { headers: { authorization: `Bearer ${raw}` } }),
  post: (path: string, body: unknown) => app.request(`/api/v1${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  }),
});

interface TokenRow { id: string; name: string; client: string | null; oauth: boolean; expiresAt: string | null; revokedAt: string | null }
const myTokens = async (who: ReturnType<typeof reqAs>): Promise<TokenRow[]> => (await json(who.get('/auth/tokens'))).data;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
});

describe('a client connected as you with a token', () => {
  it('is listed as a connection named after the client, with its expiry', async () => {
    const res = await owner().post('/auth/tokens/client', { client: 'Cursor', expiresInDays: 30 });
    expect(res.status).toBe(201);
    const { id, token, expiresAt } = await json(res);
    expect(token).toMatch(/^ordi_/);
    const days = (new Date(expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);

    const row = (await myTokens(owner())).find((t) => t.id === id);
    expect(row).toMatchObject({ name: 'Cursor', client: 'Cursor', oauth: false, revokedAt: null });
    expect(row?.expiresAt).toBe(expiresAt);
  });

  it('acts as you, with what you may do', async () => {
    const { token } = await json(owner().post('/auth/tokens/client', { client: 'Zed', expiresInDays: null }));
    const me = await json(bearer(token).get('/me'));
    expect(me.id ?? me.user?.id).toBe(users.owner!.userId);
    const row = (await myTokens(owner())).find((t) => t.name === 'Zed');
    expect(row?.expiresAt).toBeNull();
  });

  it('stops working once it expires', async () => {
    const { id, token } = await json(owner().post('/auth/tokens/client', { client: 'Old laptop', expiresInDays: 30 }));
    expect((await bearer(token).get('/me')).status).toBe(200);
    await getDb().db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiTokens.id, id));
    expect((await bearer(token).get('/me')).status).toBe(401);
  });

  it('cannot be made with a token, only from a signed-in session', async () => {
    const { token } = await json(owner().post('/auth/tokens/client', { client: 'Codex CLI', expiresInDays: 30 }));
    expect((await bearer(token).post('/auth/tokens/client', { client: 'Sneaky', expiresInDays: null })).status).toBe(403);
  });

  it('needs a client name', async () => {
    expect((await owner().post('/auth/tokens/client', { client: '  ', expiresInDays: 30 })).status).toBe(400);
  });
});

describe('who sees which connections', () => {
  let ownerClientTokenId: string;

  beforeAll(async () => {
    ownerClientTokenId = (await json(owner().post('/auth/tokens/client', { client: 'Claude Code', expiresInDays: 90 }))).id;
    // A sign-in "as me" through the browser, made the way the token endpoint makes it.
    const { db } = getDb();
    await db.insert(schema.oauthClients).values({ id: 'oc_chatgpt', name: 'ChatGPT' });
    await db.insert(schema.apiTokens).values({
      id: ulid(), userId: users.owner!.userId, name: 'ChatGPT (OAuth)', hash: sha256(`oauth-${ulid()}`),
      prefix: 'ordi_oauthxx', scopes: [], oauthClientId: 'oc_chatgpt',
    });
    expect((await owner().post('/my-agent', { name: 'Jarvis' })).status).toBe(201);
    expect((await owner().post('/my-agent/tokens', { client: 'Codex', expiresInDays: 30 })).status).toBe(201);
    expect((await member().post('/my-agent', { name: 'Robin' })).status).toBe(201);
    expect((await member().post('/my-agent/tokens', { client: 'Cursor', expiresInDays: 30 })).status).toBe(201);
    expect((await owner().post('/auth/tokens', { name: 'CI deploy', scopes: ['projects.read'], readOnly: true })).status).toBe(201);
  });

  it('a sign-in is a connection, a token for scripts is not', async () => {
    const rows = await myTokens(owner());
    expect(rows.find((t) => t.name === 'ChatGPT (OAuth)')).toMatchObject({ client: 'ChatGPT', oauth: true });
    expect(rows.find((t) => t.name === 'CI deploy')).toMatchObject({ client: null, oauth: false });
  });

  it('your own list holds only your tokens: not your agent’s, not anyone else’s', async () => {
    const ownerRows = await myTokens(owner());
    expect(ownerRows.map((t) => t.name)).not.toContain('Codex');
    const memberRows = await myTokens(member());
    expect(memberRows.map((t) => t.id)).not.toContain(ownerClientTokenId);
    expect(memberRows.some((t) => ['Claude Code', 'ChatGPT (OAuth)', 'CI deploy'].includes(t.name))).toBe(false);
  });

  it('your agent’s clients come only from your own agent', async () => {
    const mine = (await json(owner().get('/my-agent'))).agent;
    expect(mine.name).toBe('Jarvis');
    expect(mine.tokens.map((t: { name: string }) => t.name)).toEqual(['Codex']);
    const theirs = (await json(member().get('/my-agent'))).agent;
    expect(theirs.tokens.map((t: { name: string }) => t.name)).toEqual(['Cursor']);
  });

  it('someone else cannot disconnect your client', async () => {
    expect((await member().del(`/auth/tokens/${ownerClientTokenId}`)).status).toBe(200);
    expect((await myTokens(owner())).find((t) => t.id === ownerClientTokenId)?.revokedAt).toBeNull();
    const [ownerAgentToken] = (await json(owner().get('/my-agent'))).agent.tokens;
    expect((await member().del(`/my-agent/tokens/${ownerAgentToken.id}`)).status).toBeGreaterThanOrEqual(400);
    expect((await json(owner().get('/my-agent'))).agent.tokens).toHaveLength(1);
  });

  it('you can disconnect your own', async () => {
    expect((await owner().del(`/auth/tokens/${ownerClientTokenId}`)).status).toBe(200);
    expect((await myTokens(owner())).find((t) => t.id === ownerClientTokenId)?.revokedAt).not.toBeNull();
  });
});
