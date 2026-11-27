/**
 * Creating, duplicating, moving and commenting on a task, accepting an intake
 * item and editing a project are all or nothing. They used to write in
 * several steps outside a transaction – or write their events after the
 * transaction committed – so a failure part way left a task without its
 * assignees, an intake item pending next to the task made from it, labels
 * changed on a refused project edit, or events about things that never
 * committed. Each test forces a failure after the first write (an invalid
 * later input, or a trigger that raises) and checks nothing was written and
 * nothing was queued.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq, and, inArray, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { setupWorkspace, type Workspace } from './agents-helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let ws: Workspace;
let target: Workspace;
let owner: ReturnType<typeof reqAs>;

/** Run `fn` while every matching write to `table` raises, as a failure part way would. */
async function failingOn<T>(table: string, when: string, fn: () => T | Promise<T>): Promise<T> {
  const { db } = getDb();
  await db.execute(sql.raw(`CREATE OR REPLACE FUNCTION ordi_test_fail() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'injected failure'; END $$ LANGUAGE plpgsql`));
  await db.execute(sql.raw(`CREATE TRIGGER ordi_test_fail BEFORE INSERT OR UPDATE ON ${table}
    FOR EACH ROW WHEN (${when}) EXECUTE FUNCTION ordi_test_fail()`));
  try {
    return await fn();
  } finally {
    await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ordi_test_fail ON ${table}`));
  }
}

async function tasksTitled(title: string) {
  return getDb().db.select().from(schema.tasks).where(eq(schema.tasks.title, title));
}

async function eventsAbout(ids: string[], types: string[]) {
  if (!ids.length) return [];
  return getDb().db.select().from(schema.events)
    .where(and(inArray(schema.events.aggregateId, ids), inArray(schema.events.type, types)));
}

async function eventCount(type: string): Promise<number> {
  const rows = await getDb().db.select({ id: schema.events.id }).from(schema.events).where(eq(schema.events.type, type));
  return rows.length;
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  ws = await setupWorkspace(users, 'WRT');
  target = await setupWorkspace(users, 'WRTB');
  owner = reqAs(users.owner!.cookie);
});

describe('creating a task', () => {
  it('that fails after the row is written leaves no task and announces nothing', async () => {
    const createdBefore = await eventCount('task.created');
    // A person who does not exist: the assignee row fails after the task row.
    const res = await owner.post('/tasks', { projectId: ws.projectId, title: 'Half made', assigneeIds: [ulid()] });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await tasksTitled('Half made')).toHaveLength(0);
    expect(await eventCount('task.created')).toBe(createdBefore);

    // The same request with a real assignee is created, with its events.
    const ok = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Made whole', assigneeIds: [users.member!.userId] }));
    expect(ok.ref).toMatch(/^WRT-\d+$/);
    const events = await eventsAbout([ok.id], ['task.created', 'task.assigned']);
    expect(events.map((e) => e.type).sort()).toEqual(['task.assigned', 'task.created']);
    expect((events.find((e) => e.type === 'task.created')!.payload as { ref: string }).ref).toBe(ok.ref);
  });
});

describe('accepting an intake item', () => {
  async function intakeItem(title: string): Promise<string> {
    const id = ulid();
    await getDb().db.insert(schema.intakeItems).values({ id, projectId: ws.projectId, title, description: 'From the form', source: 'form' } as typeof schema.intakeItems.$inferInsert);
    return id;
  }

  it('that fails part way leaves the item pending and makes no task', async () => {
    const itemId = await intakeItem('Intake that fails');
    const createdBefore = await eventCount('task.created');
    const res = await failingOn('intake_items', `NEW.status = 'accepted'`, () => owner.post(`/intake/${itemId}/accept`, {}));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await tasksTitled('Intake that fails')).toHaveLength(0);
    expect(await eventCount('task.created')).toBe(createdBefore);
    const [item] = await getDb().db.select().from(schema.intakeItems).where(eq(schema.intakeItems.id, itemId));
    expect(item!.status).toBe('pending');
    expect(item!.createdTaskId).toBeNull();

    // Accepted for real, the item points at its one task.
    const ok = await json(owner.post(`/intake/${itemId}/accept`, {}));
    const [after] = await getDb().db.select().from(schema.intakeItems).where(eq(schema.intakeItems.id, itemId));
    expect(after).toMatchObject({ status: 'accepted', createdTaskId: ok.taskId });
    expect(await tasksTitled('Intake that fails')).toHaveLength(1);
  });

  it('twice at once makes one task', async () => {
    const itemId = await intakeItem('Accepted twice');
    const results = await Promise.all([owner.post(`/intake/${itemId}/accept`, {}), owner.post(`/intake/${itemId}/accept`, {})]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
    expect(await tasksTitled('Accepted twice')).toHaveLength(1);
  });

  it('accepted and declined at once ends one way only', async () => {
    const itemId = await intakeItem('Accepted or declined');
    const [accept, decline] = await Promise.all([
      owner.post(`/intake/${itemId}/accept`, {}),
      owner.post(`/intake/${itemId}/decline`, { reason: 'Duplicate' }),
    ]);
    expect([accept.status, decline.status].filter((s) => s >= 400)).toEqual([422]);
    const [item] = await getDb().db.select().from(schema.intakeItems).where(eq(schema.intakeItems.id, itemId));
    const made = await tasksTitled('Accepted or declined');
    if (accept.status === 201) expect({ status: item!.status, tasks: made.length }).toEqual({ status: 'accepted', tasks: 1 });
    else expect({ status: item!.status, tasks: made.length }).toEqual({ status: 'declined', tasks: 0 });
  });
});

describe('duplicating a task', () => {
  it('that fails part way leaves no copy and announces nothing', async () => {
    const source = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Copy me', assigneeIds: [users.member!.userId] }));
    const createdBefore = await eventCount('task.created');
    const res = await failingOn('task_assignees', 'true', () => owner.post(`/tasks/${source.id}/duplicate`));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await tasksTitled('Copy me (copy)')).toHaveLength(0);
    expect(await eventCount('task.created')).toBe(createdBefore);

    const copy = await json(owner.post(`/tasks/${source.id}/duplicate`));
    expect(copy.ref).toMatch(/^WRT-\d+$/);
    expect(await eventsAbout([copy.id], ['task.created'])).toHaveLength(1);
  });
});

describe('moving a task', () => {
  it('that fails at its activity record moves nothing and announces nothing', async () => {
    const task = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Stay put' }));
    const createdBefore = await eventCount('task.created');
    const res = await failingOn('activity_log', `NEW.action = 'moved'`, () => owner.post(`/tasks/${task.id}/move`, { targetProjectId: target.projectId }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    const rows = await tasksTitled('Stay put');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId: ws.projectId, deletedAt: null, redirectToTaskId: null });
    expect(await eventCount('task.created')).toBe(createdBefore);

    const moved = await json(owner.post(`/tasks/${task.id}/move`, { targetProjectId: target.projectId }));
    expect(moved.ref).toMatch(/^WRTB-\d+$/);
    const [event] = await eventsAbout([moved.id], ['task.created']);
    expect(event!.payload).toMatchObject({ ref: moved.ref, projectId: target.projectId, movedFrom: task.id });
  });

  it('to two projects at once lands in one of them', async () => {
    const third = await setupWorkspace(users, 'WRTC');
    const task = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Moved twice' }));
    const results = await Promise.all([
      owner.post(`/tasks/${task.id}/move`, { targetProjectId: target.projectId }),
      owner.post(`/tasks/${task.id}/move`, { targetProjectId: third.projectId }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    const live = (await tasksTitled('Moved twice')).filter((t) => t.deletedAt === null);
    expect(live).toHaveLength(1);
    const [source] = (await tasksTitled('Moved twice')).filter((t) => t.id === task.id);
    expect(source!.redirectToTaskId).toBe(live[0]!.id);
    expect(await eventsAbout(live.map((t) => t.id), ['task.created'])).toHaveLength(1);
  });
});

describe('commenting on a task', () => {
  it('that fails at its event leaves no comment', async () => {
    const task = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Quiet task' }));
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Lost words' }] }] };
    const res = await failingOn('events', `NEW.type = 'comment.created'`, () => owner.post(`/tasks/${task.id}/comments`, { body, mentions: [users.member!.userId] }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    const { db } = getDb();
    expect(await db.select().from(schema.comments).where(eq(schema.comments.taskId, task.id))).toHaveLength(0);
    // Nor the mention that would have announced it.
    const mentioned = await db.select().from(schema.events).where(eq(schema.events.type, 'comment.mentioned'));
    expect(mentioned.filter((e) => (e.payload as { taskId?: string }).taskId === task.id)).toHaveLength(0);

    const ok = await json(owner.post(`/tasks/${task.id}/comments`, { body, mentions: [users.member!.userId] }));
    expect((await eventsAbout([ok.id], ['comment.created', 'comment.mentioned'])).map((e) => e.type).sort()).toEqual(['comment.created', 'comment.mentioned']);
  });
});

describe('editing a project', () => {
  it('that fails after its labels are replaced keeps the old labels and fields', async () => {
    const { db } = getDb();
    const keep = await json(owner.post('/labels', { name: 'Keep', color: '#111111', scope: 'project' }));
    const other = await json(owner.post('/labels', { name: 'Other', color: '#222222', scope: 'project' }));
    let project = await json(owner.get(`/projects/${ws.projectId}`));
    project = await json(owner.patch(`/projects/${ws.projectId}`, { version: project.version, labelIds: [keep.id] }));

    // A lead who does not exist fails the project row, after the labels.
    const res = await owner.patch(`/projects/${ws.projectId}`, { version: project.version, labelIds: [other.id], name: 'Renamed', leadId: ulid() });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const labels = await db.select({ labelId: schema.projectLabels.labelId }).from(schema.projectLabels).where(eq(schema.projectLabels.projectId, ws.projectId));
    expect(labels.map((l) => l.labelId)).toEqual([keep.id]);
    const [row] = await db.select().from(schema.projects).where(eq(schema.projects.id, ws.projectId));
    expect(row).toMatchObject({ name: project.name, version: project.version });
  });

  it('that fails at its activity record announces nothing', async () => {
    const project = await json(owner.get(`/projects/${target.projectId}`));
    const completedBefore = await eventCount('project.completed');
    const res = await failingOn('activity_log', `NEW.entity_type = 'project'`, () => owner.patch(`/projects/${target.projectId}`, { version: project.version, status: 'completed' }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await eventCount('project.completed')).toBe(completedBefore);
    const [row] = await getDb().db.select().from(schema.projects).where(eq(schema.projects.id, target.projectId));
    expect(row!.status).toBe(project.status);
  });
});
