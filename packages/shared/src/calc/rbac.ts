/**
 * Pure RBAC resolver (PRD §4.1). Final rule:
 *   allowed = hasPermission(role, required) AND (unrestricted OR isResourceMember)
 * Fail closed: unknown permission = denied.
 *
 * "Unrestricted" is what `workspace` visibility means, and it applies to the
 * whole rule, not only to reads: on a workspace project/space the role's own
 * permissions decide the level (projects.write => project admin, kb.write =>
 * space editor), while `private` resources are membership-only. Requiring an
 * explicit membership row for every write made the write permissions dead on
 * arrival – a role with kb.write could not create a page anywhere, and one
 * with projects.write could not touch a project it was not added to, both
 * failing as "not found" on a resource the app had just listed.
 */
import { isPermission, type Permission } from '../permissions';

export interface AccessContext {
  permissions: Set<string>;
  /** projectId -> membership role */
  projectMemberships: Map<string, 'admin' | 'member' | 'viewer'>;
  /** spaceId -> membership role */
  spaceMemberships: Map<string, 'editor' | 'viewer'>;
  isReadOnlyToken?: boolean;
}

export function hasPermission(ctx: AccessContext, required: string): boolean {
  if (!isPermission(required)) return false; // unknown = denied
  return ctx.permissions.has(required);
}

const PROJECT_ROLE_RANK: Record<string, number> = { viewer: 1, member: 2, admin: 3 };
const SPACE_ROLE_RANK: Record<string, number> = { viewer: 1, editor: 2 };

/**
 * What a `workspace`-visible project grants on permissions alone – it is the
 * "unrestricted resource" of the authorization rule, so the global permission
 * decides the level and membership is what private projects need.
 *
 * `projects.read` is the floor for both this and `accessibleProjectIds`, which
 * keeps a project openable exactly when it is listed: a project the user can
 * write but not see would show up nowhere and still answer.
 */
function workspaceProjectRank(permissions: Set<string>): number {
  if (!permissions.has('projects.read')) return 0;
  return permissions.has('projects.write') ? PROJECT_ROLE_RANK.admin! : PROJECT_ROLE_RANK.viewer!;
}

/** Same idea for a `workspace`-visible space: kb.read views, kb.write edits. */
function workspaceSpaceRank(permissions: Set<string>): number {
  if (!permissions.has('kb.read')) return 0;
  return permissions.has('kb.write') ? SPACE_ROLE_RANK.editor! : SPACE_ROLE_RANK.viewer!;
}

/** The level the actor holds on a project, membership or permissions, 0 = none. */
export function projectAccessRank(
  ctx: AccessContext,
  params: { visibility: 'workspace' | 'private'; projectId: string },
): number {
  const membership = ctx.projectMemberships.get(params.projectId);
  const memberRank = membership ? PROJECT_ROLE_RANK[membership] ?? 0 : 0;
  const permRank = params.visibility === 'workspace' ? workspaceProjectRank(ctx.permissions) : 0;
  return Math.max(memberRank, permRank);
}

export function canAccessProject(
  ctx: AccessContext,
  params: { visibility: 'workspace' | 'private'; projectId: string; minRole?: 'viewer' | 'member' | 'admin' },
): boolean {
  const minRank = PROJECT_ROLE_RANK[params.minRole ?? 'viewer']!;
  return projectAccessRank(ctx, params) >= minRank;
}

/** The level the actor holds on a space, membership/inheritance or permissions. */
export function spaceAccessRank(
  ctx: AccessContext,
  params: {
    visibility: 'workspace' | 'private';
    spaceId: string;
    inheritedProjectRole?: 'admin' | 'member' | 'viewer' | null;
  },
): number {
  const membership = ctx.spaceMemberships.get(params.spaceId);
  const memberRank = membership ? SPACE_ROLE_RANK[membership] ?? 0 : 0;
  // Project-linked space inherits project membership (admin/member => editor, viewer => viewer).
  const inheritedRank = params.inheritedProjectRole
    ? SPACE_ROLE_RANK[params.inheritedProjectRole === 'viewer' ? 'viewer' : 'editor']!
    : 0;
  const permRank = params.visibility === 'workspace' ? workspaceSpaceRank(ctx.permissions) : 0;
  return Math.max(memberRank, inheritedRank, permRank);
}

export function canAccessSpace(
  ctx: AccessContext,
  params: {
    visibility: 'workspace' | 'private';
    spaceId: string;
    minRole?: 'viewer' | 'editor';
    inheritedProjectRole?: 'admin' | 'member' | 'viewer' | null;
  },
): boolean {
  const minRank = SPACE_ROLE_RANK[params.minRole ?? 'viewer']!;
  return spaceAccessRank(ctx, params) >= minRank;
}

/**
 * Page-level visibility inside an accessible space (PRD §9.3): a draft is for
 * the space's editors, a `private` page for its author and the editors. One
 * function, because the rule used to live only in the KB list/get path while
 * search, feeds, versions and backlinks each answered on space access alone –
 * every one of them leaked what the page tree itself refused to show.
 */
export function canSeePage(
  page: { published: boolean; visibility: string; createdBy: string | null },
  userId: string,
  isEditor: boolean,
): boolean {
  if (!page.published && !isEditor) return false;
  if (page.visibility === 'private' && !isEditor && page.createdBy !== userId) return false;
  return true;
}

/** API token scope must be a subset of the owner's role permissions (PRD §4.5.5). */
export function validateTokenScope(ownerPermissions: Set<string>, requestedScopes: Permission[]): {
  ok: boolean;
  invalid: string[];
} {
  const invalid = requestedScopes.filter((s) => !ownerPermissions.has(s));
  return { ok: invalid.length === 0, invalid };
}

/**
 * Project secrets (plan 2026-11-05-001, R43-R56): three layers that must all
 * agree, each answering one question.
 *
 *   workspace role  – what may this person do with secrets at all
 *                     (secrets.read / reveal / write / manage);
 *   project role    – where: viewer lists, member or admin reveals and writes;
 *   audience        – which secret: the whole project, named people,
 *                     departments, chosen per secret.
 *
 * No layer widens another. `secrets.manage` is the one exception to the
 * audience: it may change who has access to any secret in a project the
 * person can open, without seeing a value. Every surface (routes, MCP,
 * resources, activity) asks this one function, so the rule lives once.
 */
export type SecretAudiencePrincipal =
  | { type: 'project' }
  | { type: 'user'; id: string }
  | { type: 'department'; id: string };

export interface SecretAccessInput {
  permissions: Set<string>;
  /** The actor's effective role on the secret's project; null = cannot open it. */
  projectRole: 'admin' | 'member' | 'viewer' | null;
  audience: SecretAudiencePrincipal[];
  userId: string;
  /** The actor's department and every department above it. */
  departmentIds: ReadonlySet<string>;
}

export interface SecretAccess {
  /** Sees the secret exists: its name, fields and metadata. */
  list: boolean;
  /** Reveals and copies values. */
  reveal: boolean;
  /** Edits fields, values and description; deletes. */
  write: boolean;
  /** Changes audience, environment and agent use without being in the audience. */
  manage: boolean;
  /** The audience names the actor, by project, person or department. */
  inAudience: boolean;
}

/** Whether the audience names this person (the project principal names everyone on the project). */
export function secretAudienceIncludes(
  audience: SecretAudiencePrincipal[],
  userId: string,
  departmentIds: ReadonlySet<string>,
): boolean {
  return audience.some((p) => p.type === 'project'
    || (p.type === 'user' && p.id === userId)
    || (p.type === 'department' && departmentIds.has(p.id)));
}

/** A secret open to the whole project, as opposed to one restricted to people or departments. */
export function isProjectWideSecret(audience: SecretAudiencePrincipal[]): boolean {
  return audience.some((p) => p.type === 'project');
}

export function secretAccess(input: SecretAccessInput): SecretAccess {
  const none = { list: false, reveal: false, write: false, manage: false, inAudience: false };
  if (!input.projectRole) return none;
  const rank = PROJECT_ROLE_RANK[input.projectRole] ?? 0;
  const contributor = rank >= PROJECT_ROLE_RANK.member!;
  const inAudience = secretAudienceIncludes(input.audience, input.userId, input.departmentIds);
  const manage = input.permissions.has('secrets.manage');
  const read = input.permissions.has('secrets.read') || manage;
  // A restricted secret is invisible outside its audience: its name alone can say too much.
  const list = read && (isProjectWideSecret(input.audience) || inAudience || manage);
  return {
    list,
    reveal: contributor && inAudience && input.permissions.has('secrets.reveal'),
    write: contributor && inAudience && input.permissions.has('secrets.write'),
    manage,
    inAudience,
  };
}
