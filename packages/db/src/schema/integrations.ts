import { pgTable, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { pk, timestamps, createdBy } from './_shared';
import { tasks } from './projects';

export const gitConnections = pgTable('git_connections', {
  id: pk(),
  provider: text('provider').notNull(), // github | gitlab | gitea
  instanceUrl: text('instance_url'),
  credentials: jsonb('credentials').notNull().default({}), // AES-GCM encrypted blob
  webhookSecret: text('webhook_secret').notNull().default(''),
  status: text('status').notNull().default('connected'),
  createdBy: createdBy(),
  ...timestamps,
});

export const gitRepositories = pgTable('git_repositories', {
  id: pk(),
  connectionId: text('connection_id').notNull().references(() => gitConnections.id, { onDelete: 'cascade' }),
  externalId: text('external_id').notNull(),
  fullName: text('full_name').notNull(),
  defaultBranch: text('default_branch').notNull().default('main'),
  ...timestamps,
}, (t) => ({
  connIdx: index('git_repositories_conn_idx').on(t.connectionId),
}));

export const gitLinks = pgTable('git_links', {
  id: pk(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  repositoryId: text('repository_id').references(() => gitRepositories.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // branch | commit | pr | mr
  externalRef: text('external_ref').notNull(),
  title: text('title'),
  url: text('url'),
  state: text('state'), // open | merged | closed
  author: text('author'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  taskIdx: index('git_links_task_idx').on(t.taskId),
  refIdx: index('git_links_ref_idx').on(t.type, t.externalRef),
}));

/** Idempotency for incoming git webhooks (dedup by delivery id). */
export const gitWebhookDeliveries = pgTable('git_webhook_deliveries', {
  deliveryId: text('delivery_id').primaryKey(),
  provider: text('provider').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Workspace Slack connection (OAuth v2, Linear-style). Single-row semantics:
 * a reconnect replaces the existing row. The bot token is stored as an AES-GCM
 * encrypted blob in a jsonb column (same at-rest pattern as git credentials) and
 * is NEVER returned in any response.
 */
export const slackConnections = pgTable('slack_connections', {
  id: pk(),
  teamId: text('team_id').notNull(),
  teamName: text('team_name').notNull().default(''),
  botToken: jsonb('bot_token').notNull().default({}), // AES-GCM encrypted blob, never returned
  scope: text('scope').notNull().default(''),
  createdBy: createdBy(),
  ...timestamps,
});
