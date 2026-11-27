/**
 * An agent reaches only the projects it is a member of. Its role (projects.read
 * + projects.write) used to make it admin of every workspace-visible project,
 * so a task or comment that talked it into reaching further would find the
 * whole workspace open. Membership is the boundary, as it already was for
 * assigning work to an agent.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { generateToken } from '../lib/crypto';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { setupWorkspace, createAgent, addProjectMember, type Workspace } from './agents-helpers';
import { queueRun } from '../domains/agents/runs';

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
  // A session for the agent user, so requests run as an actor_type = 'agent' actor.
  const token = generateToken();
  await getDb().db.insert(schema.sessions).values({ id: ulid(), userId: agentId, token, expiresAt: new Date(Date.now() + 3600_000) });
  agent = reqAs(`ordi_session=${token}`);
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

describe('people keep workspace access', () => {
  it('a member-role user still opens a workspace project without a membership row', async () => {
    const hr = reqAs(users.manager!.cookie);
    expect((await hr.get(`/projects/${other.projectId}`)).status).toBe(200);
  });
});
