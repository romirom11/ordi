/**
 * People (HR) domain service (PRD §12). Employees & lifecycle, leaves,
 * recruitment, resourcing, compensation. Sensitivity rules (§12.8) are enforced
 * here: persona/emergency fields, compensation and salary ranges are stripped or
 * audited on read. Leave math comes from @ordi/shared pure calc (never re-implemented).
 */
import { getDb, schema, eq, and, isNull, inArray, desc, asc, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { leaveDays, availableBalance, carryForward, rangesOverlap, LEAVE_TRANSITIONS } from '@ordi/shared';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { writeActivity, recordSensitiveAccess } from '../../core/activity';
import { emit } from '../../core/events';
import { assertVersion } from '../../core/locking';
import { employeeFieldAccess, loadFieldGroups, selfGrantLevels, stripGroupedValues } from '../../core/fieldgroups';
import { mergeCustomFields } from '../../core/customfields';

// ─── sensitivity helpers (PRD §12.8) ───
function canSensitive(actor: Actor): boolean {
  return actor.access.permissions.has('people.read_sensitive');
}

/** Strip persona/emergency fields from an employee unless actor has people.read_sensitive. */
function stripEmployee(actor: Actor, e: any): any {
  if (!e || canSensitive(actor)) return e;
  const { sensitive, emergencyContact, ...rest } = e;
  return rest;
}

/** Definitions of the employees custom fields (full rows, deprecated included). */
async function employeeFieldDefs() {
  const { db } = getDb();
  return db.select().from(schema.customFieldDefinitions)
    .where(eq(schema.customFieldDefinitions.entityType, 'employees'))
    .orderBy(asc(schema.customFieldDefinitions.position), asc(schema.customFieldDefinitions.key));
}

/** Apply field-group visibility to one employee row's customFields. */
async function stripFieldGroups(actor: Actor, e: any): Promise<any> {
  if (!e) return e;
  const access = await employeeFieldAccess(actor, e);
  if (access.full) return e;
  const defs = await employeeFieldDefs();
  return { ...e, customFields: stripGroupedValues(e.customFields, defs, access) };
}

/** Strip a job opening's salaryRange unless actor has people.read_sensitive. */
function stripOpening(actor: Actor, o: any): any {
  if (!o || canSensitive(actor)) return o;
  const { salaryRange, ...rest } = o;
  return rest;
}

// ─── employees (PRD §12.1) ───
export async function listEmployees(actor: Actor, params: { status?: string; departmentId?: string; q?: string }) {
  const { db } = getDb();
  const rows = await db.select().from(schema.employees).where(and(
    isNull(schema.employees.deletedAt),
    params.status ? eq(schema.employees.status, params.status) : undefined,
    params.departmentId ? eq(schema.employees.departmentId, params.departmentId) : undefined,
    params.q ? sql`(${schema.employees.firstName} || ' ' || ${schema.employees.lastName}) ilike ${'%' + params.q + '%'}` : undefined,
  )).orderBy(asc(schema.employees.firstName));
  const stripped = await Promise.all(rows.map((r) => stripFieldGroups(actor, r)));
  return stripped.map((r) => stripEmployee(actor, r));
}

async function loadEmployee(id: string) {
  const { db } = getDb();
  const [e] = await db.select().from(schema.employees)
    .where(and(eq(schema.employees.id, id), isNull(schema.employees.deletedAt)));
  if (!e) throw err.notFound('Employee not found');
  return e;
}

export async function getEmployee(actor: Actor, id: string) {
  const { db } = getDb();
  const e = await loadEmployee(id);
  const access = await employeeFieldAccess(actor, e);
  const stripped = stripEmployee(actor, await stripFieldGroups(actor, e));
  let user: { id: string; name: string; email: string; avatar: string | null; isActive: boolean } | null = null;
  if (e.userId) {
    const [u] = await db.select({
      id: schema.users.id, name: schema.users.name, email: schema.users.email,
      avatar: schema.users.avatar, isActive: schema.users.isActive,
    }).from(schema.users).where(eq(schema.users.id, e.userId));
    if (u) user = u;
  }
  // groupId → read|write for THIS viewer on THIS record; the card renders from it.
  return { ...stripped, user, fieldAccess: Object.fromEntries(access.levels) };
}

/**
 * People directory (PRD §12): a unified list of workspace people. Rows are driven
 * by user accounts (actor_type='user'), each joined to an employee profile by
 * userId link or, failing that, by email match. Standalone employee profiles with
 * no matching user are appended. Compensation is NOT included here.
 */
export async function peopleDirectory() {
  const { db } = getDb();
  const users = await db.select().from(schema.users).where(eq(schema.users.actorType, 'user'));
  const emps = await db.select({
    id: schema.employees.id,
    userId: schema.employees.userId,
    firstName: schema.employees.firstName,
    lastName: schema.employees.lastName,
    email: schema.employees.email,
    status: schema.employees.status,
    positionTitle: schema.positions.title,
    departmentName: schema.departments.name,
  }).from(schema.employees)
    .leftJoin(schema.positions, eq(schema.positions.id, schema.employees.positionId))
    .leftJoin(schema.departments, eq(schema.departments.id, schema.employees.departmentId))
    .where(isNull(schema.employees.deletedAt));

  type Emp = (typeof emps)[number];
  const byUserId = new Map<string, Emp>();
  const byEmail = new Map<string, Emp>();
  for (const e of emps) {
    if (e.userId) byUserId.set(e.userId, e);
    if (e.email) byEmail.set(e.email.toLowerCase(), e);
  }

  const usedEmpIds = new Set<string>();
  const rows: Array<{
    userId: string | null; employeeId: string | null; name: string; email: string | null;
    avatar: string | null; position: string | null; departmentName: string | null;
    status: 'active' | 'deactivated'; hasEmployeeProfile: boolean;
  }> = [];

  for (const u of users) {
    const emp = byUserId.get(u.id) ?? (u.email ? byEmail.get(u.email.toLowerCase()) : undefined);
    if (emp) usedEmpIds.add(emp.id);
    rows.push({
      userId: u.id,
      employeeId: emp?.id ?? null,
      name: u.name,
      email: u.email,
      avatar: u.avatar ?? null,
      position: emp?.positionTitle ?? null,
      departmentName: emp?.departmentName ?? null,
      status: u.isActive ? 'active' : 'deactivated',
      hasEmployeeProfile: Boolean(emp),
    });
  }

  for (const e of emps) {
    if (usedEmpIds.has(e.id)) continue;
    rows.push({
      userId: e.userId ?? null,
      employeeId: e.id,
      name: `${e.firstName} ${e.lastName}`.trim(),
      email: e.email ?? null,
      avatar: null,
      position: e.positionTitle ?? null,
      departmentName: e.departmentName ?? null,
      status: e.status === 'terminated' ? 'deactivated' : 'active',
      hasEmployeeProfile: true,
    });
  }

  return rows;
}

export async function createEmployee(actor: Actor, input: any): Promise<string> {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.employees).values({
    id,
    userId: input.userId ?? null,
    firstName: input.firstName,
    lastName: input.lastName ?? '',
    email: input.email ?? null,
    phone: input.phone ?? null,
    positionId: input.positionId ?? null,
    departmentId: input.departmentId ?? null,
    employmentType: input.employmentType ?? 'full_time',
    managerId: input.managerId ?? null,
    birthday: input.birthday ?? null,
    joinDate: input.joinDate ?? null,
    probationEnd: input.probationEnd ?? null,
    status: input.status ?? 'active',
    emergencyContact: input.emergencyContact ?? null,
    sensitive: input.sensitive ?? null,
    customFields: input.customFields ?? {},
    createdBy: actor.userId,
  });
  await writeActivity(db, { entityType: 'employee', entityId: id, action: 'created', after: input, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

export async function updateEmployee(actor: Actor, id: string, input: any) {
  const { db } = getDb();
  const before = await loadEmployee(id);
  assertVersion(before, input.version, stripEmployee(actor, before));
  const patch: Record<string, unknown> = {};
  for (const k of ['userId', 'firstName', 'lastName', 'email', 'phone', 'positionId', 'departmentId',
    'employmentType', 'managerId', 'birthday', 'joinDate', 'probationEnd', 'status', 'emergencyContact', 'sensitive', 'customFields']) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  await db.update(schema.employees).set(patch)
    .where(and(eq(schema.employees.id, id), eq(schema.employees.version, before.version)));
  await writeActivity(db, { entityType: 'employee', entityId: id, action: 'updated', before, after: patch, actorId: actor.userId, actorType: actor.actorType });
  return stripEmployee(actor, await loadEmployee(id));
}

export async function softDeleteEmployee(actor: Actor, id: string) {
  const { db } = getDb();
  await loadEmployee(id);
  await db.update(schema.employees).set({ deletedAt: new Date() }).where(eq(schema.employees.id, id));
  await writeActivity(db, { entityType: 'employee', entityId: id, action: 'deleted', actorId: actor.userId, actorType: actor.actorType });
}

/** Lifecycle transitions with events (PRD §12.1). */
export async function employeeLifecycle(actor: Actor, id: string, input: { action: string; exitDate?: string | null }) {
  const { db } = getDb();
  const before = await loadEmployee(id);
  const patch: Record<string, unknown> = {};
  switch (input.action) {
    case 'onboard':
      patch.status = 'active';
      break;
    case 'exit':
      patch.status = 'terminated';
      patch.exitDate = input.exitDate ?? new Date().toISOString().slice(0, 10);
      break;
    case 'set_leave':
      patch.status = 'on_leave';
      break;
    case 'reactivate':
      patch.status = 'active';
      break;
    default:
      throw err.validation('Unknown lifecycle action');
  }
  await db.update(schema.employees).set(patch).where(eq(schema.employees.id, id));
  await writeActivity(db, { entityType: 'employee', entityId: id, action: `lifecycle_${input.action}`, before: { status: before.status }, after: patch, actorId: actor.userId, actorType: actor.actorType });

  if (input.action === 'onboard') {
    // payload can trigger the onboarding checklist consumer (Projects, via bus). No cross-domain write here.
    await emit({ type: 'employee.onboarded', aggregateType: 'employee', aggregateId: id, payload: { employeeId: id, userId: before.userId, runOnboarding: true }, actorId: actor.userId, actorType: actor.actorType });
  } else if (input.action === 'exit') {
    await emit({ type: 'employee.exited', aggregateType: 'employee', aggregateId: id, payload: { employeeId: id, userId: before.userId, exitDate: patch.exitDate }, actorId: actor.userId, actorType: actor.actorType });
  }
  return stripEmployee(actor, await loadEmployee(id));
}

// ─── employee documents (PRD §12.1) ───
export async function listEmployeeDocuments(employeeId: string) {
  const { db } = getDb();
  await loadEmployee(employeeId);
  return db.select().from(schema.employeeDocuments)
    .where(eq(schema.employeeDocuments.employeeId, employeeId))
    .orderBy(desc(schema.employeeDocuments.createdAt));
}

export async function addEmployeeDocument(actor: Actor, employeeId: string, input: { attachmentId: string; type?: string }): Promise<string> {
  const { db } = getDb();
  await loadEmployee(employeeId);
  const id = ulid();
  await db.insert(schema.employeeDocuments).values({
    id, employeeId, attachmentId: input.attachmentId, type: input.type ?? 'other',
  });
  await writeActivity(db, { entityType: 'employee', entityId: employeeId, action: 'document_added', after: { attachmentId: input.attachmentId, type: input.type ?? 'other' }, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

export async function deleteEmployeeDocument(actor: Actor, id: string) {
  const { db } = getDb();
  const [doc] = await db.select().from(schema.employeeDocuments).where(eq(schema.employeeDocuments.id, id));
  if (!doc) throw err.notFound('Document not found');
  await db.delete(schema.employeeDocuments).where(eq(schema.employeeDocuments.id, id));
  await writeActivity(db, { entityType: 'employee', entityId: doc.employeeId, action: 'document_removed', actorId: actor.userId, actorType: actor.actorType });
}

// ─── departments & positions (PRD §12.1) ───
export async function listDepartments() {
  const { db } = getDb();
  return db.select().from(schema.departments).orderBy(asc(schema.departments.name));
}

export async function createDepartment(input: any): Promise<string> {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.departments).values({ id, name: input.name, parentId: input.parentId ?? null });
  return id;
}

export async function updateDepartment(id: string, input: any) {
  const { db } = getDb();
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.parentId !== undefined) patch.parentId = input.parentId;
  await db.update(schema.departments).set(patch).where(eq(schema.departments.id, id));
}

export async function deleteDepartment(id: string) {
  const { db } = getDb();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.employees).where(eq(schema.employees.departmentId, id)) as any[];
  if (Number(n) > 0) throw err.domain('Department has employees; reassign them first');
  await db.delete(schema.departments).where(eq(schema.departments.id, id));
}

export async function listPositions() {
  const { db } = getDb();
  return db.select().from(schema.positions).orderBy(asc(schema.positions.title));
}

export async function createPosition(input: any): Promise<string> {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.positions).values({ id, title: input.title });
  return id;
}

export async function updatePosition(id: string, input: any) {
  const { db } = getDb();
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (Object.keys(patch).length === 0) return;
  await db.update(schema.positions).set(patch).where(eq(schema.positions.id, id));
}

export async function deletePosition(id: string) {
  const { db } = getDb();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.employees).where(eq(schema.employees.positionId, id)) as any[];
  if (Number(n) > 0) throw err.domain('Position is in use; reassign employees first');
  await db.delete(schema.positions).where(eq(schema.positions.id, id));
}

// ─── leave types (PRD §12.2) ───
export async function listLeaveTypes() {
  const { db } = getDb();
  return db.select().from(schema.leaveTypes).orderBy(asc(schema.leaveTypes.name));
}

export async function createLeaveType(input: any): Promise<string> {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.leaveTypes).values({
    id, name: input.name, isPaid: input.isPaid, needsApproval: input.needsApproval,
    affectsBalance: input.affectsBalance, allowHalfDay: input.allowHalfDay,
    annualQuota: String(input.annualQuota), carryForwardLimit: String(input.carryForwardLimit),
    carryForwardExpiry: input.carryForwardExpiry ?? null,
  });
  return id;
}

export async function updateLeaveType(id: string, input: any) {
  const { db } = getDb();
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'isPaid', 'needsApproval', 'affectsBalance', 'allowHalfDay', 'carryForwardExpiry']) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  if (input.annualQuota !== undefined) patch.annualQuota = String(input.annualQuota);
  if (input.carryForwardLimit !== undefined) patch.carryForwardLimit = String(input.carryForwardLimit);
  await db.update(schema.leaveTypes).set(patch).where(eq(schema.leaveTypes.id, id));
}

export async function deleteLeaveType(id: string) {
  const { db } = getDb();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.leaveRequests).where(eq(schema.leaveRequests.leaveTypeId, id)) as any[];
  if (Number(n) > 0) throw err.domain('Leave type has requests; cannot delete');
  await db.delete(schema.leaveTypes).where(eq(schema.leaveTypes.id, id));
}

// ─── leave balances (PRD §12.2) ───
export async function listLeaveBalances(employeeId?: string) {
  const { db } = getDb();
  return db.select().from(schema.leaveBalances).where(
    employeeId ? eq(schema.leaveBalances.employeeId, employeeId) : undefined,
  ).orderBy(desc(schema.leaveBalances.period));
}

/**
 * Accrue an annual quota for a period, per employee/type (PRD §12.2). Optionally
 * scope to a single employee and/or type. Carry-forward from the prior period is
 * applied with the type's cap via the pure `carryForward`/`availableBalance` calc.
 */
export async function accrueLeave(actor: Actor, input: { period: string; employeeId?: string; leaveTypeId?: string }) {
  const { db } = getDb();
  if (!input.period) throw err.validation('period is required');
  const prevPeriod = String(Number(input.period) - 1);

  const employees = input.employeeId
    ? await db.select().from(schema.employees).where(and(eq(schema.employees.id, input.employeeId), isNull(schema.employees.deletedAt)))
    : await db.select().from(schema.employees).where(and(isNull(schema.employees.deletedAt), eq(schema.employees.status, 'active')));
  const types = input.leaveTypeId
    ? await db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.id, input.leaveTypeId))
    : await db.select().from(schema.leaveTypes);

  let count = 0;
  for (const emp of employees) {
    for (const t of types) {
      const [prev] = await db.select().from(schema.leaveBalances).where(and(
        eq(schema.leaveBalances.employeeId, emp.id),
        eq(schema.leaveBalances.leaveTypeId, t.id),
        eq(schema.leaveBalances.period, prevPeriod),
      ));
      const carried = prev
        ? carryForward(availableBalance({ allocated: Number(prev.allocated), used: Number(prev.used), carried: Number(prev.carried) }), Number(t.carryForwardLimit))
        : 0;
      const [existing] = await db.select().from(schema.leaveBalances).where(and(
        eq(schema.leaveBalances.employeeId, emp.id),
        eq(schema.leaveBalances.leaveTypeId, t.id),
        eq(schema.leaveBalances.period, input.period),
      ));
      if (existing) {
        await db.update(schema.leaveBalances)
          .set({ allocated: String(t.annualQuota), carried: String(carried) })
          .where(eq(schema.leaveBalances.id, existing.id));
      } else {
        await db.insert(schema.leaveBalances).values({
          id: ulid(), employeeId: emp.id, leaveTypeId: t.id, period: input.period,
          allocated: String(t.annualQuota), used: '0', carried: String(carried),
        });
      }
      count += 1;
    }
  }
  await writeActivity(db, { entityType: 'leave_balance', entityId: input.period, action: 'accrued', after: { period: input.period, count }, actorId: actor.userId, actorType: actor.actorType });
  return { period: input.period, accrued: count };
}

// ─── leave requests (PRD §12.2) ───
async function managerUserId(managerEmployeeId: string | null): Promise<string | null> {
  if (!managerEmployeeId) return null;
  const { db } = getDb();
  const [m] = await db.select({ userId: schema.employees.userId }).from(schema.employees).where(eq(schema.employees.id, managerEmployeeId));
  return m?.userId ?? null;
}

async function findApproverFallback(): Promise<string | null> {
  const { db } = getDb();
  const rows = await db.select({ userId: schema.users.id })
    .from(schema.users)
    .innerJoin(schema.rolePermissions, eq(schema.rolePermissions.roleId, schema.users.roleId))
    .where(and(eq(schema.rolePermissions.permission, 'people.approve_leave'), eq(schema.users.isActive, true)))
    .limit(1);
  return rows[0]?.userId ?? null;
}

/**
 * Requests carry the two names they are read by – whose leave and which type.
 * Without the joins the list rendered "–" for both, so a queue of pending
 * requests said nothing about who was asking for what.
 */
export async function listLeaveRequests(params: { employeeId?: string; status?: string }) {
  const { db } = getDb();
  return db.select({
    id: schema.leaveRequests.id,
    employeeId: schema.leaveRequests.employeeId,
    leaveTypeId: schema.leaveRequests.leaveTypeId,
    fromDate: schema.leaveRequests.fromDate,
    toDate: schema.leaveRequests.toDate,
    halfDay: schema.leaveRequests.halfDay,
    reason: schema.leaveRequests.reason,
    status: schema.leaveRequests.status,
    approverId: schema.leaveRequests.approverId,
    decidedAt: schema.leaveRequests.decidedAt,
    decisionComment: schema.leaveRequests.decisionComment,
    createdAt: schema.leaveRequests.createdAt,
    employeeName: sql<string>`btrim(coalesce(${schema.employees.firstName}, '') || ' ' || coalesce(${schema.employees.lastName}, ''))`,
    leaveTypeName: schema.leaveTypes.name,
  }).from(schema.leaveRequests)
    .leftJoin(schema.employees, eq(schema.employees.id, schema.leaveRequests.employeeId))
    .leftJoin(schema.leaveTypes, eq(schema.leaveTypes.id, schema.leaveRequests.leaveTypeId))
    .where(and(
      params.employeeId ? eq(schema.leaveRequests.employeeId, params.employeeId) : undefined,
      params.status ? eq(schema.leaveRequests.status, params.status) : undefined,
    )).orderBy(desc(schema.leaveRequests.fromDate));
}

/**
 * The employee card behind a user account, if there is one. Contractors and
 * staff without a login exist as employees with no user, and users without an
 * employee card exist too – so self-service asks, it does not assume.
 */
export async function employeeOfUser(userId: string) {
  const { db } = getDb();
  const [e] = await db.select().from(schema.employees)
    .where(and(eq(schema.employees.userId, userId), isNull(schema.employees.deletedAt)));
  return e ?? null;
}

// ─── HR questionnaire: self-service field groups (PRD §5.5 extension) ───

/**
 * The groups the person may fill in about themselves, with definitions and
 * their current values. Access here is by the 'self' principal only – an HR
 * role's broad access does not turn every group into their questionnaire.
 */
export async function myHrFields(actor: Actor) {
  const emp = await employeeOfUser(actor.userId);
  if (!emp) return { linked: false as const, updatedAt: null, groups: [] };
  const selfLevels = await selfGrantLevels();
  const { groups } = await loadFieldGroups();
  const defs = await employeeFieldDefs();
  const cf = (emp.customFields && typeof emp.customFields === 'object' ? emp.customFields : {}) as Record<string, unknown>;
  const out = groups
    .filter((g) => g.entityType === 'employees' && selfLevels.has(g.id))
    .map((g) => ({
      id: g.id,
      name: g.name,
      level: selfLevels.get(g.id)!,
      fields: defs
        .filter((d) => d.groupId === g.id && !d.deprecated)
        .map((d) => ({
          id: d.id, key: d.key, label: d.label, type: d.type,
          options: d.options, required: d.required,
          value: cf[d.key] ?? null,
        })),
    }))
    .filter((g) => g.fields.length > 0);
  return { linked: true as const, updatedAt: emp.questionnaireUpdatedAt, groups: out };
}

/** Save the person's own answers – only keys of self-writable groups pass. */
export async function updateMyHrFields(actor: Actor, input: { customFields: Record<string, unknown> }) {
  const { db } = getDb();
  const emp = await employeeOfUser(actor.userId);
  if (!emp) throw err.domain('Your account is not linked to an employee record – ask HR to link it.');
  const selfLevels = await selfGrantLevels();
  const defs = await employeeFieldDefs();
  const writable = new Set(
    defs.filter((d) => d.groupId && selfLevels.get(d.groupId) === 'write' && !d.deprecated).map((d) => d.key),
  );
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.customFields ?? {})) {
    if (!writable.has(key)) throw err.forbidden(`Field '${key}' is not self-editable`);
    patch[key] = value;
  }
  if (Object.keys(patch).length) {
    await db.update(schema.employees).set({
      customFields: mergeCustomFields(emp.customFields, patch),
      questionnaireUpdatedAt: new Date(),
    }).where(eq(schema.employees.id, emp.id));
    await writeActivity(db, {
      entityType: 'employee', entityId: emp.id, action: 'questionnaire_updated',
      after: { keys: Object.keys(patch) },
      actorId: actor.userId, actorType: actor.actorType,
    });
  }
  return myHrFields(actor);
}

export async function createLeaveRequest(actor: Actor, input: any) {
  const { db } = getDb();
  // Requesting your own leave is the common case (PRD §12.2), so employeeId is
  // optional: without it the request is for whoever is asking. It used to be
  // required and the leave form never sent one, which failed every submission
  // as "employeeId: Required".
  const employee = input.employeeId
    ? await loadEmployee(input.employeeId)
    : await employeeOfUser(actor.userId);
  if (!employee) {
    throw err.domain('Your account is not linked to an employee record – ask HR to link it, or name the employee explicitly.');
  }

  // An employee may request for themselves; broader HR roles may request for anyone.
  const canForOthers = actor.access.permissions.has('people.write')
    || actor.access.permissions.has('people.manage_leave')
    || actor.access.permissions.has('people.approve_leave');
  if (!canForOthers && employee.userId !== actor.userId) {
    throw err.forbidden('Cannot request leave for another employee', 'people.write');
  }

  // Conflict: overlap with existing pending/approved requests for the same employee.
  const existing = await db.select().from(schema.leaveRequests).where(and(
    eq(schema.leaveRequests.employeeId, employee.id),
    inArray(schema.leaveRequests.status, ['pending', 'approved']),
  ));
  for (const r of existing) {
    if (rangesOverlap(input.fromDate, input.toDate, r.fromDate, r.toDate)) {
      throw err.domain('Leave request overlaps an existing request', { conflictId: r.id });
    }
  }

  const days = leaveDays(input.fromDate, input.toDate, input.halfDay ?? false);
  const approverId = (await managerUserId(employee.managerId)) ?? (await findApproverFallback());

  const id = ulid();
  await db.insert(schema.leaveRequests).values({
    id, employeeId: employee.id, leaveTypeId: input.leaveTypeId,
    fromDate: input.fromDate, toDate: input.toDate, halfDay: input.halfDay ?? false,
    reason: input.reason ?? '', attachmentId: input.attachmentId ?? null,
    status: 'pending', approverId: approverId ?? null, createdBy: actor.userId,
  });
  await writeActivity(db, { entityType: 'leave_request', entityId: id, action: 'requested', after: { ...input, days }, actorId: actor.userId, actorType: actor.actorType });
  await emit({ type: 'leave.requested', aggregateType: 'leave_request', aggregateId: id, payload: { approverId, employeeUserId: employee.userId, days }, actorId: actor.userId, actorType: actor.actorType });
  // employeeId back in the response: the caller may not have named one, and a
  // client that just filed a request should not have to guess who it is for.
  return { id, employeeId: employee.id, days, approverId };
}

async function adjustBalanceUsed(employeeId: string, leaveTypeId: string, period: string, delta: number) {
  const { db } = getDb();
  const [bal] = await db.select().from(schema.leaveBalances).where(and(
    eq(schema.leaveBalances.employeeId, employeeId),
    eq(schema.leaveBalances.leaveTypeId, leaveTypeId),
    eq(schema.leaveBalances.period, period),
  ));
  if (bal) {
    const next = Math.max(0, Number(bal.used) + delta);
    await db.update(schema.leaveBalances).set({ used: String(next) }).where(eq(schema.leaveBalances.id, bal.id));
  } else if (delta !== 0) {
    const [t] = await db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.id, leaveTypeId));
    await db.insert(schema.leaveBalances).values({
      id: ulid(), employeeId, leaveTypeId, period,
      allocated: String(t?.annualQuota ?? '0'), used: String(Math.max(0, delta)), carried: '0',
    });
  }
}

/** Approve / reject / cancel a leave request with transition + balance rules (PRD §12.2). */
export async function decideLeave(actor: Actor, id: string, newStatus: 'approved' | 'rejected' | 'canceled', comment: string) {
  const { db } = getDb();
  const [req] = await db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.id, id));
  if (!req) throw err.notFound('Leave request not found');

  const allowed = LEAVE_TRANSITIONS[req.status as keyof typeof LEAVE_TRANSITIONS] ?? [];
  if (!allowed.includes(newStatus)) throw err.domain(`Cannot transition leave from ${req.status} to ${newStatus}`);

  const employee = await loadEmployee(req.employeeId);
  const isApprover = actor.access.permissions.has('people.approve_leave');
  const isManager = (await managerUserId(employee.managerId)) === actor.userId;
  const isOwn = employee.userId === actor.userId;

  if (newStatus === 'canceled') {
    if (!(isApprover || isManager || isOwn)) throw err.forbidden('Cannot cancel this leave request', 'people.approve_leave');
  } else {
    if (!(isApprover || isManager)) throw err.forbidden('Only the manager or an approver can decide leave', 'people.approve_leave');
  }

  const [type] = await db.select().from(schema.leaveTypes).where(eq(schema.leaveTypes.id, req.leaveTypeId));
  const days = leaveDays(req.fromDate, req.toDate, req.halfDay);
  const period = req.fromDate.slice(0, 4);
  if (type?.affectsBalance) {
    if (req.status === 'pending' && newStatus === 'approved') await adjustBalanceUsed(req.employeeId, req.leaveTypeId, period, days);
    else if (req.status === 'approved' && newStatus === 'canceled') await adjustBalanceUsed(req.employeeId, req.leaveTypeId, period, -days);
  }

  await db.update(schema.leaveRequests).set({
    status: newStatus, approverId: actor.userId, decidedAt: new Date(), decisionComment: comment,
  }).where(eq(schema.leaveRequests.id, id));

  await writeActivity(db, { entityType: 'leave_request', entityId: id, action: newStatus, before: { status: req.status }, after: { status: newStatus, comment }, actorId: actor.userId, actorType: actor.actorType });
  await emit({ type: 'leave.decided', aggregateType: 'leave_request', aggregateId: id, payload: { decision: newStatus, employeeUserId: employee.userId }, actorId: actor.userId, actorType: actor.actorType });
  const [updated] = await db.select().from(schema.leaveRequests).where(eq(schema.leaveRequests.id, id));
  return updated;
}

// ─── holiday calendars (PRD §12.2) ───
export async function listHolidayCalendars() {
  const { db } = getDb();
  return db.select().from(schema.holidayCalendars).orderBy(asc(schema.holidayCalendars.name));
}

export async function createHolidayCalendar(input: any): Promise<string> {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.holidayCalendars).values({ id, name: input.name });
  return id;
}

export async function deleteHolidayCalendar(id: string) {
  const { db } = getDb();
  await db.delete(schema.holidayCalendars).where(eq(schema.holidayCalendars.id, id));
}

export async function listHolidays(calendarId?: string) {
  const { db } = getDb();
  return db.select().from(schema.holidays).where(
    calendarId ? eq(schema.holidays.calendarId, calendarId) : undefined,
  ).orderBy(asc(schema.holidays.date));
}

export async function createHoliday(input: any): Promise<string> {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.holidays).values({ id, calendarId: input.calendarId, date: input.date, name: input.name });
  return id;
}

export async function deleteHoliday(id: string) {
  const { db } = getDb();
  await db.delete(schema.holidays).where(eq(schema.holidays.id, id));
}

export async function assignHolidayCalendar(actor: Actor, employeeId: string, calendarId: string) {
  const { db } = getDb();
  await loadEmployee(employeeId);
  await db.insert(schema.employeeHolidayCalendar).values({ employeeId, calendarId }).onConflictDoNothing();
  await writeActivity(db, { entityType: 'employee', entityId: employeeId, action: 'calendar_assigned', after: { calendarId }, actorId: actor.userId, actorType: actor.actorType });
}

// ─── recruitment: applicant stages (PRD §12.3) ───
export async function listApplicantStages() {
  const { db } = getDb();
  return db.select().from(schema.applicantStages).orderBy(asc(schema.applicantStages.position));
}

export async function createApplicantStage(input: any): Promise<string> {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.applicantStages).values({
    id, name: input.name, position: input.position ?? 0, isHired: input.isHired ?? false, isRejected: input.isRejected ?? false,
  });
  return id;
}

export async function updateApplicantStage(id: string, input: any) {
  const { db } = getDb();
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'position', 'isHired', 'isRejected']) if (input[k] !== undefined) patch[k] = input[k];
  await db.update(schema.applicantStages).set(patch).where(eq(schema.applicantStages.id, id));
}

export async function deleteApplicantStage(id: string) {
  const { db } = getDb();
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.applicants).where(eq(schema.applicants.stageId, id)) as any[];
  if (Number(n) > 0) throw err.domain('Stage has applicants; move them first');
  await db.delete(schema.applicantStages).where(eq(schema.applicantStages.id, id));
}

// ─── recruitment: job openings (PRD §12.3) ───
export async function listJobOpenings(actor: Actor, status?: string) {
  const { db } = getDb();
  const rows = await db.select().from(schema.jobOpenings).where(and(
    isNull(schema.jobOpenings.deletedAt),
    status ? eq(schema.jobOpenings.status, status) : undefined,
  )).orderBy(desc(schema.jobOpenings.createdAt));
  return rows.map((r) => stripOpening(actor, r));
}

async function loadJobOpening(id: string) {
  const { db } = getDb();
  const [o] = await db.select().from(schema.jobOpenings).where(and(eq(schema.jobOpenings.id, id), isNull(schema.jobOpenings.deletedAt)));
  if (!o) throw err.notFound('Job opening not found');
  return o;
}

export async function getJobOpening(actor: Actor, id: string) {
  return stripOpening(actor, await loadJobOpening(id));
}

export async function createJobOpening(actor: Actor, input: any): Promise<string> {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.jobOpenings).values({
    id, title: input.title, departmentId: input.departmentId ?? null,
    employmentType: input.employmentType ?? 'full_time', description: input.description ?? '',
    status: input.status ?? 'draft', positionsCount: input.positionsCount ?? 1,
    hiringManagerId: input.hiringManagerId ?? null, salaryRange: input.salaryRange ?? null,
    publicToken: ulid(), publicEnabled: input.publicEnabled ?? false, createdBy: actor.userId,
  });
  await writeActivity(db, { entityType: 'job_opening', entityId: id, action: 'created', after: input, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

export async function updateJobOpening(actor: Actor, id: string, input: any, version?: number) {
  const { db } = getDb();
  const before = await loadJobOpening(id);
  assertVersion(before, version, stripOpening(actor, before));
  const patch: Record<string, unknown> = {};
  for (const k of ['title', 'departmentId', 'employmentType', 'description', 'status', 'positionsCount', 'hiringManagerId', 'salaryRange', 'publicEnabled']) {
    if (input[k] !== undefined) patch[k] = input[k];
  }
  await db.update(schema.jobOpenings).set(patch).where(and(eq(schema.jobOpenings.id, id), eq(schema.jobOpenings.version, before.version)));
  await writeActivity(db, { entityType: 'job_opening', entityId: id, action: 'updated', before, after: patch, actorId: actor.userId, actorType: actor.actorType });
  return stripOpening(actor, await loadJobOpening(id));
}

export async function deleteJobOpening(actor: Actor, id: string) {
  const { db } = getDb();
  await loadJobOpening(id);
  await db.update(schema.jobOpenings).set({ deletedAt: new Date() }).where(eq(schema.jobOpenings.id, id));
  await writeActivity(db, { entityType: 'job_opening', entityId: id, action: 'deleted', actorId: actor.userId, actorType: actor.actorType });
}

// ─── recruitment: applicants (PRD §12.3) ───
export async function listApplicants(params: { jobOpeningId?: string; stageId?: string }) {
  const { db } = getDb();
  return db.select().from(schema.applicants).where(and(
    isNull(schema.applicants.deletedAt),
    params.jobOpeningId ? eq(schema.applicants.jobOpeningId, params.jobOpeningId) : undefined,
    params.stageId ? eq(schema.applicants.stageId, params.stageId) : undefined,
  )).orderBy(desc(schema.applicants.createdAt));
}

async function loadApplicant(id: string) {
  const { db } = getDb();
  const [a] = await db.select().from(schema.applicants).where(and(eq(schema.applicants.id, id), isNull(schema.applicants.deletedAt)));
  if (!a) throw err.notFound('Applicant not found');
  return a;
}

export async function getApplicant(id: string) {
  return loadApplicant(id);
}

export async function createApplicant(actor: Actor, input: any) {
  const { db } = getDb();
  let stageId = input.stageId;
  if (!stageId) {
    const [first] = await db.select().from(schema.applicantStages).orderBy(asc(schema.applicantStages.position)).limit(1);
    if (!first) throw err.domain('No applicant stages configured');
    stageId = first.id;
  }
  // Duplicate detection by email (warn, do not block).
  const [dup] = await db.select({ id: schema.applicants.id }).from(schema.applicants).where(and(
    isNull(schema.applicants.deletedAt), eq(schema.applicants.email, input.email),
  )).limit(1);

  const id = ulid();
  await db.insert(schema.applicants).values({
    id, jobOpeningId: input.jobOpeningId, name: input.name, email: input.email,
    phone: input.phone ?? null, resumeAttachmentId: input.resumeAttachmentId ?? null,
    coverText: input.coverText ?? '', stageId, source: 'manual', createdFrom: 'manual',
    customFields: input.customFields ?? {},
  });
  await writeActivity(db, { entityType: 'applicant', entityId: id, action: 'created', after: input, actorId: actor.userId, actorType: actor.actorType });
  return { id, duplicateWarning: dup ? { existingId: dup.id } : null };
}

export async function moveApplicant(actor: Actor, id: string, input: { stageId: string; rejectedReason?: string }) {
  const { db } = getDb();
  const applicant = await loadApplicant(id);
  const [stage] = await db.select().from(schema.applicantStages).where(eq(schema.applicantStages.id, input.stageId));
  if (!stage) throw err.validation('Unknown stage');
  if (stage.isRejected && !input.rejectedReason) throw err.domain('A rejection reason is required');
  await db.update(schema.applicants).set({
    stageId: input.stageId, rejectedReason: stage.isRejected ? input.rejectedReason ?? null : null,
  }).where(eq(schema.applicants.id, id));
  await writeActivity(db, { entityType: 'applicant', entityId: id, action: 'stage_changed', before: { stageId: applicant.stageId }, after: { stageId: input.stageId }, actorId: actor.userId, actorType: actor.actorType });
  return loadApplicant(id);
}

/** Hire an applicant: create an employee from their data, mark hired, emit events (PRD §12.3). */
export async function hireApplicant(actor: Actor, id: string, input: any) {
  const { db } = getDb();
  const applicant = await loadApplicant(id);
  const parts = applicant.name.trim().split(/\s+/);
  const firstName = parts[0] ?? applicant.name;
  const lastName = parts.slice(1).join(' ');

  const employeeId = ulid();
  await db.insert(schema.employees).values({
    id: employeeId, firstName, lastName, email: applicant.email, phone: applicant.phone ?? null,
    positionId: input.positionId ?? null, departmentId: input.departmentId ?? null,
    joinDate: input.joinDate ?? null, status: 'active', createdBy: actor.userId,
  });

  const [hiredStage] = await db.select().from(schema.applicantStages).where(eq(schema.applicantStages.isHired, true)).orderBy(asc(schema.applicantStages.position)).limit(1);
  await db.update(schema.applicants).set({
    hiredEmployeeId: employeeId, ...(hiredStage ? { stageId: hiredStage.id } : {}),
  }).where(eq(schema.applicants.id, id));

  await writeActivity(db, { entityType: 'employee', entityId: employeeId, action: 'created_from_applicant', after: { applicantId: id }, actorId: actor.userId, actorType: actor.actorType });
  await writeActivity(db, { entityType: 'applicant', entityId: id, action: 'hired', after: { employeeId }, actorId: actor.userId, actorType: actor.actorType });
  await emit({ type: 'applicant.hired', aggregateType: 'applicant', aggregateId: id, payload: { employeeId, jobOpeningId: applicant.jobOpeningId }, actorId: actor.userId, actorType: actor.actorType });
  await emit({ type: 'employee.onboarded', aggregateType: 'employee', aggregateId: employeeId, payload: { employeeId, fromApplicantId: id, runOnboarding: input.runOnboarding ?? true }, actorId: actor.userId, actorType: actor.actorType });
  return { employeeId };
}

// ─── recruitment: interviews (PRD §12.3) ───
export async function listInterviews(applicantId: string) {
  const { db } = getDb();
  await loadApplicant(applicantId);
  return db.select().from(schema.interviews).where(eq(schema.interviews.applicantId, applicantId)).orderBy(asc(schema.interviews.scheduledAt));
}

export async function createInterview(input: any): Promise<string> {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.interviews).values({
    id, applicantId: input.applicantId, scheduledAt: new Date(input.scheduledAt),
    type: input.type ?? 'screening', interviewers: input.interviewers ?? [],
    scorecard: input.scorecard ?? null, summary: input.summary ?? '',
  });
  return id;
}

export async function updateInterview(id: string, input: any) {
  const { db } = getDb();
  const patch: Record<string, unknown> = {};
  if (input.scheduledAt !== undefined) patch.scheduledAt = new Date(input.scheduledAt);
  for (const k of ['type', 'interviewers', 'scorecard', 'summary']) if (input[k] !== undefined) patch[k] = input[k];
  await db.update(schema.interviews).set(patch).where(eq(schema.interviews.id, id));
}

// ─── resourcing: allocations (PRD §12.4) ───
export async function listAllocations(params: { userId?: string; projectId?: string; from?: string; to?: string }) {
  const { db } = getDb();
  return db.select().from(schema.allocations).where(and(
    params.userId ? eq(schema.allocations.userId, params.userId) : undefined,
    params.projectId ? eq(schema.allocations.projectId, params.projectId) : undefined,
    // overlap with [from, to] window if provided
    params.to ? sql`${schema.allocations.fromDate} <= ${params.to}` : undefined,
    params.from ? sql`${schema.allocations.toDate} >= ${params.from}` : undefined,
  )).orderBy(asc(schema.allocations.fromDate));
}

export async function createAllocation(actor: Actor, input: any): Promise<string> {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.allocations).values({
    id, userId: input.userId, projectId: input.projectId,
    hoursPerWeek: String(input.hoursPerWeek), fromDate: input.fromDate, toDate: input.toDate,
  });
  await writeActivity(db, { entityType: 'allocation', entityId: id, action: 'created', after: input, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

export async function deleteAllocation(actor: Actor, id: string) {
  const { db } = getDb();
  const [a] = await db.select().from(schema.allocations).where(eq(schema.allocations.id, id));
  if (!a) throw err.notFound('Allocation not found');
  await db.delete(schema.allocations).where(eq(schema.allocations.id, id));
  await writeActivity(db, { entityType: 'allocation', entityId: id, action: 'deleted', actorId: actor.userId, actorType: actor.actorType });
}

// ─── compensation (PRD §12.5) – people.read_compensation, audited on read ───
export async function listCompensation(actor: Actor, employeeId: string) {
  const { db } = getDb();
  await loadEmployee(employeeId);
  await recordSensitiveAccess(actor, 'compensation', employeeId);
  return db.select().from(schema.compensation)
    .where(eq(schema.compensation.employeeId, employeeId))
    .orderBy(desc(schema.compensation.effectiveFrom));
}

export async function createCompensation(actor: Actor, input: any): Promise<string> {
  const { db } = getDb();
  await loadEmployee(input.employeeId);
  // Close the previous open record (effectiveTo IS NULL) at the new record's start.
  await db.update(schema.compensation)
    .set({ effectiveTo: input.effectiveFrom })
    .where(and(eq(schema.compensation.employeeId, input.employeeId), isNull(schema.compensation.effectiveTo)));
  const id = ulid();
  await db.insert(schema.compensation).values({
    id, employeeId: input.employeeId, compType: input.compType, amount: String(input.amount),
    currency: input.currency ?? 'USD', effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null,
    createdBy: actor.userId,
  });
  await writeActivity(db, { entityType: 'compensation', entityId: id, action: 'created', after: { employeeId: input.employeeId, compType: input.compType, amount: input.amount, effectiveFrom: input.effectiveFrom }, actorId: actor.userId, actorType: actor.actorType });
  return id;
}

// ─── overhead settings (PRD §12.5) ───
export async function getOverheadSettings() {
  const { db } = getDb();
  const [row] = await db.select().from(schema.overheadSettings).orderBy(desc(schema.overheadSettings.effectiveFrom)).limit(1);
  return row ?? null;
}

export async function putOverheadSettings(actor: Actor, input: any) {
  const { db } = getDb();
  const id = ulid();
  await db.insert(schema.overheadSettings).values({
    id, monthlyBase: String(input.monthlyBase), currency: input.currency ?? 'USD',
    workingHoursPerWeek: String(input.workingHoursPerWeek), effectiveFrom: input.effectiveFrom,
  });
  await writeActivity(db, { entityType: 'overhead_settings', entityId: id, action: 'updated', after: { effectiveFrom: input.effectiveFrom }, actorId: actor.userId, actorType: actor.actorType });
  const [row] = await db.select().from(schema.overheadSettings).where(eq(schema.overheadSettings.id, id));
  return row;
}

// ─── HR dashboard (PRD §12.6) ───
export async function peopleDashboard() {
  const { db } = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  const [headcount] = await db.execute(sql`
    select
      count(*) filter (where status = 'active')::int as active,
      count(*) filter (where status = 'on_leave')::int as on_leave,
      count(*) filter (where join_date is not null and join_date >= ${cutoff})::int as new_hires,
      count(*) filter (where status = 'terminated' and exit_date is not null and exit_date >= ${cutoff})::int as exits
    from employees where deleted_at is null`) as any[];

  const upcomingAbsences = await db.execute(sql`
    select lr.id, lr.employee_id, lr.leave_type_id, lr.from_date, lr.to_date, lr.half_day,
           e.first_name, e.last_name
    from leave_requests lr join employees e on e.id = lr.employee_id
    where lr.status = 'approved' and lr.from_date >= ${today}
    order by lr.from_date asc limit 20`) as any[];

  const [openings] = await db.execute(sql`
    select count(*)::int as open_count from job_openings where deleted_at is null and status = 'open'`) as any[];

  const pipeline = await db.execute(sql`
    select s.id as stage_id, s.name as stage_name, count(a.id)::int as count
    from applicant_stages s
    left join applicants a on a.stage_id = s.id and a.deleted_at is null
    group by s.id, s.name, s.position order by s.position asc`) as any[];

  const upcomingProbation = await db.execute(sql`
    select id, first_name, last_name, probation_end from employees
    where deleted_at is null and status = 'active' and probation_end is not null and probation_end >= ${today}
    order by probation_end asc limit 20`) as any[];

  return {
    headcount: {
      active: Number(headcount?.active ?? 0),
      onLeave: Number(headcount?.on_leave ?? 0),
      newHires: Number(headcount?.new_hires ?? 0),
      exits: Number(headcount?.exits ?? 0),
    },
    upcomingAbsences,
    openJobOpenings: Number(openings?.open_count ?? 0),
    pipeline,
    upcomingProbationEnds: upcomingProbation,
  };
}
