/**
 * Connector gateway (plan 2026-09-05-001, R40-R41, KTD9). Every connector an
 * agent may use is reached through `POST /mcp-connectors/:slug/mcp`: a
 * stateless Streamable HTTP MCP server that authenticates the per-run token,
 * checks the agent's allowlist and the connector state, and bridges
 * tools/list and tools/call to the upstream client. Upstream secrets and
 * OAuth tokens never leave this process; a stdio connector is spawned here
 * for the life of the run.
 */
import { Hono } from 'hono';
import { getDb, schema, eq, and, inArray } from '@ordi/db';
import { AGENT_RUN_ACTIVE_STATUSES } from '@ordi/shared';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { AppEnv } from '../../context';
import { sha256 } from '../../lib/crypto';
import { logger } from '../../lib/logger';
import {
  ConnectorNeedsAuthError, loadConnectorBySlug, markNeedsAuth, openUpstream, type ConnectorRow, type UpstreamClient,
} from './connectors';
import { recordRunEvent } from './run-events';

const { apiTokens, agentRuns, agentConnectors } = schema;

interface RunContext {
  runId: string;
  agentUserId: string;
}

/** The per-run token identifies the run; anything else is refused. */
async function resolveRun(bearer: string): Promise<RunContext | null> {
  const { db } = getDb();
  const [token] = await db.select({ id: apiTokens.id, revokedAt: apiTokens.revokedAt }).from(apiTokens).where(eq(apiTokens.hash, sha256(bearer)));
  if (!token || token.revokedAt) return null;
  const [run] = await db.select({ id: agentRuns.id, agentUserId: agentRuns.agentUserId, status: agentRuns.status })
    .from(agentRuns).where(eq(agentRuns.tokenId, token.id));
  if (!run || !(AGENT_RUN_ACTIVE_STATUSES as readonly string[]).includes(run.status)) return null;
  return { runId: run.id, agentUserId: run.agentUserId };
}

async function allowed(agentUserId: string, connectorId: string): Promise<boolean> {
  const { db } = getDb();
  const [row] = await db.select({ connectorId: agentConnectors.connectorId }).from(agentConnectors)
    .where(and(eq(agentConnectors.agentUserId, agentUserId), inArray(agentConnectors.connectorId, [connectorId])));
  return Boolean(row);
}

// ── Upstream pool: one client per (run, connector), closed when the run ends ──

interface Pooled { client: UpstreamClient; lastUsed: number; connectorId: string }
const pool = new Map<string, Pooled>();
const IDLE_MS = 10 * 60_000;
let reaper: NodeJS.Timeout | null = null;

function poolKey(runId: string, connectorId: string): string {
  return `${runId}:${connectorId}`;
}

async function upstreamFor(run: RunContext, connector: ConnectorRow): Promise<UpstreamClient> {
  const key = poolKey(run.runId, connector.id);
  const existing = pool.get(key);
  if (existing) { existing.lastUsed = Date.now(); return existing.client; }
  const client = await openUpstream(connector);
  pool.set(key, { client, lastUsed: Date.now(), connectorId: connector.id });
  if (!reaper) {
    reaper = setInterval(() => {
      const cutoff = Date.now() - IDLE_MS;
      for (const [k, p] of pool) if (p.lastUsed < cutoff) { pool.delete(k); void p.client.close(); }
      if (pool.size === 0 && reaper) { clearInterval(reaper); reaper = null; }
    }, 60_000);
    reaper.unref?.();
  }
  return client;
}

async function dropUpstream(run: RunContext, connectorId: string): Promise<void> {
  const key = poolKey(run.runId, connectorId);
  const p = pool.get(key);
  if (!p) return;
  pool.delete(key);
  await p.client.close();
}

/** Called by the worker when a run finishes: closes stdio processes and HTTP clients. */
export async function closeRunConnections(runId: string): Promise<void> {
  const prefix = `${runId}:`;
  for (const [k, p] of [...pool]) {
    if (!k.startsWith(prefix)) continue;
    pool.delete(k);
    await p.client.close().catch(() => {});
  }
}

/** Test seam. */
export function pooledConnectionCount(): number {
  return pool.size;
}

function bridgeServer(run: RunContext, connector: ConnectorRow): Server {
  const server = new Server({ name: `ordi-connector-${connector.slug}`, version: '1.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const upstream = await upstreamFor(run, connector);
      const { tools } = await upstream.listTools();
      return { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: (t.inputSchema as { type: 'object' }) ?? { type: 'object' } })) };
    } catch (e) {
      throw await translate(run, connector, e);
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const startedAt = Date.now();
    const name = request.params.name;
    try {
      const upstream = await upstreamFor(run, connector);
      const result = await upstream.callTool({ name, arguments: (request.params.arguments ?? {}) as Record<string, unknown> });
      const isError = Boolean((result as { isError?: boolean })?.isError);
      await recordRunEvent(run.runId, 'connector_call', { connector: connector.slug, tool: name, ms: Date.now() - startedAt, ok: !isError });
      return result as Record<string, unknown>;
    } catch (e) {
      await recordRunEvent(run.runId, 'connector_call', { connector: connector.slug, tool: name, ms: Date.now() - startedAt, ok: false, error: (e as Error).message?.slice(0, 300) });
      throw await translate(run, connector, e);
    }
  });

  return server;
}

/** Turn upstream failures into JSON-RPC errors the model can read; flip needs_auth (R39). */
async function translate(run: RunContext, connector: ConnectorRow, e: unknown): Promise<McpError> {
  if (e instanceof McpError) return e;
  if (e instanceof ConnectorNeedsAuthError) {
    await markNeedsAuth(connector.id, 'Authorization expired; an admin must re-authorize the connector');
    await dropUpstream(run, connector.id);
    return new McpError(ErrorCode.InvalidRequest, `Connector "${connector.slug}" needs re-authorization by an admin; it is unavailable for the rest of this run.`);
  }
  await dropUpstream(run, connector.id).catch(() => {});
  logger.warn({ connector: connector.slug, run: run.runId, err: (e as Error).message }, 'connector upstream failed');
  return new McpError(ErrorCode.InternalError, `Connector "${connector.slug}" failed: ${(e as Error).message}`);
}

export function gatewayRoutes() {
  const app = new Hono<AppEnv>();

  app.post('/:slug/mcp', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return c.json({ error: 'unauthorized' }, 401);
    const run = await resolveRun(auth.slice(7).trim());
    if (!run) return c.json({ error: 'unauthorized', error_description: 'Not an active run token' }, 401);

    const connector = await loadConnectorBySlug(c.req.param('slug'));
    if (!connector || !(await allowed(run.agentUserId, connector.id))) {
      return c.json({ error: 'forbidden', error_description: 'This agent may not use that connector' }, 403);
    }
    if (connector.status !== 'active') {
      return c.json({ error: 'unavailable', error_description: `Connector is ${connector.status}` }, 409);
    }

    const server = bridgeServer(run, connector);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      // The bridge is per request; the upstream client lives on in the pool.
      void transport.close();
      void server.close();
    }
  });

  app.get('/:slug/mcp', (c) => c.json({ error: 'method_not_allowed' }, 405));
  app.delete('/:slug/mcp', (c) => c.json({ error: 'method_not_allowed' }, 405));

  return app;
}
