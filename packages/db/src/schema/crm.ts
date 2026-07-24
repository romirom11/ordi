import { pgTable, text, boolean, integer, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { pk, timestamps, createdBy, version, deletedAt, customFields, money } from './_shared';
import { users } from './core';

export const companies = pgTable('companies', {
  id: pk(),
  name: text('name').notNull(),
  domain: text('domain'),
  status: text('status').notNull().default('lead'),
  ownerId: text('owner_id').references(() => users.id),
  billingEmail: text('billing_email'),
  address: jsonb('address'),
  defaultCurrency: text('default_currency').notNull().default('USD'),
  paymentTermsDays: integer('payment_terms_days').notNull().default(14),
  portalToken: text('portal_token').unique(),
  portalEnabled: boolean('portal_enabled').notNull().default(false),
  customFields: customFields(),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  statusIdx: index('companies_status_idx').on(t.status),
  ownerIdx: index('companies_owner_idx').on(t.ownerId),
}));

export const contacts = pgTable('contacts', {
  id: pk(),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull().default(''),
  email: text('email'),
  phone: text('phone'),
  position: text('position'),
  isPrimary: boolean('is_primary').notNull().default(false),
  customFields: customFields(),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  companyIdx: index('contacts_company_idx').on(t.companyId),
}));

export const dealStages = pgTable('deal_stages', {
  id: pk(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  probability: integer('probability').notNull().default(0),
  isWon: boolean('is_won').notNull().default(false),
  isLost: boolean('is_lost').notNull().default(false),
  ...timestamps,
});

export const deals = pgTable('deals', {
  id: pk(),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  stageId: text('stage_id').notNull().references(() => dealStages.id),
  amount: money('amount').notNull().default('0'),
  currency: text('currency').notNull().default('USD'),
  expectedCloseDate: text('expected_close_date'),
  ownerId: text('owner_id').references(() => users.id),
  lostReason: text('lost_reason'),
  customFields: customFields(),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  companyIdx: index('deals_company_idx').on(t.companyId),
  stageIdx: index('deals_stage_idx').on(t.stageId),
}));

export const notes = pgTable('notes', {
  id: pk(),
  companyId: text('company_id').references(() => companies.id, { onDelete: 'cascade' }),
  contactId: text('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
  dealId: text('deal_id').references(() => deals.id, { onDelete: 'cascade' }),
  body: jsonb('body').notNull().default({}),
  pinned: boolean('pinned').notNull().default(false),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  companyIdx: index('notes_company_idx').on(t.companyId),
}));
