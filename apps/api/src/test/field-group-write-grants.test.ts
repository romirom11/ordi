/**
 * WRITE grants on employee field groups do what the RBAC matrix promises: a
 * role holding one edits exactly those custom fields via PATCH /employees/:id
 * without people.write – and nothing else.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { generateToken } from '../lib/crypto';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let owner: ReturnType<typeof reqAs>;
let teamlead: { userId: string; roleId: string; as: ReturnType<typeof reqAs> };
let employeeId = '';
let gearGroup = '';

async function customRole(name: string, permissions: string[]) {
  const { db } = getDb();
  const roleId = ulid();
  await db.insert(schema.roles).values({ id: roleId, key: `${name}-${roleId}`, name, description: 'custom', isSystem: false });
  if (permissions.length) {
    await db.insert(schema.rolePermissions).values(permissions.map((p) => ({ roleId, permission: p as any })));
  }
  const userId = ulid();
  await db.insert(schema.users).values({ id: userId, email: `${roleId}@test.local`, name, passwordHash: 'x', roleId });
  const token = generateToken();
  await db.insert(schema.sessions).values({ id: ulid(), userId, token, expiresAt: new Date(Date.now() + 3600_000) });
  return { userId, roleId, as: reqAs(`ordi_session=${token}`) };
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  // A teamlead: no people.* permission at all – only the group grant below.
  teamlead = await customRole('Teamlead', ['projects.read']);

  gearGroup = (await json(owner.post('/custom-field-groups', { entityType: 'employees', name: 'Обладнання' }))).id;
  await owner.post('/custom-fields', { entityType: 'employees', key: 'laptop', label: 'Laptop', type: 'text', groupId: gearGroup });
  await owner.post('/custom-fields', { entityType: 'employees', key: 'plain_note', label: 'Note', type: 'text' });
  await owner.put(`/custom-field-groups/${gearGroup}/grants`, {
    grants: [{ principal: `role:${teamlead.roleId}`, level: 'write' }],
  });

  employeeId = (await json(owner.post('/employees', {
    firstName: 'Ivan', lastName: 'S', customFields: { laptop: 'MBP 14', plain_note: 'hr only' },
  }))).id;
});

describe('field-group write grants in employee PATCH', () => {
  it('lets the grant holder edit the granted field without people.write', async () => {
    const res = await teamlead.as.patch(`/employees/${employeeId}`, { customFields: { laptop: 'ThinkPad X1' } });
    expect(res.status).toBe(200);
    const e = await json(owner.get(`/employees/${employeeId}`));
    expect(e.customFields.laptop).toBe('ThinkPad X1');
    // The rest of the blob is untouched (merge semantics).
    expect(e.customFields.plain_note).toBe('hr only');
  });

  it('tolerates the editor round-tripping unchanged read-only values', async () => {
    // The card's grid sends the whole visible map; unchanged keys must not 403.
    const seen = await json(teamlead.as.get(`/employees/${employeeId}`));
    const res = await teamlead.as.patch(`/employees/${employeeId}`, {
      customFields: { ...seen.customFields, laptop: 'Framework 16' },
    });
    expect(res.status).toBe(200);
  });

  it('refuses fields outside the granted group, and non-field columns', async () => {
    const otherField = await teamlead.as.patch(`/employees/${employeeId}`, { customFields: { plain_note: 'hijack' } });
    expect(otherField.status).toBe(403);

    const column = await teamlead.as.patch(`/employees/${employeeId}`, { firstName: 'Hacked' });
    expect(column.status).toBe(403);
  });

  it('read grants still cannot write', async () => {
    await owner.put(`/custom-field-groups/${gearGroup}/grants`, {
      grants: [{ principal: `role:${teamlead.roleId}`, level: 'read' }],
    });
    const res = await teamlead.as.patch(`/employees/${employeeId}`, { customFields: { laptop: 'stolen' } });
    expect(res.status).toBe(403);
  });
});
