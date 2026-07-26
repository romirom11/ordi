import { z } from 'zod';
import { MODULE_KEYS } from '../constants';

/** First-run setup (POST /setup): creates the owner + baseline config. */
export const setupSchema = z.object({
  workspaceName: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});
export type SetupInput = z.infer<typeof setupSchema>;

/** Enabled modules map: { moduleKey: boolean }. Missing key or true = enabled. */
export const modulesSchema = z.record(z.enum(MODULE_KEYS), z.boolean());

/** Third-party integration config. Secrets are masked in non-privileged GET. */
export const integrationsSchema = z.object({
  slackWebhookUrl: z.string().url().nullable().optional(),
});

/** Invoice branding rendered on the public invoice page and PDF. */
export const invoiceSettingsSchema = z.object({
  accentColor: z.string().max(32).nullable().optional(),
  footerNote: z.string().max(2000).nullable().optional(),
  paymentDetails: z.string().max(4000).nullable().optional(),
  showLogo: z.boolean().optional(),
});
export type InvoiceSettings = z.infer<typeof invoiceSettingsSchema>;

/** PATCH /settings/workspace – all fields optional. */
export const workspaceSettingsUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  logo: z.string().nullable().optional(),
  legalDetails: z.record(z.string(), z.unknown()).optional(),
  workingDays: z.array(z.number().int()).optional(),
  defaultCurrency: z.string().optional(),
  defaultBillable: z.boolean().optional(),
  defaultEstimateUnit: z.string().optional(),
  sensitiveAuditRetentionMonths: z.number().int().optional(),
  modules: modulesSchema.optional(),
  integrations: integrationsSchema.optional(),
  invoiceSettings: invoiceSettingsSchema.optional(),
});

/**
 * Integration settings editable from the UI (Settings → Integrations).
 * Secrets are write-only: the API never returns them, so an omitted or empty
 * secret means "keep whatever is stored".
 */
export const integrationsConfigSchema = z.object({
  smtp: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().default(''),
    pass: z.string().optional(),
    from: z.string().min(1),
  }).optional(),
  github: z.object({
    clientId: z.string(),
    clientSecret: z.string().optional(),
  }).optional(),
  githubApp: z.object({
    appId: z.string(),
    slug: z.string(),
    privateKey: z.string().optional(),
    webhookSecret: z.string().optional(),
    htmlUrl: z.string().optional(),
  }).optional(),
  slack: z.object({
    clientId: z.string(),
    clientSecret: z.string().optional(),
  }).optional(),
});
export type IntegrationsConfigInput = z.infer<typeof integrationsConfigSchema>;
