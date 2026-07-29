import { z } from 'zod';
import { idSchema, customFieldsSchema, richTextSchema } from './common';
import { COMPANY_STATUSES } from '../constants';

export const companyInputSchema = z.object({
  name: z.string().min(1),
  domain: z.string().nullable().optional(),
  status: z.enum(COMPANY_STATUSES).default('lead'),
  ownerId: idSchema.nullable().optional(),
  billingEmail: z.string().email().nullable().optional(),
  address: z.record(z.string(), z.unknown()).nullable().optional(),
  defaultCurrency: z.string().length(3).default('USD'),
  paymentTermsDays: z.number().int().min(0).default(14),
  customFields: customFieldsSchema.optional(),
});
export const companyUpdateSchema = companyInputSchema.partial().extend({ version: z.number().int().optional() });

export const contactInputSchema = z.object({
  companyId: idSchema,
  firstName: z.string().min(1),
  lastName: z.string().default(''),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  position: z.string().nullable().optional(),
  isPrimary: z.boolean().default(false),
  customFields: customFieldsSchema.optional(),
});
export const contactUpdateSchema = contactInputSchema.partial().extend({ version: z.number().int().optional() });

export const dealStageInputSchema = z.object({
  name: z.string().min(1),
  position: z.number().default(0),
  probability: z.number().min(0).max(100).default(0),
  isWon: z.boolean().default(false),
  isLost: z.boolean().default(false),
});

export const dealInputSchema = z.object({
  companyId: idSchema,
  /** Optional link to the product/delivery project this deal sells into. */
  projectId: idSchema.nullable().optional(),
  title: z.string().min(1),
  stageId: idSchema,
  amount: z.number().min(0).nullable().optional(),
  currency: z.string().length(3).default('USD'),
  expectedCloseDate: z.string().nullable().optional(),
  ownerId: idSchema.nullable().optional(),
  customFields: customFieldsSchema.optional(),
});
export const dealUpdateSchema = dealInputSchema.partial().extend({ version: z.number().int().optional() });

export const dealMoveSchema = z.object({
  stageId: idSchema,
  lostReason: z.string().optional(),
  version: z.number().int().optional(),
});

export const noteInputSchema = z.object({
  companyId: idSchema.nullable().optional(),
  contactId: idSchema.nullable().optional(),
  leadId: idSchema.nullable().optional(),
  dealId: idSchema.nullable().optional(),
  body: richTextSchema,
  pinned: z.boolean().default(false),
});

export const LEAD_STATUSES = [
  'new',
  'needs_review',
  'ready',
  'waiting_reply',
  'engaged',
  'nurture',
  'converted',
  'disqualified',
  'no_response',
] as const;

export const WRITABLE_LEAD_STATUSES = [
  'new',
  'needs_review',
  'ready',
  'waiting_reply',
  'engaged',
  'nurture',
  'disqualified',
  'no_response',
] as const;

export const LEAD_ACTIVITY_OUTCOME_STATUSES = [
  'ready',
  'waiting_reply',
  'engaged',
  'nurture',
  'disqualified',
  'no_response',
] as const;

export const SALES_ACTIVITY_STATUSES = ['planned', 'completed', 'cancelled'] as const;
export const SALES_ACTIVITY_TYPES = [
  'review',
  'outreach',
  'follow_up',
  'call',
  'meeting',
  'proposal',
  'nurture',
  'other',
] as const;

const publicHttpUrlSchema = z.string().url().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}, 'Only public HTTP(S) URLs are allowed');

export const dateOnlySchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'Expected a valid calendar date');

const secondarySourceSchema = z.object({
  title: z.string(),
  url: publicHttpUrlSchema,
  supports: z.string().optional(),
}).passthrough();

export const leadInputSchema = z.object({
  companyId: idSchema,
  contactId: idSchema.nullable().optional(),
  researchBatchId: idSchema.nullable().optional(),
  title: z.string().min(1),
  product: z.string().nullable().optional(),
  status: z.enum(WRITABLE_LEAD_STATUSES).default('new'),
  score: z.number().int().min(0).max(100).nullable().optional(),
  signal: z.string().nullable().optional(),
  painSignal: z.string().nullable().optional(),
  evidence: z.string().nullable().optional(),
  whyFit: z.string().nullable().optional(),
  whyNow: z.string().nullable().optional(),
  sourceTitle: z.string().nullable().optional(),
  sourceUrl: publicHttpUrlSchema.nullable().optional(),
  sourceType: z.string().nullable().optional(),
  signalDate: z.string().nullable().optional(),
  sourceCheckedAt: z.string().datetime({ offset: true }).nullable().optional(),
  suggestedChannel: z.string().nullable().optional(),
  opener: z.string().nullable().optional(),
  caution: z.string().nullable().optional(),
  dimensions: z.record(z.string(), z.number()).optional(),
  secondarySources: z.array(secondarySourceSchema).optional(),
  rawResearch: z.record(z.string(), z.unknown()).optional(),
  nurtureUntil: dateOnlySchema.nullable().optional(),
  disqualifiedReason: z.string().nullable().optional(),
  ownerId: idSchema.nullable().optional(),
  customFields: customFieldsSchema.optional(),
});
export const leadUpdateSchema = leadInputSchema.partial().extend({ version: z.number().int().optional() });

export const salesActivityInputSchema = z.object({
  leadId: idSchema.optional(),
  dealId: idSchema.optional(),
  contactId: idSchema.nullable().optional(),
  type: z.enum(SALES_ACTIVITY_TYPES),
  channel: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  context: z.string().nullable().optional(),
  dueAt: z.string().datetime({ offset: true }),
  ownerId: idSchema.nullable().optional(),
}).superRefine((value, ctx) => {
  if ((value.leadId ? 1 : 0) + (value.dealId ? 1 : 0) !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Exactly one of leadId or dealId is required' });
  }
});

export const salesActivityUpdateSchema = z.object({
  type: z.enum(SALES_ACTIVITY_TYPES).optional(),
  channel: z.string().nullable().optional(),
  subject: z.string().nullable().optional(),
  context: z.string().nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).optional(),
  ownerId: idSchema.nullable().optional(),
  version: z.number().int().optional(),
});

export const salesActivityCancelSchema = z.object({
  version: z.number().int().optional(),
});

export const salesActivityCompleteSchema = z.object({
  outcome: z.string().nullable().optional(),
  context: z.string().nullable().optional(),
  version: z.number().int().optional(),
  nextActivity: z.object({
    type: z.enum(SALES_ACTIVITY_TYPES),
    channel: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    context: z.string().nullable().optional(),
    dueAt: z.string().datetime({ offset: true }),
    ownerId: idSchema.nullable().optional(),
  }).optional(),
  leadStatus: z.enum(LEAD_ACTIVITY_OUTCOME_STATUSES).optional(),
  nurtureUntil: dateOnlySchema.optional(),
}).superRefine((value, ctx) => {
  if (value.nextActivity && (
    value.leadStatus === 'nurture'
    || value.leadStatus === 'disqualified'
    || value.leadStatus === 'no_response'
  )) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nextActivity'],
      message: 'Nurture and terminal lead statuses cannot have a follow-up activity',
    });
  }
  if (value.leadStatus === 'nurture' && !value.nurtureUntil) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nurtureUntil'],
      message: 'A nurture return date is required',
    });
  }
  if (value.leadStatus !== 'nurture' && value.nurtureUntil) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['nurtureUntil'],
      message: 'A nurture return date requires nurture status',
    });
  }
});

export const leadConvertSchema = z.object({
  stageId: idSchema.optional(),
  title: z.string().min(1).optional(),
  amount: z.number().min(0).nullable().optional(),
  currency: z.string().length(3).optional(),
  expectedCloseDate: z.string().nullable().optional(),
  contactId: idSchema.nullable().optional(),
});

export const dealDemoteSchema = z.object({
  title: z.string().min(1).optional(),
  product: z.string().nullable().optional(),
  status: z.enum(WRITABLE_LEAD_STATUSES).default('needs_review'),
});

export const researchProspectSchema = z.object({
  name: z.string().min(1),
  domain: z.string().optional(),
  company_url: publicHttpUrlSchema.optional(),
  type: z.string().optional(),
  stage: z.string().optional(),
  score: z.number().int().min(0).max(100).optional(),
  pain_signal: z.string().optional(),
  evidence: z.string().optional(),
  why_fit: z.string().optional(),
  why_now: z.string().optional(),
  source_title: z.string().optional(),
  source_url: publicHttpUrlSchema.optional(),
  source_type: z.string().optional(),
  signal_date: z.string().optional(),
  suggested_channel: z.string().optional(),
  opener: z.string().optional(),
  caution: z.string().optional(),
  dimensions: z.record(z.string(), z.number()).optional(),
  secondary_sources: z.array(secondarySourceSchema).optional(),
}).passthrough();

export const researchImportSchema = z.object({
  title: z.string().min(1),
  product: z.string().optional(),
  product_url: publicHttpUrlSchema.optional(),
  target_customer: z.string().optional(),
  search_scope: z.string().optional(),
  generated_at: z.string().optional(),
  verdict: z.string().optional(),
  prospects: z.array(researchProspectSchema).min(1),
  patterns: z.array(z.unknown()).optional(),
  outreach_plan: z.record(z.string(), z.unknown()).optional(),
  limits: z.array(z.unknown()).optional(),
  excluded_candidates: z.array(z.unknown()).optional(),
}).passthrough();
