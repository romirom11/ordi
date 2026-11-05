/**
 * Project secrets (plan 2026-11-05-001): credentials a client hands over,
 * stored encrypted and reached through the access rule in calc/rbac
 * (secretAccess). Values only ever travel inbound here, and out through
 * POST /project-secrets/:id/reveal.
 */
import { z } from 'zod';
import { idSchema } from './common';

/** Who says it is a test key: the person saving it. Decides who may hand it to agents. */
export const SECRET_ENVIRONMENTS = ['test', 'staging', 'production', 'other'] as const;
export type SecretEnvironment = (typeof SECRET_ENVIRONMENTS)[number];

/** url and text show without a reveal; the rest are secret. */
export const SECRET_FIELD_TYPES = ['text', 'url', 'password', 'api_key', 'note'] as const;
export type SecretFieldType = (typeof SECRET_FIELD_TYPES)[number];
export const SECRET_VALUE_TYPES: readonly SecretFieldType[] = ['password', 'api_key', 'note'];

/**
 * Environment variable names an agent run already uses (runtime/claude-code.ts
 * and the git checkout). A secret named after one of them would override it.
 */
export const RESERVED_SECRET_NAMES = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'SHELL', 'USER', 'PWD', 'NODE_OPTIONS', 'MCP_TIMEOUT', 'MCP_TOOL_TIMEOUT'];
export const RESERVED_SECRET_PREFIXES = ['ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'OPENAI_', 'GIT_', 'ORDI_', 'NODE_', 'NPM_'];

export function isReservedSecretName(name: string): boolean {
  return RESERVED_SECRET_NAMES.includes(name) || RESERVED_SECRET_PREFIXES.some((p) => name.startsWith(p));
}

/** Upper snake case, so it reads as the environment variable it becomes in an agent run. */
export const secretNameSchema = z.string().trim()
  .regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'Use capital letters, digits and underscores, starting with a letter (e.g. STRIPE_TEST)')
  .refine((v) => !v.includes('__'), 'Double underscores separate a secret from its field in agent runs')
  .refine((v) => !isReservedSecretName(v), 'This name is used by the agent runtime itself');

export const secretFieldKeySchema = z.string().trim()
  .regex(/^[a-z][a-z0-9_]{0,31}$/, 'Use lower case letters, digits and underscores (e.g. api_key)');

/** People open a url field with a click: http(s) only, never `javascript:` or `file:`. */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export const secretFieldInputSchema = z.object({
  key: secretFieldKeySchema,
  label: z.string().trim().min(1).max(80),
  type: z.enum(SECRET_FIELD_TYPES),
  /** Omitted on update: keep the stored value. An empty string clears it. */
  value: z.string().max(10_000).optional(),
}).refine((f) => f.type !== 'url' || !f.value || isHttpUrl(f.value.trim()), {
  message: 'A URL field takes an http(s) address', path: ['value'],
});

export const secretAudienceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('project') }),
  z.object({ type: z.literal('user'), id: idSchema }),
  z.object({ type: z.literal('department'), id: idSchema }),
]);

const fieldsSchema = z.array(secretFieldInputSchema).min(1).max(20)
  .refine((fields) => new Set(fields.map((f) => f.key)).size === fields.length, 'Field keys must be unique');
const audienceSchema = z.array(secretAudienceSchema).min(1, 'Choose who can see the values').max(100);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const secretInputSchema = z.object({
  name: secretNameSchema,
  description: z.string().trim().max(500).optional(),
  environment: z.enum(SECRET_ENVIRONMENTS),
  expiresAt: dateSchema.nullable().optional(),
  availableToAgents: z.boolean().optional(),
  audience: audienceSchema,
  fields: fieldsSchema,
});

export const secretPatchSchema = z.object({
  description: z.string().trim().max(500).nullable().optional(),
  environment: z.enum(SECRET_ENVIRONMENTS).optional(),
  expiresAt: dateSchema.nullable().optional(),
  availableToAgents: z.boolean().optional(),
  audience: audienceSchema.optional(),
  /** The full field list: a field left out is removed, a value left out is kept. */
  fields: fieldsSchema.optional(),
  version: z.number().int().optional(),
});

export const secretAudiencePreviewSchema = z.object({ audience: z.array(secretAudienceSchema).max(100) });

export const secretRevealSchema = z.object({
  field: secretFieldKeySchema,
  /** What the person did with it, for the trail: shown on screen or copied without showing. */
  purpose: z.enum(['reveal', 'copy']).default('reveal'),
});
