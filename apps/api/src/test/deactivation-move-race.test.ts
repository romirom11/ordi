/**
 * A task moved while its assignee is being deactivated (ORD-41). A move
 * soft-deletes the original and makes a copy with the same assignees; a
 * deactivation that had already picked the original used to take the person
 * off the deleted original only, leaving the copy – open work – with someone
 * who can no longer sign in. Whichever of the two commits first, no open task
 * may end up assigned to a deactivated user.
 *
 * Each race is made deterministic with a trigger that parks one side on an
 * advisory lock the test holds: the other side is started, the test waits
 * until Postgres reports it blocked on a row lock, then lets the first go.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, schema, eq, and, isNull, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

const PARK_KEY = 4141;

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let source: { id: string; key: string };
let target: { id: string; key: string };

async function newProject(name: string, key: string) {
  const { db } = getDb();
  const typeId = ulid();
  await db.insert(schema.projectTypes).values({ id: typeId, name: `${name} type` });
  const res = await reqAs(users.owner!.cookie).post('/projects', { name, key, projectTypeId: typeId });
  expect(res.status).toBe(201);
  return json(res);
}

async function createTask(projectId: string, title: string, extra: Record<string, unknown> = {}) {
  const res = await reqAs(users.owner!.cookie).post('/tasks', { projectId, title, ...extra });
  expect(res.status).toBe(201);
  return json(res);
}

async function assigneesOf(taskId: string): Promise<string[]> {
  const rows = await getDb().db.select({ userId: schema.taskAssignees.userId })
    .from(schema.taskAssignees).where(eq(schema.taskAssignees.taskId, taskId));
  return rows.map((r) => r.userId).sort();
}

/** Live (not deleted) tasks still assigned to the user, with their status category. */
async function liveTasksOf(userId: string) {
  return getDb().db.select({ id: schema.tasks.id, category: schema.taskStatuses.category })
    .from(schema.tasks)
    .innerJoin(schema.taskAssignees, eq(schema.taskAssignees.taskId, schema.tasks.id))
    .innerJoin(schema.taskStatuses, eq(schema.taskStatuses.id, schema.tasks.statusId))
    .where(and(eq(schema.taskAssignees.userId, userId), isNull(schema.tasks.deletedAt)));
}

/**
 * Hold the advisory lock on a connection of its own until `release` is
 * called. A trigger that takes the same lock parks whichever transaction
 * fires it, mid-way and holding its row locks.
 */
async function holdPark(): Promise<{ release: () => Promise<void> }> {
  const { db } = getDb();
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  let taken!: () => void;
  const lockTaken = new Promise<void>((r) => { taken = r; });
  const tx = db.transaction(async (t) => {
    await t.execute(sql.raw(`SELECT pg_advisory_xact_lock(${PARK_KEY})`));
    taken();
    await held;
  });
  await lockTaken;
  return { release: async () => { release(); await tx; } };
}

/** Wait until some backend of this database waits on `waitEvent` (e.g. a row lock or the park). */
async function waitUntilBlocked(waitEvent: 'transactionid' | 'tuple' | 'advisory', minBackends = 1): Promise<void> {
  const { db } = getDb();
  const events = waitEvent === 'advisory' ? ['advisory'] : ['transactionid', 'tuple'];
  for (let i = 0; i < 200; i++) {
    const rows = await db.execute(sql.raw(`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock' AND wait_event IN (${events.map((e) => `'${e}'`).join(', ')})`));
    const n = Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
    if (n >= minBackends) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no backend blocked on ${waitEvent}`);
}

async function parkOn(table: string, when: string) {
  await getDb().db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION test_park() RETURNS trigger AS $$
    BEGIN PERFORM pg_advisory_xact_lock(${PARK_KEY}); RETURN NEW; END $$ LANGUAGE plpgsql;
    CREATE TRIGGER test_park BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION test_park();`));
}

async function unpark(table: string) {
  await getDb().db.execute(sql.raw(`DROP TRIGGER IF EXISTS test_park ON ${table}; DROP FUNCTION IF EXISTS test_park();`));
}

beforeEach(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  source = await newProject('Source', 'SRC');
  target = await newProject('Target', 'TGT');
});

describe('a move and a deactivation of the same task, in either order', () => {
  it('the move commits first: the deactivation takes the person off the moved copy', async () => {
    const leaver = users.member!.userId;
    const task = await createTask(source.id, 'Moving work', { assigneeIds: [leaver] });
    // The move parks once it has locked the original and is copying the
    // leaver onto the new task: not committed yet.
    await parkOn('task_assignees', `NEW.task_id <> '${task.id}' AND NEW.user_id = '${leaver}'`);
    const park = await holdPark();
    try {
      const move = reqAs(users.owner!.cookie).post(`/tasks/${task.id}/move`, { targetProjectId: target.id });
      await waitUntilBlocked('advisory');
      // The deactivation now sees the original as the leaver's open task and
      // waits for the move's lock on it.
      const deactivate = reqAs(users.admin!.cookie).post(`/users/${leaver}/deactivate`, { reassignTo: users.hr!.userId });
      await waitUntilBlocked('transactionid');
      await park.release();
      const moved = await move;
      expect(moved.status).toBe(200);
      const copy = await json(moved);
      const res = await deactivate;
      expect(res.status).toBe(200);
      expect((await json(res)).handedOffTasks).toBe(1);

      expect(await assigneesOf(copy.id)).toEqual([users.hr!.userId]);
      expect(await liveTasksOf(leaver)).toEqual([]);
      // The hand-over reads on the copy, the task that is still open.
      const trail = await getDb().db.select().from(schema.activityLog).where(and(
        eq(schema.activityLog.entityType, 'task'), eq(schema.activityLog.action, 'reassigned'),
      ));
      expect(trail.map((r) => r.entityId)).toEqual([copy.id]);
    } finally {
      await park.release();
      await unpark('task_assignees');
    }
  });

  it('the deactivation commits first: the move copies no deactivated assignee', async () => {
    const leaver = users.member!.userId;
    const task = await createTask(source.id, 'Moving work', { assigneeIds: [leaver] });
    // The deactivation parks as it switches the person off, after it has
    // locked and handed over their tasks.
    await parkOn('users', `NEW.id = '${leaver}' AND NEW.is_active = false`);
    const park = await holdPark();
    try {
      const deactivate = reqAs(users.admin!.cookie).post(`/users/${leaver}/deactivate`);
      await waitUntilBlocked('advisory');
      const move = reqAs(users.owner!.cookie).post(`/tasks/${task.id}/move`, { targetProjectId: target.id });
      await waitUntilBlocked('transactionid');
      await park.release();
      expect((await deactivate).status).toBe(200);
      const moved = await move;
      expect(moved.status).toBe(200);
      expect(await assigneesOf((await json(moved)).id)).toEqual([]);
      expect(await liveTasksOf(leaver)).toEqual([]);
    } finally {
      await park.release();
      await unpark('users');
    }
  });
});

describe('moving a task whose assignee is already deactivated', () => {
  it('leaves them off open work and keeps them on closed work', async () => {
    const gone = users.member!.userId;
    const stays = users.hr!.userId;
    const statuses = await json(reqAs(users.owner!.cookie).get(`/projects/${source.id}/task-statuses`));
    const doneId = statuses.data.find((s: { category: string }) => s.category === 'done').id;
    const parent = await createTask(source.id, 'Open parent', { assigneeIds: [gone, stays] });
    const child = await createTask(source.id, 'Finished child', { assigneeIds: [gone], parentId: parent.id });
    await reqAs(users.owner!.cookie).patch(`/tasks/${child.id}`, { statusId: doneId });
    // Switched off some other way than a deactivation's hand-over, so they
    // are still on both tasks.
    await getDb().db.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, gone));

    const res = await reqAs(users.owner!.cookie).post(`/tasks/${parent.id}/move`, { targetProjectId: target.id });
    expect(res.status).toBe(200);
    const moved = await json(res);
    expect(await assigneesOf(moved.id)).toEqual([stays]);
    const [movedChild] = await getDb().db.select({ id: schema.tasks.id }).from(schema.tasks)
      .where(and(eq(schema.tasks.parentId, moved.id), isNull(schema.tasks.deletedAt)));
    // Who finished it is history, and history stays.
    expect(await assigneesOf(movedChild!.id)).toEqual([gone]);
  });
});
