/**
 * External agents: an agent that runs outside ordi connects over MCP with a
 * token of its own, so its work carries its name – not the person's who set
 * it up – it reaches only the projects it is added to, and the token can be
 * cut off on its own. ordi never dispatches it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { generateToken } from '../lib/crypto';
import { resetDb, seedRolesAndUsers, reqAs, json, app } from './helpers';
import { setupWorkspace, addProjectMember, drainOutbox, runsForTask, type Workspace } from './agents-helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let ws: Workspace;
let other: Workspace;

const owner = () => reqAs(users.owner!.cookie);

/** Requests with a bearer token, the way an MCP client sends them. */
function bearer(token: string) {
  const headers = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
  return {
    get: (path: string) => app.request(`/api/v1${path}`, { headers: headers() }),
    post: (path: string, body?: unknown) => app.request(`/api/v1${path}`, {
      method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: body ? JSON.stringify(body) : undefined,
    }),
    mcp: () => app.request('/api/v1/mcp', {
      method: 'POST',
      headers: headers({ 'content-type': 'application/json', accept: 'application/json, text/event-stream' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }),
  };
}

async function createAgent(name = 'Claude Code') {
  const res = await owner().post('/external-agents', { name });
  expect(res.status).toBe(201);
  return json(res) as Promise<{ id: string; ownerUserId: string; tokens: unknown[] }>;
}

async function issueToken(agentId: string, expiresInDays: number | null = 90): Promise<{ token: string; tokenInfo: { id: string } }> {
  const res = await owner().post(`/external-agents/${agentId}/tokens`, { expiresInDays });
  expect(res.status).toBe(201);
  return json(res);
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  ws = await setupWorkspace(users, 'EXT');
  other = await setupWorkspace(users, 'OFF');
});

describe('setting one up', () => {
  it('is an agent of its own, owned by whoever created it, and never dispatched', async () => {
    const agent = await createAgent();
    expect(agent.ownerUserId).toBe(users.owner!.userId);
    const [row] = await getDb().db.select().from(schema.users).where(eq(schema.users.id, agent.id));
    expect(row!.actorType).toBe('agent');
    const [profile] = await getDb().db.select().from(schema.agentProfiles).where(eq(schema.agentProfiles.userId, agent.id));
    expect(profile).toBeUndefined();

    const lookup = (await json(owner().get('/users/lookup'))).data as { id: string; agentKind: string | null }[];
    expect(lookup.find((u) => u.id === agent.id)?.agentKind).toBe('external');
    expect(lookup.find((u) => u.id === users.owner!.userId)?.agentKind).toBeNull();
  });

  it('needs agents.manage and users.manage, and a person as owner', async () => {
    expect((await reqAs(users.member!.cookie).post('/external-agents', { name: 'Sneaky' })).status).toBe(403);
    const agent = await createAgent('Owned by a bot?');
    expect((await owner().patch(`/external-agents/${agent.id}`, { ownerUserId: agent.id })).status).toBe(400);
    const moved = await json(owner().patch(`/external-agents/${agent.id}`, { ownerUserId: users.manager!.userId }));
    expect(moved.ownerUserId).toBe(users.manager!.userId);
  });
});

/** Someone who manages agents but is not an admin – once per file. */
let wranglerCookie: string | null = null;
async function wrangler() {
  if (!wranglerCookie) {
    const { db } = getDb();
    const roleId = ulid();
    await db.insert(schema.roles).values({ id: roleId, key: 'agent-wrangler', name: 'Agent wrangler', isSystem: false });
    await db.insert(schema.rolePermissions).values(
      ['agents.manage', 'users.manage', 'projects.read', 'projects.write', 'kb.read'].map((permission) => ({ roleId, permission })),
    );
    const wranglerId = ulid();
    await db.insert(schema.users).values({ id: wranglerId, email: 'wrangler@test.local', name: 'Wrangler', roleId });
    const session = generateToken();
    await db.insert(schema.sessions).values({ id: ulid(), userId: wranglerId, token: session, expiresAt: new Date(Date.now() + 3600_000) });
    wranglerCookie = `ordi_session=${session}`;
  }
  return reqAs(wranglerCookie);
}

describe('handing out no more than you hold', () => {
  it('refuses a role, or a token for it, that grants what the person does not have', async () => {
    const { db } = getDb();
    const w = await wrangler();
    const [adminRole] = await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'admin'));

    // The Agent role is within reach; Admin is not.
    const created = await w.post('/external-agents', { name: 'Wrangled' });
    expect(created.status).toBe(201);
    const agent = await json(created);
    expect((await w.post('/external-agents', { name: 'Too big', roleId: adminRole!.id })).status).toBe(403);
    expect((await w.patch(`/external-agents/${agent.id}`, { roleId: adminRole!.id })).status).toBe(403);
    expect((await w.post(`/external-agents/${agent.id}/tokens`, {})).status).toBe(201);

    // An owner made it Admin: the wrangler cannot mint its token any more.
    expect((await owner().patch(`/external-agents/${agent.id}`, { roleId: adminRole!.id })).status).toBe(200);
    expect((await w.post(`/external-agents/${agent.id}/tokens`, {})).status).toBe(403);
  });

  it('refuses a token for an agent on a private project the person cannot open, and does not name it', async () => {
    const w = await wrangler();
    const secret = await json(owner().post('/projects', { name: 'Secret client', key: 'SEC', projectTypeId: (await json(owner().get(`/projects/${ws.projectId}`))).projectTypeId, visibility: 'private' }));
    const agent = await createAgent('Insider');
    await addProjectMember(users, secret.id, agent.id);
    expect((await w.post(`/external-agents/${agent.id}/tokens`, {})).status).toBe(403);
    expect((await owner().post(`/external-agents/${agent.id}/tokens`, {})).status).toBe(201);

    const seen = ((await json(w.get('/external-agents'))).data as { id: string; projects: { key: string }[]; hiddenProjects: number }[])
      .find((a) => a.id === agent.id)!;
    expect(seen.projects.map((p) => p.key)).not.toContain('SEC');
    expect(seen.hiddenProjects).toBe(1);
  });

  it('is done by a signed-in person, never with a token', async () => {
    const [adminRole] = await getDb().db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'admin'));
    const agent = await createAgent('Self-renewing');
    await owner().patch(`/external-agents/${agent.id}`, { roleId: adminRole!.id });
    const { token } = await issueToken(agent.id, 30);
    // An Admin-role agent holds agents.manage, but its token cannot mint its successor.
    const minted = await bearer(token).post(`/external-agents/${agent.id}/tokens`, { expiresInDays: null });
    expect(minted.status).toBe(403);
  });
});

describe('working with its token', () => {
  it('acts under its own name, only in its projects', async () => {
    const agent = await createAgent('Content bot');
    await addProjectMember(users, ws.projectId, agent.id);
    const { token } = await issueToken(agent.id);
    const bot = bearer(token);

    const listed = (await json(bot.get('/projects'))).data.map((p: { id: string }) => p.id);
    expect(listed).toEqual([ws.projectId]);
    expect((await bot.get(`/tasks/${other.taskId}`)).status).toBe(404);

    const comment = await json(bot.post(`/tasks/${ws.taskId}/comments`, {
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Which tone should the post take?' }] }] },
    }));
    const [stored] = await getDb().db.select({ authorId: schema.comments.authorId }).from(schema.comments).where(eq(schema.comments.id, comment.id));
    expect(stored!.authorId).toBe(agent.id);

    // MCP lets the same token in (the transport itself needs the node server,
    // which app.request() does not provide – the gate is what is tested here).
    expect((await bot.mcp()).status).not.toBe(401);
  });

  it('tells the task\'s people what it wrote, by name', async () => {
    const agent = await createAgent('Question bot');
    await addProjectMember(users, ws.projectId, agent.id);
    const { token } = await issueToken(agent.id);
    await drainOutbox();
    await getDb().db.delete(schema.notifications);

    await bearer(token).post(`/tasks/${ws.taskId}/comments`, {
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Blocked on the brand colours.' }] }] },
    });
    await drainOutbox();
    // The owner reported the task (setupWorkspace), so the comment reaches them.
    const rows = await getDb().db.select().from(schema.notifications).where(eq(schema.notifications.userId, users.owner!.userId));
    const note = rows.find((r) => r.type === 'comment.created');
    expect(note).toBeDefined();
    expect((note!.payload as { actorName?: string }).actorName).toBe('Question bot');
  });

  it('is refused once expired, revoked, or the agent is switched off', async () => {
    const agent = await createAgent('Short-lived');
    await addProjectMember(users, ws.projectId, agent.id);

    const expired = await issueToken(agent.id, 30);
    await getDb().db.update(schema.apiTokens).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.apiTokens.id, expired.tokenInfo.id));
    expect((await bearer(expired.token).get('/projects')).status).toBe(401);
    expect((await bearer(expired.token).mcp()).status).toBe(401);

    const revoked = await issueToken(agent.id);
    expect((await bearer(revoked.token).get('/projects')).status).toBe(200);
    expect((await owner().del(`/external-agents/${agent.id}/tokens/${revoked.tokenInfo.id}`)).status).toBe(200);
    expect((await bearer(revoked.token).get('/projects')).status).toBe(401);

    const live = await issueToken(agent.id, null);
    expect((await owner().post(`/external-agents/${agent.id}/disable`)).status).toBe(200);
    expect((await bearer(live.token).get('/projects')).status).toBe(401);
    expect((await owner().post(`/external-agents/${agent.id}/tokens`, {})).status).toBe(422);

    // Expired and revoked tokens are not listed as live.
    const view = await json(owner().post(`/external-agents/${agent.id}/enable`));
    expect(view.tokens).toEqual([]);
  });
});

describe('what the routes refuse to touch', () => {
  it('a person, an ordi agent, or another agent\'s token', async () => {
    expect((await owner().post(`/external-agents/${users.manager!.userId}/tokens`, {})).status).toBe(404);
    expect((await owner().post(`/external-agents/${users.manager!.userId}/disable`)).status).toBe(404);
    const managed = await json(owner().post('/agents', { name: 'Ordi runner', runtime: 'claude_code' }));
    expect((await owner().post(`/external-agents/${managed.id}/tokens`, {})).status).toBe(404);

    const a = await createAgent('Agent A');
    const b = await createAgent('Agent B');
    const { token, tokenInfo } = await issueToken(b.id);
    expect((await owner().del(`/external-agents/${a.id}/tokens/${tokenInfo.id}`)).status).toBe(404);
    expect((await bearer(token).get('/projects')).status).toBe(200);
  });
});

describe('assigning work to it', () => {
  it('is not handed a leaving person\'s tasks in projects it is not on', async () => {
    const agent = await createAgent('Successor bot');
    await owner().post(`/projects/${other.projectId}/members`, { userId: users.hr!.userId, role: 'member', canWriteTasks: true });
    await owner().patch(`/tasks/${other.taskId}`, { assigneeIds: [users.hr!.userId] });
    const refused = await owner().post(`/users/${users.hr!.userId}/deactivate`, { reassignTo: agent.id });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const [hr] = await getDb().db.select({ isActive: schema.users.isActive }).from(schema.users).where(eq(schema.users.id, users.hr!.userId));
    expect(hr!.isActive).toBe(true);
  });

  it('comes off a task moved to a project it is not on', async () => {
    const agent = await createAgent('Mover bot');
    await addProjectMember(users, ws.projectId, agent.id);
    const task = await json(owner().post('/tasks', { projectId: ws.projectId, title: 'Moving house', assigneeIds: [agent.id, users.owner!.userId] }));
    const moved = await json(owner().post(`/tasks/${task.id}/move`, { targetProjectId: other.projectId }));
    const card = await json(owner().get(`/tasks/${moved.id}?include=assignees`));
    expect(card.assignees.map((a: { userId: string }) => a.userId)).toEqual([users.owner!.userId]);
  });

  it('needs it on the project, and queues no ordi run', async () => {
    const agent = await createAgent('Assignee bot');
    const refused = await owner().patch(`/tasks/${other.taskId}`, { assigneeIds: [agent.id] });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await json(refused))).toContain('agent_not_member');

    await addProjectMember(users, other.projectId, agent.id);
    expect((await owner().patch(`/tasks/${other.taskId}`, { assigneeIds: [agent.id] })).status).toBe(200);
    await drainOutbox();
    expect(await runsForTask(other.taskId)).toEqual([]);
  });
});

describe('when its owner leaves', () => {
  /** A person to own agents and then be deactivated, so the seeded users stay as they are. */
  async function person(name: string): Promise<string> {
    const { db } = getDb();
    const [memberRole] = await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'member'));
    const id = ulid();
    await db.insert(schema.users).values({ id, email: `${id.toLowerCase()}@test.local`, name, roleId: memberRole!.id });
    return id;
  }

  it('is listed before the switch-off, then moves to the successor with its tokens revoked', async () => {
    const leaver = await person('Leaving Lena');
    const agent = await createAgent('Lena\'s bot');
    await owner().patch(`/external-agents/${agent.id}`, { ownerUserId: leaver });
    const { token } = await issueToken(agent.id, null);
    expect((await bearer(token).get('/projects')).status).toBe(200);

    const preview = await json(owner().get(`/users/${leaver}/open-tasks`));
    expect(preview.ownedAgents.map((a: { id: string }) => a.id)).toEqual([agent.id]);

    const res = await json(owner().post(`/users/${leaver}/deactivate`, { reassignTo: users.manager!.userId }));
    expect(res.externalAgents).toEqual([{ id: agent.id, name: 'Lena\'s bot', outcome: 'transferred' }]);
    expect((await bearer(token).get('/projects')).status).toBe(401);
    const view = ((await json(owner().get('/external-agents'))).data as { id: string; ownerUserId: string; isActive: boolean }[])
      .find((a) => a.id === agent.id)!;
    expect(view).toMatchObject({ ownerUserId: users.manager!.userId, isActive: true });
  });

  it('is switched off when there is no one to take it over', async () => {
    const leaver = await person('Leaving Leo');
    const agent = await createAgent('Leo\'s bot');
    await owner().patch(`/external-agents/${agent.id}`, { ownerUserId: leaver });
    const { token } = await issueToken(agent.id, null);

    const res = await json(owner().post(`/users/${leaver}/deactivate`, {}));
    expect(res.externalAgents).toEqual([{ id: agent.id, name: 'Leo\'s bot', outcome: 'disabled' }]);
    expect((await bearer(token).get('/projects')).status).toBe(401);
    const [row] = await getDb().db.select({ isActive: schema.users.isActive }).from(schema.users).where(eq(schema.users.id, agent.id));
    expect(row!.isActive).toBe(false);
  });
});

describe('changing an agent\'s role from the user list', () => {
  it('never makes it Owner, nor an external agent wider than the person', async () => {
    const { db } = getDb();
    const [ownerRole] = await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'owner'));
    const [adminRole] = await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'admin'));
    const agent = await createAgent('Role climber');
    const toOwner = await owner().patch(`/users/${agent.id}/role`, { roleId: ownerRole!.id });
    expect(toOwner.status).toBeGreaterThanOrEqual(400);
    expect(toOwner.status).toBeLessThan(500);

    const w = await wrangler();
    expect((await w.patch(`/users/${agent.id}/role`, { roleId: adminRole!.id })).status).toBe(403);
    expect((await owner().patch(`/users/${agent.id}/role`, { roleId: adminRole!.id })).status).toBe(200);
  });
});
