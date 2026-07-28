/**
 * Projects + Tasks domain service (PRD §8). Business logic for projects, task
 * workflows, tasks, cycles, intake, drafts, templates. Reads are membership-gated
 * (assertProject / accessibleProjectIds); config changes require project admin or
 * settings.manage. Money/numeric columns are strings.
 */
import {
  getDb, schema, eq, and, or, isNull, isNotNull, inArray, notInArray, desc, asc, sql, type SQL,
} from '@ordi/db';
import { ulid } from 'ulid';
import { MAX_SUBTASK_DEPTH, appendPosition, buildBranchName, type CustomFieldFilter, type LabelScope } from '@ordi/shared';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { emit } from '../../core/events';
import { assertVersion } from '../../core/locking';
import { assertProject, accessibleProjectIds } from '../../core/access';
import { buildCustomFieldFilter, mergeCustomFields } from '../../core/customfields';
import { extractMentions } from '../kb/service';
import { encrypt, generateToken } from '../../lib/crypto';
import { queueEmail } from '../../lib/email';
import { asLocale, loadBranding, renderEmail, tr } from '../../lib/email-templates';
import { page } from '../../lib/http';

const { tasks, projects, taskStatuses, taskAssignees, taskLabels, projectMembers, cycles } = schema;

// ── Default status workflow seeded on every new project (PRD §8.2) ──
const DEFAULT_STATUSES: { name: string; category: string; color: string; isDefault: boolean }[] = [
  { name: 'Backlog', category: 'backlog', color: '#6b7280', isDefault: false },
  { name: 'Todo', category: 'todo', color: '#3b82f6', isDefault: true },
  { name: 'In Progress', category: 'in_progress', color: '#f59e0b', isDefault: false },
  { name: 'In Review', category: 'in_progress', color: '#8b5cf6', isDefault: false },
  { name: 'Done', category: 'done', color: '#10b981', isDefault: false },
  { name: 'Canceled', category: 'canceled', color: '#ef4444', isDefault: false },
];

function refOf(key: string, number: number): string {
  return `${key}-${number}`;
}

/**
 * Labels come in two vocabularies (`labels.scope`): a task takes task labels,
 * a project project ones. Refuse the mismatch instead of dropping the ids –
 * a save that silently ignores half its input is the worse failure.
 */
async function assertLabelScope(ids: string[], scope: LabelScope): Promise<void> {
  if (!ids.length) return;
  const { db } = getDb();
  const rows = await db.select({ id: schema.labels.id, scope: schema.labels.scope })
    .from(schema.labels).where(inArray(schema.labels.id, ids));
  const wrong = ids.filter((id) => rows.find((r) => r.id === id)?.scope !== scope);
  if (wrong.length) throw err.domain(`Not ${scope} labels: ${wrong.join(', ')}`);
}

async function projectKey(projectId: string): Promise<string> {
  const { db } = getDb();
  const [p] = await db.select({ key: projects.key }).from(projects).where(eq(projects.id, projectId));
  return p?.key ?? '';
}

/** Default (or first) status id for a project. */
async function defaultStatusId(projectId: string): Promise<string> {
  const { db } = getDb();
  const rows = await db.select({ id: taskStatuses.id, isDefault: taskStatuses.isDefault, position: taskStatuses.position })
    .from(taskStatuses).where(eq(taskStatuses.projectId, projectId)).orderBy(asc(taskStatuses.position));
  const def = rows.find((r) => r.isDefault) ?? rows[0];
  if (!def) throw err.domain('Project has no task statuses');
  return def.id;
}

async function nextTaskPosition(projectId: string): Promise<string> {
  const { db } = getDb();
  const [row] = await db.select({ maxPos: sql<string | null>`max(${tasks.position})` })
    .from(tasks).where(eq(tasks.projectId, projectId));
  const last = row?.maxPos != null ? Number(row.maxPos) : null;
  return String(appendPosition(last));
}

async function loadTask(id: string) {
  const { db } = getDb();
  const [t] = await db.select().from(tasks).where(and(eq(tasks.id, id), isNull(tasks.deletedAt)));
  if (!t) throw err.notFound('Task not found');
  return t;
}

async function taskRef(t: { projectId: string; number: number }): Promise<string> {
  return refOf(await projectKey(t.projectId), t.number);
}

async function assigneeIdsOf(taskId: string): Promise<string[]> {
  const { db } = getDb();
  const rows = await db.select({ userId: taskAssignees.userId }).from(taskAssignees).where(eq(taskAssignees.taskId, taskId));
  return rows.map((r) => r.userId);
}

// ─────────────────────────── Projects ───────────────────────────

export async function listProjects(actor: Actor, filters: { typeId?: string; status?: string; companyId?: string }) {
  const { db } = getDb();
  const ids = await accessibleProjectIds(actor);
  if (!ids.length) return [];
  return db.select().from(projects).where(and(
    isNull(projects.deletedAt),
    inArray(projects.id, ids),
    filters.typeId ? eq(projects.projectTypeId, filters.typeId) : undefined,
    filters.status ? eq(projects.status, filters.status) : undefined,
    filters.companyId ? eq(projects.companyId, filters.companyId) : undefined,
  )).orderBy(desc(projects.createdAt));
}

/**
 * Load a project type and validate the desired company link. requiresClient
 * means the client is mandatory – not that other types cannot have one: any
 * project may be linked to a client (the CRM Projects card and the project
 * rail both offer it), so a provided companyId is kept as-is.
 */
async function resolveTypeCompany(projectTypeId: string, companyId: string | null | undefined): Promise<{ typeId: string; companyId: string | null }> {
  const { db } = getDb();
  const [type] = await db.select().from(schema.projectTypes).where(eq(schema.projectTypes.id, projectTypeId));
  if (!type) throw err.validation('Project type not found', { projectTypeId });
  if (type.requiresClient && !companyId) {
    throw err.validation(`Project type "${type.name}" requires a client`, { projectTypeId });
  }
  return { typeId: type.id, companyId: companyId ?? null };
}

export async function createProject(actor: Actor, input: any): Promise<{ id: string; key: string }> {
  const { db } = getDb();
  // Friendly duplicate-key guard – otherwise the unique index surfaces as a 500.
  const [dupe] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.key, input.key), isNull(projects.deletedAt)));
  if (dupe) throw err.domain(`Project key "${input.key}" is already in use – pick another key.`);
  const { typeId, companyId } = await resolveTypeCompany(input.projectTypeId, input.companyId);
  const id = ulid();
  await db.insert(projects).values({
    id,
    companyId,
    name: input.name,
    key: input.key,
    projectTypeId: typeId,
    templateSourceId: input.templateSourceId ?? null,
    status: 'active',
    visibility: input.visibility ?? 'workspace',
    leadId: input.leadId ?? null,
    startDate: input.startDate ?? null,
    targetDate: input.targetDate ?? null,
    description: input.description ?? null,
    settings: { estimateUnit: input.estimateUnit ?? 'hours' },
    customFields: input.customFields ?? {},
    createdBy: actor.userId,
  });

  // Seed statuses: from template definition if provided, else workspace default.
  let statusSeed = DEFAULT_STATUSES;
  if (input.templateSourceId) {
    const [tpl] = await db.select().from(schema.projectTemplates).where(eq(schema.projectTemplates.id, input.templateSourceId));
    const def = (tpl?.definition ?? {}) as any;
    if (Array.isArray(def.taskStatuses) && def.taskStatuses.length) {
      statusSeed = def.taskStatuses.map((s: any, i: number) => ({
        name: String(s.name ?? `Status ${i + 1}`),
        category: String(s.category ?? 'todo'),
        color: String(s.color ?? '#6b7280'),
        isDefault: !!s.isDefault,
      }));
      const first = statusSeed[0];
      if (first && !statusSeed.some((s) => s.isDefault)) first.isDefault = true;
    }
  }
  await db.insert(taskStatuses).values(statusSeed.map((s, i) => ({
    id: ulid(), projectId: id, name: s.name, category: s.category, color: s.color,
    position: (i + 1) * 1000, isDefault: s.isDefault,
  })));

  // Creator is a project admin (PRD §4.4).
  await db.insert(projectMembers).values({ projectId: id, userId: actor.userId, role: 'admin', canWriteTasks: true });

  // Intake settings row with a random form token, disabled by default (PRD §8.6).
  await db.insert(schema.intakeSettings).values({ projectId: id, formToken: generateToken(), formEnabled: false });

  await emit({ type: 'project.created', aggregateType: 'project', aggregateId: id, payload: { key: input.key, typeId, companyId }, actorId: actor.userId, actorType: actor.actorType });
  await writeActivity(db, { entityType: 'project', entityId: id, action: 'created', after: input, actorId: actor.userId, actorType: actor.actorType });
  return { id, key: input.key };
}

export async function getProject(actor: Actor, id: string) {
  await assertProject(actor, id, 'viewer');
  const { db } = getDb();
  const [project] = await db.select().from(projects).where(and(eq(projects.id, id), isNull(projects.deletedAt)));
  if (!project) throw err.notFound('Project not found');
  const labelRows = await db.select({ labelId: schema.projectLabels.labelId })
    .from(schema.projectLabels).where(eq(schema.projectLabels.projectId, id));
  return { ...project, labelIds: labelRows.map((r) => r.labelId) };
}

export async function updateProject(actor: Actor, id: string, input: any) {
  await assertProject(actor, id, 'admin');
  const { db } = getDb();
  const [before] = await db.select().from(projects).where(and(eq(projects.id, id), isNull(projects.deletedAt)));
  if (!before) throw err.notFound('Project not found');
  assertVersion(before, input.version, before);
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'status', 'visibility', 'leadId', 'startDate', 'targetDate', 'description', 'summary', 'priority', 'links']) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  if (input.customFields !== undefined) patch.customFields = mergeCustomFields(before.customFields, input.customFields);
  // Company / type changes go through the same requiresClient rule as create.
  // These keys were silently dropped before, which made the rail's company and
  // type pickers (and CRM's "link existing project") 200-OK no-ops.
  if (input.companyId !== undefined || input.projectTypeId !== undefined) {
    const resolved = await resolveTypeCompany(
      input.projectTypeId ?? before.projectTypeId,
      input.companyId !== undefined ? input.companyId : before.companyId,
    );
    patch.projectTypeId = resolved.typeId;
    patch.companyId = resolved.companyId;
  }
  // Project labels: replace the join set when labelIds is provided.
  if (input.labelIds !== undefined) {
    const next: string[] = input.labelIds;
    await assertLabelScope(next, 'project');
    await db.delete(schema.projectLabels).where(eq(schema.projectLabels.projectId, id));
    if (next.length) await db.insert(schema.projectLabels).values(next.map((labelId) => ({ projectId: id, labelId })));
  }
  // Changing the type re-applies its behaviour: requiresClient needs the existing
  // company link; a type without a client detaches the company.
  if (input.projectTypeId !== undefined && input.projectTypeId !== before.projectTypeId) {
    const { typeId, companyId } = await resolveTypeCompany(input.projectTypeId, before.companyId);
    patch.projectTypeId = typeId;
    if (companyId !== before.companyId) patch.companyId = companyId;
  }
  // Merge settings keys (never blindly replace – preserve estimateUnit etc.).
  if (input.estimateUnit !== undefined || input.settings !== undefined) {
    const merged: Record<string, unknown> = { ...(before.settings as Record<string, unknown>) };
    if (input.settings && typeof input.settings === 'object') {
      for (const [k, v] of Object.entries(input.settings as Record<string, unknown>)) merged[k] = v;
    }
    if (input.estimateUnit !== undefined) merged.estimateUnit = input.estimateUnit;
    patch.settings = merged;
  }
  if (Object.keys(patch).length) {
    await db.update(projects).set(patch).where(and(eq(projects.id, id), eq(projects.version, before.version)));
  }
  if (input.status === 'completed' && before.status !== 'completed') {
    await emit({ type: 'project.completed', aggregateType: 'project', aggregateId: id, payload: { key: before.key, companyId: before.companyId }, actorId: actor.userId, actorType: actor.actorType });
  }
  const logged = input.labelIds !== undefined ? { ...patch, labelIds: input.labelIds } : patch;
  await writeActivity(db, { entityType: 'project', entityId: id, action: 'updated', before, after: logged, actorId: actor.userId, actorType: actor.actorType });
  const [updated] = await db.select().from(projects).where(eq(projects.id, id));
  return updated;
}

export async function softDeleteProject(actor: Actor, id: string) {
  await assertProject(actor, id, 'admin');
  const { db } = getDb();
  await db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, id));
  await writeActivity(db, { entityType: 'project', entityId: id, action: 'deleted', actorId: actor.userId, actorType: actor.actorType });
}

// ── Members ──
export async function listMembers(actor: Actor, projectId: string) {
  await assertProject(actor, projectId, 'viewer');
  const { db } = getDb();
  return db.select().from(projectMembers).where(eq(projectMembers.projectId, projectId));
}

export async function upsertMember(actor: Actor, projectId: string, input: any) {
  await assertProject(actor, projectId, 'admin');
  const { db } = getDb();
  await db.insert(projectMembers)
    .values({ projectId, userId: input.userId, role: input.role, canWriteTasks: input.canWriteTasks })
    .onConflictDoUpdate({ target: [projectMembers.projectId, projectMembers.userId], set: { role: input.role, canWriteTasks: input.canWriteTasks } });
  await writeActivity(db, { entityType: 'project', entityId: projectId, action: 'member_added', after: input, actorId: actor.userId, actorType: actor.actorType });
}

export async function removeMember(actor: Actor, projectId: string, userId: string) {
  await assertProject(actor, projectId, 'admin');
  const { db } = getDb();
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  await writeActivity(db, { entityType: 'project', entityId: projectId, action: 'member_removed', after: { userId }, actorId: actor.userId, actorType: actor.actorType });
}

// ── Task statuses (PRD §8.2) ──
export async function listTaskStatuses(actor: Actor, projectId: string) {
  await assertProject(actor, projectId, 'viewer');
  const { db } = getDb();
  return db.select().from(taskStatuses).where(eq(taskStatuses.projectId, projectId)).orderBy(asc(taskStatuses.position));
}

export async function createTaskStatus(actor: Actor, projectId: string, input: any) {
  await assertProject(actor, projectId, 'admin');
  const { db } = getDb();
  const id = ulid();
  if (input.isDefault) {
    await db.update(taskStatuses).set({ isDefault: false }).where(eq(taskStatuses.projectId, projectId));
  }
  await db.insert(taskStatuses).values({
    id, projectId, name: input.name, category: input.category, color: input.color,
    position: input.position ?? 0, isDefault: input.isDefault ?? false,
  });
  return { id };
}

export async function updateTaskStatus(actor: Actor, statusId: string, input: any) {
  const { db } = getDb();
  const [status] = await db.select().from(taskStatuses).where(eq(taskStatuses.id, statusId));
  if (!status) throw err.notFound('Status not found');
  await assertProject(actor, status.projectId, 'admin');
  if (input.isDefault === true) {
    await db.update(taskStatuses).set({ isDefault: false }).where(eq(taskStatuses.projectId, status.projectId));
  }
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'category', 'color', 'position', 'isDefault']) if (input[k] !== undefined) patch[k] = input[k];
  if (Object.keys(patch).length) await db.update(taskStatuses).set(patch).where(eq(taskStatuses.id, statusId));
  return { ok: true };
}

export async function deleteTaskStatus(actor: Actor, statusId: string, migrateTo: string | undefined) {
  const { db } = getDb();
  const [status] = await db.select().from(taskStatuses).where(eq(taskStatuses.id, statusId));
  if (!status) throw err.notFound('Status not found');
  await assertProject(actor, status.projectId, 'admin');
  if (!migrateTo) throw err.validation('migrateTo status id required to delete a status');
  const [target] = await db.select().from(taskStatuses).where(and(eq(taskStatuses.id, migrateTo), eq(taskStatuses.projectId, status.projectId)));
  if (!target) throw err.validation('migrateTo must be a status in the same project');
  await db.update(tasks).set({ statusId: migrateTo }).where(eq(tasks.statusId, statusId));
  await db.delete(taskStatuses).where(eq(taskStatuses.id, statusId));
  return { ok: true };
}

// ── Save project as template (PRD §8.1) ──
export async function saveProjectAsTemplate(actor: Actor, projectId: string, name: string) {
  await assertProject(actor, projectId, 'admin');
  const { db } = getDb();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw err.notFound('Project not found');
  const statuses = await db.select().from(taskStatuses).where(eq(taskStatuses.projectId, projectId)).orderBy(asc(taskStatuses.position));
  const types = await db.select().from(schema.taskTypes).where(eq(schema.taskTypes.projectId, projectId));
  const usedLabels = await db.selectDistinct({ id: schema.labels.id, name: schema.labels.name, color: schema.labels.color })
    .from(schema.labels)
    .innerJoin(taskLabels, eq(taskLabels.labelId, schema.labels.id))
    .innerJoin(tasks, eq(tasks.id, taskLabels.taskId))
    .where(eq(tasks.projectId, projectId));
  const definition = {
    taskStatuses: statuses.map((s) => ({ name: s.name, category: s.category, color: s.color, isDefault: s.isDefault })),
    taskTypes: types.map((t) => ({ name: t.name, icon: t.icon, color: t.color })),
    labels: usedLabels.map((l) => ({ name: l.name, color: l.color })),
  };
  const id = ulid();
  await db.insert(schema.projectTemplates).values({ id, name: name || `${project.name} template`, definition, createdBy: actor.userId });
  return { id };
}

// ─────────────────────────── Tasks ───────────────────────────

async function assertSubtaskDepth(parentId: string | null | undefined) {
  if (!parentId) return;
  const { db } = getDb();
  let ancestors = 0;
  let current: string | null = parentId;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    ancestors++;
    if (ancestors + 1 > MAX_SUBTASK_DEPTH) throw err.domain(`Max subtask depth (${MAX_SUBTASK_DEPTH}) exceeded`);
    const [row] = await db.select({ parentId: tasks.parentId }).from(tasks).where(eq(tasks.id, current));
    current = row?.parentId ?? null;
  }
}

export async function listTasks(actor: Actor, params: {
  projectId?: string; status?: string; priority?: string; assignee?: string; cycleId?: string;
  type?: string; label?: string; q?: string; cfFilters?: CustomFieldFilter[]; limit: number;
}) {
  const { db } = getDb();
  let scope: string[];
  if (params.projectId) {
    await assertProject(actor, params.projectId, 'viewer');
    scope = [params.projectId];
  } else {
    scope = await accessibleProjectIds(actor);
  }
  if (!scope.length) return { data: [], nextCursor: null };

  const cf: SQL[] = [];
  for (const f of params.cfFilters ?? []) cf.push(await buildCustomFieldFilter('tasks', f));

  const rows = await db.select().from(tasks).where(and(
    isNull(tasks.deletedAt),
    inArray(tasks.projectId, scope),
    params.status ? eq(tasks.statusId, params.status) : undefined,
    params.priority ? eq(tasks.priority, params.priority) : undefined,
    params.cycleId ? eq(tasks.cycleId, params.cycleId) : undefined,
    params.type ? eq(tasks.typeId, params.type) : undefined,
    params.q ? sql`${tasks.title} ilike ${'%' + params.q + '%'}` : undefined,
    params.assignee ? inArray(tasks.id, db.select({ id: taskAssignees.taskId }).from(taskAssignees).where(eq(taskAssignees.userId, params.assignee))) : undefined,
    params.label ? inArray(tasks.id, db.select({ id: taskLabels.taskId }).from(taskLabels).where(eq(taskLabels.labelId, params.label))) : undefined,
    ...cf,
  )).orderBy(desc(tasks.createdAt)).limit(params.limit + 1);

  const paged = page(rows, params.limit, (r) => ({ createdAt: r.createdAt }));
  const ids = paged.data.map((t) => t.id);
  const projectIds = [...new Set(paged.data.map((t) => t.projectId))];

  const keyRows = projectIds.length
    ? await db.select({ id: projects.id, key: projects.key }).from(projects).where(inArray(projects.id, projectIds))
    : [];
  const keyMap = new Map(keyRows.map((r) => [r.id, r.key]));
  const assignRows = ids.length
    ? await db.select({ taskId: taskAssignees.taskId, userId: taskAssignees.userId }).from(taskAssignees).where(inArray(taskAssignees.taskId, ids))
    : [];
  const labelRows = ids.length
    ? await db.select({ taskId: taskLabels.taskId, labelId: taskLabels.labelId }).from(taskLabels).where(inArray(taskLabels.taskId, ids))
    : [];

  const data = paged.data.map((t) => ({
    ...t,
    ref: refOf(keyMap.get(t.projectId) ?? '', t.number),
    assigneeIds: assignRows.filter((a) => a.taskId === t.id).map((a) => a.userId),
    labelIds: labelRows.filter((l) => l.taskId === t.id).map((l) => l.labelId),
  }));
  return { data, nextCursor: paged.nextCursor };
}

export async function createTask(actor: Actor, input: any) {
  await assertProject(actor, input.projectId, 'member');
  await assertSubtaskDepth(input.parentId);
  const assigneeIds: string[] = input.assigneeIds ?? [];
  const labelIds: string[] = input.labelIds ?? [];
  // Before the row exists: a rejected label must not leave a half-created task.
  await assertLabelScope(labelIds, 'task');
  const { db } = getDb();
  const id = ulid();
  const statusId = input.statusId ?? (await defaultStatusId(input.projectId));
  const position = await nextTaskPosition(input.projectId);
  await db.insert(tasks).values({
    id, projectId: input.projectId, number: 0, title: input.title,
    description: input.description ?? null, statusId, typeId: input.typeId ?? null,
    priority: input.priority ?? 'none', parentId: input.parentId ?? null,
    dueDate: input.dueDate ?? null, startDate: input.startDate ?? null,
    estimate: input.estimate != null ? String(input.estimate) : null,
    cycleId: input.cycleId ?? null, position, customFields: input.customFields ?? {},
    createdBy: actor.userId,
  });
  if (assigneeIds.length) await db.insert(taskAssignees).values(assigneeIds.map((userId) => ({ taskId: id, userId })));
  if (labelIds.length) await db.insert(taskLabels).values(labelIds.map((labelId) => ({ taskId: id, labelId })));

  const task = await loadTask(id);
  const ref = await taskRef(task);
  await emit({ type: 'task.created', aggregateType: 'task', aggregateId: id, payload: { ref, taskId: id, projectId: input.projectId }, actorId: actor.userId, actorType: actor.actorType });
  if (assigneeIds.length) {
    await emit({ type: 'task.assigned', aggregateType: 'task', aggregateId: id, payload: { assigneeIds, ref, taskId: id, projectId: input.projectId }, actorId: actor.userId, actorType: actor.actorType });
  }
  await writeActivity(db, { entityType: 'task', entityId: id, action: 'created', after: input, actorId: actor.userId, actorType: actor.actorType });
  return { ...task, ref };
}

export async function getTask(actor: Actor, id: string, include: string[]) {
  const { db } = getDb();
  const task = await loadTask(id);
  await assertProject(actor, task.projectId, 'viewer');
  const ref = await taskRef(task);
  const out: Record<string, unknown> = { ...task, ref };
  const want = new Set(include);

  if (want.has('assignees')) {
    out.assignees = await db.select({ userId: taskAssignees.userId, name: schema.users.name, email: schema.users.email })
      .from(taskAssignees).innerJoin(schema.users, eq(schema.users.id, taskAssignees.userId)).where(eq(taskAssignees.taskId, id));
  }
  if (want.has('labels')) {
    out.labels = await db.select({ id: schema.labels.id, name: schema.labels.name, color: schema.labels.color })
      .from(taskLabels).innerJoin(schema.labels, eq(schema.labels.id, taskLabels.labelId)).where(eq(taskLabels.taskId, id));
  }
  if (want.has('relations')) {
    const outgoing = await db.select().from(schema.taskRelations).where(eq(schema.taskRelations.taskId, id));
    const incoming = await db.select().from(schema.taskRelations).where(eq(schema.taskRelations.relatedTaskId, id));
    const otherIds = [...new Set([...outgoing.map((r) => r.relatedTaskId), ...incoming.map((r) => r.taskId)])];
    const refMap = await refsFor(otherIds);
    out.relations = {
      outgoing: outgoing.map((r) => ({ ...r, relatedRef: refMap.get(r.relatedTaskId) ?? null })),
      incoming: incoming.map((r) => ({ ...r, relatedRef: refMap.get(r.taskId) ?? null })),
    };
  }
  if (want.has('links')) {
    out.links = await db.select().from(schema.taskLinks).where(eq(schema.taskLinks.taskId, id));
  }
  if (want.has('comments')) {
    out.comments = await db.select().from(schema.comments).where(and(eq(schema.comments.taskId, id), isNull(schema.comments.deletedAt))).orderBy(asc(schema.comments.createdAt));
  }
  if (want.has('git_links')) {
    out.gitLinks = await db.select().from(schema.gitLinks).where(eq(schema.gitLinks.taskId, id));
  }
  return out;
}

async function refsFor(taskIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!taskIds.length) return map;
  const { db } = getDb();
  const rows = await db.select({ id: tasks.id, number: tasks.number, key: projects.key })
    .from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId)).where(inArray(tasks.id, taskIds));
  for (const r of rows) map.set(r.id, refOf(r.key, r.number));
  return map;
}

export async function updateTask(actor: Actor, id: string, input: any) {
  const { db } = getDb();
  const before = await loadTask(id);
  await assertProject(actor, before.projectId, 'member');
  assertVersion(before, input.version, before);

  const patch: Record<string, unknown> = {};
  for (const k of ['title', 'description', 'statusId', 'typeId', 'priority', 'parentId', 'dueDate', 'startDate', 'cycleId']) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  if (input.customFields !== undefined) patch.customFields = mergeCustomFields(before.customFields, input.customFields);
  if (input.estimate !== undefined) patch.estimate = input.estimate != null ? String(input.estimate) : null;
  if (input.parentId !== undefined && input.parentId) await assertSubtaskDepth(input.parentId);
  if (Object.keys(patch).length) {
    await db.update(tasks).set(patch).where(and(eq(tasks.id, id), eq(tasks.version, before.version)));
  }

  const oldAssignees = await assigneeIdsOf(id);
  let finalAssignees = oldAssignees;
  let newAssignees: string[] = [];
  if (input.assigneeIds !== undefined) {
    const next: string[] = input.assigneeIds;
    await db.delete(taskAssignees).where(eq(taskAssignees.taskId, id));
    if (next.length) await db.insert(taskAssignees).values(next.map((userId) => ({ taskId: id, userId })));
    newAssignees = next.filter((a) => !oldAssignees.includes(a));
    finalAssignees = next;
  }
  if (input.labelIds !== undefined) {
    const next: string[] = input.labelIds;
    await assertLabelScope(next, 'task');
    await db.delete(taskLabels).where(eq(taskLabels.taskId, id));
    if (next.length) await db.insert(taskLabels).values(next.map((labelId) => ({ taskId: id, labelId })));
  }

  const ref = await taskRef(before);
  if (input.statusId !== undefined && input.statusId !== before.statusId) {
    await emit({ type: 'task.status_changed', aggregateType: 'task', aggregateId: id, payload: { ref, taskId: id, assigneeIds: finalAssignees, createdBy: before.createdBy, projectId: before.projectId }, actorId: actor.userId, actorType: actor.actorType });
  }
  if (newAssignees.length) {
    await emit({ type: 'task.assigned', aggregateType: 'task', aggregateId: id, payload: { assigneeIds: newAssignees, ref, taskId: id, projectId: before.projectId }, actorId: actor.userId, actorType: actor.actorType });
  }
  await writeActivity(db, { entityType: 'task', entityId: id, action: 'updated', before, after: patch, actorId: actor.userId, actorType: actor.actorType });
  const task = await loadTask(id);
  return { ...task, ref };
}

export async function softDeleteTask(actor: Actor, id: string) {
  const { db } = getDb();
  const task = await loadTask(id);
  await assertProject(actor, task.projectId, 'member');
  await db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, id));
  await writeActivity(db, { entityType: 'task', entityId: id, action: 'deleted', actorId: actor.userId, actorType: actor.actorType });
}

export async function moveTask(actor: Actor, id: string, targetProjectId: string) {
  const { db } = getDb();
  const source = await loadTask(id);
  await assertProject(actor, source.projectId, 'member');
  await assertProject(actor, targetProjectId, 'member');
  const statusId = await defaultStatusId(targetProjectId);
  const position = await nextTaskPosition(targetProjectId);
  const newId = ulid();
  await db.insert(tasks).values({
    id: newId, projectId: targetProjectId, number: 0, title: source.title,
    description: source.description, statusId, typeId: null, priority: source.priority,
    parentId: null, dueDate: source.dueDate, startDate: source.startDate,
    estimate: source.estimate, cycleId: null, position, customFields: source.customFields,
    createdBy: actor.userId,
  });
  const assignees = await assigneeIdsOf(id);
  if (assignees.length) await db.insert(taskAssignees).values(assignees.map((userId) => ({ taskId: newId, userId })));
  const labelRows = await db.select({ labelId: taskLabels.labelId }).from(taskLabels).where(eq(taskLabels.taskId, id));
  if (labelRows.length) await db.insert(taskLabels).values(labelRows.map((l) => ({ taskId: newId, labelId: l.labelId })));

  await db.update(tasks).set({ redirectToTaskId: newId, deletedAt: new Date() }).where(eq(tasks.id, id));
  const task = await loadTask(newId);
  const ref = await taskRef(task);
  await emit({ type: 'task.created', aggregateType: 'task', aggregateId: newId, payload: { ref, projectId: targetProjectId, movedFrom: id }, actorId: actor.userId, actorType: actor.actorType });
  await writeActivity(db, { entityType: 'task', entityId: id, action: 'moved', after: { targetProjectId, newTaskId: newId }, actorId: actor.userId, actorType: actor.actorType });
  return { ...task, ref };
}

export async function duplicateTask(actor: Actor, id: string) {
  const { db } = getDb();
  const source = await loadTask(id);
  await assertProject(actor, source.projectId, 'member');
  const position = await nextTaskPosition(source.projectId);
  const newId = ulid();
  await db.insert(tasks).values({
    id: newId, projectId: source.projectId, number: 0, title: `${source.title} (copy)`,
    description: source.description, statusId: source.statusId, typeId: source.typeId, priority: source.priority,
    parentId: source.parentId, dueDate: source.dueDate, startDate: source.startDate,
    estimate: source.estimate, cycleId: source.cycleId, position, customFields: source.customFields,
    createdBy: actor.userId,
  });
  const assignees = await assigneeIdsOf(id);
  if (assignees.length) await db.insert(taskAssignees).values(assignees.map((userId) => ({ taskId: newId, userId })));
  const labelRows = await db.select({ labelId: taskLabels.labelId }).from(taskLabels).where(eq(taskLabels.taskId, id));
  if (labelRows.length) await db.insert(taskLabels).values(labelRows.map((l) => ({ taskId: newId, labelId: l.labelId })));
  const task = await loadTask(newId);
  const ref = await taskRef(task);
  await emit({ type: 'task.created', aggregateType: 'task', aggregateId: newId, payload: { ref, projectId: source.projectId }, actorId: actor.userId, actorType: actor.actorType });
  return { ...task, ref };
}

// ── Relations & links ──
export async function addRelation(actor: Actor, taskId: string, input: any) {
  const { db } = getDb();
  const task = await loadTask(taskId);
  await assertProject(actor, task.projectId, 'member');
  const related = await loadTask(input.relatedTaskId);
  await assertProject(actor, related.projectId, 'viewer');
  const id = ulid();
  await db.insert(schema.taskRelations).values({ id, taskId, relatedTaskId: input.relatedTaskId, type: input.type });
  return { id };
}

export async function deleteRelation(actor: Actor, taskId: string, relId: string) {
  const { db } = getDb();
  const task = await loadTask(taskId);
  await assertProject(actor, task.projectId, 'member');
  await db.delete(schema.taskRelations).where(and(eq(schema.taskRelations.id, relId), eq(schema.taskRelations.taskId, taskId)));
  return { ok: true };
}

export async function addLink(actor: Actor, taskId: string, input: any) {
  const { db } = getDb();
  const task = await loadTask(taskId);
  await assertProject(actor, task.projectId, 'member');
  const id = ulid();
  await db.insert(schema.taskLinks).values({ id, taskId, url: input.url, title: input.title });
  return { id };
}

export async function deleteLink(actor: Actor, taskId: string, linkId: string) {
  const { db } = getDb();
  const task = await loadTask(taskId);
  await assertProject(actor, task.projectId, 'member');
  await db.delete(schema.taskLinks).where(and(eq(schema.taskLinks.id, linkId), eq(schema.taskLinks.taskId, taskId)));
  return { ok: true };
}

// ── Comments ──
export async function listComments(actor: Actor, taskId: string) {
  const task = await loadTask(taskId);
  await assertProject(actor, task.projectId, 'viewer');
  const { db } = getDb();
  return db.select().from(schema.comments).where(and(eq(schema.comments.taskId, taskId), isNull(schema.comments.deletedAt))).orderBy(asc(schema.comments.createdAt));
}

export async function addComment(actor: Actor, taskId: string, input: any) {
  const { db } = getDb();
  const task = await loadTask(taskId);
  await assertProject(actor, task.projectId, 'member');
  const id = ulid();
  await db.insert(schema.comments).values({ id, taskId, authorId: actor.userId, body: input.body ?? {} });
  // Mentions come from the explicit list plus any parsed out of the comment body,
  // so a client that only sends the tiptap doc still notifies the mentioned users.
  const mentions = [...new Set<string>([...(input.mentions ?? []), ...extractMentions(input.body).users])]
    .filter((u) => u !== actor.userId);
  if (mentions.length) {
    const ref = await taskRef(task);
    await emit({
      type: 'comment.mentioned',
      aggregateType: 'comment',
      aggregateId: id,
      payload: { mentions, ref, taskId, projectId: task.projectId, commentId: id },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
  }
  await writeActivity(db, { entityType: 'comment', entityId: id, action: 'created', actorId: actor.userId, actorType: actor.actorType });
  return { id };
}

export async function editComment(actor: Actor, commentId: string, body: unknown) {
  const { db } = getDb();
  const [comment] = await db.select().from(schema.comments).where(and(eq(schema.comments.id, commentId), isNull(schema.comments.deletedAt)));
  if (!comment) throw err.notFound('Comment not found');
  const task = await loadTask(comment.taskId);
  await assertProject(actor, task.projectId, 'member');
  if (comment.authorId !== actor.userId) {
    await assertProject(actor, task.projectId, 'admin');
  }
  await db.update(schema.comments).set({ body: body ?? {}, editedAt: new Date() }).where(eq(schema.comments.id, commentId));
  return { ok: true };
}

export async function deleteComment(actor: Actor, commentId: string) {
  const { db } = getDb();
  const [comment] = await db.select().from(schema.comments).where(and(eq(schema.comments.id, commentId), isNull(schema.comments.deletedAt)));
  if (!comment) throw err.notFound('Comment not found');
  const task = await loadTask(comment.taskId);
  await assertProject(actor, task.projectId, comment.authorId === actor.userId ? 'member' : 'admin');
  await db.update(schema.comments).set({ deletedAt: new Date() }).where(eq(schema.comments.id, commentId));
  return { ok: true };
}

// ── Bulk (PRD §8.3) ──
export async function bulkUpdateTasks(actor: Actor, input: any) {
  const { db } = getDb();
  if (input.labelIds !== undefined) await assertLabelScope(input.labelIds as string[], 'task');
  const rows = await db.select().from(tasks).where(and(inArray(tasks.id, input.taskIds), isNull(tasks.deletedAt)));
  let updated = 0;
  for (const t of rows) {
    const role = actor.access.projectMemberships.get(t.projectId);
    if (role !== 'admin' && role !== 'member') continue;
    const patch: Record<string, unknown> = {};
    if (input.statusId !== undefined) patch.statusId = input.statusId;
    if (input.cycleId !== undefined) patch.cycleId = input.cycleId;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (Object.keys(patch).length) await db.update(tasks).set(patch).where(eq(tasks.id, t.id));
    if (input.assigneeIds !== undefined) {
      await db.delete(taskAssignees).where(eq(taskAssignees.taskId, t.id));
      if (input.assigneeIds.length) await db.insert(taskAssignees).values((input.assigneeIds as string[]).map((userId) => ({ taskId: t.id, userId })));
    }
    if (input.labelIds !== undefined) {
      await db.delete(taskLabels).where(eq(taskLabels.taskId, t.id));
      if (input.labelIds.length) await db.insert(taskLabels).values((input.labelIds as string[]).map((labelId) => ({ taskId: t.id, labelId })));
    }
    updated++;
  }
  return { updated };
}

export async function branchName(actor: Actor, id: string) {
  const task = await loadTask(id);
  await assertProject(actor, task.projectId, 'viewer');
  const key = await projectKey(task.projectId);
  return { branch: buildBranchName({ key, number: task.number, title: task.title }) };
}

// ─────────────────────────── Cycles (PRD §8.4) ───────────────────────────

export async function listCycles(actor: Actor, projectId: string) {
  await assertProject(actor, projectId, 'viewer');
  const { db } = getDb();
  return db.select().from(cycles).where(eq(cycles.projectId, projectId)).orderBy(desc(cycles.startDate));
}

export async function createCycle(actor: Actor, input: any) {
  await assertProject(actor, input.projectId, 'admin');
  const { db } = getDb();
  const id = ulid();
  await db.insert(cycles).values({
    id, projectId: input.projectId, name: input.name, startDate: input.startDate,
    endDate: input.endDate, goal: input.goal ?? null, status: 'upcoming',
  });
  return { id };
}

async function loadCycle(id: string) {
  const { db } = getDb();
  const [cycle] = await db.select().from(cycles).where(eq(cycles.id, id));
  if (!cycle) throw err.notFound('Cycle not found');
  return cycle;
}

export async function updateCycle(actor: Actor, id: string, input: any) {
  const cycle = await loadCycle(id);
  await assertProject(actor, cycle.projectId, 'admin');
  assertVersion(cycle, input.version, cycle);
  const { db } = getDb();
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'startDate', 'endDate', 'goal', 'status']) if (input[k] !== undefined) patch[k] = input[k];
  if (Object.keys(patch).length) await db.update(cycles).set(patch).where(and(eq(cycles.id, id), eq(cycles.version, cycle.version)));
  return loadCycle(id);
}

export async function completeCycle(actor: Actor, id: string, input: any) {
  const cycle = await loadCycle(id);
  await assertProject(actor, cycle.projectId, 'admin');
  const { db } = getDb();
  const openStatuses = await db.select({ id: taskStatuses.id }).from(taskStatuses)
    .where(and(eq(taskStatuses.projectId, cycle.projectId), notInArray(taskStatuses.category, ['done', 'canceled'])));
  const openIds = openStatuses.map((s) => s.id);
  const destCycle = input.moveTo === 'next_cycle' ? (input.nextCycleId ?? null) : null;
  await db.update(tasks).set({ cycleId: destCycle }).where(and(
    eq(tasks.cycleId, id), isNull(tasks.deletedAt),
    openIds.length ? inArray(tasks.statusId, openIds) : sql`false`,
  ));
  await db.update(cycles).set({ status: 'completed' }).where(eq(cycles.id, id));
  await emit({ type: 'cycle.completed', aggregateType: 'cycle', aggregateId: id, payload: { projectId: cycle.projectId, movedTo: input.moveTo }, actorId: actor.userId, actorType: actor.actorType });
  await writeActivity(db, { entityType: 'cycle', entityId: id, action: 'completed', after: { moveTo: input.moveTo }, actorId: actor.userId, actorType: actor.actorType });
  return loadCycle(id);
}

export async function cycleProgress(actor: Actor, id: string) {
  const cycle = await loadCycle(id);
  await assertProject(actor, cycle.projectId, 'viewer');
  const { db } = getDb();
  const [row] = await db.execute(sql`
    select count(*)::int as total,
      count(*) filter (where ts.category = 'done')::int as done,
      coalesce(sum(t.estimate),0) as total_estimate,
      coalesce(sum(t.estimate) filter (where ts.category = 'done'),0) as done_estimate
    from tasks t join task_statuses ts on ts.id = t.status_id
    where t.cycle_id = ${id} and t.deleted_at is null`) as any[];
  return {
    cycle,
    total: Number(row?.total ?? 0),
    done: Number(row?.done ?? 0),
    totalEstimate: Number(row?.total_estimate ?? 0),
    doneEstimate: Number(row?.done_estimate ?? 0),
  };
}

export async function cycleSnapshots(actor: Actor, id: string) {
  const cycle = await loadCycle(id);
  await assertProject(actor, cycle.projectId, 'viewer');
  const { db } = getDb();
  return db.select().from(schema.cycleSnapshots).where(eq(schema.cycleSnapshots.cycleId, id)).orderBy(asc(schema.cycleSnapshots.date));
}

// ─────────────────────────── Intake (PRD §8.6) ───────────────────────────

export async function listIntake(actor: Actor, projectId: string) {
  await assertProject(actor, projectId, 'member');
  const { db } = getDb();
  return db.select().from(schema.intakeItems)
    .where(and(eq(schema.intakeItems.projectId, projectId), eq(schema.intakeItems.status, 'pending')))
    .orderBy(desc(schema.intakeItems.createdAt));
}

async function loadIntakeItem(itemId: string) {
  const { db } = getDb();
  const [item] = await db.select().from(schema.intakeItems).where(eq(schema.intakeItems.id, itemId));
  if (!item) throw err.notFound('Intake item not found');
  return item;
}

export async function acceptIntake(actor: Actor, itemId: string, input: any) {
  const item = await loadIntakeItem(itemId);
  await assertProject(actor, item.projectId, 'member');
  if (item.status !== 'pending') throw err.domain('Intake item already triaged');
  const description = item.description
    ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: item.description }] }] }
    : null;
  const task = await createTask(actor, {
    projectId: item.projectId, title: item.title, description,
    statusId: input.statusId, typeId: input.typeId ?? null, assigneeIds: input.assigneeIds ?? [],
  });
  const { db } = getDb();
  await db.update(schema.intakeItems).set({ status: 'accepted', createdTaskId: task.id }).where(eq(schema.intakeItems.id, itemId));
  if (item.requesterEmail) {
    await sendIntakeMail(item.requesterEmail, 'intakeAccepted', item.title, null);
  }
  return { taskId: task.id, ref: task.ref };
}

export async function declineIntake(actor: Actor, itemId: string, input: any) {
  const item = await loadIntakeItem(itemId);
  await assertProject(actor, item.projectId, 'member');
  if (item.status !== 'pending') throw err.domain('Intake item already triaged');
  const { db } = getDb();
  await db.update(schema.intakeItems).set({ status: 'declined', declineReason: input.reason ?? '' }).where(eq(schema.intakeItems.id, itemId));
  if (input.notify && item.requesterEmail) {
    await sendIntakeMail(item.requesterEmail, 'intakeDeclined', item.title, input.reason ?? null);
  }
  return { ok: true };
}

export async function getIntakeSettings(actor: Actor, projectId: string) {
  await assertProject(actor, projectId, 'admin');
  const { db } = getDb();
  const [settings] = await db.select().from(schema.intakeSettings).where(eq(schema.intakeSettings.projectId, projectId));
  if (!settings) throw err.notFound('Intake settings not found');
  return redactMailbox(settings);
}

/**
 * The mailbox password never leaves the server – callers get `hasPassword`
 * instead, and an update without one keeps whatever is stored.
 */
function redactMailbox<T extends { mailbox?: unknown } | undefined>(settings: T): T {
  if (!settings) return settings;
  const mailbox = settings.mailbox as Record<string, unknown> | null | undefined;
  if (!mailbox) return settings;
  const { pass, ...rest } = mailbox;
  return { ...settings, mailbox: { ...rest, hasPassword: Boolean(pass) } };
}

export async function updateIntakeSettings(actor: Actor, projectId: string, input: any) {
  await assertProject(actor, projectId, 'admin');
  const { db } = getDb();
  const patch: Record<string, unknown> = {};
  if (input.formEnabled !== undefined) patch.formEnabled = input.formEnabled;
  if (input.mailbox !== undefined) {
    if (input.mailbox === null) {
      patch.mailbox = null;
    } else {
      const [current] = await db.select().from(schema.intakeSettings).where(eq(schema.intakeSettings.projectId, projectId));
      const stored = (current?.mailbox ?? null) as Record<string, unknown> | null;
      const { hasPassword: _ignored, pass, ...rest } = input.mailbox as Record<string, unknown>;
      // Credentials are encrypted at rest, like git and Slack tokens.
      const nextPass = typeof pass === 'string' && pass.length > 0
        ? encrypt(pass)
        : (stored?.pass ?? null);
      patch.mailbox = { ...rest, ...(nextPass ? { pass: nextPass } : {}) };
    }
  }
  if (Object.keys(patch).length) await db.update(schema.intakeSettings).set(patch).where(eq(schema.intakeSettings.projectId, projectId));
  const [settings] = await db.select().from(schema.intakeSettings).where(eq(schema.intakeSettings.projectId, projectId));
  return redactMailbox(settings);
}

// ─────────────────────────── My tasks (PRD §8.5) ───────────────────────────

/**
 * The two lists a person triages by: what is assigned to them (bucketed by due
 * date) and what they created. They used to be one list, with created work
 * folded in under the assigned buckets, so a task filed for someone else read
 * as a task to do. `created` carries everything still open that the actor
 * filed, whoever ended up holding it.
 */
export async function myTasks(actor: Actor) {
  const ids = await accessibleProjectIds(actor);
  if (!ids.length) return { overdue: [], today: [], week: [], later: [], created: [] };
  const { db } = getDb();
  const inList = sql.raw('(' + ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(',') + ')');
  const today = new Date().toISOString().slice(0, 10);
  const weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  const assigned = await db.execute(sql`
    select t.id, t.title, t.due_date, t.priority, t.number, t.project_id, p.key, ts.category, ts.name as status_name, ts.color as status_color
    from tasks t
    join task_assignees ta on ta.task_id = t.id and ta.user_id = ${actor.userId}
    join projects p on p.id = t.project_id
    join task_statuses ts on ts.id = t.status_id
    where t.deleted_at is null and ts.category not in ('done','canceled') and t.project_id in ${inList}
    order by t.due_date nulls last`) as any[];

  const created = await db.execute(sql`
    select t.id, t.title, t.due_date, t.priority, t.number, t.project_id, p.key, ts.category, ts.name as status_name, ts.color as status_color,
      exists (select 1 from task_assignees ta where ta.task_id = t.id) as has_assignee
    from tasks t
    join projects p on p.id = t.project_id
    join task_statuses ts on ts.id = t.status_id
    where t.deleted_at is null and t.created_by = ${actor.userId}
      and ts.category not in ('done','canceled') and t.project_id in ${inList}
    order by t.due_date nulls last`) as any[];

  const withRef = (r: any) => ({ ...r, ref: refOf(r.key, r.number) });
  const rows = (assigned as any[]).map(withRef);
  return {
    overdue: rows.filter((t) => t.due_date && t.due_date < today),
    today: rows.filter((t) => t.due_date === today),
    week: rows.filter((t) => t.due_date && t.due_date > today && t.due_date <= weekEnd),
    later: rows.filter((t) => !t.due_date || t.due_date > weekEnd),
    created: (created as any[]).map(withRef),
  };
}

/** Intake decision mail to an external requester (workspace default locale). */
async function sendIntakeMail(to: string, kind: 'intakeAccepted' | 'intakeDeclined', title: string, reason: string | null): Promise<void> {
  const branding = await loadBranding();
  const locale = asLocale(undefined);
  const paragraphs = [tr(locale, `${kind}.body`, { title })];
  if (reason) paragraphs.push(tr(locale, 'intake.reason', { reason }));
  const rendered = renderEmail({
    locale,
    branding,
    heading: tr(locale, `${kind}.heading`),
    paragraphs,
  });
  await queueEmail({ to, subject: tr(locale, `${kind}.subject`), body: rendered.text, html: rendered.html });
}
