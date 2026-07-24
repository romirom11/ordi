/**
 * Permission catalog — the single source of truth for RBAC capabilities (PRD §4.2, §12.8).
 *
 * Format: `domain.action`. Unknown permission = denied (fail closed).
 * The role-editor UI is rendered from this catalog; the RBAC integration test
 * matrix is generated from it (a new permission without a test fails CI).
 */

export const PERMISSION_DOMAINS = [
  'crm',
  'deals',
  'projects',
  'kb',
  'time',
  'finance',
  'people',
  'integrations',
  'settings',
] as const;

export type PermissionDomain = (typeof PERMISSION_DOMAINS)[number];

export const PERMISSIONS = [
  // crm
  'crm.read',
  'crm.write',
  'crm.delete',
  'crm.export',
  // deals
  'deals.read',
  'deals.write',
  'deals.delete',
  // projects
  'projects.read',
  'projects.create',
  'projects.write',
  'projects.delete',
  'projects.export',
  // kb
  'kb.read',
  'kb.write',
  'kb.manage_spaces',
  // time
  'time.track',
  'time.read_all',
  'time.manage',
  // finance
  'finance.read',
  'finance.write',
  'finance.send',
  'finance.payments',
  'finance.delete',
  'finance.settings',
  'finance.export',
  'finance.read_costs',
  // people
  'people.read',
  'people.read_sensitive',
  'people.read_compensation',
  'people.write',
  'people.manage_leave',
  'people.approve_leave',
  'people.recruit',
  // integrations
  'integrations.manage',
  // settings
  'settings.manage',
  'users.manage',
  'roles.manage',
  'audit.read',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET = new Set<string>(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return PERMISSION_SET.has(value);
}

/** Human-readable descriptions for the role editor UI. */
export const PERMISSION_META: Record<Permission, { domain: PermissionDomain; label: string }> = {
  'crm.read': { domain: 'crm', label: 'View companies & contacts' },
  'crm.write': { domain: 'crm', label: 'Create/edit companies & contacts' },
  'crm.delete': { domain: 'crm', label: 'Delete CRM records' },
  'crm.export': { domain: 'crm', label: 'Export CRM data' },
  'deals.read': { domain: 'deals', label: 'View deals' },
  'deals.write': { domain: 'deals', label: 'Create/edit deals' },
  'deals.delete': { domain: 'deals', label: 'Delete deals' },
  'projects.read': { domain: 'projects', label: 'View workspace projects' },
  'projects.create': { domain: 'projects', label: 'Create projects' },
  'projects.write': { domain: 'projects', label: 'Manage project settings (as project admin)' },
  'projects.delete': { domain: 'projects', label: 'Delete projects' },
  'projects.export': { domain: 'projects', label: 'Export project data' },
  'kb.read': { domain: 'kb', label: 'View knowledge base' },
  'kb.write': { domain: 'kb', label: 'Create/edit pages' },
  'kb.manage_spaces': { domain: 'kb', label: 'Create/delete workspace spaces' },
  'time.track': { domain: 'time', label: 'Track own time' },
  'time.read_all': { domain: 'time', label: "View everyone's time" },
  'time.manage': { domain: 'time', label: 'Edit others’ time & rates' },
  'finance.read': { domain: 'finance', label: 'View invoices, quotes, receivables' },
  'finance.write': { domain: 'finance', label: 'Create/edit financial documents' },
  'finance.send': { domain: 'finance', label: 'Send documents' },
  'finance.payments': { domain: 'finance', label: 'Record payments' },
  'finance.delete': { domain: 'finance', label: 'Delete financial documents' },
  'finance.settings': { domain: 'finance', label: 'Numbering, taxes, reminders' },
  'finance.export': { domain: 'finance', label: 'Export financial data' },
  'finance.read_costs': { domain: 'finance', label: 'View cost & profitability' },
  'people.read': { domain: 'people', label: 'View employees & org' },
  'people.read_sensitive': { domain: 'people', label: 'View persona/sensitive fields' },
  'people.read_compensation': { domain: 'people', label: 'View compensation (narrowest)' },
  'people.write': { domain: 'people', label: 'Edit employees & lifecycle' },
  'people.manage_leave': { domain: 'people', label: 'Manage leave types/quotas/calendars' },
  'people.approve_leave': { domain: 'people', label: 'Approve leave outside manager line' },
  'people.recruit': { domain: 'people', label: 'Openings, applicants, interviews' },
  'integrations.manage': { domain: 'integrations', label: 'Manage git & webhooks' },
  'settings.manage': { domain: 'settings', label: 'Workspace settings, templates, custom fields' },
  'users.manage': { domain: 'settings', label: 'Invite/manage users' },
  'roles.manage': { domain: 'settings', label: 'Manage roles' },
  'audit.read': { domain: 'settings', label: 'View audit log' },
};
