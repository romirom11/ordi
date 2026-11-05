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

/** Upper snake case: an agent run gets it as SECRET_<NAME> (SECRET_ENV_PREFIX). */
export const secretNameSchema = z.string().trim()
  .regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'Use capital letters, digits and underscores, starting with a letter (e.g. STRIPE_TEST)')
  .refine((v) => !v.includes('__'), 'Double underscores separate a secret from its field in agent runs');

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

/** The name of a secret in an external provider (Doppler: letters, digits, underscores). */
export const providerSecretRefSchema = z.string().trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,255}$/, 'A provider secret name is letters, digits and underscores');

export const secretFieldInputSchema = z.object({
  key: secretFieldKeySchema,
  label: z.string().trim().min(1).max(80),
  type: z.enum(SECRET_FIELD_TYPES),
  /** Omitted on update: keep the stored value. An empty string clears it. */
  value: z.string().max(10_000).optional(),
  /** Provider secrets only: the provider secret this field reads. Its value is never stored in ordi. */
  ref: providerSecretRefSchema.optional(),
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

export const SECRET_SOURCES = ['ordi', 'provider'] as const;

export const secretInputSchema = z.object({
  name: secretNameSchema,
  description: z.string().trim().max(500).optional(),
  environment: z.enum(SECRET_ENVIRONMENTS),
  expiresAt: dateSchema.nullable().optional(),
  availableToAgents: z.boolean().optional(),
  audience: audienceSchema,
  fields: fieldsSchema,
  /** provider: the values stay in the connection's store; each field names its secret there (`ref`). */
  source: z.enum(SECRET_SOURCES).default('ordi'),
  connectionId: idSchema.optional(),
}).superRefine((s, ctx) => {
  if (s.source === 'provider') {
    if (!s.connectionId) ctx.addIssue({ code: 'custom', path: ['connectionId'], message: 'Choose the connection the secret lives in' });
    s.fields.forEach((f, i) => {
      if (!f.ref) ctx.addIssue({ code: 'custom', path: ['fields', i, 'ref'], message: 'Choose which provider secret this field reads' });
      if (f.value) ctx.addIssue({ code: 'custom', path: ['fields', i, 'value'], message: 'A provider secret keeps its values in the provider' });
    });
  } else {
    if (s.connectionId) ctx.addIssue({ code: 'custom', path: ['connectionId'], message: 'Only a provider secret has a connection' });
    s.fields.forEach((f, i) => {
      if (f.ref) ctx.addIssue({ code: 'custom', path: ['fields', i, 'ref'], message: 'Only a provider secret reads from a provider' });
    });
  }
});

export const secretPatchSchema = z.object({
  description: z.string().trim().max(500).nullable().optional(),
  environment: z.enum(SECRET_ENVIRONMENTS).optional(),
  expiresAt: dateSchema.nullable().optional(),
  availableToAgents: z.boolean().optional(),
  audience: audienceSchema.optional(),
  /** The full field list: a field left out is removed, a value left out is kept. */
  fields: fieldsSchema.optional(),
  /** Provider secrets: relink to another connection the project may use (a disconnected secret, a new token). */
  connectionId: idSchema.optional(),
  version: z.number().int().optional(),
});

// ── External providers (plan U5) ──

export const SECRET_PROVIDER_KINDS = ['doppler'] as const;
export type SecretProviderKind = (typeof SECRET_PROVIDER_KINDS)[number];

/** Doppler project and config slugs. */
const providerSlugSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/, 'Letters, digits, dots, dashes and underscores');

export const secretProviderConnectionInputSchema = z.object({
  kind: z.enum(SECRET_PROVIDER_KINDS),
  label: z.string().trim().max(80).optional(),
  /** A read-only service token scoped to one config. Write-only: never returned. */
  token: z.string().trim().min(8).max(1000),
  /** Read back from the token when left out. */
  project: providerSlugSchema.optional(),
  config: providerSlugSchema.optional(),
});

export const secretProviderConnectionPatchSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  /** A new token replaces the old one, verified first. */
  token: z.string().trim().min(8).max(1000).optional(),
  project: providerSlugSchema.optional(),
  config: providerSlugSchema.optional(),
});

export const secretProviderLinksSchema = z.object({ projectIds: z.array(idSchema).max(1000) });

export const secretAudiencePreviewSchema = z.object({ audience: z.array(secretAudienceSchema).max(100) });

export const secretRevealSchema = z.object({
  field: secretFieldKeySchema,
  /** What the person did with it, for the trail: shown on screen or copied without showing. */
  purpose: z.enum(['reveal', 'copy']).default('reveal'),
});

/**
 * Every variable a secret becomes starts with this. No program reads a
 * `SECRET_` variable on its own, so whatever a secret is named – PATH,
 * HTTPS_PROXY, LD_PRELOAD – it cannot change how the agent's tools behave:
 * an allowlist by construction, where a list of dangerous names never ends.
 * Code that wants a particular name maps it: `STRIPE_KEY=$SECRET_STRIPE_TEST`.
 */
export const SECRET_ENV_PREFIX = 'SECRET_';

/** A variable an agent run may receive: `SECRET_` followed by upper snake case. */
export function isAllowedSecretVariable(name: string): boolean {
  return /^SECRET_[A-Z][A-Z0-9_]{0,127}$/.test(name);
}

/**
 * The environment variables a secret becomes in an agent run (plan R23):
 * `SECRET_<NAME>` for a one-field secret, `SECRET_<NAME>__<FIELD>` otherwise.
 * Decided by how many fields the secret has, not how many are filled, so a
 * variable keeps its name when a second value is added later. Only fields
 * with a value appear.
 */
export function secretEnvVars(
  secretName: string,
  fields: { key: string; hasValue: boolean }[],
): { field: string; variable: string }[] {
  const single = fields.length === 1;
  const base = `${SECRET_ENV_PREFIX}${secretName}`;
  return fields.filter((f) => f.hasValue)
    .map((f) => ({ field: f.key, variable: single ? base : `${base}__${f.key.toUpperCase()}` }))
    .filter((v) => isAllowedSecretVariable(v.variable));
}
