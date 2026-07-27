/**
 * Activity log (PRD §14.4). Every mutation writes an immutable record with a
 * redacted diff. Redaction is centralised (one serializer + registry): sensitive
 * values recorded as fact-only, secrets excluded entirely.
 */
import { getDb, schema } from '@ordi/db';
import { buildRedactedDiff, type Permission } from '@ordi/shared';
import { ulid } from 'ulid';
import type { Actor } from '../context';

/**
 * Cross-entity feeds (home dashboard): the permission required to see activity
 * about each entity type. Fail closed — a type missing here is admin-only
 * (audit.read). A viewer's own actions are always visible regardless of this map.
 */
const FEED_VISIBILITY: Record<string, Permission> = {
  project: 'projects.read',
  task: 'projects.read',
  comment: 'projects.read',
  cycle: 'projects.read',
  company: 'crm.read',
  contact: 'crm.read',
  deal: 'deals.read',
  invoice: 'finance.read',
  quote: 'finance.read',
  recurring_invoice: 'finance.read',
  recurring_payment: 'finance.read',
  expense: 'finance.read',
  credit_note: 'finance.read',
  ledger_transaction: 'finance.read',
  account: 'finance.read',
  overhead_settings: 'finance.read_costs',
  time_entry: 'time.read_all',
  project_rate: 'time.manage',
  kb_space: 'kb.read',
  kb_page: 'kb.read',
  kb_page_comment: 'kb.read',
  employee: 'people.read',
  leave_request: 'people.read',
  leave_balance: 'people.read',
  applicant: 'people.recruit',
  job_opening: 'people.recruit',
  allocation: 'people.read',
  compensation: 'people.read_compensation',
  user: 'users.manage',
  workspace: 'settings.manage',
  slack_connection: 'integrations.manage',
  git_connection: 'integrations.manage',
  dead_letter_event: 'audit.read',
  event: 'audit.read',
};

/** Entity types the actor may see in cross-entity activity feeds; null = unrestricted (full audit access). */
export function visibleActivityTypes(perms: ReadonlySet<string>): string[] | null {
  if (perms.has('audit.read')) return null;
  return Object.keys(FEED_VISIBILITY).filter((t) => perms.has(FEED_VISIBILITY[t]!));
}

export interface ActivityInput {
  entityType: string;
  entityId: string;
  action: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  actorId?: string | null;
  actorType?: 'user' | 'agent' | 'system' | 'integration';
  /** force sensitivity (e.g. a read-access record on compensation). */
  sensitivity?: 'normal' | 'sensitive';
  /** pre-built diff (e.g. for read-access markers). */
  diff?: Record<string, unknown>;
}

export async function writeActivity(dbOrTx: any, input: ActivityInput): Promise<void> {
  let diff: Record<string, unknown> = input.diff ?? {};
  let sensitivity: 'normal' | 'sensitive' = input.sensitivity ?? 'normal';
  if (!input.diff) {
    const redacted = buildRedactedDiff(input.before ?? null, input.after ?? null, input.entityType);
    diff = redacted.diff;
    sensitivity = input.sensitivity ?? redacted.sensitivity;
  }
  await dbOrTx.insert(schema.activityLog).values({
    id: ulid(),
    entityType: input.entityType,
    entityId: input.entityId,
    actorId: input.actorId ?? null,
    actorType: input.actorType ?? 'user',
    action: input.action,
    diff,
    sensitivity,
  });
}

/** Records that someone *viewed* compensation/sensitive data (PRD §12.8, §14.4). */
export async function recordSensitiveAccess(actor: Actor, entityType: string, entityId: string): Promise<void> {
  const { db } = getDb();
  await writeActivity(db, {
    entityType,
    entityId,
    action: 'viewed',
    actorId: actor.userId,
    actorType: actor.actorType,
    sensitivity: 'sensitive',
    diff: { access: { action: 'viewed' } },
  });
}

export function actorFields(actor: Actor): { actorId: string; actorType: 'user' | 'agent' | 'system' | 'integration' } {
  return { actorId: actor.userId, actorType: actor.actorType };
}
