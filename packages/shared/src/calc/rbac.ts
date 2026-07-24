/**
 * Pure RBAC resolver (PRD §4.1). Final rule:
 *   allowed = hasPermission(role, required) AND (unrestricted OR isResourceMember)
 * Fail closed: unknown permission = denied.
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

export function canAccessProject(
  ctx: AccessContext,
  params: { visibility: 'workspace' | 'private'; projectId: string; minRole?: 'viewer' | 'member' | 'admin' },
): boolean {
  const membership = ctx.projectMemberships.get(params.projectId);
  const minRank = PROJECT_ROLE_RANK[params.minRole ?? 'viewer']!;
  if (membership && PROJECT_ROLE_RANK[membership]! >= minRank) return true;
  // Workspace project: anyone with projects.read can view; write needs membership.
  if (params.visibility === 'workspace' && (params.minRole ?? 'viewer') === 'viewer') {
    return ctx.permissions.has('projects.read');
  }
  return false;
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
  const membership = ctx.spaceMemberships.get(params.spaceId);
  const minRank = SPACE_ROLE_RANK[params.minRole ?? 'viewer']!;
  if (membership && SPACE_ROLE_RANK[membership]! >= minRank) return true;
  // Project-linked space inherits project membership (admin/member => editor, viewer => viewer).
  if (params.inheritedProjectRole) {
    const inherited = params.inheritedProjectRole === 'viewer' ? 'viewer' : 'editor';
    if (SPACE_ROLE_RANK[inherited]! >= minRank) return true;
  }
  if (params.visibility === 'workspace' && (params.minRole ?? 'viewer') === 'viewer') {
    return ctx.permissions.has('kb.read');
  }
  return false;
}

/** API token scope must be a subset of the owner's role permissions (PRD §4.5.5). */
export function validateTokenScope(ownerPermissions: Set<string>, requestedScopes: Permission[]): {
  ok: boolean;
  invalid: string[];
} {
  const invalid = requestedScopes.filter((s) => !ownerPermissions.has(s));
  return { ok: invalid.length === 0, invalid };
}
