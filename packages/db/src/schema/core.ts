import { pgTable, text, timestamp, integer, boolean, jsonb, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
import { pk, timestamps, createdBy, version, deletedAt } from './_shared';

export const roles = pgTable('roles', {
  id: pk(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  isSystem: boolean('is_system').notNull().default(false),
  ...timestamps,
});

export const rolePermissions = pgTable('role_permissions', {
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permission: text('permission').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.roleId, t.permission] }),
}));

export const users = pgTable('users', {
  id: pk(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash'),
  roleId: text('role_id').notNull().references(() => roles.id),
  avatar: text('avatar'),
  timezone: text('timezone').notNull().default('UTC'),
  locale: text('locale').notNull().default('en'),
  /** How dates are written for this person: 'auto' follows the language. */
  dateFormat: text('date_format').notNull().default('auto'),
  isActive: boolean('is_active').notNull().default(true),
  actorType: text('actor_type').notNull().default('user'), // user | agent
  totpSecret: text('totp_secret'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  emailNotificationPrefs: jsonb('email_notification_prefs').notNull().default({}),
  ...timestamps,
  version: version(),
}, (t) => ({
  emailIdx: index('users_email_idx').on(t.email),
}));

export const sessions = pgTable('sessions', {
  id: pk(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  ...timestamps,
});

/**
 * Pending "sign in through the browser" handshakes from the desktop app.
 *
 * The desktop client keeps a secret verifier and sends only its hash, so a
 * different local app that hijacks the ordi:// deep link still cannot exchange
 * the code for a session (PKCE).
 */
export const desktopAuthRequests = pgTable('desktop_auth_requests', {
  id: pk(),
  /** Ties the browser page back to the desktop window that opened it. */
  state: text('state').notNull().unique(),
  /** sha256 of the verifier the desktop app kept to itself. */
  codeChallenge: text('code_challenge').notNull(),
  /** What the desktop calls itself, shown on the approval screen. */
  deviceLabel: text('device_label').notNull().default(''),
  /** Set once a signed-in user approves; the session is created on exchange. */
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  /** One-time code handed to the browser, redeemed by the desktop app. */
  code: text('code').unique(),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ...timestamps,
}, (t) => ({
  expiresIdx: index('desktop_auth_expires_idx').on(t.expiresAt),
}));

export const invites = pgTable('invites', {
  id: pk(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  roleId: text('role_id').notNull().references(() => roles.id),
  token: text('token').notNull().unique(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdBy: createdBy(),
  ...timestamps,
});

export const apiTokens = pgTable('api_tokens', {
  id: pk(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  hash: text('hash').notNull(),
  prefix: text('prefix').notNull(),
  scopes: jsonb('scopes').notNull().default([]),
  readOnly: boolean('read_only').notNull().default(false),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  hashIdx: uniqueIndex('api_tokens_hash_idx').on(t.hash),
}));

export const customFieldDefinitions = pgTable('custom_field_definitions', {
  id: pk(),
  entityType: text('entity_type').notNull(),
  key: text('key').notNull(),
  label: text('label').notNull(),
  type: text('type').notNull(),
  options: jsonb('options').notNull().default([]),
  required: boolean('required').notNull().default(false),
  position: integer('position').notNull().default(0),
  showInList: boolean('show_in_list').notNull().default(false),
  isSortable: boolean('is_sortable').notNull().default(false),
  indexed: boolean('indexed').notNull().default(false),
  deprecated: boolean('deprecated').notNull().default(false),
  ...timestamps,
}, (t) => ({
  entityKeyIdx: uniqueIndex('cfd_entity_key_idx').on(t.entityType, t.key),
}));

export const activityLog = pgTable('activity_log', {
  id: pk(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  actorId: text('actor_id'),
  actorType: text('actor_type').notNull().default('user'),
  action: text('action').notNull(),
  diff: jsonb('diff').notNull().default({}),
  sensitivity: text('sensitivity').notNull().default('normal'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  entityIdx: index('activity_entity_idx').on(t.entityType, t.entityId),
  actorIdx: index('activity_actor_idx').on(t.actorId),
  createdIdx: index('activity_created_idx').on(t.createdAt),
}));

export const notifications = pgTable('notifications', {
  id: pk(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  entityRef: text('entity_ref'),
  payload: jsonb('payload').notNull().default({}),
  readAt: timestamp('read_at', { withTimezone: true }),
  emailedAt: timestamp('emailed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index('notifications_user_idx').on(t.userId, t.readAt),
}));

/** Outbox (PRD §3.3): events written in the same tx as data. */
export const events = pgTable('events', {
  id: pk(),
  type: text('type').notNull(),
  aggregateType: text('aggregate_type').notNull(),
  aggregateId: text('aggregate_id').notNull(),
  payload: jsonb('payload').notNull().default({}),
  actorId: text('actor_id'),
  actorType: text('actor_type').notNull().default('system'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
}, (t) => ({
  unpublishedIdx: index('events_unpublished_idx').on(t.publishedAt, t.occurredAt),
  aggregateIdx: index('events_aggregate_idx').on(t.aggregateType, t.aggregateId),
}));

/** Dedup of at-least-once delivery (PRD §3.3). */
export const processedEvents = pgTable('processed_events', {
  consumer: text('consumer').notNull(),
  eventId: text('event_id').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.consumer, t.eventId] }),
}));

/** Dead-letter queue for exhausted retries (PRD §3.3). */
export const deadLetterEvents = pgTable('dead_letter_events', {
  id: pk(),
  consumer: text('consumer').notNull(),
  eventId: text('event_id').notNull(),
  error: text('error').notNull(),
  attempts: integer('attempts').notNull().default(0),
  payload: jsonb('payload').notNull().default({}),
  replayedAt: timestamp('replayed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const attachments = pgTable('attachments', {
  id: pk(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  fileKey: text('file_key').notNull(),
  filename: text('filename').notNull(),
  size: integer('size').notNull(),
  mime: text('mime').notNull(),
  createdBy: createdBy(),
  ...timestamps,
}, (t) => ({
  entityIdx: index('attachments_entity_idx').on(t.entityType, t.entityId),
}));

export const savedViews = pgTable('saved_views', {
  id: pk(),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id'),
  entityType: text('entity_type').notNull(),
  name: text('name').notNull(),
  filters: jsonb('filters').notNull().default({}),
  sort: jsonb('sort').notNull().default({}),
  layout: text('layout').notNull().default('list'),
  isShared: boolean('is_shared').notNull().default(false),
  createdBy: createdBy(),
  ...timestamps,
});

export const webhookSubscriptions = pgTable('webhook_subscriptions', {
  id: pk(),
  url: text('url').notNull(),
  secret: text('secret').notNull(),
  eventTypes: jsonb('event_types').notNull().default([]),
  active: boolean('active').notNull().default(true),
  createdBy: createdBy(),
  ...timestamps,
});

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: pk(),
  subscriptionId: text('subscription_id').notNull().references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
  eventId: text('event_id').notNull(),
  attempt: integer('attempt').notNull().default(0),
  status: text('status').notNull().default('pending'), // pending/delivered/failed/dead
  responseCode: integer('response_code'),
  responseBody: text('response_body'),
  nextRetryAt: timestamp('next_retry_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const dashboards = pgTable('dashboards', {
  id: pk(),
  ownerId: text('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  visibility: text('visibility').notNull().default('private'),
  ...timestamps,
  version: version(),
});

export const dashboardWidgets = pgTable('dashboard_widgets', {
  id: pk(),
  dashboardId: text('dashboard_id').notNull().references(() => dashboards.id, { onDelete: 'cascade' }),
  widgetType: text('widget_type').notNull(),
  source: text('source').notNull(),
  config: jsonb('config').notNull().default({}),
  layout: jsonb('layout').notNull().default({ x: 0, y: 0, w: 4, h: 3 }),
  ...timestamps,
});

/** Single-row workspace settings (PRD §14.7). */
export const workspaceSettings = pgTable('workspace_settings', {
  id: text('id').primaryKey().default('workspace'),
  name: text('name').notNull().default('ordi'),
  logo: text('logo'),
  legalDetails: jsonb('legal_details').notNull().default({}),
  workingDays: jsonb('working_days').notNull().default([1, 2, 3, 4, 5]),
  defaultCurrency: text('default_currency').notNull().default('USD'),
  defaultBillable: boolean('default_billable').notNull().default(true),
  defaultEstimateUnit: text('default_estimate_unit').notNull().default('hours'),
  sensitiveAuditRetentionMonths: integer('sensitive_audit_retention_months').notNull().default(24),
  /** Enabled workspace modules: { moduleKey: boolean }. Missing/true = enabled. */
  modules: jsonb('modules').notNull().default({}),
  /** Third-party integration config, e.g. { slackWebhookUrl }. Secrets masked in GET. */
  integrations: jsonb('integrations').notNull().default({}),
  /** Invoice branding: { accentColor?, footerNote?, paymentDetails?, showLogo? }. */
  invoiceSettings: jsonb('invoice_settings').notNull().default({}),
  ...timestamps,
});
