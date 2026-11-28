/**
 * Assigning someone while they are being deactivated. A deactivation locks
 * the person, takes them off their open tasks and switches them off; a write
 * that adds them as an assignee locks them too, before any task. Whichever
 * commits first, no open task may end up assigned to someone switched off,
 * and a refused write leaves nothing behind. The same holds for the
 * successor a deactivation hands work to.
 *
 * Each race runs through the real endpoints and is made deterministic with
 * the park trigger of race-helpers.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, schema, eq, and, inArray } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { setupWorkspace, type Workspace } from './agents-helpers';
import { holdPark, waitUntilBlocked, start, parkOn, unpark, resetInFlight } from './race-helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let ws: Workspace;
const owner = () => reqAs(users.owner!.cookie);
const admin = () => reqAs(users.admin!.cookie);

async function assigneesOf(taskId: string): Promise<string[]> {
  const rows = await getDb().db.select({ userId: schema.taskAssignees.userId }).from(schema.taskAssignees)
    .where(eq(schema.taskAssignees.taskId, taskId));
  return rows.map((r) => r.userId).sort();
}

async function isActive(userId: string): Promise<boolean> {
  const [row] = await getDb().db.select({ isActive: schema.users.isActive }).from(schema.users).where(eq(schema.users.id, userId));
  return row!.isActive;
}

async function newTask(title: string, extra: Record<string, unknown> = {}) {
  const res = await owner().post('/tasks', { projectId: ws.projectId, title, ...extra });
  expect(res.status).toBe(201);
  return json(res);
}

async function assignedEvents(taskIds: string[]): Promise<number> {
  const rows = await getDb().db.select({ id: schema.events.id }).from(schema.events)
    .where(and(eq(schema.events.type, 'task.assigned'), inArray(schema.events.aggregateId, taskIds)));
  return rows.length;
}

/** Park `userId`'s deactivation at the moment it switches them off, holding their row. */
async function parkDeactivationOf(userId: string) {
  await parkOn('users', `NEW.id = '${userId}' AND NEW.is_active = false`);
  const park = await holdPark();
  const deactivate = start(admin().post(`/users/${userId}/deactivate`));
  await waitUntilBlocked('advisory', '%update "users"%');
  return { park, deactivate };
}

beforeEach(async () => {
  resetInFlight();
  await resetDb();
  users = await seedRolesAndUsers();
  ws = await setupWorkspace(users, 'RCE');
});

describe('an assignment and a deactivation of the assignee', () => {
  it('the deactivation commits first: the edit waits, then is refused and changes nothing', async () => {
    const leaver = users.hr!.userId;
    const task = await newTask('Assigned as they leave');
    const { park, deactivate } = await parkDeactivationOf(leaver);
    try {
      // The edit's early check still reads them as active; it must then wait
      // on their row, not go ahead.
      const assign = start(owner().patch(`/tasks/${task.id}`, { assigneeIds: [leaver] }));
      await waitUntilBlocked('row', '%for key share%');
      await park.release();
      expect((await deactivate).status).toBe(200);
      const res = await assign;
      expect(res.status).toBe(400);
      expect((await json(res)).error.message).toBe('Assignees must be active users');
      expect(await assigneesOf(task.id)).toEqual([]);
      expect(await assignedEvents([task.id])).toBe(0);
    } finally {
      // A failed assertion must not leave a request parked: unpark waits for them all.
      await park.release();
      await unpark('users');
    }
  });

  it('the assignment commits first: the deactivation waits, then takes them off the task', async () => {
    const leaver = users.hr!.userId;
    const task = await newTask('Assigned just before they leave');
    await parkOn('task_assignees', `NEW.user_id = '${leaver}'`);
    const park = await holdPark();
    try {
      const assign = start(owner().patch(`/tasks/${task.id}`, { assigneeIds: [leaver] }));
      await waitUntilBlocked('advisory', '%insert into "task_assignees"%');
      const deactivate = start(admin().post(`/users/${leaver}/deactivate`));
      await waitUntilBlocked('row', '%for update%');
      await park.release();
      expect((await assign).status).toBe(200);
      expect((await deactivate).status).toBe(200);
      expect(await assigneesOf(task.id)).toEqual([]);
      expect(await isActive(leaver)).toBe(false);
    } finally {
      // A failed assertion must not leave a request parked: unpark waits for them all.
      await park.release();
      await unpark('task_assignees');
    }
  });

  it('a task created for them while they are switched off is refused, and none is made', async () => {
    const leaver = users.hr!.userId;
    const { park, deactivate } = await parkDeactivationOf(leaver);
    try {
      const create = start(owner().post('/tasks', { projectId: ws.projectId, title: 'Created as they leave', assigneeIds: [leaver] }));
      await waitUntilBlocked('row', '%for key share%');
      await park.release();
      expect((await deactivate).status).toBe(200);
      expect((await create).status).toBe(400);
      const made = await getDb().db.select().from(schema.tasks).where(eq(schema.tasks.title, 'Created as they leave'));
      expect(made).toHaveLength(0);
    } finally {
      // A failed assertion must not leave a request parked: unpark waits for them all.
      await park.release();
      await unpark('users');
    }
  });

  it('a bulk edit refused part way through, under lock, leaves every task as it was', async () => {
    const leaver = users.hr!.userId;
    const statuses = (await json(owner().get(`/projects/${ws.projectId}/task-statuses`))).data as { id: string; category: string }[];
    const done = statuses.find((s) => s.category === 'done')!;
    // Closed work keeps who did it, so the deactivation leaves the first task
    // alone and the bulk edit adds nobody to it; the second gains the leaver.
    const kept = await newTask('Closed, theirs', { statusId: done.id, assigneeIds: [leaver] });
    const fresh = await newTask('Open, nobody\'s');
    const { park, deactivate } = await parkDeactivationOf(leaver);
    try {
      const bulk = start(owner().post('/tasks/bulk', { taskIds: [kept.id, fresh.id], priority: 'urgent', assigneeIds: [leaver] }));
      await waitUntilBlocked('row', '%for key share%');
      await park.release();
      expect((await deactivate).status).toBe(200);
      const res = await bulk;
      expect(res.status).toBe(400);
      expect((await json(res)).error.message).toBe('Assignees must be active users');
      for (const t of [kept, fresh]) expect((await json(owner().get(`/tasks/${t.id}`))).priority).toBe('none');
      expect(await assigneesOf(kept.id)).toEqual([leaver]);
      expect(await assigneesOf(fresh.id)).toEqual([]);
      expect(await assignedEvents([fresh.id])).toBe(0);
    } finally {
      // A failed assertion must not leave a request parked: unpark waits for them all.
      await park.release();
      await unpark('users');
    }
  });
});

describe('a hand-over to someone who is leaving too', () => {
  it('is refused once their deactivation commits, and the first person stays as they were', async () => {
    const first = users.member!.userId;
    const successor = users.hr!.userId;
    const task = await newTask('Handed on', { assigneeIds: [first] });
    const { park, deactivate } = await parkDeactivationOf(successor);
    try {
      const handOver = start(admin().post(`/users/${first}/deactivate`, { reassignTo: successor }));
      await waitUntilBlocked('row', '%for key share%', '%for update%');
      await park.release();
      expect((await deactivate).status).toBe(200);
      const res = await handOver;
      expect(res.status).toBe(400);
      expect((await json(res)).error.message).toBe('Tasks cannot be handed over to a deactivated user');
      expect(await isActive(first)).toBe(true);
      expect(await assigneesOf(task.id)).toEqual([first]);
    } finally {
      // A failed assertion must not leave a request parked: unpark waits for them all.
      await park.release();
      await unpark('users');
    }
  });

  it('two people handing work to each other: one goes through, the other is refused', async () => {
    const a = users.member!.userId;
    const b = users.hr!.userId;
    const taskOfA = await newTask('A\'s work', { assigneeIds: [a] });
    const taskOfB = await newTask('B\'s work', { assigneeIds: [b] });
    await parkOn('users', `NEW.id = '${a}' AND NEW.is_active = false`);
    const park = await holdPark();
    try {
      const aToB = start(admin().post(`/users/${a}/deactivate`, { reassignTo: b }));
      await waitUntilBlocked('advisory', '%update "users"%');
      const bToA = start(admin().post(`/users/${b}/deactivate`, { reassignTo: a }));
      await waitUntilBlocked('row', '%for key share%', '%for update%');
      await park.release();
      expect((await aToB).status).toBe(200);
      expect((await bToA).status).toBe(400);
      expect(await isActive(a)).toBe(false);
      expect(await isActive(b)).toBe(true);
      expect(await assigneesOf(taskOfA.id)).toEqual([b]);
      expect(await assigneesOf(taskOfB.id)).toEqual([b]);
    } finally {
      // A failed assertion must not leave a request parked: unpark waits for them all.
      await park.release();
      await unpark('users');
    }
  });
});
