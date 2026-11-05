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
 * Who may reach a secret is three layers (calc/rbac secretAccess): the
 * workspace role, the project role, and the audience below.
 */
import { pgTable, text, boolean, jsonb, timestamp, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
import { pk, timestamps, createdBy, version } from './_shared';
import { users } from './core';
import { projects } from './projects';

export const projectSecrets = pgTable('project_secrets', {
  id: pk(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  /** Upper snake case, unique per project: the environment variable it becomes in an agent run. */
  name: text('name').notNull(),
  description: text('description'),
  /** test | staging | production | other – said by the person saving it. */
  environment: text('environment').notNull(),
  /** ordi now; provider for secrets that live in Doppler and the like (a later phase). */
  source: text('source').notNull().default('ordi'),
  /** The date the credential itself stops working, YYYY-MM-DD. */
  expiresAt: text('expires_at'),
  availableToAgents: boolean('available_to_agents').notNull().default(false),
  /** [{ key, label, type, hasValue }] – metadata only, never a value. */
  fields: jsonb('fields').notNull().default([]),
  lastRevealedAt: timestamp('last_revealed_at', { withTimezone: true }),
  lastRevealedBy: text('last_revealed_by').references(() => users.id, { onDelete: 'set null' }),
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
