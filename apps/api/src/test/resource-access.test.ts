/**
 * Resource access on workspace-visible projects and KB spaces (PRD §4.1/§4.4).
 *
 * A custom role is the interesting case: "view projects" listed a project the
 * role could then not open past the first write, and kb.read+kb.write could not
 * create a page in any space, both answering "not found" on resources the app
 * had just listed. The rule under test: workspace visibility = unrestricted, so
 * the role's own permissions set the level; private stays membership-only; and
 * a level the actor lacks on a resource it can see is a 403, never a 404.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { generateToken } from '../lib/crypto';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let typeId: string;

/** A role built in the UI: pick permissions, assign a user, no memberships. */
async function customRole(name: string, permissions: string[]) {
  const { db } = getDb();
  const roleId = ulid();
  await db.insert(schema.roles).values({ id: roleId, key: `${name}-${roleId}`, name, description: 'custom', isSystem: false });
  if (permissions.length) {
    await db.insert(schema.rolePermissions).values(permissions.map((p) => ({ roleId, permission: p as any })));
  }
  const userId = ulid();
  await db.insert(schema.users).values({ id: userId, email: `${roleId}@test.local`, name, passwordHash: 'x', roleId });
  const token = generateToken();
  await db.insert(schema.sessions).values({ id: ulid(), userId, token, expiresAt: new Date(Date.now() + 3600_000) });
  return { userId, cookie: `ordi_session=${token}`, as: reqAs(`ordi_session=${token}`) };
}

/** projects.read only – the role from the report. */
let viewer: Awaited<ReturnType<typeof customRole>>;
/** projects.read + projects.write + kb.read + kb.write – a "developer". */
let developer: Awaited<ReturnType<typeof customRole>>;
/** kb.read + kb.write, no space membership anywhere. */
let writer: Awaited<ReturnType<typeof customRole>>;

let openProject = '';
let privateProject = '';
let openSpace = '';
let privateSpace = '';

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  typeId = (await json(owner.post('/project-types', { name: 'Access test', revenueSource: 'none' }))).id;

  viewer = await customRole('Viewer', ['projects.read']);
  developer = await customRole('Developer', ['projects.read', 'projects.write', 'kb.read', 'kb.write']);
  writer = await customRole('Writer', ['kb.read', 'kb.write']);

  openProject = (await json(owner.post('/projects', { name: 'Open', key: 'OPN', projectTypeId: typeId, visibility: 'workspace' }))).id;
  privateProject = (await json(owner.post('/projects', { name: 'Secret', key: 'SEC', projectTypeId: typeId, visibility: 'private' }))).id;
  openSpace = (await json(owner.post('/spaces', { name: 'Handbook', visibility: 'workspace' }))).id;
  privateSpace = (await json(owner.post('/spaces', { name: 'Board', visibility: 'private' }))).id;
});

describe('what is listed is what opens', () => {
  it('lists the workspace project and opens every panel of its page', async () => {
    const list = (await json(viewer.as.get('/projects'))).data as any[];
    expect(list.map((p) => p.id)).toEqual([openProject]);

    for (const path of ['', '/task-statuses', '/members', '/milestones', '/updates', '/progress',
      '/cycles', '/repositories', '/automation-rules']) {
      const res = await viewer.as.get(`/projects/${openProject}${path}`);
      expect([path, res.status]).toEqual([path, 200]);
    }
  });

  it('hides the private project from the list and from the API', async () => {
    const list = (await json(viewer.as.get('/projects'))).data as any[];
    expect(list.some((p) => p.id === privateProject)).toBe(false);
    expect((await viewer.as.get(`/projects/${privateProject}`)).status).toBe(404);
    expect((await viewer.as.post('/tasks', { projectId: privateProject, title: 'x' })).status).toBe(404);
  });
});

describe('projects: workspace visibility is unrestricted, private is members-only', () => {
  it('read-only role is told what it lacks instead of "not found"', async () => {
    const res = await viewer.as.post('/tasks', { projectId: openProject, title: 'From a viewer' });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).not.toMatch(/not found/i);
  });

  it('projects.write works the project without a membership row', async () => {
    const created = await json(developer.as.post('/tasks', { projectId: openProject, title: 'From a developer' }));
    expect(created.id).toBeTruthy();
    expect((await developer.as.post(`/projects/${openProject}/milestones`, { name: 'Beta' })).status).toBe(201);
    expect((await developer.as.post(`/projects/${openProject}/updates`, { body: {}, health: 'on_track' })).status).toBe(201);

    const project = await json(developer.as.get(`/projects/${openProject}`));
    const patched = await developer.as.patch(`/projects/${openProject}`, { summary: 'Set by a non-member', version: project.version });
    expect(patched.status).toBe(200);
  });

  it('projects.write stops at the private project', async () => {
    expect((await developer.as.get(`/projects/${privateProject}`)).status).toBe(404);
    expect((await developer.as.post('/tasks', { projectId: privateProject, title: 'x' })).status).toBe(404);
    expect((await developer.as.post(`/projects/${privateProject}/milestones`, { name: 'x' })).status).toBe(404);
  });

  it('a guest with no permissions still sees nothing', async () => {
    const guest = reqAs(users.guest!.cookie);
    expect((await json(guest.get('/projects'))).data).toEqual([]);
    expect((await guest.get(`/projects/${openProject}`)).status).toBe(404);
  });
});

describe('kb: kb.write creates pages in workspace spaces', () => {
  it('creates a page in a space it is not a member of', async () => {
    const res = await writer.as.post('/pages', { spaceId: openSpace, title: 'Onboarding' });
    expect(res.status).toBe(201);
    const page = await json(writer.as.get(`/pages/${(await json(writer.as.get(`/spaces/${openSpace}/pages`))).data[0].id}`));
    expect(page.title).toBe('Onboarding');
  });

  it('kb.read alone still cannot write, and is told why', async () => {
    const reader = await customRole('Reader', ['kb.read']);
    expect((await reader.as.get(`/spaces/${openSpace}`)).status).toBe(200);
    const res = await reader.as.post('/pages', { spaceId: openSpace, title: 'Nope' });
    expect(res.status).toBe(403);
    expect((await json(res)).error.message).not.toMatch(/not found/i);
  });

  it('private space stays invisible and unwritable', async () => {
    expect((await writer.as.get(`/spaces/${privateSpace}`)).status).toBe(404);
    expect((await writer.as.post('/pages', { spaceId: privateSpace, title: 'x' })).status).toBe(404);
    const list = (await json(writer.as.get('/spaces'))).data as any[];
    expect(list.some((s) => s.id === privateSpace)).toBe(false);
  });

  it('a project space follows the project: a project admin edits it', async () => {
    const owner = reqAs(users.owner!.cookie);
    const spaceId = (await json(owner.post('/spaces', { name: 'Project docs', projectId: openProject, visibility: 'private' }))).id;
    // developer holds projects.write => project admin on a workspace project => space editor
    expect((await developer.as.post('/pages', { spaceId, title: 'Spec' })).status).toBe(201);
    // ...while a kb-only role has no way in
    expect((await writer.as.get(`/spaces/${spaceId}`)).status).toBe(404);
  });
});
