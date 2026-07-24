import { z } from 'zod';
import { idSchema } from './common';
import { GIT_PROVIDERS } from '../constants';
import { EVENT_TYPES } from '../events';

export const gitConnectionInputSchema = z.object({
  provider: z.enum(GIT_PROVIDERS),
  credentials: z.record(z.string(), z.unknown()),
  instanceUrl: z.string().url().nullable().optional(),
});

export const gitRepositoryInputSchema = z.object({
  connectionId: idSchema,
  externalId: z.string(),
  fullName: z.string(),
  defaultBranch: z.string().default('main'),
});

export const projectRepositoryInputSchema = z.object({
  repositoryId: idSchema,
});

export const gitAutomationRuleInputSchema = z.object({
  trigger: z.enum(['pr_opened', 'pr_merged', 'pr_closed', 'branch_created']),
  targetStatusId: idSchema,
});

export const webhookSubscriptionInputSchema = z.object({
  url: z.string().url(),
  secret: z.string().min(1),
  eventTypes: z.array(z.enum(EVENT_TYPES)).min(1),
  active: z.boolean().default(true),
});

export const dashboardInputSchema = z.object({
  name: z.string().min(1),
  visibility: z.enum(['private', 'workspace']).default('private'),
});

export const dashboardWidgetInputSchema = z.object({
  widgetType: z.enum(['bar', 'line', 'pie', 'number', 'table']),
  source: z.enum(['tasks', 'invoices', 'deals', 'time', 'profitability']),
  config: z.object({
    filters: z.record(z.string(), z.unknown()).default({}),
    groupBy: z.string().nullable().optional(),
    metric: z.enum(['count', 'sum_amount', 'sum_estimate', 'sum_duration']).default('count'),
  }),
  layout: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).default({ x: 0, y: 0, w: 4, h: 3 }),
});
