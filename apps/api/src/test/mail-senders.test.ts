/**
 * Mail senders (Settings → Email): the workspace keeps several From addresses,
 * one carries system mail and one is the default for invoices and quotes. A
 * Send dialog can pick any of them, the choice is recorded with the send, and
 * payment reminders follow up from the address the invoice went out from.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getDb, schema, eq, ne } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json, setTestSmtp } from './helpers';
import { seedChartOfAccounts } from '../seed-baseline';
import { runReminders } from '../workers/scheduled';
import { processEmailDeliveries } from '../workers/email-delivery';

const sendMail = vi.fn(async (_msg: unknown) => ({ messageId: '<fake@ordi.test>' }));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail, verify: async () => true }) },
}));

type Msg = { from: string; replyTo?: string; to: string; subject: string };
const lastMsg = () => sendMail.mock.calls.at(-1)![0] as Msg;

let owner: ReturnType<typeof reqAs>;
let member: ReturnType<typeof reqAs>;
let companyId: string;
let financeId: string;

const finance = {
  name: 'Finance', from: 'kdn.agency <invoices@kdn.test>', replyTo: 'accountant@kdn.test',
  host: 'smtp.finance.test', port: 465, secure: true, user: 'invoices@kdn.test', pass: 'finance-secret',
};

async function newInvoice(dueDate = '2026-09-30'): Promise<string> {
  const { id } = await json(owner.post('/invoices', {
    companyId, issueDate: '2026-09-01', dueDate, language: 'en',
    items: [{ description: 'Design', quantity: 1, unitPrice: 100 }],
  }));
  return id;
}

beforeAll(async () => {
  await resetDb();
  await seedChartOfAccounts(getDb().db);
  const users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  member = reqAs(users.member!.cookie);
  companyId = (await json(owner.post('/companies', { name: 'Globex', status: 'active', billingEmail: 'billing@globex.test' }))).id;
  // The pre-senders single SMTP setting, as an existing install has it.
  await setTestSmtp(true);
});

afterAll(async () => { await setTestSmtp(false); });

describe('senders', () => {
  it('an existing SMTP setting shows up as the sender that carries everything', async () => {
    const res = await json(owner.get('/settings/mail-senders'));
    expect(res.senders).toHaveLength(1);
    expect(res.senders[0]).toMatchObject({ id: 'smtp', name: 'Default', from: 'ordi <test@ordi.local>', source: 'db' });
    expect(res.systemSenderId).toBe('smtp');
    expect(res.invoiceSenderId).toBe('smtp');
  });

  it('only settings managers see or change senders', async () => {
    expect((await member.get('/settings/mail-senders')).status).toBe(403);
    expect((await member.post('/settings/mail-senders', finance)).status).toBe(403);
  });

  it('a new sender never hands its password back', async () => {
    const res = await owner.post('/settings/mail-senders', finance);
    expect(res.status).toBe(201);
    const created = await json(res);
    financeId = created.id;
    expect(created).toMatchObject({ name: 'Finance', from: finance.from, replyTo: finance.replyTo, hasPassword: true, port: 465, secure: true });
    const listed = await json(owner.get('/settings/mail-senders'));
    expect(JSON.stringify(listed)).not.toContain('finance-secret');
    // Stored encrypted, not as typed.
    const [ws] = await getDb().db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.id, 'workspace'));
    expect(JSON.stringify(ws!.integrations)).not.toContain('finance-secret');
  });

  it('editing without a password keeps the stored one', async () => {
    const res = await json(owner.patch(`/settings/mail-senders/${financeId}`, { name: 'Finance team' }));
    expect(res).toMatchObject({ name: 'Finance team', hasPassword: true });
  });

  it('roles must name a sender that exists', async () => {
    expect((await owner.put('/settings/mail-senders/roles', { invoices: 'nope' })).status).toBe(400);
    const roles = await json(owner.put('/settings/mail-senders/roles', { invoices: financeId }));
    expect(roles).toEqual({ systemSenderId: 'smtp', invoiceSenderId: financeId });
  });

  it('a test email goes out from the sender being tested', async () => {
    sendMail.mockClear();
    const res = await json(owner.post(`/settings/mail-senders/${financeId}/test`));
    expect(res.sent).toBe(true);
    expect(lastMsg()).toMatchObject({ from: finance.from, replyTo: finance.replyTo, to: 'owner@test.local' });
  });

  it('system mail still goes out from the system sender', async () => {
    sendMail.mockClear();
    const res = await json(owner.post('/settings/email/test'));
    expect(res.sent).toBe(true);
    expect(lastMsg().from).toBe('ordi <test@ordi.local>');
    expect(lastMsg().replyTo).toBeUndefined();
  });
});

describe('sending invoices', () => {
  it('the dialog offers every sender and preselects the invoice default', async () => {
    const id = await newInvoice();
    const preview = await json(owner.get(`/invoices/${id}/send-preview`));
    expect(preview.senderId).toBe(financeId);
    expect(preview.from).toBe(finance.from);
    expect(preview.senders.map((s: { id: string }) => s.id)).toEqual(['smtp', financeId]);
    expect(JSON.stringify(preview.senders)).not.toContain('secret');
  });

  it('without a choice the invoice goes out from the invoice default, and the send records it', async () => {
    const id = await newInvoice();
    sendMail.mockClear();
    const sent = await json(owner.post(`/invoices/${id}/send`, {}));
    expect(sent.delivery.from).toBe(finance.from);
    expect(lastMsg()).toMatchObject({ from: finance.from, replyTo: finance.replyTo, to: 'billing@globex.test' });
    expect(sent.sends[0]).toMatchObject({ to: 'billing@globex.test', from: finance.from });
  });

  it('a sender picked in the dialog wins', async () => {
    const id = await newInvoice();
    sendMail.mockClear();
    const sent = await json(owner.post(`/invoices/${id}/send`, { senderId: 'smtp' }));
    expect(lastMsg().from).toBe('ordi <test@ordi.local>');
    expect(sent.sends[0].from).toBe('ordi <test@ordi.local>');
  });

  it('an unknown sender is refused and nothing is sent', async () => {
    const id = await newInvoice();
    sendMail.mockClear();
    const res = await owner.post(`/invoices/${id}/send`, { senderId: 'gone' });
    expect(res.status).toBe(400);
    expect(sendMail).not.toHaveBeenCalled();
    expect((await json(owner.get(`/invoices/${id}`))).status).toBe('draft');
  });

  it('quotes take the same choice', async () => {
    const { id } = await json(owner.post('/quotes', { companyId, issueDate: '2026-09-01', items: [{ description: 'x', quantity: 1, unitPrice: 1 }] }));
    sendMail.mockClear();
    await json(owner.post(`/quotes/${id}/send`, { senderId: financeId }));
    expect(lastMsg().from).toBe(finance.from);
  });
});

describe('payment reminders', () => {
  it('follow up from the address the invoice was sent from', async () => {
    const { db } = getDb();
    await db.delete(schema.emailDeliveries);
    expect((await owner.post('/reminder-rules', { offsetDays: 0, active: true })).status).toBe(201);
    const id = await newInvoice('2026-01-15');
    await json(owner.post(`/invoices/${id}/send`, { senderId: 'smtp' }));

    await runReminders();
    // Every open invoice past its due date gets one; this one went out via "smtp".
    const queued = await db.select().from(schema.emailDeliveries);
    expect(queued.find((d) => d.idempotencyKey.startsWith(`invoice-reminder:${id}:`))!.senderId).toBe('smtp');
    // One sent earlier without a choice follows up from the invoice default, Finance.
    expect(queued.some((d) => d.senderId === financeId)).toBe(true);
    await db.delete(schema.emailDeliveries).where(ne(schema.emailDeliveries.senderId, 'smtp'));

    sendMail.mockClear();
    const result = await processEmailDeliveries();
    expect(result.sent).toBeGreaterThanOrEqual(1);
    expect(lastMsg().from).toBe('ordi <test@ordi.local>');
  });
});

describe('deleting a sender', () => {
  it('the env sender cannot be deleted, and a deleted role holder falls back to the default', async () => {
    expect((await owner.del('/settings/mail-senders/env')).status).toBe(400);
    expect((await owner.del(`/settings/mail-senders/${financeId}`)).status).toBe(200);
    const res = await json(owner.get('/settings/mail-senders'));
    expect(res.senders.map((s: { id: string }) => s.id)).toEqual(['smtp']);
    expect(res.invoiceSenderId).toBe('smtp');
    expect((await owner.del(`/settings/mail-senders/${financeId}`)).status).toBe(404);
  });
});
