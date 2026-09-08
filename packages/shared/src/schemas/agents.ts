/**
 * AI agent employees (plan 2026-09-05-001): agents, workspace Claude
 * credentials, MCP connectors and runs. One source of truth for API, web and
 * MCP – the same Zod shapes validate requests and describe forms.
 */
import { z } from 'zod';
import { idSchema } from './common';
import {
  AGENT_ASSIGN_POLICIES, AGENT_CREDENTIAL_KINDS, AGENT_CREDENTIAL_PROVIDERS, AGENT_CREDENTIAL_SLOTS,
  AGENT_RUN_STATUSES, AGENT_RUN_TRIGGERS, EXECUTABLE_AGENT_RUNTIMES,
  MCP_CONNECTOR_AUTH_MODES, MCP_CONNECTOR_TRANSPORTS,
} from '../constants';

// ── Agents ──

/** Only executable runtimes are accepted; `codex` is reserved and shown as coming soon. */
export const agentRuntimeSchema = z.enum(EXECUTABLE_AGENT_RUNTIMES);

export const agentProfileFieldsSchema = z.object({
  runtime: agentRuntimeSchema.default('claude_code'),
  /** Runtime model alias or id; null = the runtime's default. */
  model: z.string().trim().max(100).nullable().optional(),
  instructions: z.string().max(20_000).default(''),
  completionCategory: z.enum(['in_review']).default('in_review'),
  assignPolicy: z.enum(AGENT_ASSIGN_POLICIES).default('project_members'),
  maxRunMinutes: z.number().int().min(1).max(24 * 60).default(30),
  maxTurns: z.number().int().min(1).max(2000).default(200),
  maxBudgetUsd: z.number().min(0).max(10_000).nullable().optional(),
  concurrency: z.number().int().min(1).max(10).default(1),
  credentialId: idSchema.nullable().optional(),
  fallbackCredentialId: idSchema.nullable().optional(),
  connectorIds: z.array(idSchema).default([]),
  enabled: z.boolean().default(true),
});

export const createAgentSchema = agentProfileFieldsSchema.extend({
  name: z.string().trim().min(1).max(120),
  /** Optional: the login-less mailbox used only as the users.email key. */
  email: z.string().email().optional(),
  roleId: idSchema.optional(),
  avatar: z.string().nullable().optional(),
  timezone: z.string().optional(),
  locale: z.enum(['en', 'uk']).optional(),
});
export type CreateAgentInput = z.infer<typeof createAgentSchema>;

export const updateAgentSchema = agentProfileFieldsSchema.partial().extend({
  name: z.string().trim().min(1).max(120).optional(),
  roleId: idSchema.optional(),
  avatar: z.string().nullable().optional(),
  version: z.number().int().min(1),
});
export type UpdateAgentInput = z.infer<typeof updateAgentSchema>;

// ── Credentials ──

export const agentCredentialInputSchema = z.object({
  provider: z.enum(AGENT_CREDENTIAL_PROVIDERS).default('anthropic'),
  kind: z.enum(AGENT_CREDENTIAL_KINDS),
  label: z.string().trim().min(1).max(120),
  secret: z.string().trim().min(8).max(4096),
  slot: z.enum(AGENT_CREDENTIAL_SLOTS).nullable().optional(),
  /** Subscription tokens live a year; the owner may record the exact date. */
  expiresAt: z.string().datetime().nullable().optional(),
}).refine((v) => v.provider === 'anthropic', { message: 'Only Anthropic credentials are supported yet', path: ['provider'] });
export type AgentCredentialInput = z.infer<typeof agentCredentialInputSchema>;

export const updateAgentCredentialSchema = z.object({
  label: z.string().trim().min(1).max(120).optional(),
  slot: z.enum(AGENT_CREDENTIAL_SLOTS).nullable().optional(),
  /** Rotate: a new secret replaces the old one; status returns to active. */
  secret: z.string().trim().min(8).max(4096).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  version: z.number().int().min(1),
});

// ── Connectors ──

const slugSchema = z.string().trim().min(2).max(40).regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes');

const secretMap = z.record(z.string().min(1).max(200), z.string().max(4096));

/** A connector added by URL. stdio is library-only (R19). */
export const customMcpConnectorInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slugSchema.optional(),
  transport: z.enum(MCP_CONNECTOR_TRANSPORTS).default('http'),
  url: z.string().url(),
  authMode: z.enum(MCP_CONNECTOR_AUTH_MODES).default('none'),
  /** For `bearer`: the token. */
  bearer: z.string().max(4096).optional(),
  /** For `headers`: header name → value. */
  headers: secretMap.optional(),
  /** For `oauth` against a provider without dynamic registration. */
  oauthClientId: z.string().max(400).optional(),
  oauthClientSecret: z.string().max(4096).optional(),
}).superRefine((v, ctx) => {
  if (v.transport === 'stdio') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['transport'], message: 'Custom stdio connectors are not accepted; pick a library entry instead' });
  if (!v.url.startsWith('https://') && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(v.url)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'Connector URLs must use https' });
  }
  if (v.authMode === 'bearer' && !v.bearer) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['bearer'], message: 'Token is required' });
  if (v.authMode === 'headers' && !v.headers) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['headers'], message: 'Headers are required' });
});
export type CustomMcpConnectorInput = z.infer<typeof customMcpConnectorInputSchema>;

/** A connector from the curated library: the admin supplies only the entry's secrets. */
export const libraryMcpConnectorInputSchema = z.object({
  libraryKey: z.string().min(1),
  name: z.string().trim().min(1).max(120).optional(),
  slug: slugSchema.optional(),
  secrets: secretMap.default({}),
});
export type LibraryMcpConnectorInput = z.infer<typeof libraryMcpConnectorInputSchema>;

export const updateMcpConnectorSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  /** Rotate secrets: the given keys replace the stored ones; absent keys are kept. */
  bearer: z.string().max(4096).optional(),
  headers: secretMap.optional(),
  secrets: secretMap.optional(),
  version: z.number().int().min(1),
});

// ── Runs ──

export const agentRunStatusSchema = z.enum(AGENT_RUN_STATUSES);
export const agentRunTriggerSchema = z.enum(AGENT_RUN_TRIGGERS);

export const listAgentRunsQuerySchema = z.object({
  taskId: idSchema.optional(),
  agentUserId: idSchema.optional(),
  status: agentRunStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Public shape of the workspace's Claude connection – secrets never included. */
export const agentCredentialViewSchema = z.object({
  id: idSchema,
  provider: z.enum(AGENT_CREDENTIAL_PROVIDERS),
  kind: z.enum(AGENT_CREDENTIAL_KINDS),
  label: z.string(),
  slot: z.enum(AGENT_CREDENTIAL_SLOTS).nullable(),
  status: z.string(),
  expiresAt: z.string().nullable(),
  lastVerifiedAt: z.string().nullable(),
  lastVerifyError: z.string().nullable(),
  connectedBy: z.string().nullable(),
  connectedAt: z.string(),
  version: z.number(),
});
