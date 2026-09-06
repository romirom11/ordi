/**
 * Shared fixtures for the agent tests: a workspace with a project, an
 * in-review status and a task; agent creation through the API; a local MCP
 * server (optionally bearer- or OAuth-protected) to stand in for an upstream
 * connector; and outbox draining so consumers run inline.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { getDb, schema, eq } from '@ordi/db';
import { processOutboxOnce } from '../workers/relay';
import { reqAs, json, seedRolesAndUsers } from './helpers';

export type Users = Awaited<ReturnType<typeof seedRolesAndUsers>>;

export interface Workspace {
  users: Users;
  projectId: string;
  taskId: string;
  reviewStatusId: string;
  todoStatusId: string;
}

export async function setupWorkspace(users: Users, key = 'AGT'): Promise<Workspace> {
  const owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: `Type ${key}`, revenueSource: 'none' }));
  const project = await json(owner.post('/projects', { name: `Project ${key}`, key, projectTypeId: type.id }));
  const statuses = (await json(owner.get(`/projects/${project.id}/task-statuses`))).data as { id: string; category: string; name: string }[];
  let review = statuses.find((s) => /review/i.test(s.name));
  if (!review) {
    review = await json(owner.post(`/projects/${project.id}/task-statuses`, { name: 'In review', category: 'in_progress', color: '#888888', position: 50 }));
  }
  const todo = statuses.find((s) => s.category === 'todo') ?? statuses[0]!;
  await json(owner.post(`/projects/${project.id}/members`, { userId: users.member!.userId, role: 'member', canWriteTasks: true }));
  const task = await json(owner.post('/tasks', { projectId: project.id, title: 'Fix the flaky login test', statusId: todo.id }));
  return { users, projectId: project.id, taskId: task.id, reviewStatusId: review!.id, todoStatusId: todo.id };
}

export async function createAgent(users: Users, overrides: Record<string, unknown> = {}) {
  const owner = reqAs(users.owner!.cookie);
  const res = await owner.post('/agents', { name: 'Claude', runtime: 'claude_code', ...overrides });
  if (res.status !== 201) throw new Error(`agent creation failed: ${res.status} ${await res.text()}`);
  return json(res) as Promise<{ id: string; version: number; roleId: string }>;
}

export async function addProjectMember(users: Users, projectId: string, userId: string, role = 'member') {
  const owner = reqAs(users.owner!.cookie);
  const res = await owner.post(`/projects/${projectId}/members`, { userId, role, canWriteTasks: true });
  if (res.status >= 300) throw new Error(`membership failed: ${res.status} ${await res.text()}`);
}

export async function addCredential(users: Users, overrides: Record<string, unknown> = {}) {
  const owner = reqAs(users.owner!.cookie);
  const res = await owner.post('/agent-credentials', { provider: 'anthropic', kind: 'api_key', label: 'Company key', secret: 'sk-ant-test-1234567890', ...overrides });
  if (res.status !== 201) throw new Error(`credential failed: ${res.status} ${await res.text()}`);
  return json(res) as Promise<{ id: string; version: number; slot: string | null }>;
}

/** Run every consumer over what is in the outbox; loops until nothing is pending. */
export async function drainOutbox(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const n = await processOutboxOnce(100);
    if (n === 0) return;
  }
}

export async function runsForTask(taskId: string) {
  const { db } = getDb();
  return db.select().from(schema.agentRuns).where(eq(schema.agentRuns.taskId, taskId));
}

export async function eventsForRun(runId: string) {
  const { db } = getDb();
  return db.select().from(schema.agentRunEvents).where(eq(schema.agentRunEvents.runId, runId)).orderBy(schema.agentRunEvents.seq);
}

// ── A local upstream MCP server ──

export interface TestMcpServerOptions {
  /** When set, requests without this bearer get 401 (with resource metadata when oauth is on). */
  bearer?: string;
  /** Serve OAuth discovery, registration and token endpoints; the bearer becomes the issued access token. */
  oauth?: boolean;
  /** Issue a refresh token and accept it once. */
  refresh?: boolean;
}

export interface TestMcpServer {
  url: string;
  origin: string;
  calls: { method: string; path: string; auth: string | null; body?: unknown }[];
  /** Tokens the OAuth endpoints handed out, in order. */
  issued: string[];
  /** Force the current access token to be rejected (simulates expiry upstream). */
  rejectAccess: (token: string) => void;
  /** Make the token endpoint accept this authorization code once. */
  seedCode: (code: string) => void;
  close: () => Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

export async function startTestMcpServer(options: TestMcpServerOptions = {}): Promise<TestMcpServer> {
  const calls: TestMcpServer['calls'] = [];
  const issued: string[] = [];
  const rejected = new Set<string>();
  const codes = new Map<string, { verifier?: string }>();
  let accepted: Set<string> = new Set(options.bearer ? [options.bearer] : []);
  let origin = '';

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', origin);
    const auth = req.headers.authorization ?? null;
    const body = req.method === 'POST' ? await readBody(req) : '';
    let parsed: unknown;
    try { parsed = body ? JSON.parse(body) : undefined; } catch { parsed = body; }
    calls.push({ method: req.method ?? 'GET', path: url.pathname, auth, body: parsed });

    if (options.oauth) {
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ['header'] }));
        return;
      }
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server') || url.pathname.startsWith('/.well-known/openid-configuration')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`, response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        }));
        return;
      }
      if (url.pathname === '/register') {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ client_id: 'test-client', client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: (parsed as { redirect_uris?: string[] })?.redirect_uris ?? [], token_endpoint_auth_method: 'none' }));
        return;
      }
      if (url.pathname === '/token') {
        const params = new URLSearchParams(body);
        const grant = params.get('grant_type');
        if (grant === 'authorization_code' && codes.has(params.get('code') ?? '')) {
          codes.delete(params.get('code')!);
        } else if (grant === 'refresh_token' && options.refresh && params.get('refresh_token') === 'refresh-1') {
          // ok
        } else {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_grant' }));
          return;
        }
        const token = `at-${issued.length + 1}-${randomUUID().slice(0, 8)}`;
        issued.push(token);
        accepted = new Set([token]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: token, token_type: 'bearer', expires_in: 3600, ...(options.refresh ? { refresh_token: 'refresh-1' } : {}) }));
        return;
      }
    }

    if (url.pathname !== '/mcp') { res.writeHead(404); res.end(); return; }
    const presented = auth?.replace(/^Bearer /, '') ?? '';
    const needsAuth = options.bearer !== undefined || options.oauth;
    if (needsAuth && (!presented || !accepted.has(presented) || rejected.has(presented))) {
      res.writeHead(401, {
        'content-type': 'application/json',
        ...(options.oauth ? { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } : {}),
      });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const server = new McpServer({ name: 'upstream', version: '1.0.0' });
    server.tool('echo', 'Echo the text back', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }));
    server.tool('boom', 'Always fails', {}, async () => ({ isError: true, content: [{ type: 'text', text: 'upstream failure' }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    res.on('close', () => { void transport.close(); void server.close(); });
    await transport.handleRequest(req, res, parsed);
  };

  const httpServer: Server = createServer((req, res) => { void handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }); });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as { port: number }).port;
  origin = `http://127.0.0.1:${port}`;

  return {
    url: `${origin}/mcp`, origin, calls, issued,
    rejectAccess: (token) => rejected.add(token),
    seedCode: (code) => codes.set(code, {}),
    close: () => new Promise((resolve) => httpServer.close(() => resolve())),
  };
}
