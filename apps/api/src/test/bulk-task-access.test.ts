/**
 * Bulk task edits (POST /tasks/bulk) are held to the rule a single-task edit
 * is: member level on the project, by a membership row or by what a
 * workspace-visible project grants the role's permissions. The bulk path read
 * the membership map alone, so a person with projects.write could edit each
 * task of a workspace project one by one but not the same tasks together.
 * Nothing widens with it: private projects stay membership-only, a viewer
 * stays read-only, an agent reaches only the projects it is a member of, and
 * a deleted project grants nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { app, resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { generateToken } from '../lib/crypto';
import { createAgent, addProjectMember } from './agents-helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let owner: ReturnType<typeof reqAs>;

async function signIn(userId: string) {
  const token = generateToken();
  await getDb().db.insert(schema.sessions).values({ id: ulid(), userId, token, expiresAt: new Date(Date.now() + 3600_000) });
  return reqAs(`ordi_session=${token}`);
}

/** A role built in the UI: pick permissions, assign a user, no memberships. */
async function customRole(name: string, permissions: string[]) {
  const { db } = getDb();
  const roleId = ulid();
  await db.insert(schema.roles).values({ id: roleId, key: `${name}-${roleId}`, name, description: 'custom', isSystem: false });
  await db.insert(schema.rolePermissions).values(permissions.map((p) => ({ roleId, permission: p as any })));
  const userId = ulid();
  await db.insert(schema.users).values({ id: userId, email: `${roleId}@test.local`, name, passwordHash: 'x', roleId });
  return { userId, as: await signIn(userId) };
}

async function project(key: string, visibility: 'workspace' | 'private') {
  const typeId = (await json(owner.post('/project-types', { name: `Type ${key}`, revenueSource: 'none' }))).id;
  const id = (await json(owner.post('/projects', { name: `Project ${key}`, key, projectTypeId: typeId, visibility }))).id as string;
  const taskId = (await json(owner.post('/tasks', { projectId: id, title: `Task in ${key}` }))).id as string;
  return { id, taskId };
}

async function priorityOf(taskId: string): Promise<string> {
  const [row] = await getDb().db.select({ priority: schema.tasks.priority }).from(schema.tasks).where(eq(schema.tasks.id, taskId));
  return row!.priority;
}

let developer: Awaited<ReturnType<typeof customRole>>;
let viewer: Awaited<ReturnType<typeof customRole>>;
let open: Awaited<ReturnType<typeof project>>;
let hidden: Awaited<ReturnType<typeof project>>;
let gone: Awaited<ReturnType<typeof project>>;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  developer = await customRole('Developer', ['projects.read', 'projects.write']);
  viewer = await customRole('Viewer', ['projects.read']);
  open = await project('OPN', 'workspace');
  hidden = await project('HID', 'private');
  gone = await project('GON', 'workspace');
  expect((await owner.del(`/projects/${gone.id}`)).status).toBeLessThan(300);
});

describe('bulk edits by a person with projects.write and no membership', () => {
  it('change the tasks of a workspace project, as single edits do', async () => {
    const res = await developer.as.post('/tasks/bulk', { taskIds: [open.taskId], priority: 'urgent' });
    expect(res.status).toBe(200);
    expect((await json(res)).updated).toBe(1);
    expect(await priorityOf(open.taskId)).toBe('urgent');
  });

  it('assign the tasks of a workspace project too', async () => {
    const res = await developer.as.post('/tasks/bulk', { taskIds: [open.taskId], assigneeIds: [developer.userId] });
    expect((await json(res)).updated).toBe(1);
    const assignees = await getDb().db.select({ userId: schema.taskAssignees.userId }).from(schema.taskAssignees)
      .where(eq(schema.taskAssignees.taskId, open.taskId));
    expect(assignees.map((a) => a.userId)).toEqual([developer.userId]);
  });

  it('assign an agent whose policy wants a project admin, as projects.write makes them one', async () => {
    const agentId = (await createAgent(users, { name: 'Admins only', assignPolicy: 'project_admins' })).id;
    await addProjectMember(users, open.id, agentId);
    const res = await developer.as.post('/tasks/bulk', { taskIds: [open.taskId], assigneeIds: [developer.userId, agentId] });
    expect(res.status).toBe(200);
    expect((await json(res)).updated).toBe(1);
    const assignees = await getDb().db.select({ userId: schema.taskAssignees.userId }).from(schema.taskAssignees)
      .where(eq(schema.taskAssignees.taskId, open.taskId));
    expect(assignees.map((a) => a.userId).sort()).toEqual([developer.userId, agentId].sort());
  });

  it('leave a private project they are not on untouched', async () => {
    const res = await developer.as.post('/tasks/bulk', { taskIds: [hidden.taskId, open.taskId], priority: 'low' });
    expect((await json(res)).updated).toBe(1);
    expect(await priorityOf(hidden.taskId)).not.toBe('low');
    expect(await priorityOf(open.taskId)).toBe('low');
  });

  it('leave a deleted project untouched', async () => {
    const before = await priorityOf(gone.taskId);
    const res = await developer.as.post('/tasks/bulk', { taskIds: [gone.taskId], priority: 'urgent' });
    expect((await json(res)).updated).toBe(0);
    expect(await priorityOf(gone.taskId)).toBe(before);
  });
});

describe('bulk edits over a read-only token', () => {
  it('are refused, projects.write scope or not', async () => {
    const minted = await json(owner.post('/auth/tokens', { name: 'ro', scopes: ['projects.read', 'projects.write'], readOnly: true }));
    const before = await priorityOf(open.taskId);
    const res = await app.request('/api/v1/tasks/bulk', {
      method: 'POST',
      headers: { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ taskIds: [open.taskId], priority: before === 'none' ? 'urgent' : 'none' }),
    });
    expect(res.status).toBe(403);
    expect(await priorityOf(open.taskId)).toBe(before);
  });
});

describe('bulk edits on a private project', () => {
  it('follow the membership row: a viewer row changes nothing, a member row edits', async () => {
    const own = await project('PRV', 'private');
    const outsider = await customRole('Outsider', ['projects.read']);
    await addProjectMember(users, own.id, outsider.userId, 'viewer');
    const before = await priorityOf(own.taskId);
    expect((await json(outsider.as.post('/tasks/bulk', { taskIds: [own.taskId], priority: 'urgent' }))).updated).toBe(0);
    expect(await priorityOf(own.taskId)).toBe(before);
    await addProjectMember(users, own.id, outsider.userId, 'member');
    const fresh = await signIn(outsider.userId);
    expect((await json(fresh.post('/tasks/bulk', { taskIds: [own.taskId], priority: 'urgent' }))).updated).toBe(1);
    expect(await priorityOf(own.taskId)).toBe('urgent');
  });
});

describe('bulk edits with projects.write but not projects.read', () => {
  it('change nothing in a workspace project, as it is not listed to them either', async () => {
    const blind = await customRole('Blind writer', ['projects.write']);
    const before = await priorityOf(open.taskId);
    expect((await json(blind.as.post('/tasks/bulk', { taskIds: [open.taskId], priority: 'urgent' }))).updated).toBe(0);
    expect(await priorityOf(open.taskId)).toBe(before);
  });
});

describe('bulk edits by a viewer', () => {
  it('change nothing in a workspace project they can read', async () => {
    const before = await priorityOf(open.taskId);
    expect((await viewer.as.get(`/tasks/${open.taskId}`)).status).toBe(200);
    const res = await viewer.as.post('/tasks/bulk', { taskIds: [open.taskId], priority: 'medium' });
    expect((await json(res)).updated).toBe(0);
    expect(await priorityOf(open.taskId)).toBe(before);
  });
});

describe('bulk edits by an agent', () => {
  it('reach only the projects it is a member of, projects.write or not', async () => {
    const agentId = (await createAgent(users)).id;
    const mine = await project('AGM', 'workspace');
    await addProjectMember(users, mine.id, agentId);
    const agent = await signIn(agentId);
    const before = await priorityOf(open.taskId);
    const res = await agent.post('/tasks/bulk', { taskIds: [mine.taskId, open.taskId], priority: 'high' });
    expect((await json(res)).updated).toBe(1);
    expect(await priorityOf(mine.taskId)).toBe('high');
    expect(await priorityOf(open.taskId)).toBe(before);
  });
});
