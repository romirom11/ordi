/**
 * AI agent employees (plan 2026-09-05-001). An agent is a `users` row with
 * actor_type = 'agent'; these tables carry what a person does not have: the
 * runtime profile, the workspace's provider credentials, the MCP connector
 * library with per-agent grants, and the runs the platform executes.
 *
 * Secrets (credential secrets, connector headers/env, OAuth tokens) are
 * AES-GCM blobs written by the API and decrypted only inside the gateway or
 * the worker – never returned by a route.
 */
import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, integer, boolean, jsonb, numeric, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
import { pk, timestamps, version, createdBy } from './_shared';
import { users } from './core';
import { tasks, projects } from './projects';

/** Workspace-level provider credentials: the owner connects Claude once. */
export const agentCredentials = pgTable('agent_credentials', {
  id: pk(),
  provider: text('provider').notNull(), // anthropic | openai
  kind: text('kind').notNull(), // api_key | subscription
  label: text('label').notNull(),
  secret: text('secret').notNull(), // AES-GCM encrypted, never returned
  /** primary | fallback | null – at most one of each per workspace. */
  slot: text('slot'),
  status: text('status').notNull().default('active'), // active | expired | revoked
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  lastVerifyError: text('last_verify_error'),
  connectedBy: text('connected_by'),
  connectedAt: timestamp('connected_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ...timestamps,
  version: version(),
}, (t) => ({
  slotIdx: uniqueIndex('agent_credentials_slot_idx').on(t.slot).where(sql`slot is not null and status = 'active'`),
}));

/** 1:1 with an agent user. Without a row the user is never dispatched. */
export const agentProfiles = pgTable('agent_profiles', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  runtime: text('runtime').notNull().default('claude_code'), // claude_code | codex
  model: text('model'),
  instructions: text('instructions').notNull().default(''),
  completionCategory: text('completion_category').notNull().default('in_review'),
  assignPolicy: text('assign_policy').notNull().default('project_members'),
  maxRunMinutes: integer('max_run_minutes').notNull().default(30),
  maxTurns: integer('max_turns').notNull().default(60),
  maxBudgetUsd: numeric('max_budget_usd', { precision: 10, scale: 2 }),
  concurrency: integer('concurrency').notNull().default(1),
  /** Overrides of the workspace primary/fallback credentials. */
  credentialId: text('credential_id').references(() => agentCredentials.id, { onDelete: 'set null' }),
  fallbackCredentialId: text('fallback_credential_id').references(() => agentCredentials.id, { onDelete: 'set null' }),
  enabled: boolean('enabled').notNull().default(true),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
});

/** Workspace MCP connector library entry (from the catalogue or by URL). */
export const mcpConnectors = pgTable('mcp_connectors', {
  id: pk(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  source: text('source').notNull(), // library | custom
  libraryKey: text('library_key'),
  transport: text('transport').notNull(), // http | sse | stdio
  url: text('url'),
  command: text('command'),
  args: jsonb('args').notNull().default([]),
  authMode: text('auth_mode').notNull().default('none'), // none | bearer | headers | oauth
  /** AES-GCM encrypted JSON { headers?: {}, env?: {} }. */
  secrets: text('secrets'),
  status: text('status').notNull().default('active'), // active | needs_auth | disabled
  /** Cached tools/list: [{ name, description }]. */
  tools: jsonb('tools').notNull().default([]),
  lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
  lastError: text('last_error'),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
});

/** OAuth 2.1 client state for a connector ordi authorized itself (R38). */
export const mcpConnectorOauth = pgTable('mcp_connector_oauth', {
  connectorId: text('connector_id').primaryKey().references(() => mcpConnectors.id, { onDelete: 'cascade' }),
  resourceMetadataUrl: text('resource_metadata_url'),
  authorizationServer: text('authorization_server'),
  /** AES-GCM encrypted JSON of the registered client (client_id, client_secret, ...). */
  clientInfo: text('client_info'),
  /** AES-GCM encrypted JSON of the token set (access_token, refresh_token, scope, ...). */
  tokens: text('tokens'),
  accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
  /** In-flight authorization: state + encrypted PKCE verifier, cleared on callback. */
  pendingState: text('pending_state'),
  pendingVerifier: text('pending_verifier'),
  pendingStartedAt: timestamp('pending_started_at', { withTimezone: true }),
  authorizedBy: text('authorized_by'),
  authorizedAt: timestamp('authorized_at', { withTimezone: true }),
  ...timestamps,
});

/** Which connectors an agent may use (the built-in `ordi` server is implicit). */
export const agentConnectors = pgTable('agent_connectors', {
  agentUserId: text('agent_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectorId: text('connector_id').notNull().references(() => mcpConnectors.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.agentUserId, t.connectorId] }),
}));

/** One execution of an agent against a task. */
export const agentRuns = pgTable('agent_runs', {
  id: pk(),
  agentUserId: text('agent_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  trigger: text('trigger').notNull(), // assigned | comment | retry | manual
  status: text('status').notNull().default('queued'),
  runtime: text('runtime').notNull(),
  credentialId: text('credential_id'),
  /** Runtime session to resume for follow-ups. */
  sessionId: text('session_id'),
  parentRunId: text('parent_run_id'),
  /** Who caused the run: the assigner or commenter. */
  requestedBy: text('requested_by'),
  commentId: text('comment_id'),
  prompt: text('prompt').notNull().default(''),
  workerId: text('worker_id'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
  /** The per-run api_tokens row, revoked at finish. */
  tokenId: text('token_id'),
  branch: text('branch'),
  prUrl: text('pr_url'),
  summary: text('summary'),
  error: text('error'),
  /** { inputTokens, outputTokens, costUsd, turns, durationMs } as reported by the runtime. */
  usage: jsonb('usage').notNull().default({}),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  ...timestamps,
  version: version(),
}, (t) => ({
  /** One active run per task (R13). */
  taskActiveIdx: uniqueIndex('agent_runs_task_active_idx').on(t.taskId)
    .where(sql`status in ('queued', 'claimed', 'running', 'waiting_quota')`),
  statusIdx: index('agent_runs_status_idx').on(t.status, t.nextAttemptAt),
  agentIdx: index('agent_runs_agent_idx').on(t.agentUserId, t.createdAt),
  taskIdx: index('agent_runs_task_idx').on(t.taskId, t.createdAt),
}));

/** Live log of a run: SDK messages, connector calls and lifecycle changes. */
export const agentRunEvents = pgTable('agent_run_events', {
  id: pk(),
  runId: text('run_id').notNull().references(() => agentRuns.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  type: text('type').notNull(), // status | init | assistant | tool_use | tool_result | connector_call | result | error | log
  payload: jsonb('payload').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runSeqIdx: uniqueIndex('agent_run_events_run_seq_idx').on(t.runId, t.seq),
}));

/** Heartbeat of each agent worker process, so Settings can show it online. */
export const agentWorkers = pgTable('agent_workers', {
  id: text('id').primaryKey(), // host:pid
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  concurrency: integer('concurrency').notNull().default(1),
  running: integer('running').notNull().default(0),
  runtimeAvailable: boolean('runtime_available').notNull().default(false),
  version: text('version').notNull().default(''),
});
