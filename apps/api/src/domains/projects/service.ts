/**
 * Projects + Tasks domain service (PRD §8). Business logic for projects, task
 * workflows, tasks, cycles, intake, drafts, templates. Reads are membership-gated
 * (assertProject / accessibleProjectIds); config changes require project admin or
 * settings.manage. Money/numeric columns are strings.
 */
import {
  getDb, schema, eq, and, or, isNull, isNotNull, inArray, notInArray, lte, desc, asc, sql, type SQL,
} from '@ordi/db';
import { ulid } from 'ulid';
import {
  MAX_SUBTASK_DEPTH, appendPosition, buildBranchName, normalizeIntakeFormConfig,
  type CustomFieldFilter, type IntakeAnswer, type LabelScope,
} from '@ordi/shared';
import type { Actor } from '../../context';
import { ApiException, err } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { writeActivity } from '../../core/activity';
import { emit, publishEvent } from '../../core/events';
import { assertVersion } from '../../core/locking';
import {
  assertProject, accessibleProjectIds, effectiveProjectRole, effectiveProjectRolesIncludingDeleted, userCanOpenProject,
} from '../../core/access';
import { closeProjectTimers, closeTimersOfOutsiders } from '../time/service';
import { cancelProjectRuns } from '../agents/runs';
import { agentAssignRefusals, agentProfilesAmong, assertCanAssignAgents } from '../agents/profiles';
import { assertNotPersonalAgent, personalAgentIdsOf } from '../agents/external';
import { buildCustomFieldFilter, mergeCustomFields } from '../../core/customfields';
import { extractMentions } from '../kb/service';
import { encrypt, generateToken } from '../../lib/crypto';
import { sendEmailNow } from '../../lib/email';
import { asLocale, loadBranding, renderEmail, tr } from '../../lib/email-templates';
import { pageById } from '../../lib/http';
import { intakeTaskDescription } from './intake';
import { answerByComment, moveQuestions, openQuestionView, tasksWaitingOn, waitingOnFor, withdrawQuestionsWaitingOn } from './questions';
import { isStorageConfigured } from '../../lib/s3';

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

async function nextTaskPosition(projectId: string, db: any = getDb().db): Promise<string> {
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
  const [rows, latest] = await Promise.all([
    db.select().from(projects).where(and(
      isNull(projects.deletedAt),
      inArray(projects.id, ids),
      filters.typeId ? eq(projects.projectTypeId, filters.typeId) : undefined,
      filters.status ? eq(projects.status, filters.status) : undefined,
      filters.companyId ? eq(projects.companyId, filters.companyId) : undefined,
    )).orderBy(desc(projects.createdAt)),
    // Health as of each project's latest update (on_track | at_risk | off_track),
    // so the list can say which projects need a look.
    db.selectDistinctOn([schema.projectUpdates.projectId], {
      projectId: schema.projectUpdates.projectId,
      health: schema.projectUpdates.health,
      at: schema.projectUpdates.createdAt,
    }).from(schema.projectUpdates)
      .where(inArray(schema.projectUpdates.projectId, ids))
      .orderBy(schema.projectUpdates.projectId, desc(schema.projectUpdates.createdAt)),
  ]);
  const health = new Map(latest.map((r) => [r.projectId, { health: r.health, at: r.at }]));
  return rows.map((p) => ({ ...p, health: health.get(p.id)?.health ?? null, healthAt: health.get(p.id)?.at ?? null }));
}

/**
 * Per-project task totals in one grouped query. The projects list used to pull
 * every task of every project to draw a completion ring – one page load cost
 * N full task lists.
 */
export async function projectTaskCounts(actor: Actor) {
  const ids = await accessibleProjectIds(actor);
  if (!ids.length) return [];
  const { db } = getDb();
  const rows = await db.select({
    projectId: tasks.projectId,
    total: sql<number>`count(*)::int`,
    done: sql<number>`count(*) filter (where ${taskStatuses.category} = 'done')::int`,
  }).from(tasks)
    .innerJoin(taskStatuses, eq(taskStatuses.id, tasks.statusId))
    .where(and(isNull(tasks.deletedAt), inArray(tasks.projectId, ids)))
    .groupBy(tasks.projectId);
  return rows.map((row) => ({ projectId: row.projectId, total: Number(row.total), done: Number(row.done) }));
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
  const [labelRows, [anyCycle], [intake]] = await Promise.all([
    db.select({ labelId: schema.projectLabels.labelId }).from(schema.projectLabels).where(eq(schema.projectLabels.projectId, id)),
    db.select({ id: schema.cycles.id }).from(schema.cycles).where(eq(schema.cycles.projectId, id)).limit(1),
    db.select({ formEnabled: schema.intakeSettings.formEnabled, mailbox: schema.intakeSettings.mailbox })
      .from(schema.intakeSettings).where(eq(schema.intakeSettings.projectId, id)),
  ]);
  const settings = (project.settings ?? {}) as { cycles?: boolean };
  return {
    ...project,
    labelIds: labelRows.map((r) => r.labelId),
    // Cycles are opt-in per project. A project that already has cycles keeps
    // them until someone switches them off explicitly.
    cyclesEnabled: settings.cycles ?? !!anyCycle,
    // Intake earns its tab only once a channel (public form or mailbox) is on.
    intakeEnabled: !!intake?.formEnabled || !!(intake?.mailbox as { host?: string; user?: string } | null)?.host,
  };
}

export async function updateProject(actor: Actor, id: string, input: any) {
  await assertProject(actor, id, 'admin');
  const { db } = getDb();
  const [before] = await db.select().from(projects).where(and(eq(projects.id, id), isNull(projects.deletedAt)));
  if (!before) throw err.notFound('Project not found');
  assertVersion(before, input.version, before);
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'status', 'visibility', 'leadId', 'startDate', 'targetDate', 'description', 'summary', 'priority']) {
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
  const nextLabels: string[] | undefined = input.labelIds;
  if (nextLabels) await assertLabelScope(nextLabels, 'project');
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
  // Every check above runs before the first write, and the writes, the event
  // and the activity record share one transaction: a refused or failed edit
  // changes nothing – the labels included – and announces nothing.
  await db.transaction(async (tx) => {
    // The patch was built from `before`, and the caller named the version it
    // saw, so a change in between is a conflict.
    // NO KEY UPDATE, the lock the UPDATE takes anyway: it does not wait for the
    // key-share lock a task (or anything else) inserted under the project holds.
    const [locked] = await tx.select({ version: projects.version }).from(projects)
      .where(and(eq(projects.id, id), isNull(projects.deletedAt))).for('no key update');
    if (!locked) throw err.notFound('Project not found');
    if (input.version !== undefined && locked.version !== before.version) {
      const [current] = await tx.select().from(projects).where(eq(projects.id, id));
      throw err.conflict('The record was modified by someone else', current ?? before);
    }
    // Project labels: replace the join set when labelIds is provided.
    if (nextLabels) {
      await tx.delete(schema.projectLabels).where(eq(schema.projectLabels.projectId, id));
      if (nextLabels.length) await tx.insert(schema.projectLabels).values(nextLabels.map((labelId) => ({ projectId: id, labelId })));
    }
    if (Object.keys(patch).length) await tx.update(projects).set(patch).where(eq(projects.id, id));
    if (input.status === 'completed' && before.status !== 'completed') {
      await publishEvent(tx, { type: 'project.completed', aggregateType: 'project', aggregateId: id, payload: { key: before.key, companyId: before.companyId }, actorId: actor.userId, actorType: actor.actorType });
    }
    const logged = nextLabels ? { ...patch, labelIds: nextLabels } : patch;
    await writeActivity(tx, { entityType: 'project', entityId: id, action: 'updated', before, after: logged, actorId: actor.userId, actorType: actor.actorType });
  });
  const [updated] = await db.select().from(projects).where(eq(projects.id, id));
  return updated;
}

/**
 * Soft delete: the row and everything under it stay, so the project can be
 * restored. What runs on its own is filtered out by the workers (recurring
 * tasks and invoices, cycles, intake mail and form) and resumes on restore.
 * Two things cannot wait like that: a running timer is turned into its time
 * entry now (it would be lost otherwise), and agent runs are cancelled.
 */
export async function softDeleteProject(actor: Actor, id: string) {
  await assertProject(actor, id, 'admin');
  const { db } = getDb();
  await closeProjectTimers(actor, id);
  await cancelProjectRuns(id);
  await db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, id));
  await writeActivity(db, { entityType: 'project', entityId: id, action: 'deleted', actorId: actor.userId, actorType: actor.actorType });
}

/**
 * Who may see and restore a deleted project: projects.delete, plus admin rights
 * on that project as it stood before the delete – the same rank that would let
 * them delete it. On a workspace project projects.write grants that (not for an
 * agent, which is admin only where its membership says so); a private project
 * stays as closed in the trash as it was alive, open only to its admin
 * members (effectiveProjectRolesIncludingDeleted reads those rows, which the
 * access context skips for a deleted project).
 */
async function deletedProjectsFor(actor: Actor, id?: string) {
  const { db } = getDb();
  if (!actor.access.permissions.has('projects.delete')) return [];
  const rows = await db.select({
    id: projects.id, name: projects.name, key: projects.key, visibility: projects.visibility, deletedAt: projects.deletedAt,
  }).from(projects).where(and(isNotNull(projects.deletedAt), id ? eq(projects.id, id) : undefined))
    .orderBy(desc(projects.deletedAt));
  const roles = await effectiveProjectRolesIncludingDeleted(actor, rows.map((r) => ({ id: r.id, visibility: r.visibility as 'workspace' | 'private' })));
  return rows.filter((r) => roles.get(r.id) === 'admin');
}

export async function listDeletedProjects(actor: Actor) {
  return (await deletedProjectsFor(actor)).map(({ visibility: _v, ...r }) => r);
}

export async function restoreProject(actor: Actor, id: string) {
  const [project] = await deletedProjectsFor(actor, id);
  if (!project) throw err.notFound('Project not found');
  const { db } = getDb();
  // The key went back to the pool on delete; someone may have taken it since.
  const [taken] = await db.select({ id: projects.id, name: projects.name, visibility: projects.visibility }).from(projects)
    .where(and(eq(projects.key, project.key), isNull(projects.deletedAt)));
  if (taken) {
    // Name the project only to someone it is open to: a private one stays unnamed.
    const open = effectiveProjectRole(actor, { id: taken.id, visibility: taken.visibility as 'workspace' | 'private' }) !== null;
    throw err.domain(open
      ? `The key ${project.key} now belongs to project "${taken.name}" – rename that project's key or delete it first.`
      : `The key ${project.key} now belongs to another project – ask its admin to rename its key or delete it first.`);
  }
  await db.update(projects).set({ deletedAt: null }).where(eq(projects.id, id));
  await writeActivity(db, { entityType: 'project', entityId: id, action: 'restored', actorId: actor.userId, actorType: actor.actorType });
  const [restored] = await db.select().from(projects).where(eq(projects.id, id));
  return restored;
}

// ── Members ──
export async function listMembers(actor: Actor, projectId: string) {
  await assertProject(actor, projectId, 'viewer');
  const { db } = getDb();
  return db.select().from(projectMembers).where(eq(projectMembers.projectId, projectId));
}

export async function upsertMember(actor: Actor, projectId: string, input: any) {
  await assertProject(actor, projectId, 'admin');
  await assertNotPersonalAgent(input.userId, 'added to a project');
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
  // A question waiting on them here would wait on someone who cannot see it
  // – unless the project is open to them anyway (a workspace project).
  if (!(await userCanOpenProject(userId, projectId))) {
    await db.transaction((tx) => withdrawQuestionsWaitingOn(tx, actor, userId, 'removed', projectId));
  }
}

// ── Task statuses (PRD §8.2) ──
export async function listTaskStatuses(actor: Actor, projectId: string) {
  await assertProject(actor, projectId, 'viewer');
  const { db } = getDb();
  return db.select().from(taskStatuses).where(eq(taskStatuses.projectId, projectId)).orderBy(asc(taskStatuses.position));
}

/** Board positions are spaced so a single status can later slot in between. */
const STATUS_POSITION_STEP = 1000;

/** A status name is how people and agents tell statuses apart, so it is unique per project. */
async function assertStatusNameFree(projectId: string, name: string, exceptId?: string): Promise<void> {
  const { db } = getDb();
  const rows = await db.select({ id: taskStatuses.id, name: taskStatuses.name })
    .from(taskStatuses).where(eq(taskStatuses.projectId, projectId));
  const wanted = name.trim().toLowerCase();
  if (rows.some((r) => r.id !== exceptId && r.name.trim().toLowerCase() === wanted)) {
    throw err.validation(`This project already has a status called "${name.trim()}"`);
  }
}

async function loadStatus(statusId: string) {
  const { db } = getDb();
  const [status] = await db.select().from(taskStatuses).where(eq(taskStatuses.id, statusId));
  if (!status) throw err.notFound('Status not found');
  return status;
}

export async function createTaskStatus(actor: Actor, projectId: string, input: any) {
  await assertProject(actor, projectId, 'admin');
  await assertStatusNameFree(projectId, input.name);
  const { db } = getDb();
  const id = ulid();
  let position: number = input.position;
  if (position === undefined) {
    const [row] = await db.select({ max: sql<number | null>`max(${taskStatuses.position})` })
      .from(taskStatuses).where(eq(taskStatuses.projectId, projectId));
    position = (Number(row?.max ?? 0) || 0) + STATUS_POSITION_STEP;
  }
  await db.transaction(async (tx) => {
    if (input.isDefault) {
      await tx.update(taskStatuses).set({ isDefault: false }).where(eq(taskStatuses.projectId, projectId));
    }
    await tx.insert(taskStatuses).values({
      id, projectId, name: input.name.trim(), category: input.category, color: input.color,
      position, isDefault: input.isDefault ?? false,
    });
  });
  return loadStatus(id);
}

export async function updateTaskStatus(actor: Actor, statusId: string, input: any) {
  const status = await loadStatus(statusId);
  await assertProject(actor, status.projectId, 'admin');
  // The default is moved, never removed: new tasks always need somewhere to land.
  if (input.isDefault === false && status.isDefault) {
    throw err.validation('This is the default status for new tasks – make another status the default instead');
  }
  if (input.name !== undefined) await assertStatusNameFree(status.projectId, input.name, statusId);
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'category', 'color', 'position', 'isDefault']) if (input[k] !== undefined) patch[k] = input[k];
  if (typeof patch.name === 'string') patch.name = patch.name.trim();
  const { db } = getDb();
  if (Object.keys(patch).length) {
    await db.transaction(async (tx) => {
      if (input.isDefault === true) {
        await tx.update(taskStatuses).set({ isDefault: false }).where(eq(taskStatuses.projectId, status.projectId));
      }
      await tx.update(taskStatuses).set(patch).where(eq(taskStatuses.id, statusId));
    });
  }
  return loadStatus(statusId);
}

/** Put the project's statuses in the given board order. The list must name every status once. */
export async function reorderTaskStatuses(actor: Actor, projectId: string, ids: string[]) {
  await assertProject(actor, projectId, 'admin');
  const { db } = getDb();
  const existing = await db.select({ id: taskStatuses.id }).from(taskStatuses).where(eq(taskStatuses.projectId, projectId));
  const known = new Set(existing.map((r) => r.id));
  if (new Set(ids).size !== ids.length || ids.length !== known.size || ids.some((id) => !known.has(id))) {
    throw err.validation('ids must list every status of this project exactly once');
  }
  await db.transaction(async (tx) => {
    for (const [i, id] of ids.entries()) {
      await tx.update(taskStatuses).set({ position: (i + 1) * STATUS_POSITION_STEP }).where(eq(taskStatuses.id, id));
    }
  });
  return listTaskStatuses(actor, projectId);
}

export async function deleteTaskStatus(actor: Actor, statusId: string, migrateTo: string | undefined) {
  const status = await loadStatus(statusId);
  await assertProject(actor, status.projectId, 'admin');
  if (!migrateTo) throw err.validation('migrateTo status id required to delete a status');
  if (migrateTo === statusId) throw err.validation('migrateTo must be another status – tasks cannot move to the status being deleted');
  const { db } = getDb();
  const [target] = await db.select().from(taskStatuses).where(and(eq(taskStatuses.id, migrateTo), eq(taskStatuses.projectId, status.projectId)));
  if (!target) throw err.validation('migrateTo must be a status in the same project');
  const moved = await db.transaction(async (tx) => {
    const rows = await tx.update(tasks).set({ statusId: migrateTo }).where(eq(tasks.statusId, statusId)).returning({ id: tasks.id });
    // Deleting the default hands the role to the status its tasks moved to.
    if (status.isDefault) await tx.update(taskStatuses).set({ isDefault: true }).where(eq(taskStatuses.id, migrateTo));
    await tx.delete(taskStatuses).where(eq(taskStatuses.id, statusId));
    return rows.length;
  });
  return { ok: true, movedTasks: moved };
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

/**
 * A task's status is one of its own project's statuses: the board, progress
 * and that project's status deletion all read it that way. Exported for the
 * git automation rules, which set a status on their own later.
 */
export async function assertStatusInProject(statusId: string, projectId: string, field = 'statusId'): Promise<void> {
  const { db } = getDb();
  const [status] = await db.select({ id: taskStatuses.id }).from(taskStatuses)
    .where(and(eq(taskStatuses.id, statusId), eq(taskStatuses.projectId, projectId)));
  if (!status) throw err.validation(`${field} must be a status of the same project`);
}

/**
 * A milestone belongs to one project, so a task can only carry one of its own
 * project's milestones — otherwise the overview would count work it does not
 * own, and moving a task between projects would drag a stale grouping with it.
 */
async function assertMilestoneInProject(milestoneId: string, projectId: string): Promise<void> {
  const { db } = getDb();
  const [ms] = await db.select({ id: schema.milestones.id }).from(schema.milestones)
    .where(and(eq(schema.milestones.id, milestoneId), eq(schema.milestones.projectId, projectId)));
  if (!ms) throw err.validation('milestoneId must be a milestone of the same project');
}

/**
 * A parent is a live task of the same project that sits above the task, not
 * inside its own subtree: a parent from elsewhere puts a subtask on a board
 * that does not show it, and a parent below the task closes a loop that hides
 * the whole branch from every tree view. The task's own subtree moves with it,
 * so its height counts towards MAX_SUBTASK_DEPTH as much as the parent's
 * ancestors do. `taskId` is absent on create, where there is no subtree yet.
 */
async function assertParent(parentId: string, projectId: string, taskId?: string) {
  if (parentId === taskId) throw err.validation('A task cannot be its own parent');
  const { db } = getDb();
  const [parent] = await db.select({ projectId: tasks.projectId, parentId: tasks.parentId }).from(tasks)
    .where(and(eq(tasks.id, parentId), isNull(tasks.deletedAt)));
  if (!parent || parent.projectId !== projectId) throw err.validation('parentId must be a task of the same project');

  let ancestors = 1;
  let current = parent.parentId;
  const seen = new Set([parentId]);
  while (current && !seen.has(current)) {
    if (current === taskId) throw err.validation('parentId cannot be a subtask of the task itself');
    seen.add(current);
    ancestors++;
    const [row] = await db.select({ parentId: tasks.parentId }).from(tasks).where(eq(tasks.id, current));
    current = row?.parentId ?? null;
  }

  let height = 1;
  let frontier = taskId ? [taskId] : [];
  while (frontier.length && ancestors + height <= MAX_SUBTASK_DEPTH) {
    const children = await db.select({ id: tasks.id }).from(tasks)
      .where(and(inArray(tasks.parentId, frontier), isNull(tasks.deletedAt)));
    frontier = children.map((c) => c.id);
    if (frontier.length) height++;
  }
  if (ancestors + height > MAX_SUBTASK_DEPTH) throw err.domain(`Max subtask depth (${MAX_SUBTASK_DEPTH}) exceeded`);
}

/** A cycle plans one project's work, so a task can only join a cycle of its own project. */
async function assertCycleInProject(cycleId: string, projectId: string): Promise<void> {
  const { db } = getDb();
  const [cycle] = await db.select({ id: cycles.id }).from(cycles)
    .where(and(eq(cycles.id, cycleId), eq(cycles.projectId, projectId)));
  if (!cycle) throw err.validation('cycleId must be a cycle of the same project');
}

/** Cursor-paged on `id desc`; see `idPage` in lib/http for why the key is the id. */
export async function listTasks(actor: Actor, params: {
  projectId?: string; status?: string; priority?: string; assignee?: string; cycleId?: string;
  type?: string; parentId?: string; milestoneId?: string; labels?: string[]; q?: string; dueFrom?: string; dueTo?: string;
  /** Only tasks with an open question waiting on this user ("me" is the caller). */
  waitingOn?: string;
  cfFilters?: CustomFieldFilter[]; cursor?: { id?: string } | null; limit: number;
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

  // Every project the caller can open: the blockers they may know of.
  const reachable = [...new Set([...scope, ...(await accessibleProjectIds(actor))])];

  // Only workspace fields and those of projects in the list are known here: a
  // private project's field key reads as unknown, exactly like a made-up one,
  // instead of answering with its type or an empty match. A list of one
  // project knows that project's own fields, so a key it does not define stays
  // an unknown field there (MCP's findByKey then scans the blob instead).
  const cf: SQL[] = [];
  for (const f of params.cfFilters ?? []) {
    cf.push(await buildCustomFieldFilter('tasks', f, { projectIds: scope, projectColumn: sql`${tasks.projectId}` }));
  }

  // Several labels narrow rather than widen: "linkedin" + "case study" means
  // the tasks carrying both, which is how a plan is read off a board.
  const byLabel = (params.labels ?? []).map((labelId) =>
    inArray(tasks.id, db.select({ id: taskLabels.taskId }).from(taskLabels).where(eq(taskLabels.labelId, labelId))));

  const rows = await db.select().from(tasks).where(and(
    isNull(tasks.deletedAt),
    inArray(tasks.projectId, scope),
    params.status ? eq(tasks.statusId, params.status) : undefined,
    params.priority ? eq(tasks.priority, params.priority) : undefined,
    params.cycleId ? eq(tasks.cycleId, params.cycleId) : undefined,
    params.type ? eq(tasks.typeId, params.type) : undefined,
    // A checklist asks for one parent's children, not for the whole project.
    params.parentId ? eq(tasks.parentId, params.parentId) : undefined,
    params.milestoneId ? eq(tasks.milestoneId, params.milestoneId) : undefined,
    params.q ? sql`${tasks.title} ilike ${'%' + params.q + '%'}` : undefined,
    // due_date is a YYYY-MM-DD text column, so the window compares lexically;
    // tasks with no date fall outside it, as a calendar query means them to.
    params.dueFrom ? sql`${tasks.dueDate} >= ${params.dueFrom}` : undefined,
    params.dueTo ? sql`${tasks.dueDate} <= ${params.dueTo}` : undefined,
    params.assignee ? inArray(tasks.id, db.select({ id: taskAssignees.taskId }).from(taskAssignees).where(eq(taskAssignees.userId, params.assignee))) : undefined,
    params.waitingOn ? inArray(tasks.id, tasksWaitingOn(params.waitingOn === 'me' ? actor.ownerUserId ?? actor.userId : params.waitingOn)) : undefined,
    // Inclusive: `pageById` mints the cursor from the first row of the next page.
    params.cursor?.id ? lte(tasks.id, params.cursor.id) : undefined,
    ...byLabel,
    ...cf,
  )).orderBy(desc(tasks.id)).limit(params.limit + 1);

  const paged = pageById(rows, params.limit);
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

  // A "blocks" relation is only a fact on the task page unless the lists carry
  // it: blocked = some open task blocks this one. Only blockers the caller can
  // open count. The task page leaves out relations to a project the caller
  // cannot open, so a flag raised by one would point at nothing they can see –
  // and, flipping as it closes, would report a private task's progress.
  const blockedIds = new Set<string>();
  if (ids.length) {
    const inList = sql.raw('(' + ids.map((i) => `'${i.replace(/'/g, "''")}'`).join(',') + ')');
    const blockerProjects = sql.join(reachable.map((id) => sql`${id}`), sql`, `);
    const blockedRows = await db.execute(sql`
      select distinct tr.related_task_id as id
      from task_relations tr
      join tasks b on b.id = tr.task_id and b.deleted_at is null
      join task_statuses bs on bs.id = b.status_id
      where tr.type = 'blocks' and tr.related_task_id in ${inList}
        and b.project_id in (${blockerProjects})
        and bs.category not in ('done', 'canceled')`) as unknown as { id: string }[];
    for (const row of blockedRows) blockedIds.add(row.id);
  }

  // Who each task waits on, if anyone: a small mark on the list and board.
  const waitingOn = await waitingOnFor(ids);

  const data = paged.data.map((t) => ({
    ...t,
    ref: refOf(keyMap.get(t.projectId) ?? '', t.number),
    assigneeIds: assignRows.filter((a) => a.taskId === t.id).map((a) => a.userId),
    labelIds: labelRows.filter((l) => l.taskId === t.id).map((l) => l.labelId),
    blocked: blockedIds.has(t.id),
    waitingOnUserId: waitingOn.get(t.id) ?? null,
  }));
  return { data, nextCursor: paged.nextCursor };
}

/**
 * A reporter is someone the task can be taken back to: an active user who can
 * open the project (userCanOpenProject). The reporter hears the task's news,
 * so someone the project is closed to must not be one.
 */
async function assertReporter(project: { id: string }, userId: string): Promise<void> {
  // Someone's own agent files work for its owner; it is never the one who set it.
  await assertNotPersonalAgent(userId, "a task's reporter");
  const { db } = getDb();
  const [user] = await db.select({ isActive: schema.users.isActive }).from(schema.users).where(eq(schema.users.id, userId));
  if (!user || !user.isActive) throw err.validation('The reporter must be an active user');
  if (!(await userCanOpenProject(userId, project.id))) {
    throw err.validation('The reporter must be someone who can open this project – add them to it first');
  }
}

export async function createTask(actor: Actor, input: any) {
  const write = await prepareTask(actor, input);
  // The task, its assignees and labels, its events and the activity record
  // share one transaction: a failure part way leaves no half-created task,
  // and nothing is announced that did not happen.
  const { db } = getDb();
  const { id, ref } = await db.transaction((tx) => write(tx));
  const task = await loadTask(id);
  return { ...task, ref };
}

/**
 * Run every check a new task needs, before anything is written, and return
 * the writer that creates it inside the caller's transaction – so a task can
 * be created together with other writes (accepting an intake item).
 */
async function prepareTask(actor: Actor, input: any): Promise<(tx: any) => Promise<{ id: string; ref: string }>> {
  const project = await assertProject(actor, input.projectId, 'member');
  if (input.parentId) await assertParent(input.parentId, input.projectId);
  if (input.cycleId) await assertCycleInProject(input.cycleId, input.projectId);
  const assigneeIds: string[] = input.assigneeIds ?? [];
  if (assigneeIds.length) await assertCanAssignAgents(actor, project.id, assigneeIds, effectiveProjectRole(actor, project));
  // A person's own agent files work for its owner: the owner set it.
  const reporterId: string | null = input.reporterId === undefined ? (actor.ownerUserId ?? actor.userId) : input.reporterId;
  // A personal agent naming itself is checked too: it may not be the reporter.
  // Its owner needs no check: the agent reached this project through the
  // owner's access, read fresh, while assertReporter's view may be cached.
  const ownerOfAgent = actor.agentKind === 'personal' && reporterId === actor.ownerUserId;
  if (reporterId && !ownerOfAgent && (reporterId !== actor.userId || actor.agentKind === 'personal')) await assertReporter(project, reporterId);
  const labelIds: string[] = input.labelIds ?? [];
  await assertLabelScope(labelIds, 'task');
  if (input.statusId) await assertStatusInProject(input.statusId, input.projectId);
  const statusId = input.statusId ?? (await defaultStatusId(input.projectId));
  if (input.milestoneId) await assertMilestoneInProject(input.milestoneId, input.projectId);
  const key = await projectKey(input.projectId);

  return async (tx) => {
    const id = ulid();
    const position = await nextTaskPosition(input.projectId, tx);
    const [row] = await tx.insert(tasks).values({
      id, projectId: input.projectId, number: 0, title: input.title,
      description: input.description ?? null, statusId, typeId: input.typeId ?? null,
      priority: input.priority ?? 'none', parentId: input.parentId ?? null,
      milestoneId: input.milestoneId ?? null,
      dueDate: input.dueDate ?? null, startDate: input.startDate ?? null,
      estimate: input.estimate != null ? String(input.estimate) : null,
      cycleId: input.cycleId ?? null, position, customFields: input.customFields ?? {},
      createdBy: actor.userId, reporterId,
    }).returning({ number: tasks.number });
    if (assigneeIds.length) await tx.insert(taskAssignees).values(assigneeIds.map((userId) => ({ taskId: id, userId })));
    if (labelIds.length) await tx.insert(taskLabels).values(labelIds.map((labelId) => ({ taskId: id, labelId })));

    const ref = refOf(key, row!.number);
    await publishEvent(tx, { type: 'task.created', aggregateType: 'task', aggregateId: id, payload: { ref, taskId: id, projectId: input.projectId }, actorId: actor.userId, actorType: actor.actorType });
    if (assigneeIds.length) {
      await publishEvent(tx, { type: 'task.assigned', aggregateType: 'task', aggregateId: id, payload: { assigneeIds, ref, taskId: id, projectId: input.projectId }, actorId: actor.userId, actorType: actor.actorType });
    }
    await writeActivity(tx, { entityType: 'task', entityId: id, action: 'created', after: input, actorId: actor.userId, actorType: actor.actorType });
    return { id, ref };
  };
}

export async function getTask(actor: Actor, id: string, include: string[]) {
  const { db } = getDb();
  const task = await loadTask(id);
  await assertProject(actor, task.projectId, 'viewer');
  const ref = await taskRef(task);
  // The open question is part of the card, like its status: it is what the
  // task waits on.
  const out: Record<string, unknown> = { ...task, ref, openQuestion: await openQuestionView(actor, task) };
  const want = new Set(include);

  if (want.has('assignees')) {
    out.assignees = await db.select({ userId: taskAssignees.userId, name: schema.users.name, email: schema.users.email, avatar: schema.users.avatar })
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
    // A relation is shown only when its other end is a task the actor can
    // open: one into a private project they are not on would hand out that
    // task's ref (and with it the project's key) – the relation is left out,
    // as the task itself would be from any list.
    const refMap = await refsFor(otherIds, new Set(await accessibleProjectIds(actor)));
    out.relations = {
      outgoing: outgoing.filter((r) => refMap.has(r.relatedTaskId))
        .map((r) => ({ ...r, relatedRef: refMap.get(r.relatedTaskId)! })),
      incoming: incoming.filter((r) => refMap.has(r.taskId))
        .map((r) => ({ ...r, relatedRef: refMap.get(r.taskId)! })),
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

/** Refs of the given tasks that sit in one of `projectIds` (tasks elsewhere are left out). */
async function refsFor(taskIds: string[], projectIds: ReadonlySet<string>): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!taskIds.length) return map;
  const { db } = getDb();
  const rows = await db.select({ id: tasks.id, number: tasks.number, key: projects.key, projectId: tasks.projectId })
    .from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId)).where(inArray(tasks.id, taskIds));
  for (const r of rows) if (projectIds.has(r.projectId)) map.set(r.id, refOf(r.key, r.number));
  return map;
}

export async function updateTask(actor: Actor, id: string, input: any) {
  const { db } = getDb();
  const before = await loadTask(id);
  const project = await assertProject(actor, before.projectId, 'member');
  assertVersion(before, input.version, before);

  const patch: Record<string, unknown> = {};
  for (const k of ['title', 'description', 'statusId', 'typeId', 'priority', 'parentId', 'milestoneId', 'dueDate', 'startDate', 'cycleId', 'reporterId']) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  if (input.statusId) await assertStatusInProject(input.statusId, before.projectId);
  if (input.reporterId) await assertReporter(project, input.reporterId);
  if (input.milestoneId) await assertMilestoneInProject(input.milestoneId, before.projectId);
  if (input.customFields !== undefined) patch.customFields = mergeCustomFields(before.customFields, input.customFields);
  if (input.estimate !== undefined) patch.estimate = input.estimate != null ? String(input.estimate) : null;
  if (input.parentId) await assertParent(input.parentId, before.projectId, id);
  if (input.cycleId) await assertCycleInProject(input.cycleId, before.projectId);

  // Every check runs before the first write, and the writes, their events and
  // the activity record share one transaction: a refused or failed request
  // changes nothing, and nothing is announced that did not happen.
  const nextAssignees: string[] | undefined = input.assigneeIds;
  const role = effectiveProjectRole(actor, project);
  const checked = new Set<string>();
  const assertAssignable = async (added: string[]) => {
    const unchecked = added.filter((a) => !checked.has(a));
    // Agents among the new assignees: membership and assign policy (R48, R49).
    if (unchecked.length) await assertCanAssignAgents(actor, project.id, unchecked, role);
    for (const a of unchecked) checked.add(a);
  };
  if (nextAssignees) {
    const current = await assigneeIdsOf(id);
    await assertAssignable(nextAssignees.filter((a) => !current.includes(a)));
  }
  const nextLabels: string[] | undefined = input.labelIds;
  if (nextLabels) await assertLabelScope(nextLabels, 'task');
  const ref = await taskRef(before);

  await db.transaction(async (tx) => {
    // The row lock serializes edits of this task (an assignee-only edit too).
    // The patch was built from `before` (custom fields merge into it), so a
    // change in between is a conflict, answered with the task as it is now.
    const [locked] = await tx.select({ version: tasks.version }).from(tasks)
      .where(and(eq(tasks.id, id), isNull(tasks.deletedAt))).for('update');
    if (!locked) throw err.notFound('Task not found');
    if (Object.keys(patch).length && locked.version !== before.version) throw err.conflict('The record was modified by someone else', await loadTask(id).catch(() => before));
    const oldAssignees = (await tx.select({ userId: taskAssignees.userId }).from(taskAssignees)
      .where(eq(taskAssignees.taskId, id))).map((r) => r.userId);
    const newAssignees = nextAssignees ? nextAssignees.filter((a) => !oldAssignees.includes(a)) : [];
    // Someone may have taken an assignee off since the check above.
    await assertAssignable(newAssignees);
    const finalAssignees = nextAssignees ?? oldAssignees;
    if (Object.keys(patch).length) await tx.update(tasks).set(patch).where(eq(tasks.id, id));
    if (nextAssignees) {
      await tx.delete(taskAssignees).where(eq(taskAssignees.taskId, id));
      if (nextAssignees.length) await tx.insert(taskAssignees).values(nextAssignees.map((userId) => ({ taskId: id, userId })));
    }
    if (nextLabels) {
      await tx.delete(taskLabels).where(eq(taskLabels.taskId, id));
      if (nextLabels.length) await tx.insert(taskLabels).values(nextLabels.map((labelId) => ({ taskId: id, labelId })));
    }
    if (input.statusId !== undefined && input.statusId !== before.statusId) {
      await publishEvent(tx, { type: 'task.status_changed', aggregateType: 'task', aggregateId: id, payload: { ref, taskId: id, assigneeIds: finalAssignees, createdBy: before.createdBy, reporterId: patch.reporterId !== undefined ? patch.reporterId : before.reporterId, projectId: before.projectId }, actorId: actor.userId, actorType: actor.actorType });
    }
    if (newAssignees.length) {
      await publishEvent(tx, { type: 'task.assigned', aggregateType: 'task', aggregateId: id, payload: { assigneeIds: newAssignees, ref, taskId: id, projectId: before.projectId }, actorId: actor.userId, actorType: actor.actorType });
    }
    await writeActivity(tx, { entityType: 'task', entityId: id, action: 'updated', before, after: patch, actorId: actor.userId, actorType: actor.actorType });
    await publishEvent(tx, { type: 'task.updated', aggregateType: 'task', aggregateId: id, payload: { taskId: id, projectId: before.projectId }, actorId: actor.userId, actorType: actor.actorType });
  });
  const task = await loadTask(id);
  return { ...task, ref };
}

// ── Hand-off when someone leaves (ORD-20) ──

/** Statuses that still mean work to do; done/canceled tasks stay with whoever closed them. */
const OPEN_CATEGORIES = ['backlog', 'todo', 'in_progress'];

export interface OpenTaskRef { id: string; projectId: string; title: string; ref: string }

/**
 * Open tasks a user is assigned to, across every project. Not membership
 * gated: the caller is an admin deactivating that user (users.manage), who
 * has to see the whole picture even for projects they are not a member of.
 * `conn` is a transaction when the answer must be read under its locks
 * (handOffOpenTasks).
 */
export async function openTasksAssignedTo(userId: string, conn: any = getDb().db): Promise<OpenTaskRef[]> {
  const rows: { id: string; projectId: string; number: number; title: string; key: string }[] = await conn.select({
    id: tasks.id, projectId: tasks.projectId, number: tasks.number, title: tasks.title, key: projects.key,
  })
    .from(tasks)
    .innerJoin(taskAssignees, eq(taskAssignees.taskId, tasks.id))
    .innerJoin(taskStatuses, eq(taskStatuses.id, tasks.statusId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(
      eq(taskAssignees.userId, userId),
      isNull(tasks.deletedAt),
      // A deleted project's tasks are nobody's work: handing them on would
      // notify the successor (or queue an agent) about invisible tasks.
      isNull(projects.deletedAt),
      inArray(taskStatuses.category, OPEN_CATEGORIES),
    ))
    .orderBy(desc(tasks.id));
  return rows.map((r) => ({ id: r.id, projectId: r.projectId, title: r.title, ref: refOf(r.key, r.number) }));
}

/**
 * What the deactivate dialog shows the admin about a person's open tasks
 * (ORD-39). users.manage is not a key to private projects: a task in one the
 * actor cannot open is only counted – no id, ref, title or project – the way
 * any other list leaves it out. The hand-over itself still moves every open
 * task (handOffOpenTasks), so `count` is the full number that will move.
 */
export async function openTasksPreview(actor: Actor, userId: string) {
  const all = await openTasksAssignedTo(userId);
  const canOpen = new Set(await accessibleProjectIds(actor));
  const visible = all.filter((t) => canOpen.has(t.projectId));
  return { count: all.length, hiddenCount: all.length - visible.length, visible };
}

/**
 * Take a leaving person off their open work. Every open task assigned to
 * them loses that assignee and, when a successor is named, gains the
 * successor (a task the successor already had stays as it is). Closed tasks
 * keep their history. Each task gets a `reassigned` activity row, so the
 * hand-off reads on the task itself, not only in the user's audit trail.
 */
/**
 * Runs inside the caller's transaction (deactivation hands tasks, agents and
 * the account over as one step), events included – they go to the outbox in
 * the same transaction, so nothing is announced that did not commit.
 */
export async function handOffOpenTasks(actor: Actor, fromUserId: string, toUserId: string | null, tx: any) {
  // Read under the caller's lock on the person (ORD-41). A task move locks
  // the people on its tasks before the tasks (moveTask), so one that got
  // there first has committed – its copy is what this read finds – and one
  // that comes later waits for this hand-over and finds the person switched off.
  const open = await openTasksAssignedTo(fromUserId, tx);
  if (!open.length) return { count: 0, taskIds: [] as string[] };
  const ids = open.map((t) => t.id);
  // Handing work to an agent is assigning it: the agent must be a member of
  // each project, and the person handing over must meet its assign policy
  // there with the role they hold in that project – the same rule as
  // assigning it by hand. Checked before anything is written, so a refusal
  // leaves the person active and every task as it was.
  if (toUserId) {
    const projectIds = [...new Set(open.map((t) => t.projectId))];
    const rows = await tx.select({ id: projects.id, name: projects.name, visibility: projects.visibility })
      .from(projects).where(inArray(projects.id, projectIds)).orderBy(asc(projects.name));
    for (const project of rows) {
      const role = effectiveProjectRole(actor, { id: project.id, visibility: project.visibility as 'workspace' | 'private' });
      const [refusal] = await agentAssignRefusals(actor, project.id, [toUserId], role);
      if (refusal) {
        // A project the actor cannot open (a private one, say) is not named to them.
        const where = role ? project.name : 'a project you cannot open';
        throw new ApiException(
          refusal.error.code,
          `Open tasks in ${where} cannot be handed to this agent: ${refusal.error.message}`,
          refusal.error.details,
        );
      }
    }
  }
  // Tasks first, in id order – the order a task edit locks in – so a hand-off
  // and a concurrent edit of the same task wait for each other, not deadlock.
  await tx.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, ids)).orderBy(asc(tasks.id)).for('update');
  await tx.delete(taskAssignees).where(and(inArray(taskAssignees.taskId, ids), eq(taskAssignees.userId, fromUserId)));
  if (toUserId) {
    await tx.insert(taskAssignees).values(ids.map((taskId) => ({ taskId, userId: toUserId }))).onConflictDoNothing();
  }
  await tx.update(tasks).set({ updatedAt: new Date() }).where(inArray(tasks.id, ids));
  for (const t of open) {
    await writeActivity(tx, {
      entityType: 'task', entityId: t.id, action: 'reassigned',
      before: { assigneeId: fromUserId }, after: { assigneeId: toUserId },
      actorId: actor.userId, actorType: actor.actorType,
    });
    // The successor learns about their new work the same way any assignee does.
    if (toUserId) {
      await publishEvent(tx, { type: 'task.assigned', aggregateType: 'task', aggregateId: t.id, payload: { assigneeIds: [toUserId], ref: t.ref, taskId: t.id, projectId: t.projectId }, actorId: actor.userId, actorType: actor.actorType });
    }
  }
  return { count: ids.length, taskIds: ids };
}

export async function softDeleteTask(actor: Actor, id: string) {
  const { db } = getDb();
  const task = await loadTask(id);
  await assertProject(actor, task.projectId, 'member');
  await db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, id));
  await writeActivity(db, { entityType: 'task', entityId: id, action: 'deleted', actorId: actor.userId, actorType: actor.actorType });
}

/**
 * Where a task's status lands in another project (ORD-23): the status with
 * the same name if the target has one, else the first status of the same
 * category, else the target's default. Each project owns its statuses, so
 * "Review" in one is a different row from "Review" in another – but to the
 * person moving the task it is the same column.
 */
async function matchStatusInProject(sourceStatusId: string, targetProjectId: string): Promise<string> {
  const { db } = getDb();
  const [from] = await db.select({ name: taskStatuses.name, category: taskStatuses.category })
    .from(taskStatuses).where(eq(taskStatuses.id, sourceStatusId));
  const candidates = await db.select({
    id: taskStatuses.id, name: taskStatuses.name, category: taskStatuses.category, isDefault: taskStatuses.isDefault,
  }).from(taskStatuses).where(eq(taskStatuses.projectId, targetProjectId)).orderBy(asc(taskStatuses.position));
  if (!candidates.length) throw err.domain('Project has no task statuses');
  const wanted = from?.name.trim().toLowerCase();
  const byName = wanted ? candidates.find((s) => s.name.trim().toLowerCase() === wanted) : undefined;
  const byCategory = from ? candidates.find((s) => s.category === from.category) : undefined;
  return (byName ?? byCategory ?? candidates.find((s) => s.isDefault) ?? candidates[0]!).id;
}

/**
 * Custom-field keys a task may carry in a project: workspace-wide fields plus
 * the ones defined for that project. A key defined only for the source
 * project has no editor, filter or column in the target – it is dropped on
 * the move rather than left as an invisible blob.
 */
async function customFieldKeysFor(projectId: string): Promise<Set<string>> {
  const { db } = getDb();
  const rows = await db.select({ key: schema.customFieldDefinitions.key })
    .from(schema.customFieldDefinitions)
    .where(and(
      eq(schema.customFieldDefinitions.entityType, 'tasks'),
      or(isNull(schema.customFieldDefinitions.projectId), eq(schema.customFieldDefinitions.projectId, projectId)),
    ));
  return new Set(rows.map((r) => r.key));
}

/**
 * Moving a task moves the work, not a copy of its title. The whole subtree goes
 * (children keep their parent, re-pointed to the new ids), and everything that
 * hangs off each task follows: comments, relations, external and git links,
 * attachments, logged time and a running timer. Before this, comments stayed on
 * the soft-deleted original and subtasks were orphaned under a parent nothing
 * could open any more.
 *
 * Project-scoped fields travel as far as they can (ORD-23): each task keeps
 * the status of the same name (or category, or the target's default), custom
 * fields keep the keys the target knows, labels are workspace-wide and stay.
 * Type, cycle and milestone clear – each belongs to the source project.
 * Moving needs admin rights on both projects: it renumbers the task and
 * rewrites what the source project's board shows.
 */
export async function moveTask(actor: Actor, id: string, targetProjectId: string) {
  const { db } = getDb();
  const source = await loadTask(id);
  await assertProject(actor, source.projectId, 'admin');
  const targetProject = await assertProject(actor, targetProjectId, 'admin');
  if (source.projectId === targetProjectId) return { ...source, ref: await taskRef(source) };
  const keepKeys = await customFieldKeysFor(targetProjectId);
  const statusFor = new Map<string, string>();
  const targetStatusOf = async (statusId: string): Promise<string> => {
    let mapped = statusFor.get(statusId);
    if (!mapped) { mapped = await matchStatusInProject(statusId, targetProjectId); statusFor.set(statusId, mapped); }
    return mapped;
  };

  const targetKey = await projectKey(targetProjectId);
  const { newId, ref } = await db.transaction(async (tx) => {
    // Collect the subtree breadth-first, so a parent is always inserted first.
    const subtree = [source];
    // A reporter the target project is closed to would keep hearing about the
    // task there; the moved copy has none instead.
    const reporterOk = new Map<string, boolean>();
    const reporterFor = async (reporterId: string | null): Promise<string | null> => {
      if (!reporterId) return null;
      if (!reporterOk.has(reporterId)) reporterOk.set(reporterId, await userCanOpenProject(reporterId, targetProjectId));
      return reporterOk.get(reporterId) ? reporterId : null;
    };
    let frontier = [source.id];
    while (frontier.length) {
      const children = await tx.select().from(tasks)
        .where(and(inArray(tasks.parentId, frontier), isNull(tasks.deletedAt)));
      subtree.push(...children);
      frontier = children.map((child) => child.id);
    }
    // The people on these tasks first, then the tasks – person before task,
    // the order a deactivation locks in (ORD-41). A key-share lock is what
    // the copy's assignee rows take anyway; held from here, it makes a
    // deactivation of one of them wait for this move (and then hand over the
    // copy), or this move wait for the deactivation (and then leave them off).
    // Agents are left out: a deactivation locks the agents it switches off
    // after the tasks, so holding one here could close a cycle.
    const lockPeople = async (taskIds: string[]) => {
      const people = await tx.selectDistinct({ id: schema.users.id }).from(taskAssignees)
        .innerJoin(schema.users, eq(schema.users.id, taskAssignees.userId))
        .where(and(inArray(taskAssignees.taskId, taskIds), eq(schema.users.actorType, 'user')));
      if (people.length) {
        await tx.select({ id: schema.users.id }).from(schema.users)
          .where(inArray(schema.users.id, people.map((p) => p.id))).orderBy(asc(schema.users.id)).for('key share');
      }
    };
    await lockPeople(subtree.map((t) => t.id));
    // Lock the subtree in id order – the order a task edit and a bulk edit
    // lock in – so a second move of the same task waits and then finds it
    // gone, instead of copying it into a second project too.
    // The copies are made from the rows as locked, so an edit that committed
    // just before is carried over rather than lost.
    const live = new Map((await tx.select().from(tasks)
      .where(and(inArray(tasks.id, subtree.map((t) => t.id)), isNull(tasks.deletedAt)))
      .orderBy(asc(tasks.id)).for('update')).map((r) => [r.id, r]));
    if (!live.has(source.id)) throw err.notFound('Task not found');
    // A subtask moved elsewhere in between went with its own subtasks.
    const fresh = subtree.filter((t) => live.has(t.id)).map((t) => live.get(t.id)!);
    subtree.splice(0, subtree.length, ...fresh);
    const oldIds = subtree.map((t) => t.id);
    const newIdOf = new Map(oldIds.map((oldId) => [oldId, ulid()]));

    const [posRow] = await tx.select({ maxPos: sql<string | null>`max(${tasks.position})` })
      .from(tasks).where(eq(tasks.projectId, targetProjectId));
    let lastPos = posRow?.maxPos != null ? Number(posRow.maxPos) : null;

    const [assigneeRows, labelRows] = await Promise.all([
      tx.select().from(taskAssignees).where(inArray(taskAssignees.taskId, oldIds)),
      tx.select().from(taskLabels).where(inArray(taskLabels.taskId, oldIds)),
    ]);
    // Someone put on a task between that lock and this one is locked now –
    // out of order, but only for a person who was not on the work a moment
    // ago; at worst Postgres refuses one of two transactions, nothing is lost.
    await lockPeople(oldIds);

    // Agents work only where they are members: one that is not on the
    // target project comes off the moved tasks rather than being stranded.
    // So does one the caller may not assign there (R49): the moved tasks
    // put that agent's work on the target project.
    const strandedAgents = new Set((await agentAssignRefusals(
      actor, targetProjectId, [...new Set(assigneeRows.map((r) => r.userId))], effectiveProjectRole(actor, targetProject),
    )).map((r) => r.userId));
    // Statuses, reporters and the agent check above are looked up before the
    // first insert takes the target project's task-number counter, so the
    // move does not hold it while it waits for those reads.
    for (const t of subtree) { await targetStatusOf(t.statusId); await reporterFor(t.reporterId); }
    // Someone deactivated does not come along onto open work (ORD-41): a
    // deactivation takes them off every open task, and a copy must not put
    // them back – a closed task whose status maps to an open one in the
    // target included. On a closed copy they stay: who did the work is
    // history. Read under the locks above, so a deactivation is either
    // committed and seen here, or waits for this move.
    const assigneeIds = [...new Set(assigneeRows.map((r) => r.userId))];
    const inactive = new Set(assigneeIds.length
      ? (await tx.select({ id: schema.users.id }).from(schema.users)
        .where(and(inArray(schema.users.id, assigneeIds), eq(schema.users.isActive, false)))).map((r) => r.id)
      : []);
    const openStatusIds = new Set(inactive.size
      ? (await tx.select({ id: taskStatuses.id }).from(taskStatuses)
        .where(and(inArray(taskStatuses.id, [...statusFor.values()]), inArray(taskStatuses.category, OPEN_CATEGORIES)))).map((r) => r.id)
      : []);
    const statusOfOld = new Map(subtree.map((t) => [t.id, statusFor.get(t.statusId)!]));
    const leftOff = (row: { taskId: string; userId: string }) =>
      strandedAgents.has(row.userId) || (inactive.has(row.userId) && openStatusIds.has(statusOfOld.get(row.taskId)!));
    // Someone timing one of these tasks whose reach ends at the target stops
    // now, the time saved; the entry then moves with the task below.
    await closeTimersOfOutsiders(tx, actor, subtree.map((t) => t.id), targetProjectId);
    for (const t of subtree) {
      lastPos = appendPosition(lastPos);
      const cf = Object.fromEntries(
        Object.entries((t.customFields ?? {}) as Record<string, unknown>).filter(([key]) => keepKeys.has(key)),
      );
      await tx.insert(tasks).values({
        id: newIdOf.get(t.id)!, projectId: targetProjectId, number: 0, title: t.title,
        description: t.description, statusId: await targetStatusOf(t.statusId), typeId: null, priority: t.priority,
        parentId: t.parentId ? newIdOf.get(t.parentId) ?? null : null,
        milestoneId: null, dueDate: t.dueDate, startDate: t.startDate,
        estimate: t.estimate, cycleId: null, position: String(lastPos),
        customFields: cf, createdBy: t.createdBy, reporterId: await reporterFor(t.reporterId),
      });
    }
    const keptAssignees = assigneeRows.filter((row) => !leftOff(row));
    if (keptAssignees.length) {
      await tx.insert(taskAssignees).values(keptAssignees.map((row) => ({
        taskId: newIdOf.get(row.taskId)!, userId: row.userId,
      })));
    }
    if (labelRows.length) {
      await tx.insert(taskLabels).values(labelRows.map((row) => ({
        taskId: newIdOf.get(row.taskId)!, labelId: row.labelId,
      })));
    }

    // Everything referencing an old task re-points to its counterpart in place,
    // keeping authors, timestamps and invoice links exactly as they were.
    for (const [oldId, mappedId] of newIdOf) {
      await tx.update(schema.comments).set({ taskId: mappedId }).where(eq(schema.comments.taskId, oldId));
      await moveQuestions(tx, actor, oldId, { id: mappedId, projectId: targetProjectId, projectKey: targetKey });
      await tx.update(schema.taskRelations).set({ taskId: mappedId }).where(eq(schema.taskRelations.taskId, oldId));
      await tx.update(schema.taskRelations).set({ relatedTaskId: mappedId }).where(eq(schema.taskRelations.relatedTaskId, oldId));
      await tx.update(schema.taskLinks).set({ taskId: mappedId }).where(eq(schema.taskLinks.taskId, oldId));
      await tx.update(schema.gitLinks).set({ taskId: mappedId }).where(eq(schema.gitLinks.taskId, oldId));
      await tx.update(schema.attachments).set({ entityId: mappedId }).where(and(
        eq(schema.attachments.entityType, 'task'),
        eq(schema.attachments.entityId, oldId),
      ));
      // Hours follow the work; the rates were frozen on each entry when logged.
      await tx.update(schema.timeEntries).set({ taskId: mappedId, projectId: targetProjectId })
        .where(eq(schema.timeEntries.taskId, oldId));
      await tx.update(schema.activeTimers).set({ taskId: mappedId }).where(eq(schema.activeTimers.taskId, oldId));
      await tx.update(tasks).set({ redirectToTaskId: mappedId, deletedAt: new Date() }).where(eq(tasks.id, oldId));
    }
    // The event and the activity record commit with the move, so a move that
    // fails part way is not announced, and one that commits always is.
    const movedId = newIdOf.get(source.id)!;
    const [moved] = await tx.select({ number: tasks.number }).from(tasks).where(eq(tasks.id, movedId));
    const movedRef = refOf(targetKey, moved!.number);
    await publishEvent(tx, { type: 'task.created', aggregateType: 'task', aggregateId: movedId, payload: { ref: movedRef, projectId: targetProjectId, movedFrom: id }, actorId: actor.userId, actorType: actor.actorType });
    // The left-behind task's trail names where it went; core/activity shows that
    // part only to those who can open the destination (redactMoveDestination).
    await writeActivity(tx, { entityType: 'task', entityId: id, action: 'moved', after: { targetProjectId, newTaskId: movedId }, actorId: actor.userId, actorType: actor.actorType });
    return { newId: movedId, ref: movedRef };
  });

  const task = await loadTask(newId);
  return { ...task, ref };
}

export async function duplicateTask(actor: Actor, id: string) {
  const { db } = getDb();
  const source = await loadTask(id);
  const project = await assertProject(actor, source.projectId, 'member');
  // The copy puts the same work on the same agents, so each agent is held to
  // its assign policy as if the caller assigned it (R49). One the caller may
  // not assign – or one no longer on the project – stays off the copy, the way
  // a move leaves off an agent the target project does not have.
  const sourceAssignees = await assigneeIdsOf(id);
  const refused = new Set((await agentAssignRefusals(actor, source.projectId, sourceAssignees, effectiveProjectRole(actor, project))).map((r) => r.userId));
  const assignees = sourceAssignees.filter((userId) => !refused.has(userId));
  const labelIds = (await db.select({ labelId: taskLabels.labelId }).from(taskLabels).where(eq(taskLabels.taskId, id))).map((l) => l.labelId);
  const key = await projectKey(source.projectId);
  const newId = ulid();
  // The copy, its assignees and labels and its event share one transaction:
  // a failure part way leaves no half-made copy.
  const ref = await db.transaction(async (tx) => {
    const position = await nextTaskPosition(source.projectId, tx);
    const [row] = await tx.insert(tasks).values({
      id: newId, projectId: source.projectId, number: 0, title: `${source.title} (copy)`,
      description: source.description, statusId: source.statusId, typeId: source.typeId, priority: source.priority,
      parentId: source.parentId, dueDate: source.dueDate, startDate: source.startDate,
      estimate: source.estimate, cycleId: source.cycleId, position, customFields: source.customFields,
      // A copy answers the same request, so it keeps the reporter – or the lack of one.
      createdBy: actor.userId, reporterId: source.reporterId,
    }).returning({ number: tasks.number });
    if (assignees.length) await tx.insert(taskAssignees).values(assignees.map((userId) => ({ taskId: newId, userId })));
    if (labelIds.length) await tx.insert(taskLabels).values(labelIds.map((labelId) => ({ taskId: newId, labelId })));
    const copyRef = refOf(key, row!.number);
    await publishEvent(tx, { type: 'task.created', aggregateType: 'task', aggregateId: newId, payload: { ref: copyRef, projectId: source.projectId }, actorId: actor.userId, actorType: actor.actorType });
    return copyRef;
  });
  const task = await loadTask(newId);
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

/** A mentioned agent the comment does not start, and why (shown to the commenter). */
export interface AgentNotStarted {
  userId: string;
  name: string;
  reason: string;
}

export async function addComment(actor: Actor, taskId: string, input: any): Promise<{ id: string; agentsNotStarted: AgentNotStarted[] }> {
  const { db } = getDb();
  const task = await loadTask(taskId);
  const project = await assertProject(actor, task.projectId, 'member');
  const id = ulid();
  // Mentions come from the explicit list plus any parsed out of the comment body,
  // so a client that only sends the tiptap doc still notifies the mentioned users.
  const mentions = [...new Set<string>([...(input.mentions ?? []), ...extractMentions(input.body).users])]
    .filter((u) => u !== actor.userId);
  // An @-mention of an agent ordi runs puts work on it, so the commenter must
  // be allowed to assign that agent (R49), the same as for an assignment. The
  // comment is posted either way – it is still a message to read – but an
  // agent the commenter may not assign is not started, and the answer says
  // why. An agent already on the task follows the thread up as an assignee.
  // These are reads only, so they run before the comment is written.
  const { agentMentions, agentsNotStarted } = await dispatchableAgentMentions(actor, project, taskId, mentions);
  const ref = await taskRef(task);
  // The comment, its events and the activity record commit together: no
  // event announces a comment that was not saved, and none is missing for
  // one that was.
  await db.transaction(async (tx) => {
    await tx.insert(schema.comments).values({ id, taskId, authorId: actor.userId, via: actor.agentKind === 'personal' ? actor.clientLabel ?? null : null, body: input.body ?? {} });
    // The addressee's first comment after a question answers it.
    await answerByComment(tx, actor, task, ref, id);
    if (mentions.length) {
      await publishEvent(tx, {
        type: 'comment.mentioned',
        aggregateType: 'comment',
        aggregateId: id,
        payload: { mentions, ref, taskId, projectId: task.projectId, commentId: id },
        actorId: actor.userId,
        actorType: actor.actorType,
      });
    }
    // Every comment is an event: agents assigned to the task follow up on it (R30).
    await publishEvent(tx, {
      type: 'comment.created', aggregateType: 'comment', aggregateId: id,
      payload: { ref, taskId, projectId: task.projectId, commentId: id, mentions, agentMentions },
      actorId: actor.userId, actorType: actor.actorType,
    });
    await writeActivity(tx, { entityType: 'comment', entityId: id, action: 'created', actorId: actor.userId, actorType: actor.actorType });
  });
  return { id, agentsNotStarted };
}

/**
 * Split the agents ordi runs among `mentions` into those the comment may start
 * (`agentMentions`, read by the dispatcher) and those it may not, with the
 * reason. Mentioned people, and agents ordi does not run, are neither.
 */
async function dispatchableAgentMentions(
  actor: Actor,
  project: Awaited<ReturnType<typeof assertProject>>,
  taskId: string,
  mentions: string[],
): Promise<{ agentMentions: string[]; agentsNotStarted: AgentNotStarted[] }> {
  const profiles = await agentProfilesAmong(mentions);
  if (!profiles.size) return { agentMentions: [], agentsNotStarted: [] };
  const mentionedAgents = [...profiles.keys()];
  const refusals = await agentAssignRefusals(actor, project.id, mentionedAgents, effectiveProjectRole(actor, project));
  const refused = new Map<string, string>();
  for (const r of refusals) if (!refused.has(r.userId)) refused.set(r.userId, r.error.message);
  // The mention itself starts only an agent the commenter may assign. One on
  // the task follows the comment up as an assignee anyway – for as long as it
  // stays assigned, which the dispatcher reads when the event is delivered –
  // so it is not reported as not started.
  const agentMentions = mentionedAgents.filter((userId) => !refused.has(userId));
  const assigned = new Set(await assigneeIdsOf(taskId));
  for (const userId of assigned) refused.delete(userId);
  if (!refused.size) return { agentMentions, agentsNotStarted: [] };
  const { db } = getDb();
  const names = new Map((await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users)
    .where(inArray(schema.users.id, [...refused.keys()]))).map((u) => [u.id, u.name]));
  return {
    agentMentions,
    agentsNotStarted: [...refused].map(([userId, reason]) => ({ userId, name: names.get(userId) ?? '', reason })),
  };
}

/**
 * Rewrites one comment – only its author, whatever role anyone else holds. An
 * edit changes what a person is on record as having said, so moderation stays
 * with delete, which a project admin may still use on any comment. `editedAt`
 * is what tells the reader the text they see is not the text that was posted.
 */
export async function editComment(actor: Actor, commentId: string, body: unknown) {
  const { db } = getDb();
  const [comment] = await db.select().from(schema.comments).where(and(eq(schema.comments.id, commentId), isNull(schema.comments.deletedAt)));
  if (!comment) throw err.notFound('Comment not found');
  const task = await loadTask(comment.taskId);
  // Project access first: someone outside the project learns nothing about who
  // wrote what, they are simply not in it.
  await assertProject(actor, task.projectId, 'member');
  if (comment.authorId !== actor.userId) throw err.forbidden('Only the author can edit a comment');
  await db.update(schema.comments).set({ body: body ?? {}, editedAt: new Date() }).where(eq(schema.comments.id, commentId));
  // A mention added by the edit notifies like a fresh one; the mentions that
  // were already in the comment stay quiet instead of pinging twice.
  const before = new Set(extractMentions(comment.body).users);
  const mentions = extractMentions(body).users.filter((u) => u !== actor.userId && !before.has(u));
  if (mentions.length) {
    await emit({
      type: 'comment.mentioned',
      aggregateType: 'comment',
      aggregateId: commentId,
      payload: { mentions, ref: await taskRef(task), taskId: task.id, projectId: task.projectId, commentId },
      actorId: actor.userId,
      actorType: actor.actorType,
    });
  }
  await writeActivity(db, { entityType: 'comment', entityId: commentId, action: 'updated', actorId: actor.userId, actorType: actor.actorType });
  return { ok: true };
}

/**
 * Slack-style toggle: one call adds the actor's reaction, the same call takes
 * it back. Stored as `{ emoji: [userId, ...] }` on the comment – the column
 * has been there since the schema was born, this makes it live.
 */
export async function toggleCommentReaction(actor: Actor, commentId: string, emoji: string) {
  const { db } = getDb();
  const [comment] = await db.select().from(schema.comments).where(and(eq(schema.comments.id, commentId), isNull(schema.comments.deletedAt)));
  if (!comment) throw err.notFound('Comment not found');
  const task = await loadTask(comment.taskId);
  await assertProject(actor, task.projectId, 'member');
  const reactions = { ...((comment.reactions ?? {}) as Record<string, string[]>) };
  const reacted = new Set(reactions[emoji] ?? []);
  const mine = reacted.has(actor.userId);
  if (mine) reacted.delete(actor.userId); else reacted.add(actor.userId);
  if (reacted.size) reactions[emoji] = [...reacted]; else delete reactions[emoji];
  await db.update(schema.comments).set({ reactions }).where(eq(schema.comments.id, commentId));
  return { reactions, reacted: !mine };
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
  // The role on each project by the rule a single-task edit is held to
  // (assertProject at member level): a membership row, or what a workspace
  // project grants the role's permissions – never for an agent, which stays
  // membership-only. Reading the membership map alone refused projects the
  // caller edits task by task. A deleted project is absent, so it grants nothing.
  const projectIds = [...new Set(rows.map((t) => t.projectId))];
  const liveProjects = projectIds.length
    ? await db.select({ id: projects.id, visibility: projects.visibility }).from(projects)
      .where(and(inArray(projects.id, projectIds), isNull(projects.deletedAt)))
    : [];
  const roleOf = new Map(liveProjects.map((p) => [
    p.id,
    effectiveProjectRole(actor, { id: p.id, visibility: p.visibility as 'workspace' | 'private' }),
  ]));
  const canEdit = (projectId: string) => {
    const role = roleOf.get(projectId);
    return role === 'admin' || role === 'member';
  };
  // Before any row is written: a selection spanning projects must not land
  // half of itself in a cycle the other half cannot belong to.
  if (input.cycleId) {
    for (const projectId of new Set(rows.map((t) => t.projectId).filter(canEdit))) {
      await assertCycleInProject(input.cycleId, projectId);
    }
  }
  if (input.milestoneId) {
    for (const projectId of new Set(rows.map((t) => t.projectId).filter(canEdit))) {
      await assertMilestoneInProject(input.milestoneId, projectId);
    }
  }
  if (input.statusId) {
    for (const projectId of new Set(rows.map((t) => t.projectId).filter(canEdit))) {
      await assertStatusInProject(input.statusId, projectId);
    }
  }

  // Every check runs before the first write – an agent the caller may not
  // assign refuses the whole request, not the tasks after the ones already
  // saved – and the writes and their events share one transaction.
  const editable = rows.filter((t) => canEdit(t.projectId));
  const nextAssignees: string[] | undefined = input.assigneeIds;
  const nextLabels: string[] | undefined = input.labelIds;
  const checked = new Map<string, Set<string>>();
  const assertAssignable = async (t: typeof rows[number], added: string[]) => {
    const done = checked.get(t.projectId) ?? new Set<string>();
    const unchecked = added.filter((a) => !done.has(a));
    if (unchecked.length) await assertCanAssignAgents(actor, t.projectId, unchecked, roleOf.get(t.projectId) ?? null);
    for (const a of unchecked) done.add(a);
    checked.set(t.projectId, done);
  };
  const refs = new Map<string, string>();
  for (const t of editable) {
    if (nextAssignees) {
      const current = await assigneeIdsOf(t.id);
      await assertAssignable(t, nextAssignees.filter((a) => !current.includes(a)));
    }
    refs.set(t.id, await taskRef(t));
  }
  const patch: Record<string, unknown> = {};
  if (input.statusId !== undefined) patch.statusId = input.statusId;
  if (input.cycleId !== undefined) patch.cycleId = input.cycleId;
  if (input.milestoneId !== undefined) patch.milestoneId = input.milestoneId;
  if (input.priority !== undefined) patch.priority = input.priority;

  return db.transaction(async (tx) => {
    if (!editable.length) return { updated: 0 };
    // Lock the selection in one order, so overlapping edits wait instead of
    // deadlocking. A task deleted or moved to another project since it was
    // read is left alone: what was checked was its old place.
    const locked = await tx.select({ id: tasks.id, projectId: tasks.projectId, statusId: tasks.statusId }).from(tasks)
      .where(and(inArray(tasks.id, editable.map((t) => t.id)), isNull(tasks.deletedAt)))
      .orderBy(asc(tasks.id)).for('update');
    const now = new Map(locked.map((r) => [r.id, r]));
    const live = editable.filter((t) => now.get(t.id)?.projectId === t.projectId);
    const assigned = new Map<string, string[]>();
    if (live.length) {
      for (const r of await tx.select({ taskId: taskAssignees.taskId, userId: taskAssignees.userId }).from(taskAssignees)
        .where(inArray(taskAssignees.taskId, live.map((t) => t.id)))) {
        assigned.set(r.taskId, [...(assigned.get(r.taskId) ?? []), r.userId]);
      }
    }
    for (const t of live) {
      const ref = refs.get(t.id)!;
      const oldAssignees = assigned.get(t.id) ?? [];
      const added = nextAssignees ? nextAssignees.filter((a) => !oldAssignees.includes(a)) : [];
      // Someone may have taken an assignee off since the check above.
      await assertAssignable(t, added);
      if (Object.keys(patch).length) await tx.update(tasks).set(patch).where(eq(tasks.id, t.id));
      if (nextAssignees) {
        await tx.delete(taskAssignees).where(eq(taskAssignees.taskId, t.id));
        if (nextAssignees.length) await tx.insert(taskAssignees).values(nextAssignees.map((userId) => ({ taskId: t.id, userId })));
        // Bulk assignment dispatches and notifies like a single one (R12).
        if (added.length) {
          await publishEvent(tx, { type: 'task.assigned', aggregateType: 'task', aggregateId: t.id, payload: { assigneeIds: added, ref, taskId: t.id, projectId: t.projectId }, actorId: actor.userId, actorType: actor.actorType });
        }
      }
      if (input.statusId !== undefined && input.statusId !== now.get(t.id)!.statusId) {
        await publishEvent(tx, { type: 'task.status_changed', aggregateType: 'task', aggregateId: t.id, payload: { ref, taskId: t.id, assigneeIds: nextAssignees ?? oldAssignees, createdBy: t.createdBy, reporterId: t.reporterId, projectId: t.projectId }, actorId: actor.userId, actorType: actor.actorType });
      }
      if (nextLabels) {
        await tx.delete(taskLabels).where(eq(taskLabels.taskId, t.id));
        if (nextLabels.length) await tx.insert(taskLabels).values(nextLabels.map((labelId) => ({ taskId: t.id, labelId })));
      }
    }
    return { updated: live.length };
  });
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
  const rows = await db.select().from(schema.intakeItems)
    .where(and(eq(schema.intakeItems.projectId, projectId), eq(schema.intakeItems.status, 'pending')))
    .orderBy(desc(schema.intakeItems.createdAt));
  // The submitter key only feeds the public form's rate limit.
  return rows.map(({ submitterKey: _key, ...item }) => item);
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
  const description = intakeTaskDescription(item.description, (item.answers ?? []) as IntakeAnswer[]);
  const writeTask = await prepareTask(actor, {
    projectId: item.projectId, title: item.title, description,
    statusId: input.statusId, typeId: input.typeId ?? null, assigneeIds: input.assigneeIds ?? [],
  });
  const { db } = getDb();
  // The task, the item's new status and its files move together: a failure
  // part way leaves the item pending, with no task made from it.
  const task = await db.transaction(async (tx) => {
    // The row lock makes a second accept (or a decline) of the same item wait
    // and then see it triaged, instead of making a second task.
    const [locked] = await tx.select({ status: schema.intakeItems.status }).from(schema.intakeItems)
      .where(eq(schema.intakeItems.id, itemId)).for('update');
    if (!locked || locked.status !== 'pending') throw err.domain('Intake item already triaged');
    const created = await writeTask(tx);
    await tx.update(schema.intakeItems).set({ status: 'accepted', createdTaskId: created.id }).where(eq(schema.intakeItems.id, itemId));
    // The request's files travel with it: re-bind them to the created task so
    // they appear in the task's Files section under the task's access rules.
    await tx.update(schema.attachments).set({ entityType: 'task', entityId: created.id })
      .where(and(eq(schema.attachments.entityType, 'intake_item'), eq(schema.attachments.entityId, itemId)));
    return created;
  });
  // The accept has committed: a mail server that refuses the notice does not
  // turn it into a failed request, which a retry would answer with "triaged".
  if (item.requesterEmail) {
    await sendIntakeMail(item.requesterEmail, 'intakeAccepted', item.title, null)
      .catch((e) => logger.warn({ err: e, itemId }, 'intake accepted mail failed'));
  }
  return { taskId: task.id, ref: task.ref };
}

export async function declineIntake(actor: Actor, itemId: string, input: any) {
  const item = await loadIntakeItem(itemId);
  await assertProject(actor, item.projectId, 'member');
  if (item.status !== 'pending') throw err.domain('Intake item already triaged');
  const { db } = getDb();
  // Only a pending item: an accept that committed in between keeps its task.
  const declined = await db.update(schema.intakeItems).set({ status: 'declined', declineReason: input.reason ?? '' })
    .where(and(eq(schema.intakeItems.id, itemId), eq(schema.intakeItems.status, 'pending'))).returning({ id: schema.intakeItems.id });
  if (!declined.length) throw err.domain('Intake item already triaged');
  if (input.notify && item.requesterEmail) {
    await sendIntakeMail(item.requesterEmail, 'intakeDeclined', item.title, input.reason ?? null)
      .catch((e) => logger.warn({ err: e, itemId }, 'intake declined mail failed'));
  }
  return { ok: true };
}

export async function getIntakeSettings(actor: Actor, projectId: string) {
  await assertProject(actor, projectId, 'admin');
  const { db } = getDb();
  const [settings] = await db.select().from(schema.intakeSettings).where(eq(schema.intakeSettings.projectId, projectId));
  if (!settings) throw err.notFound('Intake settings not found');
  return presentIntakeSettings(settings);
}

/**
 * Settings as the editor sees them: the form made whole, the mailbox password
 * withheld, and whether file uploads can work here at all.
 */
function presentIntakeSettings<T extends { mailbox?: unknown; formConfig?: unknown }>(settings: T) {
  return {
    ...redactMailbox(settings),
    formConfig: normalizeIntakeFormConfig(settings.formConfig),
    storageConfigured: isStorageConfigured(),
  };
}

/**
 * A new form token: the old link and every page that embeds it stop working
 * at once (404). For a link that leaked or a form that attracts spam.
 */
export async function rotateIntakeToken(actor: Actor, projectId: string) {
  await assertProject(actor, projectId, 'admin');
  const { db } = getDb();
  const [settings] = await db.update(schema.intakeSettings).set({ formToken: generateToken(), updatedAt: new Date() })
    .where(eq(schema.intakeSettings.projectId, projectId)).returning();
  if (!settings) throw err.notFound('Intake settings not found');
  await writeActivity(db, {
    entityType: 'project', entityId: projectId, action: 'updated',
    diff: { intakeFormToken: { to: 'rotated' } },
    actorId: actor.userId, actorType: actor.actorType,
  });
  return presentIntakeSettings(settings);
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
  if (input.formConfig !== undefined) patch.formConfig = normalizeIntakeFormConfig(input.formConfig);
  if (Object.keys(patch).length) await db.update(schema.intakeSettings).set(patch).where(eq(schema.intakeSettings.projectId, projectId));
  const [settings] = await db.select().from(schema.intakeSettings).where(eq(schema.intakeSettings.projectId, projectId));
  if (!settings) throw err.notFound('Intake settings not found');
  return presentIntakeSettings(settings);
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

  // A person's own agent works its owner's tasks: "my tasks" are theirs.
  // `status_id`, `version` and the project's `visibility` are what the list
  // needs to change a status in place: the current pick, the optimistic-lock
  // token for the PATCH, and the input to the caller's project-role check.
  const assigned = await db.execute(sql`
    select t.id, t.title, t.due_date, t.priority, t.number, t.project_id, t.status_id, t.version,
      p.key, p.visibility, ts.category, ts.name as status_name, ts.color as status_color
    from tasks t
    join task_assignees ta on ta.task_id = t.id and ta.user_id = ${actor.ownerUserId ?? actor.userId}
    join projects p on p.id = t.project_id
    join task_statuses ts on ts.id = t.status_id
    where t.deleted_at is null and ts.category not in ('done','canceled') and t.project_id in ${inList}
    order by t.due_date nulls last`) as any[];

  // A person and their own agent share one list: what either filed (the agent
  // files for its owner, who is the task's reporter).
  const person = actor.ownerUserId ?? actor.userId;
  const filers = [person, ...(await personalAgentIdsOf([person]))];
  const createdBy = sql`(${sql.join(filers.map((id) => sql`${id}`), sql`, `)})`;
  const created = await db.execute(sql`
    select t.id, t.title, t.due_date, t.priority, t.number, t.project_id, t.status_id, t.version,
      p.key, p.visibility, ts.category, ts.name as status_name, ts.color as status_color,
      exists (select 1 from task_assignees ta where ta.task_id = t.id) as has_assignee
    from tasks t
    join projects p on p.id = t.project_id
    join task_statuses ts on ts.id = t.status_id
    where t.deleted_at is null and t.created_by in ${createdBy}
      and ts.category not in ('done','canceled') and t.project_id in ${inList}
    order by t.due_date nulls last`) as any[];

  // Whom each task's open question waits on: the mark on the row.
  const waiting = await waitingOnFor([...(assigned as any[]), ...(created as any[])].map((r) => r.id));
  const withRef = (r: any) => ({ ...r, ref: refOf(r.key, r.number), waiting_on_user_id: waiting.get(r.id) ?? null });
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
  await sendEmailNow({ to, subject: tr(locale, `${kind}.subject`), body: rendered.text, html: rendered.html });
}
