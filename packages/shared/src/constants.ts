/** Cross-cutting enums & constants shared by API, web and MCP. */

export const COMPANY_STATUSES = ['lead', 'active', 'paused', 'archived'] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const PROJECT_KINDS = ['client', 'internal'] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_STATUSES = ['active', 'paused', 'completed', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const VISIBILITY = ['workspace', 'private'] as const;
export type Visibility = (typeof VISIBILITY)[number];

export const PROJECT_MEMBER_ROLES = ['admin', 'member', 'viewer'] as const;
export type ProjectMemberRole = (typeof PROJECT_MEMBER_ROLES)[number];

export const SPACE_MEMBER_ROLES = ['editor', 'viewer'] as const;
export type SpaceMemberRole = (typeof SPACE_MEMBER_ROLES)[number];

export const TASK_STATUS_CATEGORIES = ['backlog', 'todo', 'in_progress', 'done', 'canceled'] as const;
export type TaskStatusCategory = (typeof TASK_STATUS_CATEGORIES)[number];

export const TASK_PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_RELATION_TYPES = ['blocks', 'relates', 'duplicates'] as const;
export type TaskRelationType = (typeof TASK_RELATION_TYPES)[number];

export const CYCLE_STATUSES = ['upcoming', 'active', 'completed'] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];

export const ESTIMATE_UNITS = ['hours', 'points'] as const;
export type EstimateUnit = (typeof ESTIMATE_UNITS)[number];

export const INTAKE_STATUSES = ['pending', 'accepted', 'declined'] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

export const QUOTE_STATUSES = ['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

export const INVOICE_STATUSES = ['draft', 'sent', 'viewed', 'partially_paid', 'paid', 'canceled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_METHODS = ['bank', 'card', 'cash', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const RECURRING_FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
export type RecurringFrequency = (typeof RECURRING_FREQUENCIES)[number];

export const DISCOUNT_TYPES = ['none', 'percent', 'fixed'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

export const DOC_LANGUAGES = ['uk', 'en'] as const;
export type DocLanguage = (typeof DOC_LANGUAGES)[number];

export const CUSTOM_FIELD_TYPES = [
  'text', 'number', 'date', 'select', 'multiselect', 'checkbox', 'url', 'user',
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_ENTITIES = [
  'companies', 'contacts', 'deals', 'projects', 'tasks', 'invoices', 'quotes', 'employees', 'applicants',
] as const;
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number];

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contractor'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export const EMPLOYEE_STATUSES = ['active', 'on_leave', 'terminated'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const LEAVE_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'canceled'] as const;
export type LeaveRequestStatus = (typeof LEAVE_REQUEST_STATUSES)[number];

export const JOB_OPENING_STATUSES = ['draft', 'open', 'on_hold', 'closed'] as const;
export type JobOpeningStatus = (typeof JOB_OPENING_STATUSES)[number];

export const COMP_TYPES = ['monthly', 'hourly', 'contractor'] as const;
export type CompType = (typeof COMP_TYPES)[number];

export const GIT_PROVIDERS = ['github', 'gitlab', 'gitea'] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

export const GIT_LINK_TYPES = ['branch', 'commit', 'pr', 'mr'] as const;
export type GitLinkType = (typeof GIT_LINK_TYPES)[number];

export const ACTOR_TYPES = ['user', 'agent', 'system', 'integration'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const DASHBOARD_WIDGET_TYPES = ['bar', 'line', 'pie', 'number', 'table'] as const;
export type DashboardWidgetType = (typeof DASHBOARD_WIDGET_TYPES)[number];

/** Status transition matrices (validated in services). */
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ['sent', 'canceled'],
  sent: ['viewed', 'partially_paid', 'paid', 'canceled'],
  viewed: ['partially_paid', 'paid', 'canceled'],
  partially_paid: ['paid', 'canceled'],
  paid: [],
  canceled: [],
};

export const QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  draft: ['sent'],
  sent: ['viewed', 'accepted', 'declined', 'expired'],
  viewed: ['accepted', 'declined', 'expired'],
  accepted: [],
  declined: [],
  expired: [],
};

export const LEAVE_TRANSITIONS: Record<LeaveRequestStatus, LeaveRequestStatus[]> = {
  pending: ['approved', 'rejected', 'canceled'],
  approved: ['canceled'],
  rejected: [],
  canceled: [],
};

export const MAX_SUBTASK_DEPTH = 5;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const SOFT_LOCK_TTL_SECONDS = 120;
export const BLOCKED_FILE_EXTENSIONS = ['exe', 'bat', 'cmd', 'sh', 'msi', 'com', 'scr', 'js', 'jar', 'app'];
