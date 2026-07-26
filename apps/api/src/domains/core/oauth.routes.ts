/**
 * OAuth 2.1 authorization server for MCP clients (Claude, Cursor, ...), so
 * connecting an agent is "log in and approve" instead of copying a token.
 *
 * Deliberately small: public clients only (RFC 7591 dynamic registration, no
 * secrets), PKCE S256 required, authorization codes are single-use and live
 * ten minutes. A successful exchange issues a normal ordi API token scoped to
 * the approving user's own permissions – it shows up in Settings → MCP next to
 * hand-made tokens and is revoked the same way. No refresh tokens: the access
 * token lives until revoked, exactly like a hand-made one.
 */
import { Hono, type Context } from 'hono';
import { getDb, schema, eq, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { AppEnv } from '../../context';
import { authMiddleware, requireAuth, currentActor } from '../../core/auth';
import { effectivePermissions } from '../../core/rbac';
import { generateToken, sha256 } from '../../lib/crypto';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';

const CODE_TTL_MS = 10 * 60_000;

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Exact match, except loopback redirects where RFC 8252 §7.3 requires the
 * port to be allowed to vary (CLI clients bind a random port per run).
 */
function redirectAllowed(registered: string[], presented: string): boolean {
  if (registered.includes(presented)) return true;
  let p: URL;
  try { p = new URL(presented); } catch { return false; }
  if (p.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(p.hostname)) return false;
  return registered.some((r) => {
    try {
      const u = new URL(r);
      return u.protocol === 'http:' && u.hostname === p.hostname && u.pathname === p.pathname;
    } catch { return false; }
  });
}

const inFlight = new Map<string, { count: number; resetAt: number }>();
function checkRate(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const entry = inFlight.get(key);
  if (!entry || entry.resetAt < now) {
    inFlight.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  entry.count += 1;
  if (entry.count > max) throw err.domain('Too many requests, slow down');
}

/** OAuth error responses are a fixed JSON shape, not the ordi error envelope. */
function oauthError(c: Context, code: string, description: string) {
  return c.json({ error: code, error_description: description }, 400);
}

export function oauthRoutes() {
  const app = new Hono<AppEnv>();

  // ── Dynamic client registration (RFC 7591) ──
  app.post('/register', async (c) => {
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    checkRate(`oauth-register:${ip}`, 20, 3600_000);
    const body = z.object({
      redirect_uris: z.array(z.string().url()).min(1).max(10),
      client_name: z.string().max(200).optional(),
      token_endpoint_auth_method: z.string().optional(),
      grant_types: z.array(z.string()).optional(),
      response_types: z.array(z.string()).optional(),
    }).passthrough().parse(await c.req.json());

    // https redirects, custom app schemes (cursor://...) and loopback http only.
    for (const uri of body.redirect_uris) {
      const u = new URL(uri);
      const loopback = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
      if (u.protocol === 'http:' && !loopback) throw err.validation(`Insecure redirect_uri: ${uri}`);
    }

    const { db } = getDb();
    const id = `mcp_${generateToken(16)}`;
    await db.insert(schema.oauthClients).values({
      id, name: body.client_name ?? 'MCP client', redirectUris: body.redirect_uris,
    });
    return c.json({
      client_id: id,
      client_name: body.client_name ?? 'MCP client',
      redirect_uris: body.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
    }, 201);
  });

  // ── What the consent page shows ──
  app.get('/client', authMiddleware, requireAuth, async (c) => {
    const { db } = getDb();
    const [client] = await db.select().from(schema.oauthClients)
      .where(eq(schema.oauthClients.id, c.req.query('client_id') ?? ''));
    if (!client) throw err.notFound('Unknown client');
    return c.json({ id: client.id, name: client.name, redirectUris: client.redirectUris });
  });

  // ── The signed-in user approves; we mint the code and hand back the redirect ──
  app.post('/approve', authMiddleware, requireAuth, async (c) => {
    const actor = currentActor(c);
    const body = z.object({
      clientId: z.string(),
      redirectUri: z.string().url(),
      state: z.string().max(512).optional(),
      codeChallenge: z.string().min(43).max(128),
      codeChallengeMethod: z.literal('S256'),
    }).parse(await c.req.json());

    const { db } = getDb();
    const [client] = await db.select().from(schema.oauthClients)
      .where(eq(schema.oauthClients.id, body.clientId));
    if (!client) throw err.notFound('Unknown client');
    if (!redirectAllowed(client.redirectUris as string[], body.redirectUri)) {
      throw err.validation('redirect_uri is not registered for this client');
    }

    // Opportunistic cleanup – codes are short-lived and never read after use.
    await db.delete(schema.oauthAuthCodes).where(sql`${schema.oauthAuthCodes.expiresAt} < now()`);

    const code = generateToken(32);
    await db.insert(schema.oauthAuthCodes).values({
      id: ulid(), code, clientId: client.id, userId: actor.userId!,
      codeChallenge: body.codeChallenge, redirectUri: body.redirectUri,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    await writeActivity(db, {
      entityType: 'user', entityId: actor.userId!, action: 'oauth.authorize',
      actorId: actor.userId, actorType: actor.actorType, diff: { client: client.name },
    });

    const url = new URL(body.redirectUri);
    url.searchParams.set('code', code);
    if (body.state) url.searchParams.set('state', body.state);
    return c.json({ redirectTo: url.toString() });
  });

  // ── Token endpoint: code + verifier → ordi API token ──
  app.post('/token', async (c) => {
    const ip = c.req.header('x-forwarded-for') ?? 'local';
    checkRate(`oauth-token:${ip}`, 30, 60_000);

    // Clients send application/x-www-form-urlencoded; a few send JSON.
    const contentType = c.req.header('content-type') ?? '';
    const raw = contentType.includes('json')
      ? await c.req.json().catch(() => ({}))
      : Object.fromEntries((await c.req.formData()).entries());
    const parsed = z.object({
      grant_type: z.string(),
      code: z.string().optional(),
      code_verifier: z.string().optional(),
      redirect_uri: z.string().optional(),
      client_id: z.string().optional(),
    }).safeParse(raw);
    if (!parsed.success) return oauthError(c, 'invalid_request', 'Malformed token request');
    const body = parsed.data;

    if (body.grant_type !== 'authorization_code') {
      return oauthError(c, 'unsupported_grant_type', 'Only authorization_code is supported');
    }
    if (!body.code || !body.code_verifier) {
      return oauthError(c, 'invalid_request', 'code and code_verifier are required');
    }

    const { db } = getDb();
    const [row] = await db.select().from(schema.oauthAuthCodes)
      .where(eq(schema.oauthAuthCodes.code, body.code));
    // Single use: burn the code before validating so a race cannot redeem twice.
    if (row) await db.delete(schema.oauthAuthCodes).where(eq(schema.oauthAuthCodes.id, row.id));

    if (!row || row.expiresAt < new Date()) return oauthError(c, 'invalid_grant', 'Code is invalid or expired');
    if (body.client_id && body.client_id !== row.clientId) return oauthError(c, 'invalid_grant', 'Code was issued to another client');
    if (body.redirect_uri && body.redirect_uri !== row.redirectUri) return oauthError(c, 'invalid_grant', 'redirect_uri mismatch');
    if (s256(body.code_verifier) !== row.codeChallenge) return oauthError(c, 'invalid_grant', 'PKCE verification failed');

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId));
    if (!user || !user.isActive) return oauthError(c, 'invalid_grant', 'User is not active');
    const [client] = await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.id, row.clientId));

    // The access token is an ordinary API token: same auth path, same
    // revocation UI, scope = the user's own permissions at grant time.
    const perms = await effectivePermissions(user.roleId, null);
    const token = `ordi_${generateToken(24)}`;
    await db.insert(schema.apiTokens).values({
      id: ulid(), userId: user.id, name: `${client?.name ?? 'MCP client'} (OAuth)`,
      hash: sha256(token), prefix: token.slice(0, 12), scopes: [...perms], readOnly: false,
    });

    return c.json({ access_token: token, token_type: 'bearer' });
  });

  return app;
}
