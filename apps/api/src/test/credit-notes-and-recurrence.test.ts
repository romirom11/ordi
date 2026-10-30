/**
 * amount_paid is cash only; credit notes settle an invoice too, so every
 * balance (public page, detail, list, company receivables) subtracts both.
 * Monthly schedules anchored on the 29th–31st land on the month's last day
 * instead of rolling into the next month.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { seedChartOfAccounts } from '../seed-baseline';
import { runRecurringInvoices, runRecurringPayments } from '../workers/scheduled';

let owner: ReturnType<typeof reqAs>;
let companyId: string;

async function newInvoice(unitPrice: number): Promise<string> {
  const { id } = await json(owner.post('/invoices', {
    companyId, issueDate: '2026-10-01', dueDate: '2026-10-31', language: 'en',
    items: [{ description: 'Work', quantity: 1, unitPrice }],
  }));
  return id;
}

beforeAll(async () => {
  await resetDb();
  await seedChartOfAccounts(getDb().db);
  const users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  companyId = (await json(owner.post('/companies', { name: 'Acme', status: 'active' }))).id;
});

describe('credit notes settle the balance everywhere', () => {
  it('a fully credited invoice shows nothing outstanding on its public page', async () => {
    const id = await newInvoice(100);
    expect((await owner.post(`/invoices/${id}/credit-notes`, { amount: 100, reason: 'goodwill', date: '2026-10-02' })).status).toBe(201);
    const inv = await json(owner.get(`/invoices/${id}`));
    expect(inv.status).toBe('paid');
    expect(inv.amountCredited).toBe(100);
    const pub = await json(owner.get(`/i/${inv.publicToken}`));
    expect(pub.outstanding).toBe(0);
    expect(pub.amountCredited).toBe(100);
  });

  it('cash and credit together, with cents that do not add up in floating point', async () => {
    const id = await newInvoice(100);
    await owner.post(`/invoices/${id}/payments`, { amount: 33.33, currency: 'USD', date: '2026-10-02' });
    await owner.post(`/invoices/${id}/credit-notes`, { amount: 40, reason: 'scope cut', date: '2026-10-03' });
    const inv = await json(owner.get(`/invoices/${id}`));
    const pub = await json(owner.get(`/i/${inv.publicToken}`));
    expect(pub.amountPaid).toBe(33.33);
    expect(pub.outstanding).toBe(26.67);
    const list = await json(owner.get(`/invoices?companyId=${companyId}`));
    expect(list.data.find((r: any) => r.id === id).amountCredited).toBe(40);
  });

  it('company receivables subtract credit notes', async () => {
    const { db } = getDb();
    const other = (await json(owner.post('/companies', { name: 'Receivables Ltd', status: 'active' }))).id;
    const { id } = await json(owner.post('/invoices', {
      companyId: other, issueDate: '2026-10-01', dueDate: '2026-10-31', language: 'en',
      items: [{ description: 'Work', quantity: 1, unitPrice: 200 }],
    }));
    await owner.post(`/invoices/${id}/credit-notes`, { amount: 50, reason: 'discount', date: '2026-10-02' });
    const [row] = await db.select().from(schema.invoices).where(eq(schema.invoices.id, id));
    expect(row!.status).toBe('partially_paid');
    const overview = await json(owner.get(`/companies/${other}/overview`));
    expect(Number(overview.billing[0].receivables)).toBe(150);
  });
});

describe('monthly schedules from the end of a month', () => {
  it('a recurring invoice due Jan 31 next falls on Feb 28', async () => {
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.recurringInvoices).values({
      id, companyId, frequency: 'monthly', nextIssueDate: '2026-01-31',
      itemsTemplate: [{ description: 'Retainer', quantity: 1, unitPrice: 10 }], currency: 'USD',
    } as any);
    await runRecurringInvoices();
    const [rule] = await db.select().from(schema.recurringInvoices).where(eq(schema.recurringInvoices.id, id));
    expect(rule!.nextIssueDate).toBe('2026-02-28');
  });

  it('a recurring payment catching up from Jan 31 visits every month-end', async () => {
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.recurringPayments).values({
      id, name: 'Hosting', amount: '10', currency: 'USD', interval: 'monthly', nextDate: '2026-01-31', isActive: true,
    } as any);
    await runRecurringPayments();
    const [rp] = await db.select().from(schema.recurringPayments).where(eq(schema.recurringPayments.id, id));
    // Jan 31 → Feb 28 → Mar 28 → …, advanced until strictly after today.
    expect(rp!.nextDate > new Date().toISOString().slice(0, 10)).toBe(true);
    expect(rp!.nextDate.slice(8)).toBe('28');
  });
});
