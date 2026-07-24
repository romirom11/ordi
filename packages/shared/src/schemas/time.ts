import { z } from 'zod';
import { idSchema } from './common';

export const timeEntryInputSchema = z.object({
  taskId: idSchema,
  startedAt: z.string(),
  durationSeconds: z.number().int().min(0),
  note: z.string().default(''),
  billable: z.boolean().optional(),
});

export const timeEntryUpdateSchema = z.object({
  startedAt: z.string().optional(),
  durationSeconds: z.number().int().min(0).optional(),
  note: z.string().optional(),
  billable: z.boolean().optional(),
  version: z.number().int().optional(),
});

export const timerStartSchema = z.object({
  taskId: idSchema,
  note: z.string().default(''),
});

export const projectRateInputSchema = z.object({
  projectId: idSchema,
  userId: idSchema.nullable().optional(),
  hourlyRate: z.number().min(0),
  currency: z.string().length(3).default('USD'),
});

export const timeReportQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  groupBy: z.enum(['project', 'user', 'company']).default('project'),
  billable: z.enum(['all', 'billable', 'nonbillable']).default('all'),
  projectId: idSchema.optional(),
});
