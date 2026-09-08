/**
 * Project fixes: moving a task carries its subtree, comments, relations and
 * logged time; the projects list gets its completion counts from one grouped
 * query; task lists mark tasks blocked by an open "blocks" relation.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectA: { id: string; key: string };
let projectB: { id: string; key: string };

/** A type of our own – seeded types may require a client. */
let typeId: string;

async function createProject(name: string, key: string) {
  const res = await reqAs(users.owner!.cookie).post('/projects', { name, key, projectTypeId: typeId });
  expect(res.status).toBe(201);
  return json(res);
}

async function createTask(projectId: string, title: string, extra: Record<string, unknown> = {}) {
  const res = await reqAs(users.owner!.cookie).post('/tasks', { projectId, title, ...extra });
  expect(res.status).toBe(201);
  return json(res);
}

async function doneStatusId(projectId: string): Promise<string> {
  const statuses = await json(reqAs(users.owner!.cookie).get(`/projects/${projectId}/task-statuses`));
  return statuses.data.find((s: { category: string }) => s.category === 'done').id;
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();
  typeId = ulid();
  await db.insert(schema.projectTypes).values({ id: typeId, name: 'Service' });
  projectA = await createProject('Source', 'SRC');
  projectB = await createProject('Target', 'TGT');
});

describe('move task between projects', () => {
  it('moves the subtree with comments, relations and time intact', async () => {
    const { db } = getDb();
    const parent = await createTask(projectA.id, 'Parent work');
    const child = await createTask(projectA.id, 'Child step', { parentId: parent.id });
    const other = await createTask(projectA.id, 'Blocker elsewhere');
    await reqAs(users.owner!.cookie).post(`/tasks/${other.id}/relations`, {
      relatedTaskId: parent.id, type: 'blocks',
    });
    await reqAs(users.owner!.cookie).post(`/tasks/${parent.id}/comments`, {
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'context' }] }] },
    });
    await db.insert(schema.timeEntries).values({
      id: ulid(), taskId: parent.id, userId: users.owner!.userId, projectId: projectA.id,
      startedAt: new Date(), durationSeconds: 3600,
    });

    const moved = await json(reqAs(users.owner!.cookie).post(`/tasks/${parent.id}/move`, { targetProjectId: projectB.id }));
    expect(moved.projectId).toBe(projectB.id);
    expect(moved.ref.startsWith('TGT-')).toBe(true);

    // The comment and the incoming relation live on the new task.
    const full = await json(reqAs(users.owner!.cookie).get(`/tasks/${moved.id}?include=comments,relations`));
    expect(full.comments).toHaveLength(1);
    expect(full.relations.incoming).toHaveLength(1);

    // The subtask followed, parented to the new task, in the target project.
    const children = await json(reqAs(users.owner!.cookie).get(`/tasks?projectId=${projectB.id}&parentId=${moved.id}`));
    expect(children.data).toHaveLength(1);
    expect(children.data[0].title).toBe('Child step');

    // Hours moved with the work.
    const [entry] = await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.taskId, moved.id));
    expect(entry?.projectId).toBe(projectB.id);

    // The originals are gone from the source project.
    expect((await reqAs(users.owner!.cookie).get(`/tasks/${parent.id}`)).status).toBe(404);
    expect((await reqAs(users.owner!.cookie).get(`/tasks/${child.id}`)).status).toBe(404);
  });
});

describe('move rules (ORD-23)', () => {
  const owner = () => reqAs(users.owner!.cookie);

  async function statusByName(projectId: string, name: string): Promise<{ id: string; category: string }> {
    const statuses = await json(owner().get(`/projects/${projectId}/task-statuses`));
    return statuses.data.find((s: { name: string }) => s.name === name);
  }

  it('lands on the status of the same name, else the same category, else the default', async () => {
    // "Review" exists on both sides; "QA" only on the source.
    await json(owner().post(`/projects/${projectA.id}/task-statuses`, { name: 'Review', category: 'in_progress' }));
    await json(owner().post(`/projects/${projectB.id}/task-statuses`, { name: 'Review', category: 'in_progress' }));
    await json(owner().post(`/projects/${projectA.id}/task-statuses`, { name: 'QA', category: 'in_progress' }));

    const inReview = await createTask(projectA.id, 'Under review', { statusId: (await statusByName(projectA.id, 'Review')).id });
    const inQa = await createTask(projectA.id, 'In QA', { statusId: (await statusByName(projectA.id, 'QA')).id });
    const done = await createTask(projectA.id, 'Shipped', { statusId: await doneStatusId(projectA.id) });

    const movedReview = await json(owner().post(`/tasks/${inReview.id}/move`, { targetProjectId: projectB.id }));
    expect(movedReview.statusId).toBe((await statusByName(projectB.id, 'Review')).id);

    const movedQa = await json(owner().post(`/tasks/${inQa.id}/move`, { targetProjectId: projectB.id }));
    const qaLanded = (await json(owner().get(`/projects/${projectB.id}/task-statuses`))).data
      .find((s: { id: string }) => s.id === movedQa.statusId);
    expect(qaLanded.category).toBe('in_progress');
    expect(qaLanded.name).not.toBe('QA');

    // Same name on both sides again, via the seeded set: Done stays Done.
    const movedDone = await json(owner().post(`/tasks/${done.id}/move`, { targetProjectId: projectB.id }));
    expect(movedDone.statusId).toBe(await doneStatusId(projectB.id));
  });

  it('keeps custom fields the target knows and drops the source-only ones', async () => {
    await json(owner().post('/custom-fields', { entityType: 'tasks', key: 'platform', label: 'Platform', type: 'text' }));
    await json(owner().post('/custom-fields', { entityType: 'tasks', projectId: projectA.id, key: 'src_only', label: 'Source only', type: 'text' }));
    await json(owner().post('/custom-fields', { entityType: 'tasks', projectId: projectB.id, key: 'tgt_only', label: 'Target only', type: 'text' }));

    const task = await createTask(projectA.id, 'With fields', { customFields: { platform: 'linkedin', src_only: 'gone' } });
    const moved = await json(owner().post(`/tasks/${task.id}/move`, { targetProjectId: projectB.id }));
    expect(moved.customFields).toEqual({ platform: 'linkedin' });
  });

  it('needs admin rights on both projects', async () => {
    const task = await createTask(projectA.id, 'Guarded');
    await owner().post(`/projects/${projectA.id}/members`, { userId: users.member!.userId, role: 'admin', canWriteTasks: true });
    await owner().post(`/projects/${projectB.id}/members`, { userId: users.member!.userId, role: 'member', canWriteTasks: true });

    const asMember = await reqAs(users.member!.cookie).post(`/tasks/${task.id}/move`, { targetProjectId: projectB.id });
    expect(asMember.status).toBe(403);
    // Nothing moved: the task is still where it was.
    expect((await owner().get(`/tasks/${task.id}`)).status).toBe(200);

    await owner().post(`/projects/${projectB.id}/members`, { userId: users.member!.userId, role: 'admin', canWriteTasks: true });
    const asAdmin = await reqAs(users.member!.cookie).post(`/tasks/${task.id}/move`, { targetProjectId: projectB.id });
    expect(asAdmin.status).toBe(200);
  });
});

describe('project task counts', () => {
  it('returns totals and done per accessible project from one call', async () => {
    const done = await createTask(projectA.id, 'Counted done');
    await createTask(projectA.id, 'Counted open');
    await reqAs(users.owner!.cookie).patch(`/tasks/${done.id}`, { statusId: await doneStatusId(projectA.id) });

    const res = await json(reqAs(users.owner!.cookie).get('/projects/task-counts'));
    const forA = res.data.find((row: { projectId: string }) => row.projectId === projectA.id);
    expect(forA.total).toBeGreaterThanOrEqual(2);
    expect(forA.done).toBeGreaterThanOrEqual(1);
  });
});

describe('blocked flag on task lists', () => {
  it('marks a task blocked while its blocker is open, and clears when it closes', async () => {
    const blocker = await createTask(projectB.id, 'Blocker');
    const blocked = await createTask(projectB.id, 'Waiting on blocker');
    await reqAs(users.owner!.cookie).post(`/tasks/${blocker.id}/relations`, {
      relatedTaskId: blocked.id, type: 'blocks',
    });

    let list = await json(reqAs(users.owner!.cookie).get(`/tasks?projectId=${projectB.id}`));
    let row = list.data.find((task: { id: string }) => task.id === blocked.id);
    expect(row.blocked).toBe(true);
    expect(list.data.find((task: { id: string }) => task.id === blocker.id).blocked).toBe(false);

    await reqAs(users.owner!.cookie).patch(`/tasks/${blocker.id}`, { statusId: await doneStatusId(projectB.id) });
    list = await json(reqAs(users.owner!.cookie).get(`/tasks?projectId=${projectB.id}`));
    row = list.data.find((task: { id: string }) => task.id === blocked.id);
    expect(row.blocked).toBe(false);
  });
});
