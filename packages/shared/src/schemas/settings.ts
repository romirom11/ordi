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

/** PATCH /settings/workspace — all fields optional. */
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
});
