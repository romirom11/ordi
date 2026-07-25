/**
 * Resource access (PRD §4.4). Project/space membership + accessibleProjectIds
 * (one cached query per request), and assert helpers used by services.
 */
import { getDb, schema, eq, and, inArray, isNull, or } from '@ordi/db';
import { type AccessContext, canAccessProject, canAccessSpace } from '@ordi/shared';
import type { Actor } from '../context';
import { err } from '../lib/errors';

export async function buildAccessContext(
  userId: string,
  permissions: Set<string>,
  readOnly: boolean,
): Promise<AccessContext> {
  const { db } = getDb();
  const [pms, sms] = await Promise.all([
    db.select().from(schema.projectMembers).where(eq(schema.projectMembers.userId, userId)),
    db.select().from(schema.spaceMembers).where(eq(schema.spaceMembers.userId, userId)),
  ]);
  return {
    permissions,
    projectMemberships: new Map(pms.map((m) => [m.projectId, m.role as 'admin' | 'member' | 'viewer'])),
    spaceMemberships: new Map(sms.map((m) => [m.spaceId, m.role as 'editor' | 'viewer'])),
    isReadOnlyToken: readOnly,
  };
}

/**
 * All project ids the actor can view: workspace projects (if projects.read) plus
 * every project they're a member of. One query, cached on the request actor.
 */
const cacheKey = Symbol('accessibleProjectIds');
export async function accessibleProjectIds(
  actor: Actor,
  /** Long-lived connections (SSE) must be able to see projects created after
   *  they started, so they ask for a fresh read rather than the request cache. */
  opts?: { fresh?: boolean },
): Promise<string[]> {
  const anyActor = actor as unknown as Record<symbol, string[] | undefined>;
  if (!opts?.fresh && anyActor[cacheKey]) return anyActor[cacheKey]!;
  const { db } = getDb();
  const memberIds = [...actor.access.projectMemberships.keys()];
  let rows: { id: string }[];
  if (actor.access.permissions.has('projects.read')) {
    rows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(and(isNull(schema.projects.deletedAt),
        or(eq(schema.projects.visibility, 'workspace'),
          memberIds.length ? inArray(schema.projects.id, memberIds) : undefined)));
  } else if (memberIds.length) {
    rows = await db
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(and(isNull(schema.projects.deletedAt), inArray(schema.projects.id, memberIds)));
  } else {
    rows = [];
  }
  const ids = rows.map((r) => r.id);
  anyActor[cacheKey] = ids;
  return ids;
}

/** Assert the actor can access a project at minRole, else 404 (no existence leak). */
export async function assertProject(
  actor: Actor,
  projectId: string,
  minRole: 'viewer' | 'member' | 'admin' = 'viewer',
): Promise<{ id: string; visibility: 'workspace' | 'private'; projectTypeId: string; companyId: string | null }> {
  const { db } = getDb();
  const [project] = await db
    .select({ id: schema.projects.id, visibility: schema.projects.visibility, projectTypeId: schema.projects.projectTypeId, companyId: schema.projects.companyId })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
  if (!project) throw err.notFound('Project not found');
  const ok = canAccessProject(actor.access, {
    visibility: project.visibility as 'workspace' | 'private',
    projectId,
    minRole,
  });
  if (!ok) throw err.notFound('Project not found');
  return { ...project, visibility: project.visibility as 'workspace' | 'private' };
}

/** Assert space access; project-linked spaces inherit project membership. */
export async function assertSpace(
  actor: Actor,
  spaceId: string,
  minRole: 'viewer' | 'editor' = 'viewer',
): Promise<{ id: string; visibility: 'workspace' | 'private'; projectId: string | null }> {
  const { db } = getDb();
  const [space] = await db
    .select({ id: schema.kbSpaces.id, visibility: schema.kbSpaces.visibility, projectId: schema.kbSpaces.projectId })
    .from(schema.kbSpaces)
    .where(and(eq(schema.kbSpaces.id, spaceId), isNull(schema.kbSpaces.deletedAt)));
  if (!space) throw err.notFound('Space not found');
  const inheritedProjectRole = space.projectId
    ? actor.access.projectMemberships.get(space.projectId) ?? null
    : null;
  const ok = canAccessSpace(actor.access, {
    visibility: space.visibility as 'workspace' | 'private',
    spaceId,
    minRole,
    inheritedProjectRole,
  });
  if (!ok) throw err.notFound('Space not found');
  return { ...space, visibility: space.visibility as 'workspace' | 'private' };
}
