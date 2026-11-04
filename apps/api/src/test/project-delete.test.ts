/**
 * Deleting a project hides everything under it and stops what runs on its own;
 * restoring brings it all back. The key goes back to the pool in between.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq, and, isNull } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { runRecurringTasks } from '../workers/scheduled';
import { openTasksAssignedTo } from '../domains/projects/service';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let owner: ReturnType<typeof reqAs>;
let typeId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  typeId = (await json(owner.post('/project-types', { name: 'Delivery', revenueSource: 'none' }))).id;
});

async function project(key: string): Promise<string> {
  const res = await owner.post('/projects', { name: `Project ${key}`, key, projectTypeId: typeId });
  expect(res.status).toBe(201);
  return (await json(res)).id;
}

describe('project key after delete', () => {
  it('can be used again, and a restore waits until it is free', async () => {
    const first = await project('KEY');
    expect((await owner.del(`/projects/${first}`)).status).toBe(200);

    // Used to be a 500: the table-wide unique constraint still held the key.
    const second = await project('KEY');

    const listed = await json(owner.get('/projects/deleted'));
    expect(listed.data.map((p: { id: string }) => p.id)).toContain(first);

    const blocked = await owner.post(`/projects/${first}/restore`);
    expect(blocked.status).toBe(422);
    expect((await json(blocked)).error.message).toContain('KEY');

    await owner.del(`/projects/${second}`);
    const restored = await owner.post(`/projects/${first}/restore`);
    expect(restored.status).toBe(200);
    expect((await json(restored)).deletedAt).toBeNull();
    expect((await owner.get(`/projects/${first}`)).status).toBe(200);
  });

  it('only shows the trash to people who may restore', async () => {
    const id = await project('TRS');
    await owner.del(`/projects/${id}`);
    // The member role has no projects.delete.
    expect((await reqAs(users.member!.cookie).get('/projects/deleted')).status).toBe(403);
    expect((await reqAs(users.member!.cookie).post(`/projects/${id}/restore`)).status).toBe(403);
  });
});

describe('what a deleted project takes with it', () => {
  let projectId: string;
  let taskId: string;
  let formToken: string;

  beforeAll(async () => {
    projectId = await project('GONE');
    const task = await json(owner.post('/tasks', { projectId, title: 'Billable work', assigneeIds: [users.member!.userId] }));
    taskId = task.id;
    expect((await owner.post(`/projects/${projectId}/members`, { userId: users.member!.userId, role: 'member', canWriteTasks: true })).status).toBe(201);

    const { db } = getDb();
    await db.insert(schema.timeEntries).values({
      id: ulid(), taskId, userId: users.owner!.userId, projectId,
      startedAt: new Date('2026-10-01T09:00:00Z'), durationSeconds: 7200, note: 'logged', billable: true, hourlyRate: '50',
    });
    // Every project gets its intake settings row on creation; switch the form on.
    const [intake] = await db.update(schema.intakeSettings).set({ formEnabled: true })
      .where(eq(schema.intakeSettings.projectId, projectId)).returning();
    formToken = intake!.formToken;
    const templateId = ulid();
    await db.insert(schema.taskTemplates).values({ id: templateId, projectId, name: 'Weekly report' });
    await db.insert(schema.recurringTasks).values({ id: ulid(), projectId, templateId, frequency: 'weekly', nextRun: '2026-01-01' });

    // A timer running at the moment of the delete.
    expect((await owner.post('/time/timer/start', { taskId })).status).toBe(200);
    expect((await owner.del(`/projects/${projectId}`)).status).toBe(200);
  });

  it('saves the running timer as a time entry instead of losing it', async () => {
    const { db } = getDb();
    const timers = await db.select().from(schema.activeTimers).where(eq(schema.activeTimers.userId, users.owner!.userId));
    expect(timers).toHaveLength(0);
    const entries = await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.projectId, projectId));
    expect(entries).toHaveLength(2);
    expect(await json(owner.get('/time/timer'))).toBeNull();
  });

  it('leaves time reports, entries and unbilled hours', async () => {
    const report = await json(owner.get('/time/reports?groupBy=project'));
    expect(report.data.some((r: { key: string }) => r.key === projectId)).toBe(false);
    const unbilled = await json(owner.get('/time/unbilled'));
    expect(unbilled.data.some((r: { projectId: string }) => r.projectId === projectId)).toBe(false);
    const entries = await json(owner.get(`/time/entries?projectId=${projectId}`));
    expect(entries.data).toHaveLength(0);
    const exported = await (await owner.get('/export/time.csv')).text();
    expect(exported).not.toContain('GONE-');
  });

  it('closes the public intake form', async () => {
    const res = await reqAs('').post(`/intake/${formToken}`, { requesterName: 'Bot', title: 'Hello' });
    expect(res.status).toBe(404);
  });

  it('stops recurring tasks', async () => {
    await runRecurringTasks();
    const { db } = getDb();
    const tasks = await db.select().from(schema.tasks).where(and(eq(schema.tasks.projectId, projectId), isNull(schema.tasks.deletedAt)));
    expect(tasks).toHaveLength(1);
  });

  it('takes former members off its tasks in bulk edits', async () => {
    const res = await json(reqAs(users.member!.cookie).post('/tasks/bulk', { taskIds: [taskId], priority: 'urgent' }));
    expect(res.updated ?? 0).toBe(0);
    const { db } = getDb();
    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(task?.priority).not.toBe('urgent');
  });

  it('keeps its tasks out of a deactivation hand-off', async () => {
    const open = await openTasksAssignedTo(users.member!.userId);
    expect(open.some((t) => t.id === taskId)).toBe(false);
  });

  it('comes back whole on restore, recurring tasks included', async () => {
    expect((await owner.post(`/projects/${projectId}/restore`)).status).toBe(200);
    const entries = await json(owner.get(`/time/entries?projectId=${projectId}`));
    expect(entries.data).toHaveLength(2);
    await runRecurringTasks();
    const { db } = getDb();
    const tasks = await db.select().from(schema.tasks).where(and(eq(schema.tasks.projectId, projectId), isNull(schema.tasks.deletedAt)));
    expect(tasks).toHaveLength(2);
  });
});

describe('the project space in the knowledge base', () => {
  it('is hidden with its deleted project, even when workspace-visible', async () => {
    const projectId = await project('KBS');
    const space = await json(owner.post('/spaces', { name: 'Project notes', projectId, visibility: 'workspace' }));
    const before = await json(reqAs(users.member!.cookie).get('/spaces'));
    expect(before.data.some((s: { id: string }) => s.id === space.id)).toBe(true);

    await owner.del(`/projects/${projectId}`);
    const after = await json(reqAs(users.member!.cookie).get('/spaces'));
    expect(after.data.some((s: { id: string }) => s.id === space.id)).toBe(false);
    expect((await reqAs(users.member!.cookie).get(`/spaces/${space.id}`)).status).toBe(404);
  });
});

describe('project types', () => {
  it('can be deleted when only deleted projects use them', async () => {
    const spare = await json(owner.post('/project-types', { name: 'Spare', revenueSource: 'none' }));
    const id = (await json(owner.post('/projects', { name: 'On spare', key: 'SPR', projectTypeId: spare.id }))).id;
    expect((await owner.del(`/project-types/${spare.id}`)).status).toBe(422);
    await owner.del(`/projects/${id}`);
    expect((await owner.del(`/project-types/${spare.id}`)).status).toBe(200);
    // The deleted project moved to another type, so a restore still has one.
    expect((await owner.post(`/projects/${id}/restore`)).status).toBe(200);
  });
});

describe('agent runs of a deleted project', () => {
  it('are cancelled, or asked to stop when already running', async () => {
    const projectId = await project('AGR');
    // One active run per task and agent, so two tasks.
    const task = await json(owner.post('/tasks', { projectId, title: 'For the agent' }));
    const other = await json(owner.post('/tasks', { projectId, title: 'Already running' }));
    const { db } = getDb();
    const queuedId = ulid();
    const runningId = ulid();
    const agentUserId = users.agent!.userId;
    await db.insert(schema.agentRuns).values([
      { id: queuedId, agentUserId, taskId: task.id, projectId, trigger: 'manual', status: 'queued', runtime: 'claude_code' },
      { id: runningId, agentUserId, taskId: other.id, projectId, trigger: 'manual', status: 'running', runtime: 'claude_code' },
    ]);

    await owner.del(`/projects/${projectId}`);

    const [queued] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, queuedId));
    const [running] = await db.select().from(schema.agentRuns).where(eq(schema.agentRuns.id, runningId));
    expect(queued?.status).toBe('cancelled');
    // The worker polls for this request and aborts the run itself.
    expect(running?.error).toBe('cancel requested');
  });
});
