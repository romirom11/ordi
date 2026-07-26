/**
 * Global search: covers every top-level kind (companies, projects, tasks,
 * invoices, KB pages) and stays inside the actor's permission boundary.
 * The projects section exists precisely so an MCP client can resolve a
 * project by name without already knowing its id.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Search test', revenueSource: 'none' }));
  const project = await json(owner.post('/projects', { name: 'Solovei', key: 'SOL', projectTypeId: type.id }));
  projectId = project.id;
  await owner.post('/tasks', { projectId, title: 'Test task', priority: 'none', assigneeIds: [], labelIds: [] });
  await owner.post('/companies', { name: 'Kdnx Agency' });
});

describe('global search', () => {
  it('finds a project by name', async () => {
    const owner = reqAs(users.owner!.cookie);
    const hits = (await json(owner.get('/search?q=Solovei'))).data as any[];
    const project = hits.find((h) => h.kind === 'project');
    expect(project).toBeTruthy();
    expect(project.id).toBe(projectId);
    expect(project.title).toBe('SOL Solovei');
    expect(project.url).toBe(`/projects/${projectId}`);
  });

  it('finds a project by key, case-insensitively', async () => {
    const owner = reqAs(users.owner!.cookie);
    const hits = (await json(owner.get('/search?q=sol'))).data as any[];
    expect(hits.some((h) => h.kind === 'project' && h.id === projectId)).toBe(true);
  });

  it('still finds companies and tasks', async () => {
    const owner = reqAs(users.owner!.cookie);
    const companies = (await json(owner.get('/search?q=Kdnx'))).data as any[];
    expect(companies.some((h) => h.kind === 'company')).toBe(true);
    const tasks = (await json(owner.get('/search?q=Test'))).data as any[];
    expect(tasks.some((h) => h.kind === 'task')).toBe(true);
  });

  it('does not leak projects to actors without access', async () => {
    const guest = reqAs(users.guest!.cookie);
    const hits = (await json(guest.get('/search?q=Solovei'))).data as any[];
    expect(hits.some((h) => h.kind === 'project')).toBe(false);
  });
});
