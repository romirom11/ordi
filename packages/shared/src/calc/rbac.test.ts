import { describe, it, expect } from 'vitest';
import { hasPermission, canAccessProject, canAccessSpace, validateTokenScope, type AccessContext } from './rbac';

function ctx(
  perms: string[],
  projects: [string, 'admin' | 'member' | 'viewer'][] = [],
  spaces: [string, 'editor' | 'viewer'][] = [],
): AccessContext {
  return {
    permissions: new Set(perms),
    projectMemberships: new Map(projects),
    spaceMemberships: new Map(spaces),
  };
}

describe('hasPermission', () => {
  it('grants known permission in set', () => {
    expect(hasPermission(ctx(['finance.read']), 'finance.read')).toBe(true);
  });
  it('denies unknown permission (fail closed)', () => {
    expect(hasPermission(ctx(['finance.read', 'made.up']), 'made.up')).toBe(false);
  });
  it('denies missing permission', () => {
    expect(hasPermission(ctx(['crm.read']), 'finance.read')).toBe(false);
  });
});

describe('canAccessProject', () => {
  it('workspace project visible to projects.read', () => {
    expect(canAccessProject(ctx(['projects.read']), { visibility: 'workspace', projectId: 'p1' })).toBe(true);
  });
  it('private project invisible to non-member', () => {
    expect(canAccessProject(ctx(['projects.read']), { visibility: 'private', projectId: 'p1' })).toBe(false);
  });
  it('private project visible to member', () => {
    expect(canAccessProject(ctx(['projects.read'], [['p1', 'member']]), { visibility: 'private', projectId: 'p1' })).toBe(true);
  });
  it('read alone stays read-only on a workspace project', () => {
    expect(canAccessProject(ctx(['projects.read']), { visibility: 'workspace', projectId: 'p1', minRole: 'member' })).toBe(false);
    expect(canAccessProject(ctx(['projects.read'], [['p1', 'admin']]), { visibility: 'workspace', projectId: 'p1', minRole: 'admin' })).toBe(true);
  });
  it('projects.write works a workspace project without a membership row', () => {
    const writer = ctx(['projects.read', 'projects.write']);
    expect(canAccessProject(writer, { visibility: 'workspace', projectId: 'p1', minRole: 'member' })).toBe(true);
    expect(canAccessProject(writer, { visibility: 'workspace', projectId: 'p1', minRole: 'admin' })).toBe(true);
  });
  it('projects.write does not reach into a private project', () => {
    const writer = ctx(['projects.read', 'projects.write']);
    expect(canAccessProject(writer, { visibility: 'private', projectId: 'p1' })).toBe(false);
    expect(canAccessProject(writer, { visibility: 'private', projectId: 'p1', minRole: 'member' })).toBe(false);
  });
  it('never grants more than the listing does: no projects.read, no access', () => {
    // accessibleProjectIds keys workspace listing off projects.read, so writing
    // without it would mean a project that answers but is listed nowhere.
    expect(canAccessProject(ctx(['projects.write']), { visibility: 'workspace', projectId: 'p1' })).toBe(false);
    expect(canAccessProject(ctx(['projects.write']), { visibility: 'workspace', projectId: 'p1', minRole: 'admin' })).toBe(false);
  });
  it('membership still wins where permissions stop', () => {
    expect(canAccessProject(ctx([], [['p1', 'admin']]), { visibility: 'private', projectId: 'p1', minRole: 'admin' })).toBe(true);
  });
});

describe('canAccessSpace with project inheritance', () => {
  it('project member inherits editor', () => {
    expect(canAccessSpace(ctx(['kb.read']), { visibility: 'private', spaceId: 's1', minRole: 'editor', inheritedProjectRole: 'member' })).toBe(true);
  });
  it('project viewer inherits viewer only', () => {
    expect(canAccessSpace(ctx(['kb.read']), { visibility: 'private', spaceId: 's1', minRole: 'editor', inheritedProjectRole: 'viewer' })).toBe(false);
  });
});

describe('canAccessSpace on workspace spaces', () => {
  it('kb.read reads, kb.write edits – no membership row needed', () => {
    expect(canAccessSpace(ctx(['kb.read']), { visibility: 'workspace', spaceId: 's1' })).toBe(true);
    expect(canAccessSpace(ctx(['kb.read']), { visibility: 'workspace', spaceId: 's1', minRole: 'editor' })).toBe(false);
    expect(canAccessSpace(ctx(['kb.read', 'kb.write']), { visibility: 'workspace', spaceId: 's1', minRole: 'editor' })).toBe(true);
  });
  it('private space stays members-only, whatever kb.write says', () => {
    expect(canAccessSpace(ctx(['kb.read', 'kb.write']), { visibility: 'private', spaceId: 's1' })).toBe(false);
    expect(canAccessSpace(ctx(['kb.read', 'kb.write'], [], [['s1', 'viewer']]), { visibility: 'private', spaceId: 's1', minRole: 'editor' })).toBe(false);
    expect(canAccessSpace(ctx(['kb.read'], [], [['s1', 'editor']]), { visibility: 'private', spaceId: 's1', minRole: 'editor' })).toBe(true);
  });
  it('kb.write without kb.read grants nothing (the space is listed nowhere)', () => {
    expect(canAccessSpace(ctx(['kb.write']), { visibility: 'workspace', spaceId: 's1', minRole: 'editor' })).toBe(false);
  });
});

describe('validateTokenScope', () => {
  it('rejects scope wider than owner role', () => {
    const r = validateTokenScope(new Set(['crm.read']), ['crm.read', 'finance.read']);
    expect(r.ok).toBe(false);
    expect(r.invalid).toContain('finance.read');
  });
  it('accepts subset', () => {
    expect(validateTokenScope(new Set(['crm.read', 'finance.read']), ['crm.read']).ok).toBe(true);
  });
});
