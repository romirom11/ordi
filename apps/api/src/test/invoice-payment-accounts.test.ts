/**
 * Payment accounts: an invoice prints the account in the currency the client
 * pays in (never another currency's IBAN), a client paying the equivalent in
 * another currency gets that currency's account and the amount at the rate
 * typed in, the public page sees only the one set of details it prints, and a
 * sent invoice keeps the details it went out with.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getDb } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json, setTestSmtp } from './helpers';
import { seedChartOfAccounts } from '../seed-baseline';
import { renderInvoicePdf } from '../domains/finance/pdf';

const sendMail = vi.fn(async (_msg: unknown) => ({ messageId: '<fake@ordi.test>' }));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail, verify: async () => true }) },
}));

let owner: ReturnType<typeof reqAs>;
let companyId: string;

const UAH = { id: 'uah', name: 'ПриватБанк, гривня', currency: 'UAH', details: 'IBAN UA86 3220 0100 UAH' };
const USD = { id: 'usd', name: 'USD account', currency: 'USD', details: 'IBAN UA11 3220 0100 USD' };
const USD2 = { id: 'usd2', name: 'USD reserve', currency: 'USD', details: 'IBAN UA22 3220 0100 USD-2' };

async function newInvoice(body: Record<string, unknown> = {}) {
  return owner.post('/invoices', {
    companyId, issueDate: '2026-11-06', currency: 'USD', language: 'uk',
    items: [{ description: 'Design sprint', quantity: 1, unitPrice: 1000 }],
    ...body,
  });
}

async function publicOf(id: string) {
  const inv = await json(owner.get(`/invoices/${id}`));
  return json(owner.get(`/i/${inv.publicToken}`));
}

beforeAll(async () => {
  await resetDb();
  await seedChartOfAccounts(getDb().db);
  const users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  companyId = (await json(owner.post('/companies', { name: 'Appricotsoft', status: 'active', billingEmail: 'billing@appricotsoft.test' }))).id;
  const res = await owner.patch('/settings/workspace', {
    name: 'kdn.agency',
    invoiceSettings: { paymentDetails: null, paymentAccounts: [UAH, USD, USD2] },
  });
  expect(res.status).toBe(200);
  await setTestSmtp(false);
});

afterAll(async () => { await setTestSmtp(false); });

describe('which account an invoice prints', () => {
  it('takes the first account in the invoice currency, and the public page sees nothing else', async () => {
    const { id } = await json(await newInvoice());
    const pub = await publicOf(id);
    expect(pub.invoiceSettings.paymentDetails).toBe(USD.details);
    expect(pub.invoiceSettings.paymentAccounts).toBeUndefined();
    expect(JSON.stringify(pub)).not.toContain(UAH.details);
  });

  it('prints the account chosen on the invoice', async () => {
    const { id } = await json(await newInvoice({ paymentAccountId: 'usd2' }));
    expect((await publicOf(id)).invoiceSettings.paymentDetails).toBe(USD2.details);
  });

  it('prints nothing for a currency without an account', async () => {
    const { id } = await json(await newInvoice({ currency: 'EUR' }));
    expect((await publicOf(id)).invoiceSettings.paymentDetails).toBeNull();
  });

  it('refuses an account in another currency', async () => {
    const res = await newInvoice({ paymentAccountId: 'uah' });
    expect(res.status).toBe(400);
    expect((await json(res)).error.details.field).toBe('paymentAccountId');
  });
});

describe('a client paying the equivalent in UAH', () => {
  it('needs a rate, and a currency other than the invoice\'s own', async () => {
    expect((await newInvoice({ paymentCurrency: 'UAH' })).status).toBe(400);
    expect((await newInvoice({ paymentCurrency: 'USD', exchangeRate: 1 })).status).toBe(400);
  });

  it('is paid to the UAH account and shows the rate on the public page and PDF', async () => {
    const { id } = await json(await newInvoice({ paymentCurrency: 'UAH', exchangeRate: 41.25 }));
    const inv = await json(owner.get(`/invoices/${id}`));
    expect(inv.paymentCurrency).toBe('UAH');
    expect(Number(inv.exchangeRate)).toBe(41.25);

    const pub = await publicOf(id);
    expect(pub.invoiceSettings.paymentDetails).toBe(UAH.details);
    expect(pub.invoice.paymentCurrency).toBe('UAH');
    expect(Number(pub.invoice.exchangeRate)).toBe(41.25);

    const pdf = await renderInvoicePdf({ ...inv, total: '1000' }, inv.items, { name: 'Appricotsoft' }, { invoiceSettings: { paymentAccounts: [UAH, USD] } });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('switching back to paying in USD drops the rate and moves to the USD account', async () => {
    const { id } = await json(await newInvoice({ paymentCurrency: 'UAH', exchangeRate: 41.25 }));
    const before = await json(owner.get(`/invoices/${id}`));
    const res = await owner.patch(`/invoices/${id}`, { paymentCurrency: null, exchangeRate: null, version: before.version });
    expect(res.status).toBe(200);
    const after = await json(res);
    expect(after.paymentCurrency).toBeNull();
    expect(after.exchangeRate).toBeNull();
    expect((await publicOf(id)).invoiceSettings.paymentDetails).toBe(USD.details);
  });

  it('a currency change the account no longer fits drops the stored account instead of failing', async () => {
    const { id } = await json(await newInvoice({ paymentAccountId: 'usd2' }));
    const before = await json(owner.get(`/invoices/${id}`));
    const after = await json(owner.patch(`/invoices/${id}`, { currency: 'UAH', version: before.version }));
    expect(after.paymentAccountId).toBeNull();
    expect((await publicOf(id)).invoiceSettings.paymentDetails).toBe(UAH.details);
  });
});

describe('a sent invoice', () => {
  it('keeps the details it went out with after the account is edited', async () => {
    await setTestSmtp(true);
    const { id } = await json(await newInvoice());
    expect((await owner.post(`/invoices/${id}/send`, {})).status).toBe(200);
    expect((await json(owner.get(`/invoices/${id}`))).paymentDetails).toBe(USD.details);

    await owner.patch('/settings/workspace', {
      invoiceSettings: { paymentAccounts: [UAH, { ...USD, details: 'IBAN UA99 NEW' }, USD2] },
    });
    expect((await publicOf(id)).invoiceSettings.paymentDetails).toBe(USD.details);

    // A draft still reads the account live.
    const draft = await json(await newInvoice());
    expect((await publicOf(draft.id)).invoiceSettings.paymentDetails).toBe('IBAN UA99 NEW');
  });
});
