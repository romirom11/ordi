/**
 * System + preset roles (PRD §4.3, §12.8). System roles are non-editable.
 * Preset roles are seeded and editable by admins via the role-matrix UI.
 */
import { PERMISSIONS, type Permission } from './permissions';

export interface RoleSeed {
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  /** null => all permissions (computed at seed time from the catalog). */
  permissions: Permission[] | 'all';
}

const ALL: Permission[] = [...PERMISSIONS];

/** Admin gets everything except the ability to manage the Owner (enforced in service, not via a permission). */
const ADMIN: Permission[] = [...PERMISSIONS];

const MANAGER: Permission[] = [
  'crm.read', 'crm.write', 'crm.export',
  'deals.read', 'deals.write',
  'projects.read', 'projects.create', 'projects.write', 'projects.export',
  'kb.read', 'kb.write', 'kb.manage_spaces',
  'time.track', 'time.read_all', 'time.manage',
  'finance.read', 'finance.write', 'finance.send',
];

/**
 * A seller's shape: the whole CRM, and read-only sight of the delivery and
 * money the pipeline feeds into. Without this the only preset that covered the
 * sales workspace was Manager, which also hands out project write and the right
 * to issue and send invoices - far more than a new salesperson should carry.
 */
const SALES: Permission[] = [
  'crm.read', 'crm.write', 'crm.export',
  'deals.read', 'deals.write',
  'projects.read',
  'kb.read',
  'time.track',
  'finance.read',
];

const MEMBER: Permission[] = [
  'crm.read',
  'deals.read', 'deals.write',
  'projects.read', 'projects.create',
  'kb.read', 'kb.write',
  'time.track',
];

const FINANCE: Permission[] = [
  'crm.read',
  'finance.read', 'finance.write', 'finance.send', 'finance.payments',
  'finance.delete', 'finance.settings', 'finance.export', 'finance.read_costs',
  'projects.read',
  'time.read_all',
];

const HR: Permission[] = [
  'people.read', 'people.read_sensitive', 'people.write',
  'people.manage_leave', 'people.approve_leave', 'people.recruit',
  'projects.read',
];

/** Guest: no global permissions; access is purely via project/space membership. */
const GUEST: Permission[] = [];

export const SYSTEM_ROLES: RoleSeed[] = [
  { key: 'owner', name: 'Owner', description: 'Full access. The last Owner cannot be removed.', isSystem: true, permissions: 'all' },
  { key: 'admin', name: 'Admin', description: 'Full access except managing the Owner.', isSystem: true, permissions: ADMIN },
];

export const PRESET_ROLES: RoleSeed[] = [
  { key: 'manager', name: 'Manager', description: 'Runs delivery: CRM, projects, KB, time, finance read/write/send.', isSystem: false, permissions: MANAGER },
  { key: 'sales', name: 'Sales', description: 'Works the sales pipeline: leads, activities, playbooks and deals. Reads projects and finance, changes neither.', isSystem: false, permissions: SALES },
  { key: 'member', name: 'Member', description: 'Team member: projects, tasks, time. No finance.', isSystem: false, permissions: MEMBER },
  { key: 'finance', name: 'Finance', description: 'Full finance incl. costs & profitability.', isSystem: false, permissions: FINANCE },
  { key: 'hr', name: 'HR', description: 'People module fully except compensation.', isSystem: false, permissions: HR },
  { key: 'guest', name: 'Guest', description: 'External: access only via project/space membership.', isSystem: false, permissions: GUEST },
];

export const ALL_ROLE_SEEDS: RoleSeed[] = [...SYSTEM_ROLES, ...PRESET_ROLES];

export function resolveRolePermissions(seed: RoleSeed): Permission[] {
  return seed.permissions === 'all' ? ALL : seed.permissions;
}
