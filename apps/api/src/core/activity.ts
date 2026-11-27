/**
 * Activity log (PRD §14.4). Every mutation writes an immutable record with a
 * redacted diff. Redaction is centralised (one serializer + registry): sensitive
 * values recorded as fact-only, secrets excluded entirely.
 */
import { getDb, schema, eq, and, desc, inArray, isNull } from '@ordi/db';
import { buildRedactedDiff, canSeePage, type Permission } from '@ordi/shared';
import { ulid } from 'ulid';
import type { Actor } from '../context';
import { accessibleProjectIds, accessibleSpaceIds, editableSpaceIds, effectiveProjectRole } from './access';

/**
 * Cross-entity feeds (home dashboard): the permission required to see activity
 * about each entity type. Fail closed – a type missing here is admin-only
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
  lead: 'crm.read',
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
  mcp_connector: 'integrations.manage',
  agent: 'agents.manage',
  agent_credential: 'agents.manage',
  agent_run: 'projects.read',
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

/**
 * Activity that no general feed shows, not even to audit.read: a secret's
 * trail names restricted secrets and who reached them, and answers to the
 * secret's own access rule (secrets/service secretActivity) instead.
 */
export const PRIVATE_ACTIVITY_TYPES: readonly string[] = ['project_secret'];
const PRIVATE_ACTIVITY = new Set(PRIVATE_ACTIVITY_TYPES);

/** Where an activity record lives: entity type -> the project or space that owns it. */
const PROJECT_SCOPED = new Set(['project', 'task', 'comment', 'cycle', 'time_entry', 'project_rate', 'allocation']);
/** Project-owned rows that may be hard-deleted: their project is also read from their own trail. */
const ROW_PROJECT: Record<string, { table: typeof schema.timeEntries | typeof schema.projectRates | typeof schema.allocations }> = {
  time_entry: { table: schema.timeEntries },
  project_rate: { table: schema.projectRates },
  allocation: { table: schema.allocations },
};
const SPACE_SCOPED = new Set(['kb_space', 'kb_page', 'kb_page_comment']);

/**
 * Which permission covers the files hanging off each record type – the read
 * rule of the attachments routes, and of an attachment's activity, which
 * names the file and the record it is on.
 */
export const ATTACHMENT_READ_PERM: Record<string, Permission> = {
  company: 'crm.read', lead: 'crm.read', deal: 'deals.read',
  task: 'projects.read', project: 'projects.read', intake_item: 'projects.read',
  employee: 'people.read_documents',
};
/**
 * The record a file hangs off, as its activity names it. Every record of a
 * file's trail carries it, so once the file is gone its trail still answers
 * to the record it was last on (core/activity), not the one it started on – a
 * task moved into a private project takes its files with it.
 */
export function onRecord(att: { entityType: string | null; entityId: string | null }): { on?: { to: string } } {
  return att.entityType ? { on: { to: `${att.entityType}:${att.entityId ?? ''}` } } : {};
}

/** Record types whose files belong to a project (and answer to its access). */
const ATTACHMENT_IN_PROJECT = new Set(['project', 'task', 'intake_item']);

/**
 * Resolve the project (or space) each of these activity records belongs to, in
 * one query per kind. Records outside those two families resolve to null and
 * are governed by the permission map alone.
 */
/** What canSeePage needs to judge a page-owned activity record. */
export interface PageVisibilityMeta { published: boolean; visibility: string; createdBy: string | null }

/** The record an attachment hangs off (type null: embedded in a document, no record). */
export interface AttachmentParent { type: string | null; id: string | null }

export async function activityOwners(rows: { entityType: string; entityId: string }[]): Promise<{
  projectOf: Map<string, string>;
  spaceOf: Map<string, string>;
  pageMetaOf: Map<string, PageVisibilityMeta>;
  attachmentParentOf: Map<string, AttachmentParent>;
  fieldScopeOf: Map<string, 'workspace' | 'project'>;
}> {
  const { db } = getDb();
  const idsOf = (type: string) => [...new Set(rows.filter((r) => r.entityType === type).map((r) => r.entityId))];
  const projectOf = new Map<string, string>();
  const spaceOf = new Map<string, string>();
  const pageMetaOf = new Map<string, PageVisibilityMeta>();

  for (const id of idsOf('project')) projectOf.set(id, id);
  for (const id of idsOf('kb_space')) spaceOf.set(id, id);

  const taskIds = idsOf('task');
  const commentIds = idsOf('comment');
  const cycleIds = idsOf('cycle');
  const pageIds = idsOf('kb_page');
  const pageCommentIds = idsOf('kb_page_comment');

  const pageFields = {
    spaceId: schema.kbPages.spaceId,
    published: schema.kbPages.published,
    visibility: schema.kbPages.visibility,
    createdBy: schema.kbPages.createdBy,
  };
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
      ? db.select({ id: schema.kbPages.id, ...pageFields }).from(schema.kbPages).where(inArray(schema.kbPages.id, pageIds))
      : [],
    pageCommentIds.length
      ? db.select({ id: schema.kbPageComments.id, ...pageFields })
        .from(schema.kbPageComments).innerJoin(schema.kbPages, eq(schema.kbPages.id, schema.kbPageComments.pageId))
        .where(inArray(schema.kbPageComments.id, pageCommentIds))
      : [],
  ]);
  for (const r of [...tasks, ...comments, ...cycles]) projectOf.set(r.id, r.projectId);
  for (const type of Object.keys(ROW_PROJECT)) await rowProjects(type, idsOf(type), projectOf);
  for (const r of [...pages, ...pageComments]) {
    spaceOf.set(r.id, r.spaceId);
    pageMetaOf.set(r.id, { published: r.published, visibility: r.visibility, createdBy: r.createdBy });
  }
  const attachmentParentOf = await attachmentParents(idsOf('attachment'), projectOf);
  const fieldScopeOf = await customFieldScopes(idsOf('custom_field'), projectOf);
  return { projectOf, spaceOf, pageMetaOf, attachmentParentOf, fieldScopeOf };
}

/**
 * The project of each time entry, rate or allocation: the live row, or – once
 * it is deleted – the newest record of its own trail that names one
 * (`projectId: { to }` or `{ from }`). Unknown ones stay out of projectOf, so
 * the caller fails closed.
 */
async function rowProjects(type: string, ids: string[], projectOf: Map<string, string>): Promise<void> {
  if (!ids.length) return;
  const { db } = getDb();
  const { table } = ROW_PROJECT[type]!;
  const live = await db.select({ id: table.id, projectId: table.projectId }).from(table).where(inArray(table.id, ids));
  for (const r of live) projectOf.set(r.id, r.projectId);
  const gone = ids.filter((id) => !projectOf.has(id));
  if (!gone.length) return;
  const trail = await db.select({ entityId: schema.activityLog.entityId, diff: schema.activityLog.diff })
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, type), inArray(schema.activityLog.entityId, gone)))
    .orderBy(desc(schema.activityLog.createdAt), desc(schema.activityLog.id));
  for (const r of trail) {
    if (projectOf.has(r.entityId)) continue;
    const named = ((r.diff ?? {}) as { projectId?: { to?: unknown; from?: unknown } }).projectId;
    const projectId = typeof named?.to === 'string' ? named.to : typeof named?.from === 'string' ? named.from : null;
    if (projectId) projectOf.set(r.entityId, projectId);
  }
}

/** The `created` record of each of these entities, for rows that are gone (hard-deleted). */
async function createdDiffs(entityType: string, ids: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!ids.length) return out;
  const { db } = getDb();
  const rows = await db.select({ entityId: schema.activityLog.entityId, diff: schema.activityLog.diff })
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, entityType), eq(schema.activityLog.action, 'created'),
      inArray(schema.activityLog.entityId, ids)));
  for (const r of rows) out.set(r.entityId, (r.diff ?? {}) as Record<string, unknown>);
  return out;
}

/**
 * Where each custom field definition lives: 'workspace', or – for a project's
 * own field – the project (into projectOf). A deleted definition is read from
 * its `created` record (`projectId: { to }`). Unknown ones are left out.
 */
async function customFieldScopes(ids: string[], projectOf: Map<string, string>): Promise<Map<string, 'workspace' | 'project'>> {
  const out = new Map<string, 'workspace' | 'project'>();
  if (!ids.length) return out;
  const { db } = getDb();
  const live = await db.select({ id: schema.customFieldDefinitions.id, projectId: schema.customFieldDefinitions.projectId })
    .from(schema.customFieldDefinitions).where(inArray(schema.customFieldDefinitions.id, ids));
  const scopeOf = new Map<string, string | null>(live.map((d) => [d.id, d.projectId]));
  const created = await createdDiffs('custom_field', ids.filter((id) => !scopeOf.has(id)));
  for (const [id, diff] of created) {
    const to = (diff.projectId as { to?: unknown } | undefined)?.to;
    scopeOf.set(id, typeof to === 'string' && to ? to : null);
  }
  for (const [id, projectId] of scopeOf) {
    out.set(id, projectId ? 'project' : 'workspace');
    if (projectId) projectOf.set(id, projectId);
  }
  return out;
}

/**
 * The project each task is in now: a task moved to another project is left
 * behind deleted with a redirect to its counterpart, and an old record naming
 * the left-behind task belongs with where the work went.
 */
async function currentTaskProjects(taskIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const { db } = getDb();
  let pending = new Map(taskIds.map((id) => [id, id])); // asked id -> id to look up
  for (let hop = 0; hop < 5 && pending.size; hop++) {
    const rows = await db.select({ id: schema.tasks.id, projectId: schema.tasks.projectId, redirect: schema.tasks.redirectToTaskId })
      .from(schema.tasks).where(inArray(schema.tasks.id, [...new Set(pending.values())]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const next = new Map<string, string>();
    for (const [asked, lookup] of pending) {
      const row = byId.get(lookup);
      if (!row) continue;
      if (row.redirect) next.set(asked, row.redirect);
      else out.set(asked, row.projectId);
    }
    pending = next;
  }
  return out;
}

/**
 * The record each attachment hangs off, and for a file on a project, a task or
 * an intake item, the project (into projectOf). A deleted file's row is gone,
 * so its parent is read from the latest record of its own trail that names
 * one (`on: "task:<id>"`: the upload, and since then every rename and the
 * delete) – the record it was last on, so a file whose task moved into a
 * private project stays with that project. An attachment found in neither is
 * left out of the map: nothing says whose it was, so the caller fails closed.
 */
async function attachmentParents(ids: string[], projectOf: Map<string, string>): Promise<Map<string, AttachmentParent>> {
  const out = new Map<string, AttachmentParent>();
  if (!ids.length) return out;
  const { db } = getDb();
  const live = await db.select({ id: schema.attachments.id, type: schema.attachments.entityType, entityId: schema.attachments.entityId })
    .from(schema.attachments).where(inArray(schema.attachments.id, ids));
  for (const a of live) out.set(a.id, { type: a.type, id: a.entityId });
  const gone = ids.filter((id) => !out.has(id));
  if (gone.length) {
    const trail = await db.select({ entityId: schema.activityLog.entityId, diff: schema.activityLog.diff })
      .from(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, 'attachment'), inArray(schema.activityLog.entityId, gone)))
      .orderBy(desc(schema.activityLog.createdAt), desc(schema.activityLog.id));
    for (const r of trail) {
      if (out.has(r.entityId)) continue; // newest first: the first that names a record wins
      const on = ((r.diff ?? {}) as { on?: { to?: unknown } }).on?.to;
      if (typeof on !== 'string') continue;
      const at = on.indexOf(':');
      if (at < 1) continue;
      out.set(r.entityId, { type: on.slice(0, at), id: on.slice(at + 1) || null });
    }
  }
  const parentIds = (type: string) => [...new Set([...out.values()].filter((p) => p.type === type && p.id).map((p) => p.id!))];
  const taskIds = parentIds('task');
  const intakeIds = parentIds('intake_item');
  const [tasks, intake] = await Promise.all([
    currentTaskProjects(taskIds),
    intakeIds.length
      ? db.select({ id: schema.intakeItems.id, projectId: schema.intakeItems.projectId }).from(schema.intakeItems).where(inArray(schema.intakeItems.id, intakeIds))
      : [],
  ]);
  const projectOfParent = new Map<string, string>([
    ...[...tasks].map(([id, projectId]) => [`task:${id}`, projectId] as [string, string]),
    ...intake.map((i) => [`intake_item:${i.id}`, i.projectId] as [string, string]),
  ]);
  for (const [attId, p] of out) {
    if (!p.type || !p.id || !ATTACHMENT_IN_PROJECT.has(p.type)) continue;
    const projectId = p.type === 'project' ? p.id : projectOfParent.get(`${p.type}:${p.id}`);
    if (projectId) projectOf.set(attId, projectId);
  }
  return out;
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
  all: T[],
): Promise<T[]> {
  const rows = all.filter((r) => !PRIVATE_ACTIVITY.has(r.entityType));
  if (actor.access.permissions.has('audit.read')) return rows;
  const scoped = rows.filter((r) => PROJECT_SCOPED.has(r.entityType) || SPACE_SCOPED.has(r.entityType)
    || r.entityType === 'attachment' || r.entityType === 'custom_field');
  if (!scoped.length) return rows;
  const [projectIds, spaceIds, editorIds, owners] = await Promise.all([
    accessibleProjectIds(actor),
    accessibleSpaceIds(actor),
    editableSpaceIds(actor),
    activityOwners(scoped),
  ]);
  const projects = new Set(projectIds);
  // An intake item's files answer to the triage queue's rule: project member.
  const intakeProjects = [...new Set([...owners.attachmentParentOf]
    .filter(([, p]) => p.type === 'intake_item')
    .map(([attId]) => owners.projectOf.get(attId))
    .filter((id): id is string => !!id && projects.has(id)))];
  const memberProjects = new Set<string>();
  if (intakeProjects.length) {
    const { db } = getDb();
    const rows = await db.select({ id: schema.projects.id, visibility: schema.projects.visibility }).from(schema.projects)
      .where(and(inArray(schema.projects.id, intakeProjects), isNull(schema.projects.deletedAt)));
    for (const p of rows) {
      const role = effectiveProjectRole(actor, { id: p.id, visibility: p.visibility as 'workspace' | 'private' });
      if (role === 'member' || role === 'admin') memberProjects.add(p.id);
    }
  }
  const spaces = new Set(spaceIds);
  const editorSpaces = new Set(editorIds);
  return rows.filter((r) => {
    if (PROJECT_SCOPED.has(r.entityType)) {
      const owner = owners.projectOf.get(r.entityId);
      return owner ? projects.has(owner) : false;
    }
    if (r.entityType === 'attachment') {
      // A file's trail names the file and its record: it is as readable as the
      // file itself – the record type's permission, and for a file in a
      // project, that project. One embedded in a document, or whose record
      // is unknown, is no feed's to show.
      const parent = owners.attachmentParentOf.get(r.entityId);
      if (!parent?.type) return false;
      const needed = ATTACHMENT_READ_PERM[parent.type];
      if (!needed || !actor.access.permissions.has(needed)) return false;
      if (!ATTACHMENT_IN_PROJECT.has(parent.type)) return true;
      const owner = owners.projectOf.get(r.entityId);
      if (!owner) return false;
      return parent.type === 'intake_item' ? memberProjects.has(owner) : projects.has(owner);
    }
    if (r.entityType === 'custom_field') {
      // A project's own field is that project's configuration.
      const scope = owners.fieldScopeOf.get(r.entityId);
      if (scope === 'workspace') return true;
      const owner = owners.projectOf.get(r.entityId);
      return scope === 'project' && owner ? projects.has(owner) : false;
    }
    if (SPACE_SCOPED.has(r.entityType)) {
      const owner = owners.spaceOf.get(r.entityId);
      if (!owner || !spaces.has(owner)) return false;
      // Page-owned records answer to page-level visibility too: a draft or a
      // private page must not narrate its title through the feed to viewers
      // the page tree itself refuses.
      const meta = owners.pageMetaOf.get(r.entityId);
      if (!meta) return true; // the space itself
      return canSeePage(meta, actor.userId, editorSpaces.has(owner));
    }
    return true;
  }).map((r) => redactMoveDestination(r, projects));
}

/**
 * A task moved to another project leaves a `moved` record on the task left
 * behind, naming the destination project and the new task. Whoever could see
 * the old task can read its trail, but only those who can open the
 * destination learn where it went: for everyone else the record says that it
 * moved and nothing more.
 */
function redactMoveDestination<T extends { entityType: string }>(row: T, projects: ReadonlySet<string>): T {
  const r = row as T & { action?: unknown; diff?: unknown };
  if (r.entityType !== 'task' || r.action !== 'moved' || !r.diff || typeof r.diff !== 'object') return row;
  const { targetProjectId, newTaskId, ...rest } = r.diff as Record<string, unknown>;
  if (targetProjectId === undefined && newTaskId === undefined) return row;
  const to = (targetProjectId as { to?: unknown } | undefined)?.to;
  if (typeof to === 'string' && projects.has(to)) return row;
  return { ...row, diff: rest };
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
