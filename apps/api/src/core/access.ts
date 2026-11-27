/**
 * Resource access (PRD §4.4). Project/space membership + accessibleProjectIds
 * (one cached query per request), and assert helpers used by services.
 */
import { getDb, schema, eq, and, inArray, isNull, or, sql, type SQL } from '@ordi/db';
import { type AccessContext, projectAccessRank, spaceAccessRank } from '@ordi/shared';
import type { Actor } from '../context';
import { err } from '../lib/errors';
import { loadRolePermissions } from './rbac';

export async function buildAccessContext(
  userId: string,
  permissions: Set<string>,
  readOnly: boolean,
  /** The user row's actor type: an agent reaches only the projects it is a member of. */
  actorType: string = 'user',
): Promise<AccessContext> {
  const { db } = getDb();
  const [pms, sms] = await Promise.all([
    // Memberships of soft-deleted projects grant nothing: code that trusts this
    // map directly must not reach a deleted project.
    db.select({ projectId: schema.projectMembers.projectId, role: schema.projectMembers.role })
      .from(schema.projectMembers)
      .innerJoin(schema.projects, eq(schema.projects.id, schema.projectMembers.projectId))
      .where(and(eq(schema.projectMembers.userId, userId), isNull(schema.projects.deletedAt))),
    db.select().from(schema.spaceMembers).where(eq(schema.spaceMembers.userId, userId)),
  ]);
  return {
    permissions,
    projectMemberships: new Map(pms.map((m) => [m.projectId, m.role as 'admin' | 'member' | 'viewer'])),
    spaceMemberships: new Map(sms.map((m) => [m.spaceId, m.role as 'editor' | 'viewer'])),
    isReadOnlyToken: readOnly,
    membershipOnlyProjects: actorType === 'agent',
  };
}

/**
 * All project ids the actor can view: workspace projects (if projects.read, and
 * not an agent – see membershipOnlyProjects) plus every project they're a
 * member of. One query, cached on the request actor.
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
  if (actor.access.permissions.has('projects.read') && !actor.access.membershipOnlyProjects) {
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

/**
 * SQL guard for rows hanging off a project: true unless that project is soft-
 * deleted. NOT EXISTS rather than a join, so a row with no project (a client-
 * level invoice, an internal expense) still passes. `col` may be a column or a
 * raw alias such as sql`te.project_id`.
 */
export function notInDeletedProject(col: unknown): SQL {
  return sql`not exists (select 1 from projects dp where dp.id = ${col} and dp.deleted_at is not null)`;
}

/** 404 unless the project exists and is not deleted – for writes that take a bare projectId. */
export async function assertLiveProject(projectId: string): Promise<void> {
  const { db } = getDb();
  const [row] = await db.select({ id: schema.projects.id }).from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
  if (!row) throw err.notFound('Project not found');
}

const PROJECT_RANK = { viewer: 1, member: 2, admin: 3 } as const;
const SPACE_RANK = { viewer: 1, editor: 2 } as const;
const PROJECT_ROLE_OF_RANK = [null, 'viewer', 'member', 'admin'] as const;

/**
 * Every KB space the actor can read or edit: workspace spaces (with kb.read /
 * kb.write), spaces they are a member of, and the spaces of projects they can
 * reach. The counterpart of accessibleProjectIds, for the feeds and search
 * that pull space-owned rows straight out of the database – both levels in one
 * pass, because page-level visibility (canSeePage) needs the editor set
 * everywhere the viewer set goes.
 */
const spaceCacheKey = Symbol('spaceAccessSets');
export async function spaceAccessSets(
  actor: Actor,
  opts?: { fresh?: boolean },
): Promise<{ viewer: string[]; editor: string[] }> {
  const anyActor = actor as unknown as Record<symbol, { viewer: string[]; editor: string[] } | undefined>;
  if (!opts?.fresh && anyActor[spaceCacheKey]) return anyActor[spaceCacheKey]!;
  const { db } = getDb();
  const spaces = await db
    .select({ id: schema.kbSpaces.id, visibility: schema.kbSpaces.visibility, projectId: schema.kbSpaces.projectId })
    .from(schema.kbSpaces)
    .where(isNull(schema.kbSpaces.deletedAt));
  const projectIds = [...new Set(spaces.map((s) => s.projectId).filter((id): id is string => !!id))];
  const projects = projectIds.length
    ? await db
      .select({ id: schema.projects.id, visibility: schema.projects.visibility })
      .from(schema.projects)
      .where(and(inArray(schema.projects.id, projectIds), isNull(schema.projects.deletedAt)))
    : [];
  const roleOfProject = new Map(projects.map((p) => [
    p.id,
    effectiveProjectRole(actor, { id: p.id, visibility: p.visibility as 'workspace' | 'private' }),
  ]));
  const sets: { viewer: string[]; editor: string[] } = { viewer: [], editor: [] };
  for (const s of spaces) {
    // The space of a deleted project is hidden with it, workspace visibility or not.
    if (s.projectId && !roleOfProject.has(s.projectId)) continue;
    const rank = spaceAccessRank(actor.access, {
      visibility: s.visibility as 'workspace' | 'private',
      spaceId: s.id,
      inheritedProjectRole: s.projectId ? roleOfProject.get(s.projectId) ?? null : null,
      projectLinked: !!s.projectId,
    });
    if (rank >= SPACE_RANK.viewer) sets.viewer.push(s.id);
    if (rank >= SPACE_RANK.editor) sets.editor.push(s.id);
  }
  anyActor[spaceCacheKey] = sets;
  return sets;
}

export async function accessibleSpaceIds(actor: Actor, opts?: { fresh?: boolean }): Promise<string[]> {
  return (await spaceAccessSets(actor, opts)).viewer;
}

/** The spaces the actor edits – the isEditor half of canSeePage, in bulk. */
export async function editableSpaceIds(actor: Actor): Promise<string[]> {
  return (await spaceAccessSets(actor)).editor;
}

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
 * effectiveProjectRole for projects that may be deleted. The access context
 * skips memberships of deleted projects, so the actor's own rows for those are
 * read here; the role is what the actor held while the project was alive, so
 * a deleted private project stays as closed as it was.
 */
export async function effectiveProjectRolesIncludingDeleted(
  actor: Actor,
  projects: { id: string; visibility: 'workspace' | 'private' }[],
): Promise<Map<string, 'admin' | 'member' | 'viewer' | null>> {
  const out = new Map<string, 'admin' | 'member' | 'viewer' | null>();
  if (!projects.length) return out;
  const memberships = new Map(actor.access.projectMemberships);
  const unknown = projects.map((p) => p.id).filter((id) => !memberships.has(id));
  if (unknown.length) {
    const { db } = getDb();
    const rows = await db.select({ projectId: schema.projectMembers.projectId, role: schema.projectMembers.role })
      .from(schema.projectMembers)
      .where(and(eq(schema.projectMembers.userId, actor.userId), inArray(schema.projectMembers.projectId, unknown)));
    for (const r of rows) memberships.set(r.projectId, r.role as 'admin' | 'member' | 'viewer');
  }
  const asBefore: Actor = { ...actor, access: { ...actor.access, projectMemberships: memberships } };
  for (const p of projects) out.set(p.id, effectiveProjectRole(asBefore, p));
  return out;
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
    if (!project) throw err.notFound('Space not found'); // went with its deleted project
    inheritedProjectRole = effectiveProjectRole(actor, {
      id: project.id,
      visibility: project.visibility as 'workspace' | 'private',
    });
  }
  const rank = spaceAccessRank(actor.access, {
    visibility: space.visibility as 'workspace' | 'private',
    spaceId,
    inheritedProjectRole,
    projectLinked: !!space.projectId,
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

/**
 * Whether a given person (not the request's actor) can open a project now, by
 * the rule every request is held to: role permissions plus memberships. Used
 * where someone is named on a project's work – a task's reporter – and before
 * telling them about it, so news never reaches someone the project is closed to.
 * An agent opens only the projects it is a member of. A deleted project, an
 * inactive or unknown user: no.
 */
export async function userCanOpenProject(userId: string, projectId: string): Promise<boolean> {
  const { db } = getDb();
  const [user] = await db.select({ id: schema.users.id, isActive: schema.users.isActive, actorType: schema.users.actorType, roleId: schema.users.roleId })
    .from(schema.users).where(eq(schema.users.id, userId));
  if (!user || !user.isActive) return false;
  const [project] = await db.select({ visibility: schema.projects.visibility })
    .from(schema.projects).where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)));
  if (!project) return false;
  const access = await buildAccessContext(user.id, await loadRolePermissions(user.roleId), false);
  if (user.actorType === 'agent') return access.projectMemberships.has(projectId);
  return projectAccessRank(access, { visibility: project.visibility as 'workspace' | 'private', projectId }) > 0;
}

/**
 * A person's own agent reaches what its owner reaches – the owner's
 * memberships and, through the given permissions (already intersected with
 * the owner's), workspace projects – but as a member at most on a project and
 * a reader on a space: it works tasks, it does not run projects. Built on
 * every request, so losing a project or a permission takes effect at once.
 */
export async function buildPersonalAgentAccess(ownerUserId: string, permissions: Set<string>, readOnly: boolean): Promise<AccessContext> {
  const base = await buildAccessContext(ownerUserId, permissions, readOnly, 'user');
  return {
    ...base,
    projectMemberships: new Map([...base.projectMemberships].map(([id, role]) => [id, role === 'admin' ? 'member' : role])),
    spaceMemberships: new Map([...base.spaceMemberships].map(([id]) => [id, 'viewer' as const])),
    membershipOnlyProjects: false,
    projectRankCap: 2,
    spaceRankCap: 1,
  };
}
