/**
 * A task edit is all or nothing. Field changes used to be written before the
 * agent-assignment check (assertCanAssignAgents) could refuse the request, so
 * a refused edit left the title, priority or status changed – and in a bulk
 * edit, every task before the refused one fully edited, events and all.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq, and, inArray, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { BULK_TASK_LIMIT } from '@ordi/shared';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { setupWorkspace, createAgent, addProjectMember, type Workspace } from './agents-helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let ws: Workspace;
let other: Workspace;
let owner: ReturnType<typeof reqAs>;
let member: ReturnType<typeof reqAs>;
let adminsOnly: string;

async function newTask(projectId: string, title: string) {
  const res = await owner.post('/tasks', { projectId, title, labelIds: [] });
  expect(res.status).toBe(201);
  return json(res) as Promise<{ id: string; version: number; statusId: string; priority: string; title: string }>;
}

async function row(taskId: string) {
  const { db } = getDb();
  const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
  const assignees = await db.select({ userId: schema.taskAssignees.userId }).from(schema.taskAssignees).where(eq(schema.taskAssignees.taskId, taskId));
  return { ...task!, assignees: assignees.map((a) => a.userId) };
}

async function eventsFor(taskIds: string[]) {
  return getDb().db.select({ type: schema.events.type, aggregateId: schema.events.aggregateId }).from(schema.events)
    .where(and(inArray(schema.events.aggregateId, taskIds), inArray(schema.events.type, ['task.updated', 'task.assigned', 'task.status_changed'])));
}

async function activityFor(taskId: string) {
  return getDb().db.select({ action: schema.activityLog.action }).from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, 'task'), eq(schema.activityLog.entityId, taskId)));
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  ws = await setupWorkspace(users, 'ATOM');
  other = await setupWorkspace(users, 'OTHR');
  owner = reqAs(users.owner!.cookie);
  // setupWorkspace adds the member as a project member of both.
  member = reqAs(users.member!.cookie);
  adminsOnly = (await createAgent(users, { name: 'Admins only', assignPolicy: 'project_admins' })).id;
  await addProjectMember(users, ws.projectId, adminsOnly);
});

describe('a single task edit that is refused', () => {
  it('saves none of its other fields, and announces nothing', async () => {
    const task = await newTask(ws.projectId, 'Keep this title');
    const before = await eventsFor([task.id]);
    const activityBefore = await activityFor(task.id);
    const res = await member.patch(`/tasks/${task.id}`, {
      version: task.version, title: 'Changed anyway', priority: 'urgent', statusId: ws.reviewStatusId,
      assigneeIds: [users.member!.userId, adminsOnly],
    });
    expect(res.status).toBe(403);
    const after = await row(task.id);
    expect(after.title).toBe('Keep this title');
    expect(after.priority).toBe(task.priority);
    expect(after.statusId).toBe(task.statusId);
    expect(after.version).toBe(task.version);
    expect(after.assignees).toEqual([]);
    expect(await eventsFor([task.id])).toHaveLength(before.length);
    expect(await activityFor(task.id)).toHaveLength(activityBefore.length);

    // Without the agent the same edit goes through, with its events.
    const ok = await member.patch(`/tasks/${task.id}`, {
      version: task.version, title: 'Changed', statusId: ws.reviewStatusId, assigneeIds: [users.member!.userId],
    });
    expect(ok.status).toBe(200);
    expect((await row(task.id)).title).toBe('Changed');
    expect((await activityFor(task.id)).length).toBe(activityBefore.length + 1);
    const types = (await eventsFor([task.id])).slice(before.length).map((e) => e.type).sort();
    expect(types).toEqual(['task.assigned', 'task.status_changed', 'task.updated']);
  });
});

describe('a bulk task edit that is refused', () => {
  it('changes no task, not even the ones before the refused one', async () => {
    const first = await newTask(ws.projectId, 'Bulk first');
    // The agent is a member of ATOM only: the OTHR task is where it is refused.
    const second = await newTask(other.projectId, 'Bulk second');
    const before = await eventsFor([first.id, second.id]);
    const res = await owner.post('/tasks/bulk', {
      taskIds: [first.id, second.id], priority: 'urgent', assigneeIds: [adminsOnly], labelIds: [],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    for (const t of [first, second]) {
      const after = await row(t.id);
      expect(after.priority).toBe(t.priority);
      expect(after.assignees).toEqual([]);
    }
    expect(await eventsFor([first.id, second.id])).toHaveLength(before.length);
  });

  it('refused by the assign policy changes nothing either', async () => {
    const a = await newTask(ws.projectId, 'Policy A');
    const b = await newTask(ws.projectId, 'Policy B');
    const res = await member.post('/tasks/bulk', { taskIds: [a.id, b.id], statusId: ws.reviewStatusId, assigneeIds: [adminsOnly] });
    expect(res.status).toBe(403);
    for (const t of [a, b]) expect((await row(t.id)).statusId).toBe(t.statusId);
  });

  it('that fails on a write rolls back the tasks already written', async () => {
    const a = await newTask(ws.projectId, 'Rollback A');
    const b = await newTask(ws.projectId, 'Rollback B');
    // No such user: the assignee insert fails on its foreign key.
    const res = await owner.post('/tasks/bulk', { taskIds: [a.id, b.id], priority: 'urgent', assigneeIds: [ulid()] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    for (const t of [a, b]) expect((await row(t.id)).priority).toBe(t.priority);
  });

  it('that fails on a later task takes back the events already written for earlier ones', async () => {
    const a = await newTask(ws.projectId, 'Late failure A');
    const b = await newTask(ws.projectId, 'Late failure B');
    const label = await json(owner.post('/labels', { name: 'Atomic', scope: 'task' }));
    const before = await eventsFor([a.id, b.id]);
    // A write that fails only for B, after A's status change and its event.
    const { db } = getDb();
    await db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION test_refuse_label() RETURNS trigger AS $$
      BEGIN IF NEW.task_id = '${b.id}' THEN RAISE EXCEPTION 'refused for the test'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_refuse_label BEFORE INSERT ON task_labels FOR EACH ROW EXECUTE FUNCTION test_refuse_label();`));
    try {
      const res = await owner.post('/tasks/bulk', { taskIds: [a.id, b.id], statusId: ws.reviewStatusId, labelIds: [label.id] });
      expect(res.status).toBeGreaterThanOrEqual(400);
    } finally {
      await db.execute(sql.raw('DROP TRIGGER test_refuse_label ON task_labels; DROP FUNCTION test_refuse_label();'));
    }
    for (const t of [a, b]) expect((await row(t.id)).statusId).toBe(t.statusId);
    expect(await eventsFor([a.id, b.id])).toHaveLength(before.length);
  });

  it('waits for a concurrent edit of the same task instead of merging assignee lists', async () => {
    const task = await newTask(ws.projectId, 'Contended');
    const { db } = getDb();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    // Another edit, mid-way: it holds the task and has assigned the admin,
    // not committed yet.
    const other = db.transaction(async (tx) => {
      await tx.select({ id: schema.tasks.id }).from(schema.tasks).where(eq(schema.tasks.id, task.id)).for('update');
      await tx.insert(schema.taskAssignees).values({ taskId: task.id, userId: users.admin!.userId });
      locked();
      await held;
    });
    await lockTaken;
    const patch = owner.patch(`/tasks/${task.id}`, { assigneeIds: [users.member!.userId] });
    await new Promise((r) => setTimeout(r, 300));
    release();
    await other;
    expect((await patch).status).toBe(200);
    // The later edit replaced the list it found, rather than adding to it.
    expect((await row(task.id)).assignees).toEqual([users.member!.userId]);
  });

  it('goes through whole when nothing refuses it', async () => {
    const a = await newTask(ws.projectId, 'Whole A');
    const b = await newTask(ws.projectId, 'Whole B');
    const res = await owner.post('/tasks/bulk', { taskIds: [a.id, b.id], priority: 'high', statusId: ws.reviewStatusId, assigneeIds: [adminsOnly] });
    expect(res.status).toBe(200);
    expect((await json(res)).updated).toBe(2);
    for (const t of [a, b]) {
      const after = await row(t.id);
      expect(after.priority).toBe('high');
      expect(after.statusId).toBe(ws.reviewStatusId);
      expect(after.assignees).toEqual([adminsOnly]);
    }
    const types = (await eventsFor([a.id, b.id])).filter((e) => e.type !== 'task.updated').map((e) => e.type).sort();
    expect(types).toEqual(['task.assigned', 'task.assigned', 'task.status_changed', 'task.status_changed']);
  });
});

describe('a bulk task edit of a large selection', () => {
  it('takes at most BULK_TASK_LIMIT tasks, and refuses a larger one before reading any', async () => {
    const task = await newTask(ws.projectId, 'Not touched by the oversized edit');
    const ids = (n: number) => [task.id, ...Array.from({ length: n - 1 }, () => ulid())];
    const tooMany = await owner.post('/tasks/bulk', { taskIds: ids(BULK_TASK_LIMIT + 1), priority: 'urgent' });
    expect(tooMany.status).toBe(400);
    const body = await json(tooMany);
    expect(body.error.code).toBe('validation_error');
    expect(body.error.details.fieldErrors.taskIds).toEqual([`Edit at most ${BULK_TASK_LIMIT} tasks at once`]);
    expect((await row(task.id)).priority).toBe(task.priority);

    const atLimit = await owner.post('/tasks/bulk', { taskIds: ids(BULK_TASK_LIMIT), priority: 'urgent' });
    expect(atLimit.status).toBe(200);
    expect((await json(atLimit)).updated).toBe(1);
    expect((await row(task.id)).priority).toBe('urgent');
  });
});
