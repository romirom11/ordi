/**
 * A task's reporter: who set it, and so who to ask what it is for. It starts
 * as the creator, can be set to someone else (a task filed for a colleague),
 * and is who the task's own news goes to, where the creator used to be.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { createAgent, drainOutbox } from './agents-helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;
let privateProjectId: string;

const owner = () => reqAs(users.owner!.cookie);

async function project(key: string, visibility: 'workspace' | 'private', typeId: string): Promise<string> {
  const res = await owner().post('/projects', { name: `Project ${key}`, key, projectTypeId: typeId, visibility });
  expect(res.status).toBe(201);
  return (await json(res)).id;
}

async function notificationTypes(userId: string): Promise<string[]> {
  const rows = await getDb().db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
  return rows.map((r) => r.type);
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const typeId = ulid();
  await getDb().db.insert(schema.projectTypes).values({ id: typeId, name: 'Service' });
  projectId = await project('REP', 'workspace', typeId);
  privateProjectId = await project('PRV', 'private', typeId);
});

describe('the reporter of a task', () => {
  it('is the creator unless someone else is named', async () => {
    const mine = await json(owner().post('/tasks', { projectId, title: 'Mine' }));
    expect(mine.reporterId).toBe(users.owner!.userId);

    const forColleague = await json(owner().post('/tasks', { projectId, title: 'Filed for Manager', reporterId: users.manager!.userId }));
    expect(forColleague.reporterId).toBe(users.manager!.userId);
    expect(forColleague.createdBy).toBe(users.owner!.userId);

    const none = await json(owner().post('/tasks', { projectId, title: 'Nobody set this', reporterId: null }));
    expect(none.reporterId).toBeNull();
  });

  it('can be changed and cleared', async () => {
    const task = await json(owner().post('/tasks', { projectId, title: 'Hand over' }));
    const changed = await json(owner().patch(`/tasks/${task.id}`, { reporterId: users.manager!.userId }));
    expect(changed.reporterId).toBe(users.manager!.userId);
    const cleared = await json(owner().patch(`/tasks/${task.id}`, { reporterId: null }));
    expect(cleared.reporterId).toBeNull();
  });

  it('must be someone the task can be taken back to', async () => {
    const task = await json(owner().post('/tasks', { projectId, title: 'Who asked?' }));
    expect((await owner().patch(`/tasks/${task.id}`, { reporterId: ulid() })).status).toBe(400);

    await getDb().db.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, users.hr!.userId));
    expect((await owner().patch(`/tasks/${task.id}`, { reporterId: users.hr!.userId })).status).toBe(400);

    // A private project only takes its members.
    expect((await owner().post('/tasks', { projectId: privateProjectId, title: 'Secret', reporterId: users.manager!.userId })).status).toBe(400);
    await owner().post(`/projects/${privateProjectId}/members`, { userId: users.manager!.userId, role: 'member', canWriteTasks: true });
    expect((await owner().post('/tasks', { projectId: privateProjectId, title: 'Secret', reporterId: users.manager!.userId })).status).toBe(201);
  });

  it('can be an agent that is on the project', async () => {
    const agent = await createAgent(users, { name: 'Triage bot' });
    const task = await json(owner().post('/tasks', { projectId, title: 'Raised by the bot' }));
    expect((await owner().patch(`/tasks/${task.id}`, { reporterId: agent.id })).status).toBe(400);
    await owner().post(`/projects/${projectId}/members`, { userId: agent.id, role: 'member', canWriteTasks: true });
    expect((await json(owner().patch(`/tasks/${task.id}`, { reporterId: agent.id }))).reporterId).toBe(agent.id);
  });

  it('hears about status changes, instead of whoever typed the task in', async () => {
    const statuses = (await json(owner().get(`/projects/${projectId}/task-statuses`))).data as { id: string; category: string }[];
    const done = statuses.find((s) => s.category === 'done')!;
    const task = await json(owner().post('/tasks', { projectId, title: 'Report me', reporterId: users.manager!.userId }));
    await drainOutbox();
    await getDb().db.delete(schema.notifications);

    // Someone else moves it: the reporter hears, the creator (owner) does not.
    await reqAs(users.admin!.cookie).patch(`/tasks/${task.id}`, { statusId: done.id });
    await drainOutbox();
    expect(await notificationTypes(users.manager!.userId)).toContain('task.status_changed');
    expect(await notificationTypes(users.owner!.userId)).not.toContain('task.status_changed');
  });

  it('travels with a duplicate', async () => {
    const task = await json(owner().post('/tasks', { projectId, title: 'Original', reporterId: users.manager!.userId }));
    const copy = await json(reqAs(users.admin!.cookie).post(`/tasks/${task.id}/duplicate`));
    expect(copy.reporterId).toBe(users.manager!.userId);
  });
});
