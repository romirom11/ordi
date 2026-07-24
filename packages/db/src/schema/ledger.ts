/**
 * Double-entry ledger core (internal money representation).
 *
 * Users keep working with documents (invoices, payments, expenses, income);
 * every economic event those documents produce is mirrored here as a balanced
 * ledger transaction with >= 2 postings. The service layer enforces the
 * invariant sum(debit amount_base) == sum(credit amount_base) per transaction.
 */
import { pgTable, text, boolean, integer, numeric, index, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { pk, timestamps, createdBy, money } from './_shared';
import { projects } from './projects';
import { companies } from './crm';

/** Chart of accounts. `isSystem` rows are seeded and cannot be deleted. */
export const accounts = pgTable('accounts', {
  id: pk(),
  code: text('code'),
  name: text('name').notNull(),
  type: text('type').notNull(), // asset | liability | equity | revenue | expense
  currency: text('currency'),
  parentId: text('parent_id').references((): AnyPgColumn => accounts.id),
  isSystem: boolean('is_system').notNull().default(false),
  archived: boolean('archived').notNull().default(false),
  position: integer('position').notNull().default(0),
  ...timestamps,
}, (t) => ({
  typeIdx: index('accounts_type_idx').on(t.type),
  parentIdx: index('accounts_parent_idx').on(t.parentId),
}));

export const ledgerTransactions = pgTable('ledger_transactions', {
  id: pk(),
  date: text('date').notNull(), // YYYY-MM-DD
  description: text('description').notNull().default(''),
  status: text('status').notNull().default('posted'), // posted | void
  sourceType: text('source_type'), // invoice | payment | expense | income | manual | reversal
  sourceId: text('source_id'),
  projectId: text('project_id').references(() => projects.id),
  companyId: text('company_id').references(() => companies.id),
  createdBy: createdBy(),
  ...timestamps,
}, (t) => ({
  dateIdx: index('ledger_transactions_date_idx').on(t.date),
  sourceIdx: index('ledger_transactions_source_idx').on(t.sourceType, t.sourceId),
  projectIdx: index('ledger_transactions_project_idx').on(t.projectId),
}));

export const ledgerPostings = pgTable('ledger_postings', {
  id: pk(),
  transactionId: text('transaction_id').notNull().references(() => ledgerTransactions.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull().references(() => accounts.id),
  direction: text('direction').notNull(), // debit | credit
  amount: money('amount').notNull(),
  currency: text('currency').notNull().default('USD'),
  // FX plumbing: exchange_rate converts `amount` (document currency) into
  // `amount_base` (workspace default currency). Rate is 1 until FX lands.
  exchangeRate: numeric('exchange_rate').notNull().default('1'),
  amountBase: money('amount_base').notNull(),
}, (t) => ({
  txIdx: index('ledger_postings_tx_idx').on(t.transactionId),
  accountIdx: index('ledger_postings_account_idx').on(t.accountId),
}));
