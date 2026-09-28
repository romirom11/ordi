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

/**
 * Invoice branding rendered on the public invoice page and PDF, plus the text
 * every new invoice/quote starts with (defaultNotes/defaultTerms) so the
 * same payment terms are not retyped per document.
 */
export const invoiceSettingsSchema = z.object({
  accentColor: z.string().max(32).nullable().optional(),
  footerNote: z.string().max(2000).nullable().optional(),
  paymentDetails: z.string().max(4000).nullable().optional(),
  showLogo: z.boolean().optional(),
  defaultNotes: z.string().max(4000).nullable().optional(),
  defaultTerms: z.string().max(4000).nullable().optional(),
});
export type InvoiceSettings = z.infer<typeof invoiceSettingsSchema>;

/**
 * The issuer's own requisites (workspace_settings.legal_details): printed in
 * the "From" block of every invoice and quote. All free text – a legal name,
 * a tax id (ЄДРПОУ / VAT), a multi-line address, contact email and phone.
 */
export const legalDetailsSchema = z.object({
  legalName: z.string().max(300).nullable().optional(),
  taxId: z.string().max(100).nullable().optional(),
  address: z.string().max(1000).nullable().optional(),
  email: z.string().max(200).nullable().optional(),
  phone: z.string().max(100).nullable().optional(),
});
export type LegalDetails = z.infer<typeof legalDetailsSchema>;

/** PATCH /settings/workspace – all fields optional. */
export const workspaceSettingsUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  logo: z.string().nullable().optional(),
  legalDetails: legalDetailsSchema.optional(),
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
    signingSecret: z.string().optional(),
  }).optional(),
});
export type IntegrationsConfigInput = z.infer<typeof integrationsConfigSchema>;
