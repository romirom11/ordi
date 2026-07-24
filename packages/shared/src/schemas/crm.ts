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
  title: z.string().min(1),
  stageId: idSchema,
  amount: z.number().min(0).default(0),
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
  dealId: idSchema.nullable().optional(),
  body: richTextSchema,
  pinned: z.boolean().default(false),
});
