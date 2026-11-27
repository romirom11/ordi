/**
 * A task's status is always one of its own project's statuses. A status id
 * from another project used to be stored as given: the task then fell off its
 * board and its progress, and the other project deleting that status moved it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { consumers } from '../workers/consumers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let owner: ReturnType<typeof reqAs>;
let home: string;
let other: string;
let homeStatus: { id: string; name: string };
let foreignStatus: string;

async function createProject(key: string, typeId: string): Promise<string> {
  const res = await owner.post('/projects', { name: `Project ${key}`, key, projectTypeId: typeId });
  expect(res.status).toBe(201);
  return (await json(res)).id;
}

async function statusesOf(projectId: string): Promise<{ id: string; name: string; isDefault: boolean }[]> {
  return (await json(owner.get(`/projects/${projectId}/task-statuses`))).data;
}

async function statusOfTask(taskId: string): Promise<string> {
  const [row] = await getDb().db.select({ statusId: schema.tasks.statusId }).from(schema.tasks).where(eq(schema.tasks.id, taskId));
  return row!.statusId;
}

async function newTask(title: string): Promise<{ id: string; statusId: string; version: number }> {
  const res = await owner.post('/tasks', { projectId: home, title });
  expect(res.status).toBe(201);
  return json(res);
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  const typeId = ulid();
  await getDb().db.insert(schema.projectTypes).values({ id: typeId, name: 'Service' });
  home = await createProject('HOME', typeId);
  other = await createProject('OTHR', typeId);
  homeStatus = (await statusesOf(home)).find((s) => !s.isDefault)!;
  foreignStatus = (await statusesOf(other))[0]!.id;
});

describe("a task's status", () => {
  it('is refused on create when it belongs to another project', async () => {
    const res = await owner.post('/tasks', { projectId: home, title: 'Foreign on create', statusId: foreignStatus });
    expect(res.status).toBe(400);
    expect((await json(res)).error.message).toContain('statusId');
    const { db } = getDb();
    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.title, 'Foreign on create'));
    expect(rows).toHaveLength(0);
    // A status of the project itself still works.
    const ok = await owner.post('/tasks', { projectId: home, title: 'Own on create', statusId: homeStatus.id });
    expect(ok.status).toBe(201);
    expect((await json(ok)).statusId).toBe(homeStatus.id);
  });

  it('is refused on update, and nothing else in the request is saved', async () => {
    const task = await newTask('Update me');
    const res = await owner.patch(`/tasks/${task.id}`, { version: task.version, statusId: foreignStatus, title: 'Renamed' });
    expect(res.status).toBe(400);
    const after = await json(owner.get(`/tasks/${task.id}`));
    expect(after.statusId).toBe(task.statusId);
    expect(after.title).toBe('Update me');
    const ok = await owner.patch(`/tasks/${task.id}`, { version: task.version, statusId: homeStatus.id });
    expect(ok.status).toBe(200);
    expect(await statusOfTask(task.id)).toBe(homeStatus.id);
  });

  it('is refused in a bulk edit before any task changes', async () => {
    const a = await newTask('Bulk A');
    const b = await newTask('Bulk B');
    const res = await owner.post('/tasks/bulk', { taskIds: [a.id, b.id], statusId: foreignStatus, priority: 'urgent' });
    expect(res.status).toBe(400);
    for (const t of [a, b]) {
      const after = await json(owner.get(`/tasks/${t.id}`));
      expect(after.statusId).toBe(t.statusId);
      expect(after.priority).not.toBe('urgent');
    }
    const ok = await json(owner.post('/tasks/bulk', { taskIds: [a.id, b.id], statusId: homeStatus.id }));
    expect(ok.updated).toBe(2);
  });

  it('is refused when accepting an intake request into another project\'s status', async () => {
    const { db } = getDb();
    const itemId = ulid();
    await db.insert(schema.intakeItems).values({ id: itemId, projectId: home, title: 'From the form' });
    const res = await owner.post(`/intake/${itemId}/accept`, { statusId: foreignStatus });
    expect(res.status).toBe(400);
    const [item] = await db.select().from(schema.intakeItems).where(eq(schema.intakeItems.id, itemId));
    expect(item!.status).toBe('pending');
    const ok = await owner.post(`/intake/${itemId}/accept`, { statusId: homeStatus.id });
    expect(ok.status).toBe(201);
  });

  it('cannot come from a git automation rule pointing at another project', async () => {
    const refused = await owner.post(`/projects/${home}/automation-rules`, { trigger: 'pr_merged', targetStatusId: foreignStatus });
    expect(refused.status).toBe(400);

    // A rule stored before the check existed sets nothing either.
    const task = await newTask('Automated');
    const { db } = getDb();
    await db.insert(schema.gitAutomationRules).values({ id: ulid(), projectId: home, trigger: 'pr_opened', targetStatusId: foreignStatus });
    const automations = consumers.find((c) => c.name === 'automations')!;
    await automations.handle({ id: ulid(), type: 'git.pr_opened', aggregateType: 'task', aggregateId: task.id, payload: { taskId: task.id, projectId: home } } as never);
    expect(await statusOfTask(task.id)).toBe(task.statusId);

    const ok = await owner.post(`/projects/${home}/automation-rules`, { trigger: 'pr_merged', targetStatusId: homeStatus.id });
    expect(ok.status).toBe(201);
    await automations.handle({ id: ulid(), type: 'git.pr_merged', aggregateType: 'task', aggregateId: task.id, payload: { taskId: task.id, projectId: home } } as never);
    expect(await statusOfTask(task.id)).toBe(homeStatus.id);
  });
});
