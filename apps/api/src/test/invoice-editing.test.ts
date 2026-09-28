/**
 * Editing an invoice after it exists: dates, tax and discount stay editable,
 * items lock once sent, a due date is optional (an undated invoice is open
 * but never overdue), and the tax row carries the rate's name.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getDb } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json, setTestSmtp } from './helpers';
import { seedChartOfAccounts } from '../seed-baseline';
import { renderInvoicePdf } from '../domains/finance/pdf';

vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: async () => ({ messageId: '<edit@ordi.test>' }), verify: async () => true }) },
}));

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let owner: ReturnType<typeof reqAs>;
let companyId: string;
let vatId: string;

beforeAll(async () => {
  await resetDb();
  await seedChartOfAccounts(getDb().db);
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  companyId = (await json(owner.post('/companies', { name: 'Appricotsoft', status: 'active', billingEmail: 'billing@appricotsoft.test' }))).id;
  vatId = (await json(owner.post('/tax-rates', { name: 'VAT', ratePercent: 20 }))).id;
  await setTestSmtp(true);
});

afterAll(async () => { await setTestSmtp(false); });

describe('due date is optional', () => {
  it('an invoice created without one stores null and is never overdue', async () => {
    const { id } = await json(owner.post('/invoices', {
      companyId, issueDate: '2020-01-01', items: [{ description: 'x', quantity: 1, unitPrice: 10 }],
    }));
    const inv = await json(owner.get(`/invoices/${id}`));
    expect(inv.dueDate).toBeNull();
    expect(inv.is_overdue).toBe(false);
  });

  it('the finance dashboard copes with an open undated invoice', async () => {
    const { id } = await json(owner.post('/invoices', {
      companyId, issueDate: '2020-01-01', items: [{ description: 'x', quantity: 1, unitPrice: 40 }],
    }));
    expect((await owner.post(`/invoices/${id}/send`, {})).status).toBe(200);
    const dash = await json(owner.get('/finance/dashboard'));
    // Counted as receivable, absent from overdue and from the expected-payments calendar.
    expect(dash.receivables.total.USD).toBeGreaterThanOrEqual(40);
    expect(dash.overdue.find((r: { id: string }) => r.id === id)).toBeUndefined();
    expect(dash.expectedPayments.find((r: { dueDate: string | null }) => r.dueDate == null)).toBeUndefined();
  });

  it('a due date can be set and cleared again on an existing invoice', async () => {
    const { id } = await json(owner.post('/invoices', {
      companyId, issueDate: '2026-09-01', items: [{ description: 'x', quantity: 1, unitPrice: 10 }],
    }));
    let inv = await json(owner.get(`/invoices/${id}`));
    inv = await json(owner.patch(`/invoices/${id}`, { dueDate: '2026-09-15', issueDate: '2026-09-02', version: inv.version }));
    expect(inv.dueDate).toBe('2026-09-15');
    expect(inv.issueDate).toBe('2026-09-02');
    inv = await json(owner.patch(`/invoices/${id}`, { dueDate: null, version: inv.version }));
    expect(inv.dueDate).toBeNull();
  });

  it('the PDF renders without a due date and with a readable issue date', async () => {
    const buf = await renderInvoicePdf(
      { number: 'INV-9', currency: 'USD', issueDate: '2026-09-28', dueDate: null, status: 'sent', subtotal: 10, taxTotal: 0, total: 10, publicToken: 'T', language: 'en' },
      [{ description: 'x', quantity: 1, unitPrice: 10, amount: 10 }],
      { name: 'Acme' },
      { name: 'ordi', legalDetails: {}, invoiceSettings: {} },
    );
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});

describe('tax and discount', () => {
  it('a tax rate applied to the lines is totalled and named on the invoice and its public page', async () => {
    const { id } = await json(owner.post('/invoices', {
      companyId, issueDate: '2026-09-28', dueDate: '2026-10-05',
      items: [{ description: 'Design', quantity: 2, unitPrice: 50, taxRateId: vatId }],
    }));
    const inv = await json(owner.get(`/invoices/${id}`));
    expect(Number(inv.subtotal)).toBe(100);
    expect(Number(inv.taxTotal)).toBe(20);
    expect(Number(inv.total)).toBe(120);
    expect(inv.taxRateLabel).toBe('VAT 20%');
    const pub = await json(owner.get(`/i/${inv.publicToken}`));
    expect(pub.invoice.taxRateLabel).toBe('VAT 20%');
    expect(pub.items[0].taxRateId).toBeUndefined();
  });

  it('an untaxed invoice has no tax label', async () => {
    const { id } = await json(owner.post('/invoices', {
      companyId, issueDate: '2026-09-28', items: [{ description: 'x', quantity: 1, unitPrice: 10 }],
    }));
    const inv = await json(owner.get(`/invoices/${id}`));
    expect(Number(inv.taxTotal)).toBe(0);
    expect(inv.taxRateLabel).toBeNull();
  });

  it('items, tax and a discount can be changed on a draft, items lock once sent', async () => {
    const { id } = await json(owner.post('/invoices', {
      companyId, issueDate: '2026-09-28', items: [{ description: 'x', quantity: 1, unitPrice: 100 }],
    }));
    let inv = await json(owner.get(`/invoices/${id}`));
    inv = await json(owner.patch(`/invoices/${id}`, {
      version: inv.version, discountType: 'percent', discountValue: 10, currency: 'EUR', language: 'uk',
      items: [{ description: 'Design sprint', quantity: 1, unitPrice: 200, taxRateId: vatId, position: 1000 }],
    }));
    expect(inv.currency).toBe('EUR');
    expect(inv.language).toBe('uk');
    expect(Number(inv.subtotal)).toBe(200);
    expect(Number(inv.taxTotal)).toBe(36); // 20% of 180 after a 10% discount
    expect(Number(inv.total)).toBe(216);
    expect(inv.items[0].description).toBe('Design sprint');

    expect((await owner.post(`/invoices/${id}/send`, {})).status).toBe(200);
    inv = await json(owner.get(`/invoices/${id}`));
    const locked = await owner.patch(`/invoices/${id}`, { version: inv.version, items: [{ description: 'y', quantity: 1, unitPrice: 1 }] });
    expect(locked.status).toBe(422);
    const dates = await owner.patch(`/invoices/${id}`, { version: inv.version, dueDate: '2026-12-01' });
    expect(dates.status).toBe(200);
    expect((await json(dates)).dueDate).toBe('2026-12-01');
  });
});
