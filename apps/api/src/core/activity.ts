/**
 * Activity log (PRD §14.4). Every mutation writes an immutable record with a
 * redacted diff. Redaction is centralised (one serializer + registry): sensitive
 * values recorded as fact-only, secrets excluded entirely.
 */
import { getDb, schema, eq, inArray } from '@ordi/db';
import { buildRedactedDiff, type Permission } from '@ordi/shared';
import { ulid } from 'ulid';
import type { Actor } from '../context';
import { accessibleProjectIds, accessibleSpaceIds } from './access';

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
  note: 'crm.read',
  attachment: 'crm.read',
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
  custom_field: 'settings.manage',
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

/** The permission a cross-entity feed requires for one entity type (undefined = audit.read only). */
export function activityFeedPermission(entityType: string): Permission | undefined {
  return FEED_VISIBILITY[entityType];
}

/** Where an activity record lives: entity type -> the project or space that owns it. */
const PROJECT_SCOPED = new Set(['project', 'task', 'comment', 'cycle']);
const SPACE_SCOPED = new Set(['kb_space', 'kb_page', 'kb_page_comment']);

/**
 * Resolve the project (or space) each of these activity records belongs to, in
 * one query per kind. Records outside those two families resolve to null and
 * are governed by the permission map alone.
 */
export async function activityOwners(rows: { entityType: string; entityId: string }[]): Promise<{
  projectOf: Map<string, string>;
  spaceOf: Map<string, string>;
}> {
  const { db } = getDb();
  const idsOf = (type: string) => [...new Set(rows.filter((r) => r.entityType === type).map((r) => r.entityId))];
  const projectOf = new Map<string, string>();
  const spaceOf = new Map<string, string>();

  for (const id of idsOf('project')) projectOf.set(id, id);
  for (const id of idsOf('kb_space')) spaceOf.set(id, id);

  const taskIds = idsOf('task');
  const commentIds = idsOf('comment');
  const cycleIds = idsOf('cycle');
  const pageIds = idsOf('kb_page');
  const pageCommentIds = idsOf('kb_page_comment');

  const [tasks, comments, cycles, pages, pageComments] = await Promise.all([
    taskIds.length
      ? db.select({ id: schema.tasks.id, projectId: schema.tasks.projectId }).from(schema.tasks).where(inArray(schema.tasks.id, taskIds))
      : [],
    commentIds.length
      ? db.select({ id: schema.comments.id, projectId: schema.tasks.projectId })
        .from(schema.comments).innerJoin(schema.tasks, eq(schema.tasks.id, schema.comments.taskId))
        .where(inArray(schema.comments.id, commentIds))
      : [],
    cycleIds.length
      ? db.select({ id: schema.cycles.id, projectId: schema.cycles.projectId }).from(schema.cycles).where(inArray(schema.cycles.id, cycleIds))
      : [],
    pageIds.length
      ? db.select({ id: schema.kbPages.id, spaceId: schema.kbPages.spaceId }).from(schema.kbPages).where(inArray(schema.kbPages.id, pageIds))
      : [],
    pageCommentIds.length
      ? db.select({ id: schema.kbPageComments.id, spaceId: schema.kbPages.spaceId })
        .from(schema.kbPageComments).innerJoin(schema.kbPages, eq(schema.kbPages.id, schema.kbPageComments.pageId))
        .where(inArray(schema.kbPageComments.id, pageCommentIds))
      : [],
  ]);
  for (const r of [...tasks, ...comments, ...cycles]) projectOf.set(r.id, r.projectId);
  for (const r of [...pages, ...pageComments]) spaceOf.set(r.id, r.spaceId);
  return { projectOf, spaceOf };
}

/**
 * Drop the records whose project or space the actor cannot reach.
 *
 * The permission map answers "may this role see task activity at all"; it says
 * nothing about *which* tasks, so the home feed used to narrate private
 * projects – names, titles and all – to anyone holding projects.read. Full
 * audit access (audit.read) is exempt: seeing everything is the point of it.
 */
export async function scopeActivityToResources<T extends { entityType: string; entityId: string }>(
  actor: Actor,
  rows: T[],
): Promise<T[]> {
  if (actor.access.permissions.has('audit.read')) return rows;
  const scoped = rows.filter((r) => PROJECT_SCOPED.has(r.entityType) || SPACE_SCOPED.has(r.entityType));
  if (!scoped.length) return rows;
  const [projectIds, spaceIds, owners] = await Promise.all([
    accessibleProjectIds(actor),
    accessibleSpaceIds(actor),
    activityOwners(scoped),
  ]);
  const projects = new Set(projectIds);
  const spaces = new Set(spaceIds);
  return rows.filter((r) => {
    if (PROJECT_SCOPED.has(r.entityType)) {
      const owner = owners.projectOf.get(r.entityId);
      return owner ? projects.has(owner) : false;
    }
    if (SPACE_SCOPED.has(r.entityType)) {
      const owner = owners.spaceOf.get(r.entityId);
      return owner ? spaces.has(owner) : false;
    }
    return true;
  });
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
