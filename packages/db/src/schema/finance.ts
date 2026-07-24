import { pgTable, text, boolean, integer, numeric, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { pk, timestamps, createdBy, version, deletedAt, customFields, money, position } from './_shared';
import { users } from './core';
import { companies } from './crm';
import { projects } from './projects';
import { accounts } from './ledger';

export const numberSequences = pgTable('number_sequences', {
  id: pk(),
  docType: text('doc_type').notNull(),
  periodKey: text('period_key').notNull(),
  lastValue: integer('last_value').notNull().default(0),
  pattern: text('pattern').notNull().default('INV-{YYYY}-{seq:4}'),
  resetPeriod: text('reset_period').notNull().default('year'),
}, (t) => ({
  docPeriodIdx: uniqueIndex('number_sequences_doc_period_idx').on(t.docType, t.periodKey),
}));

export const taxRates = pgTable('tax_rates', {
  id: pk(),
  name: text('name').notNull(),
  ratePercent: numeric('rate_percent', { precision: 6, scale: 3 }).notNull().default('0'),
  ...timestamps,
});

export const quotes = pgTable('quotes', {
  id: pk(),
  companyId: text('company_id').notNull().references(() => companies.id),
  projectId: text('project_id').references(() => projects.id),
  number: text('number').notNull().unique(),
  status: text('status').notNull().default('draft'),
  currency: text('currency').notNull().default('USD'),
  issueDate: text('issue_date').notNull(),
  validUntil: text('valid_until'),
  language: text('language').notNull().default('en'),
  discountType: text('discount_type').notNull().default('none'),
  discountValue: money('discount_value').notNull().default('0'),
  subtotal: money('subtotal').notNull().default('0'),
  taxTotal: money('tax_total').notNull().default('0'),
  total: money('total').notNull().default('0'),
  notes: text('notes').notNull().default(''),
  terms: text('terms').notNull().default(''),
  publicToken: text('public_token').notNull().unique(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  declineComment: text('decline_comment'),
  convertedInvoiceId: text('converted_invoice_id'),
  customFields: customFields(),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  companyIdx: index('quotes_company_idx').on(t.companyId),
  statusIdx: index('quotes_status_idx').on(t.status),
}));

export const quoteItems = pgTable('quote_items', {
  id: pk(),
  quoteId: text('quote_id').notNull().references(() => quotes.id, { onDelete: 'cascade' }),
  description: text('description').notNull(),
  quantity: numeric('quantity').notNull().default('1'),
  unitPrice: money('unit_price').notNull().default('0'),
  taxRateId: text('tax_rate_id').references(() => taxRates.id),
  amount: money('amount').notNull().default('0'),
  position: position(),
});

export const invoices = pgTable('invoices', {
  id: pk(),
  companyId: text('company_id').notNull().references(() => companies.id),
  projectId: text('project_id').references(() => projects.id),
  quoteId: text('quote_id').references(() => quotes.id),
  number: text('number').notNull().unique(),
  status: text('status').notNull().default('draft'),
  currency: text('currency').notNull().default('USD'),
  issueDate: text('issue_date').notNull(),
  dueDate: text('due_date').notNull(),
  language: text('language').notNull().default('en'),
  discountType: text('discount_type').notNull().default('none'),
  discountValue: money('discount_value').notNull().default('0'),
  discountBeforeTax: boolean('discount_before_tax').notNull().default(true),
  subtotal: money('subtotal').notNull().default('0'),
  taxTotal: money('tax_total').notNull().default('0'),
  total: money('total').notNull().default('0'),
  amountPaid: money('amount_paid').notNull().default('0'),
  notes: text('notes').notNull().default(''),
  terms: text('terms').notNull().default(''),
  publicToken: text('public_token').notNull().unique(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  viewedAt: timestamp('viewed_at', { withTimezone: true }),
  remindersPaused: boolean('reminders_paused').notNull().default(false),
  source: text('source').notNull().default('manual'), // manual | time | quote | recurring
  customFields: customFields(),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  companyIdx: index('invoices_company_idx').on(t.companyId),
  statusIdx: index('invoices_status_idx').on(t.status),
  dueIdx: index('invoices_due_idx').on(t.dueDate),
}));

export const invoiceItems = pgTable('invoice_items', {
  id: pk(),
  invoiceId: text('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  description: text('description').notNull(),
  quantity: numeric('quantity').notNull().default('1'),
  unitPrice: money('unit_price').notNull().default('0'),
  taxRateId: text('tax_rate_id').references(() => taxRates.id),
  amount: money('amount').notNull().default('0'),
  position: position(),
  source: text('source').notNull().default('manual'), // manual | time | quote
});

export const payments = pgTable('payments', {
  id: pk(),
  invoiceId: text('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  amount: money('amount').notNull(),
  currency: text('currency').notNull().default('USD'),
  date: text('date').notNull(),
  method: text('method').notNull().default('bank'),
  reference: text('reference').notNull().default(''),
  notes: text('notes').notNull().default(''),
  createdBy: createdBy(),
  ...timestamps,
});

export const creditNotes = pgTable('credit_notes', {
  id: pk(),
  invoiceId: text('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  amount: money('amount').notNull(),
  reason: text('reason').notNull(),
  date: text('date').notNull(),
  createdBy: createdBy(),
  ...timestamps,
});

export const recurringInvoices = pgTable('recurring_invoices', {
  id: pk(),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  projectId: text('project_id').references(() => projects.id),
  frequency: text('frequency').notNull(),
  nextIssueDate: text('next_issue_date').notNull(),
  itemsTemplate: jsonb('items_template').notNull().default([]),
  autoSend: boolean('auto_send').notNull().default(false),
  currency: text('currency').notNull().default('USD'),
  endDate: text('end_date'),
  status: text('status').notNull().default('active'),
  ...timestamps,
});

export const expenseCategories = pgTable('expense_categories', {
  id: pk(),
  name: text('name').notNull(),
  // Ledger mapping: expenses in this category post to this expense account
  // (falls back to the system "Other expenses" account when unset).
  accountId: text('account_id').references(() => accounts.id),
  ...timestamps,
});

export const expenses = pgTable('expenses', {
  id: pk(),
  companyId: text('company_id').references(() => companies.id),
  projectId: text('project_id').references(() => projects.id),
  categoryId: text('category_id').references(() => expenseCategories.id),
  amount: money('amount').notNull(),
  currency: text('currency').notNull().default('USD'),
  date: text('date').notNull(),
  description: text('description').notNull().default(''),
  attachmentId: text('attachment_id'),
  billable: boolean('billable').notNull().default(false),
  markup: numeric('markup').notNull().default('0'),
  createdBy: createdBy(),
  ...timestamps,
  deletedAt: deletedAt(),
}, (t) => ({
  projectIdx: index('expenses_project_idx').on(t.projectId),
}));

/**
 * Recurring payments / subscriptions (vendor bills the workspace pays regularly).
 * A daily job advances next_date by `interval` and optionally materialises an
 * expense row. Amount stored as string (numeric). Soft-deleted + optimistic version.
 */
export const recurringPayments = pgTable('recurring_payments', {
  id: pk(),
  name: text('name').notNull(),
  vendor: text('vendor'),
  companyId: text('company_id').references(() => companies.id),
  amount: money('amount').notNull(),
  currency: text('currency').notNull().default('USD'),
  interval: text('interval').notNull(), // weekly | monthly | quarterly | yearly
  nextDate: text('next_date').notNull(),
  category: text('category'),
  notes: text('notes'),
  isActive: boolean('is_active').notNull().default(true),
  autoCreateExpense: boolean('auto_create_expense').notNull().default(false),
  lastCreatedAt: timestamp('last_created_at', { withTimezone: true }),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  activeIdx: index('recurring_payments_active_idx').on(t.isActive),
  nextDateIdx: index('recurring_payments_next_date_idx').on(t.nextDate),
}));

export const reminderRules = pgTable('reminder_rules', {
  id: pk(),
  offsetDays: integer('offset_days').notNull(),
  templateId: text('template_id'),
  active: boolean('active').notNull().default(true),
  ...timestamps,
});

export const emailTemplates = pgTable('email_templates', {
  id: pk(),
  type: text('type').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  ...timestamps,
});

export const reminderLog = pgTable('reminder_log', {
  id: pk(),
  invoiceId: text('invoice_id').notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  ruleId: text('rule_id').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  dedupeIdx: uniqueIndex('reminder_log_dedupe_idx').on(t.invoiceId, t.ruleId),
}));
