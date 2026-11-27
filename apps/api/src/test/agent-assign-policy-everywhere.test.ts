/**
 * An agent's assign policy (R49) holds on every path that puts work on it,
 * not only on create, edit and bulk edit: a duplicate copies an agent only if
 * the caller may assign it, and an @-mention starts an agent only if the
 * commenter may – the comment itself is posted either way, and the answer
 * says which agents did not start and why.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { setupWorkspace, createAgent, addProjectMember, drainOutbox, runsForTask, type Workspace } from './agents-helpers';

let ws: Workspace;
let guarded: string; // project_admins policy
let open: string; // project_members policy

const text = (s: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }] });

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

    const res = await member.post(`/tasks/${task.id}/comments`, { body: text('@Guarded please fix'), mentions: [guarded] });
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
});
