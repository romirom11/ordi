/**
 * HR dashboard: lists of people that need attention, and a headcount that
 * leaves out people whose card is terminated or whose account is deactivated.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { nextOccurrence } from '../domains/people/service';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
const ids: Record<string, string> = {};

const dayOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
/** A birth or join date whose anniversary falls `days` from now, `years` back. */
const yearsAgo = (years: number, days: number) => {
  const d = dayOffset(days);
  return `${Number(d.slice(0, 4)) - years}${d.slice(4)}`;
};

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();
  const emp = async (key: string, values: Partial<typeof schema.employees.$inferInsert>) => {
    ids[key] = ulid();
    await db.insert(schema.employees).values({ id: ids[key]!, firstName: key, lastName: 'Test', ...values });
  };
  await emp('Olena', { birthday: yearsAgo(30, 3), joinDate: yearsAgo(2, 10) });
  await emp('Petro', { joinDate: dayOffset(-5) });
  await emp('Gone', { status: 'terminated', exitDate: dayOffset(-2), birthday: yearsAgo(40, 1) });
  // Card still active, account deactivated: has left all the same.
  await emp('Member', { userId: users.member!.userId, birthday: yearsAgo(25, 2) });
  await reqAs(users.owner!.cookie).post(`/users/${users.member!.userId}/deactivate`);

  const typeId = ulid();
  await db.insert(schema.leaveTypes).values({ id: typeId, name: 'Vacation' });
  await db.insert(schema.leaveRequests).values([
    { id: ulid(), employeeId: ids.Olena!, leaveTypeId: typeId, fromDate: dayOffset(1), toDate: dayOffset(3), status: 'approved' },
    { id: ulid(), employeeId: ids.Petro!, leaveTypeId: typeId, fromDate: dayOffset(14), toDate: dayOffset(15), status: 'pending' },
    { id: ulid(), employeeId: ids.Member!, leaveTypeId: typeId, fromDate: dayOffset(0), toDate: dayOffset(2), status: 'approved' },
  ]);

  const stage = ulid();
  const hired = ulid();
  await db.insert(schema.applicantStages).values([
    { id: stage, name: 'Screening', position: 0 },
    { id: hired, name: 'Hired', position: 9, isHired: true },
  ]);
  const opening = ulid();
  await db.insert(schema.jobOpenings).values({ id: opening, title: 'Sales Manager', status: 'open', publicToken: ulid() });
  await db.insert(schema.applicants).values([
    { id: ulid(), jobOpeningId: opening, name: 'A', email: 'a@x.test', stageId: stage },
    { id: ulid(), jobOpeningId: opening, name: 'B', email: 'b@x.test', stageId: hired },
  ]);
});

describe('HR dashboard', () => {
  it('counts only the people still here', async () => {
    const d = await json(reqAs(users.owner!.cookie).get('/people/dashboard'));
    expect(d.headcount.active).toBe(2);
  });

  it('lists leave to decide and who is away this week, without people who left', async () => {
    const d = await json(reqAs(users.owner!.cookie).get('/people/dashboard'));
    expect(d.pendingLeave).toEqual([expect.objectContaining({ employeeId: ids.Petro, name: 'Petro Test', leaveType: 'Vacation' })]);
    expect(d.awayThisWeek.map((l: { employeeId: string }) => l.employeeId)).toEqual([ids.Olena]);
  });

  it('lists birthdays, anniversaries, joiners and leavers', async () => {
    const d = await json(reqAs(users.owner!.cookie).get('/people/dashboard'));
    expect(d.dates).toEqual([
      expect.objectContaining({ kind: 'birthday', employeeId: ids.Olena, date: dayOffset(3) }),
      expect.objectContaining({ kind: 'anniversary', employeeId: ids.Olena, date: dayOffset(10), years: 2 }),
    ]);
    expect(d.joiners.map((m: { employeeId: string }) => m.employeeId)).toContain(ids.Petro);
    expect(d.leavers.map((m: { employeeId: string }) => m.employeeId)).toEqual([ids.Gone]);
  });

  it('counts candidates still in play per open role, without their names', async () => {
    const d = await json(reqAs(users.owner!.cookie).get('/people/dashboard'));
    expect(d.recruiting.openRoles).toEqual([expect.objectContaining({ title: 'Sales Manager', activeCandidates: 1 })]);
    expect(d.recruiting.stages).toEqual([{ stageId: expect.any(String), name: 'Screening', count: 1 }]);
    expect(JSON.stringify(d.recruiting)).not.toContain('a@x.test');
  });

  it('keeps openings and stages from someone without people.recruit', async () => {
    // A role that reads people but does not recruit.
    const { db } = getDb();
    const roleId = ulid();
    const userId = ulid();
    const token = `t-${ulid()}`;
    await db.insert(schema.roles).values({ id: roleId, key: 'people_viewer', name: 'People viewer', description: '', isSystem: false });
    await db.insert(schema.rolePermissions).values({ roleId, permission: 'people.read' });
    await db.insert(schema.users).values({ id: userId, email: 'viewer@test.local', name: 'Viewer', passwordHash: 'x', roleId });
    await db.insert(schema.sessions).values({ id: ulid(), userId, token, expiresAt: new Date(Date.now() + 3600_000) });
    const d = await json(reqAs(`ordi_session=${token}`).get('/people/dashboard'));
    expect(d.recruiting).toBeNull();
    expect(d.canRecruit).toBe(false);
    expect(d.openJobOpenings).toBe(1);
  });
});

describe('nextOccurrence', () => {
  it('rolls over to next year once the day has passed', () => {
    expect(nextOccurrence('1990-03-10', '2026-11-06')).toEqual({ date: '2027-03-10', years: 37 });
    expect(nextOccurrence('1990-11-06', '2026-11-06')).toEqual({ date: '2026-11-06', years: 36 });
  });

  it('puts 29 February on 28 February outside a leap year', () => {
    expect(nextOccurrence('2000-02-29', '2026-11-06')).toEqual({ date: '2027-02-28', years: 27 });
    expect(nextOccurrence('2000-02-29', '2027-11-06')).toEqual({ date: '2028-02-29', years: 28 });
  });
});
