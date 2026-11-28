/**
 * Deactivating a user hands their open work over (ORD-20): open tasks go to
 * a named successor or become unassigned, closed tasks keep their history,
 * and the admin can preview what is about to move.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getDb, schema, eq, and } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { createAgent, addProjectMember } from './agents-helpers';
import { generateToken } from '../lib/crypto';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let project: { id: string; key: string };

async function createTask(title: string, extra: Record<string, unknown> = {}) {
  const res = await reqAs(users.owner!.cookie).post('/tasks', { projectId: project.id, title, ...extra });
  expect(res.status).toBe(201);
  return json(res);
}

async function doneStatusId(): Promise<string> {
  const statuses = await json(reqAs(users.owner!.cookie).get(`/projects/${project.id}/task-statuses`));
  return statuses.data.find((s: { category: string }) => s.category === 'done').id;
}

async function assigneesOf(taskId: string): Promise<string[]> {
  const { db } = getDb();
  const rows = await db.select({ userId: schema.taskAssignees.userId })
    .from(schema.taskAssignees).where(eq(schema.taskAssignees.taskId, taskId));
  return rows.map((r) => r.userId).sort();
}

beforeEach(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();
  const typeId = ulid();
  await db.insert(schema.projectTypes).values({ id: typeId, name: 'Service' });
  const res = await reqAs(users.owner!.cookie).post('/projects', { name: 'Handover', key: 'HND', projectTypeId: typeId });
  expect(res.status).toBe(201);
  project = await json(res);
});

describe('open tasks preview', () => {
  it('counts only open tasks the user is assigned to', async () => {
    const open = await createTask('Still to do', { assigneeIds: [users.member!.userId] });
    const done = await createTask('Already shipped', { assigneeIds: [users.member!.userId] });
    await createTask('Someone else', { assigneeIds: [users.hr!.userId] });
    await reqAs(users.owner!.cookie).patch(`/tasks/${done.id}`, { statusId: await doneStatusId() });

    const preview = await json(reqAs(users.owner!.cookie).get(`/users/${users.member!.userId}/open-tasks`));
    expect(preview.count).toBe(1);
    expect(preview.data.map((t: { id: string }) => t.id)).toEqual([open.id]);
    expect(preview.data[0].ref).toBe(`${project.key}-${open.number}`);
  });

  it('is an admin-only view', async () => {
    const res = await reqAs(users.member!.cookie).get(`/users/${users.hr!.userId}/open-tasks`);
    expect(res.status).toBe(403);
  });
});

describe('deactivate with hand-off', () => {
  it('moves open tasks to the successor and leaves closed ones alone', async () => {
    const open = await createTask('Still to do', { assigneeIds: [users.member!.userId] });
    const shared = await createTask('Pair work', { assigneeIds: [users.member!.userId, users.hr!.userId] });
    const done = await createTask('Already shipped', { assigneeIds: [users.member!.userId] });
    await reqAs(users.owner!.cookie).patch(`/tasks/${done.id}`, { statusId: await doneStatusId() });

    const res = await reqAs(users.owner!.cookie).post(`/users/${users.member!.userId}/deactivate`, { reassignTo: users.hr!.userId });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, handedOffTasks: 2, reassignTo: users.hr!.userId });

    expect(await assigneesOf(open.id)).toEqual([users.hr!.userId]);
    // The successor was already on it: no duplicate row, the leaver is gone.
    expect(await assigneesOf(shared.id)).toEqual([users.hr!.userId]);
    // History stays: whoever finished it still shows as having done so.
    expect(await assigneesOf(done.id)).toEqual([users.member!.userId]);

    const { db } = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, users.member!.userId));
    expect(user!.isActive).toBe(false);

    const rows = await db.select().from(schema.activityLog).where(and(
      eq(schema.activityLog.entityType, 'task'), eq(schema.activityLog.action, 'reassigned'),
    ));
    expect(rows.map((r) => r.entityId).sort()).toEqual([open.id, shared.id].sort());
  });

  it('unassigns open tasks when no successor is named', async () => {
    const open = await createTask('Still to do', { assigneeIds: [users.member!.userId] });

    const res = await reqAs(users.owner!.cookie).post(`/users/${users.member!.userId}/deactivate`);
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, handedOffTasks: 1, reassignTo: null });
    expect(await assigneesOf(open.id)).toEqual([]);
  });

  it('refuses a successor who is the leaver or already deactivated', async () => {
    await createTask('Still to do', { assigneeIds: [users.member!.userId] });
    await reqAs(users.owner!.cookie).post(`/users/${users.hr!.userId}/deactivate`);

    const self = await reqAs(users.owner!.cookie).post(`/users/${users.member!.userId}/deactivate`, { reassignTo: users.member!.userId });
    expect(self.status).toBe(400);
    const gone = await reqAs(users.owner!.cookie).post(`/users/${users.member!.userId}/deactivate`, { reassignTo: users.hr!.userId });
    expect(gone.status).toBe(400);

    // Nothing moved and the leaver is still active: the refusal came first.
    const { db } = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, users.member!.userId));
    expect(user!.isActive).toBe(true);
  });
});

/**
 * Handing a leaver's tasks to an agent ordi runs is assigning work to it, so
 * the person deactivating must meet the agent's assign policy in each project,
 * with the role they hold there. `users.manage` alone is not `agents.manage`.
 */
describe('deactivate with hand-off to an agent', () => {
  /** Someone who may manage users but not agents: a custom role, as a workspace might set up. */
  async function peopleAdmin(): Promise<{ userId: string; cookie: string }> {
    const { db } = getDb();
    const roleId = ulid();
    await db.insert(schema.roles).values({ id: roleId, key: 'people_admin', name: 'People admin', description: 'Users only', isSystem: false });
    await db.insert(schema.rolePermissions).values(['users.manage', 'projects.read'].map((permission) => ({ roleId, permission })));
    const userId = ulid();
    await db.insert(schema.users).values({ id: userId, email: 'people-admin@test.local', name: 'People admin', roleId });
    const token = generateToken();
    await db.insert(schema.sessions).values({ id: ulid(), userId, token, expiresAt: new Date(Date.now() + 3600_000) });
    return { userId, cookie: `ordi_session=${token}` };
  }

  async function isActive(userId: string): Promise<boolean> {
    const [row] = await getDb().db.select({ isActive: schema.users.isActive }).from(schema.users).where(eq(schema.users.id, userId));
    return row!.isActive;
  }

  async function agentOnProject(assignPolicy: string): Promise<string> {
    const agent = await createAgent(users, { name: `Agent ${assignPolicy}`, assignPolicy });
    await addProjectMember(users, project.id, agent.id);
    return agent.id;
  }

  it('refuses a users.manage holder without agents.manage, and changes nothing', async () => {
    const agentId = await agentOnProject('agents_managers');
    const actor = await peopleAdmin();
    // Even as a project admin: this policy asks for agents.manage.
    await addProjectMember(users, project.id, actor.userId, 'admin');
    const open = await createTask('Still to do', { assigneeIds: [users.member!.userId] });
    const before = await json(reqAs(users.owner!.cookie).get(`/tasks/${open.id}`));

    const res = await reqAs(actor.cookie).post(`/users/${users.member!.userId}/deactivate`, { reassignTo: agentId });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.error.message).toContain('Handover');
    expect(body.error.message).toMatch(/agents\.manage/);

    expect(await isActive(users.member!.userId)).toBe(true);
    expect(await assigneesOf(open.id)).toEqual([users.member!.userId]);
    const after = await json(reqAs(users.owner!.cookie).get(`/tasks/${open.id}`));
    expect(after.version).toBe(before.version);
    const { db } = getDb();
    const reassigned = await db.select().from(schema.activityLog).where(and(
      eq(schema.activityLog.entityType, 'task'), eq(schema.activityLog.action, 'reassigned'),
    ));
    expect(reassigned).toEqual([]);
    const tokens = await db.select().from(schema.sessions).where(eq(schema.sessions.userId, users.member!.userId));
    expect(tokens.length).toBeGreaterThan(0);
  });

  it('lets an Admin hand the same tasks to that agent', async () => {
    const agentId = await agentOnProject('agents_managers');
    const open = await createTask('Still to do', { assigneeIds: [users.member!.userId] });

    const res = await reqAs(users.admin!.cookie).post(`/users/${users.member!.userId}/deactivate`, { reassignTo: agentId });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, handedOffTasks: 1, reassignTo: agentId });
    expect(await assigneesOf(open.id)).toEqual([agentId]);
    expect(await isActive(users.member!.userId)).toBe(false);
  });

  it('judges a project_admins policy by the role the actor holds in the project', async () => {
    const agentId = await agentOnProject('project_admins');
    const actor = await peopleAdmin();
    const open = await createTask('Still to do', { assigneeIds: [users.member!.userId] });

    // Only able to read the project: refused.
    const refused = await reqAs(actor.cookie).post(`/users/${users.member!.userId}/deactivate`, { reassignTo: agentId });
    expect(refused.status).toBe(403);
    expect(await isActive(users.member!.userId)).toBe(true);

    // A project admin there: allowed, though they still lack agents.manage.
    await addProjectMember(users, project.id, actor.userId, 'admin');
    const res = await reqAs(actor.cookie).post(`/users/${users.member!.userId}/deactivate`, { reassignTo: agentId });
    expect(res.status).toBe(200);
    expect(await assigneesOf(open.id)).toEqual([agentId]);
  });

  it('judges each project by the role held there, and refuses the whole hand-over if one fails', async () => {
    const agentId = await agentOnProject('project_admins');
    const actor = await peopleAdmin();
    await addProjectMember(users, project.id, actor.userId, 'admin');
    // A second project where the agent works but the actor only reads.
    const typeId = ulid();
    await getDb().db.insert(schema.projectTypes).values({ id: typeId, name: 'Other' });
    const second = await json(reqAs(users.owner!.cookie).post('/projects', { name: 'Elsewhere', key: 'ELS', projectTypeId: typeId }));
    await addProjectMember(users, second.id, agentId);
    const here = await createTask('Here', { assigneeIds: [users.member!.userId] });
    const there = await json(reqAs(users.owner!.cookie).post('/tasks', { projectId: second.id, title: 'There', assigneeIds: [users.member!.userId] }));

    const res = await reqAs(actor.cookie).post(`/users/${users.member!.userId}/deactivate`, { reassignTo: agentId });
    expect(res.status).toBe(403);
    expect((await json(res)).error.message).toContain('Elsewhere');
    expect(await isActive(users.member!.userId)).toBe(true);
    expect(await assigneesOf(here.id)).toEqual([users.member!.userId]);
    expect(await assigneesOf(there.id)).toEqual([users.member!.userId]);
  });

  it('does not name a private project the actor cannot open', async () => {
    const agentId = await agentOnProject('project_members');
    const actor = await peopleAdmin();
    const typeId = ulid();
    await getDb().db.insert(schema.projectTypes).values({ id: typeId, name: 'Hidden' });
    const hidden = await json(reqAs(users.owner!.cookie).post('/projects', { name: 'Codename Falcon', key: 'FAL', projectTypeId: typeId, visibility: 'private' }));
    await addProjectMember(users, hidden.id, agentId);
    await addProjectMember(users, hidden.id, users.member!.userId);
    await json(reqAs(users.owner!.cookie).post('/tasks', { projectId: hidden.id, title: 'Hidden work', assigneeIds: [users.member!.userId] }));

    const res = await reqAs(actor.cookie).post(`/users/${users.member!.userId}/deactivate`, { reassignTo: agentId });
    expect(res.status).toBe(403);
    const message = (await json(res)).error.message as string;
    expect(message).not.toContain('Falcon');
    expect(message).toMatch(/project members/);
    expect(await isActive(users.member!.userId)).toBe(true);
  });

  it('still hands tasks to a person without any agent check', async () => {
    const actor = await peopleAdmin();
    const open = await createTask('Still to do', { assigneeIds: [users.member!.userId] });
    const res = await reqAs(actor.cookie).post(`/users/${users.member!.userId}/deactivate`, { reassignTo: users.hr!.userId });
    expect(res.status).toBe(200);
    expect(await assigneesOf(open.id)).toEqual([users.hr!.userId]);
  });
});
