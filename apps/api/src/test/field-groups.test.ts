/**
 * Field groups as access boundaries (PRD §5.5 extension). Employee custom
 * fields split into groups; roles get read grants in the RBAC matrix, the
 * 'self' principal covers the person the record is about, and roles holding
 * people.write (HR) implicitly hold everything. Enforcement is server-side:
 * reads strip what the viewer may not see, the self-service endpoint accepts
 * only self-writable keys.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { generateToken } from '../lib/crypto';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;

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

let hr: Awaited<ReturnType<typeof customRole>>;
let member: Awaited<ReturnType<typeof customRole>>;
let owner: ReturnType<typeof reqAs>;

let anketaGroup = '';
let hrOnlyGroup = '';
let employeeId = '';

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  hr = await customRole('HR', ['people.read', 'people.write']);
  member = await customRole('Member', ['people.read']);

  anketaGroup = (await json(owner.post('/custom-field-groups', { entityType: 'employees', name: 'Анкета' }))).id;
  hrOnlyGroup = (await json(owner.post('/custom-field-groups', { entityType: 'employees', name: 'Internal' }))).id;

  await owner.post('/custom-fields', { entityType: 'employees', key: 'tshirt', label: 'T-shirt', type: 'text', groupId: anketaGroup });
  await owner.post('/custom-fields', { entityType: 'employees', key: 'note', label: 'Note', type: 'text', groupId: hrOnlyGroup });
  await owner.post('/custom-fields', { entityType: 'employees', key: 'plain', label: 'Plain', type: 'text' });

  // The questionnaire group: the person themselves may fill it in.
  await owner.put(`/custom-field-groups/${anketaGroup}/grants`, { grants: [{ principal: 'self', level: 'write' }] });

  employeeId = (await json(hr.as.post('/employees', {
    firstName: 'Mira', lastName: 'K', userId: member.userId,
    customFields: { tshirt: 'L', note: 'secret', plain: 'visible' },
  }))).id;
});

describe('group management is settings/rbac territory', () => {
  it('a plain role can neither create groups nor edit grants', async () => {
    expect((await member.as.post('/custom-field-groups', { entityType: 'employees', name: 'X' })).status).toBe(403);
    expect((await member.as.put(`/custom-field-groups/${anketaGroup}/grants`, { grants: [] })).status).toBe(403);
  });
});

describe('reading grouped fields', () => {
  it('HR (people.write) sees every group and gets write access on all of them', async () => {
    const e = await json(hr.as.get(`/employees/${employeeId}`));
    expect(e.customFields).toMatchObject({ tshirt: 'L', note: 'secret', plain: 'visible' });
    expect(e.fieldAccess[anketaGroup]).toBe('write');
    expect(e.fieldAccess[hrOnlyGroup]).toBe('write');
  });

  it('an ungranted viewer loses grouped values but keeps ungrouped ones', async () => {
    // The member IS the record's person here – self has write on Анкета, so
    // tshirt stays; the Internal group has no grants at all and disappears.
    const e = await json(member.as.get(`/employees/${employeeId}`));
    expect(e.customFields.plain).toBe('visible');
    expect(e.customFields.tshirt).toBe('L');
    expect(e.customFields.note).toBeUndefined();
    expect(e.fieldAccess[hrOnlyGroup]).toBeUndefined();
  });

  it('a role read grant opens a group for that role', async () => {
    const stranger = await customRole('Stranger', ['people.read']);
    let e = await json(stranger.as.get(`/employees/${employeeId}`));
    expect(e.customFields.tshirt).toBeUndefined();
    await owner.put(`/custom-field-groups/${anketaGroup}/grants`, {
      grants: [{ principal: 'self', level: 'write' }, { principal: `role:${stranger.roleId}`, level: 'read' }],
    });
    e = await json(stranger.as.get(`/employees/${employeeId}`));
    expect(e.customFields.tshirt).toBe('L');
    expect(e.fieldAccess[anketaGroup]).toBe('read');
    expect(e.customFields.note).toBeUndefined();
  });
});

describe('the questionnaire (self-service)', () => {
  it('lists only self-granted groups with current values', async () => {
    const mine = await json(member.as.get('/me/hr-fields'));
    expect(mine.linked).toBe(true);
    expect(mine.groups.map((g: any) => g.id)).toEqual([anketaGroup]);
    const tshirt = mine.groups[0].fields.find((f: any) => f.key === 'tshirt');
    expect(tshirt.value).toBe('L');
  });

  it('saves self-writable keys and stamps the questionnaire date', async () => {
    const updated = await json(member.as.patch('/me/hr-fields', { customFields: { tshirt: 'M' } }));
    expect(updated.groups[0].fields.find((f: any) => f.key === 'tshirt').value).toBe('M');
    expect(updated.updatedAt).toBeTruthy();
    const e = await json(hr.as.get(`/employees/${employeeId}`));
    expect(e.customFields.tshirt).toBe('M');
    expect(e.questionnaireUpdatedAt).toBeTruthy();
  });

  it('rejects keys outside the self-writable groups', async () => {
    expect((await member.as.patch('/me/hr-fields', { customFields: { note: 'hijack' } })).status).toBe(403);
    expect((await member.as.patch('/me/hr-fields', { customFields: { plain: 'hijack' } })).status).toBe(403);
    const e = await json(hr.as.get(`/employees/${employeeId}`));
    expect(e.customFields.note).toBe('secret');
    expect(e.customFields.plain).toBe('visible');
  });

  it('an account with no employee record simply has no questionnaire', async () => {
    const loner = await customRole('Loner', []);
    const mine = await json(loner.as.get('/me/hr-fields'));
    expect(mine.linked).toBe(false);
    expect((await loner.as.patch('/me/hr-fields', { customFields: { tshirt: 'S' } })).status).toBe(422);
  });
});

describe('group deletion degrades gracefully', () => {
  it('fields of a deleted group fall back to ungrouped and stay visible', async () => {
    const g = (await json(owner.post('/custom-field-groups', { entityType: 'employees', name: 'Temp' }))).id;
    await owner.post('/custom-fields', { entityType: 'employees', key: 'temp_field', label: 'Temp', type: 'text' });
    const defs = (await json(owner.get('/custom-fields?entityType=employees'))).data as any[];
    const def = defs.find((d) => d.key === 'temp_field');
    await owner.patch(`/custom-fields/${def.id}`, { groupId: g });
    await owner.del(`/custom-field-groups/${g}`);
    const after = (await json(owner.get('/custom-fields?entityType=employees'))).data as any[];
    expect(after.find((d) => d.key === 'temp_field').groupId).toBeNull();
  });
});
