/**
 * Slack notification copy (ORD-32): every message is Block Kit – the entity's
 * reference carries the deep link, a muted context line says which project,
 * whose work and what state, the push fallback is one short line without a
 * URL, and human text is escaped so a title like "Fix <script> parsing"
 * survives mrkdwn. Both delivery paths send the same blocks.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import type { DomainEvent, EventType } from '@ordi/shared';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { buildSlackMessage, type SlackMessage } from '../workers/slack-messages';
import { consumers } from '../workers/consumers';
import { encrypt } from '../lib/crypto';

const TASK_TITLE = 'Fix <script> parsing & co';
const COMPANY_NAME = 'Finqbit <Ltd> & Sons';
const ASSIGNEE_NAME = 'Roman <K> & Co';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;
let companyId: string;
let task: { id: string; ref: string };
let statusName: string;

const slackConsumer = consumers.find((c) => c.name === 'slack')!;

function event(
  type: EventType,
  aggregate: { type: DomainEvent['aggregateType']; id: string },
  payload: Record<string, unknown> = {},
  actorId: string | null = null,
): DomainEvent {
  return {
    id: ulid(),
    type,
    aggregateType: aggregate.type,
    aggregateId: aggregate.id,
    payload,
    occurredAt: new Date().toISOString(),
    actorId,
    actorType: actorId ? 'user' : 'system',
  };
}

function taskEvent(type: EventType, payload: Record<string, unknown> = {}, actorId: string | null = null): DomainEvent {
  return event(type, { type: 'task', id: task.id }, { taskId: task.id, projectId, ref: task.ref, ...payload }, actorId);
}

function section(msg: SlackMessage): string {
  const block = msg.blocks[0];
  expect(block?.type).toBe('section');
  return (block as { text: { text: string } }).text.text;
}

function context(msg: SlackMessage): string {
  const block = msg.blocks[1];
  expect(block?.type).toBe('context');
  return (block as { elements: { text: string }[] }).elements[0]!.text;
}

async function built(ev: DomainEvent): Promise<SlackMessage> {
  const msg = await buildSlackMessage(ev);
  expect(msg).not.toBeNull();
  return msg!;
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();
  // Human text carries mrkdwn control characters everywhere it can: title,
  // company and the name of the person on the task.
  await db.update(schema.users).set({ name: ASSIGNEE_NAME }).where(eq(schema.users.id, users.member!.userId));
  companyId = ulid();
  await db.insert(schema.companies).values({ id: companyId, name: COMPANY_NAME, createdBy: users.owner!.userId });

  const owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Delivery', revenueSource: 'none' }));
  projectId = (await json(owner.post('/projects', { name: 'Finqbit', key: 'FIN', projectTypeId: type.id, companyId }))).id;
  await json(owner.post(`/projects/${projectId}/members`, { userId: users.member!.userId, role: 'member', canWriteTasks: true }));
  const created = await json(owner.post('/tasks', { projectId, title: TASK_TITLE, assigneeIds: [users.member!.userId] }));
  task = { id: created.id, ref: created.ref };
  const statuses = await json(owner.get(`/projects/${projectId}/task-statuses`));
  statusName = (statuses.data as { id: string; name: string }[]).find((s) => s.id === created.statusId)!.name;
});

describe('task messages', () => {
  it('links the ref instead of dumping a raw URL, and names project, assignee and status', async () => {
    const msg = await built(taskEvent('task.created', {}, users.owner!.userId));
    expect(msg.projectId).toBe(projectId);

    // mrkdwn `<url|label>`: the URL hides behind the short ref.
    expect(section(msg)).toContain(`/projects/${projectId}/tasks/${task.id}|${task.ref}>`);
    expect(section(msg)).toContain('New task');
    // Angle brackets and ampersands are escaped, not interpreted as markup.
    expect(section(msg)).toContain('Fix &lt;script&gt; parsing &amp; co');
    expect(section(msg)).not.toContain('<script>');

    expect(context(msg)).toBe(`Finqbit · Assignee: Roman &lt;K&gt; &amp; Co · Status: ${statusName}`);

    // The push fallback is one short line, and no URL at all.
    expect(msg.text).toBe('New task FIN-1: Fix &lt;script&gt; parsing &amp; co');
    expect(msg.text).not.toContain('http');
  });

  it('says Unassigned when nobody is on the task', async () => {
    const bare = await json(reqAs(users.owner!.cookie).post('/tasks', { projectId, title: 'Nobody yet' }));
    const msg = await built(event('task.created', { type: 'task', id: bare.id }, { projectId, ref: bare.ref }));
    expect(context(msg)).toContain('Unassigned');
  });

  it('derives the ref from the project when the event does not carry one', async () => {
    const msg = await built(event('task.created', { type: 'task', id: task.id }, { projectId }));
    expect(section(msg)).toContain(`|${task.ref}>`);
  });

  it('puts the new status in the headline and leaves it out of the context line', async () => {
    const msg = await built(taskEvent('task.status_changed', {}, users.owner!.userId));
    expect(section(msg)).toContain(`*${statusName}*`);
    expect(context(msg)).not.toContain('Status:');
    expect(msg.text).toBe(`FIN-1 moved to ${statusName}`);
  });

  it('names whoever was just assigned', async () => {
    const msg = await built(taskEvent('task.assigned', { assigneeIds: [users.member!.userId] }, users.owner!.userId));
    expect(section(msg)).toContain('assigned to *Roman &lt;K&gt; &amp; Co*');
    // The headline already names them – the context line does not repeat it.
    expect(context(msg)).not.toContain('Assignee');
    expect(msg.text).toBe('FIN-1 assigned to Roman &lt;K&gt; &amp; Co');
  });

  it('names the mentioned people instead of saying "you" to a whole channel', async () => {
    const msg = await built(event(
      'comment.mentioned',
      { type: 'comment', id: ulid() },
      { taskId: task.id, projectId, ref: task.ref, mentions: [users.member!.userId] },
      users.owner!.userId,
    ));
    expect(section(msg)).toContain('*Owner* mentioned *Roman &lt;K&gt; &amp; Co*');
    expect(section(msg)).toContain(`|${task.ref}>`);
    expect(msg.text).not.toContain('http');
  });

  it('posts a plain comment but leaves one with mentions to comment.mentioned', async () => {
    const plain = await built(event(
      'comment.created',
      { type: 'comment', id: ulid() },
      { taskId: task.id, projectId, ref: task.ref, mentions: [] },
      users.owner!.userId,
    ));
    expect(section(plain)).toContain('*Owner* commented on');

    const mentioning = await buildSlackMessage(event(
      'comment.created',
      { type: 'comment', id: ulid() },
      { taskId: task.id, projectId, ref: task.ref, mentions: [users.member!.userId] },
      users.owner!.userId,
    ));
    expect(mentioning).toBeNull();
  });

  it('announces a merged PR with the status the automation left the task in', async () => {
    const msg = await built(taskEvent('git.pr_merged'));
    expect(section(msg)).toContain('PR merged for');
    expect(context(msg)).toContain(`Status: ${statusName}`);
  });

  it('says nothing about a task that no longer exists', async () => {
    expect(await buildSlackMessage(event('task.created', { type: 'task', id: ulid() }, { projectId }))).toBeNull();
  });
});

describe('finance and CRM messages', () => {
  let invoiceId = '';
  let invoiceNumber = '';

  beforeAll(async () => {
    const owner = reqAs(users.owner!.cookie);
    const inv = await json(owner.post('/invoices', {
      companyId, currency: 'USD', issueDate: '2026-02-01', dueDate: '2026-03-01',
      items: [{ description: 'work', quantity: 1, unitPrice: 600 }],
    }));
    invoiceId = inv.id;
    invoiceNumber = (await json(owner.get(`/invoices/${invoiceId}`))).number;
  });

  it('names the client and the outstanding amount on a part payment', async () => {
    const owner = reqAs(users.owner!.cookie);
    const pay = await json(owner.post(`/invoices/${invoiceId}/payments`, {
      amount: 200, currency: 'USD', date: '2026-02-10', method: 'bank',
    }));
    const msg = await built(event('payment.recorded', { type: 'payment', id: pay.id }, { invoiceId, amount: 200, number: invoiceNumber }));
    expect(section(msg)).toContain('$200.00');
    expect(section(msg)).toContain(`/finance/invoices/${invoiceId}|${invoiceNumber}>`);
    expect(context(msg)).toBe('Finqbit &lt;Ltd&gt; &amp; Sons · Outstanding: $400.00');
  });

  it('leaves the payment that settles an invoice to invoice.paid', async () => {
    const owner = reqAs(users.owner!.cookie);
    const pay = await json(owner.post(`/invoices/${invoiceId}/payments`, {
      amount: 400, currency: 'USD', date: '2026-02-20', method: 'bank',
    }));
    expect(await buildSlackMessage(event('payment.recorded', { type: 'payment', id: pay.id }, { invoiceId, amount: 400, number: invoiceNumber }))).toBeNull();

    const paid = await built(event('invoice.paid', { type: 'invoice', id: invoiceId }, { number: invoiceNumber, companyId }));
    expect(section(paid)).toContain(`|${invoiceNumber}>`);
    expect(context(paid)).toBe('Finqbit &lt;Ltd&gt; &amp; Sons · $600.00');
    expect(paid.text).toBe(`Invoice ${invoiceNumber} was paid`);
  });

  it('reports a client decision on a quote with its total and its reason', async () => {
    const owner = reqAs(users.owner!.cookie);
    const quote = await json(owner.post('/quotes', {
      companyId, currency: 'USD', issueDate: '2026-02-01',
      items: [{ description: 'discovery', quantity: 1, unitPrice: 1500 }],
    }));
    const accepted = await built(event('quote.accepted', { type: 'quote', id: quote.id }, { ref: quote.number }));
    expect(section(accepted)).toContain('was accepted');
    expect(context(accepted)).toBe('Finqbit &lt;Ltd&gt; &amp; Sons · $1,500.00');

    const { db } = getDb();
    await db.update(schema.quotes).set({ declineComment: 'Too <expensive> & slow' }).where(eq(schema.quotes.id, quote.id));
    const declined = await built(event('quote.declined', { type: 'quote', id: quote.id }, { ref: quote.number }));
    expect(context(declined)).toContain('Reason: Too &lt;expensive&gt; &amp; slow');
  });

  it('links a won deal to the deal itself and a lost one to its reason', async () => {
    const { db } = getDb();
    const stageId = ulid();
    await db.insert(schema.dealStages).values({ id: stageId, name: 'Qualified', position: 0 });
    const dealId = ulid();
    await db.insert(schema.deals).values({
      id: dealId, companyId, stageId, title: 'Retainer <2027> & support',
      amount: '12000', currency: 'EUR', createdBy: users.owner!.userId,
    });

    const won = await built(event('deal.won', { type: 'deal', id: dealId }, { companyId, title: 'Retainer <2027> & support', amount: '12000', currency: 'EUR' }));
    expect(section(won)).toContain(`/deals/${dealId}|Retainer &lt;2027&gt; &amp; support>`);
    expect(context(won)).toContain('€12,000.00');
    expect(won.text).toBe('Deal won: Retainer &lt;2027&gt; &amp; support');

    const lost = await built(event('deal.lost', { type: 'deal', id: dealId }, { companyId, lostReason: 'Price' }));
    expect(context(lost)).toContain('Reason: Price');
  });

  it('closes a project with its key and its client', async () => {
    const msg = await built(event('project.completed', { type: 'project', id: projectId }, { key: 'FIN' }));
    expect(section(msg)).toContain(`/projects/${projectId}|Finqbit>`);
    expect(context(msg)).toBe('FIN · Finqbit &lt;Ltd&gt; &amp; Sons');
    expect(msg.projectId).toBe(projectId);
  });
});

describe('event coverage', () => {
  it('keeps the personal notification types out of a shared channel', async () => {
    const personal: [EventType, DomainEvent['aggregateType']][] = [
      ['page.mentioned', 'page'],
      ['leave.requested', 'leave_request'],
      ['leave.decided', 'leave_request'],
      ['agent.run_finished', 'agent_run'],
      ['agent.needs_input', 'agent_run'],
      ['sales.work_digest_due', 'user'],
      ['time.entry_created', 'time_entry'],
    ];
    for (const [type, aggregateType] of personal) {
      expect(await buildSlackMessage(event(type, { type: aggregateType, id: ulid() }, { projectId }))).toBeNull();
    }
  });
});

describe('delivery', () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    const { db } = getDb();
    await db.delete(schema.slackConnections);
    await db.update(schema.projects).set({ settings: {} }).where(eq(schema.projects.id, projectId));
  });

  it('sends the blocks and the fallback through the bot, with unfurling off', async () => {
    const { db } = getDb();
    await db.insert(schema.slackConnections).values({
      id: ulid(), teamId: 'T1', teamName: 'Finqbit', botToken: encrypt('xoxb-test'), scope: 'chat:write',
    });
    await db.update(schema.projects).set({ settings: { slackChannelId: 'C42' } }).where(eq(schema.projects.id, projectId));

    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    await slackConsumer.handle(taskEvent('task.created', {}, users.owner!.userId));

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://slack.com/api/chat.postMessage');
    expect(calls[0]!.body.channel).toBe('C42');
    expect(calls[0]!.body.unfurl_links).toBe(false);
    expect(calls[0]!.body.blocks[0].type).toBe('section');
    expect(calls[0]!.body.text).not.toContain('http');
  });

  it('sends the same blocks to a legacy incoming webhook', async () => {
    const { db } = getDb();
    await db.update(schema.projects).set({ settings: { slackWebhookUrl: 'https://hooks.slack.test/T/B/X' } })
      .where(eq(schema.projects.id, projectId));

    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('ok', { status: 200 });
    }));

    const ev = taskEvent('task.created', {}, users.owner!.userId);
    await slackConsumer.handle(ev);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://hooks.slack.test/T/B/X');
    expect(calls[0]!.body.unfurl_links).toBe(false);
    expect(calls[0]!.body.blocks).toEqual((await built(ev)).blocks);
  });

  it('skips an event no builder covers without calling Slack', async () => {
    // Slack is configured here, so the silence is the event and not a missing target.
    const { db } = getDb();
    await db.update(schema.projects).set({ settings: { slackWebhookUrl: 'https://hooks.slack.test/T/B/X' } })
      .where(eq(schema.projects.id, projectId));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await slackConsumer.handle(event('time.entry_created', { type: 'time_entry', id: ulid() }, { projectId }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
