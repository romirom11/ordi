/**
 * Time entries come back with what they were logged against, a task shows the
 * time logged on it, and the reports narrow to one project, person or client
 * and break down by task.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let project: { id: string; key: string };
let task: { id: string; number: number };
let otherTask: { id: string };
let ownerEntryId: string;
let memberEntryId: string;

const monday = '2026-11-02';

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();
  const typeId = ulid();
  await db.insert(schema.projectTypes).values({ id: typeId, name: 'Service' });
  const owner = reqAs(users.owner!.cookie);
  project = await json(owner.post('/projects', { name: 'Roadmap', key: 'RDM', projectTypeId: typeId }));
  await owner.post(`/projects/${project.id}/members`, { userId: users.member!.userId, role: 'member' });
  task = await json(owner.post('/tasks', { projectId: project.id, title: 'Sign-in codes' }));
  otherTask = await json(owner.post('/tasks', { projectId: project.id, title: 'Deploy' }));

  ownerEntryId = (await json(owner.post('/time/entries', {
    taskId: task.id, startedAt: `${monday}T09:00:00.000Z`, durationSeconds: 3600, note: 'Review',
  }))).id;
  memberEntryId = (await json(reqAs(users.member!.cookie).post('/time/entries', {
    taskId: task.id, startedAt: `${monday}T10:00:00.000Z`, durationSeconds: 1800, note: 'Fix',
  }))).id;
  await owner.post('/time/entries', { taskId: otherTask.id, startedAt: `${monday}T12:00:00.000Z`, durationSeconds: 600 });
});

describe('time entries carry their task and project', () => {
  it('my week names the task of every entry', async () => {
    const week = await json(reqAs(users.owner!.cookie).get(`/time/my-week?weekStart=${monday}`));
    const entries = week.days.flatMap((d: { entries: unknown[] }) => d.entries);
    const review = entries.find((e: { id: string }) => e.id === ownerEntryId);
    expect(review).toMatchObject({
      taskRef: `RDM-${task.number}`, taskTitle: 'Sign-in codes', projectName: 'Roadmap', projectKey: 'RDM',
    });
  });

  it('an entry opens on its own, but not someone else\'s without time.read_all', async () => {
    const own = await json(reqAs(users.member!.cookie).get(`/time/entries/${memberEntryId}`));
    expect(own).toMatchObject({ id: memberEntryId, taskTitle: 'Sign-in codes', userName: expect.any(String) });
    expect(own).not.toHaveProperty('costRate');
    const foreign = await reqAs(users.member!.cookie).get(`/time/entries/${ownerEntryId}`);
    expect(foreign.status).toBe(404);
    const asOwner = await reqAs(users.owner!.cookie).get(`/time/entries/${memberEntryId}`);
    expect(asOwner.status).toBe(200);
  });
});

describe('time on a task', () => {
  it('shows the total and the split by person to time.read_all', async () => {
    const res = await json(reqAs(users.owner!.cookie).get(`/time/tasks/${task.id}`));
    expect(res.totalSeconds).toBe(5400);
    expect(res.mySeconds).toBe(3600);
    expect(res.people).toHaveLength(2);
    expect(res.entries.map((e: { id: string }) => e.id).sort()).toEqual([ownerEntryId, memberEntryId].sort());
  });

  it('shows a tracker the total but only their own entries', async () => {
    const res = await json(reqAs(users.member!.cookie).get(`/time/tasks/${task.id}`));
    expect(res.totalSeconds).toBe(5400);
    expect(res.mySeconds).toBe(1800);
    expect(res.people).toBeNull();
    expect(res.entries.map((e: { id: string }) => e.id)).toEqual([memberEntryId]);
  });

  it('is not shown for a task the viewer cannot see', async () => {
    const res = await reqAs(users.member!.cookie).get(`/time/tasks/${ulid()}`);
    expect(res.status).toBe(404);
  });
});

describe('time reports drill down', () => {
  it('break a project down by task', async () => {
    const res = await json(reqAs(users.owner!.cookie).get(`/time/reports?groupBy=task&projectId=${project.id}`));
    expect(res.data).toHaveLength(2);
    expect(res.data[0]).toMatchObject({ key: task.id, ref: `RDM-${task.number}`, label: 'Sign-in codes', projectId: project.id, hours: 1.5 });
  });

  it('say enough about each task to read the list without opening it', async () => {
    await reqAs(users.owner!.cookie).patch(`/tasks/${task.id}`, { estimate: 2 });
    const res = await json(reqAs(users.owner!.cookie).get(`/time/reports?groupBy=task&projectId=${project.id}`));
    const row = res.data.find((r: { key: string }) => r.key === task.id);
    expect(row).toMatchObject({
      projectName: 'Roadmap',
      status: { name: expect.any(String), category: expect.any(String) },
      estimateHours: 2,
      lastAt: `${monday}T10:00:00.000Z`,
    });
    expect(row.people).toHaveLength(2);
    const other = res.data.find((r: { key: string }) => r.key === otherTask.id);
    expect(other).toMatchObject({ estimateHours: null, people: [{ id: users.owner!.userId, name: expect.any(String) }] });
  });

  it('carry when time was last logged in every grouping', async () => {
    const res = await json(reqAs(users.owner!.cookie).get('/time/reports?groupBy=user'));
    expect(res.data.every((r: { lastAt: string | null }) => typeof r.lastAt === 'string')).toBe(true);
  });

  it('narrow to one person', async () => {
    const res = await json(reqAs(users.owner!.cookie).get(`/time/reports?groupBy=task&userId=${users.member!.userId}`));
    expect(res.data).toEqual([expect.objectContaining({ key: task.id, hours: 0.5 })]);
  });

  it('narrow to projects with no client', async () => {
    const res = await json(reqAs(users.owner!.cookie).get('/time/reports?groupBy=project&companyId=internal'));
    expect(res.data).toEqual([expect.objectContaining({ key: project.id })]);
    const entries = await json(reqAs(users.owner!.cookie).get('/time/entries?companyId=internal&limit=10'));
    expect(entries.data).toHaveLength(3);
  });
});
