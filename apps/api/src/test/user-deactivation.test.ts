/**
 * Deactivating a user hands their open work over (ORD-20): open tasks go to
 * a named successor or become unassigned, closed tasks keep their history,
 * and the admin can preview what is about to move.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, schema, eq, and } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let project: { id: string; key: string };

async function createTask(title: string, extra: Record<string, unknown> = {}) {
  const res = await reqAs(users.owner!.cookie).post('/tasks', { projectId: project.id, title, ...extra });
  expect(res.status).toBe(201);
  return json(res);
}

async function doneStatusId(): Promise<string> {
  const statuses = await json(reqAs(users.owner!.cookie).get(`/projects/${project.id}/task-statuses`));
  return statuses.data.find((s: { category: string }) => s.category === 'done').id;
}

async function assigneesOf(taskId: string): Promise<string[]> {
  const { db } = getDb();
  const rows = await db.select({ userId: schema.taskAssignees.userId })
    .from(schema.taskAssignees).where(eq(schema.taskAssignees.taskId, taskId));
  return rows.map((r) => r.userId).sort();
}

beforeEach(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();
  const typeId = ulid();
  await db.insert(schema.projectTypes).values({ id: typeId, name: 'Service' });
  const res = await reqAs(users.owner!.cookie).post('/projects', { name: 'Handover', key: 'HND', projectTypeId: typeId });
  expect(res.status).toBe(201);
  project = await json(res);
});

describe('open tasks preview', () => {
  it('counts only open tasks the user is assigned to', async () => {
    const open = await createTask('Still to do', { assigneeIds: [users.member!.userId] });
    const done = await createTask('Already shipped', { assigneeIds: [users.member!.userId] });
    await createTask('Someone else', { assigneeIds: [users.hr!.userId] });
    await reqAs(users.owner!.cookie).patch(`/tasks/${done.id}`, { statusId: await doneStatusId() });

    const preview = await json(reqAs(users.owner!.cookie).get(`/users/${users.member!.userId}/open-tasks`));
    expect(preview.count).toBe(1);
    expect(preview.data.map((t: { id: string }) => t.id)).toEqual([open.id]);
    expect(preview.data[0].ref).toBe(`${project.key}-${open.number}`);
  });

  it('is an admin-only view', async () => {
    const res = await reqAs(users.member!.cookie).get(`/users/${users.hr!.userId}/open-tasks`);
    expect(res.status).toBe(403);
  });
});

describe('deactivate with hand-off', () => {
  it('moves open tasks to the successor and leaves closed ones alone', async () => {
    const open = await createTask('Still to do', { assigneeIds: [users.member!.userId] });
    const shared = await createTask('Pair work', { assigneeIds: [users.member!.userId, users.hr!.userId] });
    const done = await createTask('Already shipped', { assigneeIds: [users.member!.userId] });
    await reqAs(users.owner!.cookie).patch(`/tasks/${done.id}`, { statusId: await doneStatusId() });

    const res = await reqAs(users.owner!.cookie).post(`/users/${users.member!.userId}/deactivate`, { reassignTo: users.hr!.userId });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, handedOffTasks: 2, reassignTo: users.hr!.userId });

    expect(await assigneesOf(open.id)).toEqual([users.hr!.userId]);
    // The successor was already on it: no duplicate row, the leaver is gone.
    expect(await assigneesOf(shared.id)).toEqual([users.hr!.userId]);
    // History stays: whoever finished it still shows as having done so.
    expect(await assigneesOf(done.id)).toEqual([users.member!.userId]);

    const { db } = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, users.member!.userId));
    expect(user!.isActive).toBe(false);

    const rows = await db.select().from(schema.activityLog).where(and(
      eq(schema.activityLog.entityType, 'task'), eq(schema.activityLog.action, 'reassigned'),
    ));
    expect(rows.map((r) => r.entityId).sort()).toEqual([open.id, shared.id].sort());
  });

  it('unassigns open tasks when no successor is named', async () => {
    const open = await createTask('Still to do', { assigneeIds: [users.member!.userId] });

    const res = await reqAs(users.owner!.cookie).post(`/users/${users.member!.userId}/deactivate`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, handedOffTasks: 1, reassignTo: null });
    expect(await assigneesOf(open.id)).toEqual([]);
  });

  it('refuses a successor who is the leaver or already deactivated', async () => {
    await createTask('Still to do', { assigneeIds: [users.member!.userId] });
    await reqAs(users.owner!.cookie).post(`/users/${users.hr!.userId}/deactivate`);

    const self = await reqAs(users.owner!.cookie).post(`/users/${users.member!.userId}/deactivate`, { reassignTo: users.member!.userId });
    expect(self.status).toBe(400);
    const gone = await reqAs(users.owner!.cookie).post(`/users/${users.member!.userId}/deactivate`, { reassignTo: users.hr!.userId });
    expect(gone.status).toBe(400);

    // Nothing moved and the leaver is still active: the refusal came first.
    const { db } = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, users.member!.userId));
    expect(user!.isActive).toBe(true);
  });
});
