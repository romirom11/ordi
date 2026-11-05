/**
 * Project secrets (plan 2026-11-05-001): credentials a client hands over –
 * logins, test API keys, staging passwords – kept with the project they
 * belong to and listed among its resources.
 *
 * The values live in `project_secret_payloads`, one AES-GCM blob per secret,
 * in a table of their own so no select() of secrets can return them by
 * accident. `fields` on the secret holds only what lists may show: keys,
 * labels, types and whether a value is set.
 *
 * When it was last opened is read from its trail (activity_log), not kept
 * here: every update bumps `version`, and a reveal must not make the person
 * editing the secret at that moment lose their edit to a conflict.
 *
 * Who may reach a secret is three layers (calc/rbac secretAccess): the
 * workspace role, the project role, and the audience below.
 */
import { pgTable, text, boolean, jsonb, timestamp, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
import { pk, timestamps, createdBy, version } from './_shared';
import { projects } from './projects';

/**
 * A workspace's connection to an external secret store (Doppler first, plan
 * U5). The token is read-only and scoped to one config; it is stored
 * encrypted and never returned. Secrets that live there keep only a
 * reference in ordi and are fetched when someone reveals one or a run starts.
 */
export const secretProviderConnections = pgTable('secret_provider_connections', {
  id: pk(),
  /** doppler */
  kind: text('kind').notNull(),
  label: text('label').notNull(),
  /** encrypt(JSON { token }) – lib/crypto, v1 format. */
  credentials: text('credentials').notNull(),
  /** Where the token points, for display and for the API calls that need it: { project, config }. */
  config: jsonb('config').notNull().default({}),
  /** ok | error – from the last call to the provider. */
  status: text('status').notNull().default('ok'),
  lastError: text('last_error'),
  checkedAt: timestamp('checked_at', { withTimezone: true }),
  createdBy: createdBy(),
  ...timestamps,
});

/** Which projects may add secrets from a connection. */
export const projectSecretProviderLinks = pgTable('project_secret_provider_links', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id').notNull().references(() => secretProviderConnections.id, { onDelete: 'cascade' }),
  createdBy: createdBy(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.projectId, t.connectionId] }),
  connectionIdx: index('project_secret_provider_links_connection_idx').on(t.connectionId),
}));

export const projectSecrets = pgTable('project_secrets', {
  id: pk(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  /** Upper snake case, unique per project: the environment variable it becomes in an agent run. */
  name: text('name').notNull(),
  description: text('description'),
  /** test | staging | production | other – said by the person saving it. */
  environment: text('environment').notNull(),
  /** ordi, or provider: the values live in Doppler and the like, and each field names the provider secret it reads. */
  source: text('source').notNull().default('ordi'),
  /** source = provider. Null once the connection is removed: the secret is then disconnected, its metadata kept. */
  providerConnectionId: text('provider_connection_id').references(() => secretProviderConnections.id, { onDelete: 'set null' }),
  /** The date the credential itself stops working, YYYY-MM-DD. */
  expiresAt: text('expires_at'),
  availableToAgents: boolean('available_to_agents').notNull().default(false),
  /** [{ key, label, type, hasValue, ref? }] – metadata only, never a value. `ref` is the provider secret's name. */
  fields: jsonb('fields').notNull().default([]),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
}, (t) => ({
  nameIdx: uniqueIndex('project_secrets_name_idx').on(t.projectId, t.name),
}));

/** Who a secret is shared with: the whole project, a person, or a department (with its sub-departments). */
export const projectSecretAudience = pgTable('project_secret_audience', {
  secretId: text('secret_id').notNull().references(() => projectSecrets.id, { onDelete: 'cascade' }),
  /** project | user | department */
  principalType: text('principal_type').notNull(),
  /** The user or department id; '' for the project principal. */
  principalId: text('principal_id').notNull().default(''),
}, (t) => ({
  pk: primaryKey({ columns: [t.secretId, t.principalType, t.principalId] }),
  principalIdx: index('project_secret_audience_principal_idx').on(t.principalType, t.principalId),
}));

export const projectSecretPayloads = pgTable('project_secret_payloads', {
  secretId: text('secret_id').primaryKey().references(() => projectSecrets.id, { onDelete: 'cascade' }),
  /** encrypt(JSON { [fieldKey]: value }) – lib/crypto, v1 format. */
  ciphertext: text('ciphertext').notNull(),
  ...timestamps,
});
