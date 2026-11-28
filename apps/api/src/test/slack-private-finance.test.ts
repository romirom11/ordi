/**
 * Deals and invoices are workspace news and go to the workspace webhook – but
 * one tied to a private project follows that project's Slack rule (#202): its
 * own channel or webhook, or nothing. The project is read at delivery, from
 * the deal or invoice as it is then. An invoice from time across several
 * projects is filed under none: the projects its time entries now belong to
 * decide. One private project among them: its own target or nothing. Several:
 * nothing.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb, schema, eq, and, inArray, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { drainOutbox } from './agents-helpers';
import { encrypt } from '../lib/crypto';
import { seedChartOfAccounts } from '../seed-baseline';

const WORKSPACE_HOOK = 'https://hooks.slack.com/services/T000/B000/workspace';
const OWN_HOOK = 'https://hooks.slack.com/services/T000/B000/own-project';
const OTHER_HOOK = 'https://hooks.slack.com/services/T000/B000/other-project';
const CHAT_POST = 'https://slack.com/api/chat.postMessage';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let companyId: string;
let typeId: string;
let openStageId: string;
let wonStageId: string;
let lostStageId: string;
let posts: { url: string; body: { text?: string; channel?: string } }[] = [];

const owner = () => reqAs(users.owner!.cookie);

async function setWorkspaceHook(url: string | null) {
  const { db } = getDb();
  const [ws] = await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.id, 'workspace'));
  const integrations = { ...((ws?.integrations as Record<string, unknown>) ?? {}) };
  if (url) integrations.slackWebhookUrl = url;
  else delete integrations.slackWebhookUrl;
  if (ws) await db.update(schema.workspaceSettings).set({ integrations }).where(eq(schema.workspaceSettings.id, 'workspace'));
  else await db.insert(schema.workspaceSettings).values({ id: 'workspace', integrations });
}

let keySeq = 0;
/** SFA, SFB, … SFAA: project keys are letters only. */
function nextKey(): string {
  keySeq += 1;
  let n = keySeq;
  let suffix = '';
  while (n > 0) { n -= 1; suffix = String.fromCharCode(65 + (n % 26)) + suffix; n = Math.floor(n / 26); }
  return `SF${suffix}`;
}

async function project(visibility: 'workspace' | 'private', settings: Record<string, unknown> = {}): Promise<string> {
  const key = nextKey();
  const res = await owner().post('/projects', { name: `Billing ${visibility} ${key}`, key, projectTypeId: typeId, visibility, companyId });
  expect(res.status).toBe(201);
  const p = await json(res);
  if (Object.keys(settings).length) {
    await getDb().db.update(schema.projects).set({ settings }).where(eq(schema.projects.id, p.id));
  }
  return p.id;
}

/** A sent invoice of 100, filed under `projectId` (or none). */
async function invoice(projectId: string | null): Promise<string> {
  const res = await owner().post('/invoices', {
    companyId, projectId, issueDate: '2026-10-01', dueDate: '2026-10-31', language: 'en',
    items: [{ description: 'Work', quantity: 1, unitPrice: 100 }],
  });
  expect(res.status).toBe(201);
  return (await json(res)).id;
}

/** An invoice from an hour of billable time on a task in each of the projects. */
async function invoiceFromTime(projectIds: string[]): Promise<{ id: string; taskIds: string[] }> {
  const { db } = getDb();
  const taskIds: string[] = [];
  for (const projectId of projectIds) {
    const res = await owner().post('/tasks', { projectId, title: 'Billable work' });
    expect(res.status).toBe(201);
    const taskId = (await json(res)).id;
    taskIds.push(taskId);
    await db.insert(schema.timeEntries).values({
      id: ulid(), taskId, userId: users.owner!.userId, projectId,
      startedAt: new Date('2026-10-05T10:00:00Z'), durationSeconds: 3600, billable: true, hourlyRate: '50',
    });
  }
  const res = await owner().post('/invoices/from-time', { companyId, from: '2026-10-01', to: '2026-10-31', projectIds });
  expect(res.status).toBe(201);
  const { id } = await json(res);
  const [row] = await db.select({ projectId: schema.invoices.projectId }).from(schema.invoices).where(eq(schema.invoices.id, id));
  if (projectIds.length > 1) expect(row!.projectId).toBeNull();
  return { id, taskIds };
}

async function pay(invoiceId: string) {
  const inv = await json(owner().get(`/invoices/${invoiceId}`));
  const res = await owner().post(`/invoices/${invoiceId}/payments`, { amount: Number(inv.total), currency: 'USD', date: '2026-10-10' });
  expect(res.status).toBe(201);
}

async function deal(projectId: string | null): Promise<string> {
  const res = await owner().post('/deals', { companyId, projectId, title: 'Secret retainer', stageId: openStageId, amount: 5000 });
  expect(res.status).toBe(201);
  return (await json(res)).id;
}

async function move(dealId: string, stageId: string) {
  const res = await owner().post(`/deals/${dealId}/move`, { stageId, lostReason: 'Budget' });
  expect(res.status).toBe(200);
}

/**
 * Deliver what is queued, and check that Slack handled every deal and invoice
 * event without throwing: a handler that failed posts nothing too, but leaves
 * the event for a retry instead of deciding to stay quiet.
 */
async function deliver() {
  await drainOutbox();
  const { db } = getDb();
  const events = await db.select({ id: schema.events.id }).from(schema.events)
    .where(inArray(schema.events.type, ['invoice.paid', 'deal.won', 'deal.lost']));
  const handled = await db.select({ eventId: schema.processedEvents.eventId }).from(schema.processedEvents)
    .where(and(eq(schema.processedEvents.consumer, 'slack'), inArray(schema.processedEvents.eventId, events.map((e) => e.id))));
  expect(handled.length).toBe(events.length);
}

/** Run what is queued, then forget what it posted: the next step's posts are the ones asserted. */
async function settle() {
  await drainOutbox();
  posts = [];
}

const urls = () => posts.map((p) => p.url);

async function connectBot() {
  await getDb().db.insert(schema.slackConnections).values({
    id: ulid(), teamId: 'T000', teamName: 'Test', botToken: encrypt('xoxb-test-token'), scope: 'chat:write',
  });
}

beforeAll(async () => {
  await resetDb();
  const { db } = getDb();
  await seedChartOfAccounts(db);
  users = await seedRolesAndUsers();
  companyId = (await json(owner().post('/companies', { name: 'Acme', status: 'active' }))).id;
  typeId = ulid();
  await db.insert(schema.projectTypes).values({ id: typeId, name: 'Client work', revenueSource: 'client_billing' });
  openStageId = ulid(); wonStageId = ulid(); lostStageId = ulid();
  await db.insert(schema.dealStages).values([
    { id: openStageId, name: 'Qualified', position: 0 },
    { id: wonStageId, name: 'Won', position: 1, isWon: true },
    { id: lostStageId, name: 'Lost', position: 2, isLost: true },
  ]);
  await setWorkspaceHook(WORKSPACE_HOOK);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    posts.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : {} });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});

beforeEach(async () => {
  await getDb().db.delete(schema.slackConnections);
  await settle();
});

afterAll(async () => {
  // workspace_settings outlives resetDb(): leave no shared channel behind.
  await setWorkspaceHook(null);
  await getDb().db.delete(schema.slackConnections);
  vi.unstubAllGlobals();
});

describe('invoice.paid for an invoice filed under one project', () => {
  it('a private project with no target of its own posts nothing', async () => {
    const id = await invoice(await project('private'));
    await settle();
    await pay(id);
    await deliver();
    expect(posts).toEqual([]);
  });

  it('a private project with its own webhook posts there', async () => {
    const id = await invoice(await project('private', { slackWebhookUrl: OWN_HOOK }));
    await settle();
    await pay(id);
    await deliver();
    expect(urls()).toEqual([OWN_HOOK]);
    expect(posts[0]!.body.text).toContain('was paid');
  });

  it('a private project with a channel posts there through the bot', async () => {
    await connectBot();
    const id = await invoice(await project('private', { slackChannelId: 'C0PRIVATE' }));
    await settle();
    await pay(id);
    await deliver();
    expect(urls()).toEqual([CHAT_POST]);
    expect(posts[0]!.body.channel).toBe('C0PRIVATE');
  });

  it('a private project with a channel but no bot token posts nothing', async () => {
    const id = await invoice(await project('private', { slackChannelId: 'C0PRIVATE' }));
    await settle();
    await pay(id);
    await deliver();
    expect(posts).toEqual([]);
  });

  it('a public project still uses the workspace webhook', async () => {
    const id = await invoice(await project('workspace'));
    await settle();
    await pay(id);
    await deliver();
    expect(urls()).toEqual([WORKSPACE_HOOK]);
  });

  it('a public project with its own webhook still uses the workspace webhook, as before', async () => {
    const id = await invoice(await project('workspace', { slackWebhookUrl: OWN_HOOK }));
    await settle();
    await pay(id);
    await deliver();
    expect(urls()).toEqual([WORKSPACE_HOOK]);
  });

  it('an invoice with no project still uses the workspace webhook', async () => {
    const id = await invoice(null);
    await settle();
    await pay(id);
    await deliver();
    expect(urls()).toEqual([WORKSPACE_HOOK]);
  });

  it('paid in full by a credit note follows the same rule', async () => {
    const id = await invoice(await project('private'));
    await settle();
    const res = await owner().post(`/invoices/${id}/credit-notes`, { amount: 100, reason: 'goodwill', date: '2026-10-02' });
    expect(res.status).toBe(201);
    await deliver();
    expect(posts).toEqual([]);
  });
});

describe('invoice.paid reads the invoice and its project at delivery', () => {
  it('a project made private before delivery posts nothing to the workspace', async () => {
    const projectId = await project('workspace');
    const id = await invoice(projectId);
    await settle();
    await pay(id);
    await getDb().db.update(schema.projects).set({ visibility: 'private' }).where(eq(schema.projects.id, projectId));
    await deliver();
    expect(posts).toEqual([]);
  });

  it('an invoice moved to a private project before delivery posts nothing to the workspace', async () => {
    const id = await invoice(await project('workspace'));
    await settle();
    await pay(id);
    const privateId = await project('private');
    await getDb().db.update(schema.invoices).set({ projectId: privateId }).where(eq(schema.invoices.id, id));
    await deliver();
    expect(posts).toEqual([]);
  });

  it('an invoice deleted before delivery posts nothing', async () => {
    const id = await invoice(await project('workspace'));
    await settle();
    await pay(id);
    await getDb().db.update(schema.invoices).set({ deletedAt: new Date() }).where(eq(schema.invoices.id, id));
    await deliver();
    expect(posts).toEqual([]);
  });

  it('a private project deleted before delivery posts nothing, even with its own webhook', async () => {
    const projectId = await project('private', { slackWebhookUrl: OWN_HOOK });
    const { id } = await invoiceFromTime([projectId, await project('workspace')]);
    await settle();
    await pay(id);
    await getDb().db.update(schema.projects).set({ deletedAt: new Date() }).where(eq(schema.projects.id, projectId));
    await deliver();
    expect(posts).toEqual([]);
  });

  it('time billed under a public project and moved with its task into a private one before delivery posts nothing', async () => {
    const publicId = await project('workspace');
    const { id, taskIds } = await invoiceFromTime([publicId]);
    await settle();
    await pay(id);
    const privateId = await project('private');
    expect((await owner().post(`/tasks/${taskIds[0]}/move`, { targetProjectId: privateId })).status).toBe(200);
    await deliver();
    expect(posts.filter((p) => p.body.text?.includes('was paid'))).toEqual([]);
    // The move itself announces the task in the private project: nowhere, it has no target.
    expect(urls()).not.toContain(WORKSPACE_HOOK);
  });
});

describe('invoice.paid for an invoice from time across several projects', () => {
  it('all public: the workspace webhook', async () => {
    const { id } = await invoiceFromTime([await project('workspace'), await project('workspace')]);
    await settle();
    await pay(id);
    await deliver();
    expect(urls()).toEqual([WORKSPACE_HOOK]);
  });

  it('one private with no target of its own: nothing, though the others are public', async () => {
    const { id } = await invoiceFromTime([await project('workspace'), await project('private')]);
    await settle();
    await pay(id);
    await deliver();
    expect(posts).toEqual([]);
  });

  it('one private with its own webhook: only there', async () => {
    const { id } = await invoiceFromTime([
      await project('workspace', { slackWebhookUrl: OTHER_HOOK }),
      await project('private', { slackWebhookUrl: OWN_HOOK }),
    ]);
    await settle();
    await pay(id);
    await deliver();
    expect(urls()).toEqual([OWN_HOOK]);
  });

  it('several private, each with its own webhook: nothing', async () => {
    const { id } = await invoiceFromTime([
      await project('private', { slackWebhookUrl: OWN_HOOK }),
      await project('private', { slackWebhookUrl: OTHER_HOOK }),
    ]);
    await settle();
    await pay(id);
    await deliver();
    expect(posts).toEqual([]);
  });
});

describe.each([
  { name: 'deal.won', stage: () => wonStageId, text: 'Deal won' },
  { name: 'deal.lost', stage: () => lostStageId, text: 'Deal lost' },
])('$name', ({ stage, text }) => {
  it('for a private project with no target of its own posts nothing', async () => {
    const id = await deal(await project('private'));
    await settle();
    await move(id, stage());
    await deliver();
    expect(posts).toEqual([]);
  });

  it('for a private project with its own webhook posts there', async () => {
    const id = await deal(await project('private', { slackWebhookUrl: OWN_HOOK }));
    await settle();
    await move(id, stage());
    await deliver();
    expect(urls()).toEqual([OWN_HOOK]);
    expect(posts[0]!.body.text).toContain(text);
  });

  it('for a public project uses the workspace webhook', async () => {
    const id = await deal(await project('workspace'));
    await settle();
    await move(id, stage());
    await deliver();
    expect(urls()).toEqual([WORKSPACE_HOOK]);
  });

  it('with no project uses the workspace webhook', async () => {
    const id = await deal(null);
    await settle();
    await move(id, stage());
    await deliver();
    expect(urls()).toEqual([WORKSPACE_HOOK]);
    expect(posts[0]!.body.text).toContain('Secret retainer');
  });

  it('moved to a private project before delivery posts nothing to the workspace', async () => {
    const id = await deal(await project('workspace'));
    await settle();
    await move(id, stage());
    const privateId = await project('private');
    await getDb().db.update(schema.deals).set({ projectId: privateId }).where(eq(schema.deals.id, id));
    await deliver();
    expect(posts).toEqual([]);
  });

  it('deleted before delivery posts nothing', async () => {
    const id = await deal(null);
    await settle();
    await move(id, stage());
    await getDb().db.update(schema.deals).set({ deletedAt: new Date() }).where(eq(schema.deals.id, id));
    await deliver();
    expect(posts).toEqual([]);
  });
});

describe('invoice.paid for an invoice from a quote', () => {
  async function fromQuote(projectId: string): Promise<string> {
    const quote = await owner().post('/quotes', {
      companyId, projectId, issueDate: '2026-10-01', language: 'en', currency: 'USD',
      items: [{ description: 'Work', quantity: 1, unitPrice: 100 }],
    });
    expect(quote.status).toBe(201);
    // Linked to the quote, but filed under no project.
    const res = await owner().post('/invoices', {
      companyId, quoteId: (await json(quote)).id, issueDate: '2026-10-01', dueDate: '2026-10-31', language: 'en',
      items: [{ description: 'Work', quantity: 1, unitPrice: 100 }],
    });
    expect(res.status).toBe(201);
    return (await json(res)).id;
  }

  it('of a private project with no target of its own posts nothing', async () => {
    const id = await fromQuote(await project('private'));
    await settle();
    await pay(id);
    await deliver();
    expect(posts).toEqual([]);
  });

  it('of a private project with its own webhook posts there', async () => {
    const id = await fromQuote(await project('private', { slackWebhookUrl: OWN_HOOK }));
    await settle();
    await pay(id);
    await deliver();
    expect(urls()).toEqual([OWN_HOOK]);
  });

  it('of a public project uses the workspace webhook', async () => {
    const id = await fromQuote(await project('workspace'));
    await settle();
    await pay(id);
    await deliver();
    expect(urls()).toEqual([WORKSPACE_HOOK]);
  });
});

describe('an invoice from time whose time entries are no longer linked', () => {
  it('cancelled, then settled by a credit note, still knows its private project: nothing', async () => {
    const { id } = await invoiceFromTime([await project('workspace'), await project('private')]);
    expect((await owner().post(`/invoices/${id}/cancel`)).status).toBe(200);
    await settle();
    const res = await owner().post(`/invoices/${id}/credit-notes`, { amount: 100, reason: 'write-off', date: '2026-10-02' });
    expect(res.status).toBe(201);
    await deliver();
    expect(posts).toEqual([]);
  });

  it('cancelled, then settled by a credit note, across public projects: the workspace webhook', async () => {
    const { id } = await invoiceFromTime([await project('workspace'), await project('workspace')]);
    expect((await owner().post(`/invoices/${id}/cancel`)).status).toBe(200);
    await settle();
    expect((await owner().post(`/invoices/${id}/credit-notes`, { amount: 100, reason: 'write-off', date: '2026-10-02' })).status).toBe(201);
    await deliver();
    expect(urls()).toEqual([WORKSPACE_HOOK]);
  });

  it('with its lines edited and filed under a public project, still knows its private project: nothing', async () => {
    const publicId = await project('workspace');
    const { id } = await invoiceFromTime([publicId, await project('private')]);
    const inv = await json(owner().get(`/invoices/${id}`));
    const edit = await owner().patch(`/invoices/${id}`, {
      version: inv.version, projectId: publicId, items: [{ description: 'All the time', quantity: 2, unitPrice: 50 }],
    });
    expect(edit.status).toBe(200);
    await settle();
    await pay(id);
    await deliver();
    expect(posts).toEqual([]);
    // Nothing about where its time came from is handed out with the invoice.
    expect(JSON.stringify(await json(owner().get(`/invoices/${id}`)))).not.toContain('sourceProject');
  });

  it('with its lines edited across public projects: the workspace webhook', async () => {
    const { id } = await invoiceFromTime([await project('workspace'), await project('workspace')]);
    const inv = await json(owner().get(`/invoices/${id}`));
    const edit = await owner().patch(`/invoices/${id}`, { version: inv.version, items: [{ description: 'All the time', quantity: 2, unitPrice: 50 }] });
    expect(edit.status).toBe(200);
    await settle();
    await pay(id);
    await deliver();
    expect(urls()).toEqual([WORKSPACE_HOOK]);
  });

  it('duplicated, the copy keeps its private project: nothing', async () => {
    const { id } = await invoiceFromTime([await project('workspace'), await project('private')]);
    const copy = await owner().post(`/invoices/${id}/duplicate`);
    expect(copy.status).toBe(201);
    const copyId = (await json(copy)).id;
    await settle();
    await pay(copyId);
    await deliver();
    expect(posts).toEqual([]);
  });

  it('with no source recorded and no entries left (from before sources were kept): nothing, whatever it is filed under', async () => {
    const publicId = await project('workspace');
    const { id } = await invoiceFromTime([publicId]);
    const { db } = getDb();
    await db.delete(schema.invoiceSourceProjects).where(eq(schema.invoiceSourceProjects.invoiceId, id));
    expect((await owner().post(`/invoices/${id}/cancel`)).status).toBe(200);
    await settle();
    expect((await owner().post(`/invoices/${id}/credit-notes`, { amount: 50, reason: 'write-off', date: '2026-10-02' })).status).toBe(201);
    await deliver();
    expect(posts).toEqual([]);
  });
});

describe('a deal.lost still queued when the deal is reopened', () => {
  it('shows the reason on the deal now, not the one queued with the event', async () => {
    const id = await deal(await project('private'));
    await settle();
    await move(id, lostStageId);
    // Reopened (which clears the reason) and moved to a public project before delivery.
    await move(id, openStageId);
    await getDb().db.update(schema.deals).set({ projectId: await project('workspace') }).where(eq(schema.deals.id, id));
    await deliver();
    const lost = posts.find((p) => p.body.text?.includes('Deal lost'));
    expect(lost?.url).toBe(WORKSPACE_HOOK);
    expect(lost!.body.text).not.toContain('Budget');
  });
});

describe('the migration that starts recording sources', () => {
  it('backfills them from the entries still linked and the project an invoice is filed under', async () => {
    const { db } = getDb();
    const privateId = await project('private');
    const publicId = await project('workspace');
    const multi = await invoiceFromTime([publicId, privateId]);
    const single = await invoiceFromTime([await project('workspace')]);
    const [singleRow] = await db.select({ projectId: schema.invoices.projectId }).from(schema.invoices).where(eq(schema.invoices.id, single.id));
    // As they were before: nothing recorded, and the single one's entries unlinked.
    await db.delete(schema.invoiceSourceProjects).where(inArray(schema.invoiceSourceProjects.invoiceId, [multi.id, single.id]));
    await db.update(schema.timeEntries).set({ invoiceItemId: null }).where(inArray(schema.timeEntries.taskId, single.taskIds));
    const migration = readFileSync(fileURLToPath(new URL('../../../../packages/db/drizzle/0056_invoice_source_projects.sql', import.meta.url)), 'utf8');
    const backfill = migration.split('--> statement-breakpoint').map((part) => part.trim()).find((part) => part.includes('INSERT INTO'));
    expect(backfill).toBeDefined();
    await db.execute(sql.raw(backfill!));
    const recorded = async (invoiceId: string) => (await db.select({ projectId: schema.invoiceSourceProjects.projectId })
      .from(schema.invoiceSourceProjects).where(eq(schema.invoiceSourceProjects.invoiceId, invoiceId))).map((r) => r.projectId).sort();
    expect(await recorded(multi.id)).toEqual([publicId, privateId].sort());
    expect(await recorded(single.id)).toEqual([singleRow!.projectId]);
  });
});
