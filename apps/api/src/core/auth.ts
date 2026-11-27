/**
 * Auth middleware (PRD §4.5.1, §6). Resolves a user from a session cookie or an
 * API Bearer token, builds the actor + access context, and attaches it to ctx.
 */
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { getDb, schema, eq, and, isNull } from '@ordi/db';
import type { AppEnv, Actor } from '../context';
import { err } from '../lib/errors';
import { sha256 } from '../lib/crypto';
import { PERSONAL_AGENT_PERMISSIONS } from '@ordi/shared';
import { effectivePermissions, readRolePermissions } from './rbac';
import { buildAccessContext, buildPersonalAgentAccess } from './access';

export const SESSION_COOKIE = 'ordi_session';

/**
 * Who is calling, from the request's credentials – or null. Long-lived
 * connections (the SSE stream) call it again to notice a revoked token or a
 * personal agent's owner losing access.
 */
export async function resolveActor(
  c: Parameters<MiddlewareHandler<AppEnv>>[0],
  /** touch: false – a re-check, not a use: leave the token's lastUsedAt alone. */
  opts: { touch?: boolean } = {},
): Promise<Actor | null> {
  const { db } = getDb();
  const authHeader = c.req.header('Authorization');
  const cookieToken = getCookie(c, SESSION_COOKIE);

  let userId: string | null = null;
  let tokenScopes: string[] | null = null;
  let readOnly = false;
  let apiTokenId: string | null = null;
  let tokenName: string | null = null;

  if (authHeader?.startsWith('Bearer ')) {
    const raw = authHeader.slice(7).trim();
    const [token] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.hash, sha256(raw)));
    if (token) {
      if (token.revokedAt) return null;
      if (token.expiresAt && token.expiresAt <= new Date()) return null;
      userId = token.userId;
      tokenScopes = (token.scopes as string[]) ?? [];
      readOnly = token.readOnly;
      apiTokenId = token.id;
      tokenName = token.name.replace(/\s*\(OAuth\)$/, '');
      // Never stamped on a token revoked since it was read (the OAuth clean-up
      // may have just taken it): a revoked row keeps its last real use.
      if (opts.touch !== false) db.update(schema.apiTokens).set({ lastUsedAt: new Date() }).where(and(eq(schema.apiTokens.id, token.id), isNull(schema.apiTokens.revokedAt))).catch(() => {});
    } else {
      // Bearer session token (desktop/Tauri client, PRD §18): the tauri://
      // origin cannot share same-site cookies, so the login-issued session
      // token is presented as a bearer credential with full role scope.
      const [session] = await db.select().from(schema.sessions).where(eq(schema.sessions.token, raw));
      if (!session || session.expiresAt < new Date()) return null;
      userId = session.userId;
    }
  } else if (cookieToken) {
    const [session] = await db.select().from(schema.sessions).where(eq(schema.sessions.token, cookieToken));
    if (!session || session.expiresAt < new Date()) return null;
    userId = session.userId;
  }

  if (!userId) return null;

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!user || !user.isActive) return null;

  const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, user.roleId));

  // A person's own agent: its owner's current reach, bounded, every request.
  if (user.actorType === 'agent') {
    const [ext] = await db.select({ kind: schema.externalAgents.kind, ownerUserId: schema.externalAgents.ownerUserId })
      .from(schema.externalAgents).where(eq(schema.externalAgents.userId, user.id));
    if (ext?.kind === 'personal') {
      const [owner] = await db.select({ isActive: schema.users.isActive, roleId: schema.users.roleId })
        .from(schema.users).where(eq(schema.users.id, ext.ownerUserId));
      if (!owner?.isActive) return null;
      // Uncached: a role edited in another process must bind the agent now.
      const ownerPerms = await readRolePermissions(owner.roleId);
      const allowed = PERSONAL_AGENT_PERMISSIONS.filter((p) => ownerPerms.has(p) && (!tokenScopes || tokenScopes.includes(p)));
      const permissions = new Set<string>(allowed);
      return {
        userId: user.id,
        actorType: 'agent',
        roleId: user.roleId,
        roleName: role?.name ?? 'unknown',
        email: user.email,
        name: user.name,
        locale: user.locale,
        timezone: user.timezone,
        readOnly,
        tokenScopes,
        apiTokenId,
        ownerUserId: ext.ownerUserId,
        agentKind: 'personal',
        clientLabel: tokenName,
        access: await buildPersonalAgentAccess(ext.ownerUserId, permissions, readOnly),
      };
    }
  }

  const permissions = await effectivePermissions(user.roleId, tokenScopes);
  const access = await buildAccessContext(user.id, permissions, readOnly, user.actorType);

  return {
    userId: user.id,
    actorType: (user.actorType as Actor['actorType']) ?? 'user',
    roleId: user.roleId,
    roleName: role?.name ?? 'unknown',
    email: user.email,
    name: user.name,
    locale: user.locale,
    timezone: user.timezone,
    readOnly,
    tokenScopes,
    apiTokenId,
    access,
  };
}

/** Populates ctx.actor if credentials are present; does not reject (routes decide). */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = await resolveActor(c);
  if (actor) c.set('actor', actor);
  await next();
};

/** Requires an authenticated actor (used before guards on protected routers). */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('actor')) throw err.unauthenticated();
  await next();
};

/**
 * Credential-issuing routes (API tokens, OAuth and desktop approvals, TOTP)
 * need a signed-in session. An API token is a scoped credential: letting one
 * mint another credential – or reset the second factor – would turn any
 * leaked narrow or read-only token into the account's full role.
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const actor = c.get('actor');
  if (!actor) throw err.unauthenticated();
  if (actor.tokenScopes !== null) throw err.forbidden('Sign in to manage credentials');
  await next();
};

export function currentActor(c: { get: (k: 'actor') => Actor | undefined }): Actor {
  const actor = c.get('actor');
  if (!actor) throw err.unauthenticated();
  return actor;
}
