/**
 * An agent reaches only the projects it is a member of. Its role (projects.read
 * + projects.write) used to make it admin of every workspace-visible project,
 * so a task or comment that talked it into reaching further would find the
 * whole workspace open. Membership is the boundary, as it already was for
 * assigning work to an agent.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { generateToken } from '../lib/crypto';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { setupWorkspace, createAgent, addProjectMember, type Workspace } from './agents-helpers';
import { queueRun } from '../domains/agents/runs';
import { prepare } from '../domains/agents/run-service';

/** A signed-in session for an agent user, so requests run as an actor_type = 'agent' actor. */
async function sessionFor(userId: string): Promise<ReturnType<typeof reqAs>> {
  const token = generateToken();
  await getDb().db.insert(schema.sessions).values({ id: ulid(), userId, token, expiresAt: new Date(Date.now() + 3600_000) });
  return reqAs(`ordi_session=${token}`);
}

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let mine: Workspace;
let other: Workspace;
let agentId: string;
let agent: ReturnType<typeof reqAs>;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  mine = await setupWorkspace(users, 'MINE');
  other = await setupWorkspace(users, 'OTHR');
  agentId = (await createAgent(users)).id;
  await addProjectMember(users, mine.projectId, agentId);
  agent = await sessionFor(agentId);
});

describe('an agent outside its projects', () => {
  it('does not see a workspace project it is not a member of', async () => {
    const listed = (await json(agent.get('/projects'))).data.map((p: { id: string }) => p.id);
    expect(listed).toContain(mine.projectId);
    expect(listed).not.toContain(other.projectId);
    expect((await agent.get(`/projects/${other.projectId}`)).status).toBe(404);
    expect((await agent.get(`/tasks/${other.taskId}`)).status).toBe(404);
  });

  it('cannot change anything there', async () => {
    expect((await agent.patch(`/tasks/${other.taskId}`, { title: 'changed by agent' })).status).toBe(404);
    expect((await agent.patch(`/projects/${other.projectId}`, { name: 'renamed by agent' })).status).toBe(404);
    expect((await agent.patch(`/task-statuses/${other.todoStatusId}`, { name: 'Hijacked' })).status).toBe(404);
    const task = await json(reqAs(users.owner!.cookie).get(`/tasks/${other.taskId}`));
    expect(task.title).toBe('Fix the flaky login test');
  });

  it('is not run there, even when mentioned', async () => {
    expect(await queueRun({ agentUserId: agentId, taskId: other.taskId, projectId: other.projectId, trigger: 'comment', requestedBy: users.owner!.userId })).toBeNull();
  });
});

describe('an agent in its own project', () => {
  it('works tasks at its membership role', async () => {
    const res = await agent.patch(`/tasks/${mine.taskId}`, { title: 'Fix the flaky login test (retry)' });
    expect(res.status).toBe(200);
  });

  it('does not get admin rights from projects.write', async () => {
    expect((await agent.patch(`/projects/${mine.projectId}`, { name: 'renamed by agent' })).status).toBe(403);
    expect((await agent.patch(`/task-statuses/${mine.todoStatusId}`, { name: 'Hijacked' })).status).toBe(403);
  });
});

describe('an agent given the Admin role', () => {
  it('still sees only its own projects, their runs and their trash', async () => {
    const { db } = getDb();
    const [adminRole] = await db.select({ id: schema.roles.id }).from(schema.roles).where(eq(schema.roles.key, 'admin'));
    const boss = await createAgent(users, { name: 'Ops bot', roleId: adminRole!.id });
    await addProjectMember(users, mine.projectId, boss.id, 'admin');
    const bot = await sessionFor(boss.id);

    const listed = (await json(bot.get('/projects'))).data.map((p: { id: string }) => p.id);
    expect(listed).toEqual([mine.projectId]);

    // Runs in both projects; agents.manage lists runs across tasks, but only its projects'.
    for (const [taskId, projectId] of [[mine.taskId, mine.projectId], [other.taskId, other.projectId]] as const) {
      await db.insert(schema.agentRuns).values({ id: ulid(), agentUserId: agentId, taskId, projectId, trigger: 'assigned', status: 'failed', runtime: 'claude_code' });
    }
    const runs = (await json(bot.get('/agent-runs'))).data as { projectId: string }[];
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.projectId === mine.projectId)).toBe(true);

    // The trash: projects.write used to show every deleted project.
    const gone = await setupWorkspace(users, 'GONE');
    expect((await reqAs(users.owner!.cookie).del(`/projects/${gone.projectId}`)).status).toBe(200);
    const trash = (await json(bot.get('/projects/deleted'))).data.map((p: { id: string }) => p.id);
    expect(trash).not.toContain(gone.projectId);
    expect((await bot.post(`/projects/${gone.projectId}/restore`)).status).toBe(404);
  });
});

describe('a run queued before the agent left the project', () => {
  it('is not prepared: no brief, no credentials, no repository', async () => {
    const runId = ulid();
    await getDb().db.insert(schema.agentRuns).values({
      id: runId, agentUserId: agentId, taskId: other.taskId, projectId: other.projectId,
      trigger: 'assigned', status: 'claimed', runtime: 'claude_code',
    });
    await expect(prepare(runId)).rejects.toThrow(/no longer a member/);
  });
});

describe('people keep workspace access', () => {
  it('a member-role user still opens a workspace project without a membership row', async () => {
    const hr = reqAs(users.manager!.cookie);
    expect((await hr.get(`/projects/${other.projectId}`)).status).toBe(200);
  });
});
