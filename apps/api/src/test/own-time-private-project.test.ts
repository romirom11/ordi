/**
 * Your own time does not reveal a private project you cannot open. A task
 * moved into one takes its logged time with it (the hours follow the work),
 * so a tracker who is not on the destination used to read its name, key and
 * id, and the task's new ref and title, off their own entries, their week and
 * their running timer.
 *
 * Now the move stops such a tracker's timer, saving the time, and every view
 * of their own time keeps the hours, the day, the billable flag and their
 * note but says only that the entry is on a private project. A member of the
 * destination sees everything, and time.read_all (the reports) sees the
 * workspace's time as it is.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { generateToken } from '../lib/crypto';

const TRACKER = ['projects.read', 'time.track'];

let owner: ReturnType<typeof reqAs>;
let insider: { userId: string; as: ReturnType<typeof reqAs> };
let outsider: { userId: string; as: ReturnType<typeof reqAs> };
/** Reads all time, tracks their own, and is on no project. */
let auditor: { userId: string; as: ReturnType<typeof reqAs> };
let roleId = '';

let openProject = '';
let secretProject = '';
const monday = '2026-11-02';

type Entry = Record<string, unknown> & { id: string; userId: string; durationSeconds: number; note: string };

async function person(name: string, role = roleId) {
  const { db } = getDb();
  const userId = ulid();
  await db.insert(schema.users).values({ id: userId, email: `${userId}@test.local`, name, passwordHash: 'x', roleId: role });
  const token = generateToken();
  await db.insert(schema.sessions).values({ id: ulid(), userId, token, expiresAt: new Date(Date.now() + 3600_000) });
  return { userId, as: reqAs(`ordi_session=${token}`) };
}

async function task(projectId: string, title: string): Promise<string> {
  const res = await owner.post('/tasks', { projectId, title });
  expect(res.status).toBe(201);
  return (await json(res)).id;
}

async function log(who: typeof outsider, taskId: string, note: string, durationSeconds = 3600, billable = true): Promise<string> {
  const res = await who.as.post('/time/entries', { taskId, startedAt: `${monday}T09:00:00.000Z`, durationSeconds, note, billable });
  expect(res.status).toBe(201);
  return (await json(res)).id;
}

/** The project and task fields a hidden entry must not carry. */
const HIDDEN = {
  projectHidden: true, projectId: null, projectKey: null, projectName: null,
  taskId: null, taskNumber: null, taskTitle: null, taskRef: null,
};

beforeAll(async () => {
  await resetDb();
  const users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  const { db } = getDb();
  roleId = ulid();
  await db.insert(schema.roles).values({ id: roleId, key: `tracker-${roleId}`, name: 'Tracker', description: 'custom', isSystem: false });
  await db.insert(schema.rolePermissions).values(TRACKER.map((p) => ({ roleId, permission: p as any })));
  const auditorRole = ulid();
  await db.insert(schema.roles).values({ id: auditorRole, key: `auditor-${auditorRole}`, name: 'Auditor', description: 'custom', isSystem: false });
  await db.insert(schema.rolePermissions).values(['time.track', 'time.read_all'].map((p) => ({ roleId: auditorRole, permission: p as any })));
  auditor = await person('Auditor', auditorRole);
  insider = await person('Insider');
  outsider = await person('Outsider');

  const typeId = (await json(owner.post('/project-types', { name: 'Own time', revenueSource: 'none' }))).id;
  openProject = (await json(owner.post('/projects', { name: 'Open', key: 'OPN', projectTypeId: typeId, visibility: 'workspace' }))).id;
  secretProject = (await json(owner.post('/projects', { name: 'Skunkworks', key: 'SKW', projectTypeId: typeId, visibility: 'private' }))).id;
  expect((await owner.post(`/projects/${secretProject}/members`, { userId: insider.userId, role: 'member' })).status).toBe(201);
});

describe('a task moved into a private project a tracker is not on', () => {
  let left = '';
  let moved = '';
  let manual = '';
  let insiderManual = '';
  let stayed = '';

  beforeAll(async () => {
    left = await task(openProject, 'Falcon prep');
    const staying = await task(openProject, 'Public chores');
    manual = await log(outsider, left, 'My notes on prep', 5400, false);
    insiderManual = await log(insider, left, 'Insider notes');
    stayed = await log(outsider, staying, 'Chores');
    // Both are timing the task when it moves.
    expect((await outsider.as.post('/time/timer/start', { taskId: left, note: 'Timing prep' })).status).toBe(200);
    expect((await insider.as.post('/time/timer/start', { taskId: left, note: 'Insider timing' })).status).toBe(200);
    const { db } = getDb();
    // Ten minutes in, so the saved entry has a duration to check.
    await db.update(schema.activeTimers).set({ startedAt: new Date(Date.now() - 600_000) });

    const res = await owner.post(`/tasks/${left}/move`, { targetProjectId: secretProject });
    expect(res.status).toBe(200);
    moved = (await json(res)).id;
  });

  const leaks = () => [secretProject, moved, 'Skunkworks', 'SKW', 'Falcon prep'];
  const expectNoLeak = (body: unknown) => {
    const text = JSON.stringify(body);
    for (const needle of leaks()) expect(text).not.toContain(needle);
  };

  it('stops the outsider\'s timer and saves its time as an entry', async () => {
    expect(await json(outsider.as.get('/time/timer'))).toBeNull();
    const { data } = await json(outsider.as.get('/time/entries?limit=50'));
    const fromTimer = (data as Entry[]).find((e) => e.note === 'Timing prep');
    expect(fromTimer).toBeDefined();
    expect(fromTimer!.durationSeconds).toBeGreaterThanOrEqual(590);
    expect(fromTimer!.durationSeconds).toBeLessThan(900);
    // The saved time moved with the task, like the rest of it.
    const { db } = getDb();
    const [row] = await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.id, fromTimer!.id));
    expect(row).toMatchObject({ taskId: moved, projectId: secretProject });
  });

  it('keeps the insider\'s timer running, now on the moved task', async () => {
    const timer = await json(insider.as.get('/time/timer'));
    expect(timer).toMatchObject({ taskId: moved, title: 'Falcon prep', projectHidden: false });
    expect(timer.ref).toMatch(/^SKW-\d+$/);
  });

  it('masks the outsider\'s entries, keeping hours, day, billable and note', async () => {
    const { data } = await json(outsider.as.get('/time/entries?limit=50'));
    const rows = data as Entry[];
    const hidden = rows.filter((e) => e.projectHidden);
    expect(hidden.map((e) => e.note).sort()).toEqual(['My notes on prep', 'Timing prep']);
    expectNoLeak(hidden);
    const mine = hidden.find((e) => e.id === manual)!;
    expect(mine).toMatchObject({ ...HIDDEN, durationSeconds: 5400, billable: false, note: 'My notes on prep', userId: outsider.userId });
    expect(String(mine.startedAt)).toContain(monday);
    // An entry on a project they can open is as it was.
    expect(rows.find((e) => e.id === stayed)).toMatchObject({ projectId: openProject, projectName: 'Open', projectHidden: false });
  });

  it('masks one entry opened on its own', async () => {
    const res = await outsider.as.get(`/time/entries/${manual}`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ ...HIDDEN, id: manual, durationSeconds: 5400 });
    expectNoLeak(body);
  });

  it('masks the week view', async () => {
    const week = await json(outsider.as.get(`/time/my-week?weekStart=${monday}`));
    const entries = week.days.flatMap((d: { entries: Entry[] }) => d.entries) as Entry[];
    expect(entries.find((e) => e.id === manual)).toMatchObject(HIDDEN);
    expect(entries.find((e) => e.id === stayed)).toMatchObject({ projectName: 'Open', projectHidden: false });
    expectNoLeak(entries.filter((e) => e.projectHidden));
    // The day's totals still count the hidden hours.
    const day = week.days.find((d: { date: string }) => d.date === monday);
    expect(day.totalSeconds).toBe(5400 + 3600);
  });

  it('answers a filter naming the project, the task or its client with nothing', async () => {
    for (const q of [`projectId=${secretProject}`, `taskId=${moved}`, 'companyId=internal']) {
      const { data } = await json(outsider.as.get(`/time/entries?${q}`));
      expect((data as Entry[]).some((e) => e.projectHidden)).toBe(false);
      expectNoLeak(data);
    }
  });

  it('still lets the outsider edit and delete their hidden time, without naming the project', async () => {
    const entry = await json(outsider.as.get(`/time/entries/${manual}`));
    const res = await outsider.as.patch(`/time/entries/${manual}`, {
      note: 'Edited note', durationSeconds: 1800, version: entry.version,
      // Not a field an entry takes: it cannot be moved to another task.
      taskId: left,
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toMatchObject({ ...HIDDEN, note: 'Edited note', durationSeconds: 1800 });
    expectNoLeak(body);
    const { db } = getDb();
    const [row] = await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.id, manual));
    expect(row).toMatchObject({ taskId: moved, projectId: secretProject, note: 'Edited note' });

    const extra = await log(insider, moved, 'Insider second');
    // Someone else's hidden-to-them entry is still not theirs to touch.
    expect((await outsider.as.del(`/time/entries/${extra}`)).status).toBe(403);
    const timerEntry = ((await json(outsider.as.get('/time/entries?limit=50'))).data as Entry[]).find((e) => e.note === 'Timing prep')!;
    expect((await outsider.as.del(`/time/entries/${timerEntry.id}`)).status).toBe(200);
    expect((await outsider.as.get(`/time/entries/${timerEntry.id}`)).status).toBe(404);
  });

  it('shows a member of the destination everything', async () => {
    const { data } = await json(insider.as.get('/time/entries?limit=50'));
    const row = (data as Entry[]).find((e) => e.id === insiderManual);
    expect(row).toMatchObject({ projectId: secretProject, projectName: 'Skunkworks', projectKey: 'SKW', taskId: moved, taskTitle: 'Falcon prep', projectHidden: false });
    const week = await json(insider.as.get(`/time/my-week?weekStart=${monday}`));
    const inWeek = week.days.flatMap((d: { entries: Entry[] }) => d.entries).find((e: Entry) => e.id === insiderManual);
    expect(inWeek).toMatchObject({ projectName: 'Skunkworks', projectHidden: false });
  });

  it('leaves time.read_all with the full picture', async () => {
    // The auditor is on no project: time.read_all alone decides.
    const { data } = await json(auditor.as.get(`/time/entries?userId=${outsider.userId}&limit=50`));
    const row = (data as Entry[]).find((e) => e.id === manual);
    expect(row).toMatchObject({ projectId: secretProject, projectName: 'Skunkworks', taskId: moved, taskTitle: 'Falcon prep', projectHidden: false });
    const report = await json(auditor.as.get(`/time/reports?groupBy=task&from=${monday}&to=2026-11-08`));
    const line = (report.data as { key: string; label: string; projectName: string; hours: number }[]).find((r) => r.key === moved);
    expect(line).toMatchObject({ label: 'Falcon prep', projectName: 'Skunkworks' });
    // The outsider's edited half hour counts there too.
    expect(line!.hours).toBe(round2((1800 + 3600 + 3600) / 3600));
    const byUser = await json(auditor.as.get(`/time/reports?groupBy=user&from=${monday}&to=2026-11-08`));
    expect((byUser.data as { key: string; hours: number }[]).find((r) => r.key === outsider.userId)?.hours).toBe(round2((1800 + 3600) / 3600));
  });
});

describe('a timer running on a project its tracker is taken off', () => {
  let secretTask = '';
  let tracker: typeof outsider;

  beforeAll(async () => {
    tracker = await person('Leaver');
    expect((await owner.post(`/projects/${secretProject}/members`, { userId: tracker.userId, role: 'member' })).status).toBe(201);
    secretTask = await task(secretProject, 'Orbit plans');
    expect((await tracker.as.post('/time/timer/start', { taskId: secretTask, note: 'Plans' })).status).toBe(200);
    expect((await owner.del(`/projects/${secretProject}/members/${tracker.userId}`)).status).toBeLessThan(300);
  });

  it('runs on but no longer names its task', async () => {
    const timer = await json(tracker.as.get('/time/timer'));
    expect(timer).toMatchObject({ projectHidden: true, taskId: null, ref: null, title: null, note: 'Plans' });
    expect(JSON.stringify(timer)).not.toContain(secretTask);
    expect(JSON.stringify(timer)).not.toContain('Orbit');
  });

  it('stops into a hidden entry', async () => {
    const res = await tracker.as.post('/time/timer/stop');
    expect(res.status).toBe(200);
    const { entryId } = await json(res);
    expect(await json(tracker.as.get(`/time/entries/${entryId}`))).toMatchObject({ ...HIDDEN, note: 'Plans' });
  });
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
