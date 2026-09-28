/**
 * Sending an invoice is the action, not a status flip: no mail server or no
 * recipient refuses before anything changes, a transport failure surfaces as
 * the error it was, and a real send is recorded with the address it went to.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getDb } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json, setTestSmtp } from './helpers';
import { seedChartOfAccounts } from '../seed-baseline';

// One fake transport for the whole file; each test decides what sendMail does.
const sendMail = vi.fn(async (_msg: unknown) => ({ messageId: '<fake@ordi.test>' }));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({ sendMail, verify: async () => true }),
  },
}));

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let owner: ReturnType<typeof reqAs>;
let companyId: string;
let mutedCompanyId: string;

async function newInvoice(company = companyId): Promise<string> {
  const { id } = await json(owner.post('/invoices', {
    companyId: company, issueDate: '2026-09-28', dueDate: '2026-09-30', language: 'uk',
    items: [{ description: 'Finqbit page changes', quantity: 2, unitPrice: 17 }],
  }));
  return id;
}

beforeAll(async () => {
  await resetDb();
  await seedChartOfAccounts(getDb().db);
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  companyId = (await json(owner.post('/companies', { name: 'Appricotsoft', status: 'active', billingEmail: 'billing@appricotsoft.test' }))).id;
  mutedCompanyId = (await json(owner.post('/companies', { name: 'No Mail Ltd', status: 'active' }))).id;
  await owner.patch('/settings/workspace', { name: 'kdn.agency' });
  await setTestSmtp(false);
});

afterAll(async () => { await setTestSmtp(false); });

describe('before mail is configured', () => {
  it('the preview says so and still names the recipient, subject and attachment', async () => {
    const id = await newInvoice();
    const preview = await json(owner.get(`/invoices/${id}/send-preview`));
    expect(preview.mailConfigured).toBe(false);
    expect(preview.from).toBeNull();
    expect(preview.to).toBe('billing@appricotsoft.test');
    expect(preview.subject).toMatch(/^Рахунок INV-.* від kdn\.agency$/);
    expect(preview.body).toContain('34.00');
    expect(preview.attachment).toMatch(/^INV-.*\.pdf$/);
    expect(preview.link).toContain('/i/');
    expect(preview.canSend).toBe(true);
  });

  it('sending is refused and the invoice stays a draft', async () => {
    const id = await newInvoice();
    const res = await owner.post(`/invoices/${id}/send`, {});
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.code).toBe('domain_rule');
    expect(body.error.details.code).toBe('email_not_configured');
    const inv = await json(owner.get(`/invoices/${id}`));
    expect(inv.status).toBe('draft');
    expect(inv.sentAt).toBeNull();
    expect(inv.sends).toEqual([]);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('with mail configured', () => {
  beforeAll(async () => {
    const res = await owner.patch('/settings/integrations-config', {
      smtp: { host: 'smtp.test.local', port: 587, secure: false, user: 'ordi', pass: 'secret', from: 'ordi <billing@kdn.test>' },
    });
    expect(res.status).toBe(200);
    sendMail.mockClear();
  });

  it('the preview shows the sender address', async () => {
    const id = await newInvoice();
    const preview = await json(owner.get(`/invoices/${id}/send-preview`));
    expect(preview.mailConfigured).toBe(true);
    expect(preview.from).toBe('ordi <billing@kdn.test>');
  });

  it('a company without a billing email needs an explicit address', async () => {
    const id = await newInvoice(mutedCompanyId);
    const preview = await json(owner.get(`/invoices/${id}/send-preview`));
    expect(preview.to).toBeNull();
    const res = await owner.post(`/invoices/${id}/send`, {});
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe('validation_error');
    expect((await json(owner.get(`/invoices/${id}`))).status).toBe('draft');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('a real send mails the address, attaches the PDF, marks the invoice sent and records where it went', async () => {
    const id = await newInvoice();
    const res = await owner.post(`/invoices/${id}/send`, { to: 'cfo@appricotsoft.test', subject: 'Рахунок за вересень' });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe('sent');
    expect(body.delivery).toMatchObject({ to: 'cfo@appricotsoft.test', subject: 'Рахунок за вересень' });
    expect(body.sends).toHaveLength(1);
    expect(body.sends[0].to).toBe('cfo@appricotsoft.test');

    expect(sendMail).toHaveBeenCalledTimes(1);
    const msg = sendMail.mock.calls[0]![0] as { from: string; to: string; subject: string; attachments: { filename: string; content: Buffer; contentType: string }[]; html: string };
    expect(msg.from).toBe('ordi <billing@kdn.test>');
    expect(msg.to).toBe('cfo@appricotsoft.test');
    expect(msg.subject).toBe('Рахунок за вересень');
    expect(msg.attachments[0]!.filename).toMatch(/^INV-.*\.pdf$/);
    expect(msg.attachments[0]!.content.subarray(0, 5).toString()).toBe('%PDF-');
    expect(msg.html).toContain(`/i/${body.publicToken}`);

    // A second send (a reminder to another person) is a second recorded send, not a status change.
    sendMail.mockClear();
    const again = await json(owner.post(`/invoices/${id}/send`, { to: 'ceo@appricotsoft.test' }));
    expect(again.status).toBe('sent');
    expect(again.sends.map((s: { to: string }) => s.to)).toEqual(['ceo@appricotsoft.test', 'cfo@appricotsoft.test']);
  });

  it('a transport failure is reported as the error it was and changes nothing', async () => {
    const id = await newInvoice();
    sendMail.mockClear();
    sendMail.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:587'), { code: 'ECONNREFUSED' }));
    const res = await owner.post(`/invoices/${id}/send`, {});
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.message).toContain('ECONNREFUSED');
    expect(body.error.details.code).toBe('ECONNREFUSED');
    const inv = await json(owner.get(`/invoices/${id}`));
    expect(inv.status).toBe('draft');
    expect(inv.sends).toEqual([]);
  });

  it('quotes follow the same rules', async () => {
    const { id } = await json(owner.post('/quotes', { companyId: mutedCompanyId, issueDate: '2026-09-28', items: [{ description: 'x', quantity: 1, unitPrice: 1 }] }));
    expect((await owner.post(`/quotes/${id}/send`, {})).status).toBe(400);
    sendMail.mockClear();
    const sent = await json(owner.post(`/quotes/${id}/send`, { to: 'buyer@nomail.test' }));
    expect(sent.status).toBe('sent');
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
