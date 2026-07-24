import { describe, it, expect } from 'vitest';
import { hasPermission, canAccessProject, canAccessSpace, validateTokenScope, type AccessContext } from './rbac';

function ctx(perms: string[], projects: [string, 'admin' | 'member' | 'viewer'][] = []): AccessContext {
  return {
    permissions: new Set(perms),
    projectMemberships: new Map(projects),
    spaceMemberships: new Map(),
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
  it('write requires membership even on workspace project', () => {
    expect(canAccessProject(ctx(['projects.read']), { visibility: 'workspace', projectId: 'p1', minRole: 'member' })).toBe(false);
    expect(canAccessProject(ctx(['projects.read'], [['p1', 'admin']]), { visibility: 'workspace', projectId: 'p1', minRole: 'admin' })).toBe(true);
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
