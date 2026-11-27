/**
 * A person's own agent: it works its owner's tasks under its own name, with
 * its owner's reach checked on every request – as a member at most, tasks and
 * the knowledge base only – and is never an assignee, a member or a role.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json, app } from './helpers';
import { setupWorkspace, drainOutbox, type Workspace } from './agents-helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let ws: Workspace;
let agentId: string;
let token: string;

const owner = () => reqAs(users.owner!.cookie);

function bearer(raw: string) {
  const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${raw}`, ...extra });
  return {
    get: (path: string) => app.request(`/api/v1${path}`, { headers: headers() }),
    post: (path: string, body?: unknown) => app.request(`/api/v1${path}`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: body ? JSON.stringify(body) : undefined,
    }),
    patch: (path: string, body?: unknown) => app.request(`/api/v1${path}`, {
      method: 'PATCH', headers: headers({ 'content-type': 'application/json' }), body: body ? JSON.stringify(body) : undefined,
    }),
  };
}

const doc = (text: string, mention?: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [
    ...(mention ? [{ type: 'mention', attrs: { id: mention } }] : []),
    { type: 'text', text },
  ] }],
});

async function notificationTypes(userId: string): Promise<string[]> {
  const rows = await getDb().db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
  return rows.map((r) => r.type);
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  ws = await setupWorkspace(users, 'MINE');
  const created = await owner().post('/my-agent', { name: 'Jarvis' });
  expect(created.status).toBe(201);
  agentId = (await json(created)).id;
  const issued = await json(owner().post('/my-agent/tokens', { client: 'Codex', expiresInDays: 30 }));
  token = issued.token;
});

describe('creating one', () => {
  it('is one per person, shows whose it is, and is not a workspace member to manage', async () => {
    expect((await owner().post('/my-agent', { name: 'Second' })).status).toBeGreaterThanOrEqual(400);
    const lookup = (await json(owner().get('/users/lookup'))).data as { id: string; agentKind: string; ownerUserId?: string }[];
    expect(lookup.find((u) => u.id === agentId)).toMatchObject({ agentKind: 'personal', ownerUserId: users.owner!.userId });
    const listed = (await json(owner().get('/users'))).data.map((u: { id: string }) => u.id);
    expect(listed).not.toContain(agentId);
  });

  it('is set up by the person, never with a token', async () => {
    expect((await bearer(token).post('/my-agent/tokens', { client: 'Sneaky', expiresInDays: null })).status).toBe(403);
    expect((await bearer(token).patch('/me', { name: 'Renamed myself' })).status).toBe(403);
    // Admin routes do not reach into someone's own agent.
    expect((await owner().post(`/external-agents/${agentId}/tokens`, {})).status).toBe(403);
    expect((await owner().patch(`/external-agents/${agentId}`, { ownerUserId: users.manager!.userId })).status).toBeGreaterThanOrEqual(400);
  });
});

describe('what it can do', () => {
  it('works its owner\'s tasks, as a member at most', async () => {
    const bot = bearer(token);
    expect((await bot.get(`/tasks/${ws.taskId}`)).status).toBe(200);
    expect((await bot.patch(`/tasks/${ws.taskId}`, { title: 'Fix the flaky login test (agent)' })).status).toBe(200);
    // The owner is project admin; the agent is not.
    expect((await bot.patch(`/projects/${ws.projectId}`, { name: 'Renamed by agent' })).status).toBe(403);
    expect((await bot.patch(`/task-statuses/${ws.todoStatusId}`, { name: 'Hijacked' })).status).toBe(403);
  });

  it('never reaches finance, people or settings, even when its owner can', async () => {
    const bot = bearer(token);
    expect((await owner().get('/invoices')).status).toBe(200);
    expect((await bot.get('/invoices')).status).toBe(403);
    expect((await bot.get('/users')).status).toBe(403);
  });

  it('loses a project the moment its owner does', async () => {
    const admin = reqAs(users.admin!.cookie);
    const type = await json(admin.post('/project-types', { name: 'Private type', revenueSource: 'none' }));
    const priv = await json(admin.post('/projects', { name: 'Closed', key: 'CLO', projectTypeId: type.id, visibility: 'private' }));
    const bot = bearer(token);
    expect((await bot.get(`/projects/${priv.id}`)).status).toBe(404);
    await admin.post(`/projects/${priv.id}/members`, { userId: users.owner!.userId, role: 'member', canWriteTasks: true });
    expect((await bot.get(`/projects/${priv.id}`)).status).toBe(200);
    await admin.del(`/projects/${priv.id}/members/${users.owner!.userId}`);
    expect((await bot.get(`/projects/${priv.id}`)).status).toBe(404);
  });

  it('lists its owner\'s tasks as its own, and files new ones for them', async () => {
    await owner().patch(`/tasks/${ws.taskId}`, { assigneeIds: [users.owner!.userId] });
    const mine = await json(bearer(token).get('/me/tasks'));
    const all = [...mine.overdue, ...mine.today, ...mine.week, ...mine.later].map((t: { id: string }) => t.id);
    expect(all).toContain(ws.taskId);
    const filed = await json(bearer(token).post('/tasks', { projectId: ws.projectId, title: 'Follow-up from the agent' }));
    expect(filed.reporterId).toBe(users.owner!.userId);
  });
});

describe('what it is not', () => {
  it('is never an assignee, a project member or given a role', async () => {
    const assign = await owner().patch(`/tasks/${ws.taskId}`, { assigneeIds: [agentId] });
    expect(assign.status).toBeGreaterThanOrEqual(400);
    expect((await owner().post(`/projects/${ws.projectId}/members`, { userId: agentId, role: 'member', canWriteTasks: true })).status).toBe(400);
    const [adminRole] = await getDb().db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'admin'));
    expect((await owner().patch(`/users/${agentId}/role`, { roleId: adminRole!.id })).status).toBe(400);
  });
});

describe('talking to its owner', () => {
  it('writes as itself through the client, quietly – and reaches its owner when it asks', async () => {
    await drainOutbox();
    await getDb().db.delete(schema.notifications);
    // The member reported nothing here; make them an assignee so they hear.
    await owner().patch(`/tasks/${ws.taskId}`, { assigneeIds: [users.owner!.userId, users.member!.userId] });
    await drainOutbox();
    await getDb().db.delete(schema.notifications);

    const plain = await json(bearer(token).post(`/tasks/${ws.taskId}/comments`, { body: doc('Pushed a fix, running tests.') }));
    const [row] = await getDb().db.select({ authorId: schema.comments.authorId, via: schema.comments.via }).from(schema.comments).where(eq(schema.comments.id, plain.id));
    expect(row).toEqual({ authorId: agentId, via: 'Codex' });
    await drainOutbox();
    // Its owner is not buried in its routine work; the others on the task hear.
    expect(await notificationTypes(users.owner!.userId)).toEqual([]);
    expect(await notificationTypes(users.member!.userId)).toContain('comment.created');

    await bearer(token).post(`/tasks/${ws.taskId}/comments`, { body: doc(' which login provider should it use?', users.owner!.userId) });
    await drainOutbox();
    expect(await notificationTypes(users.owner!.userId)).toContain('comment.mentioned');
  });
});

describe('when its owner leaves', () => {
  it('stops, and is not handed to anyone', async () => {
    // A member with an agent of their own.
    const memberAgent = await json(reqAs(users.member!.cookie).post('/my-agent', { name: 'Member bot' }));
    const memberToken = (await json(reqAs(users.member!.cookie).post('/my-agent/tokens', { client: 'Claude Code', expiresInDays: null }))).token;
    expect((await bearer(memberToken).get('/projects')).status).toBe(200);

    const res = await json(owner().post(`/users/${users.member!.userId}/deactivate`, { reassignTo: users.manager!.userId }));
    expect(res.externalAgents).toEqual([{ id: memberAgent.id, name: 'Member bot', outcome: 'disabled' }]);
    expect((await bearer(memberToken).get('/projects')).status).toBe(401);
  });
});
