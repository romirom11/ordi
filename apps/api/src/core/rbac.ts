/**
 * RBAC execution (PRD §4.5). Permission set per role is cached in-process and
 * invalidated by the `role.updated` event. Guards are declarative per route.
 */
import type { MiddlewareHandler } from 'hono';
import { getDb, schema, eq } from '@ordi/db';
import { type Permission } from '@ordi/shared';
import type { AppEnv, Actor } from '../context';
import { err } from '../lib/errors';

const rolePermCache = new Map<string, Set<string>>();

export async function loadRolePermissions(roleId: string): Promise<Set<string>> {
  const cached = rolePermCache.get(roleId);
  if (cached) return cached;
  const { db } = getDb();
  const rows = await db.select().from(schema.rolePermissions).where(eq(schema.rolePermissions.roleId, roleId));
  const set = new Set(rows.map((r) => r.permission));
  rolePermCache.set(roleId, set);
  return set;
}

export function invalidateRoleCache(roleId?: string): void {
  if (roleId) rolePermCache.delete(roleId);
  else rolePermCache.clear();
}

/**
 * Effective permissions for an actor: role permissions, intersected with the
 * API-token scope when the request is token-authenticated (PRD §4.5.5).
 */
export async function effectivePermissions(roleId: string, tokenScopes: string[] | null): Promise<Set<string>> {
  const rolePerms = await loadRolePermissions(roleId);
  if (!tokenScopes) return rolePerms;
  return new Set([...tokenScopes].filter((s) => rolePerms.has(s)));
}

/** Route guard: requires a capability. Missing declaration is caught by a lint test. */
export function guard(required: Permission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get('actor') as Actor | undefined;
    if (!actor) throw err.unauthenticated();
    if (actor.readOnly && isWritePermission(required)) {
      throw err.forbidden('Read-only token', required);
    }
    if (!actor.access.permissions.has(required)) {
      // 403 with required permission is written to audit by the audit middleware.
      throw err.forbidden(`Missing permission ${required}`, required);
    }
    await next();
  };
}

/** Requires ALL listed permissions. */
export function guardAll(...required: Permission[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get('actor') as Actor | undefined;
    if (!actor) throw err.unauthenticated();
    for (const p of required) {
      if (!actor.access.permissions.has(p)) throw err.forbidden(`Missing permission ${p}`, p);
    }
    await next();
  };
}

/** Explicitly public route marker (satisfies the "guard-or-public" invariant). */
export function publicRoute(): MiddlewareHandler<AppEnv> {
  return async (_c, next) => next();
}

const WRITE_ACTIONS = ['write', 'create', 'delete', 'send', 'payments', 'manage', 'track', 'approve_leave', 'manage_leave', 'recruit', 'manage_spaces'];
function isWritePermission(p: string): boolean {
  const action = p.split('.')[1] ?? '';
  return WRITE_ACTIONS.some((a) => action === a || action.startsWith(a));
}

export function hasPerm(actor: Actor, p: Permission): boolean {
  return actor.access.permissions.has(p);
}
