/**
 * Server-side enforcement of the workspace module toggles.
 *
 * Turning a module off used to only hide it from the navigation, which meant a
 * disabled module still answered on the API – to a bookmarked URL, a stale tab,
 * an API token or the MCP server. That is surprising: switching something off
 * should switch it off. This middleware rejects those requests.
 *
 * It deliberately never gates settings, auth or anything the app needs to turn
 * a module back on, and it does not gate projects/tasks, which are the core the
 * rest hangs off.
 */
import type { MiddlewareHandler } from 'hono';
import type { ModuleKey } from '@ordi/shared';
import { getDb, schema, eq } from '@ordi/db';
import type { AppEnv } from '../context';
import { err } from '../lib/errors';

/**
 * First path segment of a route -> the module that owns it. Anything not listed
 * is always available.
 */
const OWNER: Record<string, ModuleKey> = {
  companies: 'crm',
  contacts: 'crm',
  deals: 'crm',
  'deal-stages': 'crm',
  notes: 'crm',
  spaces: 'kb',
  pages: 'kb',
  time: 'time',
  invoices: 'finance',
  quotes: 'finance',
  payments: 'finance',
  expenses: 'finance',
  'credit-notes': 'finance',
  'recurring-invoices': 'finance',
  'recurring-payments': 'finance',
  'tax-rates': 'finance',
  accounts: 'finance',
  ledger: 'finance',
  income: 'finance',
  // Real route segments – earlier entries here ('leave', 'candidates',
  // 'vacancies') never existed as paths, so most of HR ignored the toggle.
  employees: 'people',
  'employee-documents': 'people',
  departments: 'people',
  positions: 'people',
  'leave-requests': 'people',
  'leave-balances': 'people',
  'leave-types': 'people',
  applicants: 'people',
  'applicant-stages': 'people',
  'job-openings': 'people',
  interviews: 'people',
  holidays: 'people',
  'holiday-calendars': 'people',
  compensation: 'people',
  'overhead-settings': 'people',
  people: 'people',
  allocations: 'resourcing',
  resourcing: 'resourcing',
  dashboards: 'dashboards',
};

let cache: { at: number; value: Record<string, boolean> } | null = null;
const TTL_MS = 30_000;

export function invalidateModuleCache(): void {
  cache = null;
}

async function enabledModules(): Promise<Record<string, boolean>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const { db } = getDb();
  const [ws] = await db.select({ modules: schema.workspaceSettings.modules })
    .from(schema.workspaceSettings).where(eq(schema.workspaceSettings.id, 'workspace'));
  cache = { at: Date.now(), value: (ws?.modules ?? {}) as Record<string, boolean> };
  return cache.value;
}

/** Missing key means enabled – modules are opt-out, not opt-in. */
export async function moduleEnabled(key: ModuleKey): Promise<boolean> {
  return (await enabledModules())[key] !== false;
}

export const moduleGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const segment = c.req.path.replace(/^\/api\/v1\/?/, '').split('/')[0] ?? '';
  const owner = OWNER[segment];
  if (owner && !(await moduleEnabled(owner))) {
    throw err.notFound(`The ${owner} module is turned off for this workspace`);
  }
  await next();
};
