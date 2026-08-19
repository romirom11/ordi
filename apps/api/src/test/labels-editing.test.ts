/**
 * Editing the label vocabulary (ORD-15): rename/recolor via PATCH, delete via
 * DELETE. Both are settings.manage – the same bar creating a label already
 * has – and deleting a label detaches it from every task through the FK
 * cascade instead of leaving dangling ids.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;
let labelId: string;
let taskId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Content', revenueSource: 'none' }));
  projectId = (await json(owner.post('/projects', { name: 'Content', key: 'CNT', projectTypeId: type.id }))).id;
  labelId = (await json(owner.post('/labels', { name: 'Bug', color: '#ef4444', scope: 'task' }))).id;
  taskId = (await json(owner.post('/tasks', { projectId, title: 'Broken thing', labelIds: [labelId] }))).id;
});

describe('label editing', () => {
  it('renames and recolors in place, visible to every reader of the vocabulary', async () => {
    const owner = reqAs(users.owner!.cookie);
    const res = await owner.patch(`/labels/${labelId}`, { name: 'Defect', color: '#8b5cf6' });
    expect(res.status).toBe(200);
    const list = (await json(owner.get('/labels?scope=task'))).data as any[];
    expect(list.find((l) => l.id === labelId)).toMatchObject({ name: 'Defect', color: '#8b5cf6' });
  });

  it('refuses the edit to a user without settings.manage, and names a missing label', async () => {
    const member = reqAs(users.member!.cookie);
    expect((await member.patch(`/labels/${labelId}`, { name: 'X' })).status).toBe(403);
    const owner = reqAs(users.owner!.cookie);
    expect((await owner.patch('/labels/01JMISSING0000000000000000', { name: 'X' })).status).toBe(404);
    expect((await owner.patch(`/labels/${labelId}`, {})).status).toBe(400);
  });

  it('deleting a label detaches it from tasks instead of orphaning them', async () => {
    const owner = reqAs(users.owner!.cookie);
    expect((await owner.del(`/labels/${labelId}`)).status).toBe(200);
    const task = await json(owner.get(`/tasks/${taskId}?include=labels`));
    expect((task.labels ?? []).map((l: any) => l.id)).toEqual([]);
    const list = (await json(owner.get('/labels?scope=task'))).data as any[];
    expect(list.some((l) => l.id === labelId)).toBe(false);
  });
});
