/**
 * A project's own task statuses: a project admin adds, edits, reorders and
 * deletes them, and none of it can leave the project without a default status
 * or a task without a status.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let typeId: string;

interface Status { id: string; name: string; category: string; color: string; position: number; isDefault: boolean }

const owner = () => reqAs(users.owner!.cookie);

async function createProject(key: string): Promise<string> {
  const res = await owner().post('/projects', { name: `Project ${key}`, key, projectTypeId: typeId });
  expect(res.status).toBe(201);
  return (await json(res)).id;
}

async function statuses(projectId: string): Promise<Status[]> {
  return (await json(owner().get(`/projects/${projectId}/task-statuses`))).data;
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  typeId = ulid();
  await getDb().db.insert(schema.projectTypes).values({ id: typeId, name: 'Service' });
});

describe('task statuses', () => {
  it('appends a new status at the end of the board and returns it', async () => {
    const projectId = await createProject('ADD');
    const before = await statuses(projectId);
    const res = await owner().post(`/projects/${projectId}/task-statuses`, { name: 'Awaiting client', category: 'in_progress', color: '#0ea5e9' });
    expect(res.status).toBe(201);
    const created: Status = await json(res);
    expect(created).toMatchObject({ name: 'Awaiting client', category: 'in_progress', color: '#0ea5e9', isDefault: false });
    const after = await statuses(projectId);
    expect(after).toHaveLength(before.length + 1);
    expect(after.at(-1)!.id).toBe(created.id);
  });

  it('refuses a second status with the same name, whatever the case', async () => {
    const projectId = await createProject('DUP');
    const res = await owner().post(`/projects/${projectId}/task-statuses`, { name: ' todo ', category: 'todo' });
    expect(res.status).toBe(400);
    const existing = (await statuses(projectId)).find((s) => s.name === 'Done')!;
    const rename = await owner().patch(`/task-statuses/${existing.id}`, { name: 'BACKLOG' });
    expect(rename.status).toBe(400);
  });

  it('moves the default instead of dropping it', async () => {
    const projectId = await createProject('DEF');
    const list = await statuses(projectId);
    const current = list.find((s) => s.isDefault)!;
    const other = list.find((s) => !s.isDefault)!;

    expect((await owner().patch(`/task-statuses/${current.id}`, { isDefault: false })).status).toBe(400);

    const res = await owner().patch(`/task-statuses/${other.id}`, { isDefault: true });
    expect(res.status).toBe(200);
    const defaults = (await statuses(projectId)).filter((s) => s.isDefault);
    expect(defaults.map((s) => s.id)).toEqual([other.id]);
  });

  it('reorders the whole board and refuses a partial list', async () => {
    const projectId = await createProject('ORD');
    const ids = (await statuses(projectId)).map((s) => s.id);
    const reversed = [...ids].reverse();
    const res = await owner().patch(`/projects/${projectId}/task-statuses/order`, { ids: reversed });
    expect(res.status).toBe(200);
    expect((await json(res)).data.map((s: Status) => s.id)).toEqual(reversed);
    expect((await statuses(projectId)).map((s) => s.id)).toEqual(reversed);

    const partial = await owner().patch(`/projects/${projectId}/task-statuses/order`, { ids: reversed.slice(1) });
    expect(partial.status).toBe(400);
  });

  it('deletes a status by moving its tasks, and hands the default on', async () => {
    const projectId = await createProject('DEL');
    const list = await statuses(projectId);
    const def = list.find((s) => s.isDefault)!;
    const target = list.find((s) => s.category === 'backlog')!;
    const task = await json(owner().post('/tasks', { projectId, title: 'Lands in the default' }));
    expect(task.statusId).toBe(def.id);

    expect((await owner().del(`/task-statuses/${def.id}?migrateTo=${def.id}`)).status).toBe(400);

    const res = await owner().del(`/task-statuses/${def.id}?migrateTo=${target.id}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, movedTasks: 1 });

    const moved = await json(owner().get(`/tasks/${task.id}`));
    expect(moved.statusId).toBe(target.id);
    const after = await statuses(projectId);
    expect(after.find((s) => s.id === def.id)).toBeUndefined();
    expect(after.filter((s) => s.isDefault).map((s) => s.id)).toEqual([target.id]);
  });

  it('is for project admins only', async () => {
    const projectId = await createProject('ACL');
    const add = await owner().post(`/projects/${projectId}/members`, { userId: users.member!.userId, role: 'member', canWriteTasks: true });
    expect(add.status).toBeLessThan(300);
    const member = reqAs(users.member!.cookie);
    expect((await member.get(`/projects/${projectId}/task-statuses`)).status).toBe(200);
    expect((await member.post(`/projects/${projectId}/task-statuses`, { name: 'Sneaky', category: 'todo' })).status).toBe(403);
    const ids = (await statuses(projectId)).map((s) => s.id);
    expect((await member.patch(`/projects/${projectId}/task-statuses/order`, { ids })).status).toBe(403);
  });
});
