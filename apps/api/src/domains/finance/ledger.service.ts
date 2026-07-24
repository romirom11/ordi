/**
 * Double-entry ledger core (internal money representation).
 *
 * Documents (invoices, payments, expenses, manual income) remain the user-facing
 * records; every economic event they produce is mirrored here as a balanced
 * ledger transaction. Invariant enforced on every write: a transaction has at
 * least two postings and Σ debit(amount_base) == Σ credit(amount_base) (2dp).
 *
 * Correction model: money is never edited in place – a mirrored `reversal`
 * transaction negates the original, and the original is flagged status='void'.
 * Balance/revenue queries therefore sum over ALL transactions (reversals net
 * out); `void` is a journal display flag, not a filter.
 */
import { getDb, schema, eq, and, sql, desc, inArray } from '@ordi/db';
import { ulid } from 'ulid';
import type { AccountType } from '@ordi/shared';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';

// ─── system chart of accounts (ids match migration 0004 + seed-baseline) ─────
export const SYSTEM_ACCOUNTS = [
  { id: 'ACC000000000BANK0000000000', code: '1000', name: 'Bank', type: 'asset', position: 0 },
  { id: 'ACC000000000RECEIVABLE0000', code: '1100', name: 'Accounts receivable', type: 'asset', position: 1 },
  { id: 'ACC000000000OPENING0000000', code: '3000', name: 'Opening balance', type: 'equity', position: 0 },
  { id: 'ACC000000000CLIENTBILLING0', code: '4000', name: 'Client billing', type: 'revenue', position: 0 },
  { id: 'ACC000000000PRODUCTREV0000', code: '4100', name: 'Product revenue', type: 'revenue', position: 1 },
  { id: 'ACC000000000OTHERINCOME000', code: '4900', name: 'Other income', type: 'revenue', position: 2 },
  { id: 'ACC000000000PAYROLL0000000', code: '5000', name: 'Payroll', type: 'expense', position: 0 },
  { id: 'ACC000000000SOFTWARE000000', code: '5100', name: 'Software & subscriptions', type: 'expense', position: 1 },
  { id: 'ACC000000000CONTRACTORS000', code: '5200', name: 'Contractors', type: 'expense', position: 2 },
  { id: 'ACC000000000OTHEREXPENSES0', code: '5900', name: 'Other expenses', type: 'expense', position: 3 },
] as const;

export const SYS = {
  bank: '1000',
  receivable: '1100',
  clientBilling: '4000',
  productRevenue: '4100',
  otherExpenses: '5900',
} as const;

/** Resolve a system account by code, creating it if missing (idempotent by code). */
export async function systemAccount(code: string) {
  const { db } = getDb();
  const [existing] = await db.select().from(schema.accounts).where(eq(schema.accounts.code, code));
  if (existing) return existing;
  const seed = SYSTEM_ACCOUNTS.find((a) => a.code === code);
  if (!seed) throw err.domain(`Unknown system account code ${code}`);
  await db.insert(schema.accounts)
    .values({ id: seed.id, code: seed.code, name: seed.name, type: seed.type, isSystem: true, position: seed.position })
    .onConflictDoNothing();
  const [row] = await db.select().from(schema.accounts).where(eq(schema.accounts.code, code));
  return row!;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── transaction core ─────────────────────────────────────────────────────────
export interface PostingInput {
  accountId: string;
  direction: 'debit' | 'credit';
  amount: number;
  currency?: string;
}
interface TransactionInput {
  date: string;
  description?: string;
  sourceType?: string | null;
  sourceId?: string | null;
  projectId?: string | null;
  companyId?: string | null;
  postings: PostingInput[];
}

async function defaultCurrency(): Promise<string> {
  const { db } = getDb();
  const [ws] = await db.select({ cur: schema.workspaceSettings.defaultCurrency }).from(schema.workspaceSettings).limit(1);
  return ws?.cur ?? 'USD';
}

/**
 * Insert a balanced ledger transaction. Violations of the double-entry
 * invariant are a 422 (`domain_rule`), never silently corrected.
 */
export async function createTransaction(actor: Actor | null, input: TransactionInput): Promise<string> {
  const { db } = getDb();
  const postings = input.postings ?? [];
  if (postings.length < 2) throw err.domain('A ledger transaction needs at least two postings');
  if (postings.some((p) => !(p.amount > 0))) throw err.domain('Posting amounts must be positive');

  const baseCur = await defaultCurrency();
  // FX would plug in here: look up the rate document-currency → base currency
  // for input.date. Until then every posting converts 1:1 (amountBase = amount).
  const rows = postings.map((p) => ({
    id: ulid(),
    accountId: p.accountId,
    direction: p.direction,
    amount: round2(p.amount),
    currency: p.currency ?? baseCur,
    exchangeRate: '1',
    amountBase: round2(p.amount),
  }));

  const debitCents = rows.filter((r) => r.direction === 'debit').reduce((s, r) => s + Math.round(r.amountBase * 100), 0);
  const creditCents = rows.filter((r) => r.direction === 'credit').reduce((s, r) => s + Math.round(r.amountBase * 100), 0);
  if (debitCents !== creditCents) {
    throw err.domain('Transaction is not balanced: debits and credits must be equal', {
      debitTotal: debitCents / 100, creditTotal: creditCents / 100,
    });
  }

  const accountIds = [...new Set(rows.map((r) => r.accountId))];
  const found = await db.select({ id: schema.accounts.id }).from(schema.accounts).where(inArray(schema.accounts.id, accountIds));
  if (found.length !== accountIds.length) throw err.validation('Unknown account in postings');

  const id = ulid();
  await db.insert(schema.ledgerTransactions).values({
    id,
    date: input.date,
    description: input.description ?? '',
    status: 'posted',
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    projectId: input.projectId ?? null,
    companyId: input.companyId ?? null,
    createdBy: actor?.userId ?? null,
  });
  await db.insert(schema.ledgerPostings).values(rows.map((r) => ({
    id: r.id, transactionId: id, accountId: r.accountId, direction: r.direction,
    amount: String(r.amount), currency: r.currency, exchangeRate: r.exchangeRate, amountBase: String(r.amountBase),
  })));
  return id;
}

/** The still-posted transaction mirroring a document, if any. */
async function postedSourceTx(sourceType: string, sourceId: string) {
  const { db } = getDb();
  const [tx] = await db.select().from(schema.ledgerTransactions).where(and(
    eq(schema.ledgerTransactions.sourceType, sourceType),
    eq(schema.ledgerTransactions.sourceId, sourceId),
    eq(schema.ledgerTransactions.status, 'posted'),
  ));
  return tx ?? null;
}

/**
 * Negate a posted transaction: create a mirrored `reversal` and flag the
 * original `void`. Sums over all transactions therefore net to zero.
 */
async function reverseTransaction(actor: Actor | null, tx: typeof schema.ledgerTransactions.$inferSelect, description: string): Promise<string> {
  const { db } = getDb();
  const postings = await db.select().from(schema.ledgerPostings).where(eq(schema.ledgerPostings.transactionId, tx.id));
  const id = ulid();
  await db.insert(schema.ledgerTransactions).values({
    id, date: tx.date, description, status: 'posted', sourceType: 'reversal', sourceId: tx.id,
    projectId: tx.projectId, companyId: tx.companyId, createdBy: actor?.userId ?? null,
  });
  await db.insert(schema.ledgerPostings).values(postings.map((p) => ({
    id: ulid(), transactionId: id, accountId: p.accountId,
    direction: p.direction === 'debit' ? 'credit' : 'debit',
    amount: p.amount, currency: p.currency, exchangeRate: p.exchangeRate, amountBase: p.amountBase,
  })));
  await db.update(schema.ledgerTransactions).set({ status: 'void' }).where(eq(schema.ledgerTransactions.id, tx.id));
  return id;
}

/** Reverse whatever posted transaction mirrors (sourceType, sourceId). No-op when none. */
export async function reverseSource(actor: Actor | null, sourceType: string, sourceId: string, description: string): Promise<string | null> {
  const tx = await postedSourceTx(sourceType, sourceId);
  if (!tx) return null;
  return reverseTransaction(actor, tx, description);
}

// ─── document hooks (accrual-light) ───────────────────────────────────────────
interface InvoiceLike { id: string; number: string; total: string; currency: string; issueDate: string; projectId: string | null; companyId: string | null }

/** Invoice first marked sent → debit Accounts receivable / credit Client billing. */
export async function postInvoiceSent(actor: Actor | null, inv: InvoiceLike): Promise<void> {
  const total = Number(inv.total);
  if (!(total > 0)) return;
  if (await postedSourceTx('invoice', inv.id)) return; // idempotent
  const [ar, revenue] = await Promise.all([systemAccount(SYS.receivable), systemAccount(SYS.clientBilling)]);
  await createTransaction(actor, {
    date: today(),
    description: `Invoice ${inv.number}`,
    sourceType: 'invoice', sourceId: inv.id, projectId: inv.projectId, companyId: inv.companyId,
    postings: [
      { accountId: ar.id, direction: 'debit', amount: total, currency: inv.currency },
      { accountId: revenue.id, direction: 'credit', amount: total, currency: inv.currency },
    ],
  });
}

/** Invoice canceled after having been sent → mirrored reversal frees the receivable. */
export async function reverseInvoice(actor: Actor | null, inv: { id: string; number: string }): Promise<void> {
  await reverseSource(actor, 'invoice', inv.id, `Reversal – invoice ${inv.number} canceled`);
}

/** Payment recorded → debit Bank / credit Accounts receivable. */
export async function postPayment(
  actor: Actor | null,
  payment: { id: string; amount: number; currency: string; date: string },
  inv: { number: string; projectId: string | null; companyId: string | null },
): Promise<void> {
  if (!(payment.amount > 0)) return;
  if (await postedSourceTx('payment', payment.id)) return;
  const [bank, ar] = await Promise.all([systemAccount(SYS.bank), systemAccount(SYS.receivable)]);
  await createTransaction(actor, {
    date: payment.date,
    description: `Payment – invoice ${inv.number}`,
    sourceType: 'payment', sourceId: payment.id, projectId: inv.projectId, companyId: inv.companyId,
    postings: [
      { accountId: bank.id, direction: 'debit', amount: payment.amount, currency: payment.currency },
      { accountId: ar.id, direction: 'credit', amount: payment.amount, currency: payment.currency },
    ],
  });
}

/** Payment deleted → mirrored reversal restores the receivable. */
export async function reversePayment(actor: Actor | null, paymentId: string, invoiceNumber: string): Promise<void> {
  await reverseSource(actor, 'payment', paymentId, `Reversal – payment on invoice ${invoiceNumber} deleted`);
}

interface ExpenseLike { id: string; amount: string; currency: string; date: string; description: string; categoryId: string | null; projectId: string | null; companyId: string | null }

/** Resolve the expense account mapped to a category (fallback: "Other expenses"). */
async function expenseAccountFor(categoryId: string | null): Promise<string> {
  const { db } = getDb();
  if (categoryId) {
    const [cat] = await db.select({ accountId: schema.expenseCategories.accountId })
      .from(schema.expenseCategories).where(eq(schema.expenseCategories.id, categoryId));
    if (cat?.accountId) return cat.accountId;
  }
  return (await systemAccount(SYS.otherExpenses)).id;
}

/** Expense created → debit its mapped expense account / credit Bank. */
export async function postExpense(actor: Actor | null, exp: ExpenseLike): Promise<void> {
  const amount = Number(exp.amount);
  if (!(amount > 0)) return;
  if (await postedSourceTx('expense', exp.id)) return;
  const [accountId, bank] = await Promise.all([expenseAccountFor(exp.categoryId), systemAccount(SYS.bank)]);
  await createTransaction(actor, {
    date: exp.date,
    description: exp.description || 'Expense',
    sourceType: 'expense', sourceId: exp.id, projectId: exp.projectId, companyId: exp.companyId,
    postings: [
      { accountId, direction: 'debit', amount, currency: exp.currency },
      { accountId: bank.id, direction: 'credit', amount, currency: exp.currency },
    ],
  });
}

/** Expense (soft-)deleted → mirrored reversal. */
export async function reverseExpense(actor: Actor | null, expenseId: string): Promise<void> {
  await reverseSource(actor, 'expense', expenseId, 'Reversal – expense deleted');
}

/** Money-relevant expense edit → reverse the old posting, post the new state. */
export async function repostExpense(actor: Actor | null, exp: ExpenseLike): Promise<void> {
  await reverseSource(actor, 'expense', exp.id, 'Reversal – expense updated');
  await postExpense(actor, exp);
}

/** Manual income document → debit Bank / credit a revenue account. */
export async function postIncome(actor: Actor, input: {
  date: string; amount: number; currency: string; accountId?: string;
  projectId?: string | null; companyId?: string | null; description?: string;
}): Promise<string> {
  const { db } = getDb();
  let account;
  if (input.accountId) {
    [account] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, input.accountId));
    if (!account) throw err.notFound('Account not found');
    if (account.type !== 'revenue') throw err.domain('Income must be posted to a revenue account', { accountId: account.id });
    if (account.archived) throw err.domain('Cannot post income to an archived account');
  } else {
    account = await systemAccount(SYS.productRevenue);
  }
  const bank = await systemAccount(SYS.bank);
  const id = await createTransaction(actor, {
    date: input.date,
    description: input.description || 'Income',
    sourceType: 'income', sourceId: null, projectId: input.projectId ?? null, companyId: input.companyId ?? null,
    postings: [
      { accountId: bank.id, direction: 'debit', amount: input.amount, currency: input.currency },
      { accountId: account.id, direction: 'credit', amount: input.amount, currency: input.currency },
    ],
  });
  await writeActivity(db, { entityType: 'ledger_transaction', entityId: id, action: 'created', after: { sourceType: 'income', amount: input.amount, accountId: account.id }, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

// ─── manual journal + void ────────────────────────────────────────────────────
export async function createManualTransaction(actor: Actor, input: {
  date: string; description?: string; projectId?: string | null; companyId?: string | null; postings: PostingInput[];
}): Promise<string> {
  const { db } = getDb();
  const id = await createTransaction(actor, { ...input, sourceType: 'manual', sourceId: null });
  await writeActivity(db, { entityType: 'ledger_transaction', entityId: id, action: 'created', after: { sourceType: 'manual', postings: input.postings.length }, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

/** Void a manual/income transaction: mirrored reversal + status flag. */
export async function voidTransaction(actor: Actor, id: string): Promise<{ reversalId: string }> {
  const { db } = getDb();
  const [tx] = await db.select().from(schema.ledgerTransactions).where(eq(schema.ledgerTransactions.id, id));
  if (!tx) throw err.notFound('Transaction not found');
  if (tx.status !== 'posted') throw err.domain('Transaction is already void');
  if (tx.sourceType && !['manual', 'income'].includes(tx.sourceType)) {
    throw err.domain('This entry mirrors a document – cancel or delete the document instead', { sourceType: tx.sourceType });
  }
  const reversalId = await reverseTransaction(actor, tx, `Reversal – ${tx.description || 'entry'} voided`);
  await writeActivity(db, { entityType: 'ledger_transaction', entityId: id, action: 'voided', after: { reversalId }, actorId: actor.userId, actorType: actor.actorType });
  return { reversalId };
}

// ─── accounts CRUD ────────────────────────────────────────────────────────────
const TYPE_ORDER: Record<string, number> = { asset: 0, liability: 1, equity: 2, revenue: 3, expense: 4 };

/** Flat list ordered as a tree: type → roots (position, code) → their children. */
export async function listAccounts() {
  const { db } = getDb();
  const rows = await db.select().from(schema.accounts);
  const counts = await db.select({
    accountId: schema.ledgerPostings.accountId,
    n: sql<number>`count(*)`,
  }).from(schema.ledgerPostings).groupBy(schema.ledgerPostings.accountId);
  const countMap = new Map(counts.map((c) => [c.accountId, Number(c.n)]));

  const byParent = new Map<string | null, typeof rows>();
  for (const r of rows) {
    const key = r.parentId && rows.some((x) => x.id === r.parentId) ? r.parentId : null;
    const list = byParent.get(key) ?? [];
    list.push(r);
    byParent.set(key, list);
  }
  const cmp = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.position - b.position || (a.code ?? '').localeCompare(b.code ?? '') || a.name.localeCompare(b.name);
  const out: Array<(typeof rows)[number] & { depth: number; postingCount: number }> = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const r of (byParent.get(parentId) ?? []).sort(cmp)) {
      out.push({ ...r, depth, postingCount: countMap.get(r.id) ?? 0 });
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export async function createAccount(actor: Actor, input: {
  name: string; type: AccountType; code?: string | null; currency?: string | null; parentId?: string | null; position?: number;
}): Promise<string> {
  const { db } = getDb();
  if (input.parentId) {
    const [parent] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, input.parentId));
    if (!parent) throw err.validation('Parent account not found');
    if (parent.type !== input.type) throw err.domain('A sub-account must have the same type as its parent');
  }
  const id = ulid();
  await db.insert(schema.accounts).values({
    id, name: input.name, type: input.type, code: input.code ?? null,
    currency: input.currency ?? null, parentId: input.parentId ?? null, position: input.position ?? 0,
  });
  await writeActivity(db, { entityType: 'account', entityId: id, action: 'created', after: input, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

export async function updateAccount(actor: Actor, id: string, input: {
  name?: string; code?: string | null; currency?: string | null; parentId?: string | null; archived?: boolean; position?: number;
}) {
  const { db } = getDb();
  const [before] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
  if (!before) throw err.notFound('Account not found');
  if (before.isSystem && (input.archived !== undefined || input.parentId !== undefined)) {
    throw err.domain('System accounts can be renamed but not archived or re-parented');
  }
  if (input.parentId) {
    if (input.parentId === id) throw err.domain('An account cannot be its own parent');
    const [parent] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, input.parentId));
    if (!parent) throw err.validation('Parent account not found');
    if (parent.type !== before.type) throw err.domain('A sub-account must have the same type as its parent');
  }
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'code', 'currency', 'parentId', 'archived', 'position'] as const) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  if (Object.keys(patch).length) await db.update(schema.accounts).set(patch).where(eq(schema.accounts.id, id));
  await writeActivity(db, { entityType: 'account', entityId: id, action: 'updated', before, after: patch, actorId: actor.userId, actorType: actor.actorType });
  const [after] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
  return after;
}

export async function deleteAccount(actor: Actor, id: string): Promise<void> {
  const { db } = getDb();
  const [acc] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
  if (!acc) throw err.notFound('Account not found');
  if (acc.isSystem) throw err.domain('System accounts cannot be deleted');
  const [{ n: postings }] = await db.select({ n: sql<number>`count(*)` }).from(schema.ledgerPostings).where(eq(schema.ledgerPostings.accountId, id)) as any[];
  if (Number(postings) > 0) throw err.domain('Account has ledger entries – archive it instead');
  const [{ n: children }] = await db.select({ n: sql<number>`count(*)` }).from(schema.accounts).where(eq(schema.accounts.parentId, id)) as any[];
  if (Number(children) > 0) throw err.domain('Account has sub-accounts – move or delete them first');
  await db.delete(schema.accounts).where(eq(schema.accounts.id, id));
  await writeActivity(db, { entityType: 'account', entityId: id, action: 'deleted', before: { name: acc.name }, actorId: actor.userId, actorType: actor.actorType });
}

/** Sign-adjusted balance: assets/expenses grow with debits, the rest with credits. */
export async function accountBalance(id: string, params: { from?: string; to?: string }): Promise<{ accountId: string; balance: number }> {
  const { db } = getDb();
  const [acc] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id));
  if (!acc) throw err.notFound('Account not found');
  const debitPositive = acc.type === 'asset' || acc.type === 'expense';
  const [row] = await db.execute(sql`
    select coalesce(sum(case when p.direction = 'debit' then p.amount_base else -p.amount_base end), 0) as net
    from ledger_postings p
    join ledger_transactions t on t.id = p.transaction_id
    where p.account_id = ${id}
      ${params.from ? sql`and t.date >= ${params.from}` : sql``}
      ${params.to ? sql`and t.date <= ${params.to}` : sql``}
  `) as any[];
  const net = Number(row?.net ?? 0);
  return { accountId: id, balance: round2(debitPositive ? net : -net) };
}

// ─── journal ──────────────────────────────────────────────────────────────────
export async function listTransactions(params: {
  accountId?: string; projectId?: string; sourceType?: string; from?: string; to?: string; limit: number;
}) {
  const { db } = getDb();
  const filters = and(
    params.projectId ? eq(schema.ledgerTransactions.projectId, params.projectId) : undefined,
    params.sourceType ? eq(schema.ledgerTransactions.sourceType, params.sourceType) : undefined,
    params.from ? sql`${schema.ledgerTransactions.date} >= ${params.from}` : undefined,
    params.to ? sql`${schema.ledgerTransactions.date} <= ${params.to}` : undefined,
    params.accountId
      ? sql`exists (select 1 from ledger_postings lp where lp.transaction_id = ${schema.ledgerTransactions.id} and lp.account_id = ${params.accountId})`
      : undefined,
  );
  const txs = await db.select().from(schema.ledgerTransactions).where(filters)
    .orderBy(desc(schema.ledgerTransactions.date), desc(schema.ledgerTransactions.id))
    .limit(params.limit + 1);
  const ids = txs.map((t) => t.id);
  const postings = ids.length
    ? await db.select({
        id: schema.ledgerPostings.id,
        transactionId: schema.ledgerPostings.transactionId,
        accountId: schema.ledgerPostings.accountId,
        accountName: schema.accounts.name,
        accountType: schema.accounts.type,
        direction: schema.ledgerPostings.direction,
        amount: schema.ledgerPostings.amount,
        currency: schema.ledgerPostings.currency,
        amountBase: schema.ledgerPostings.amountBase,
      }).from(schema.ledgerPostings)
        .innerJoin(schema.accounts, eq(schema.accounts.id, schema.ledgerPostings.accountId))
        .where(inArray(schema.ledgerPostings.transactionId, ids))
    : [];
  const byTx = new Map<string, typeof postings>();
  for (const p of postings) {
    const list = byTx.get(p.transactionId) ?? [];
    list.push(p);
    byTx.set(p.transactionId, list);
  }
  return txs.map((t) => ({ ...t, postings: byTx.get(t.id) ?? [] }));
}

/**
 * Direct revenue for a project in [from, to]: net credits to revenue-type
 * accounts across all its ledger transactions (reversals net out).
 */
export async function projectDirectRevenue(projectId: string, from: string, to: string): Promise<number> {
  const { db } = getDb();
  const [row] = await db.execute(sql`
    select coalesce(sum(case when p.direction = 'credit' then p.amount_base else -p.amount_base end), 0) as revenue
    from ledger_postings p
    join ledger_transactions t on t.id = p.transaction_id
    join accounts a on a.id = p.account_id
    where a.type = 'revenue' and t.project_id = ${projectId} and t.date >= ${from} and t.date <= ${to}
  `) as any[];
  return round2(Number(row?.revenue ?? 0));
}
