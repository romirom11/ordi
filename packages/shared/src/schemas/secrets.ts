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
 * Variables a secret may never become in an agent run. Not only the runtime's
 * own (PATH, HOME, the credential): a variable that changes how a program
 * behaves – what it loads (LD_PRELOAD, BASH_ENV, PYTHONPATH, NODE_OPTIONS),
 * where it connects (HTTPS_PROXY would route the model credential through
 * someone's proxy), which certificates it trusts – turns "may add a secret"
 * into "may run code as the agent". Checked when a secret is saved and again
 * when a run's environment is built, so a name saved under an older list
 * cannot slip in.
 */
export const RESERVED_SECRET_NAMES = [
  'PATH', 'HOME', 'LANG', 'LANGUAGE', 'TMPDIR', 'TMP', 'TEMP', 'SHELL', 'USER', 'LOGNAME', 'PWD', 'OLDPWD', 'TERM',
  'IFS', 'ENV', 'BASH_ENV', 'CDPATH', 'PROMPT_COMMAND', 'EDITOR', 'VISUAL', 'PAGER', 'BROWSER',
  'GCONV_PATH', 'HOSTALIASES', 'LOCALDOMAIN', 'RES_OPTIONS', 'TZ', 'TZDIR', 'NLSPATH', 'MALLOC_CHECK_',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'GOFLAGS', 'GOPROXY', 'CARGO_HOME', 'RUSTFLAGS',
  'CI', 'NO_COLOR', 'DISABLE_AUTOUPDATER', 'DISABLE_TELEMETRY', 'MCP_TIMEOUT', 'MCP_TOOL_TIMEOUT',
];
export const RESERVED_SECRET_PREFIXES = [
  'ANTHROPIC_', 'CLAUDE_', 'CODEX_', 'OPENAI_', 'ORDI_', 'MCP_',
  'LD_', 'DYLD_', 'LC_', 'XDG_',
  'NODE_', 'NPM_', 'YARN_', 'PNPM_', 'BUN_', 'DENO_', 'PYTHON', 'PIP_', 'PERL', 'RUBY', 'GEM_', 'BUNDLE_', 'COMPOSER_',
  'GIT_', 'SSH_', 'GPG_', 'GNUPG',
];
/** Proxies route every request – the model credential with it – through someone else's server. */
const RESERVED_SECRET_SUFFIXES = ['_PROXY'];

export function isReservedSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  return RESERVED_SECRET_NAMES.includes(upper)
    || RESERVED_SECRET_PREFIXES.some((p) => upper.startsWith(p))
    || RESERVED_SECRET_SUFFIXES.some((s) => upper.endsWith(s));
}

/** A variable name an agent run may receive: plain upper snake case, and not reserved. */
export function isAllowedSecretVariable(name: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,127}$/.test(name) && !isReservedSecretName(name);
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

/**
 * The environment variables a secret becomes in an agent run (plan R23): the
 * secret's name for a one-field secret, `<NAME>__<FIELD>` otherwise. Decided by
 * how many fields the secret has, not how many are filled, so a variable keeps
 * its name when a second value is added later. Only fields with a value appear.
 */
export function secretEnvVars(
  secretName: string,
  fields: { key: string; hasValue: boolean }[],
): { field: string; variable: string }[] {
  const single = fields.length === 1;
  return fields.filter((f) => f.hasValue)
    .map((f) => ({ field: f.key, variable: single ? secretName : `${secretName}__${f.key.toUpperCase()}` }))
    .filter((v) => isAllowedSecretVariable(v.variable));
}
