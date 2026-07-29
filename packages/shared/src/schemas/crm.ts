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
  name: z.string().trim().min(1),
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

export const SALES_SEQUENCE_STATUSES = ['active', 'completed', 'stopped'] as const;
export const SALES_TEMPLATE_VARIABLES = [
  'companyName',
  'contactFirstName',
  'contactName',
  'ownerName',
  'leadTitle',
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

export const leadInputSchema = z.object({
  companyId: idSchema,
  contactId: idSchema.nullable().optional(),
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
  templateId: idSchema.nullable().optional(),
}).superRefine((value, ctx) => {
  if ((value.leadId ? 1 : 0) + (value.dealId ? 1 : 0) !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Exactly one of leadId or dealId is required' });
  }
});

export const salesMessageTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  activityType: z.enum(SALES_ACTIVITY_TYPES),
  channel: z.string().trim().max(80).nullable().optional(),
  subject: z.string().max(500).nullable().optional(),
  body: z.string().min(1).max(20_000),
  active: z.boolean().default(true),
});

export const salesMessageTemplateUpdateSchema = salesMessageTemplateInputSchema.partial().extend({
  version: z.number().int().optional(),
});

export const salesSequenceStepInputSchema = z.object({
  delayDays: z.number().int().min(0).max(3_650).default(0),
  templateId: idSchema.nullable().optional(),
  activityType: z.enum(SALES_ACTIVITY_TYPES).optional(),
  channel: z.string().trim().max(80).nullable().optional(),
  subject: z.string().max(500).nullable().optional(),
  context: z.string().max(20_000).nullable().optional(),
}).superRefine((value, ctx) => {
  if (!value.templateId && !value.activityType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['activityType'],
      message: 'An activity type or template is required',
    });
  }
});

export const salesSequenceInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2_000).default(''),
  active: z.boolean().default(true),
  steps: z.array(salesSequenceStepInputSchema).min(1).max(50),
});

export const salesSequenceUpdateSchema = salesSequenceInputSchema.partial().extend({
  version: z.number().int().optional(),
});

export const salesSequenceEnrollSchema = z.object({
  leadId: idSchema.optional(),
  dealId: idSchema.optional(),
  contactId: idSchema.nullable().optional(),
  ownerId: idSchema.nullable().optional(),
  startAt: z.string().datetime({ offset: true }).optional(),
}).superRefine((value, ctx) => {
  if ((value.leadId ? 1 : 0) + (value.dealId ? 1 : 0) !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Exactly one of leadId or dealId is required' });
  }
});

export const salesSequenceStopSchema = z.object({
  version: z.number().int().optional(),
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
