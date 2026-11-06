/**
 * The org structure counts the people in a department or position now: a card
 * marked terminated or an account that was deactivated has left, and is
 * reported apart as former.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let deptId: string;
let posId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  deptId = (await json(owner.post('/departments', { name: 'Sales' }))).id;
  posId = (await json(owner.post('/positions', { title: 'Sales Manager' }))).id;
  const unit = { departmentId: deptId, positionId: posId };
  // Still here.
  await owner.post('/employees', { firstName: 'Iryna', ...unit });
  // Card terminated.
  const gone = (await json(owner.post('/employees', { firstName: 'Taras', ...unit }))).id;
  const card = await json(owner.get(`/employees/${gone}`));
  const res = await owner.patch(`/employees/${gone}`, { status: 'terminated', version: card.version });
  expect(res.status).toBeLessThan(300);
  // Account deactivated, card left as it was.
  await owner.post('/employees', { firstName: 'Member', userId: users.member!.userId, ...unit });
  await owner.post(`/users/${users.member!.userId}/deactivate`);
});

describe('org headcount', () => {
  it('counts a department\'s current people and reports the former apart', async () => {
    const { data } = await json(reqAs(users.owner!.cookie).get('/departments'));
    expect(data.find((d: { id: string }) => d.id === deptId)).toMatchObject({ name: 'Sales', activeCount: 1, formerCount: 2 });
  });

  it('counts a position the same way', async () => {
    const { data } = await json(reqAs(users.owner!.cookie).get('/positions'));
    expect(data.find((p: { id: string }) => p.id === posId)).toMatchObject({ title: 'Sales Manager', activeCount: 1, formerCount: 2 });
  });
});
