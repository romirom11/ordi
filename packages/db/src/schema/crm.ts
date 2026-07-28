import { sql } from 'drizzle-orm';
import { pgTable, text, boolean, integer, jsonb, index, uniqueIndex, timestamp, check } from 'drizzle-orm/pg-core';
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
  domainIdx: index('companies_domain_idx').on(t.domain),
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

export const researchBatches = pgTable('research_batches', {
  id: pk(),
  title: text('title').notNull(),
  product: text('product'),
  productUrl: text('product_url'),
  targetCustomer: text('target_customer'),
  searchScope: text('search_scope'),
  generatedAt: text('generated_at'),
  verdict: text('verdict'),
  patterns: jsonb('patterns').notNull().default([]),
  outreachPlan: jsonb('outreach_plan').notNull().default({}),
  limits: jsonb('limits').notNull().default([]),
  excludedCandidates: jsonb('excluded_candidates').notNull().default([]),
  rawPayload: jsonb('raw_payload').notNull(),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
});

export const leads = pgTable('leads', {
  id: pk(),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  researchBatchId: text('research_batch_id').references(() => researchBatches.id, { onDelete: 'set null' }),
  legacyDealId: text('legacy_deal_id'),
  title: text('title').notNull(),
  product: text('product'),
  status: text('status').notNull().default('new'),
  score: integer('score'),
  signal: text('signal'),
  painSignal: text('pain_signal'),
  evidence: text('evidence'),
  whyFit: text('why_fit'),
  whyNow: text('why_now'),
  sourceTitle: text('source_title'),
  sourceUrl: text('source_url'),
  sourceType: text('source_type'),
  signalDate: text('signal_date'),
  sourceCheckedAt: timestamp('source_checked_at', { withTimezone: true }),
  suggestedChannel: text('suggested_channel'),
  opener: text('opener'),
  caution: text('caution'),
  dimensions: jsonb('dimensions').notNull().default({}),
  secondarySources: jsonb('secondary_sources').notNull().default([]),
  rawResearch: jsonb('raw_research').notNull().default({}),
  nurtureUntil: text('nurture_until'),
  disqualifiedReason: text('disqualified_reason'),
  ownerId: text('owner_id').references(() => users.id),
  customFields: customFields(),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  companyIdx: index('leads_company_idx').on(t.companyId),
  contactIdx: index('leads_contact_idx').on(t.contactId),
  ownerIdx: index('leads_owner_idx').on(t.ownerId),
  statusIdx: index('leads_status_idx').on(t.status),
  batchIdx: index('leads_research_batch_idx').on(t.researchBatchId),
  legacyDealIdx: uniqueIndex('leads_legacy_deal_idx').on(t.legacyDealId),
}));

export const deals = pgTable('deals', {
  id: pk(),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  sourceLeadId: text('source_lead_id').references(() => leads.id, { onDelete: 'set null' }),
  /**
   * Optional link to the product/delivery project this deal sells into
   * (e.g. a SaaS lead vs. a services lead). The FK to projects(id) lives in
   * the SQL migration – projects.ts imports this module, so a drizzle-level
   * reference here would create a schema-module cycle.
   */
  projectId: text('project_id'),
  title: text('title').notNull(),
  stageId: text('stage_id').notNull().references(() => dealStages.id),
  amount: money('amount'),
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
  projectIdx: index('deals_project_idx').on(t.projectId),
  sourceLeadIdx: uniqueIndex('deals_source_lead_idx').on(t.sourceLeadId),
}));

export const salesActivities = pgTable('sales_activities', {
  id: pk(),
  leadId: text('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
  dealId: text('deal_id').references(() => deals.id, { onDelete: 'cascade' }),
  companyId: text('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  type: text('type').notNull(),
  status: text('status').notNull().default('planned'),
  channel: text('channel'),
  subject: text('subject'),
  context: text('context'),
  outcome: text('outcome'),
  dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  ownerId: text('owner_id').references(() => users.id),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  leadIdx: index('sales_activities_lead_idx').on(t.leadId),
  dealIdx: index('sales_activities_deal_idx').on(t.dealId),
  companyIdx: index('sales_activities_company_idx').on(t.companyId),
  ownerIdx: index('sales_activities_owner_idx').on(t.ownerId),
  dueIdx: index('sales_activities_due_idx').on(t.status, t.dueAt),
  leadDueIdx: index('sales_activities_lead_due_idx').on(t.leadId, t.status, t.dueAt),
  dealDueIdx: index('sales_activities_deal_due_idx').on(t.dealId, t.status, t.dueAt),
  parentCheck: check('sales_activities_parent_check', sql`(${t.leadId} is null) <> (${t.dealId} is null)`),
}));

export const notes = pgTable('notes', {
  id: pk(),
  companyId: text('company_id').references(() => companies.id, { onDelete: 'cascade' }),
  contactId: text('contact_id').references(() => contacts.id, { onDelete: 'cascade' }),
  leadId: text('lead_id').references(() => leads.id, { onDelete: 'cascade' }),
  dealId: text('deal_id').references(() => deals.id, { onDelete: 'cascade' }),
  body: jsonb('body').notNull().default({}),
  pinned: boolean('pinned').notNull().default(false),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  companyIdx: index('notes_company_idx').on(t.companyId),
  leadIdx: index('notes_lead_idx').on(t.leadId),
}));
