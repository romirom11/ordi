/**
 * Notifications (ORD-30): who a notification reaches, and what it says.
 *
 * The rules under test: it is addressed to the people it concerns and to
 * nobody else, the person who caused it is not one of them, a comment reaches
 * the thread and not only the @-mentioned, and the row is streamed to its
 * recipient alone rather than to everyone who can see the project.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb, schema, and, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { emit, broadcaster, type SSEMessage } from '../core/events';
import { processOutboxOnce } from '../workers/relay';
import { consumers, notificationPath } from '../workers/consumers';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

const docMentioning = (userId: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: userId } }] }],
});

/** Notification types waiting for one person, newest first. */
async function notificationsOf(userId: string): Promise<{ type: string; entityRef: string | null; payload: any }[]> {
  const { db } = getDb();
  const rows = await db.select().from(schema.notifications)
    .where(eq(schema.notifications.userId, userId))
    .orderBy(schema.notifications.createdAt, schema.notifications.id);
  return rows.map((r) => ({ type: r.type, entityRef: r.entityRef, payload: r.payload as any }));
}

async function typesFor(userId: string): Promise<string[]> {
  return (await notificationsOf(userId)).map((n) => n.type);
}

async function clearNotifications(): Promise<void> {
  const { db } = getDb();
  await db.delete(schema.notifications);
}

/** Record every frame the consumers broadcast while `run` executes. */
async function captureStream(run: () => Promise<void>): Promise<SSEMessage[]> {
  const frames: SSEMessage[] = [];
  const unsub = broadcaster.subscribe((msg) => frames.push(msg));
  try {
    await run();
  } finally {
    unsub();
  }
  return frames;
}

async function newTask(cookie: string, input: Record<string, unknown>): Promise<{ id: string; ref: string }> {
  const created = await json(reqAs(cookie).post('/tasks', { projectId, ...input }));
  return { id: created.id as string, ref: created.ref as string };
}

/** A status the task is not in, so a patch actually changes it. */
async function otherStatusId(cookie: string, statusId: string): Promise<string> {
  const statuses = await json(reqAs(cookie).get(`/projects/${projectId}/task-statuses`));
  return (statuses.data as { id: string }[]).find((s) => s.id !== statusId)!.id;
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Delivery', revenueSource: 'none' }));
  projectId = (await json(owner.post('/projects', { name: 'Delivery', key: 'DEL', projectTypeId: type.id }))).id;
  for (const key of ['member', 'sales', 'manager']) {
    await json(owner.post(`/projects/${projectId}/members`, { userId: users[key]!.userId, role: 'member', canWriteTasks: true }));
  }
});

beforeEach(async () => {
  await clearNotifications();
});

describe('notification recipients', () => {
  it('notifies the assignee of a new task and nobody else', async () => {
    await newTask(users.owner!.cookie, { title: 'Ship the thing', assigneeIds: [users.member!.userId] });
    await processOutboxOnce();

    expect(await typesFor(users.member!.userId)).toEqual(['task.assigned']);
    // The author assigned it, the other members are bystanders: a task for one
    // person used to read as "a task was assigned to you" for the whole team.
    expect(await typesFor(users.owner!.userId)).toEqual([]);
    expect(await typesFor(users.sales!.userId)).toEqual([]);
    expect(await typesFor(users.manager!.userId)).toEqual([]);
  });

  it('leaves the actor out of their own assignment and their own status change', async () => {
    const { id } = await newTask(users.owner!.cookie, { title: 'Mine alone', assigneeIds: [users.owner!.userId] });
    await processOutboxOnce();
    expect(await typesFor(users.owner!.userId)).toEqual([]);

    const task = await json(reqAs(users.owner!.cookie).get(`/tasks/${id}`));
    const statusId = await otherStatusId(users.owner!.cookie, task.statusId);
    const res = await reqAs(users.owner!.cookie).patch(`/tasks/${id}`, { statusId, version: task.version });
    expect(res.status).toBe(200);
    await processOutboxOnce();

    expect(await typesFor(users.owner!.userId)).toEqual([]);
  });

  it('tells the assignee and the author when someone else moves the task', async () => {
    const { id } = await newTask(users.owner!.cookie, { title: 'Moved by another', assigneeIds: [users.sales!.userId] });
    await processOutboxOnce();
    await clearNotifications();

    const task = await json(reqAs(users.member!.cookie).get(`/tasks/${id}`));
    const statusId = await otherStatusId(users.member!.cookie, task.statusId);
    await reqAs(users.member!.cookie).patch(`/tasks/${id}`, { statusId, version: task.version });
    await processOutboxOnce();

    expect(await typesFor(users.sales!.userId)).toEqual(['task.status_changed']);
    expect(await typesFor(users.owner!.userId)).toEqual(['task.status_changed']);
    expect(await typesFor(users.member!.userId)).toEqual([]);
  });
});

describe('notifications for a comment', () => {
  it('reaches the task author, its assignees and the earlier commenters', async () => {
    const { id } = await newTask(users.owner!.cookie, { title: 'Discuss me', assigneeIds: [users.sales!.userId] });
    await json(reqAs(users.manager!.cookie).post(`/tasks/${id}/comments`, { body: doc('First thought') }));
    await processOutboxOnce();
    await clearNotifications();

    await json(reqAs(users.member!.cookie).post(`/tasks/${id}/comments`, { body: doc('Second thought') }));
    await processOutboxOnce();

    // The author of the task hearing nothing when someone answers on it was
    // the complaint that opened ORD-30.
    expect(await typesFor(users.owner!.userId)).toEqual(['comment.created']);
    expect(await typesFor(users.sales!.userId)).toEqual(['comment.created']);
    expect(await typesFor(users.manager!.userId)).toEqual(['comment.created']);
    expect(await typesFor(users.member!.userId)).toEqual([]);
  });

  it('does not tell a mentioned person about the same comment twice', async () => {
    const { id } = await newTask(users.member!.cookie, { title: 'Mention me', assigneeIds: [users.sales!.userId] });
    await processOutboxOnce();
    await clearNotifications();

    await json(reqAs(users.manager!.cookie).post(`/tasks/${id}/comments`, { body: docMentioning(users.sales!.userId) }));
    await processOutboxOnce();

    expect(await typesFor(users.sales!.userId)).toEqual(['comment.mentioned']);
    expect(await typesFor(users.member!.userId)).toEqual(['comment.created']);
  });

  it('carries the task link, so the row opens the task it belongs to', async () => {
    const { id, ref } = await newTask(users.owner!.cookie, { title: 'Linked', assigneeIds: [] });
    await processOutboxOnce();
    await clearNotifications();

    await json(reqAs(users.member!.cookie).post(`/tasks/${id}/comments`, { body: doc('Over here') }));
    await processOutboxOnce();

    const [notification] = await notificationsOf(users.owner!.userId);
    expect(notification?.entityRef).toBe(ref);
    expect(notification?.payload).toMatchObject({ taskId: id, projectId });
  });

  it('stays quiet for an agent, whose run events already report it', async () => {
    const { id, ref } = await newTask(users.owner!.cookie, { title: 'Worked by an agent' });
    await processOutboxOnce();
    await clearNotifications();

    // A comment from the runtime, which also emits agent.needs_input or
    // agent.run_finished for the same news.
    await emit({
      type: 'comment.created', aggregateType: 'comment', aggregateId: ulid(),
      payload: { taskId: id, projectId, ref }, actorId: users.agent!.userId, actorType: 'agent',
    });
    await processOutboxOnce();
    expect(await typesFor(users.owner!.userId)).toEqual([]);

    // A human's comment on the same task still reaches the author.
    await json(reqAs(users.member!.cookie).post(`/tasks/${id}/comments`, { body: doc('Human note') }));
    await processOutboxOnce();
    expect(await typesFor(users.owner!.userId)).toEqual(['comment.created']);
  });
});

describe('notifications outside projects', () => {
  it('sends a paid invoice to whoever raised it and whoever owns the client', async () => {
    const { db } = getDb();
    const companyId = ulid();
    const invoiceId = ulid();
    await db.insert(schema.companies).values({ id: companyId, name: 'Acme', ownerId: users.sales!.userId });
    await db.insert(schema.invoices).values({
      id: invoiceId, companyId, number: 'INV-2026-0007', issueDate: '2026-09-01', dueDate: '2026-09-15',
      publicToken: ulid(), createdBy: users.finance!.userId,
    });

    await emit({
      type: 'invoice.paid', aggregateType: 'invoice', aggregateId: invoiceId,
      payload: { number: 'INV-2026-0007', companyId }, actorId: users.owner!.userId, actorType: 'user',
    });
    await processOutboxOnce();

    const [raised] = await notificationsOf(users.finance!.userId);
    expect(raised?.type).toBe('invoice.paid');
    // The email used to read "Invoice  was paid" and link to the finance index:
    // the event names the document, so the recipients and the ref come from it.
    expect(raised?.entityRef).toBe('INV-2026-0007');
    expect(raised?.payload).toMatchObject({ invoiceId, ref: 'INV-2026-0007' });
    expect(await typesFor(users.sales!.userId)).toEqual(['invoice.paid']);
  });

  it('reports a declined quote, not only an accepted one', async () => {
    const { db } = getDb();
    const companyId = ulid();
    const quoteId = ulid();
    await db.insert(schema.companies).values({ id: companyId, name: 'Globex', ownerId: users.sales!.userId });
    await db.insert(schema.quotes).values({
      id: quoteId, companyId, number: 'QUO-2026-0003', issueDate: '2026-09-01',
      publicToken: ulid(), createdBy: users.finance!.userId,
    });

    // The client's own decision: no actor, and a payload that names neither
    // the owner nor the author.
    await emit({
      type: 'quote.declined', aggregateType: 'quote', aggregateId: quoteId,
      payload: { ownerId: null, ref: 'QUO-2026-0003' }, actorId: null, actorType: 'system',
    });
    await processOutboxOnce();

    expect(await typesFor(users.finance!.userId)).toEqual(['quote.declined']);
    expect(await typesFor(users.sales!.userId)).toEqual(['quote.declined']);
  });

  it('files a page mention under its own type, linking the page', async () => {
    const { db } = getDb();
    const spaceId = ulid();
    const pageId = ulid();
    await db.insert(schema.kbSpaces).values({ id: spaceId, name: 'Handbook' });
    await db.insert(schema.kbPages).values({ id: pageId, spaceId, title: 'Onboarding', createdBy: users.owner!.userId });

    await emit({
      type: 'page.mentioned', aggregateType: 'page', aggregateId: pageId,
      payload: { pageId, spaceId, mentions: [users.member!.userId, users.owner!.userId] },
      actorId: users.owner!.userId, actorType: 'user',
    });
    await processOutboxOnce();

    const [mentioned] = await notificationsOf(users.member!.userId);
    // Filed as comment.mentioned it showed up as a task mention and opened the
    // task list; its own type is what makes the bell say "on a page".
    expect(mentioned?.type).toBe('page.mentioned');
    expect(mentioned?.payload).toMatchObject({ pageId, spaceId });
    // The person who wrote the mention is not told about their own writing.
    expect(await typesFor(users.owner!.userId)).toEqual([]);
  });

  it('sends a merged pull request to the people on the task', async () => {
    const { id, ref } = await newTask(users.owner!.cookie, { title: 'Merged work', assigneeIds: [users.member!.userId] });
    await processOutboxOnce();
    await clearNotifications();

    // The webhook knows the task and not its people, which is why it used to
    // announce the merge to an empty list.
    await emit({
      type: 'git.pr_merged', aggregateType: 'task', aggregateId: id,
      payload: { taskId: id, projectId, ref }, actorId: null, actorType: 'integration',
    });
    await processOutboxOnce();

    expect(await typesFor(users.member!.userId)).toEqual(['git.pr_merged']);
    expect(await typesFor(users.owner!.userId)).toEqual(['git.pr_merged']);
  });
});

describe('notification delivery', () => {
  it('streams each row to its recipient alone', async () => {
    const { id } = await newTask(users.owner!.cookie, { title: 'Streamed', assigneeIds: [] });
    await processOutboxOnce();
    await clearNotifications();

    const frames = await captureStream(async () => {
      await json(reqAs(users.member!.cookie).post(`/tasks/${id}/comments`, { body: doc('Ping') }));
      await processOutboxOnce();
    });

    const addressed = frames.filter((f) => f.event === 'notification.created');
    expect(addressed).toHaveLength(1);
    expect(addressed[0]?.userScope).toEqual([users.owner!.userId]);
    expect(addressed[0]?.data).toMatchObject({ type: 'comment.created' });
  });

  it('writes the rows before the event reaches any client', () => {
    // Whatever a client refreshes on an event, it must read a bell the
    // notifications consumer has already written to.
    const names = consumers.map((c) => c.name);
    expect(names.indexOf('notifications')).toBeLessThan(names.indexOf('sse'));
  });

  it('does not repeat the stream frame when the relay replays the event', async () => {
    const { db } = getDb();
    const eventId = await emit({
      type: 'task.assigned', aggregateType: 'task', aggregateId: ulid(),
      payload: { assigneeIds: [users.member!.userId], ref: 'DEL-99', projectId },
      actorId: users.owner!.userId, actorType: 'user',
    });
    await processOutboxOnce();

    const replayed = await captureStream(async () => {
      await db.delete(schema.processedEvents).where(and(
        eq(schema.processedEvents.consumer, 'notifications'),
        eq(schema.processedEvents.eventId, eventId),
      ));
      await db.update(schema.events).set({ publishedAt: null }).where(eq(schema.events.id, eventId));
      await processOutboxOnce();
    });

    expect(replayed.filter((f) => f.event === 'notification.created')).toHaveLength(0);
    expect(await typesFor(users.member!.userId)).toEqual(['task.assigned']);
  });

  /**
   * The same table is asserted against notifLink() in
   * apps/web/src/lib/notifications.test.ts. The email button and the bell row
   * must not land the reader in two different places.
   */
  it('points the email at the same place as the bell', () => {
    const task = { projectId: 'p1', taskId: 't1' };
    for (const type of ['task.assigned', 'task.status_changed', 'comment.created', 'comment.mentioned', 'git.pr_merged', 'agent.needs_input']) {
      expect(notificationPath(type, task)).toBe('/projects/p1/tasks/t1');
    }
    expect(notificationPath('task.assigned', {})).toBe('/my-tasks');
    expect(notificationPath('page.mentioned', { pageId: 'pg1', spaceId: 'sp1' })).toBe('/kb/sp1/pg1');
    expect(notificationPath('comment.mentioned', { pageId: 'pg1', spaceId: 'sp1' })).toBe('/kb/sp1/pg1');
    expect(notificationPath('invoice.paid', { invoiceId: 'i1' })).toBe('/finance/invoices/i1');
    expect(notificationPath('payment.recorded', { invoiceId: 'i1' })).toBe('/finance/invoices/i1');
    expect(notificationPath('invoice.paid', {})).toBe('/finance');
    expect(notificationPath('quote.accepted', {})).toBe('/finance');
    expect(notificationPath('quote.declined', {})).toBe('/finance');
    expect(notificationPath('leave.requested', {})).toBe('/people');
    expect(notificationPath('leave.decided', {})).toBe('/people');
    expect(notificationPath('sales.work_digest', {})).toBe('/crm/work');
    expect(notificationPath('agent.credential_expired', {})).toBe('/settings/agents');
    expect(notificationPath('something.new', {})).toBeNull();
  });

  it('skips a deactivated account', async () => {
    const { db } = getDb();
    await db.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, users.sales!.userId));
    await newTask(users.owner!.cookie, { title: 'For someone who left', assigneeIds: [users.sales!.userId] });
    await processOutboxOnce();
    await db.update(schema.users).set({ isActive: true }).where(eq(schema.users.id, users.sales!.userId));

    expect(await typesFor(users.sales!.userId)).toEqual([]);
  });
});
