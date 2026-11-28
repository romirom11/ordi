/**
 * The Inbox: what waits on a person – questions put to them, agent runs that
 * stopped on their work, their mentions and their leave approvals – and,
 * above all, nothing from a project they cannot open now.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json, app } from './helpers';
import { setupWorkspace, addProjectMember, createAgent, drainOutbox, type Workspace } from './agents-helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let ws: Workspace;
let privId: string;
let agentId: string;

const owner = () => reqAs(users.owner!.cookie);
const member = () => reqAs(users.member!.cookie);

const mentionDoc = (userId: string, text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: userId } }, { type: 'text', text }] }],
});

async function newTask(projectId: string, input: Record<string, unknown> = {}): Promise<{ id: string; ref: string }> {
  const res = await owner().post('/tasks', { projectId, title: 'Inbox work', ...input });
  expect(res.status).toBe(201);
  return json(res);
}

async function insertRun(taskId: string, projectId: string, status: string, createdAt = new Date()) {
  const id = ulid();
  await getDb().db.insert(schema.agentRuns).values({
    id, agentUserId: agentId, taskId, projectId, trigger: 'assigned', status, runtime: 'claude_code',
    error: status === 'failed' ? 'It broke' : null, createdAt, updatedAt: createdAt,
  });
  return id;
}

const inboxOf = (cookie: string) => json(reqAs(cookie).get('/inbox'));
const countOf = (cookie: string) => json(reqAs(cookie).get('/inbox/count'));

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  ws = await setupWorkspace(users, 'INB');
  const type = await json(owner().post('/project-types', { name: 'Private type', revenueSource: 'none' }));
  privId = (await json(owner().post('/projects', { name: 'Private', key: 'PRV', projectTypeId: type.id, visibility: 'private' }))).id;
  await addProjectMember(users, privId, users.member!.userId, 'member');
  agentId = (await createAgent(users)).id;
  await addProjectMember(users, ws.projectId, agentId, 'member');
  await addProjectMember(users, privId, agentId, 'member');
});

describe('waiting on you', () => {
  it('lists the open questions put to me and counts them on the badge', async () => {
    const t = await newTask(ws.projectId, { assigneeIds: [users.member!.userId] });
    await owner().post(`/tasks/${t.id}/question`, { question: 'Ready to ship?' });
    const box = await inboxOf(users.member!.cookie);
    expect(box.waitingOnYou.map((q: { task: { id: string } }) => q.task.id)).toContain(t.id);
    expect(box.waitingOnYou.find((q: { task: { id: string } }) => q.task.id === t.id)).toMatchObject({
      question: 'Ready to ship?', askedBy: { id: users.owner!.userId }, task: { ref: t.ref, projectId: ws.projectId },
    });
    expect((await countOf(users.member!.cookie)).waitingOnYou).toBeGreaterThanOrEqual(1);
    // Answered, it leaves the Inbox.
    await member().post(`/tasks/${t.id}/comments`, { body: mentionDoc(users.owner!.userId, ' yes') });
    const after = await inboxOf(users.member!.cookie);
    expect(after.waitingOnYou.map((q: { task: { id: string } }) => q.task.id)).not.toContain(t.id);
  });
});

describe('agent stopped', () => {
  it('shows a failed or parked run on my task, and not one a later run has fixed', async () => {
    const failed = await newTask(ws.projectId, { assigneeIds: [users.member!.userId, agentId] });
    const parked = await newTask(ws.projectId, { reporterId: users.member!.userId });
    const fixed = await newTask(ws.projectId, { assigneeIds: [users.member!.userId] });
    const notMine = await newTask(ws.projectId, { reporterId: users.owner!.userId });
    const failedRun = await insertRun(failed.id, ws.projectId, 'failed');
    const parkedRun = await insertRun(parked.id, ws.projectId, 'waiting_quota');
    await insertRun(fixed.id, ws.projectId, 'failed', new Date(Date.now() - 60_000));
    await insertRun(fixed.id, ws.projectId, 'succeeded');
    await insertRun(notMine.id, ws.projectId, 'failed');
    const box = await inboxOf(users.member!.cookie);
    const ids = box.agentStopped.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining([failedRun, parkedRun]));
    const tasksShown = box.agentStopped.map((r: { task: { id: string } }) => r.task.id);
    expect(tasksShown).not.toContain(fixed.id);
    expect(tasksShown).not.toContain(notMine.id);
    expect(box.agentStopped.find((r: { id: string }) => r.id === failedRun)).toMatchObject({ status: 'failed', error: 'It broke', agent: { id: agentId } });
  });

  it('shows the runs of an agent I own', async () => {
    const created = await json(owner().post('/external-agents', { name: 'Owned bot', ownerUserId: users.manager!.userId }));
    const t = await newTask(ws.projectId, { reporterId: users.owner!.userId });
    const id = ulid();
    await getDb().db.insert(schema.agentRuns).values({
      id, agentUserId: created.id, taskId: t.id, projectId: ws.projectId, trigger: 'assigned', status: 'failed', runtime: 'claude_code',
    });
    const box = await inboxOf(users.manager!.cookie);
    expect(box.agentStopped.map((r: { id: string }) => r.id)).toContain(id);
  });
});

describe('mentions', () => {
  it('lists my recent mentions on tasks', async () => {
    const t = await newTask(ws.projectId);
    await owner().post(`/tasks/${t.id}/comments`, { body: mentionDoc(users.member!.userId, ' have a look') });
    await drainOutbox();
    const box = await inboxOf(users.member!.cookie);
    expect(box.mentions.find((m: { payload: { taskId: string } }) => m.payload.taskId === t.id)).toMatchObject({
      type: 'comment.mentioned', ref: t.ref, actorName: 'Owner',
    });
  });
});

describe('approvals', () => {
  it('lists leave waiting on my decision and counts it', async () => {
    const { db } = getDb();
    const employeeId = ulid();
    const typeId = ulid();
    await db.insert(schema.employees).values({ id: employeeId, userId: users.member!.userId, firstName: 'Mykola', lastName: 'Member' });
    await db.insert(schema.leaveTypes).values({ id: typeId, name: 'Vacation' });
    const leaveId = ulid();
    await db.insert(schema.leaveRequests).values({
      id: leaveId, employeeId, leaveTypeId: typeId, fromDate: '2026-12-01', toDate: '2026-12-05', status: 'pending', approverId: users.manager!.userId,
    });
    const box = await inboxOf(users.manager!.cookie);
    expect(box.approvals).toEqual([expect.objectContaining({ kind: 'leave', id: leaveId, employeeName: 'Mykola Member', leaveTypeName: 'Vacation' })]);
    expect((await countOf(users.manager!.cookie)).approvals).toBe(1);
    // Someone else's approvals are not mine.
    expect((await inboxOf(users.hr!.cookie)).approvals).toEqual([]);
  });
});

describe('private projects', () => {
  it('drop out of every section the moment I cannot open them', async () => {
    const t = await newTask(privId, { assigneeIds: [users.member!.userId] });
    await owner().post(`/tasks/${t.id}/question`, { question: 'Secret plan?' });
    await owner().post(`/tasks/${t.id}/comments`, { body: mentionDoc(users.member!.userId, ' about the secret') });
    const run = await insertRun(t.id, privId, 'failed');
    await drainOutbox();

    const before = await inboxOf(users.member!.cookie);
    expect(before.waitingOnYou.map((q: { task: { id: string } }) => q.task.id)).toContain(t.id);
    expect(before.agentStopped.map((r: { id: string }) => r.id)).toContain(run);
    expect(before.mentions.map((m: { payload: { taskId: string } }) => m.payload.taskId)).toContain(t.id);
    const countBefore = (await countOf(users.member!.cookie)).waitingOnYou;

    await owner().del(`/projects/${privId}/members/${users.member!.userId}`);
    const after = await inboxOf(users.member!.cookie);
    expect(JSON.stringify(after)).not.toContain(t.id);
    expect(JSON.stringify(after)).not.toContain('Secret plan');
    expect(JSON.stringify(after)).not.toContain('PRV-');
    expect((await countOf(users.member!.cookie)).waitingOnYou).toBe(countBefore - 1);
  });

  it('never shows someone else\'s questions, even on a workspace project', async () => {
    const t = await newTask(ws.projectId, { assigneeIds: [users.member!.userId] });
    await owner().post(`/tasks/${t.id}/question`, { question: 'For the member only' });
    expect(JSON.stringify(await inboxOf(users.manager!.cookie))).not.toContain('For the member only');
  });

  it('is a person\'s: an agent token is refused', async () => {
    const created = await json(owner().post('/external-agents', { name: 'Curious bot' }));
    const { token } = await json(owner().post(`/external-agents/${created.id}/tokens`, { expiresInDays: 30 }));
    const res = await app.request('/api/v1/inbox', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });
});
