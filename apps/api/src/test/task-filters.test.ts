/**
 * The task list as a planning query: the date window a calendar is read
 * through, several labels at once, and a custom field. Everything an agent
 * (MCP) or a board view narrows a project by before it starts writing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;
let statusByCategory: Record<string, string>;
let labels: Record<string, string>;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Content', revenueSource: 'none' }));
  const project = await json(owner.post('/projects', { name: 'Content', key: 'CNT', projectTypeId: type.id }));
  projectId = project.id;
  const statuses = (await json(owner.get(`/projects/${projectId}/task-statuses`))).data as any[];
  statusByCategory = Object.fromEntries(statuses.map((s) => [s.category, s.id]));
  const linkedin = await json(owner.post('/labels', { name: 'LinkedIn', scope: 'task' }));
  const caseStudy = await json(owner.post('/labels', { name: 'Case study', scope: 'task' }));
  labels = { linkedin: linkedin.id, caseStudy: caseStudy.id };
  await json(owner.post('/custom-fields', { entityType: 'tasks', key: 'platform', label: 'Platform', type: 'text' }));

  const post = (title: string, dueDate: string | null, labelIds: string[], platform: string) =>
    json(owner.post('/tasks', {
      projectId, title, dueDate, labelIds, statusId: statusByCategory.todo, customFields: { platform },
    }));
  await post('August opener', '2026-08-03', [labels.linkedin!], 'linkedin');
  await post('August case study', '2026-08-10', [labels.linkedin!, labels.caseStudy!], 'linkedin');
  await post('September piece', '2026-09-01', [labels.linkedin!], 'x');
  await post('Undated idea', null, [], 'linkedin');
});

const titles = async (query: string): Promise<string[]> => {
  const res = await json(reqAs(users.owner!.cookie).get(`/tasks?projectId=${projectId}&${query}`));
  return (res.data as any[]).map((t) => t.title).sort();
};

describe('task list filters', () => {
  it('answers a date window, and leaves undated tasks out of it', async () => {
    expect(await titles('dueFrom=2026-08-01&dueTo=2026-08-31')).toEqual(['August case study', 'August opener']);
    expect(await titles('dueFrom=2026-08-05')).toEqual(['August case study', 'September piece']);
    expect(await titles('dueTo=2026-08-05')).toEqual(['August opener']);
  });

  it('narrows on every label given, not on any of them', async () => {
    expect(await titles(`label=${labels.linkedin}`)).toEqual(['August case study', 'August opener', 'September piece']);
    expect(await titles(`label=${labels.linkedin},${labels.caseStudy}`)).toEqual(['August case study']);
  });

  it('combines the window, the labels and a custom field', async () => {
    const cf = encodeURIComponent(JSON.stringify([{ field_key: 'platform', op: 'eq', value: 'linkedin' }]));
    expect(await titles(`dueFrom=2026-08-01&dueTo=2026-12-31&label=${labels.linkedin}&cf=${cf}`))
      .toEqual(['August case study', 'August opener']);
  });

  it('keeps the status filter working alongside the new ones', async () => {
    expect(await titles(`status=${statusByCategory.todo}&dueFrom=2026-09-01`)).toEqual(['September piece']);
    expect(await titles(`status=${statusByCategory.done}`)).toEqual([]);
  });
});
