/**
 * A task's parent and cycle point inside its own project. The API took both
 * as given, so a REST call (or an agent) could hang a subtask under another
 * project's task, loop a task under its own subtask, or drop it into another
 * project's cycle – rows no board shows where they claim to be.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { MAX_SUBTASK_DEPTH } from '@ordi/shared';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let owner: ReturnType<typeof reqAs>;
let projectA = '';
let projectB = '';
let cycleA = '';
let cycleB = '';

const task = async (projectId: string, title: string, extra: Record<string, unknown> = {}) =>
  json(owner.post('/tasks', { projectId, title, ...extra }));

async function refused(res: Response | Promise<Response>, code: string, message: string) {
  const r = await res;
  const body: any = await r.json();
  expect(r.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
  expect(body.error.code).toBe(code);
  expect(body.error.message).toContain(message);
}

beforeAll(async () => {
  await resetDb();
  const users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Delivery', revenueSource: 'none' }));
  projectA = (await json(owner.post('/projects', { name: 'Alpha', key: 'ALP', projectTypeId: type.id }))).id;
  projectB = (await json(owner.post('/projects', { name: 'Beta', key: 'BET', projectTypeId: type.id }))).id;
  cycleA = (await json(owner.post('/cycles', { projectId: projectA, name: 'Alpha 1', startDate: '2026-11-01', endDate: '2026-11-14' }))).id;
  cycleB = (await json(owner.post('/cycles', { projectId: projectB, name: 'Beta 1', startDate: '2026-11-01', endDate: '2026-11-14' }))).id;
});

describe('the parent of a task', () => {
  it('is accepted from the same project, on create and on update', async () => {
    const parent = await task(projectA, 'Parent');
    const child = await task(projectA, 'Child', { parentId: parent.id });
    expect(child.parentId).toBe(parent.id);

    const other = await task(projectA, 'Other');
    const moved = await json(owner.patch(`/tasks/${other.id}`, { parentId: parent.id }));
    expect(moved.parentId).toBe(parent.id);
    const detached = await json(owner.patch(`/tasks/${other.id}`, { parentId: null }));
    expect(detached.parentId).toBeNull();
  });

  it('is refused from another project', async () => {
    const foreign = await task(projectB, 'Foreign parent');
    await refused(owner.post('/tasks', { projectId: projectA, title: 'Child', parentId: foreign.id }), 'validation_error', 'same project');
    const local = await task(projectA, 'Local');
    await refused(owner.patch(`/tasks/${local.id}`, { parentId: foreign.id }), 'validation_error', 'same project');
    expect((await json(owner.get(`/tasks/${local.id}`))).parentId).toBeNull();
  });

  it('is refused when it is the task itself', async () => {
    const t = await task(projectA, 'Self');
    await refused(owner.patch(`/tasks/${t.id}`, { parentId: t.id }), 'validation_error', 'own parent');
  });

  it('is refused when it is one of the task’s own subtasks, however deep', async () => {
    const root = await task(projectA, 'Root');
    const child = await task(projectA, 'Child', { parentId: root.id });
    const grandchild = await task(projectA, 'Grandchild', { parentId: child.id });
    await refused(owner.patch(`/tasks/${root.id}`, { parentId: child.id }), 'validation_error', 'subtask of the task itself');
    await refused(owner.patch(`/tasks/${root.id}`, { parentId: grandchild.id }), 'validation_error', 'subtask of the task itself');
    expect((await json(owner.get(`/tasks/${root.id}`))).parentId).toBeNull();
  });

  it('is refused when it is deleted', async () => {
    const gone = await task(projectA, 'Gone');
    expect((await owner.del(`/tasks/${gone.id}`)).ok).toBe(true);
    await refused(owner.post('/tasks', { projectId: projectA, title: 'Orphan', parentId: gone.id }), 'validation_error', 'same project');
  });

  it('counts the subtree that moves with the task towards the depth limit', async () => {
    // A chain exactly MAX_SUBTASK_DEPTH deep is allowed…
    const chain = [await task(projectA, 'Level 1')];
    for (let level = 2; level <= MAX_SUBTASK_DEPTH; level++) {
      chain.push(await task(projectA, `Level ${level}`, { parentId: chain[chain.length - 1].id }));
    }
    await refused(owner.post('/tasks', { projectId: projectA, title: 'Too deep', parentId: chain[chain.length - 1].id }), 'domain_rule', 'depth');

    // …and a two-level branch hung under its second-to-last task would go one past it.
    const branch = await task(projectA, 'Branch');
    await task(projectA, 'Branch child', { parentId: branch.id });
    await refused(owner.patch(`/tasks/${branch.id}`, { parentId: chain[chain.length - 2].id }), 'domain_rule', 'depth');
    const fits = await json(owner.patch(`/tasks/${branch.id}`, { parentId: chain[chain.length - 3].id }));
    expect(fits.parentId).toBe(chain[chain.length - 3].id);
  });
});

describe('the cycle of a task', () => {
  it('is accepted from the same project, and cleared with null', async () => {
    const t = await task(projectA, 'Planned', { cycleId: cycleA });
    expect(t.cycleId).toBe(cycleA);
    const cleared = await json(owner.patch(`/tasks/${t.id}`, { cycleId: null }));
    expect(cleared.cycleId).toBeNull();
  });

  it('is refused from another project on create and update', async () => {
    await refused(owner.post('/tasks', { projectId: projectA, title: 'Wrong cycle', cycleId: cycleB }), 'validation_error', 'same project');
    const t = await task(projectA, 'Wrong cycle later');
    await refused(owner.patch(`/tasks/${t.id}`, { cycleId: cycleB }), 'validation_error', 'same project');
    expect((await json(owner.get(`/tasks/${t.id}`))).cycleId).toBeNull();
  });

  it('is refused on bulk update before any task moves when the selection spans projects', async () => {
    const a = await task(projectA, 'Bulk A');
    const b = await task(projectB, 'Bulk B');
    await refused(owner.post('/tasks/bulk', { taskIds: [a.id, b.id], cycleId: cycleA }), 'validation_error', 'same project');
    expect((await json(owner.get(`/tasks/${a.id}`))).cycleId).toBeNull();

    const ok = await json(owner.post('/tasks/bulk', { taskIds: [a.id], cycleId: cycleA }));
    expect(ok.updated).toBe(1);
    expect((await json(owner.get(`/tasks/${a.id}`))).cycleId).toBe(cycleA);
  });
});
