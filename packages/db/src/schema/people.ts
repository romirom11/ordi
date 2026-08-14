import { pgTable, text, boolean, integer, numeric, timestamp, jsonb, index, primaryKey } from 'drizzle-orm/pg-core';
import { pk, timestamps, createdBy, version, deletedAt, customFields, money } from './_shared';
import { users } from './core';
import { projects } from './projects';

export const departments = pgTable('departments', {
  id: pk(),
  name: text('name').notNull(),
  parentId: text('parent_id'),
  ...timestamps,
});

export const positions = pgTable('positions', {
  id: pk(),
  title: text('title').notNull(),
  ...timestamps,
});

export const employees = pgTable('employees', {
  id: pk(),
  userId: text('user_id').references(() => users.id),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull().default(''),
  email: text('email'),
  phone: text('phone'),
  /** Free-form "country, city" – where the person is based. */
  location: text('location'),
  positionId: text('position_id').references(() => positions.id),
  departmentId: text('department_id').references(() => departments.id),
  employmentType: text('employment_type').notNull().default('full_time'),
  managerId: text('manager_id'),
  birthday: text('birthday'),
  joinDate: text('join_date'),
  probationEnd: text('probation_end'),
  exitDate: text('exit_date'),
  status: text('status').notNull().default('active'),
  emergencyContact: jsonb('emergency_contact'),
  sensitive: jsonb('sensitive'),
  customFields: customFields(),
  /** Last time the person saved their own (self-service) fields – the questionnaire. */
  questionnaireUpdatedAt: timestamp('questionnaire_updated_at', { withTimezone: true }),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  statusIdx: index('employees_status_idx').on(t.status),
  managerIdx: index('employees_manager_idx').on(t.managerId),
}));

export const employeeDocuments = pgTable('employee_documents', {
  id: pk(),
  employeeId: text('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  attachmentId: text('attachment_id').notNull(),
  type: text('type').notNull().default('other'),
  ...timestamps,
});

export const leaveTypes = pgTable('leave_types', {
  id: pk(),
  name: text('name').notNull(),
  isPaid: boolean('is_paid').notNull().default(true),
  needsApproval: boolean('needs_approval').notNull().default(true),
  affectsBalance: boolean('affects_balance').notNull().default(true),
  allowHalfDay: boolean('allow_half_day').notNull().default(false),
  annualQuota: numeric('annual_quota').notNull().default('0'),
  carryForwardLimit: numeric('carry_forward_limit').notNull().default('0'),
  carryForwardExpiry: text('carry_forward_expiry'),
  ...timestamps,
});

export const leaveBalances = pgTable('leave_balances', {
  id: pk(),
  employeeId: text('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  leaveTypeId: text('leave_type_id').notNull().references(() => leaveTypes.id, { onDelete: 'cascade' }),
  period: text('period').notNull(),
  allocated: numeric('allocated').notNull().default('0'),
  used: numeric('used').notNull().default('0'),
  carried: numeric('carried').notNull().default('0'),
}, (t) => ({
  uniq: index('leave_balances_uniq_idx').on(t.employeeId, t.leaveTypeId, t.period),
}));

export const leaveRequests = pgTable('leave_requests', {
  id: pk(),
  employeeId: text('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  leaveTypeId: text('leave_type_id').notNull().references(() => leaveTypes.id),
  fromDate: text('from_date').notNull(),
  toDate: text('to_date').notNull(),
  halfDay: boolean('half_day').notNull().default(false),
  reason: text('reason').notNull().default(''),
  attachmentId: text('attachment_id'),
  status: text('status').notNull().default('pending'),
  approverId: text('approver_id').references(() => users.id),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionComment: text('decision_comment'),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
}, (t) => ({
  employeeIdx: index('leave_requests_employee_idx').on(t.employeeId),
  statusIdx: index('leave_requests_status_idx').on(t.status),
}));

export const holidayCalendars = pgTable('holiday_calendars', {
  id: pk(),
  name: text('name').notNull(),
  ...timestamps,
});

export const holidays = pgTable('holidays', {
  id: pk(),
  calendarId: text('calendar_id').notNull().references(() => holidayCalendars.id, { onDelete: 'cascade' }),
  date: text('date').notNull(),
  name: text('name').notNull(),
});

export const employeeHolidayCalendar = pgTable('employee_holiday_calendar', {
  employeeId: text('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  calendarId: text('calendar_id').notNull().references(() => holidayCalendars.id, { onDelete: 'cascade' }),
}, (t) => ({
  pk: primaryKey({ columns: [t.employeeId, t.calendarId] }),
}));

export const applicantStages = pgTable('applicant_stages', {
  id: pk(),
  name: text('name').notNull(),
  position: integer('position').notNull().default(0),
  isHired: boolean('is_hired').notNull().default(false),
  isRejected: boolean('is_rejected').notNull().default(false),
  ...timestamps,
});

export const jobOpenings = pgTable('job_openings', {
  id: pk(),
  title: text('title').notNull(),
  departmentId: text('department_id').references(() => departments.id),
  employmentType: text('employment_type').notNull().default('full_time'),
  description: text('description').notNull().default(''),
  status: text('status').notNull().default('draft'),
  positionsCount: integer('positions_count').notNull().default(1),
  hiringManagerId: text('hiring_manager_id').references(() => users.id),
  salaryRange: jsonb('salary_range'),
  publicToken: text('public_token').notNull().unique(),
  publicEnabled: boolean('public_enabled').notNull().default(false),
  createdBy: createdBy(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
});

export const applicants = pgTable('applicants', {
  id: pk(),
  jobOpeningId: text('job_opening_id').notNull().references(() => jobOpenings.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phone: text('phone'),
  resumeAttachmentId: text('resume_attachment_id'),
  coverText: text('cover_text').notNull().default(''),
  stageId: text('stage_id').notNull().references(() => applicantStages.id),
  rejectedReason: text('rejected_reason'),
  source: text('source').notNull().default('manual'),
  createdFrom: text('created_from').notNull().default('manual'),
  hiredEmployeeId: text('hired_employee_id'),
  customFields: customFields(),
  ...timestamps,
  version: version(),
  deletedAt: deletedAt(),
}, (t) => ({
  openingIdx: index('applicants_opening_idx').on(t.jobOpeningId),
  emailIdx: index('applicants_email_idx').on(t.email),
}));

export const interviews = pgTable('interviews', {
  id: pk(),
  applicantId: text('applicant_id').notNull().references(() => applicants.id, { onDelete: 'cascade' }),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
  type: text('type').notNull().default('screening'),
  interviewers: jsonb('interviewers').notNull().default([]),
  scorecard: jsonb('scorecard'),
  summary: text('summary').notNull().default(''),
  ...timestamps,
});

export const allocations = pgTable('allocations', {
  id: pk(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  hoursPerWeek: numeric('hours_per_week').notNull().default('0'),
  fromDate: text('from_date').notNull(),
  toDate: text('to_date').notNull(),
  ...timestamps,
}, (t) => ({
  userIdx: index('allocations_user_idx').on(t.userId),
}));

/** Versioned compensation (PRD §12.5) – sensitive, redacted in audit. */
export const compensation = pgTable('compensation', {
  id: pk(),
  employeeId: text('employee_id').notNull().references(() => employees.id, { onDelete: 'cascade' }),
  compType: text('comp_type').notNull(),
  amount: money('amount').notNull(),
  currency: text('currency').notNull().default('USD'),
  effectiveFrom: text('effective_from').notNull(),
  effectiveTo: text('effective_to'),
  createdBy: createdBy(),
  ...timestamps,
}, (t) => ({
  employeeIdx: index('compensation_employee_idx').on(t.employeeId),
}));

export const overheadSettings = pgTable('overhead_settings', {
  id: pk(),
  monthlyBase: money('monthly_base').notNull().default('0'),
  currency: text('currency').notNull().default('USD'),
  workingHoursPerWeek: numeric('working_hours_per_week').notNull().default('40'),
  effectiveFrom: text('effective_from').notNull(),
  ...timestamps,
});
