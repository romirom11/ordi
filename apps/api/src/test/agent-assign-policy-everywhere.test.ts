/**
 * An agent's assign policy (R49) holds on every path that puts work on it,
 * not only on create, edit and bulk edit: a duplicate copies an agent only if
 * the caller may assign it, and an @-mention starts an agent only if the
 * commenter may – the comment itself is posted either way, and the answer
 * says which agents did not start and why. A move leaves off an agent the
 * caller may not assign on the target project, and a run is retried only by
 * someone who may assign its agent – on the task or not – while cancelling
 * stays open to project writers.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { setupWorkspace, createAgent, addProjectMember, drainOutbox, runsForTask, type Workspace } from './agents-helpers';

let ws: Workspace;
let guarded: string; // project_admins policy
let open: string; // project_members policy

const text = (s: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] });
/** A comment the way the browser sends it: the mention lives in the body only. */
const mentioning = (userId: string, s: string) => ({
  type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: userId, label: 'Agent' } }, { type: 'text', text: ` ${s}` }] }],
});

async function assigneesOf(taskId: string): Promise<string[]> {
  const { db } = getDb();
  return (await db.select({ userId: schema.taskAssignees.userId }).from(schema.taskAssignees)
    .where(eq(schema.taskAssignees.taskId, taskId))).map((r) => r.userId).sort();
}

beforeAll(async () => {
  await resetDb();
  const users = await seedRolesAndUsers();
  ws = await setupWorkspace(users, 'POL');
  guarded = (await createAgent(users, { name: 'Guarded', assignPolicy: 'project_admins' })).id;
  open = (await createAgent(users, { name: 'Open', assignPolicy: 'project_members' })).id;
  await addProjectMember(users, ws.projectId, guarded);
  await addProjectMember(users, ws.projectId, open);
});

describe('duplicating a task', () => {
  it('leaves off an agent the caller may not assign, and keeps everyone else', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const member = reqAs(ws.users.member!.cookie);
    const source = await json(owner.post('/tasks', {
      projectId: ws.projectId, title: 'Guarded work', assigneeIds: [guarded, open, ws.users.member!.userId],
    }));

    const res = await member.post(`/tasks/${source.id}/duplicate`);
    expect(res.status).toBe(201);
    const copy = await res.json() as { id: string };
    expect(await assigneesOf(copy.id)).toEqual([open, ws.users.member!.userId].sort());

    // A follow-up comment on the copy therefore never starts the guarded agent.
    await drainOutbox();
    await member.post(`/tasks/${copy.id}/comments`, { body: text('Please pick this up') });
    await drainOutbox();
    expect((await runsForTask(copy.id)).map((r) => r.agentUserId)).not.toContain(guarded);
  });

  it('keeps the agent when the caller may assign it', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const source = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Admin copy', assigneeIds: [guarded] }));
    const copy = await json(owner.post(`/tasks/${source.id}/duplicate`));
    expect(await assigneesOf(copy.id)).toEqual([guarded]);
  });
});

describe('mentioning an agent in a comment', () => {
  it('posts the comment but does not start an agent the commenter may not assign, and says why', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const member = reqAs(ws.users.member!.cookie);
    const task = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Mention me' }));
    await drainOutbox();

    const res = await member.post(`/tasks/${task.id}/comments`, { body: mentioning(guarded, 'please fix') });
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; agentsNotStarted: unknown };
    expect(body.agentsNotStarted).toEqual([
      { userId: guarded, name: 'Guarded', reason: 'Only project admins may assign work to this agent' },
    ]);
    const comments = await json(owner.get(`/tasks/${task.id}/comments`));
    expect(comments.data.map((c: { id: string }) => c.id)).toContain(body.id);

    await drainOutbox();
    expect(await runsForTask(task.id)).toHaveLength(0);
  });

  it('starts the agent when the commenter may assign it', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const member = reqAs(ws.users.member!.cookie);
    const task = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Mention allowed' }));
    await drainOutbox();

    const byMember = await json(member.post(`/tasks/${task.id}/comments`, { body: text('@Open take a look'), mentions: [open] }));
    expect(byMember.agentsNotStarted).toEqual([]);
    await drainOutbox();
    expect((await runsForTask(task.id)).map((r) => r.agentUserId)).toEqual([open]);

    const other = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Admin mention' }));
    await drainOutbox();
    const byOwner = await json(owner.post(`/tasks/${other.id}/comments`, { body: text('@Guarded go'), mentions: [guarded] }));
    expect(byOwner.agentsNotStarted).toEqual([]);
    await drainOutbox();
    expect((await runsForTask(other.id)).map((r) => r.agentUserId)).toEqual([guarded]);
  });

  it('an agent already on the task follows up on any member\'s comment, mentioned or not', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const member = reqAs(ws.users.member!.cookie);
    const task = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Assigned by an admin', assigneeIds: [guarded] }));
    await drainOutbox();
    const { db } = getDb();
    // Settle the assignment's run, so the comment can queue its own.
    await db.update(schema.agentRuns).set({ status: 'succeeded' }).where(eq(schema.agentRuns.taskId, task.id));

    const res = await json(member.post(`/tasks/${task.id}/comments`, { body: text('@Guarded one more thing'), mentions: [guarded] }));
    expect(res.agentsNotStarted).toEqual([]);
    await drainOutbox();
    expect((await runsForTask(task.id)).filter((r) => r.status === 'queued').map((r) => r.agentUserId)).toEqual([guarded]);
  });

  it('does not start an agent the commenter may not assign once it is taken off the task before the comment is delivered', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const member = reqAs(ws.users.member!.cookie);
    const task = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Assigned, then not', assigneeIds: [guarded] }));
    await drainOutbox();
    const { db } = getDb();
    await db.update(schema.agentRuns).set({ status: 'succeeded' }).where(eq(schema.agentRuns.taskId, task.id));

    const res = await json(member.post(`/tasks/${task.id}/comments`, { body: mentioning(guarded, 'one more thing') }));
    // On the task when the comment is written, so it would follow up as an assignee.
    expect(res.agentsNotStarted).toEqual([]);
    const fresh = await json(owner.get(`/tasks/${task.id}`));
    expect((await owner.patch(`/tasks/${task.id}`, { version: fresh.version, assigneeIds: [] })).status).toBe(200);
    await drainOutbox();
    expect((await runsForTask(task.id)).filter((r) => r.status === 'queued')).toHaveLength(0);
  });
});

describe('moving a task', () => {
  it('leaves off an agent the caller may not assign on the target project', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const manager = reqAs(ws.users.manager!.cookie);
    const target = await setupWorkspace(ws.users, 'POLT');
    const locked = (await createAgent(ws.users, { name: 'Managers only', assignPolicy: 'agents_managers' })).id;
    for (const projectId of [ws.projectId, target.projectId]) {
      await addProjectMember(ws.users, projectId, locked);
      await addProjectMember(ws.users, projectId, ws.users.manager!.userId, 'admin');
    }
    await addProjectMember(ws.users, target.projectId, open);
    const task = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Moving work', assigneeIds: [locked, open] }));

    // An admin of both projects without agents.manage moves it.
    const res = await manager.post(`/tasks/${task.id}/move`, { targetProjectId: target.projectId });
    expect(res.status).toBe(200);
    const moved = await res.json() as { id: string };
    expect(await assigneesOf(moved.id)).toEqual([open]);

    const again = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Moved by the owner', assigneeIds: [locked] }));
    const byOwner = await json(owner.post(`/tasks/${again.id}/move`, { targetProjectId: target.projectId }));
    expect(await assigneesOf(byOwner.id)).toEqual([locked]);
  });
});

describe('retrying a run', () => {
  it('a run a mention started is retried only by someone who may assign the agent', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const member = reqAs(ws.users.member!.cookie);
    const task = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Retry me' }));
    await owner.post(`/tasks/${task.id}/comments`, { body: mentioning(guarded, 'please look') });
    await drainOutbox();
    const [run] = await runsForTask(task.id);
    expect(run!.agentUserId).toBe(guarded);
    const { db } = getDb();
    await db.update(schema.agentRuns).set({ status: 'failed' }).where(eq(schema.agentRuns.id, run!.id));

    expect((await member.post(`/agent-runs/${run!.id}/retry`)).status).toBe(403);
    expect((await owner.post(`/agent-runs/${run!.id}/retry`)).status).toBe(201);
  });

  // A retry spends another run whether or not the agent is on the task, so
  // it is held to the assign policy either way (it used to be open to any
  // member when the agent was assigned).
  /** Project admin on the shared project, whether or not an earlier test made them a member. */
  async function makeProjectAdmin(userId: string) {
    await getDb().db.insert(schema.projectMembers).values({ projectId: ws.projectId, userId, role: 'admin', canWriteTasks: true })
      .onConflictDoUpdate({ target: [schema.projectMembers.projectId, schema.projectMembers.userId], set: { role: 'admin' } });
  }

  async function failedRunOf(agentId: string, title: string) {
    const owner = reqAs(ws.users.owner!.cookie);
    const task = await json(owner.post('/tasks', { projectId: ws.projectId, title, assigneeIds: [agentId] }));
    await drainOutbox();
    const [run] = await runsForTask(task.id);
    expect(run!.agentUserId).toBe(agentId);
    const { db } = getDb();
    await db.update(schema.agentRuns).set({ status: 'failed' }).where(eq(schema.agentRuns.id, run!.id));
    return { taskId: task.id as string, runId: run!.id };
  }

  it('a run of an agent on the task with a project_admins policy is not retried by a plain member', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const member = reqAs(ws.users.member!.cookie);
    const { taskId, runId } = await failedRunOf(guarded, 'Assigned retry, admins only');
    const refused = await member.post(`/agent-runs/${runId}/retry`);
    expect(refused.status).toBe(403);
    expect((await json(refused)).error.message).toMatch(/project admins/i);
    expect(await runsForTask(taskId)).toHaveLength(1);
    expect((await owner.post(`/agent-runs/${runId}/retry`)).status).toBe(201);
  });

  it('a project admin retries a run of an agent with a project_admins policy', async () => {
    await makeProjectAdmin(ws.users.manager!.userId);
    const { runId } = await failedRunOf(guarded, 'Assigned retry by a project admin');
    expect((await reqAs(ws.users.manager!.cookie).post(`/agent-runs/${runId}/retry`)).status).toBe(201);
  });

  it('a run of an agent on the task with an agents_managers policy is retried only with agents.manage', async () => {
    const locked = (await createAgent(ws.users, { name: 'Locked', assignPolicy: 'agents_managers' })).id;
    await addProjectMember(ws.users, ws.projectId, locked);
    await makeProjectAdmin(ws.users.manager!.userId);
    const { runId } = await failedRunOf(locked, 'Assigned retry, managers only');
    const member = await reqAs(ws.users.member!.cookie).post(`/agent-runs/${runId}/retry`);
    expect(member.status).toBe(403);
    expect((await json(member)).error.message).toMatch(/agents\.manage/);
    // Project admin is not enough for this policy.
    expect((await reqAs(ws.users.manager!.cookie).post(`/agent-runs/${runId}/retry`)).status).toBe(403);
    expect((await reqAs(ws.users.admin!.cookie).post(`/agent-runs/${runId}/retry`)).status).toBe(201);
  });

  it('a run of an agent with a project_members policy is retried by any member', async () => {
    const { runId } = await failedRunOf(open, 'Assigned retry, open agent');
    expect((await reqAs(ws.users.member!.cookie).post(`/agent-runs/${runId}/retry`)).status).toBe(201);
  });

  it('a plain member still cancels a run of an agent they may not retry', async () => {
    const owner = reqAs(ws.users.owner!.cookie);
    const task = await json(owner.post('/tasks', { projectId: ws.projectId, title: 'Cancel me', assigneeIds: [guarded] }));
    await drainOutbox();
    const [run] = await runsForTask(task.id);
    expect(run!.status).toBe('queued');
    const res = await reqAs(ws.users.member!.cookie).post(`/agent-runs/${run!.id}/cancel`);
    expect(res.status).toBe(200);
    expect((await json(res)).status).toBe('cancelled');
  });
});
