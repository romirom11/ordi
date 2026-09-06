/**
 * Workspace MCP connector library (plan 2026-09-05-001, R17-R24). A connector
 * comes from the curated catalogue or is added by URL; its secrets live here
 * AES-GCM encrypted and are decrypted only to open an upstream client for the
 * gateway or a test. Agents never see a url, header, command or env.
 */
import { getDb, schema, eq, and, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { findMcpLibraryEntry, type CustomMcpConnectorInput, type LibraryMcpConnectorInput } from '@ordi/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { encrypt, decrypt } from '../../lib/crypto';
import { writeActivity } from '../../core/activity';
import { assertVersion } from '../../core/locking';
import { logger } from '../../lib/logger';
import { ConnectorOAuthProvider, hasOAuthTokens, storePreregisteredClient } from './connector-oauth';

const { mcpConnectors, mcpConnectorOauth, agentConnectors } = schema;

export type ConnectorRow = typeof mcpConnectors.$inferSelect;

export interface ConnectorSecrets {
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface ConnectorView {
  id: string;
  slug: string;
  name: string;
  source: string;
  libraryKey: string | null;
  transport: string;
  url: string | null;
  command: string | null;
  args: string[];
  authMode: string;
  status: string;
  tools: { name: string; description?: string }[];
  toolCount: number;
  lastTestedAt: string | null;
  lastError: string | null;
  /** Which secret keys are stored (never their values). */
  secretKeys: string[];
  oauth: { authorized: boolean; authorizedBy: string | null; authorizedAt: string | null; pending: boolean } | null;
  agentCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export function readSecrets(row: Pick<ConnectorRow, 'secrets'>): ConnectorSecrets {
  if (!row.secrets) return {};
  try { return JSON.parse(decrypt(row.secrets)) as ConnectorSecrets; } catch { return {}; }
}

function writeSecrets(secrets: ConnectorSecrets): string | null {
  const clean: ConnectorSecrets = {};
  if (secrets.headers && Object.keys(secrets.headers).length) clean.headers = secrets.headers;
  if (secrets.env && Object.keys(secrets.env).length) clean.env = secrets.env;
  return Object.keys(clean).length ? encrypt(JSON.stringify(clean)) : null;
}

/** Every secret value stored for a connector – the worker scrubs these from logs. */
export function secretValues(row: Pick<ConnectorRow, 'secrets'>): string[] {
  const s = readSecrets(row);
  return [...Object.values(s.headers ?? {}), ...Object.values(s.env ?? {})].filter((v) => v.length >= 8);
}

async function toView(row: ConnectorRow): Promise<ConnectorView> {
  const { db } = getDb();
  const [oauth] = await db.select().from(mcpConnectorOauth).where(eq(mcpConnectorOauth.connectorId, row.id));
  const [grantCount] = await db.select({ count: sql<number>`count(*)::int` }).from(agentConnectors).where(eq(agentConnectors.connectorId, row.id));
  const secrets = readSecrets(row);
  const tools = (row.tools as { name: string; description?: string }[]) ?? [];
  return {
    id: row.id, slug: row.slug, name: row.name, source: row.source, libraryKey: row.libraryKey,
    transport: row.transport, url: row.url, command: row.command, args: (row.args as string[]) ?? [],
    authMode: row.authMode, status: row.status, tools, toolCount: tools.length,
    lastTestedAt: row.lastTestedAt?.toISOString() ?? null, lastError: row.lastError,
    secretKeys: [...Object.keys(secrets.headers ?? {}), ...Object.keys(secrets.env ?? {})],
    oauth: row.authMode === 'oauth'
      ? {
        authorized: Boolean(oauth && hasOAuthTokens(oauth)),
        authorizedBy: oauth?.authorizedBy ?? null,
        authorizedAt: oauth?.authorizedAt?.toISOString() ?? null,
        pending: Boolean(oauth?.pendingState),
      }
      : null,
    agentCount: Number(grantCount?.count ?? 0),
    createdBy: row.createdBy, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

export async function listConnectors(): Promise<ConnectorView[]> {
  const { db } = getDb();
  const rows = await db.select().from(mcpConnectors).orderBy(mcpConnectors.createdAt);
  return Promise.all(rows.map(toView));
}

export async function getConnector(id: string): Promise<ConnectorView> {
  return toView(await loadConnector(id));
}

export async function loadConnector(id: string): Promise<ConnectorRow> {
  const { db } = getDb();
  const [row] = await db.select().from(mcpConnectors).where(eq(mcpConnectors.id, id));
  if (!row) throw err.notFound('Connector not found');
  return row;
}

export async function loadConnectorBySlug(slug: string): Promise<ConnectorRow | null> {
  const { db } = getDb();
  const [row] = await db.select().from(mcpConnectors).where(eq(mcpConnectors.slug, slug));
  return row ?? null;
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'connector';
}

/** `ordi` is the built-in server every agent gets; nothing else may take that name. */
const RESERVED_SLUGS = new Set(['ordi']);

async function uniqueSlug(preferred: string): Promise<string> {
  const { db } = getDb();
  const base = slugify(preferred);
  if (RESERVED_SLUGS.has(base)) throw err.validation(`"${base}" is reserved`);
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const [taken] = await db.select({ id: mcpConnectors.id }).from(mcpConnectors).where(eq(mcpConnectors.slug, candidate));
    if (!taken) return candidate;
  }
  throw err.domain('Could not find a free slug');
}

export async function createLibraryConnector(actor: Actor, input: LibraryMcpConnectorInput): Promise<ConnectorView> {
  const entry = findMcpLibraryEntry(input.libraryKey);
  if (!entry) throw err.validation(`Unknown library entry ${input.libraryKey}`);
  const secrets: ConnectorSecrets = { headers: {}, env: {} };
  for (const field of entry.secrets) {
    const value = input.secrets[field.key]?.trim();
    if (!value) {
      if (field.required) throw err.validation(`${field.label} is required`, { field: field.key });
      continue;
    }
    const rendered = field.template ? field.template.replace('{value}', value) : value;
    if (field.as === 'header') secrets.headers![field.key] = rendered;
    else secrets.env![field.key] = rendered;
  }
  const authMode = entry.auth === 'oauth' ? 'oauth' : entry.secrets.length && Object.keys(secrets.headers!).length ? 'headers' : 'none';
  const { db } = getDb();
  const id = ulid();
  const slug = await uniqueSlug(input.slug ?? entry.key);
  await db.insert(mcpConnectors).values({
    id, slug, name: input.name ?? entry.name, source: 'library', libraryKey: entry.key,
    transport: entry.transport, url: entry.url ?? null, command: entry.command ?? null, args: entry.args ?? [],
    authMode, secrets: writeSecrets(secrets), status: entry.auth === 'oauth' ? 'needs_auth' : 'active',
    createdBy: actor.userId,
  });
  await writeActivity(db, {
    entityType: 'mcp_connector', entityId: id, action: 'created', actorId: actor.userId, actorType: actor.actorType,
    diff: { slug, name: input.name ?? entry.name, libraryKey: entry.key, transport: entry.transport, authMode },
  });
  return toView(await loadConnector(id));
}

export async function createCustomConnector(actor: Actor, input: CustomMcpConnectorInput): Promise<ConnectorView> {
  const { db } = getDb();
  const id = ulid();
  const slug = await uniqueSlug(input.slug ?? input.name);
  const secrets: ConnectorSecrets = { headers: {} };
  if (input.authMode === 'bearer' && input.bearer) secrets.headers!.Authorization = `Bearer ${input.bearer.trim()}`;
  if (input.authMode === 'headers' && input.headers) secrets.headers = { ...input.headers };
  await db.insert(mcpConnectors).values({
    id, slug, name: input.name, source: 'custom', transport: input.transport, url: input.url,
    authMode: input.authMode, secrets: writeSecrets(secrets),
    status: input.authMode === 'oauth' ? 'needs_auth' : 'active', createdBy: actor.userId,
  });
  if (input.authMode === 'oauth' && input.oauthClientId) {
    await storePreregisteredClient(id, input.oauthClientId, input.oauthClientSecret ?? null);
  }
  await writeActivity(db, {
    entityType: 'mcp_connector', entityId: id, action: 'created', actorId: actor.userId, actorType: actor.actorType,
    diff: { slug, name: input.name, url: input.url, transport: input.transport, authMode: input.authMode },
  });
  return toView(await loadConnector(id));
}

export async function updateConnector(actor: Actor, id: string, input: {
  name?: string; enabled?: boolean; bearer?: string; headers?: Record<string, string>; secrets?: Record<string, string>; version: number;
}): Promise<ConnectorView> {
  const { db } = getDb();
  const row = await loadConnector(id);
  assertVersion(row, input.version, await toView(row));
  const patch: Partial<typeof mcpConnectors.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.enabled !== undefined) {
    patch.status = input.enabled
      ? (row.authMode === 'oauth' ? 'needs_auth' : 'active')
      : 'disabled';
    if (input.enabled && row.authMode === 'oauth') {
      const [oauth] = await db.select().from(mcpConnectorOauth).where(eq(mcpConnectorOauth.connectorId, id));
      if (oauth && hasOAuthTokens(oauth)) patch.status = 'active';
    }
  }
  const rotated = input.bearer !== undefined || input.headers !== undefined || input.secrets !== undefined;
  if (rotated) {
    const current = readSecrets(row);
    const headers = { ...(current.headers ?? {}) };
    const envVars = { ...(current.env ?? {}) };
    if (input.bearer !== undefined) headers.Authorization = `Bearer ${input.bearer.trim()}`;
    if (input.headers) Object.assign(headers, input.headers);
    if (input.secrets) {
      const entry = row.libraryKey ? findMcpLibraryEntry(row.libraryKey) : undefined;
      for (const [key, value] of Object.entries(input.secrets)) {
        const field = entry?.secrets.find((f) => f.key === key);
        const rendered = field?.template ? field.template.replace('{value}', value) : value;
        if (field?.as === 'env') envVars[key] = rendered;
        else headers[key] = rendered;
      }
    }
    patch.secrets = writeSecrets({ headers, env: envVars });
  }
  if (Object.keys(patch).length) {
    await db.update(mcpConnectors).set(patch).where(and(eq(mcpConnectors.id, id), eq(mcpConnectors.version, row.version)));
  }
  await writeActivity(db, {
    entityType: 'mcp_connector', entityId: id,
    action: input.enabled === false ? 'disabled' : input.enabled === true ? 'enabled' : rotated ? 'secrets_rotated' : 'updated',
    actorId: actor.userId, actorType: actor.actorType, diff: { name: input.name, enabled: input.enabled },
  });
  return toView(await loadConnector(id));
}

export async function deleteConnector(actor: Actor, id: string): Promise<void> {
  const { db } = getDb();
  const row = await loadConnector(id);
  await db.delete(mcpConnectors).where(eq(mcpConnectors.id, id));
  await writeActivity(db, {
    entityType: 'mcp_connector', entityId: id, action: 'deleted', actorId: actor.userId, actorType: actor.actorType,
    diff: { slug: row.slug, name: row.name },
  });
}

// ── Upstream clients ──

export interface UpstreamClient {
  listTools(): Promise<{ tools: { name: string; description?: string; inputSchema?: unknown }[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

export type UpstreamOpener = (connector: ConnectorRow) => Promise<UpstreamClient>;

/** Marker for "the connector needs (re-)authorization". */
export class ConnectorNeedsAuthError extends Error {
  constructor(public readonly connectorId: string) {
    super('Connector needs authorization');
    this.name = 'ConnectorNeedsAuthError';
  }
}

async function defaultOpener(connector: ConnectorRow): Promise<UpstreamClient> {
  const secrets = readSecrets(connector);
  let transport: Transport;
  if (connector.transport === 'stdio') {
    if (!connector.command) throw err.domain('Connector has no command');
    transport = new StdioClientTransport({
      command: connector.command,
      args: (connector.args as string[]) ?? [],
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', ...(secrets.env ?? {}) },
      stderr: 'ignore',
    });
  } else {
    if (!connector.url) throw err.domain('Connector has no url');
    const url = new URL(connector.url);
    const headers = secrets.headers ?? {};
    const authProvider = connector.authMode === 'oauth' ? new ConnectorOAuthProvider(connector.id, connector.url) : undefined;
    // Static headers ride on every request, including the SSE stream itself.
    const withHeaders = (input: string | URL, init?: RequestInit) => fetch(input, {
      ...init, headers: { ...(init?.headers as Record<string, string> ?? {}), ...headers },
    });
    transport = connector.transport === 'sse'
      ? new SSEClientTransport(url, { authProvider, requestInit: { headers }, fetch: withHeaders })
      : new StreamableHTTPClientTransport(url, { authProvider, requestInit: { headers }, fetch: withHeaders });
  }
  const client = new Client({ name: 'ordi-gateway', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
  } catch (e) {
    if (e instanceof UnauthorizedError) throw new ConnectorNeedsAuthError(connector.id);
    throw e;
  }
  return {
    listTools: async () => {
      const res = await client.listTools();
      return { tools: res.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
    },
    callTool: async (params) => {
      try {
        return await client.callTool({ name: params.name, arguments: params.arguments ?? {} });
      } catch (e) {
        if (e instanceof UnauthorizedError) throw new ConnectorNeedsAuthError(connector.id);
        throw e;
      }
    },
    close: async () => { await client.close().catch(() => {}); },
  };
}

let opener: UpstreamOpener = defaultOpener;

export function openUpstream(connector: ConnectorRow): Promise<UpstreamClient> {
  return opener(connector);
}

/** Test seam: replace how upstreams are reached. */
export function setUpstreamOpener(next: UpstreamOpener | null): void {
  opener = next ?? defaultOpener;
}

/** R20: initialize + tools/list, cache the tool names, record the outcome. */
export async function testConnector(actor: Actor, id: string): Promise<{ ok: boolean; needsAuth: boolean; tools: { name: string; description?: string }[]; error: string | null }> {
  const { db } = getDb();
  const row = await loadConnector(id);
  let client: UpstreamClient | null = null;
  try {
    client = await openUpstream(row);
    const { tools } = await client.listTools();
    const cached = tools.map((t) => ({ name: t.name, description: t.description?.slice(0, 500) }));
    await db.update(mcpConnectors).set({
      tools: cached, lastTestedAt: new Date(), lastError: null,
      status: row.status === 'disabled' ? 'disabled' : 'active',
    }).where(eq(mcpConnectors.id, id));
    await writeActivity(db, {
      entityType: 'mcp_connector', entityId: id, action: 'tested', actorId: actor.userId, actorType: actor.actorType,
      diff: { toolCount: cached.length },
    });
    return { ok: true, needsAuth: false, tools: cached, error: null };
  } catch (e) {
    const needsAuth = e instanceof ConnectorNeedsAuthError;
    const message = needsAuth ? 'Authorization required' : (e as Error).message;
    await db.update(mcpConnectors).set({
      lastTestedAt: new Date(), lastError: message,
      status: needsAuth ? 'needs_auth' : row.status,
    }).where(eq(mcpConnectors.id, id));
    logger.warn({ connector: row.slug, err: message }, 'connector test failed');
    return { ok: false, needsAuth, tools: (row.tools as { name: string }[]) ?? [], error: message };
  } finally {
    await client?.close();
  }
}

/** Mark a connector as needing authorization (a refresh failed or upstream said 401). */
export async function markNeedsAuth(id: string, reason: string): Promise<void> {
  const { db } = getDb();
  await db.update(mcpConnectors).set({ status: 'needs_auth', lastError: reason })
    .where(and(eq(mcpConnectors.id, id), sql`${mcpConnectors.status} <> 'disabled'`));
}
