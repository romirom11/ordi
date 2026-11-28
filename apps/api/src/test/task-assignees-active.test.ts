/**
 * Only active users take new work. The web pickers hide deactivated people
 * and switched-off agents; the API held nobody to that, so an API or MCP
 * caller (an agent holding an old user id) could assign a task to someone
 * who has left. Every write that adds an assignee now refuses one with a
 * 400 before anything is written. Assignees already on a task stay and do
 * not block other edits; a copy of a task leaves them off.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq, and, inArray, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { setupWorkspace, createAgent, addProjectMember, type Workspace } from './agents-helpers';
import { runRecurringTasks } from '../workers/scheduled';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let ws: Workspace;
let owner: ReturnType<typeof reqAs>;
/** A person who has left: on no task yet, deactivated. */
let leaver: string;

async function setActive(userId: string, isActive: boolean): Promise<void> {
  await getDb().db.update(schema.users).set({ isActive }).where(eq(schema.users.id, userId));
}

async function assigneesOf(taskId: string): Promise<string[]> {
  const rows = await getDb().db.select({ userId: schema.taskAssignees.userId }).from(schema.taskAssignees)
    .where(eq(schema.taskAssignees.taskId, taskId));
  return rows.map((r) => r.userId).sort();
}

async function tasksTitled(title: string) {
  return getDb().db.select().from(schema.tasks).where(eq(schema.tasks.title, title));
}

async function assignedEvents(taskIds: string[]): Promise<number> {
  const rows = await getDb().db.select({ id: schema.events.id }).from(schema.events)
    .where(and(eq(schema.events.type, 'task.assigned'), inArray(schema.events.aggregateId, taskIds)));
  return rows.length;
}

async function newTask(title: string, assigneeIds: string[] = []) {
  const res = await owner.post('/tasks', { projectId: ws.projectId, title, assigneeIds });
  expect(res.status).toBe(201);
  return json(res);
}

/** A task that already carries `userId`, who is then deactivated. */
async function taskWithLeaver(title: string, userId: string) {
  await setActive(userId, true);
  const task = await newTask(title, [userId]);
  await setActive(userId, false);
  return task;
}

async function expectRefused(res: Response, userId: string): Promise<void> {
  expect(res.status).toBe(400);
  const body = await json(res);
  expect(body.error.code).toBe('validation_error');
  expect(body.error.message).toBe('Assignees must be active users');
  expect(body.error.details).toEqual({ userIds: [userId] });
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  ws = await setupWorkspace(users, 'ACT');
  owner = reqAs(users.owner!.cookie);
  leaver = users.hr!.userId;
  await setActive(leaver, false);
});

describe('creating a task', () => {
  it('refuses a deactivated assignee and writes nothing', async () => {
    const res = await owner.post('/tasks', { projectId: ws.projectId, title: 'For someone gone', assigneeIds: [users.member!.userId, leaver] });
    await expectRefused(res, leaver);
    expect(await tasksTitled('For someone gone')).toHaveLength(0);
  });

  it('refuses an id that names no user, before anything is written', async () => {
    const nobody = ulid();
    await expectRefused(await owner.post('/tasks', { projectId: ws.projectId, title: 'For nobody', assigneeIds: [nobody] }), nobody);
    expect(await tasksTitled('For nobody')).toHaveLength(0);
  });

  it('still takes an active assignee', async () => {
    const task = await newTask('For someone here', [users.member!.userId]);
    expect(await assigneesOf(task.id)).toEqual([users.member!.userId]);
  });

  it('refuses a switched-off agent', async () => {
    const agent = await createAgent(users, { name: 'Off duty' });
    await addProjectMember(users, ws.projectId, agent.id);
    expect((await owner.post(`/agents/${agent.id}/disable`)).status).toBe(200);
    await expectRefused(await owner.post('/tasks', { projectId: ws.projectId, title: 'For the off agent', assigneeIds: [agent.id] }), agent.id);
    expect(await tasksTitled('For the off agent')).toHaveLength(0);
  });
});

describe('accepting an intake item', () => {
  it('refuses a deactivated assignee and leaves the item pending', async () => {
    const itemId = ulid();
    await getDb().db.insert(schema.intakeItems).values({ id: itemId, projectId: ws.projectId, source: 'email', status: 'pending', title: 'Intake for the leaver', description: '' });
    await expectRefused(await owner.post(`/intake/${itemId}/accept`, { assigneeIds: [leaver] }), leaver);
    const [item] = await getDb().db.select().from(schema.intakeItems).where(eq(schema.intakeItems.id, itemId));
    expect(item).toMatchObject({ status: 'pending', createdTaskId: null });
    expect(await tasksTitled('Intake for the leaver')).toHaveLength(0);

    const ok = await json(owner.post(`/intake/${itemId}/accept`, { assigneeIds: [users.member!.userId] }));
    expect(await assigneesOf(ok.taskId)).toEqual([users.member!.userId]);
  });
});

describe('updating a task', () => {
  it('refuses adding a deactivated assignee and changes nothing', async () => {
    const task = await newTask('Edit me', [users.member!.userId]);
    const res = await owner.patch(`/tasks/${task.id}`, { version: task.version, title: 'Edited', assigneeIds: [users.member!.userId, leaver] });
    await expectRefused(res, leaver);
    const after = await json(owner.get(`/tasks/${task.id}`));
    expect(after.title).toBe('Edit me');
    expect(after.version).toBe(task.version);
    expect(await assigneesOf(task.id)).toEqual([users.member!.userId]);
    expect(await assignedEvents([task.id])).toBe(1);
  });

  it('refuses it the way assign_task sends it: assignees only, no version', async () => {
    const task = await newTask('Assign me');
    await expectRefused(await owner.patch(`/tasks/${task.id}`, { assigneeIds: [leaver] }), leaver);
    expect(await assigneesOf(task.id)).toEqual([]);
    expect((await owner.patch(`/tasks/${task.id}`, { assigneeIds: [users.member!.userId] })).status).toBe(200);
    expect(await assigneesOf(task.id)).toEqual([users.member!.userId]);
  });

  it('lets an unrelated edit through when the task already carries a deactivated assignee', async () => {
    const former = users.sales!.userId;
    const task = await taskWithLeaver('Closed long ago', former);
    try {
      const renamed = await owner.patch(`/tasks/${task.id}`, { version: task.version, title: 'Closed long ago (renamed)' });
      expect(renamed.status).toBe(200);
      // Keeping them while adding someone else is no new assignment of them either.
      const fresh = await json(renamed);
      const added = await owner.patch(`/tasks/${task.id}`, { version: fresh.version, assigneeIds: [former, users.member!.userId] });
      expect(added.status).toBe(200);
      expect(await assigneesOf(task.id)).toEqual([former, users.member!.userId].sort());
      // Taken off, they cannot be put back.
      await json(owner.patch(`/tasks/${task.id}`, { assigneeIds: [users.member!.userId] }));
      await expectRefused(await owner.patch(`/tasks/${task.id}`, { assigneeIds: [users.member!.userId, former] }), former);
    } finally {
      await setActive(former, true);
    }
  });

  it('waits for a deactivation in progress, then refuses the person it switched off', async () => {
    const { db } = getDb();
    const person = users.finance!.userId;
    const task = await newTask('Racing a deactivation');
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    // Stands in for POST /users/:id/deactivate: the person's row is locked,
    // then switched off.
    const deactivation = db.transaction(async (tx) => {
      await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, person)).for('update');
      held();
      await released;
      await tx.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, person));
    });
    try {
      await holding;
      const assign = owner.patch(`/tasks/${task.id}`, { assigneeIds: [person] });
      // The edit's check passes before the lock (the person still reads as
      // active); it must then block on the person's row, not go ahead.
      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const rows = await db.execute(sql`select 1 from pg_stat_activity
          where wait_event_type = 'Lock' and query ilike '%for key share%'`) as unknown as unknown[];
        blocked = rows.length > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked).toBe(true);
      release();
      await deactivation;
      await expectRefused(await assign, person);
      expect(await assigneesOf(task.id)).toEqual([]);
    } finally {
      release();
      await deactivation.catch(() => undefined);
      await setActive(person, true);
    }
  });
});

describe('bulk editing tasks', () => {
  it('refuses adding a deactivated assignee and changes none of the tasks', async () => {
    const a = await newTask('Bulk A', [users.member!.userId]);
    const b = await newTask('Bulk B');
    const res = await owner.post('/tasks/bulk', { taskIds: [a.id, b.id], priority: 'urgent', assigneeIds: [users.member!.userId, leaver] });
    await expectRefused(res, leaver);
    for (const t of [a, b]) expect((await json(owner.get(`/tasks/${t.id}`))).priority).toBe('none');
    expect(await assigneesOf(a.id)).toEqual([users.member!.userId]);
    expect(await assigneesOf(b.id)).toEqual([]);
  });

  it('lets an edit through that adds nobody new to a task with a deactivated assignee', async () => {
    const former = users.sales!.userId;
    const task = await taskWithLeaver('Bulk history', former);
    try {
      expect((await owner.post('/tasks/bulk', { taskIds: [task.id], priority: 'high' })).status).toBe(200);
      expect((await owner.post('/tasks/bulk', { taskIds: [task.id], assigneeIds: [former] })).status).toBe(200);
      expect(await assigneesOf(task.id)).toEqual([former]);
    } finally {
      await setActive(former, true);
    }
  });

  it('still assigns an active person', async () => {
    const t = await newTask('Bulk C');
    expect((await owner.post('/tasks/bulk', { taskIds: [t.id], assigneeIds: [users.member!.userId] })).status).toBe(200);
    expect(await assigneesOf(t.id)).toEqual([users.member!.userId]);
  });
});

describe('duplicating a task', () => {
  it('leaves a deactivated assignee off the copy and keeps the active ones', async () => {
    const former = users.sales!.userId;
    await setActive(former, true);
    const source = await newTask('Copy me', [users.member!.userId, former]);
    await setActive(former, false);
    try {
      const res = await owner.post(`/tasks/${source.id}/duplicate`);
      expect(res.status).toBe(201);
      const copy = await json(res);
      expect(await assigneesOf(copy.id)).toEqual([users.member!.userId]);
      // The original keeps who worked on it.
      expect(await assigneesOf(source.id)).toEqual([users.member!.userId, former].sort());
    } finally {
      await setActive(former, true);
    }
  });
});

describe('recurring tasks', () => {
  it('are created on schedule, with no assignee to fail on', async () => {
    // A template carries no assignees, so the job that files recurring tasks
    // assigns nobody, and nobody leaving can make it fail.
    const { db } = getDb();
    const templateId = ulid();
    await db.insert(schema.taskTemplates).values({ id: templateId, projectId: ws.projectId, name: 'Weekly report', definition: { titlePattern: 'Weekly report' } });
    await db.insert(schema.recurringTasks).values({ id: ulid(), projectId: ws.projectId, templateId, frequency: 'weekly', nextRun: '2000-01-01', active: true });
    await runRecurringTasks();
    const made = await tasksTitled('Weekly report');
    expect(made).toHaveLength(1);
    expect(await assigneesOf(made[0]!.id)).toEqual([]);
  });
});
