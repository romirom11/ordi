/**
 * One name per person (ORD-19, stage 1): the linked HR card and the account
 * spell the person identically, whichever side was edited. A card write
 * overwrites users.name with the card's full name; a profile rename walks
 * back into the card (first word → first name, the rest → last name).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let empId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const hr = reqAs(users.hr!.cookie);
  empId = (await json(hr.post('/employees', {
    firstName: 'Vasyl', lastName: 'Petrenko', userId: users.member!.userId,
  }))).id;
});

describe('name sync between account and HR card', () => {
  it('creating and editing the card renames the account', async () => {
    const member = reqAs(users.member!.cookie);
    expect((await json(member.get('/me'))).user.name).toBe('Vasyl Petrenko');

    const hr = reqAs(users.hr!.cookie);
    const current = await json(hr.get(`/employees/${empId}`));
    await json(hr.patch(`/employees/${empId}`, { lastName: 'Petrenko-Kovalchuk', version: current.version }));
    expect((await json(member.get('/me'))).user.name).toBe('Vasyl Petrenko-Kovalchuk');
  });

  it('renaming yourself in the profile walks back into the card', async () => {
    const member = reqAs(users.member!.cookie);
    expect((await member.patch('/me', { name: 'Василь Петренко' })).status).toBe(200);

    const hr = reqAs(users.hr!.cookie);
    const emp = await json(hr.get(`/employees/${empId}`));
    expect(emp.firstName).toBe('Василь');
    expect(emp.lastName).toBe('Петренко');
    // And the account took the same spelling, so the two cannot diverge.
    expect((await json(member.get('/me'))).user.name).toBe('Василь Петренко');
  });

  it('leaves accounts without a card alone', async () => {
    const manager = reqAs(users.manager!.cookie);
    const before = (await json(manager.get('/me'))).user.name;
    expect((await manager.patch('/me', { name: 'Just Manager' })).status).toBe(200);
    expect((await json(manager.get('/me'))).user.name).toBe('Just Manager');
    expect(before).not.toBe('Just Manager');
  });
});
