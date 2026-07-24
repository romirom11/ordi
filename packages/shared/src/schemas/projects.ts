import { z } from 'zod';
import { idSchema, customFieldsSchema, richTextSchema } from './common';
import {
  PROJECT_STATUSES, VISIBILITY, PROJECT_MEMBER_ROLES, REVENUE_SOURCES,
  TASK_STATUS_CATEGORIES, TASK_PRIORITIES, TASK_RELATION_TYPES, CYCLE_STATUSES, ESTIMATE_UNITS,
} from '../constants';

export const projectInputSchema = z.object({
  name: z.string().min(1),
  key: z.string().regex(/^[A-Z]{2,5}$/, '2-5 uppercase letters'),
  /** Required – every project has a user-configurable type. "Type requires a client" is validated server-side against the type row. */
  projectTypeId: idSchema,
  companyId: idSchema.nullable().optional(),
  templateSourceId: idSchema.nullable().optional(),
  visibility: z.enum(VISIBILITY).default('workspace'),
  leadId: idSchema.nullable().optional(),
  startDate: z.string().nullable().optional(),
  targetDate: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  estimateUnit: z.enum(ESTIMATE_UNITS).default('hours'),
  customFields: customFieldsSchema.optional(),
});

/** Resource link on the project overview. */
export const projectLinkSchema = z.object({
  label: z.string().min(1),
  url: z.string().url(),
});

export const projectUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  visibility: z.enum(VISIBILITY).optional(),
  projectTypeId: idSchema.optional(),
  leadId: idSchema.nullable().optional(),
  startDate: z.string().nullable().optional(),
  targetDate: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  summary: z.string().max(500).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  links: z.array(projectLinkSchema).max(50).optional(),
  labelIds: z.array(idSchema).optional(),
  estimateUnit: z.enum(ESTIMATE_UNITS).optional(),
  customFields: customFieldsSchema.optional(),
  /** Per-project settings; merged (not replaced) with existing keys like estimateUnit. */
  settings: z.object({
    estimateUnit: z.enum(ESTIMATE_UNITS).optional(),
    slackWebhookUrl: z.string().url().nullable().optional(),
    /** Preferred Slack channel id for this project (Slack app posts here). */
    slackChannelId: z.string().nullable().optional(),
  }).partial().optional(),
  version: z.number().int().optional(),
});

/** Milestones (project overview checklist). */
export const milestoneInputSchema = z.object({
  name: z.string().min(1),
  targetDate: z.string().nullable().optional(),
  done: z.boolean().default(false),
  position: z.number().int().optional(),
});

export const milestonePatchSchema = z.object({
  name: z.string().min(1).optional(),
  targetDate: z.string().nullable().optional(),
  done: z.boolean().optional(),
  position: z.number().int().optional(),
});

/** Project status updates (health reports). */
export const PROJECT_HEALTH = ['on_track', 'at_risk', 'off_track'] as const;
export type ProjectHealth = (typeof PROJECT_HEALTH)[number];

export const projectUpdatePostSchema = z.object({
  body: richTextSchema,
  health: z.enum(PROJECT_HEALTH).default('on_track'),
});

export const projectUpdatePatchSchema = z.object({
  body: richTextSchema.optional(),
  health: z.enum(PROJECT_HEALTH).optional(),
});

export const projectMemberInputSchema = z.object({
  userId: idSchema,
  role: z.enum(PROJECT_MEMBER_ROLES).default('member'),
  canWriteTasks: z.boolean().default(true),
});

export const taskStatusInputSchema = z.object({
  name: z.string().min(1),
  category: z.enum(TASK_STATUS_CATEGORIES),
  color: z.string().default('#6b7280'),
  position: z.number().default(0),
  isDefault: z.boolean().default(false),
});

export const taskTypeInputSchema = z.object({
  projectId: idSchema.nullable().optional(),
  name: z.string().min(1),
  icon: z.string().default('circle'),
  color: z.string().default('#6b7280'),
  position: z.number().default(0),
});

export const projectTypeInputSchema = z.object({
  name: z.string().min(1),
  icon: z.string().default('folder'),
  color: z.string().default('#6b7280'),
  requiresClient: z.boolean().default(false),
  revenueSource: z.enum(REVENUE_SOURCES).default('client_billing'),
  isDefault: z.boolean().default(false),
  position: z.number().int().default(0),
});

/** PATCH /project-types/order – full ordered list of type ids. */
export const projectTypeOrderSchema = z.object({
  ids: z.array(idSchema).min(1),
});

export const taskInputSchema = z.object({
  projectId: idSchema,
  title: z.string().min(1),
  description: richTextSchema.optional(),
  statusId: idSchema.optional(),
  typeId: idSchema.nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).default('none'),
  parentId: idSchema.nullable().optional(),
  dueDate: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  estimate: z.number().nullable().optional(),
  cycleId: idSchema.nullable().optional(),
  assigneeIds: z.array(idSchema).default([]),
  labelIds: z.array(idSchema).default([]),
  customFields: customFieldsSchema.optional(),
});

export const taskUpdateSchema = z.object({
  title: z.string().min(1).optional(),
  description: richTextSchema.optional(),
  statusId: idSchema.optional(),
  typeId: idSchema.nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  parentId: idSchema.nullable().optional(),
  dueDate: z.string().nullable().optional(),
  startDate: z.string().nullable().optional(),
  estimate: z.number().nullable().optional(),
  cycleId: idSchema.nullable().optional(),
  assigneeIds: z.array(idSchema).optional(),
  labelIds: z.array(idSchema).optional(),
  customFields: customFieldsSchema.optional(),
  version: z.number().int().optional(),
});

export const taskMoveSchema = z.object({
  targetProjectId: idSchema,
});

export const taskRelationSchema = z.object({
  relatedTaskId: idSchema,
  type: z.enum(TASK_RELATION_TYPES),
});

export const taskLinkSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1),
});

export const bulkTaskUpdateSchema = z.object({
  taskIds: z.array(idSchema).min(1),
  statusId: idSchema.optional(),
  assigneeIds: z.array(idSchema).optional(),
  labelIds: z.array(idSchema).optional(),
  cycleId: idSchema.nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
});

export const commentInputSchema = z.object({
  body: richTextSchema,
  mentions: z.array(idSchema).default([]),
});

export const labelInputSchema = z.object({
  name: z.string().min(1),
  color: z.string().default('#6b7280'),
});

export const cycleInputSchema = z.object({
  projectId: idSchema,
  name: z.string().min(1),
  startDate: z.string(),
  endDate: z.string(),
  goal: z.string().nullable().optional(),
});

export const cycleCompleteSchema = z.object({
  moveTo: z.enum(['next_cycle', 'backlog']).default('backlog'),
  nextCycleId: idSchema.nullable().optional(),
});

export const taskViewSchema = z.enum(['list', 'board', 'calendar', 'timeline', 'spreadsheet']);

export const savedViewInputSchema = z.object({
  entityType: z.string(),
  name: z.string().min(1),
  filters: z.record(z.string(), z.unknown()).default({}),
  sort: z.record(z.string(), z.unknown()).default({}),
  layout: taskViewSchema.default('list'),
  isShared: z.boolean().default(false),
  projectId: idSchema.nullable().optional(),
});

export const taskTemplateInputSchema = z.object({
  projectId: idSchema.nullable().optional(),
  name: z.string().min(1),
  definition: z.object({
    titlePattern: z.string().default(''),
    description: richTextSchema.optional(),
    typeId: idSchema.nullable().optional(),
    priority: z.enum(TASK_PRIORITIES).default('none'),
    labelIds: z.array(idSchema).default([]),
    estimate: z.number().nullable().optional(),
    subtasks: z.array(z.object({ title: z.string(), priority: z.enum(TASK_PRIORITIES).default('none') })).default([]),
  }),
});

export const recurringTaskInputSchema = z.object({
  projectId: idSchema,
  templateId: idSchema,
  frequency: z.enum(['daily', 'weekly', 'monthly', 'custom']),
  cron: z.string().nullable().optional(),
  active: z.boolean().default(true),
});

export const projectTemplateInputSchema = z.object({
  name: z.string().min(1),
  definition: z.record(z.string(), z.unknown()),
});

export const intakeSubmitSchema = z.object({
  requesterName: z.string().min(1),
  requesterEmail: z.string().email().optional(),
  title: z.string().min(1),
  description: z.string().default(''),
  honeypot: z.string().optional(),
});

export const intakeAcceptSchema = z.object({
  statusId: idSchema.optional(),
  typeId: idSchema.nullable().optional(),
  assigneeIds: z.array(idSchema).default([]),
});

export const intakeDeclineSchema = z.object({
  reason: z.string().default(''),
  notify: z.boolean().default(false),
});

export const intakeSettingsSchema = z.object({
  formEnabled: z.boolean().optional(),
  mailbox: z.record(z.string(), z.unknown()).nullable().optional(),
});
