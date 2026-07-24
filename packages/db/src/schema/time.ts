import { pgTable, text, boolean, integer, numeric, timestamp, index } from 'drizzle-orm/pg-core';
import { pk, timestamps, createdBy, version, money } from './_shared';
import { users } from './core';
import { projects, tasks } from './projects';

export const timeEntries = pgTable('time_entries', {
  id: pk(),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  durationSeconds: integer('duration_seconds').notNull().default(0),
  note: text('note').notNull().default(''),
  billable: boolean('billable').notNull().default(true),
  hourlyRate: money('hourly_rate').notNull().default('0'),
  costRate: money('cost_rate').notNull().default('0'),
  invoiceItemId: text('invoice_item_id'),
  ...timestamps,
  version: version(),
}, (t) => ({
  userIdx: index('time_entries_user_idx').on(t.userId),
  projectIdx: index('time_entries_project_idx').on(t.projectId),
  taskIdx: index('time_entries_task_idx').on(t.taskId),
  unbilledIdx: index('time_entries_unbilled_idx').on(t.invoiceItemId),
}));

/** One active timer per user (running entry has a null duration marker in state). */
export const activeTimers = pgTable('active_timers', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  taskId: text('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  note: text('note').notNull().default(''),
});

export const projectRates = pgTable('project_rates', {
  id: pk(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  hourlyRate: money('hourly_rate').notNull().default('0'),
  currency: text('currency').notNull().default('USD'),
  ...timestamps,
}, (t) => ({
  projectIdx: index('project_rates_project_idx').on(t.projectId),
}));
