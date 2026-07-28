/**
 * Resource access (PRD §4.4). Project/space membership + accessibleProjectIds
 * (one cached query per request), and assert helpers used by services.
 */
import { getDb, schema, eq, and, inArray, isNull, or } from '@ordi/db';
import { type AccessContext, projectAccessRank, spaceAccessRank } from '@ordi/shared';
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

const PROJECT_RANK = { viewer: 1, member: 2, admin: 3 } as const;
const SPACE_RANK = { viewer: 1, editor: 2 } as const;
const PROJECT_ROLE_OF_RANK = [null, 'viewer', 'member', 'admin'] as const;

/**
 * The project role the actor effectively holds – the membership row, or what a
 * workspace project grants their permissions. Spaces attached to a project
 * inherit this, so a project admin edits the project's space whether the rights
 * came from a membership row or from projects.write.
 */
export function effectiveProjectRole(
  actor: Actor,
  project: { id: string; visibility: 'workspace' | 'private' },
): 'admin' | 'member' | 'viewer' | null {
  const rank = projectAccessRank(actor.access, { visibility: project.visibility, projectId: project.id });
  return PROJECT_ROLE_OF_RANK[rank] ?? null;
}

/**
 * Assert the actor can access a project at minRole.
 *
 * Invisible (or absent) => 404, so existence never leaks. Visible but below
 * minRole => 403 naming what is missing: "Project not found" on a project the
 * user is looking at reads as a broken app rather than as a permission
 * boundary, which is exactly how the too-strict write rule used to surface.
 */
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
  const rank = projectAccessRank(actor.access, {
    visibility: project.visibility as 'workspace' | 'private',
    projectId,
  });
  if (rank < PROJECT_RANK[minRole]) {
    if (rank < PROJECT_RANK.viewer) throw err.notFound('Project not found');
    throw err.forbidden(
      `This needs ${minRole} rights on the project – ask a project admin to add you, or get the projects.write permission.`,
      'projects.write',
    );
  }
  return { ...project, visibility: project.visibility as 'workspace' | 'private' };
}

/**
 * Assert space access; project-linked spaces inherit project membership.
 * Same 404-vs-403 split as assertProject.
 */
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
  let inheritedProjectRole: 'admin' | 'member' | 'viewer' | null = null;
  if (space.projectId) {
    const [project] = await db
      .select({ id: schema.projects.id, visibility: schema.projects.visibility })
      .from(schema.projects)
      .where(and(eq(schema.projects.id, space.projectId), isNull(schema.projects.deletedAt)));
    if (project) {
      inheritedProjectRole = effectiveProjectRole(actor, {
        id: project.id,
        visibility: project.visibility as 'workspace' | 'private',
      });
    }
  }
  const rank = spaceAccessRank(actor.access, {
    visibility: space.visibility as 'workspace' | 'private',
    spaceId,
    inheritedProjectRole,
  });
  if (rank < SPACE_RANK[minRole]) {
    if (rank < SPACE_RANK.viewer) throw err.notFound('Space not found');
    throw err.forbidden(
      'This needs editor rights on the space – ask a space editor to add you, or get the kb.write permission.',
      'kb.write',
    );
  }
  return { ...space, visibility: space.visibility as 'workspace' | 'private' };
}
