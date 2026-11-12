/**
 * Time tracking service (PRD §10, §11.10). Entries snapshot both the client
 * hourly_rate (from project_rates) and the cost_rate (from employee
 * compensation + overhead) at creation time, so past periods stay correct.
 */
import { getDb, schema, eq, and, isNull, desc, gte, lt, lte, sql, type SQL } from '@ordi/db';
import { ulid } from 'ulid';
import { compensationAt, hourlyCostRate, overheadPerHour, type CompensationRecord } from '@ordi/shared';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { emit } from '../../core/events';
import { assertVersion } from '../../core/locking';
import { assertProject, assertLiveProject, notInDeletedProject } from '../../core/access';

/** Inclusive upper bound for a plain date (`YYYY-MM-DD` → end of that day). */
function upperBound(to?: string): string | undefined {
  if (!to) return undefined;
  return to.length === 10 ? `${to}T23:59:59.999Z` : to;
}

/** Workspace default billable flag (fallback when a project has no override). */
async function workspaceDefaultBillable(db: any): Promise<boolean> {
  const [ws] = await db.select({ defaultBillable: schema.workspaceSettings.defaultBillable })
    .from(schema.workspaceSettings).limit(1);
  return ws?.defaultBillable ?? true;
}

async function workspaceDefaultCurrency(db: any): Promise<string> {
  const [ws] = await db.select({ defaultCurrency: schema.workspaceSettings.defaultCurrency })
    .from(schema.workspaceSettings).limit(1);
  return ws?.defaultCurrency ?? 'USD';
}

/** billable default: explicit override → project settings → workspace default (PRD §10.2). */
async function resolveBillable(db: any, settings: unknown, override?: boolean): Promise<boolean> {
  if (typeof override === 'boolean') return override;
  const s = (settings ?? {}) as Record<string, unknown>;
  if (typeof s.defaultBillable === 'boolean') return s.defaultBillable as boolean;
  if (typeof s.billable === 'boolean') return s.billable as boolean;
  return workspaceDefaultBillable(db);
}

/** hourly_rate snapshot: personal project rate → project default → 0 (PRD §10.2). */
async function snapshotHourlyRate(db: any, projectId: string, userId: string): Promise<string> {
  const rates = await db.select().from(schema.projectRates).where(eq(schema.projectRates.projectId, projectId));
  const personal = rates.find((r: any) => r.userId === userId);
  if (personal) return String(personal.hourlyRate);
  const def = rates.find((r: any) => r.userId === null);
  if (def) return String(def.hourlyRate);
  return '0';
}

/**
 * cost_rate snapshot (PRD §11.10, §12.5): employee compensation effective at the
 * entry date + optional company overhead per hour. 0 when the user has no
 * linked employee / no effective compensation.
 */
async function snapshotCostRate(db: any, userId: string, isoDate: string): Promise<string> {
  const dateStr = isoDate.slice(0, 10);
  const [emp] = await db.select({ id: schema.employees.id })
    .from(schema.employees)
    .where(and(eq(schema.employees.userId, userId), isNull(schema.employees.deletedAt)));
  if (!emp) return '0';

  const comps = await db.select().from(schema.compensation).where(eq(schema.compensation.employeeId, emp.id));
  const records: CompensationRecord[] = comps.map((r: any) => ({
    compType: r.compType as CompensationRecord['compType'],
    amount: Number(r.amount),
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
  }));
  const comp = compensationAt(records, dateStr);
  if (!comp) return '0';

  const [oh] = await db.select().from(schema.overheadSettings)
    .where(lte(schema.overheadSettings.effectiveFrom, dateStr))
    .orderBy(desc(schema.overheadSettings.effectiveFrom))
    .limit(1);
  const workingHoursPerWeek = oh ? Number(oh.workingHoursPerWeek) : 40;
  let cost = hourlyCostRate(comp, workingHoursPerWeek);
  if (oh) cost += overheadPerHour(Number(oh.monthlyBase), workingHoursPerWeek);
  return String(cost);
}

async function getEntry(id: string) {
  const { db } = getDb();
  // An entry of a deleted project went with it: not editable until a restore.
  const [entry] = await db.select().from(schema.timeEntries)
    .where(and(eq(schema.timeEntries.id, id), notInDeletedProject(schema.timeEntries.projectId)));
  if (!entry) throw err.notFound('Time entry not found');
  return entry;
}

/** Resolve a task's project, asserting the actor can view it. */
async function taskProject(actor: Actor, taskId: string): Promise<{ projectId: string; settings: unknown }> {
  const { db } = getDb();
  const [task] = await db.select({ id: schema.tasks.id, projectId: schema.tasks.projectId })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, taskId), isNull(schema.tasks.deletedAt)));
  if (!task) throw err.notFound('Task not found');
  await assertProject(actor, task.projectId, 'viewer');
  const [proj] = await db.select({ settings: schema.projects.settings })
    .from(schema.projects).where(eq(schema.projects.id, task.projectId));
  return { projectId: task.projectId, settings: proj?.settings ?? {} };
}

// ── Entries ──

/**
 * An entry with what it was logged against: a bare row only knows ids, so a
 * list of them could show nothing but the note.
 */
const te = schema.timeEntries;
const entryColumns = {
  id: te.id, taskId: te.taskId, userId: te.userId, projectId: te.projectId,
  startedAt: te.startedAt, durationSeconds: te.durationSeconds, note: te.note,
  billable: te.billable, hourlyRate: te.hourlyRate, costRate: te.costRate,
  invoiceItemId: te.invoiceItemId, createdAt: te.createdAt, updatedAt: te.updatedAt, version: te.version,
  taskNumber: schema.tasks.number, taskTitle: schema.tasks.title,
  projectKey: schema.projects.key, projectName: schema.projects.name,
  userName: schema.users.name,
};

function selectEntries() {
  const { db } = getDb();
  return db.select(entryColumns).from(te)
    .innerJoin(schema.tasks, eq(schema.tasks.id, te.taskId))
    .innerJoin(schema.projects, eq(schema.projects.id, te.projectId))
    .innerJoin(schema.users, eq(schema.users.id, te.userId));
}

type EntryRow = Awaited<ReturnType<ReturnType<typeof selectEntries>['where']>>[number];

function withRef(row: EntryRow) {
  return { ...row, taskRef: `${row.projectKey}-${row.taskNumber}` };
}

export interface EntryFilters {
  from?: string;
  to?: string;
  projectId?: string;
  userId?: string;
  taskId?: string;
  /** A company id, or `internal` for projects with no client. */
  companyId?: string;
  limit: number;
}

export async function listEntries(actor: Actor, filters: EntryFilters, canReadAll: boolean) {
  const scopedUserId = canReadAll ? filters.userId : actor.userId;
  const to = upperBound(filters.to);
  const rows = await selectEntries().where(and(
    scopedUserId ? eq(te.userId, scopedUserId) : undefined,
    filters.projectId ? eq(te.projectId, filters.projectId) : undefined,
    filters.taskId ? eq(te.taskId, filters.taskId) : undefined,
    filters.companyId === 'internal' ? isNull(schema.projects.companyId)
      : filters.companyId ? eq(schema.projects.companyId, filters.companyId) : undefined,
    isNull(schema.projects.deletedAt),
    filters.from ? gte(te.startedAt, new Date(filters.from)) : undefined,
    to ? lte(te.startedAt, new Date(to)) : undefined,
  )).orderBy(desc(te.startedAt), desc(te.id)).limit(filters.limit + 1);
  return rows.map(withRef);
}

/** One entry with its task and project, for the entry panel. */
export async function getEntryDetail(actor: Actor, id: string, canReadAll: boolean) {
  const [row] = await selectEntries().where(and(eq(te.id, id), isNull(schema.projects.deletedAt)));
  // Someone else's entry is as invisible as a missing one without time.read_all.
  if (!row || (row.userId !== actor.userId && !canReadAll)) throw err.notFound('Time entry not found');
  return withRef(row);
}

/**
 * Time logged on a task: the total and the viewer's own share for anyone who
 * can see the task, the split by person and everyone's entries only with
 * time.read_all (the same line /time/entries draws).
 */
export async function taskTime(actor: Actor, taskId: string, canReadAll: boolean) {
  const { db } = getDb();
  await taskProject(actor, taskId);
  const people = await db.select({
    userId: te.userId, name: schema.users.name,
    seconds: sql<number>`coalesce(sum(${te.durationSeconds}), 0)::int`,
  }).from(te)
    .innerJoin(schema.users, eq(schema.users.id, te.userId))
    .where(eq(te.taskId, taskId))
    .groupBy(te.userId, schema.users.name)
    .orderBy(desc(sql`sum(${te.durationSeconds})`));
  const totalSeconds = people.reduce((acc, p) => acc + Number(p.seconds), 0);
  const mySeconds = Number(people.find((p) => p.userId === actor.userId)?.seconds ?? 0);
  const entries = await selectEntries().where(and(
    eq(te.taskId, taskId),
    canReadAll ? undefined : eq(te.userId, actor.userId),
  )).orderBy(desc(te.startedAt), desc(te.id)).limit(50);
  return {
    totalSeconds,
    mySeconds,
    people: canReadAll ? people.map((p) => ({ ...p, seconds: Number(p.seconds) })) : null,
    entries: entries.map(withRef),
  };
}

export async function createEntry(actor: Actor, input: any): Promise<string> {
  const { db } = getDb();
  const { projectId, settings } = await taskProject(actor, input.taskId);
  const billable = await resolveBillable(db, settings, input.billable);
  const hourlyRate = await snapshotHourlyRate(db, projectId, actor.userId);
  const costRate = await snapshotCostRate(db, actor.userId, input.startedAt);
  const id = ulid();
  await db.insert(schema.timeEntries).values({
    id,
    taskId: input.taskId,
    userId: actor.userId,
    projectId,
    startedAt: new Date(input.startedAt),
    durationSeconds: input.durationSeconds,
    note: input.note ?? '',
    billable,
    hourlyRate,
    costRate,
  });
  await writeActivity(db, { entityType: 'time_entry', entityId: id, action: 'created', after: { taskId: input.taskId, projectId, durationSeconds: input.durationSeconds, billable }, actorId: actor.userId, actorType: actor.actorType });
  await emit({ type: 'time.entry_created', aggregateType: 'time_entry', aggregateId: id, payload: { taskId: input.taskId, projectId, userId: actor.userId, durationSeconds: input.durationSeconds, billable }, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

export async function updateEntry(actor: Actor, id: string, input: any, canManage: boolean) {
  const { db } = getDb();
  const entry = await getEntry(id);
  if (entry.userId !== actor.userId && !canManage) throw err.forbidden('Cannot edit others’ time', 'time.manage');
  assertVersion(entry, input.version, entry);

  if (entry.invoiceItemId && input.durationSeconds !== undefined && input.durationSeconds !== entry.durationSeconds) {
    throw err.domain('Cannot change the duration of a billed entry; remove it from the invoice first');
  }

  const patch: Record<string, unknown> = {};
  if (input.startedAt !== undefined) patch.startedAt = new Date(input.startedAt);
  if (input.durationSeconds !== undefined) patch.durationSeconds = input.durationSeconds;
  if (input.note !== undefined) patch.note = input.note;
  if (input.billable !== undefined) patch.billable = input.billable;
  if (Object.keys(patch).length === 0) return entry;

  await db.update(schema.timeEntries).set(patch)
    .where(and(eq(schema.timeEntries.id, id), eq(schema.timeEntries.version, entry.version)));
  await writeActivity(db, { entityType: 'time_entry', entityId: id, action: 'updated', before: entry as any, after: patch, actorId: actor.userId, actorType: actor.actorType });
  return getEntry(id);
}

export async function deleteEntry(actor: Actor, id: string, canManage: boolean): Promise<void> {
  const { db } = getDb();
  const entry = await getEntry(id);
  if (entry.userId !== actor.userId && !canManage) throw err.forbidden('Cannot delete others’ time', 'time.manage');
  if (entry.invoiceItemId) throw err.domain('Cannot delete a billed entry; remove it from the invoice first');
  await db.delete(schema.timeEntries).where(eq(schema.timeEntries.id, id));
  await writeActivity(db, { entityType: 'time_entry', entityId: id, action: 'deleted', before: entry as any, actorId: actor.userId, actorType: actor.actorType });
}

// ── Timer ──

/** Convert a running timer into a completed time entry (snapshotting rates). */
async function timerToEntry(actor: Actor, timer: { userId: string; taskId: string; startedAt: Date; note: string }): Promise<string | null> {
  const { db } = getDb();
  const [task] = await db.select({ projectId: schema.tasks.projectId })
    .from(schema.tasks)
    .where(and(eq(schema.tasks.id, timer.taskId), isNull(schema.tasks.deletedAt)));
  if (!task) return null; // task gone; nothing to persist
  const [proj] = await db.select({ settings: schema.projects.settings })
    .from(schema.projects).where(and(eq(schema.projects.id, task.projectId), isNull(schema.projects.deletedAt)));
  // Project deleted under a running timer: closeProjectTimers saves those at
  // delete time, so one still here has nowhere visible to go.
  if (!proj) return null;
  const durationSeconds = Math.max(0, Math.floor((Date.now() - timer.startedAt.getTime()) / 1000));
  const billable = await resolveBillable(db, proj?.settings ?? {}, undefined);
  const hourlyRate = await snapshotHourlyRate(db, task.projectId, timer.userId);
  const costRate = await snapshotCostRate(db, timer.userId, timer.startedAt.toISOString());
  const id = ulid();
  await db.insert(schema.timeEntries).values({
    id,
    taskId: timer.taskId,
    userId: timer.userId,
    projectId: task.projectId,
    startedAt: timer.startedAt,
    durationSeconds,
    note: timer.note,
    billable,
    hourlyRate,
    costRate,
  });
  await writeActivity(db, { entityType: 'time_entry', entityId: id, action: 'created', after: { taskId: timer.taskId, projectId: task.projectId, durationSeconds, billable, source: 'timer' }, actorId: actor.userId, actorType: actor.actorType });
  await emit({ type: 'time.entry_created', aggregateType: 'time_entry', aggregateId: id, payload: { taskId: timer.taskId, projectId: task.projectId, userId: timer.userId, durationSeconds, billable, source: 'timer' }, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

/**
 * Turn every timer running on a project's tasks into its time entry. Called
 * just before the project is soft-deleted: the entries go with the project and
 * come back on restore, where a timer left running would be lost.
 */
export async function closeProjectTimers(actor: Actor, projectId: string): Promise<void> {
  const { db } = getDb();
  const timers = await db.select({
    userId: schema.activeTimers.userId, taskId: schema.activeTimers.taskId,
    startedAt: schema.activeTimers.startedAt, note: schema.activeTimers.note,
  }).from(schema.activeTimers)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.activeTimers.taskId))
    .where(eq(schema.tasks.projectId, projectId));
  for (const timer of timers) {
    await timerToEntry(actor, timer);
    await db.delete(schema.activeTimers).where(eq(schema.activeTimers.userId, timer.userId));
  }
}

export async function startTimer(actor: Actor, input: any) {
  const { db } = getDb();
  await taskProject(actor, input.taskId); // assert access to the task's project
  // Stop any existing active timer (one active timer per user, PRD §10.2).
  const [existing] = await db.select().from(schema.activeTimers).where(eq(schema.activeTimers.userId, actor.userId));
  let stoppedEntryId: string | null = null;
  if (existing) {
    stoppedEntryId = await timerToEntry(actor, { userId: existing.userId, taskId: existing.taskId, startedAt: existing.startedAt, note: existing.note });
    await db.delete(schema.activeTimers).where(eq(schema.activeTimers.userId, actor.userId));
  }
  const startedAt = new Date();
  await db.insert(schema.activeTimers).values({ userId: actor.userId, taskId: input.taskId, startedAt, note: input.note ?? '' });
  return { userId: actor.userId, taskId: input.taskId, startedAt, note: input.note ?? '', elapsedSeconds: 0, stoppedEntryId };
}

export async function stopTimer(actor: Actor) {
  const { db } = getDb();
  const [timer] = await db.select().from(schema.activeTimers).where(eq(schema.activeTimers.userId, actor.userId));
  if (!timer) throw err.notFound('No active timer');
  const entryId = await timerToEntry(actor, { userId: timer.userId, taskId: timer.taskId, startedAt: timer.startedAt, note: timer.note });
  await db.delete(schema.activeTimers).where(eq(schema.activeTimers.userId, actor.userId));
  return { entryId };
}

export async function getTimer(actor: Actor) {
  const { db } = getDb();
  const [timer] = await db.select().from(schema.activeTimers).where(eq(schema.activeTimers.userId, actor.userId));
  if (!timer) return null;
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - timer.startedAt.getTime()) / 1000));
  // The header indicator shows which task is being timed, so hand back its ref
  // and title rather than making every caller look them up.
  const [task] = await db
    .select({ number: schema.tasks.number, title: schema.tasks.title, key: schema.projects.key, deletedAt: schema.projects.deletedAt })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tasks.projectId))
    .where(eq(schema.tasks.id, timer.taskId));
  if (task?.deletedAt) {
    // Belt and braces – the delete closes these timers – but a stray one must
    // not keep naming a task nobody can open.
    await db.delete(schema.activeTimers).where(eq(schema.activeTimers.userId, actor.userId));
    return null;
  }
  return {
    ...timer,
    elapsedSeconds,
    ref: task ? `${task.key}-${task.number}` : null,
    title: task?.title ?? null,
  };
}

// ── Rates ──

export async function listRates(projectId: string) {
  await assertLiveProject(projectId);
  const { db } = getDb();
  return db.select().from(schema.projectRates)
    .where(eq(schema.projectRates.projectId, projectId))
    .orderBy(desc(schema.projectRates.createdAt));
}

export async function upsertRate(actor: Actor, input: any): Promise<string> {
  await assertLiveProject(input.projectId);
  const { db } = getDb();
  const userId = input.userId ?? null;
  const existing = await db.select().from(schema.projectRates)
    .where(eq(schema.projectRates.projectId, input.projectId));
  const match = existing.find((r: any) => r.userId === userId);
  if (match) {
    await db.update(schema.projectRates)
      .set({ hourlyRate: String(input.hourlyRate), currency: input.currency ?? match.currency })
      .where(eq(schema.projectRates.id, match.id));
    await writeActivity(db, { entityType: 'project_rate', entityId: match.id, action: 'updated', after: { projectId: input.projectId, userId, hourlyRate: input.hourlyRate }, actorId: actor.userId, actorType: actor.actorType });
    return match.id;
  }
  const id = ulid();
  await db.insert(schema.projectRates).values({
    id,
    projectId: input.projectId,
    userId,
    hourlyRate: String(input.hourlyRate),
    currency: input.currency ?? 'USD',
  });
  await writeActivity(db, { entityType: 'project_rate', entityId: id, action: 'created', after: { projectId: input.projectId, userId, hourlyRate: input.hourlyRate }, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

export async function deleteRate(actor: Actor, id: string): Promise<void> {
  const { db } = getDb();
  const [rate] = await db.select().from(schema.projectRates).where(eq(schema.projectRates.id, id));
  if (!rate) throw err.notFound('Rate not found');
  await db.delete(schema.projectRates).where(eq(schema.projectRates.id, id));
  await writeActivity(db, { entityType: 'project_rate', entityId: id, action: 'deleted', before: rate as any, actorId: actor.userId, actorType: actor.actorType });
}

// ── Reports (raw SQL aggregates, PRD §10.2, §11.10) ──

interface ReportFilters { from?: string; to?: string; projectId?: string; userId?: string; taskId?: string; companyId?: string; billable: string }

function whereFragments(f: ReportFilters): SQL[] {
  // Time of a deleted project leaves the reports with it (and returns on restore).
  const conds: SQL[] = [notInDeletedProject(sql`te.project_id`)];
  if (f.from) conds.push(sql`te.started_at >= ${f.from}`);
  const to = upperBound(f.to);
  if (to) conds.push(sql`te.started_at <= ${to}`);
  if (f.projectId) conds.push(sql`te.project_id = ${f.projectId}`);
  if (f.userId) conds.push(sql`te.user_id = ${f.userId}`);
  if (f.taskId) conds.push(sql`te.task_id = ${f.taskId}`);
  // `internal` is the bucket the company grouping gives projects with no client.
  if (f.companyId === 'internal') conds.push(sql`te.project_id in (select id from projects where company_id is null)`);
  else if (f.companyId) conds.push(sql`te.project_id in (select id from projects where company_id = ${f.companyId})`);
  if (f.billable === 'billable') conds.push(sql`te.billable = true`);
  if (f.billable === 'nonbillable') conds.push(sql`te.billable = false`);
  return conds;
}

export async function report(params: ReportFilters & { groupBy: string }) {
  const { db } = getDb();
  const conds = whereFragments(params);
  const whereSql = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``;
  const wsCurrency = await workspaceDefaultCurrency(db);

  let rows: any[];
  if (params.groupBy === 'task') {
    rows = await db.execute(sql`
      select t.id as key, p.key || '-' || t.number as ref, t.title as label, p.id as project_id,
        p.name as project_name, ts.name as status_name, ts.category as status_category, ts.color as status_color,
        -- An estimate compares with time only when the project counts it in hours.
        case when p.settings->>'estimateUnit' = 'hours' then t.estimate end as estimate_hours,
        jsonb_agg(distinct jsonb_build_object('id', u.id, 'name', u.name, 'avatar', u.avatar, 'actorType', u.actor_type)) as people,
        max(te.started_at) as last_at,
        coalesce(c.default_currency, ${wsCurrency}) as currency,
        coalesce(sum(te.duration_seconds),0) as secs,
        coalesce(sum(te.duration_seconds) filter (where te.billable),0) as billable_secs,
        coalesce(sum((te.duration_seconds/3600.0) * te.hourly_rate),0) as amount,
        coalesce(sum((te.duration_seconds/3600.0) * te.hourly_rate) filter (where te.billable),0) as billable_amount
      from time_entries te
      join tasks t on t.id = te.task_id
      join task_statuses ts on ts.id = t.status_id
      join users u on u.id = te.user_id
      join projects p on p.id = te.project_id
      left join companies c on c.id = p.company_id
      ${whereSql}
      group by t.id, p.id, ts.id, c.default_currency
      order by secs desc`) as any[];
  } else if (params.groupBy === 'user') {
    rows = await db.execute(sql`
      select u.id as key, u.name as label, null::text as currency,
        max(te.started_at) as last_at,
        coalesce(sum(te.duration_seconds),0) as secs,
        coalesce(sum(te.duration_seconds) filter (where te.billable),0) as billable_secs,
        coalesce(sum((te.duration_seconds/3600.0) * te.hourly_rate),0) as amount,
        coalesce(sum((te.duration_seconds/3600.0) * te.hourly_rate) filter (where te.billable),0) as billable_amount
      from time_entries te
      join users u on u.id = te.user_id
      ${whereSql}
      group by u.id, u.name
      order by amount desc`) as any[];
  } else if (params.groupBy === 'company') {
    rows = await db.execute(sql`
      select coalesce(c.id, 'internal') as key, coalesce(c.name, '(internal)') as label,
        max(te.started_at) as last_at,
        coalesce(c.default_currency, ${wsCurrency}) as currency,
        coalesce(sum(te.duration_seconds),0) as secs,
        coalesce(sum(te.duration_seconds) filter (where te.billable),0) as billable_secs,
        coalesce(sum((te.duration_seconds/3600.0) * te.hourly_rate),0) as amount,
        coalesce(sum((te.duration_seconds/3600.0) * te.hourly_rate) filter (where te.billable),0) as billable_amount
      from time_entries te
      join projects p on p.id = te.project_id
      left join companies c on c.id = p.company_id
      ${whereSql}
      group by c.id, c.name, c.default_currency
      order by amount desc`) as any[];
  } else {
    rows = await db.execute(sql`
      select p.id as key, p.name as label,
        max(te.started_at) as last_at,
        coalesce(c.default_currency, ${wsCurrency}) as currency,
        coalesce(sum(te.duration_seconds),0) as secs,
        coalesce(sum(te.duration_seconds) filter (where te.billable),0) as billable_secs,
        coalesce(sum((te.duration_seconds/3600.0) * te.hourly_rate),0) as amount,
        coalesce(sum((te.duration_seconds/3600.0) * te.hourly_rate) filter (where te.billable),0) as billable_amount
      from time_entries te
      join projects p on p.id = te.project_id
      left join companies c on c.id = p.company_id
      ${whereSql}
      group by p.id, p.name, c.default_currency
      order by amount desc`) as any[];
  }

  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    ...(r.ref ? {
      ref: r.ref, projectId: r.project_id, projectName: r.project_name,
      status: { name: r.status_name, category: r.status_category, color: r.status_color },
      estimateHours: r.estimate_hours != null && Number(r.estimate_hours) > 0 ? Number(r.estimate_hours) : null,
      people: (typeof r.people === 'string' ? JSON.parse(r.people) : r.people ?? []) as { id: string; name: string; avatar: string | null; actorType: string }[],
    } : {}),
    lastAt: r.last_at ? new Date(r.last_at).toISOString() : null,
    hours: round2(Number(r.secs) / 3600),
    billableHours: round2(Number(r.billable_secs) / 3600),
    amount: round2(Number(r.amount)),
    billableAmount: round2(Number(r.billable_amount)),
    currency: r.currency ?? wsCurrency,
  }));
}

export async function unbilled(params: { companyId?: string; from?: string; to?: string }) {
  const { db } = getDb();
  // A deleted project cannot be invoiced, so its hours are not "unbilled work".
  const conds: SQL[] = [sql`te.billable = true`, sql`te.invoice_item_id is null`, sql`p.deleted_at is null`];
  if (params.companyId) conds.push(sql`c.id = ${params.companyId}`);
  if (params.from) conds.push(sql`te.started_at >= ${params.from}`);
  const to = upperBound(params.to);
  if (to) conds.push(sql`te.started_at <= ${to}`);
  const whereSql = sql`where ${sql.join(conds, sql` and `)}`;

  const rows = await db.execute(sql`
    select p.id as project_id, p.name as project_name,
      coalesce(c.default_currency, 'USD') as currency,
      t.id as task_id, t.number as task_number, t.title as task_title,
      coalesce(sum(te.duration_seconds),0) as secs,
      coalesce(sum((te.duration_seconds/3600.0) * te.hourly_rate),0) as amount
    from time_entries te
    join projects p on p.id = te.project_id
    join tasks t on t.id = te.task_id
    left join companies c on c.id = p.company_id
    ${whereSql}
    group by p.id, p.name, c.default_currency, t.id, t.number, t.title
    order by p.name, t.number`) as any[];

  return rows.map((r) => ({
    projectId: r.project_id,
    projectName: r.project_name,
    taskId: r.task_id,
    taskNumber: Number(r.task_number),
    taskTitle: r.task_title,
    hours: round2(Number(r.secs) / 3600),
    amount: round2(Number(r.amount)),
    currency: r.currency,
  }));
}

/**
 * The user's week. `bounds` are the instants the week starts and ends in the
 * viewer's own time zone: a UTC week put Monday 01:00 in Kyiv into the week
 * before. Without them (older clients) the week runs midnight to midnight UTC.
 */
export async function myWeek(actor: Actor, weekStart: string, bounds?: { from?: string; to?: string }) {
  let start = new Date(`${weekStart.slice(0, 10)}T00:00:00.000Z`);
  let end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 7);
  const from = bounds?.from ? new Date(bounds.from) : null;
  const to = bounds?.to ? new Date(bounds.to) : null;
  const span = from && to ? to.getTime() - from.getTime() : NaN;
  // A week across a DST change is 167–169 hours; anything else is not a week.
  if (Number.isFinite(span) && span > 0 && span <= 8 * 86_400_000) { start = from!; end = to!; }
  const rows = (await selectEntries().where(and(
    eq(te.userId, actor.userId),
    gte(te.startedAt, start),
    lt(te.startedAt, end),
    isNull(schema.projects.deletedAt),
  )).orderBy(te.startedAt, te.id)).map(withRef);

  const byDay = new Map<string, { date: string; totalSeconds: number; billableSeconds: number; entries: any[] }>();
  for (const e of rows) {
    const day = e.startedAt.toISOString().slice(0, 10);
    let bucket = byDay.get(day);
    if (!bucket) { bucket = { date: day, totalSeconds: 0, billableSeconds: 0, entries: [] }; byDay.set(day, bucket); }
    bucket.totalSeconds += e.durationSeconds;
    if (e.billable) bucket.billableSeconds += e.durationSeconds;
    bucket.entries.push(e);
  }
  return { weekStart: weekStart.slice(0, 10), days: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
