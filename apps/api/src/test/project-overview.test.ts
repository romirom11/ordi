/**
 * Project overview endpoints: milestones CRUD, project updates (author/admin
 * edit rules) and the progress (burnup) series shape.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;
let statusByCategory: Record<string, string>;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Overview test', revenueSource: 'none' }));
  const project = await json(owner.post('/projects', { name: 'Overview', key: 'OVW', projectTypeId: type.id }));
  projectId = project.id;
  // Membership for the member-role user (author-vs-admin checks).
  await owner.post(`/projects/${projectId}/members`, { userId: users.member!.userId, role: 'member', canWriteTasks: true });
  const statuses = (await json(owner.get(`/projects/${projectId}/task-statuses`))).data as any[];
  statusByCategory = Object.fromEntries(statuses.map((s) => [s.category, s.id]));
});

describe('milestones CRUD', () => {
  it('creates, lists (ordered), patches and deletes milestones', async () => {
    const owner = reqAs(users.owner!.cookie);
    const m1 = await json(owner.post(`/projects/${projectId}/milestones`, { name: 'Design ready' }));
    expect(m1.id).toBeTruthy();
    expect(m1.done).toBe(false);
    const m2 = await json(owner.post(`/projects/${projectId}/milestones`, { name: 'Beta launch', targetDate: '2026-09-01' }));
    expect(m2.position).toBeGreaterThan(m1.position);

    let list = (await json(owner.get(`/projects/${projectId}/milestones`))).data as any[];
    expect(list.map((m) => m.name)).toEqual(['Design ready', 'Beta launch']);

    const patched = await json(owner.patch(`/milestones/${m1.id}`, { done: true, targetDate: '2026-08-15' }));
    expect(patched.done).toBe(true);
    expect(patched.targetDate).toBe('2026-08-15');

    // Reorder by swapping positions.
    await owner.patch(`/milestones/${m1.id}`, { position: m2.position });
    await owner.patch(`/milestones/${m2.id}`, { position: m1.position });
    list = (await json(owner.get(`/projects/${projectId}/milestones`))).data as any[];
    expect(list.map((m) => m.name)).toEqual(['Beta launch', 'Design ready']);

    expect((await owner.del(`/milestones/${m1.id}`)).status).toBe(200);
    list = (await json(owner.get(`/projects/${projectId}/milestones`))).data as any[];
    expect(list).toHaveLength(1);
  });

  it('rejects non-members', async () => {
    const guest = reqAs(users.guest!.cookie);
    expect((await guest.get(`/projects/${projectId}/milestones`)).status).toBe(404);
    expect((await guest.post(`/projects/${projectId}/milestones`, { name: 'x' })).status).toBe(404);
  });
});

describe('project updates', () => {
  it('posts an update with health and lists it with the author', async () => {
    const member = reqAs(users.member!.cookie);
    const body = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'All good' }] }] };
    const created = await json(member.post(`/projects/${projectId}/updates`, { body, health: 'at_risk' }));
    expect(created.health).toBe('at_risk');
    const list = (await json(member.get(`/projects/${projectId}/updates`))).data as any[];
    expect(list.length).toBe(1);
    expect(list[0].authorName).toBeTruthy();
    expect(list[0].createdBy).toBe(users.member!.userId);
  });

  it('author can edit, non-author member cannot, project admin can', async () => {
    const member = reqAs(users.member!.cookie);
    const owner = reqAs(users.owner!.cookie);
    const list = (await json(member.get(`/projects/${projectId}/updates`))).data as any[];
    const id = list[0].id;

    // Author edits own update.
    const edited = await json(member.patch(`/project-updates/${id}`, { health: 'off_track' }));
    expect(edited.health).toBe('off_track');

    // A different non-admin member is rejected (owner-posted update).
    const ownerUpdate = await json(owner.post(`/projects/${projectId}/updates`, { body: {}, health: 'on_track' }));
    const res = await member.patch(`/project-updates/${ownerUpdate.id}`, { health: 'at_risk' });
    expect([403, 404]).toContain(res.status);

    // Project admin can delete someone else's update.
    expect((await owner.del(`/project-updates/${id}`)).status).toBe(200);
    expect((await owner.del(`/project-updates/${ownerUpdate.id}`)).status).toBe(200);
  });

  it('validates health enum', async () => {
    const owner = reqAs(users.owner!.cookie);
    const res = await owner.post(`/projects/${projectId}/updates`, { body: {}, health: 'sideways' });
    expect([400, 422]).toContain(res.status);
  });
});

describe('progress endpoint', () => {
  it('returns scope/started/completed and a daily series ending today', async () => {
    const owner = reqAs(users.owner!.cookie);
    const t1 = await json(owner.post('/tasks', { projectId, title: 'A' }));
    const t2 = await json(owner.post('/tasks', { projectId, title: 'B' }));
    await json(owner.post('/tasks', { projectId, title: 'C' }));
    // Move A to in-progress and B to done (status transitions land in the activity log).
    await owner.patch(`/tasks/${t1.id}`, { statusId: statusByCategory.in_progress, version: t1.version });
    await owner.patch(`/tasks/${t2.id}`, { statusId: statusByCategory.done, version: t2.version });

    const progress = await json(owner.get(`/projects/${projectId}/progress`));
    expect(progress.scope).toBe(3);
    expect(progress.started).toBe(2); // in_progress + done both count as started
    expect(progress.completed).toBe(1);
    expect(Array.isArray(progress.series)).toBe(true);
    expect(progress.series.length).toBeGreaterThan(0);
    expect(progress.series.length).toBeLessThanOrEqual(180);
    const last = progress.series[progress.series.length - 1];
    expect(last.date).toBe(new Date().toISOString().slice(0, 10));
    expect(last).toMatchObject({ scope: 3, started: 2, completed: 1 });
    for (const p of progress.series) {
      expect(p).toHaveProperty('date');
      expect(p.started).toBeGreaterThanOrEqual(p.completed);
      expect(p.scope).toBeGreaterThanOrEqual(p.started);
    }
  });

  it('is membership-gated', async () => {
    const guest = reqAs(users.guest!.cookie);
    expect((await guest.get(`/projects/${projectId}/progress`)).status).toBe(404);
  });
});

describe('project PATCH: summary / priority / links / labels', () => {
  it('persists the new overview fields and label joins', async () => {
    const owner = reqAs(users.owner!.cookie);
    const label = await json(owner.post('/labels', { name: 'Overview label', color: '#5e6ad2' }));
    const before = await json(owner.get(`/projects/${projectId}`));
    const patched = await json(owner.patch(`/projects/${projectId}`, {
      summary: 'Short summary',
      priority: 'high',
      links: [{ label: 'Docs', url: 'https://example.com/docs' }],
      labelIds: [label.id],
      version: before.version,
    }));
    expect(patched.summary).toBe('Short summary');
    expect(patched.priority).toBe('high');
    expect(patched.links).toEqual([{ label: 'Docs', url: 'https://example.com/docs' }]);
    const fresh = await json(owner.get(`/projects/${projectId}`));
    expect(fresh.labelIds).toEqual([label.id]);
  });

  it('rejects bad priority and bad link urls', async () => {
    const owner = reqAs(users.owner!.cookie);
    const fresh = await json(owner.get(`/projects/${projectId}`));
    expect([400, 422]).toContain((await owner.patch(`/projects/${projectId}`, { priority: 'asap', version: fresh.version })).status);
    expect([400, 422]).toContain((await owner.patch(`/projects/${projectId}`, { links: [{ label: 'x', url: 'not-a-url' }], version: fresh.version })).status);
  });
});
