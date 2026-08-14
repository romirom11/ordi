/**
 * Project-scoped custom fields: a project admin defines task fields that exist
 * only in their project, on top of the workspace-wide definitions.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;
let otherProjectId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Content', revenueSource: 'none' }));
  projectId = (await json(owner.post('/projects', { name: 'Content', key: 'CNT', projectTypeId: type.id }))).id;
  otherProjectId = (await json(owner.post('/projects', { name: 'Other', key: 'OTH', projectTypeId: type.id }))).id;
  await json(owner.post('/custom-fields', { entityType: 'tasks', key: 'platform', label: 'Platform', type: 'text' }));
});

describe('project-scoped custom fields', () => {
  it('creates a project field and scopes reads by projectId', async () => {
    const owner = reqAs(users.owner!.cookie);
    const created = await owner.post('/custom-fields', {
      entityType: 'tasks', projectId, key: 'content_pillar', label: 'Content pillar', type: 'text',
    });
    expect(created.status).toBe(201);

    const global = (await json(owner.get('/custom-fields?entityType=tasks'))).data as any[];
    expect(global.map((f) => f.key)).toEqual(['platform']);

    const inProject = (await json(owner.get(`/custom-fields?entityType=tasks&projectId=${projectId}`))).data as any[];
    expect(inProject.map((f) => f.key).sort()).toEqual(['content_pillar', 'platform']);

    const elsewhere = (await json(owner.get(`/custom-fields?entityType=tasks&projectId=${otherProjectId}`))).data as any[];
    expect(elsewhere.map((f) => f.key)).toEqual(['platform']);
  });

  it('lets two projects reuse the same key, but not shadow a global field', async () => {
    const owner = reqAs(users.owner!.cookie);
    const sameKeyElsewhere = await owner.post('/custom-fields', {
      entityType: 'tasks', projectId: otherProjectId, key: 'content_pillar', label: 'Pillar', type: 'text',
    });
    expect(sameKeyElsewhere.status).toBe(201);

    const shadowsGlobal = await owner.post('/custom-fields', {
      entityType: 'tasks', projectId, key: 'platform', label: 'Platform again', type: 'text',
    });
    expect(shadowsGlobal.status).toBe(422);

    const globalOverProject = await owner.post('/custom-fields', {
      entityType: 'tasks', key: 'content_pillar', label: 'Global pillar', type: 'text',
    });
    expect(globalOverProject.status).toBe(422);
  });

  it('demands settings.manage for global fields but project admin suffices for project fields', async () => {
    // The member preset has projects.create (so their own project makes them admin) but no settings.manage.
    const member = reqAs(users.member!.cookie);
    const own = await json(member.post('/projects', { name: 'Mine', key: 'MNE', projectTypeId: (await json(member.get(`/projects/${projectId}`))).projectTypeId }));

    const globalAttempt = await member.post('/custom-fields', {
      entityType: 'tasks', key: 'member_field', label: 'Nope', type: 'text',
    });
    expect(globalAttempt.status).toBe(403);

    const projectAttempt = await member.post('/custom-fields', {
      entityType: 'tasks', projectId: own.id, key: 'member_field', label: 'Mine', type: 'text',
    });
    expect(projectAttempt.status).toBe(201);

    // ...but not on a project they are no admin of.
    const foreignAttempt = await member.post('/custom-fields', {
      entityType: 'tasks', projectId, key: 'foreign_field', label: 'Foreign', type: 'text',
    });
    expect([403, 404]).toContain(foreignAttempt.status);
  });

  it('project admin can edit and delete only their project fields', async () => {
    const owner = reqAs(users.owner!.cookie);
    const member = reqAs(users.member!.cookie);
    const fields = (await json(owner.get(`/custom-fields?entityType=tasks&projectId=${projectId}`))).data as any[];
    const projectField = fields.find((f) => f.key === 'content_pillar');
    const globalField = fields.find((f) => f.key === 'platform');

    const editGlobal = await member.patch(`/custom-fields/${globalField.id}`, { label: 'Hacked' });
    expect(editGlobal.status).toBe(403);

    const editProject = await owner.patch(`/custom-fields/${projectField.id}`, { label: 'Pillar v2' });
    expect(editProject.status).toBe(200);

    const del = await owner.del(`/custom-fields/${projectField.id}`);
    expect(del.status).toBe(200);
    const after = (await json(owner.get(`/custom-fields?entityType=tasks&projectId=${projectId}`))).data as any[];
    expect(after.map((f) => f.key)).toEqual(['platform']);
  });
});
