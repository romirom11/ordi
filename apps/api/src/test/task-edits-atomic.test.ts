/**
 * A task edit is all or nothing. Field changes used to be written before the
 * agent-assignment check (assertCanAssignAgents) could refuse the request, so
 * a refused edit left the title, priority or status changed – and in a bulk
 * edit, every task before the refused one fully edited, events and all.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq, and, inArray } from '@ordi/db';
import { ulid } from 'ulid';
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

    // Without the agent the same edit goes through, with its events.
    const ok = await member.patch(`/tasks/${task.id}`, {
      version: task.version, title: 'Changed', statusId: ws.reviewStatusId, assigneeIds: [users.member!.userId],
    });
    expect(ok.status).toBe(200);
    expect((await row(task.id)).title).toBe('Changed');
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
