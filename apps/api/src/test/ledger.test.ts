/**
 * Double-entry ledger core: balance invariant, document → posting hooks,
 * reversals, manual income and expense-category account mapping.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { seedChartOfAccounts } from '../seed-baseline';
import { runRecurringPayments } from '../workers/scheduled';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let owner: ReturnType<typeof reqAs>;

beforeAll(async () => {
  await resetDb();
  await seedChartOfAccounts(getDb().db);
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
});

async function accountByCode(code: string): Promise<any> {
  const list = await json(owner.get('/ledger/accounts'));
  return (list.data as any[]).find((a) => a.code === code);
}
async function txsBySource(sourceType: string): Promise<any[]> {
  const res = await json(owner.get(`/ledger/transactions?sourceType=${sourceType}&limit=100`));
  return res.data as any[];
}

describe('ledger invariant (Σ debit == Σ credit, ≥2 postings)', () => {
  it('rejects an unbalanced manual transaction with 422', async () => {
    const bank = await accountByCode('1000');
    const other = await accountByCode('4900');
    const res = await owner.post('/ledger/transactions', {
      date: '2026-01-10',
      description: 'lopsided',
      postings: [
        { accountId: bank.id, direction: 'debit', amount: 100 },
        { accountId: other.id, direction: 'credit', amount: 90 },
      ],
    });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.code).toBe('domain_rule');
  });

  it('rejects a single-posting transaction', async () => {
    const bank = await accountByCode('1000');
    const res = await owner.post('/ledger/transactions', {
      date: '2026-01-10', postings: [{ accountId: bank.id, direction: 'debit', amount: 100 }],
    });
    expect([400, 422]).toContain(res.status);
  });

  it('accepts a balanced manual transaction and voids it via reversal', async () => {
    const bank = await accountByCode('1000');
    const opening = await accountByCode('3000');
    const created = await json(owner.post('/ledger/transactions', {
      date: '2026-01-15',
      description: 'Opening balance',
      postings: [
        { accountId: bank.id, direction: 'debit', amount: 2500 },
        { accountId: opening.id, direction: 'credit', amount: 2500 },
      ],
    }));
    expect(created.id).toBeTruthy();

    const voided = await json(owner.post(`/ledger/transactions/${created.id}/void`));
    expect(voided.reversalId).toBeTruthy();
    const reversals = await txsBySource('reversal');
    const rev = reversals.find((r) => r.sourceId === created.id);
    expect(rev).toBeTruthy();
    // Mirrored: the reversal credits Bank with the same amount.
    const bankLeg = rev.postings.find((p: any) => p.accountId === bank.id);
    expect(bankLeg.direction).toBe('credit');
    expect(Number(bankLeg.amount)).toBe(2500);
  });
});

describe('documents mirror into the ledger', () => {
  let companyId: string;
  let invoiceId: string;

  beforeAll(async () => {
    const company = await json(owner.post('/companies', { name: 'LedgerCo', defaultCurrency: 'USD' }));
    companyId = company.id;
    const inv = await json(owner.post('/invoices', {
      companyId, currency: 'USD', issueDate: '2026-02-01', dueDate: '2026-03-01',
      items: [{ description: 'work', quantity: 1, unitPrice: 600 }],
    }));
    invoiceId = inv.id;
  });

  it('invoice first marked sent → AR debit / Client billing credit', async () => {
    expect((await owner.post(`/invoices/${invoiceId}/send`, {})).status).toBe(200);
    const txs = await txsBySource('invoice');
    const tx = txs.find((t) => t.sourceId === invoiceId);
    expect(tx).toBeTruthy();
    const debit = tx.postings.find((p: any) => p.direction === 'debit');
    const credit = tx.postings.find((p: any) => p.direction === 'credit');
    expect(debit.accountName).toBe('Accounts receivable');
    expect(Number(debit.amount)).toBe(600);
    expect(credit.accountName).toBe('Client billing');
    // Re-send does not double post.
    await owner.post(`/invoices/${invoiceId}/send`, {});
    expect((await txsBySource('invoice')).filter((t) => t.sourceId === invoiceId).length).toBe(1);
  });

  it('payment recorded → Bank debit / AR credit', async () => {
    const pay = await json(owner.post(`/invoices/${invoiceId}/payments`, {
      amount: 200, currency: 'USD', date: '2026-02-10', method: 'bank',
    }));
    const txs = await txsBySource('payment');
    const tx = txs.find((t) => t.sourceId === pay.id);
    expect(tx).toBeTruthy();
    const debit = tx.postings.find((p: any) => p.direction === 'debit');
    expect(debit.accountName).toBe('Bank');
    expect(Number(debit.amount)).toBe(200);
    expect(tx.postings.find((p: any) => p.direction === 'credit').accountName).toBe('Accounts receivable');
  });

  it('canceling a sent invoice reverses the posting and zeroes AR', async () => {
    const ar = await accountByCode('1100');
    const before = await json(owner.get(`/ledger/accounts/${ar.id}/balance`));
    expect(before.balance).toBe(400); // 600 invoiced − 200 paid
    expect((await owner.post(`/invoices/${invoiceId}/cancel`)).status).toBe(200);
    const after = await json(owner.get(`/ledger/accounts/${ar.id}/balance`));
    expect(after.balance).toBe(before.balance - 600);
    const reversals = await txsBySource('reversal');
    const invoiceTx = (await txsBySource('invoice')).find((t) => t.sourceId === invoiceId);
    expect(invoiceTx.status).toBe('void');
    expect(reversals.some((r) => r.sourceId === invoiceTx.id)).toBe(true);
  });

  it('expense posts to its category-mapped account, unmapped falls back to Other expenses', async () => {
    const cloud = await json(owner.post('/ledger/accounts', { name: 'Cloud hosting', type: 'expense', code: '5150' }));
    const cat = await json(owner.post('/expense-categories', { name: 'Hosting', accountId: cloud.id }));

    const mapped = await json(owner.post('/expenses', {
      amount: 120, currency: 'USD', date: '2026-02-12', description: 'VMs', categoryId: cat.id,
    }));
    const unmapped = await json(owner.post('/expenses', {
      amount: 30, currency: 'USD', date: '2026-02-13', description: 'Stamps',
    }));

    const txs = await txsBySource('expense');
    const mappedTx = txs.find((t) => t.sourceId === mapped.id);
    const unmappedTx = txs.find((t) => t.sourceId === unmapped.id);
    expect(mappedTx.postings.find((p: any) => p.direction === 'debit').accountName).toBe('Cloud hosting');
    expect(unmappedTx.postings.find((p: any) => p.direction === 'debit').accountName).toBe('Other expenses');
    // Both credit Bank.
    expect(mappedTx.postings.find((p: any) => p.direction === 'credit').accountName).toBe('Bank');

    // Soft-deleting the expense reverses it.
    await owner.del(`/expenses/${unmapped.id}`);
    const reversals = await txsBySource('reversal');
    expect(reversals.some((r) => r.sourceId === unmappedTx.id)).toBe(true);
  });

  it('recurring payment auto-expense flows through the same ledger hook', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await owner.post('/recurring-payments', {
      name: 'CI minutes', amount: 45, currency: 'USD', interval: 'monthly',
      nextDate: yesterday, autoCreateExpense: true,
    });
    await runRecurringPayments();
    const txs = await txsBySource('expense');
    const tx = txs.find((t) => t.description === 'CI minutes');
    expect(tx).toBeTruthy();
    expect(tx.postings.find((p: any) => p.direction === 'debit').accountName).toBe('Other expenses');
  });
});

describe('manual income + direct-revenue profitability', () => {
  it('income posts Bank → revenue account and feeds a direct project’s revenue', async () => {
    const types = (await json(owner.get('/project-types'))).data as any[];
    const direct = types.find((x) => x.revenueSource === 'direct');
    expect(direct).toBeTruthy();
    const project = await json(owner.post('/projects', { name: 'SaaS thing', key: 'SAAS', projectTypeId: direct.id }));

    const res = await owner.post('/income', {
      date: '2026-03-01', amount: 500, currency: 'USD', projectId: project.id, description: 'March subscriptions',
    });
    expect(res.status).toBe(201);

    const incomes = await txsBySource('income');
    const tx = incomes.find((t) => t.projectId === project.id);
    expect(tx).toBeTruthy();
    expect(tx.postings.find((p: any) => p.direction === 'debit').accountName).toBe('Bank');
    expect(tx.postings.find((p: any) => p.direction === 'credit').accountName).toBe('Product revenue');

    const prof = await json(owner.get(`/finance/profitability?scope=project&projectId=${project.id}`));
    const row = (prof.rows as any[]).find((r) => r.projectId === project.id);
    expect(row.revenue).toBe(500);
  });

  it('rejects income posted to a non-revenue account', async () => {
    const bank = await accountByCode('1000');
    const res = await owner.post('/income', { date: '2026-03-02', amount: 10, currency: 'USD', accountId: bank.id });
    expect(res.status).toBe(422);
  });
});

describe('chart of accounts guardrails', () => {
  it('system accounts can be renamed but never deleted or archived', async () => {
    const bank = await accountByCode('1000');
    const renamed = await json(owner.patch(`/ledger/accounts/${bank.id}`, { name: 'Main bank' }));
    expect(renamed.name).toBe('Main bank');
    expect((await owner.patch(`/ledger/accounts/${bank.id}`, { archived: true })).status).toBe(422);
    expect((await owner.del(`/ledger/accounts/${bank.id}`)).status).toBe(422);
  });

  it('accounts with postings cannot be hard-deleted', async () => {
    const acc = await json(owner.post('/ledger/accounts', { name: 'Consulting', type: 'revenue', code: '4200' }));
    await owner.post('/income', { date: '2026-03-05', amount: 50, currency: 'USD', accountId: acc.id });
    expect((await owner.del(`/ledger/accounts/${acc.id}`)).status).toBe(422);
    // Archive works instead; empty accounts delete fine.
    const arch = await json(owner.patch(`/ledger/accounts/${acc.id}`, { archived: true }));
    expect(arch.archived).toBe(true);
    const empty = await json(owner.post('/ledger/accounts', { name: 'Scratch', type: 'expense' }));
    expect((await owner.del(`/ledger/accounts/${empty.id}`)).status).toBe(200);
  });
});
