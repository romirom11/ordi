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
 *
 * A person who has an agent of their own (Profile → MCP & API → My agent) can
 * approve the client to work as that agent instead: the token is then the
 * agent's, named after the client, scoped and bounded like the tokens the My
 * agent card issues. Connecting the same client again for the same target
 * replaces the earlier OAuth token instead of piling up another one.
 */
import { Hono, type Context } from 'hono';
import { getDb, schema, eq, and, isNull, inArray, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { MY_AGENT_TOKEN_DEFAULT_DAYS, PERSONAL_AGENT_PERMISSIONS } from '@ordi/shared';
import type { AppEnv, Actor } from '../../context';
import { authMiddleware, requireAuth, requireSession, currentActor } from '../../core/auth';
import { effectivePermissions } from '../../core/rbac';
import { generateToken, sha256 } from '../../lib/crypto';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { logger } from '../../lib/logger';

const CODE_TTL_MS = 10 * 60_000;

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Exact match, except loopback redirects where RFC 8252 §7.3 requires the
 * port to be allowed to vary (CLI clients bind a random port per run).
 */
/**
 * Schemes a browser runs or renders instead of handing to an app. The consent
 * page navigates to the redirect, so one of these would execute script on the
 * ordi origin with the code in hand.
 */
const UNSAFE_REDIRECT_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:']);

function unsafeRedirect(uri: string): boolean {
  try { return UNSAFE_REDIRECT_SCHEMES.has(new URL(uri).protocol); } catch { return true; }
}

function redirectAllowed(registered: string[], presented: string): boolean {
  // Re-checked here, not just at registration: clients registered before the
  // check existed must not reach the browser with one of these either.
  if (unsafeRedirect(presented)) return false;
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

/**
 * OAuth error responses are a fixed JSON shape, not the ordi error envelope.
 * Always logged: the caller is another machine (an MCP client's backend), so
 * a silent 400 here is invisible to both the operator and the person staring
 * at "authorization failed" in the client - the log line is the only witness.
 */
function oauthError(c: Context, code: string, description: string, extra?: Record<string, unknown>) {
  logger.warn({ path: c.req.path, code, description, ...extra }, 'oauth request rejected');
  return c.json({ error: code, error_description: description }, 400);
}

/** The approving person's own agent, if they have one. */
async function personalAgentOf(ownerUserId: string): Promise<{ id: string; name: string; isActive: boolean } | null> {
  const { db } = getDb();
  const [row] = await db.select({ id: schema.users.id, name: schema.users.name, isActive: schema.users.isActive })
    .from(schema.externalAgents)
    .innerJoin(schema.users, eq(schema.users.id, schema.externalAgents.userId))
    .where(and(eq(schema.externalAgents.ownerUserId, ownerUserId), eq(schema.externalAgents.kind, 'personal')));
  return row ?? null;
}

/** Only a person signed in through the browser approves: never an agent, never a token. */
function signedInPerson(actor: Actor): boolean {
  return actor.actorType === 'user' && actor.tokenScopes === null && !actor.apiTokenId;
}

/**
 * The live OAuth tokens a new consent replaces: the target user's tokens
 * issued through the consent page to the same client. Clients register again
 * on reconnect and get a new client id, so "the same client" is one of the
 * same name that also lists the redirect this code went to (a loopback port
 * may differ). The name alone is anyone's to claim: a look-alike registration
 * sending codes elsewhere must not cut off the real client. Hand-made tokens
 * record no client and are never among them.
 */
async function replacedOAuthTokens(tx: any, userId: string, clientName: string, redirectUri: string): Promise<string[]> {
  const rows: { id: string; redirectUris: unknown }[] = await tx.select({ id: schema.apiTokens.id, redirectUris: schema.oauthClients.redirectUris })
    .from(schema.apiTokens)
    .innerJoin(schema.oauthClients, eq(schema.oauthClients.id, schema.apiTokens.oauthClientId))
    .where(and(eq(schema.apiTokens.userId, userId), isNull(schema.apiTokens.revokedAt), eq(schema.oauthClients.name, clientName)));
  return rows.filter((r) => redirectAllowed((r.redirectUris as string[]) ?? [], redirectUri)).map((r) => r.id);
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

    // https redirects, custom app schemes (cursor://...) and loopback http only –
    // never a scheme the browser would execute or render itself.
    for (const uri of body.redirect_uris) {
      const u = new URL(uri);
      const loopback = u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
      if (u.protocol === 'http:' && !loopback) throw err.validation(`Insecure redirect_uri: ${uri}`);
      if (unsafeRedirect(uri)) throw err.validation(`Unsupported redirect_uri scheme: ${u.protocol}`);
    }

    const { db } = getDb();
    const id = `mcp_${generateToken(16)}`;
    await db.insert(schema.oauthClients).values({
      id, name: body.client_name ?? 'MCP client', redirectUris: body.redirect_uris,
    });
    logger.info({ clientId: id, name: body.client_name, redirectHosts: body.redirect_uris.map((u) => { try { return new URL(u).host; } catch { return u; } }) }, 'oauth client registered');
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
    // What the consent page offers to connect as: the person, or their own agent.
    const actor = currentActor(c);
    const agent = signedInPerson(actor) ? await personalAgentOf(actor.userId) : null;
    return c.json({
      id: client.id, name: client.name, redirectUris: client.redirectUris,
      myAgent: agent ? { name: agent.name, isActive: agent.isActive } : null,
    });
  });

  // ── The signed-in user approves; we mint the code and hand back the redirect ──
  app.post('/approve', authMiddleware, requireSession, async (c) => {
    const actor = currentActor(c);
    if (!signedInPerson(actor)) throw err.forbidden('Only a signed-in person approves a client');
    const raw = await c.req.json();
    const parsedBody = z.object({
      clientId: z.string(),
      redirectUri: z.string().url(),
      // The state is the client's opaque blob echoed back verbatim; capping it
      // short rejects legitimate clients whose state is a signed payload.
      state: z.string().max(4096).optional(),
      codeChallenge: z.string().min(43).max(128),
      codeChallengeMethod: z.literal('S256'),
      // Who the client works as. Omitted by consent pages from before the
      // choice existed: as the person, as it always was. The agent is never
      // named by the request – it is the approver's own, looked up here.
      actAs: z.enum(['me', 'agent']).default('me'),
    }).safeParse(raw);
    if (!parsedBody.success) {
      logger.warn({ issues: parsedBody.error.flatten().fieldErrors, clientId: (raw as { clientId?: string })?.clientId }, 'oauth approve rejected: validation');
      throw parsedBody.error;
    }
    const body = parsedBody.data;

    const { db } = getDb();
    const [client] = await db.select().from(schema.oauthClients)
      .where(eq(schema.oauthClients.id, body.clientId));
    if (!client) {
      logger.warn({ clientId: body.clientId }, 'oauth approve rejected: unknown client');
      throw err.notFound('Unknown client');
    }
    if (!redirectAllowed(client.redirectUris as string[], body.redirectUri)) {
      logger.warn({ clientId: body.clientId, redirectUri: body.redirectUri }, 'oauth approve rejected: redirect_uri not registered');
      throw err.validation('redirect_uri is not registered for this client');
    }

    let agentUserId: string | null = null;
    if (body.actAs === 'agent') {
      const agent = await personalAgentOf(actor.userId);
      if (!agent) throw err.notFound('You have no agent yet – create one in Profile → MCP & API');
      if (!agent.isActive) throw err.domain('Your agent is switched off; switch it on before connecting a client');
      agentUserId = agent.id;
    }

    // Opportunistic cleanup – codes are short-lived and never read after use.
    await db.delete(schema.oauthAuthCodes).where(sql`${schema.oauthAuthCodes.expiresAt} < now()`);

    const code = generateToken(32);
    await db.insert(schema.oauthAuthCodes).values({
      id: ulid(), code, clientId: client.id, userId: actor.userId!, agentUserId,
      codeChallenge: body.codeChallenge, redirectUri: body.redirectUri,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    await writeActivity(db, {
      entityType: 'user', entityId: actor.userId!, action: 'oauth.authorize',
      actorId: actor.userId, actorType: actor.actorType,
      diff: { client: client.name, ...(agentUserId ? { asAgent: agentUserId } : {}) },
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
    if (!parsed.success) return oauthError(c, 'invalid_request', 'Malformed token request', { contentType });
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

    if (!row || row.expiresAt < new Date()) {
      return oauthError(c, 'invalid_grant', 'Code is invalid or expired', { codeKnown: !!row, clientId: body.client_id });
    }
    if (body.client_id && body.client_id !== row.clientId) {
      return oauthError(c, 'invalid_grant', 'Code was issued to another client', { presented: body.client_id, expected: row.clientId });
    }
    if (body.redirect_uri && body.redirect_uri !== row.redirectUri) {
      return oauthError(c, 'invalid_grant', 'redirect_uri mismatch', { presented: body.redirect_uri, expected: row.redirectUri });
    }
    if (s256(body.code_verifier) !== row.codeChallenge) {
      return oauthError(c, 'invalid_grant', 'PKCE verification failed', { clientId: row.clientId });
    }

    const [client] = await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.id, row.clientId));
    const clientName = client?.name ?? 'MCP client';
    const token = `ordi_${generateToken(24)}`;
    const tokenId = ulid();

    if (row.agentUserId) {
      // As the person's own agent: everything the approval relied on is
      // checked again, under the locks switching off and deactivation take –
      // person before agent – so neither can slip in between.
      const agentUserId = row.agentUserId;
      const expiresAt = new Date(Date.now() + MY_AGENT_TOKEN_DEFAULT_DAYS * 86_400_000);
      let replaced: string[] = [];
      const refused = await db.transaction(async (tx) => {
        const [owner] = await tx.select({ isActive: schema.users.isActive, actorType: schema.users.actorType })
          .from(schema.users).where(eq(schema.users.id, row.userId)).for('share');
        if (!owner?.isActive || owner.actorType !== 'user') return 'User is not active';
        const [agent] = await tx.select({ isActive: schema.users.isActive, actorType: schema.users.actorType })
          .from(schema.users).where(eq(schema.users.id, agentUserId)).for('update');
        const [ext] = await tx.select({ kind: schema.externalAgents.kind, ownerUserId: schema.externalAgents.ownerUserId })
          .from(schema.externalAgents).where(eq(schema.externalAgents.userId, agentUserId));
        if (!agent || agent.actorType !== 'agent' || ext?.kind !== 'personal' || ext.ownerUserId !== row.userId) {
          return 'The agent is not the approver\'s own';
        }
        if (!agent.isActive) return 'The agent is switched off';
        replaced = await replacedOAuthTokens(tx, agentUserId, clientName, row.redirectUri);
        if (replaced.length) await tx.update(schema.apiTokens).set({ revokedAt: new Date() }).where(inArray(schema.apiTokens.id, replaced));
        await tx.insert(schema.apiTokens).values({
          // Named after the client alone, like a token from the My agent
          // card: the agent's comments say "via <client>".
          id: tokenId, userId: agentUserId, name: clientName.slice(0, 120), hash: sha256(token), prefix: token.slice(0, 12),
          // The most a personal agent may ever do; each request is narrowed
          // further to what its owner can do at that moment.
          scopes: [...PERSONAL_AGENT_PERMISSIONS], readOnly: false, expiresAt, oauthClientId: row.clientId,
        });
        return null;
      });
      if (refused) return oauthError(c, 'invalid_grant', refused, { clientId: row.clientId, agentUserId });
      await writeActivity(db, {
        entityType: 'agent', entityId: agentUserId, action: 'token_issued', actorId: row.userId, actorType: 'user',
        diff: { tokenId, client: clientName, oauth: true, replaced: replaced.length, expiresAt: expiresAt.toISOString() },
      });
      logger.info({ clientId: row.clientId, client: clientName, userId: row.userId, agentUserId, replaced: replaced.length }, 'oauth token issued for personal agent');
      return c.json({
        access_token: token, token_type: 'bearer',
        expires_in: MY_AGENT_TOKEN_DEFAULT_DAYS * 86_400,
      });
    }

    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, row.userId));
    if (!user || !user.isActive) return oauthError(c, 'invalid_grant', 'User is not active');

    // The access token is an ordinary API token: same auth path, same
    // revocation UI, scope = the user's own permissions at grant time.
    const perms = await effectivePermissions(user.roleId, null);
    const name = `${clientName} (OAuth)`;
    let replaced: string[] = [];
    await db.transaction(async (tx) => {
      replaced = await replacedOAuthTokens(tx, user.id, clientName, row.redirectUri);
      if (replaced.length) await tx.update(schema.apiTokens).set({ revokedAt: new Date() }).where(inArray(schema.apiTokens.id, replaced));
      await tx.insert(schema.apiTokens).values({
        id: tokenId, userId: user.id, name,
        hash: sha256(token), prefix: token.slice(0, 12), scopes: [...perms], readOnly: false, oauthClientId: row.clientId,
      });
    });

    logger.info({ clientId: row.clientId, client: clientName, userId: user.id, replaced: replaced.length }, 'oauth token issued');
    return c.json({ access_token: token, token_type: 'bearer' });
  });

  return app;
}
