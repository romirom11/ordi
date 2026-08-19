/**
 * Account ↔ card pairing (ORD-19, stages 2 and 4): accepting an invite links
 * the waiting card or creates one, a card created for an existing account
 * links itself by email, and the leftover pairs surface as one-click link
 * suggestions.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { app, resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let memberRoleId: string;

async function invite(email: string, name: string): Promise<string> {
  const owner = reqAs(users.owner!.cookie);
  const res = await json(owner.post('/users/invite', { email, name, roleId: memberRoleId }));
  return new URL(res.inviteUrl).searchParams.get('token')!;
}

const accept = (token: string, name: string, password = 'password123') =>
  app.request('/api/v1/auth/accept-invite', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, name, password }),
  });

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  const roles = (await json(owner.get('/roles'))).data as any[];
  memberRoleId = roles.find((r) => r.key === 'member')!.id;
});

describe('invite acceptance and the HR card', () => {
  it('links the card that was waiting under the email, and takes its name', async () => {
    const hr = reqAs(users.hr!.cookie);
    const cardId = (await json(hr.post('/employees', {
      firstName: 'Olena', lastName: 'Shevchenko', email: 'olena@test.local',
    }))).id;

    const token = await invite('olena@test.local', 'Olena');
    const res = await accept(token, 'olena'); // typed a lowercase short name
    expect(res.status).toBe(200);
    const { userId } = await res.json() as { userId: string };

    const card = await json(hr.get(`/employees/${cardId}`));
    expect(card.userId).toBe(userId);
    // The card is canonical: the account name is the card's full name.
    const dir = (await json(hr.get('/users/lookup'))).data as any[];
    expect(dir.find((u) => u.id === userId)!.name).toBe('Olena Shevchenko');
  });

  it('creates a linked card from the invite when none was waiting', async () => {
    const token = await invite('petro@test.local', 'Petro');
    const res = await accept(token, 'Petro Bondar');
    expect(res.status).toBe(200);
    const { userId } = await res.json() as { userId: string };

    const hr = reqAs(users.hr!.cookie);
    const list = (await json(hr.get('/employees'))).data as any[];
    const card = list.find((e) => e.userId === userId);
    expect(card).toBeTruthy();
    expect(card.firstName).toBe('Petro');
    expect(card.lastName).toBe('Bondar');
  });
});

describe('card creation against an existing account', () => {
  it('auto-links by email and renames the account from the card', async () => {
    const hr = reqAs(users.hr!.cookie);
    const cardId = (await json(hr.post('/employees', {
      firstName: 'Dmytro', lastName: 'Kovalenko', email: 'member@test.local',
    }))).id;
    const card = await json(hr.get(`/employees/${cardId}`));
    expect(card.userId).toBe(users.member!.userId);
    const dir = (await json(hr.get('/users/lookup'))).data as any[];
    expect(dir.find((u) => u.id === users.member!.userId)!.name).toBe('Dmytro Kovalenko');
  });
});

describe('link suggestions', () => {
  it('surfaces an unlinked card whose email belongs to an account, and links it on demand', async () => {
    const hr = reqAs(users.hr!.cookie);
    // An unlinked card for the manager: created without email match first,
    // then given the email – the create-time auto-link must not fire here.
    const cardId = (await json(hr.post('/employees', { firstName: 'Marta', lastName: 'Manager' }))).id;
    const current = await json(hr.get(`/employees/${cardId}`));
    await json(hr.patch(`/employees/${cardId}`, { email: 'manager@test.local', version: current.version }));

    const suggestions = await json(hr.get('/people/link-suggestions'));
    const hit = suggestions.linkable.find((l: any) => l.employeeId === cardId);
    expect(hit).toMatchObject({ userId: users.manager!.userId, email: 'manager@test.local' });

    const linked = await json(hr.post(`/employees/${cardId}/link-user`, { userId: users.manager!.userId }));
    expect(linked.userId).toBe(users.manager!.userId);
    const after = await json(hr.get('/people/link-suggestions'));
    expect(after.linkable.some((l: any) => l.employeeId === cardId)).toBe(false);
    // The card renamed the account on link.
    const dir = (await json(hr.get('/users/lookup'))).data as any[];
    expect(dir.find((u) => u.id === users.manager!.userId)!.name).toBe('Marta Manager');
  });

  it('refuses to link a taken account or an already linked card', async () => {
    const hr = reqAs(users.hr!.cookie);
    const spareId = (await json(hr.post('/employees', { firstName: 'Spare' }))).id;
    // manager already carries a card from the previous test
    expect((await hr.post(`/employees/${spareId}/link-user`, { userId: users.manager!.userId })).status).toBe(422);
  });
});
