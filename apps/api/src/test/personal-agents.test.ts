/**
 * A person's own agent: it works its owner's tasks under its own name, with
 * its owner's reach checked on every request – as a member at most, tasks and
 * the knowledge base only – and is never an assignee, a member or a role.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getDb, schema, eq, and } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json, app } from './helpers';
import { setupWorkspace, drainOutbox, type Workspace } from './agents-helpers';
import { broadcaster } from '../core/events';
import { streamTiming } from '../domains/core/stream.routes';

/** Slow CI must not turn a late event into a failure. */
const WAIT = { timeout: 5000, interval: 20 };

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

/** An open SSE connection: the event names it has received so far, and whether it ended. */
async function openStream(raw: string) {
  const res = await app.request('/api/v1/stream', { headers: { authorization: `Bearer ${raw}` } });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const state = { events: [] as string[], ended: false, close: () => reader.cancel().catch(() => {}) };
  let buf = '';
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buf.indexOf('\n\n')) >= 0) {
        const name = /^event: (.*)$/m.exec(buf.slice(0, at))?.[1];
        buf = buf.slice(at + 2);
        if (name) state.events.push(name);
      }
    }
  })().catch(() => {}).finally(() => { state.ended = true; });
  await vi.waitFor(() => expect(state.events).toContain('connected'), WAIT);
  return state;
}

const pings = (s: { events: string[] }) => s.events.filter((e) => e === 'ping').length;

async function notificationTypes(userId: string): Promise<string[]> {
  const rows = await getDb().db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
  return rows.map((r) => r.type);
}

const pingMs = streamTiming.pingMs;
afterAll(() => { streamTiming.pingMs = pingMs; });

beforeAll(async () => {
  streamTiming.pingMs = 40;
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

  it('is one per person even from two tabs at once', async () => {
    const manager = reqAs(users.manager!.cookie);
    const both = await Promise.all([manager.post('/my-agent', { name: 'Tab one' }), manager.post('/my-agent', { name: 'Tab two' })]);
    const statuses = both.map((r) => r.status).sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);
    expect(statuses[1]).toBeLessThan(500);
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

    // What either of them filed is one list, seen the same from both sides.
    const byOwner = await json(owner().post('/tasks', { projectId: ws.projectId, title: 'Filed by the owner', assigneeIds: [users.member!.userId] }));
    const createdFor = async (r: ReturnType<typeof bearer> | ReturnType<typeof owner>) =>
      (await json(r.get('/me/tasks'))).created.map((t: { id: string }) => t.id);
    expect(await createdFor(bearer(token))).toEqual(expect.arrayContaining([filed.id, byOwner.id]));
    expect(await createdFor(owner())).toEqual(expect.arrayContaining([filed.id, byOwner.id]));
  });

  it('files for its owner as soon as another process grants the role back', async () => {
    // The owner's role, as this process last read it, cannot read projects;
    // in the database (another process granted it back) it can.
    const { db } = getDb();
    const [ownerUser] = await db.select({ roleId: schema.users.roleId }).from(schema.users).where(eq(schema.users.id, users.owner!.userId));
    const roleId = ownerUser!.roleId;
    const perms = ['projects.read', 'projects.write'];
    const open = await json(reqAs(users.admin!.cookie).post('/projects', {
      name: 'Cache lag', key: 'LAG', projectTypeId: (await json(reqAs(users.admin!.cookie).post('/project-types', { name: 'Lag type', revenueSource: 'none' }))).id, visibility: 'workspace',
    }));
    for (const permission of perms) {
      await db.delete(schema.rolePermissions).where(and(eq(schema.rolePermissions.roleId, roleId), eq(schema.rolePermissions.permission, permission)));
    }
    try {
      await owner().get('/me'); // this process has now read the role without them
    } finally {
      await db.insert(schema.rolePermissions).values(perms.map((permission) => ({ roleId, permission })));
    }
    const res = await bearer(token).post('/tasks', { projectId: open.id, title: 'Filed through the lag' });
    expect(res.status).toBe(201);
    expect((await json(res)).reporterId).toBe(users.owner!.userId);
  });

  it('never names itself the reporter', async () => {
    const bot = bearer(token);
    expect((await bot.post('/tasks', { projectId: ws.projectId, title: 'Mine, says the agent', reporterId: agentId })).status).toBe(400);
    expect((await owner().patch(`/tasks/${ws.taskId}`, { reporterId: agentId })).status).toBe(400);
  });

  it('follows its owner\'s role at once, even when another process changed it', async () => {
    // A workspace project the owner reaches through projects.write alone.
    const admin = reqAs(users.admin!.cookie);
    const type = await json(admin.post('/project-types', { name: 'Open type', revenueSource: 'none' }));
    const open = await json(admin.post('/projects', { name: 'Open work', key: 'OPN', projectTypeId: type.id, visibility: 'workspace' }));
    const task = await json(admin.post('/tasks', { projectId: open.id, title: 'Open task' }));
    const bot = bearer(token);
    expect((await bot.patch(`/tasks/${task.id}`, { title: 'Open task (agent)' })).status).toBe(200);

    // The role loses projects.write the way another process would see it:
    // in the database, without the route that edits roles.
    expect((await owner().get('/me')).status).toBe(200);
    const { db } = getDb();
    const [ownerUser] = await db.select({ roleId: schema.users.roleId }).from(schema.users).where(eq(schema.users.id, users.owner!.userId));
    const row = and(eq(schema.rolePermissions.roleId, ownerUser!.roleId), eq(schema.rolePermissions.permission, 'projects.write'));
    await db.delete(schema.rolePermissions).where(row);
    try {
      expect((await bot.patch(`/tasks/${task.id}`, { title: 'Open task (agent, again)' })).status).toBe(403);
    } finally {
      await db.insert(schema.rolePermissions).values({ roleId: ownerUser!.roleId, permission: 'projects.write' });
    }
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

  it('reaches its owner from a knowledge-base page too, when it asks', async () => {
    const space = await json(owner().post('/spaces', { name: 'Runbooks', visibility: 'workspace' }));
    const page = await json(owner().post('/pages', { spaceId: space.id, title: 'Deploying' }));
    await drainOutbox();
    await getDb().db.delete(schema.notifications);
    const res = await bearer(token).post(`/pages/${page.id}/comments`, { body: doc(' is step 3 still right?', users.owner!.userId) });
    expect(res.status).toBe(201);
    await drainOutbox();
    expect(await notificationTypes(users.owner!.userId)).toContain('page.mentioned');
  });
});

describe('what it hears on the event stream', () => {
  it('hears about the work on its owner\'s projects, nothing else', async () => {
    const stream = await openStream(token);
    try {
      broadcaster.broadcast({ event: 'payment.recorded', data: { aggregateType: 'payment', aggregateId: 'pay1', invoiceId: 'inv1', amount: '1200.00' } });
      broadcaster.broadcast({ event: 'leave.requested', data: { aggregateType: 'leave_request', aggregateId: 'lr1' } });
      // A project created names no project scope: a private one's key would leak.
      broadcaster.broadcast({ event: 'project.created', data: { aggregateType: 'project', aggregateId: 'p1', key: 'SECRET' } });
      // Time on a project it works on is still not task work.
      broadcaster.broadcast({ event: 'time.entry_created', data: { aggregateType: 'time_entry', projectId: ws.projectId }, projectScope: [ws.projectId] });
      broadcaster.broadcast({ event: 'task.updated', data: { aggregateType: 'task', projectId: ws.projectId }, projectScope: [ws.projectId] });
      await vi.waitFor(() => expect(stream.events).toContain('task.updated'), WAIT);
      const seen = pings(stream);
      await vi.waitFor(() => expect(pings(stream)).toBeGreaterThanOrEqual(seen + 1), WAIT);
      for (const e of ['payment.recorded', 'leave.requested', 'project.created', 'time.entry_created']) expect(stream.events).not.toContain(e);
    } finally { await stream.close(); }
  });

  it('stops hearing a project its owner has left, without reconnecting', async () => {
    const admin = reqAs(users.admin!.cookie);
    const type = await json(admin.post('/project-types', { name: 'Stream type', revenueSource: 'none' }));
    const priv = await json(admin.post('/projects', { name: 'Streamed', key: 'STR', projectTypeId: type.id, visibility: 'private' }));
    await admin.post(`/projects/${priv.id}/members`, { userId: users.owner!.userId, role: 'member', canWriteTasks: true });
    const stream = await openStream(token);
    try {
      broadcaster.broadcast({ event: 'task.before', data: { projectId: priv.id }, projectScope: [priv.id] });
      await vi.waitFor(() => expect(stream.events).toContain('task.before'), WAIT);

      await admin.del(`/projects/${priv.id}/members/${users.owner!.userId}`);
      const seen = pings(stream);
      await vi.waitFor(() => expect(pings(stream)).toBeGreaterThanOrEqual(seen + 2), WAIT);
      broadcaster.broadcast({ event: 'task.after', data: { projectId: priv.id }, projectScope: [priv.id] });
      // A denied event may need a database read to be judged: give it two pings.
      const after = pings(stream);
      await vi.waitFor(() => expect(pings(stream)).toBeGreaterThanOrEqual(after + 2), WAIT);
      expect(stream.events).not.toContain('task.after');
    } finally { await stream.close(); }
  });

  it('ends when the client is disconnected', async () => {
    const issued = await json(owner().post('/my-agent/tokens', { client: 'Cursor', expiresInDays: 30 }));
    const stream = await openStream(issued.token);
    try {
      // Re-checking on each ping is not a use of the token.
      const lastUsed = async () => (await getDb().db.select({ at: schema.apiTokens.lastUsedAt }).from(schema.apiTokens)
        .where(eq(schema.apiTokens.id, issued.tokenInfo.id)))[0]!.at?.getTime() ?? null;
      const atConnect = await lastUsed();
      const seen = pings(stream);
      await vi.waitFor(() => expect(pings(stream)).toBeGreaterThanOrEqual(seen + 2), WAIT);
      expect(await lastUsed()).toBe(atConnect);

      expect((await owner().del(`/my-agent/tokens/${issued.tokenInfo.id}`)).status).toBe(200);
      await vi.waitFor(() => expect(stream.ended).toBe(true), WAIT);
    } finally { await stream.close(); }
  });
});

describe('when its owner leaves', () => {
  it('stops, and is not handed to anyone', async () => {
    // A member with an agent of their own.
    const memberAgent = await json(reqAs(users.member!.cookie).post('/my-agent', { name: 'Member bot' }));
    const memberToken = (await json(reqAs(users.member!.cookie).post('/my-agent/tokens', { client: 'Claude Code', expiresInDays: null }))).token;
    expect((await bearer(memberToken).get('/projects')).status).toBe(200);
    // The admin is told it is switched off, not handed to the successor.
    const preview = await json(owner().get(`/users/${users.member!.userId}/open-tasks`));
    expect(preview.ownedAgents).toEqual([expect.objectContaining({ id: memberAgent.id, kind: 'personal' })]);

    const res = await json(owner().post(`/users/${users.member!.userId}/deactivate`, { reassignTo: users.manager!.userId }));
    expect(res.externalAgents).toEqual([{ id: memberAgent.id, name: 'Member bot', outcome: 'disabled' }]);
    expect((await bearer(memberToken).get('/projects')).status).toBe(401);
  });
});
