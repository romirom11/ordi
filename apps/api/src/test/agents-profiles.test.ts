/**
 * Agent identity and RBAC (plan 2026-09-05-001, R1-R5, R43-R49): creation
 * behind agents.manage + users.manage, the Agent preset role, the lookup
 * badge, project membership as the boundary, the assign policy on single and
 * bulk assignment, and bulk assignment emitting task.assigned.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq, and } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { setupWorkspace, createAgent, addProjectMember, type Workspace } from './agents-helpers';

let ws: Workspace;

beforeAll(async () => {
  await resetDb();
  const users = await seedRolesAndUsers();
  ws = await setupWorkspace(users);
});

describe('creating agents', () => {
  it('needs agents.manage (and users.manage) – a manager gets 403, the owner 201', async () => {
    const manager = reqAs(ws.users.manager!.cookie);
    expect((await manager.post('/agents', { name: 'Nope' })).status).toBe(403);
    expect((await manager.get('/agents')).status).toBe(403);
    expect((await manager.get('/agent-credentials')).status).toBe(403);

    const agent = await createAgent(ws.users, { name: 'Claude' });
    const { db } = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, agent.id));
    expect(user!.actorType).toBe('agent');
    expect(user!.passwordHash).toBeNull();
    const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, user!.roleId));
    expect(role!.key).toBe('agent');
  });

  it('rejects the codex runtime and the owner role', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    expect((await owner.post('/agents', { name: 'Codex', runtime: 'codex' })).status).toBe(400);
    const { db } = getDb();
    const [ownerRole] = await db.select().from(schema.roles).where(eq(schema.roles.key, 'owner'));
    expect((await owner.post('/agents', { name: 'Boss', roleId: ownerRole!.id })).status).toBe(422);
  });

  it('shows up in the lookup with actorType and never in the people directory', async () => {
    const agent = await createAgent(ws.users, { name: 'Badge' });
    const lookup = (await json(reqAs(ws.users.member!.cookie).get('/users/lookup'))).data as { id: string; actorType: string }[];
    expect(lookup.find((u) => u.id === agent.id)?.actorType).toBe('agent');
    const people = await json(reqAs(ws.users.owner!.cookie).get('/employees'));
    const ids = ((people.data ?? people) as { userId?: string }[]).map((e) => e.userId);
    expect(ids).not.toContain(agent.id);
  });

  it('cannot get a password reset', async () => {
    const agent = await createAgent(ws.users, { name: 'NoLogin' });
    expect((await reqAs(ws.users.owner!.cookie).post(`/users/${agent.id}/reset-password`, {})).status).toBe(422);
  });

  it('updates with optimistic locking and grants connectors', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const agent = await createAgent(ws.users, { name: 'Editable' });
    const updated = await json(owner.patch(`/agents/${agent.id}`, { version: agent.version, assignPolicy: 'project_admins', maxTurns: 10, name: 'Edited' }));
    expect(updated.assignPolicy).toBe('project_admins');
    expect(updated.maxTurns).toBe(10);
    expect(updated.name).toBe('Edited');
    expect((await owner.patch(`/agents/${agent.id}`, { version: agent.version, maxTurns: 11 })).status).toBe(409);
    expect((await owner.patch(`/agents/${agent.id}`, { version: updated.version, connectorIds: ['01JMISSING0000000000000000'] })).status).toBe(400);
  });

  it('disabling deactivates the user and marks the agent not dispatchable', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const agent = await createAgent(ws.users, { name: 'Sleepy' });
    const off = await json(owner.post(`/agents/${agent.id}/disable`));
    expect(off.enabled).toBe(false);
    expect(off.isActive).toBe(false);
    expect(off.dispatchable).toBe(false);
  });
});

describe('assigning tasks to agents', () => {
  it('refuses an agent that is not a project member', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const agent = await createAgent(ws.users, { name: 'Outsider' });
    const task = await json(owner.get(`/tasks/${ws.taskId}`));
    const res = await owner.patch(`/tasks/${ws.taskId}`, { version: task.version, assigneeIds: [agent.id] });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toMatch(/member/i);
  });

  it('project_members policy: a member may assign; project_admins policy: only admins (or agents.manage)', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const member = reqAs(ws.users.member!.cookie);
    const agent = await createAgent(ws.users, { name: 'Policy', assignPolicy: 'project_admins' });
    await addProjectMember(ws.users, ws.projectId, agent.id);
    const task = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Policy task' }));

    const denied = await member.patch(`/tasks/${task.id}`, { version: task.version, assigneeIds: [agent.id] });
    expect(denied.status).toBe(403);

    const fresh = await json(owner.get(`/tasks/${task.id}`));
    const allowed = await owner.patch(`/tasks/${task.id}`, { version: fresh.version, assigneeIds: [agent.id] });
    expect(allowed.status).toBe(200);

    const relaxed = await createAgent(ws.users, { name: 'Relaxed' });
    await addProjectMember(ws.users, ws.projectId, relaxed.id);
    const other = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Relaxed task' }));
    expect((await member.patch(`/tasks/${other.id}`, { version: other.version, assigneeIds: [relaxed.id] })).status).toBe(200);
  });

  it('agents_managers policy: a project admin without agents.manage is refused', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const manager = reqAs(ws.users.manager!.cookie);
    const agent = await createAgent(ws.users, { name: 'Locked', assignPolicy: 'agents_managers' });
    await addProjectMember(ws.users, ws.projectId, agent.id);
    await addProjectMember(ws.users, ws.projectId, ws.users.manager!.userId, 'admin');
    const task = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Locked task' }));
    expect((await manager.patch(`/tasks/${task.id}`, { version: task.version, assigneeIds: [agent.id] })).status).toBe(403);
    const fresh = await json(owner.get(`/tasks/${task.id}`));
    expect((await owner.patch(`/tasks/${task.id}`, { version: fresh.version, assigneeIds: [agent.id] })).status).toBe(200);
  });

  it('createTask applies the policy too', async () => {
    const member = reqAs(ws.users.member!.cookie);
    const agent = await createAgent(ws.users, { name: 'AtCreate', assignPolicy: 'project_admins' });
    await addProjectMember(ws.users, ws.projectId, agent.id);
    expect((await member.post('/tasks', { projectId: ws.projectId, title: 'x', assigneeIds: [agent.id] })).status).toBe(403);
  });

  it('bulk assignment enforces the policy and emits task.assigned per task', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const member = reqAs(ws.users.member!.cookie);
    const agent = await createAgent(ws.users, { name: 'Bulk', assignPolicy: 'project_admins' });
    await addProjectMember(ws.users, ws.projectId, agent.id);
    const a = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Bulk A' }));
    const b = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Bulk B' }));

    expect((await member.post('/tasks/bulk', { taskIds: [a.id, b.id], assigneeIds: [agent.id] })).status).toBe(403);

    const { db } = getDb();
    const before = await db.select().from(schema.events).where(and(eq(schema.events.type, 'task.assigned'), eq(schema.events.aggregateId, a.id)));
    const res = await owner.post('/tasks/bulk', { taskIds: [a.id, b.id], assigneeIds: [agent.id] });
    expect(res.status).toBe(200);
    const after = await db.select().from(schema.events).where(and(eq(schema.events.type, 'task.assigned'), eq(schema.events.aggregateId, a.id)));
    expect(after.length).toBe(before.length + 1);
    expect((after.at(-1)!.payload as { assigneeIds: string[] }).assigneeIds).toEqual([agent.id]);
  });
});

describe('agent role scope', () => {
  it('an agent-role token reaches project tools but not finance', async () => {
    const agent = await createAgent(ws.users, { name: 'Scoped' });
    await addProjectMember(ws.users, ws.projectId, agent.id);
    const { db } = getDb();
    const { generateToken, sha256 } = await import('../lib/crypto');
    const raw = `ordi_${generateToken(24)}`;
    const { loadRolePermissions } = await import('../core/rbac');
    await db.insert(schema.apiTokens).values({
      id: '01JAGENTTOKEN000000000000A', userId: agent.id, name: 't', hash: sha256(raw), prefix: raw.slice(0, 12),
      scopes: [...(await loadRolePermissions(agent.roleId))], readOnly: false,
    });
    const { app } = await import('./helpers');
    const asAgent = (path: string) => app.request(`/api/v1${path}`, { headers: { Authorization: `Bearer ${raw}` } });
    expect((await asAgent(`/tasks/${ws.taskId}`)).status).toBe(200);
    expect((await asAgent('/invoices')).status).toBe(403);
    expect((await asAgent('/agents')).status).toBe(403);
  });
});
