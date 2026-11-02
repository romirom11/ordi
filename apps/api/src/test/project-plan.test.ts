/**
 * The project plan: cycles are opt-in per project (a project that already has
 * cycles keeps them), intake earns its tab once a channel is on, milestones can
 * be set on many tasks at once (only milestones of the task's own project), and
 * the projects list says how each project is doing as of its latest update.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let owner: ReturnType<typeof reqAs>;
let typeId: string;

const newProject = async (key: string) => (await json(owner.post('/projects', { name: `Plan ${key}`, key, projectTypeId: typeId }))).id as string;

beforeAll(async () => {
  await resetDb();
  const users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  typeId = (await json(owner.post('/project-types', { name: 'Plan test', revenueSource: 'none' }))).id;
});

describe('cycles are opt-in', () => {
  it('a new project has them off; creating a cycle turns them on; an explicit off wins', async () => {
    const id = await newProject('PLA');
    expect((await json(owner.get(`/projects/${id}`))).cyclesEnabled).toBe(false);

    expect((await owner.post('/cycles', { projectId: id, name: 'Sprint 1', startDate: '2026-11-02', endDate: '2026-11-15' })).status).toBe(201);
    let p = await json(owner.get(`/projects/${id}`));
    expect(p.cyclesEnabled).toBe(true);

    p = await json(owner.patch(`/projects/${id}`, { settings: { cycles: false }, version: p.version }));
    expect((await json(owner.get(`/projects/${id}`))).cyclesEnabled).toBe(false);
    // Other settings survive the merge.
    expect((await json(owner.get(`/projects/${id}`))).settings.estimateUnit).toBe('hours');
  });

  it('can be switched on before any cycle exists', async () => {
    const id = await newProject('PLB');
    const p = await json(owner.get(`/projects/${id}`));
    await owner.patch(`/projects/${id}`, { settings: { cycles: true }, version: p.version });
    expect((await json(owner.get(`/projects/${id}`))).cyclesEnabled).toBe(true);
  });
});

describe('intake', () => {
  it('reads as enabled once the public form is on', async () => {
    const id = await newProject('PLC');
    expect((await json(owner.get(`/projects/${id}`))).intakeEnabled).toBe(false);
    expect((await owner.patch(`/projects/${id}/intake-settings`, { formEnabled: true })).status).toBe(200);
    expect((await json(owner.get(`/projects/${id}`))).intakeEnabled).toBe(true);
  });
});

describe('bulk milestone', () => {
  it('sets and clears a milestone on many tasks, and refuses one from another project', async () => {
    const id = await newProject('PLD');
    const other = await newProject('PLE');
    const ms = await json(owner.post(`/projects/${id}/milestones`, { name: 'Launch' }));
    const foreign = await json(owner.post(`/projects/${other}/milestones`, { name: 'Elsewhere' }));
    const a = await json(owner.post('/tasks', { projectId: id, title: 'A' }));
    const b = await json(owner.post('/tasks', { projectId: id, title: 'B' }));

    expect((await owner.post('/tasks/bulk', { taskIds: [a.id, b.id], milestoneId: foreign.id })).status).toBe(400);
    expect((await json(owner.get(`/tasks/${a.id}`))).milestoneId).toBeNull();

    expect((await owner.post('/tasks/bulk', { taskIds: [a.id, b.id], milestoneId: ms.id })).status).toBe(200);
    expect((await json(owner.get(`/tasks/${a.id}`))).milestoneId).toBe(ms.id);
    expect((await json(owner.get(`/tasks/${b.id}`))).milestoneId).toBe(ms.id);
    const counted = (await json(owner.get(`/projects/${id}/milestones`))).data[0];
    expect(counted.taskCount).toBe(2);

    await owner.post('/tasks/bulk', { taskIds: [a.id], milestoneId: null });
    expect((await json(owner.get(`/tasks/${a.id}`))).milestoneId).toBeNull();
  });
});

describe('projects list health', () => {
  it('carries the health of each project\'s latest update, null before the first', async () => {
    const id = await newProject('PLF');
    let row = (await json(owner.get('/projects'))).data.find((p: { id: string }) => p.id === id);
    expect(row.health).toBeNull();
    const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ok' }] }] };
    await owner.post(`/projects/${id}/updates`, { body: doc, health: 'on_track' });
    await owner.post(`/projects/${id}/updates`, { body: doc, health: 'at_risk' });
    row = (await json(owner.get('/projects'))).data.find((p: { id: string }) => p.id === id);
    expect(row.health).toBe('at_risk');
  });
});
