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
import { Hono, type Context } from 'hono';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from '@ordi/mcp/server';
import { OrdiClient } from '@ordi/mcp/client';
import { getDb, schema, eq } from '@ordi/db';
import { sha256 } from '../../lib/crypto';
import type { AppEnv } from '../../context';
import { env } from '../../env';

/**
 * The origin this request actually arrived on.
 *
 * Discovery documents must advertise URLs the *client* can reach, and RFC 8414
 * additionally requires the issuer to match where the metadata was fetched
 * from. Deriving them from APP_URL breaks both the moment APP_URL is stale or
 * left at its default: discovery still answers (the client reached the real
 * host), but it hands back a registration_endpoint on localhost, and the
 * client reports that it could not register. So: forwarded headers first, then
 * Host, and APP_URL only as a last resort.
 */
export function publicOrigin(c: Context): string {
  const first = (v: string | undefined) => v?.split(',')[0]?.trim() || undefined;
  const host = first(c.req.header('x-forwarded-host')) ?? first(c.req.header('host'));
  if (!host) return env.appUrl;
  return `${publicProto(c, host)}://${host}`;
}

/**
 * The scheme the *client* used. Inside the container the socket is always
 * plain http, so this has to come from somewhere else, and advertising
 * http:// URLs for an https site makes every MCP client refuse the connector.
 *
 * APP_URL wins when it names this very host, ahead of the forwarded headers.
 * That inversion is deliberate. X-Forwarded-Proto is set by the *nearest*
 * proxy, and a common self-hosted chain – Cloudflare tunnel terminating TLS,
 * then a router reached over plain http that overwrites the header with its
 * own entrypoint's scheme – reports http for a site that is https everywhere
 * the user can see. An operator who wrote APP_URL=https://this.host has
 * stated what the site is; a hop header contradicting that for the same host
 * describes the last hop, not the client. The host itself still comes from
 * the request, so serving several domains keeps working.
 */
function publicProto(c: Context, host: string): string {
  const first = (v: string | undefined) => v?.split(',')[0]?.trim() || undefined;

  try {
    const configured = new URL(env.appUrl);
    if (configured.host === host) return configured.protocol.replace(':', '');
  } catch { /* APP_URL unparseable – fall through to the headers */ }

  const xfp = first(c.req.header('x-forwarded-proto'));
  if (xfp) return xfp;

  // RFC 7239: Forwarded: for=...;proto=https;host=...
  const fwd = /proto=("?)([A-Za-z]+)\1/.exec(c.req.header('forwarded') ?? '');
  if (fwd) return fwd[2]!.toLowerCase();

  try { return new URL(c.req.url).protocol.replace(':', ''); } catch { return 'http'; }
}

function resourceMetadataUrl(c: Context): string {
  return `${publicOrigin(c)}/api/v1/.well-known/oauth-protected-resource`;
}

function unauthorized(c: Context) {
  return new Response(
    JSON.stringify({ error: 'unauthorized', error_description: 'Bearer token required' }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        // RFC 9728: tells the client where to discover the OAuth server.
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(c)}"`,
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
    if (!auth.startsWith('Bearer ')) return unauthorized(c);
    const raw = auth.slice(7);
    if (!(await tokenIsValid(raw))) return unauthorized(c);

    // Node's req/res, provided by @hono/node-server. Absent under app.request()
    // (tests) – the OAuth flow is tested there, the transport is not.
    const bindings = c.env as unknown as { incoming?: IncomingMessage; outgoing?: ServerResponse };
    if (!bindings.incoming || !bindings.outgoing) {
      return c.json({ error: 'unsupported', error_description: 'MCP requires the node server' }, 501);
    }

    // publicUrl: image links handed to the agent must resolve on the app
    // origin – the localhost baseUrl only exists inside this process.
    const client = new OrdiClient({ baseUrl: `http://localhost:${env.port}`, token: raw, publicUrl: env.appUrl });
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
export function protectedResourceMetadata(c: Context) {
  const origin = publicOrigin(c);
  return {
    resource: `${origin}/api/v1/mcp`,
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
  };
}

/** RFC 8414 – the authorization server description MCP clients discover. */
export function authorizationServerMetadata(c: Context) {
  const origin = publicOrigin(c);
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/v1/oauth/token`,
    registration_endpoint: `${origin}/api/v1/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}
