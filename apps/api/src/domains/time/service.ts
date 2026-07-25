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
import { assertProject } from '../../core/access';

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
  const [entry] = await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.id, id));
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

export interface EntryFilters {
  from?: string;
  to?: string;
  projectId?: string;
  userId?: string;
  taskId?: string;
  limit: number;
}

export async function listEntries(actor: Actor, filters: EntryFilters, canReadAll: boolean) {
  const { db } = getDb();
  const scopedUserId = canReadAll ? filters.userId : actor.userId;
  const to = upperBound(filters.to);
  const rows = await db.select().from(schema.timeEntries).where(and(
    scopedUserId ? eq(schema.timeEntries.userId, scopedUserId) : undefined,
    filters.projectId ? eq(schema.timeEntries.projectId, filters.projectId) : undefined,
    filters.taskId ? eq(schema.timeEntries.taskId, filters.taskId) : undefined,
    filters.from ? gte(schema.timeEntries.startedAt, new Date(filters.from)) : undefined,
    to ? lte(schema.timeEntries.startedAt, new Date(to)) : undefined,
  )).orderBy(desc(schema.timeEntries.startedAt)).limit(filters.limit + 1);
  return rows;
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
    .from(schema.projects).where(eq(schema.projects.id, task.projectId));
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
    .select({ number: schema.tasks.number, title: schema.tasks.title, key: schema.projects.key })
    .from(schema.tasks)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.tasks.projectId))
    .where(eq(schema.tasks.id, timer.taskId));
  return {
    ...timer,
    elapsedSeconds,
    ref: task ? `${task.key}-${task.number}` : null,
    title: task?.title ?? null,
  };
}

// ── Rates ──

export async function listRates(projectId: string) {
  const { db } = getDb();
  return db.select().from(schema.projectRates)
    .where(eq(schema.projectRates.projectId, projectId))
    .orderBy(desc(schema.projectRates.createdAt));
}

export async function upsertRate(actor: Actor, input: any): Promise<string> {
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

function whereFragments(f: { from?: string; to?: string; projectId?: string; billable: string }): SQL[] {
  const conds: SQL[] = [];
  if (f.from) conds.push(sql`te.started_at >= ${f.from}`);
  const to = upperBound(f.to);
  if (to) conds.push(sql`te.started_at <= ${to}`);
  if (f.projectId) conds.push(sql`te.project_id = ${f.projectId}`);
  if (f.billable === 'billable') conds.push(sql`te.billable = true`);
  if (f.billable === 'nonbillable') conds.push(sql`te.billable = false`);
  return conds;
}

export async function report(params: { from?: string; to?: string; groupBy: string; billable: string; projectId?: string }) {
  const { db } = getDb();
  const conds = whereFragments(params);
  const whereSql = conds.length ? sql`where ${sql.join(conds, sql` and `)}` : sql``;
  const wsCurrency = await workspaceDefaultCurrency(db);

  let rows: any[];
  if (params.groupBy === 'user') {
    rows = await db.execute(sql`
      select u.id as key, u.name as label, null::text as currency,
        coalesce(sum(te.duration_seconds),0) as secs,
        coalesce(sum(te.duration_seconds) filter (where te.billable),0) as billable_secs,
        coalesce(sum((te.duration_seconds/3600.0) * te.hourly_rate),0) as amount
      from time_entries te
      join users u on u.id = te.user_id
      ${whereSql}
      group by u.id, u.name
      order by amount desc`) as any[];
  } else if (params.groupBy === 'company') {
    rows = await db.execute(sql`
      select coalesce(c.id, 'internal') as key, coalesce(c.name, '(internal)') as label,
        coalesce(c.default_currency, ${wsCurrency}) as currency,
        coalesce(sum(te.duration_seconds),0) as secs,
        coalesce(sum(te.duration_seconds) filter (where te.billable),0) as billable_secs,
        coalesce(sum((te.duration_seconds/3600.0) * te.hourly_rate),0) as amount
      from time_entries te
      join projects p on p.id = te.project_id
      left join companies c on c.id = p.company_id
      ${whereSql}
      group by c.id, c.name, c.default_currency
      order by amount desc`) as any[];
  } else {
    rows = await db.execute(sql`
      select p.id as key, p.name as label,
        coalesce(c.default_currency, ${wsCurrency}) as currency,
        coalesce(sum(te.duration_seconds),0) as secs,
        coalesce(sum(te.duration_seconds) filter (where te.billable),0) as billable_secs,
        coalesce(sum((te.duration_seconds/3600.0) * te.hourly_rate),0) as amount
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
    hours: round2(Number(r.secs) / 3600),
    billableHours: round2(Number(r.billable_secs) / 3600),
    amount: round2(Number(r.amount)),
    currency: r.currency ?? wsCurrency,
  }));
}

export async function unbilled(params: { companyId?: string; from?: string; to?: string }) {
  const { db } = getDb();
  const conds: SQL[] = [sql`te.billable = true`, sql`te.invoice_item_id is null`];
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

export async function myWeek(actor: Actor, weekStart: string) {
  const { db } = getDb();
  const start = new Date(`${weekStart.slice(0, 10)}T00:00:00.000Z`);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 7);
  const rows = await db.select().from(schema.timeEntries).where(and(
    eq(schema.timeEntries.userId, actor.userId),
    gte(schema.timeEntries.startedAt, start),
    lt(schema.timeEntries.startedAt, end),
  )).orderBy(schema.timeEntries.startedAt);

  const byDay = new Map<string, { date: string; totalSeconds: number; billableSeconds: number; entries: any[] }>();
  for (const e of rows) {
    const day = e.startedAt.toISOString().slice(0, 10);
    let bucket = byDay.get(day);
    if (!bucket) { bucket = { date: day, totalSeconds: 0, billableSeconds: 0, entries: [] }; byDay.set(day, bucket); }
    bucket.totalSeconds += e.durationSeconds;
    if (e.billable) bucket.billableSeconds += e.durationSeconds;
    bucket.entries.push(e);
  }
  return { weekStart: start.toISOString().slice(0, 10), days: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
