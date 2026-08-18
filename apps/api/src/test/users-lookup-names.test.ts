/**
 * /users/lookup names people by their linked HR employee card: users.name is
 * whatever the person typed at signup (often a bare first name), while the
 * employee card is where the real full name lives. Member lists, pickers and
 * @mentions all read this route, so the preference fixes them in one place.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
});

describe('/users/lookup names', () => {
  it('prefers the linked employee card over the signup name, and only for card holders', async () => {
    const member = reqAs(users.member!.cookie);
    const before = (await json(member.get('/users/lookup'))).data as { id: string; name: string }[];
    const signupName = before.find((u) => u.id === users.member!.userId)!.name;
    const managerName = before.find((u) => u.id === users.manager!.userId)!.name;

    const hr = reqAs(users.hr!.cookie);
    await json(hr.post('/employees', {
      firstName: 'Vasyl', lastName: 'Petrenko', userId: users.member!.userId,
    }));

    const after = (await json(member.get('/users/lookup'))).data as { id: string; name: string }[];
    expect(after.find((u) => u.id === users.member!.userId)!.name).toBe('Vasyl Petrenko');
    expect(after.find((u) => u.id === users.member!.userId)!.name).not.toBe(signupName);
    // No card linked – the signup name stays.
    expect(after.find((u) => u.id === users.manager!.userId)!.name).toBe(managerName);
  });
});
