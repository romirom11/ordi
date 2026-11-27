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

describe('handing out no more than you hold', () => {
  it('refuses a role, or a token for it, that grants what the person does not have', async () => {
    const { db } = getDb();
    // Someone who manages agents but is not an admin.
    const roleId = ulid();
    await db.insert(schema.roles).values({ id: roleId, key: 'agent-wrangler', name: 'Agent wrangler', isSystem: false });
    await db.insert(schema.rolePermissions).values(
      ['agents.manage', 'users.manage', 'projects.read', 'projects.write', 'kb.read'].map((permission) => ({ roleId, permission })),
    );
    const wranglerId = ulid();
    await db.insert(schema.users).values({ id: wranglerId, email: 'wrangler@test.local', name: 'Wrangler', roleId });
    const session = generateToken();
    await db.insert(schema.sessions).values({ id: ulid(), userId: wranglerId, token: session, expiresAt: new Date(Date.now() + 3600_000) });
    const wrangler = reqAs(`ordi_session=${session}`);
    const [adminRole] = await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'admin'));

    // The Agent role is within reach; Admin is not.
    const created = await wrangler.post('/external-agents', { name: 'Wrangled' });
    expect(created.status).toBe(201);
    const agent = await json(created);
    expect((await wrangler.post('/external-agents', { name: 'Too big', roleId: adminRole!.id })).status).toBe(403);
    expect((await wrangler.patch(`/external-agents/${agent.id}`, { roleId: adminRole!.id })).status).toBe(403);
    expect((await wrangler.post(`/external-agents/${agent.id}/tokens`, {})).status).toBe(201);

    // An owner made it Admin: the wrangler cannot mint its token any more.
    expect((await owner().patch(`/external-agents/${agent.id}`, { roleId: adminRole!.id })).status).toBe(200);
    expect((await wrangler.post(`/external-agents/${agent.id}/tokens`, {})).status).toBe(403);
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

describe('assigning work to it', () => {
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
