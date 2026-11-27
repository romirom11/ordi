/**
 * A role change binds every server process at once.
 *
 * The report: a role's permissions were cached in each process and cleared
 * only in the process whose role editor saved the change. The API, the agent
 * worker and any extra API replica each resolve actors, so everywhere else a
 * removed permission kept working until a restart. "Another process" is
 * simulated here by changing role_permissions directly in the database –
 * never through the roles route, which is the one place that used to clear
 * this process's cache – after this process has already read the role.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq, and } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, app } from './helpers';
import { generateToken, sha256 } from '../lib/crypto';
import { loadRolePermissions } from '../core/rbac';
import { userCanOpenProject } from '../core/access';

let roleId = '';
let cookie = '';
let rawToken = '';
let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;

const bearer = (path: string) => app.request(`/api/v1${path}`, { headers: { authorization: `Bearer ${rawToken}` } });

async function revoke(permission: string): Promise<void> {
  await getDb().db.delete(schema.rolePermissions)
    .where(and(eq(schema.rolePermissions.roleId, roleId), eq(schema.rolePermissions.permission, permission)));
}

async function grant(permission: string): Promise<void> {
  await getDb().db.insert(schema.rolePermissions).values({ roleId, permission }).onConflictDoNothing();
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();
  roleId = ulid();
  await db.insert(schema.roles).values({ id: roleId, key: `custom_${roleId}`, name: 'Account manager', description: 'custom', isSystem: false });
  await db.insert(schema.rolePermissions).values(['crm.read', 'projects.read'].map((permission) => ({ roleId, permission })));
  const userId = ulid();
  await db.insert(schema.users).values({ id: userId, email: `${roleId}@test.local`, name: 'Account manager', passwordHash: 'x', roleId });
  const session = generateToken();
  await db.insert(schema.sessions).values({ id: ulid(), userId, token: session, expiresAt: new Date(Date.now() + 3600_000) });
  cookie = `ordi_session=${session}`;
  rawToken = `ordi_${generateToken(24)}`;
  await db.insert(schema.apiTokens).values({
    id: ulid(), userId, name: 'script', hash: sha256(rawToken), prefix: rawToken.slice(0, 12), scopes: ['crm.read'], readOnly: false,
  });
});

describe('a permission taken off a role', () => {
  it('stops working on the next signed-in request', async () => {
    const me = reqAs(cookie);
    expect((await me.get('/companies')).status).toBe(200);
    await revoke('crm.read');
    try {
      expect((await me.get('/companies')).status).toBe(403);
    } finally {
      await grant('crm.read');
    }
    // ...and a permission given back works on the next request too.
    expect((await me.get('/companies')).status).toBe(200);
  });

  it('stops working on the next API-token request, whatever the token’s scopes say', async () => {
    expect((await bearer('/companies')).status).toBe(200);
    await revoke('crm.read');
    try {
      expect((await bearer('/companies')).status).toBe(403);
    } finally {
      await grant('crm.read');
    }
  });

  it('is gone for background work too: the worker reads the role as it stands', async () => {
    // The notifications consumer and the agent worker ask the role directly.
    expect(await loadRolePermissions(roleId)).toContain('projects.read');
    const type = await (await reqAs(users.owner!.cookie).post('/project-types', { name: 'Ops', revenueSource: 'none' })).json() as { id: string };
    const project = await (await reqAs(users.owner!.cookie).post('/projects', { name: 'Ops', key: 'OPS', projectTypeId: type.id, visibility: 'workspace' })).json() as { id: string };
    const [user] = await getDb().db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.roleId, roleId));
    expect(await userCanOpenProject(user!.id, project.id)).toBe(true);

    await revoke('projects.read');
    try {
      expect(await loadRolePermissions(roleId)).not.toContain('projects.read');
      expect(await userCanOpenProject(user!.id, project.id)).toBe(false);
    } finally {
      await grant('projects.read');
    }
  });
});

describe('saving a role in the role editor', () => {
  const editRole = (permissions: string[]) =>
    reqAs(users.owner!.cookie).patch(`/roles/${roleId}`, { name: 'Account manager', description: 'custom', permissions });

  it('takes effect on the next request', async () => {
    const me = reqAs(cookie);
    expect((await me.get('/companies')).status).toBe(200);
    expect((await editRole(['projects.read'])).status).toBe(200);
    expect((await me.get('/companies')).status).toBe(403);
    expect((await editRole(['crm.read', 'projects.read'])).status).toBe(200);
    expect((await me.get('/companies')).status).toBe(200);
  });

  it('never leaves the role empty: a repeated permission is saved once', async () => {
    // The delete and the insert used to commit apart, and a repeated key
    // failed the insert after the delete had gone through.
    expect((await editRole(['crm.read', 'crm.read', 'projects.read'])).status).toBe(200);
    expect([...(await loadRolePermissions(roleId))].sort()).toEqual(['crm.read', 'projects.read']);
    expect((await reqAs(cookie).get('/companies')).status).toBe(200);
  });
});
