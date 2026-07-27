/** Test helpers: reset DB, seed roles/users, and make authenticated requests. */
import { getDb, schema, eq, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { ALL_ROLE_SEEDS, resolveRolePermissions } from '@ordi/shared';
import { createApp } from '../app';
import { hashPassword, generateToken } from '../lib/crypto';

export const app = createApp();

const TABLES = [
  'time_entries', 'active_timers', 'project_rates', 'payments', 'credit_notes', 'invoice_items',
  'invoices', 'quote_items', 'quotes', 'recurring_invoices', 'expenses', 'expense_categories', 'reminder_log',
  'ledger_postings', 'ledger_transactions', 'accounts', 'recurring_payments',
  'comments', 'task_assignees', 'task_labels', 'task_relations', 'task_links', 'tasks',
  'cycle_snapshots', 'cycles', 'task_statuses', 'task_types', 'project_members', 'projects',
  'kb_page_versions', 'kb_page_comments', 'kb_page_links', 'kb_pages', 'space_members', 'kb_spaces',
  'leave_requests', 'leave_balances', 'compensation', 'employees', 'applicants', 'job_openings', 'interviews',
  'git_links', 'project_repositories', 'git_automation_rules', 'git_repositories',
  'git_connections', 'git_webhook_deliveries',
  'deals', 'contacts', 'companies', 'notes', 'attachments', 'activity_log', 'events', 'processed_events',
  'dead_letter_events', 'notifications', 'sessions', 'api_tokens', 'oauth_auth_codes', 'oauth_clients', 'invites', 'role_permissions',
  'roles', 'users', 'deal_stages', 'applicant_stages', 'leave_types', 'tax_rates',
  'number_sequences', 'task_number_counters',
];

export async function resetDb(): Promise<void> {
  const { db } = getDb();
  await db.execute(sql.raw(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`));
}

export interface SeededRole { key: string; roleId: string }

export async function seedRolesAndUsers(): Promise<Record<string, { userId: string; cookie: string; token: string }>> {
  const { db } = getDb();
  const roleIds = new Map<string, string>();
  for (const seed of ALL_ROLE_SEEDS) {
    const id = ulid();
    await db.insert(schema.roles).values({ id, key: seed.key, name: seed.name, description: seed.description, isSystem: seed.isSystem });
    const perms = resolveRolePermissions(seed);
    if (perms.length) await db.insert(schema.rolePermissions).values(perms.map((p) => ({ roleId: id, permission: p })));
    roleIds.set(seed.key, id);
  }
  const users: Record<string, { userId: string; cookie: string; token: string }> = {};
  for (const seed of ALL_ROLE_SEEDS) {
    const userId = ulid();
    await db.insert(schema.users).values({
      id: userId, email: `${seed.key}@test.local`, name: seed.name,
      passwordHash: hashPassword('password'), roleId: roleIds.get(seed.key)!,
    });
    const token = generateToken();
    await db.insert(schema.sessions).values({ id: ulid(), userId, token, expiresAt: new Date(Date.now() + 3600_000) });
    users[seed.key] = { userId, cookie: `ordi_session=${token}`, token };
  }
  return users;
}

export function reqAs(cookie: string) {
  return {
    get: (path: string) => app.request(`/api/v1${path}`, { headers: { cookie } }),
    post: (path: string, body?: unknown) => app.request(`/api/v1${path}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    }),
    patch: (path: string, body?: unknown) => app.request(`/api/v1${path}`, {
      method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    }),
    del: (path: string) => app.request(`/api/v1${path}`, { method: 'DELETE', headers: { cookie } }),
  };
}

/** Typed JSON reader (Response.json() is `unknown` under strict undici types). */
export async function json(res: Response | Promise<Response>): Promise<any> {
  const r = await res;
  return r.json();
}

export function anon() {
  return {
    get: (path: string) => app.request(`/api/v1${path}`),
    post: (path: string, body?: unknown) => app.request(`/api/v1${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    }),
  };
}
