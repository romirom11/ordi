import { z } from 'zod';
import { idSchema, customFieldsSchema } from './common';
import { PAYMENT_METHODS, RECURRING_FREQUENCIES, DISCOUNT_TYPES, DOC_LANGUAGES } from '../constants';

export const lineItemInputSchema = z.object({
  description: z.string().min(1),
  quantity: z.number().min(0).default(1),
  unitPrice: z.number().default(0),
  taxRateId: idSchema.nullable().optional(),
  position: z.number().default(0),
});

export const quoteInputSchema = z.object({
  companyId: idSchema,
  projectId: idSchema.nullable().optional(),
  currency: z.string().length(3).default('USD'),
  issueDate: z.string(),
  validUntil: z.string().nullable().optional(),
  language: z.enum(DOC_LANGUAGES).default('en'),
  discountType: z.enum(DISCOUNT_TYPES).default('none'),
  discountValue: z.number().min(0).default(0),
  notes: z.string().default(''),
  terms: z.string().default(''),
  items: z.array(lineItemInputSchema).default([]),
  customFields: customFieldsSchema.optional(),
});
export const quoteUpdateSchema = quoteInputSchema.partial().extend({ version: z.number().int().optional() });

export const invoiceInputSchema = z.object({
  companyId: idSchema,
  projectId: idSchema.nullable().optional(),
  quoteId: idSchema.nullable().optional(),
  currency: z.string().length(3).default('USD'),
  issueDate: z.string(),
  dueDate: z.string(),
  language: z.enum(DOC_LANGUAGES).default('en'),
  discountType: z.enum(DISCOUNT_TYPES).default('none'),
  discountValue: z.number().min(0).default(0),
  discountBeforeTax: z.boolean().default(true),
  notes: z.string().default(''),
  terms: z.string().default(''),
  items: z.array(lineItemInputSchema).default([]),
  customFields: customFieldsSchema.optional(),
});
export const invoiceUpdateSchema = invoiceInputSchema.partial().extend({ version: z.number().int().optional() });

export const sendDocumentSchema = z.object({
  to: z.string().email().optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
});

export const paymentInputSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().length(3),
  date: z.string(),
  method: z.enum(PAYMENT_METHODS).default('bank'),
  reference: z.string().default(''),
  notes: z.string().default(''),
});

export const creditNoteInputSchema = z.object({
  amount: z.number().positive(),
  reason: z.string().min(1),
  date: z.string(),
});

export const invoiceFromTimeSchema = z.object({
  companyId: idSchema,
  from: z.string(),
  to: z.string(),
  projectIds: z.array(idSchema).min(1),
  grouping: z.enum(['task', 'user', 'single']).default('task'),
});

export const recurringInvoiceInputSchema = z.object({
  companyId: idSchema,
  projectId: idSchema.nullable().optional(),
  frequency: z.enum(RECURRING_FREQUENCIES),
  nextIssueDate: z.string(),
  autoSend: z.boolean().default(false),
  itemsTemplate: z.array(lineItemInputSchema).default([]),
  endDate: z.string().nullable().optional(),
  currency: z.string().length(3).default('USD'),
});

export const expenseInputSchema = z.object({
  companyId: idSchema.nullable().optional(),
  projectId: idSchema.nullable().optional(),
  categoryId: idSchema.nullable().optional(),
  amount: z.number().positive(),
  currency: z.string().length(3).default('USD'),
  date: z.string(),
  description: z.string().default(''),
  attachmentId: idSchema.nullable().optional(),
  billable: z.boolean().default(false),
  markup: z.number().min(0).default(0),
});

export const expenseCategoryInputSchema = z.object({ name: z.string().min(1) });

/** Recurring payment / subscription the workspace pays regularly. */
export const RECURRING_PAYMENT_INTERVALS = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
export const recurringPaymentInputSchema = z.object({
  name: z.string().min(1),
  vendor: z.string().nullable().optional(),
  companyId: idSchema.nullable().optional(),
  amount: z.number().positive(),
  currency: z.string().length(3).default('USD'),
  interval: z.enum(RECURRING_PAYMENT_INTERVALS),
  nextDate: z.string(),
  category: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  isActive: z.boolean().default(true),
  autoCreateExpense: z.boolean().default(false),
});
export const recurringPaymentUpdateSchema = recurringPaymentInputSchema.partial().extend({
  version: z.number().int().optional(),
});

export const taxRateInputSchema = z.object({
  name: z.string().min(1),
  ratePercent: z.number().min(0).max(100),
});

export const reminderRuleInputSchema = z.object({
  offsetDays: z.number().int(),
  templateId: idSchema.nullable().optional(),
  active: z.boolean().default(true),
});

export const emailTemplateInputSchema = z.object({
  type: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
});

export const numberSequenceInputSchema = z.object({
  docType: z.enum(['invoice', 'quote']),
  pattern: z.string().min(1),
  resetPeriod: z.enum(['none', 'year']).default('year'),
});

export const publicQuoteDecisionSchema = z.object({
  decision: z.enum(['accept', 'decline']),
  comment: z.string().default(''),
});

export const profitabilityQuerySchema = z.object({
  scope: z.enum(['project', 'client', 'labor']).default('project'),
  from: z.string().optional(),
  to: z.string().optional(),
  projectId: idSchema.optional(),
  companyId: idSchema.optional(),
});
