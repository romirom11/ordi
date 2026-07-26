/**
 * Hosted MCP: the same tool catalog the stdio binary serves, exposed over
 * Streamable HTTP at /api/v1/mcp with OAuth discovery. An MCP client pointed
 * at that URL gets a 401 with resource metadata, walks the OAuth flow
 * (oauth.routes.ts), and comes back with a Bearer token – the person just
 * logs in, no token copying.
 *
 * Stateless mode: a fresh server+transport pair per request, no session ids.
 * The tools call the REST API back over localhost with the caller's own
 * token, so permissions resolve exactly like any other API request.
 */
import { Hono } from 'hono';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from '@ordi/mcp/server';
import { OrdiClient } from '@ordi/mcp/client';
import { getDb, schema, eq } from '@ordi/db';
import { sha256 } from '../../lib/crypto';
import type { AppEnv } from '../../context';
import { env } from '../../env';

function resourceMetadataUrl(): string {
  return `${env.appUrl}/api/v1/.well-known/oauth-protected-resource`;
}

function unauthorized() {
  return new Response(
    JSON.stringify({ error: 'unauthorized', error_description: 'Bearer token required' }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        // RFC 9728: tells the client where to discover the OAuth server.
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl()}"`,
      },
    },
  );
}

async function tokenIsValid(raw: string): Promise<boolean> {
  const { db } = getDb();
  const [token] = await db.select().from(schema.apiTokens)
    .where(eq(schema.apiTokens.hash, sha256(raw)));
  if (token) return !token.revokedAt;
  // Bearer session tokens (desktop) are valid API credentials too.
  const [session] = await db.select().from(schema.sessions)
    .where(eq(schema.sessions.token, raw));
  return !!session && session.expiresAt > new Date();
}

export function mcpRoutes() {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    if (!auth.startsWith('Bearer ')) return unauthorized();
    const raw = auth.slice(7);
    if (!(await tokenIsValid(raw))) return unauthorized();

    // Node's req/res, provided by @hono/node-server. Absent under app.request()
    // (tests) – the OAuth flow is tested there, the transport is not.
    const bindings = c.env as unknown as { incoming?: IncomingMessage; outgoing?: ServerResponse };
    if (!bindings.incoming || !bindings.outgoing) {
      return c.json({ error: 'unsupported', error_description: 'MCP requires the node server' }, 501);
    }

    const client = new OrdiClient({ baseUrl: `http://localhost:${env.port}`, token: raw });
    const server = buildServer(client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    await server.connect(transport);
    // The transport writes the response itself; close both once it is flushed.
    bindings.outgoing.on('close', () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(bindings.incoming, bindings.outgoing, await c.req.json());
    return RESPONSE_ALREADY_SENT;
  });

  // Stateless server: nothing to GET (no server-push stream) or DELETE.
  app.get('/', (c) => c.json({ error: 'method_not_allowed' }, 405));
  app.delete('/', (c) => c.json({ error: 'method_not_allowed' }, 405));

  return app;
}

/* ─────────────────────────── OAuth discovery ─────────────────────────── */

/** RFC 9728 – who protects /mcp and where its authorization server lives. */
export function protectedResourceMetadata() {
  return {
    resource: `${env.appUrl}/api/v1/mcp`,
    authorization_servers: [env.appUrl],
    bearer_methods_supported: ['header'],
  };
}

/** RFC 8414 – the authorization server description MCP clients discover. */
export function authorizationServerMetadata() {
  return {
    issuer: env.appUrl,
    authorization_endpoint: `${env.appUrl}/oauth/authorize`,
    token_endpoint: `${env.appUrl}/api/v1/oauth/token`,
    registration_endpoint: `${env.appUrl}/api/v1/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}
