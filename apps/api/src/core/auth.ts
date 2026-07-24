/**
 * Auth middleware (PRD §4.5.1, §6). Resolves a user from a session cookie or an
 * API Bearer token, builds the actor + access context, and attaches it to ctx.
 */
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { getDb, schema, eq, and } from '@ordi/db';
import type { AppEnv, Actor } from '../context';
import { err } from '../lib/errors';
import { sha256 } from '../lib/crypto';
import { effectivePermissions } from './rbac';
import { buildAccessContext } from './access';

export const SESSION_COOKIE = 'ordi_session';

async function resolveActor(c: Parameters<MiddlewareHandler<AppEnv>>[0]): Promise<Actor | null> {
  const { db } = getDb();
  const authHeader = c.req.header('Authorization');
  const cookieToken = getCookie(c, SESSION_COOKIE);

  let userId: string | null = null;
  let tokenScopes: string[] | null = null;
  let readOnly = false;

  if (authHeader?.startsWith('Bearer ')) {
    const raw = authHeader.slice(7).trim();
    const [token] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.hash, sha256(raw)));
    if (token) {
      if (token.revokedAt) return null;
      userId = token.userId;
      tokenScopes = (token.scopes as string[]) ?? [];
      readOnly = token.readOnly;
      db.update(schema.apiTokens).set({ lastUsedAt: new Date() }).where(eq(schema.apiTokens.id, token.id)).catch(() => {});
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
  const permissions = await effectivePermissions(user.roleId, tokenScopes);
  const access = await buildAccessContext(user.id, permissions, readOnly);

  return {
    userId: user.id,
    actorType: (user.actorType as Actor['actorType']) ?? 'user',
    roleId: user.roleId,
    roleName: role?.name ?? 'unknown',
    email: user.email,
    name: user.name,
    locale: user.locale,
    readOnly,
    tokenScopes,
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

export function currentActor(c: { get: (k: 'actor') => Actor | undefined }): Actor {
  const actor = c.get('actor');
  if (!actor) throw err.unauthenticated();
  return actor;
}
