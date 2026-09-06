/**
 * The workspace connector library (plan 2026-09-05-001, R17-R24, R38, R39,
 * R42, R45): library and custom connectors, secrets masked, the test call
 * against a real local MCP server with a bearer, and the OAuth 2.1 client
 * flow ordi runs itself – discovery, dynamic registration, consent url,
 * code exchange, refresh, and needs_auth when the upstream stops accepting.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { startTestMcpServer, type TestMcpServer, type Users } from './agents-helpers';
import { decrypt } from '../lib/crypto';
import { hasOAuthTokens } from '../domains/agents/connector-oauth';

let users: Users;
const servers: TestMcpServer[] = [];

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
});

afterAll(async () => { await Promise.all(servers.map((s) => s.close())); });

describe('connector library', () => {
  it('lists the catalogue and creates a library connector from it, rendering the secret into a header', async () => {
    const owner = reqAs(users.owner!.cookie);
    const library = (await json(owner.get('/mcp-connectors/library'))).data as { key: string }[];
    expect(library.map((e) => e.key)).toContain('github');

    expect((await owner.post('/mcp-connectors/library', { libraryKey: 'github', secrets: {} })).status).toBe(400);
    const created = await json(owner.post('/mcp-connectors/library', { libraryKey: 'github', secrets: { Authorization: 'ghp_secret_token_value' } }));
    expect(created.slug).toBe('github');
    expect(created.authMode).toBe('headers');
    expect(created.secretKeys).toEqual(['Authorization']);
    expect(JSON.stringify(created)).not.toContain('ghp_secret');
    const { db } = getDb();
    const [row] = await db.select().from(schema.mcpConnectors).where(eq(schema.mcpConnectors.id, created.id));
    expect(row!.secrets).not.toContain('ghp_secret');
    expect(JSON.parse(decrypt(row!.secrets!))).toEqual({ headers: { Authorization: 'Bearer ghp_secret_token_value' } });

    const second = await json(owner.post('/mcp-connectors/library', { libraryKey: 'github', secrets: { Authorization: 'other' } }));
    expect(second.slug).toBe('github-2');
  });

  it('an OAuth library entry starts in needs_auth; a stdio entry keeps its pinned command', async () => {
    const owner = reqAs(users.owner!.cookie);
    const notion = await json(owner.post('/mcp-connectors/library', { libraryKey: 'notion', secrets: {} }));
    expect(notion.status).toBe('needs_auth');
    expect(notion.oauth).toEqual({ authorized: false, authorizedBy: null, authorizedAt: null, pending: false });
    const pw = await json(owner.post('/mcp-connectors/library', { libraryKey: 'playwright', secrets: {} }));
    expect(pw.transport).toBe('stdio');
    expect(pw.command).toBe('npx');
    expect(pw.args[1]).toMatch(/^@playwright\/mcp@/);
  });

  it('custom connectors need https and never accept stdio; the slug "ordi" is reserved', async () => {
    const owner = reqAs(users.owner!.cookie);
    expect((await owner.post('/mcp-connectors/custom', { name: 'Plain', url: 'http://mcp.example.com/mcp' })).status).toBe(400);
    expect((await owner.post('/mcp-connectors/custom', { name: 'Shell', url: 'https://x.example.com', transport: 'stdio' })).status).toBe(400);
    expect((await owner.post('/mcp-connectors/custom', { name: 'ordi', url: 'https://x.example.com/mcp' })).status).toBe(400);
    const created = await json(owner.post('/mcp-connectors/custom', { name: 'Docs MCP', url: 'https://docs.example.com/mcp', authMode: 'bearer', bearer: 'tok-1234567890' }));
    expect(created.slug).toBe('docs-mcp');
    expect(created.secretKeys).toEqual(['Authorization']);
  });

  it('is gated by integrations.manage', async () => {
    const member = reqAs(users.member!.cookie);
    expect((await member.get('/mcp-connectors')).status).toBe(403);
    expect((await member.post('/mcp-connectors/custom', { name: 'x', url: 'https://x.example.com/mcp' })).status).toBe(403);
  });

  it('test performs initialize + tools/list with the stored bearer and caches the tools', async () => {
    const owner = reqAs(users.owner!.cookie);
    const upstream = await startTestMcpServer({ bearer: 'up-secret-token-1' });
    servers.push(upstream);
    const created = await json(owner.post('/mcp-connectors/custom', { name: 'Upstream', url: upstream.url, authMode: 'bearer', bearer: 'up-secret-token-1' }));
    const res = await json(owner.post(`/mcp-connectors/${created.id}/test`));
    expect(res.ok).toBe(true);
    expect(res.tools.map((t: { name: string }) => t.name).sort()).toEqual(['boom', 'echo']);
    expect(upstream.calls.every((c) => c.auth === 'Bearer up-secret-token-1')).toBe(true);
    const view = await json(owner.get(`/mcp-connectors/${created.id}`));
    expect(view.toolCount).toBe(2);
    expect(view.lastTestedAt).not.toBeNull();
    expect(view.status).toBe('active');

    // A wrong secret is reported, not thrown, and the connector stays active for a static bearer.
    const wrong = await json(owner.post('/mcp-connectors/custom', { name: 'Wrong', url: upstream.url, authMode: 'bearer', bearer: 'nope-nope-nope' }));
    const bad = await json(owner.post(`/mcp-connectors/${wrong.id}/test`));
    expect(bad.ok).toBe(false);
  });

  it('rotates secrets, disables, and deletes with version checks', async () => {
    const owner = reqAs(users.owner!.cookie);
    const created = await json(owner.post('/mcp-connectors/custom', { name: 'Rotate', url: 'https://r.example.com/mcp', authMode: 'bearer', bearer: 'first-token-value' }));
    const rotated = await json(owner.patch(`/mcp-connectors/${created.id}`, { version: created.version, bearer: 'second-token-value' }));
    const { db } = getDb();
    const [row] = await db.select().from(schema.mcpConnectors).where(eq(schema.mcpConnectors.id, created.id));
    expect(JSON.parse(decrypt(row!.secrets!)).headers.Authorization).toBe('Bearer second-token-value');
    expect((await owner.patch(`/mcp-connectors/${created.id}`, { version: created.version, name: 'stale' })).status).toBe(409);
    const off = await json(owner.patch(`/mcp-connectors/${created.id}`, { version: rotated.version, enabled: false }));
    expect(off.status).toBe('disabled');
    expect((await owner.del(`/mcp-connectors/${created.id}`)).status).toBe(200);
    expect((await owner.get(`/mcp-connectors/${created.id}`)).status).toBe(404);
  });
});

describe('connector OAuth', () => {
  it('discovers, registers, hands back a consent url, exchanges the code and records who authorized', async () => {
    const owner = reqAs(users.owner!.cookie);
    const upstream = await startTestMcpServer({ oauth: true, refresh: true });
    servers.push(upstream);
    const created = await json(owner.post('/mcp-connectors/custom', { name: 'OAuth MCP', url: upstream.url, authMode: 'oauth' }));
    expect(created.status).toBe('needs_auth');

    // Before consent the test call reports needs_auth instead of failing hard.
    const probe = await json(owner.post(`/mcp-connectors/${created.id}/test`));
    expect(probe.needsAuth).toBe(true);

    const start = await json(owner.post(`/mcp-connectors/${created.id}/oauth/start`));
    const consent = new URL(start.authorizationUrl);
    expect(consent.origin).toBe(upstream.origin);
    expect(consent.pathname).toBe('/authorize');
    expect(consent.searchParams.get('client_id')).toBe('test-client');
    expect(consent.searchParams.get('code_challenge_method')).toBe('S256');
    expect(consent.searchParams.get('redirect_uri')).toMatch(/\/api\/v1\/mcp-connectors\/oauth\/callback$/);
    const state = consent.searchParams.get('state')!;
    expect(upstream.calls.some((c) => c.path === '/register')).toBe(true);
    const pendingView = await json(owner.get(`/mcp-connectors/${created.id}`));
    expect(pendingView.oauth.pending).toBe(true);

    // The provider would redirect the browser with a code; our test server accepts any code it "issued".
    const code = 'code-abc';
    (upstream as unknown as { calls: unknown[] }).calls.length = 0;
    upstream.seedCode(code);
    const cb = await owner.get(`/mcp-connectors/oauth/callback?code=${code}&state=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toContain('oauth=connected');
    expect(upstream.calls.some((c) => c.path === '/token')).toBe(true);

    const view = await json(owner.get(`/mcp-connectors/${created.id}`));
    expect(view.status).toBe('active');
    expect(view.oauth).toMatchObject({ authorized: true, authorizedBy: users.owner!.userId, pending: false });
    const { db } = getDb();
    const [oauthRow] = await db.select().from(schema.mcpConnectorOauth).where(eq(schema.mcpConnectorOauth.connectorId, created.id));
    expect(hasOAuthTokens(oauthRow!)).toBe(true);
    expect(oauthRow!.tokens).not.toContain(upstream.issued[0]);

    // Tokens work against the upstream through the normal client path.
    const tested = await json(owner.post(`/mcp-connectors/${created.id}/test`));
    expect(tested.ok).toBe(true);
    expect(tested.tools.length).toBe(2);

    // The access token is rejected upstream: the client refreshes transparently.
    upstream.rejectAccess(upstream.issued[0]!);
    const refreshed = await json(owner.post(`/mcp-connectors/${created.id}/test`));
    expect(refreshed.ok).toBe(true);
    expect(upstream.issued.length).toBe(2);

    // Revoking forgets the tokens and the connector asks for authorization again.
    expect((await owner.post(`/mcp-connectors/${created.id}/oauth/revoke`)).status).toBe(200);
    const revoked = await json(owner.get(`/mcp-connectors/${created.id}`));
    expect(revoked.status).toBe('needs_auth');
    expect(revoked.oauth.authorized).toBe(false);
  });

  it('an unknown state on the callback is refused', async () => {
    const owner = reqAs(users.owner!.cookie);
    const cb = await owner.get('/mcp-connectors/oauth/callback?code=x&state=does-not-exist');
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toContain('oauth=error');
  });
});
