import { pgTable, text, boolean, integer, numeric, jsonb, index, uniqueIndex, primaryKey, timestamp } from 'drizzle-orm/pg-core';
import { pk, timestamps, createdBy, version, deletedAt, customFields, position } from './_shared';
import { users } from './core';
import { companies } from './crm';

export const projectTypes = pgTable('project_types', {
  id: pk(),
  name: text('name').notNull(),
  icon: text('icon').notNull().default('folder'),
  color: text('color').notNull().default('#6b7280'),
  /** Projects of this type must be linked to a client company. */
  requiresClient: boolean('requires_client').notNull().default(false),
  /** client_billing | none | direct — drives invoice eligibility & profitability revenue. */
  revenueSource: text('revenue_source').notNull().default('client_billing'),
  /** Preselected in the new-project dialog. */
  isDefault: boolean('is_default').notNull().default(false),
  position: integer('position').notNull().default(0),
  ...timestamps,
});

export const projectTemplates = pgTable('project_templates', {
  id: pk(),
  name: text('name').notNull(),
  definition: jsonb('definition').notNull().default({}),
  createdBy: createdBy(),
  ...timestamps,
});

export const projects = pgTable('projects', {
  id: pk(),
  companyId: text('company_id').references(() => companies.id),
  name: text('name').notNull(),
  key: text('key').notNull().unique(),
  projectTypeId: text('project_type_id').notNull().references(() => projectTypes.id),
  templateSourceId: text('template_source_id'),
  status: text('status').notNull().default('active'),
  visibility: text('visibility').notNull().default('workspace'),
  leadId: text('lead_id').references(() => users.id),
  startDate: text('start_date'),
  targetDate: text('target_date'),
  description: text('description'),
  settings: jsonb('settings').notNull().default({ estimateUnit: 'hours' }),
  customFields: customFields(),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  typeIdx: index('projects_type_idx').on(t.projectTypeId),
  statusIdx: index('projects_status_idx').on(t.status),
  companyIdx: index('projects_company_idx').on(t.companyId),
}));

export const projectMembers = pgTable('project_members', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'), // admin | member | viewer
  canWriteTasks: boolean('can_write_tasks').notNull().default(true),
  ...timestamps,
}, (t) => ({
  pk: primaryKey({ columns: [t.projectId, t.userId] }),
  userIdx: index('project_members_user_idx').on(t.userId),
}));

export const taskStatuses = pgTable('task_statuses', {
  id: pk(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  category: text('category').notNull(), // backlog/todo/in_progress/done/canceled
  color: text('color').notNull().default('#6b7280'),
  position: integer('position').notNull().default(0),
  isDefault: boolean('is_default').notNull().default(false),
  ...timestamps,
}, (t) => ({
  projectIdx: index('task_statuses_project_idx').on(t.projectId),
}));

export const taskTypes = pgTable('task_types', {
  id: pk(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  icon: text('icon').notNull().default('circle'),
  color: text('color').notNull().default('#6b7280'),
  position: integer('position').notNull().default(0),
  ...timestamps,
});

export const labels = pgTable('labels', {
  id: pk(),
  name: text('name').notNull(),
  color: text('color').notNull().default('#6b7280'),
  ...timestamps,
});

export const cycles = pgTable('cycles', {
  id: pk(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  status: text('status').notNull().default('upcoming'),
  goal: text('goal'),
  ...timestamps,
  version: version(),
}, (t) => ({
  projectIdx: index('cycles_project_idx').on(t.projectId),
}));

export const cycleSnapshots = pgTable('cycle_snapshots', {
  id: pk(),
  cycleId: text('cycle_id').notNull().references(() => cycles.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  openCount: integer('open_count').notNull().default(0),
  openEstimate: numeric('open_estimate').notNull().default('0'),
}, (t) => ({
  cycleDateIdx: uniqueIndex('cycle_snapshots_cycle_date_idx').on(t.cycleId, t.date),
}));

export const tasks = pgTable('tasks', {
  id: pk(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  number: integer('number').notNull(),
  title: text('title').notNull(),
  description: jsonb('description'),
  statusId: text('status_id').notNull().references(() => taskStatuses.id),
  typeId: text('type_id').references(() => taskTypes.id),
  priority: text('priority').notNull().default('none'),
  parentId: text('parent_id'),
  dueDate: text('due_date'),
  startDate: text('start_date'),
  estimate: numeric('estimate'),
  cycleId: text('cycle_id').references(() => cycles.id),
  position: position(),
  redirectToTaskId: text('redirect_to_task_id'),
  customFields: customFields(),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  projectNumberIdx: uniqueIndex('tasks_project_number_idx').on(t.projectId, t.number),
  statusIdx: index('tasks_status_idx').on(t.statusId),
  cycleIdx: index('tasks_cycle_idx').on(t.cycleId),
  parentIdx: index('tasks_parent_idx').on(t.parentId),
}));

export const taskAssignees = pgTable('task_assignees', {
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.taskId, t.userId] }),
  userIdx: index('task_assignees_user_idx').on(t.userId),
}));

export const taskLabels = pgTable('task_labels', {
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  labelId: text('label_id').notNull().references(() => labels.id, { onDelete: 'cascade' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.taskId, t.labelId] }),
}));

export const taskRelations = pgTable('task_relations', {
  id: pk(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  relatedTaskId: text('related_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // blocks | relates | duplicates
  ...timestamps,
}, (t) => ({
  taskIdx: index('task_relations_task_idx').on(t.taskId),
}));

export const taskLinks = pgTable('task_links', {
  id: pk(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  url: text('url').notNull(),
  title: text('title').notNull(),
  ...timestamps,
});

export const comments = pgTable('comments', {
  id: pk(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  authorId: text('author_id').references(() => users.id),
  body: jsonb('body').notNull().default({}),
  reactions: jsonb('reactions').notNull().default({}),
  editedAt: timestamp('edited_at', { withTimezone: true }),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  taskIdx: index('comments_task_idx').on(t.taskId),
}));

export const taskDrafts = pgTable('task_drafts', {
  id: pk(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  payload: jsonb('payload').notNull().default({}),
  ...timestamps,
});

export const taskTemplates = pgTable('task_templates', {
  id: pk(),
  projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  definition: jsonb('definition').notNull().default({}),
  ...timestamps,
});

export const recurringTasks = pgTable('recurring_tasks', {
  id: pk(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  templateId: text('template_id').notNull().references(() => taskTemplates.id, { onDelete: 'cascade' }),
  frequency: text('frequency').notNull(),
  cron: text('cron'),
  nextRun: text('next_run').notNull(),
  active: boolean('active').notNull().default(true),
  ...timestamps,
});

export const intakeItems = pgTable('intake_items', {
  id: pk(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  source: text('source').notNull().default('form'), // form | email
  requesterName: text('requester_name'),
  requesterEmail: text('requester_email'),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  attachments: jsonb('attachments').notNull().default([]),
  status: text('status').notNull().default('pending'),
  declineReason: text('decline_reason'),
  createdTaskId: text('created_task_id').references(() => tasks.id),
  ...timestamps,
}, (t) => ({
  projectIdx: index('intake_project_idx').on(t.projectId, t.status),
}));

export const intakeSettings = pgTable('intake_settings', {
  projectId: text('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  formToken: text('form_token').notNull().unique(),
  formEnabled: boolean('form_enabled').notNull().default(false),
  mailbox: jsonb('mailbox'),
  ...timestamps,
});

export const projectRepositories = pgTable('project_repositories', {
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  repositoryId: text('repository_id').notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.projectId, t.repositoryId] }),
}));

export const gitAutomationRules = pgTable('git_automation_rules', {
  id: pk(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  trigger: text('trigger').notNull(),
  targetStatusId: text('target_status_id').notNull().references(() => taskStatuses.id, { onDelete: 'cascade' }),
  ...timestamps,
});
