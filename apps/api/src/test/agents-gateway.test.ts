/**
 * The connector gateway (plan 2026-09-05-001, R22-R24, R40, R41): a run
 * token reaches an allowed connector and only that one, tools/list and
 * tools/call are bridged to the upstream, every call is logged as a run
 * event without secrets, a disabled connector answers 409, an upstream that
 * stops accepting the token flips the connector to needs_auth, and stdio
 * library connectors are bridged the same way.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getDb, schema, eq } from '@ordi/db';
import { app, resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { setupWorkspace, createAgent, addProjectMember, startTestMcpServer, eventsForRun, type TestMcpServer, type Workspace } from './agents-helpers';
import { queueRun, startRun, claimRuns } from '../domains/agents/runs';
import { closeRunConnections, pooledConnectionCount } from '../domains/agents/gateway';
import { setUpstreamOpener, ConnectorNeedsAuthError } from '../domains/agents/connectors';
import { registerRunSecrets } from '../domains/agents/run-events';

let ws: Workspace;
let upstream: TestMcpServer;
let agentId: string;
let runId: string;
let token: string;
let allowedId: string;
let deniedId: string;

/** An MCP client that talks to the gateway through app.request(), so no port is needed. */
async function gatewayClient(slug: string, bearer: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`http://ordi.test/api/v1/mcp-connectors/${slug}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => app.request(input instanceof Request ? input : String(input), init)) as unknown as typeof fetch,
  });
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  await resetDb();
  const users = await seedRolesAndUsers();
  ws = await setupWorkspace(users, 'GWY');
  upstream = await startTestMcpServer({ bearer: 'upstream-secret-abc' });
  const owner = reqAs(users.owner!.cookie);
  const allowed = await json(owner.post('/mcp-connectors/custom', { name: 'Allowed', url: upstream.url, authMode: 'bearer', bearer: 'upstream-secret-abc' }));
  const denied = await json(owner.post('/mcp-connectors/custom', { name: 'Denied', url: upstream.url, authMode: 'bearer', bearer: 'upstream-secret-abc' }));
  allowedId = allowed.id; deniedId = denied.id;
  const agent = await createAgent(users, { name: 'Gate', connectorIds: [allowed.id] });
  agentId = agent.id;
  await addProjectMember(users, ws.projectId, agent.id);
  runId = (await queueRun({ agentUserId: agent.id, taskId: ws.taskId, projectId: ws.projectId, trigger: 'manual', requestedBy: users.owner!.userId }))!;
  await claimRuns('gateway-test', 1);
  const started = await startRun(runId);
  token = started!.token;
  registerRunSecrets(runId, ['upstream-secret-abc', token]);
});

afterEach(() => setUpstreamOpener(null));
afterAll(async () => { await closeRunConnections(runId); await upstream.close(); });

describe('gateway', () => {
  it('refuses anything but an active run token', async () => {
    const noAuth = await app.request('/api/v1/mcp-connectors/allowed/mcp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(noAuth.status).toBe(401);
    const session = await app.request('/api/v1/mcp-connectors/allowed/mcp', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${ws.users.owner!.token}` }, body: '{}' });
    expect(session.status).toBe(401);
  });

  it('bridges tools/list and tools/call for an allowed connector and logs the call', async () => {
    const client = await gatewayClient('allowed', token);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['boom', 'echo']);
    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect((result.content as { text: string }[])[0]!.text).toBe('echo:hi');
    const failed = await client.callTool({ name: 'boom', arguments: {} });
    expect(failed.isError).toBe(true);
    await client.close();

    const events = await eventsForRun(runId);
    const calls = events.filter((e) => e.type === 'connector_call').map((e) => e.payload as { connector: string; tool: string; ok: boolean });
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ connector: 'allowed', tool: 'echo', ok: true }),
      expect.objectContaining({ connector: 'allowed', tool: 'boom', ok: false }),
    ]));
    expect(JSON.stringify(events)).not.toContain('upstream-secret-abc');
    // The upstream saw the real bearer; the agent never did.
    expect(upstream.calls.some((c) => c.path === '/mcp' && c.auth === 'Bearer upstream-secret-abc')).toBe(true);
    expect(pooledConnectionCount()).toBeGreaterThan(0);
  });

  it('refuses a connector outside the allowlist and an unknown slug', async () => {
    const denied = await app.request('/api/v1/mcp-connectors/denied/mcp', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' });
    expect(denied.status).toBe(403);
    const unknown = await app.request('/api/v1/mcp-connectors/nope/mcp', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' });
    expect(unknown.status).toBe(403);
    expect(deniedId).toBeTruthy();
  });

  it('answers 409 for a disabled connector', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const view = await json(owner.get(`/mcp-connectors/${allowedId}`));
    await json(owner.patch(`/mcp-connectors/${allowedId}`, { version: view.version, enabled: false }));
    const res = await app.request('/api/v1/mcp-connectors/allowed/mcp', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' });
    expect(res.status).toBe(409);
    const again = await json(owner.get(`/mcp-connectors/${allowedId}`));
    await json(owner.patch(`/mcp-connectors/${allowedId}`, { version: again.version, enabled: true }));
  });

  it('an upstream that needs authorization flips the connector to needs_auth and tells the model', async () => {
    await closeRunConnections(runId);
    setUpstreamOpener(async (connector) => { throw new ConnectorNeedsAuthError(connector.id); });
    const client = await gatewayClient('allowed', token);
    await expect(client.listTools()).rejects.toThrow(/re-authorization/);
    await client.close();
    const { db } = getDb();
    const [row] = await db.select().from(schema.mcpConnectors).where(eq(schema.mcpConnectors.id, allowedId));
    expect(row!.status).toBe('needs_auth');
    await db.update(schema.mcpConnectors).set({ status: 'active' }).where(eq(schema.mcpConnectors.id, allowedId));
  });

  it('bridges a stdio library connector through the same door', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    // A stdio connector whose "command" is stubbed: the opener seam stands in for spawning.
    const created = await json(owner.post('/mcp-connectors/library', { libraryKey: 'playwright', secrets: {} }));
    const agentView = await json(owner.get(`/agents/${agentId}`));
    await json(owner.patch(`/agents/${agentId}`, { version: agentView.version, connectorIds: [allowedId, created.id] }));
    let opened = 0;
    let closed = 0;
    setUpstreamOpener(async (connector) => {
      expect(connector.transport).toBe('stdio');
      opened++;
      return {
        listTools: async () => ({ tools: [{ name: 'browser_navigate', description: 'Go to a url' }] }),
        callTool: async ({ name }) => ({ content: [{ type: 'text', text: `ran ${name}` }] }),
        close: async () => { closed++; },
      };
    });
    const client = await gatewayClient('playwright', token);
    expect((await client.listTools()).tools[0]!.name).toBe('browser_navigate');
    const res = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } });
    expect((res.content as { text: string }[])[0]!.text).toBe('ran browser_navigate');
    await client.close();
    // One upstream process for the run, closed when the run's connections are dropped.
    expect(opened).toBe(1);
    await closeRunConnections(runId);
    expect(closed).toBe(1);
  });

  it('a revoked run token is refused', async () => {
    const { db } = getDb();
    const [run] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runId));
    await db.update(schema.apiTokens).set({ revokedAt: new Date() }).where(eq(schema.apiTokens.id, run!.tokenId!));
    const res = await app.request('/api/v1/mcp-connectors/allowed/mcp', { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' });
    expect(res.status).toBe(401);
  });
});
