import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  employeeInputSchema, employeeUpdateSchema, employeeLifecycleSchema,
  departmentInputSchema, positionInputSchema, leaveTypeInputSchema,
  leaveRequestInputSchema, leaveDecisionSchema,
  holidayCalendarInputSchema, holidayInputSchema,
  applicantStageInputSchema, jobOpeningInputSchema, applicantInputSchema,
  applicantMoveSchema, hireApplicantSchema, interviewInputSchema,
  allocationInputSchema, compensationInputSchema, overheadSettingsSchema,
  type Permission,
} from '@ordi/shared';
import type { AppEnv, Actor } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { err } from '../../lib/errors';
import * as svc from './service';

/** Guard allowing ANY of the listed permissions (union). */
function guardAny(...perms: Permission[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get('actor') as Actor | undefined;
    if (!actor) throw err.unauthenticated();
    if (perms.some((p) => actor.access.permissions.has(p))) return next();
    throw err.forbidden(`Missing one of: ${perms.join(', ')}`, perms[0]);
  };
}

export function peopleRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // ── People directory (PRD §12): unified users ∪ employee profiles ──
  app.get('/people/directory', guard('people.read'), async (c) =>
    c.json({ data: await svc.peopleDirectory() }));

  // ── Employees (PRD §12.1) ──
  app.get('/employees', guard('people.read'), async (c) => {
    const data = await svc.listEmployees(currentActor(c), {
      status: c.req.query('status'), departmentId: c.req.query('departmentId'), q: c.req.query('q'),
    });
    return c.json({ data });
  });

  app.post('/employees', guard('people.write'), async (c) => {
    const body = employeeInputSchema.parse(await c.req.json());
    const id = await svc.createEmployee(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.get('/employees/:id', guard('people.read'), async (c) =>
    c.json(await svc.getEmployee(currentActor(c), c.req.param('id'))));

  app.patch('/employees/:id', guard('people.write'), async (c) => {
    const body = employeeUpdateSchema.parse(await c.req.json());
    return c.json(await svc.updateEmployee(currentActor(c), c.req.param('id'), body));
  });

  app.delete('/employees/:id', guard('people.write'), async (c) => {
    await svc.softDeleteEmployee(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/employees/:id/lifecycle', guard('people.write'), async (c) => {
    const body = employeeLifecycleSchema.parse(await c.req.json());
    return c.json(await svc.employeeLifecycle(currentActor(c), c.req.param('id'), body));
  });

  // ── Employee documents (PRD §12.1) ──
  app.get('/employees/:id/documents', guard('people.read'), async (c) =>
    c.json({ data: await svc.listEmployeeDocuments(c.req.param('id')) }));

  app.post('/employees/:id/documents', guard('people.write'), async (c) => {
    const body = await c.req.json();
    if (!body?.attachmentId) throw err.validation('attachmentId required');
    const id = await svc.addEmployeeDocument(currentActor(c), c.req.param('id'), { attachmentId: body.attachmentId, type: body.type });
    return c.json({ id }, 201);
  });

  app.delete('/employee-documents/:id', guard('people.write'), async (c) => {
    await svc.deleteEmployeeDocument(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Departments (PRD §12.1) ──
  app.get('/departments', guard('people.read'), async (c) => c.json({ data: await svc.listDepartments() }));
  app.post('/departments', guard('people.write'), async (c) => {
    const body = departmentInputSchema.parse(await c.req.json());
    return c.json({ id: await svc.createDepartment(body) }, 201);
  });
  app.patch('/departments/:id', guard('people.write'), async (c) => {
    const body = departmentInputSchema.partial().parse(await c.req.json());
    await svc.updateDepartment(c.req.param('id'), body);
    return c.json({ ok: true });
  });
  app.delete('/departments/:id', guard('people.write'), async (c) => {
    await svc.deleteDepartment(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Positions (PRD §12.1) ──
  app.get('/positions', guard('people.read'), async (c) => c.json({ data: await svc.listPositions() }));
  app.post('/positions', guard('people.write'), async (c) => {
    const body = positionInputSchema.parse(await c.req.json());
    return c.json({ id: await svc.createPosition(body) }, 201);
  });
  app.patch('/positions/:id', guard('people.write'), async (c) => {
    const body = positionInputSchema.partial().parse(await c.req.json());
    await svc.updatePosition(c.req.param('id'), body);
    return c.json({ ok: true });
  });
  app.delete('/positions/:id', guard('people.write'), async (c) => {
    await svc.deletePosition(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Leave types (PRD §12.2) ──
  app.get('/leave-types', guard('people.read'), async (c) => c.json({ data: await svc.listLeaveTypes() }));
  app.post('/leave-types', guard('people.manage_leave'), async (c) => {
    const body = leaveTypeInputSchema.parse(await c.req.json());
    return c.json({ id: await svc.createLeaveType(body) }, 201);
  });
  app.patch('/leave-types/:id', guard('people.manage_leave'), async (c) => {
    const body = leaveTypeInputSchema.partial().parse(await c.req.json());
    await svc.updateLeaveType(c.req.param('id'), body);
    return c.json({ ok: true });
  });
  app.delete('/leave-types/:id', guard('people.manage_leave'), async (c) => {
    await svc.deleteLeaveType(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Leave balances (PRD §12.2) ──
  app.get('/leave-balances', guard('people.read'), async (c) =>
    c.json({ data: await svc.listLeaveBalances(c.req.query('employeeId')) }));

  app.post('/leave-balances/accrue', guard('people.manage_leave'), async (c) => {
    const body = await c.req.json();
    if (!body?.period) throw err.validation('period required');
    return c.json(await svc.accrueLeave(currentActor(c), { period: String(body.period), employeeId: body.employeeId, leaveTypeId: body.leaveTypeId }));
  });

  // ── Leave requests (PRD §12.2) ──
  // Leave is the one part of People everybody takes part in: an employee files
  // their own and a manager decides their reports', neither of which is
  // "reading the HR module". So these authorize per request in the service
  // (own / manager / approver) instead of demanding people.read, which the
  // Member and Manager roles do not carry – the list is the exception, since
  // seeing everyone's absences is exactly that read.
  app.get('/leave-requests', async (c) => {
    const actor = currentActor(c);
    const requested = c.req.query('employeeId');
    if (actor.access.permissions.has('people.read')) {
      return c.json({ data: await svc.listLeaveRequests({ employeeId: requested, status: c.req.query('status') }) });
    }
    const own = await svc.employeeOfUser(actor.userId);
    if (!own || (requested && requested !== own.id)) throw err.forbidden('Missing permission people.read', 'people.read');
    return c.json({ data: await svc.listLeaveRequests({ employeeId: own.id, status: c.req.query('status') }) });
  });

  app.post('/leave-requests', async (c) => {
    const body = leaveRequestInputSchema.parse(await c.req.json());
    return c.json(await svc.createLeaveRequest(currentActor(c), body), 201);
  });

  app.post('/leave-requests/:id/approve', async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const { comment } = leaveDecisionSchema.parse({ decision: 'approve', comment: raw?.comment });
    return c.json(await svc.decideLeave(currentActor(c), c.req.param('id'), 'approved', comment));
  });

  app.post('/leave-requests/:id/reject', async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const { comment } = leaveDecisionSchema.parse({ decision: 'reject', comment: raw?.comment });
    return c.json(await svc.decideLeave(currentActor(c), c.req.param('id'), 'rejected', comment));
  });

  app.post('/leave-requests/:id/cancel', async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const comment = typeof raw?.comment === 'string' ? raw.comment : '';
    return c.json(await svc.decideLeave(currentActor(c), c.req.param('id'), 'canceled', comment));
  });

  // ── Holiday calendars (PRD §12.2) ──
  app.get('/holiday-calendars', guard('people.read'), async (c) => c.json({ data: await svc.listHolidayCalendars() }));
  app.post('/holiday-calendars', guard('people.manage_leave'), async (c) => {
    const body = holidayCalendarInputSchema.parse(await c.req.json());
    return c.json({ id: await svc.createHolidayCalendar(body) }, 201);
  });
  app.delete('/holiday-calendars/:id', guard('people.manage_leave'), async (c) => {
    await svc.deleteHolidayCalendar(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/holidays', guard('people.read'), async (c) => c.json({ data: await svc.listHolidays(c.req.query('calendarId')) }));
  app.post('/holidays', guard('people.manage_leave'), async (c) => {
    const body = holidayInputSchema.parse(await c.req.json());
    return c.json({ id: await svc.createHoliday(body) }, 201);
  });
  app.delete('/holidays/:id', guard('people.manage_leave'), async (c) => {
    await svc.deleteHoliday(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/employees/:id/holiday-calendar', guard('people.write'), async (c) => {
    const body = await c.req.json();
    if (!body?.calendarId) throw err.validation('calendarId required');
    await svc.assignHolidayCalendar(currentActor(c), c.req.param('id'), body.calendarId);
    return c.json({ ok: true });
  });

  // ── Recruitment: applicant stages (PRD §12.3) ──
  app.get('/applicant-stages', guard('people.recruit'), async (c) => c.json({ data: await svc.listApplicantStages() }));
  app.post('/applicant-stages', guard('people.recruit'), async (c) => {
    const body = applicantStageInputSchema.parse(await c.req.json());
    return c.json({ id: await svc.createApplicantStage(body) }, 201);
  });
  app.patch('/applicant-stages/:id', guard('people.recruit'), async (c) => {
    const body = applicantStageInputSchema.partial().parse(await c.req.json());
    await svc.updateApplicantStage(c.req.param('id'), body);
    return c.json({ ok: true });
  });
  app.delete('/applicant-stages/:id', guard('people.recruit'), async (c) => {
    await svc.deleteApplicantStage(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Recruitment: job openings (PRD §12.3) ──
  app.get('/job-openings', guard('people.recruit'), async (c) =>
    c.json({ data: await svc.listJobOpenings(currentActor(c), c.req.query('status')) }));

  app.post('/job-openings', guard('people.recruit'), async (c) => {
    const body = jobOpeningInputSchema.parse(await c.req.json());
    return c.json({ id: await svc.createJobOpening(currentActor(c), body) }, 201);
  });

  app.get('/job-openings/:id', guard('people.recruit'), async (c) =>
    c.json(await svc.getJobOpening(currentActor(c), c.req.param('id'))));

  app.patch('/job-openings/:id', guard('people.recruit'), async (c) => {
    const raw = await c.req.json();
    const body = jobOpeningInputSchema.partial().parse(raw);
    const version = typeof raw?.version === 'number' ? raw.version : undefined;
    return c.json(await svc.updateJobOpening(currentActor(c), c.req.param('id'), body, version));
  });

  app.delete('/job-openings/:id', guard('people.recruit'), async (c) => {
    await svc.deleteJobOpening(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Recruitment: applicants (PRD §12.3) ──
  app.get('/applicants', guard('people.recruit'), async (c) =>
    c.json({ data: await svc.listApplicants({ jobOpeningId: c.req.query('jobOpeningId'), stageId: c.req.query('stageId') }) }));

  app.post('/applicants', guard('people.recruit'), async (c) => {
    const body = applicantInputSchema.parse(await c.req.json());
    return c.json(await svc.createApplicant(currentActor(c), body), 201);
  });

  app.get('/applicants/:id', guard('people.recruit'), async (c) => c.json(await svc.getApplicant(c.req.param('id'))));

  app.post('/applicants/:id/move', guard('people.recruit'), async (c) => {
    const body = applicantMoveSchema.parse(await c.req.json());
    return c.json(await svc.moveApplicant(currentActor(c), c.req.param('id'), body));
  });

  app.post('/applicants/:id/hire', guard('people.recruit'), async (c) => {
    const body = hireApplicantSchema.parse(await c.req.json());
    return c.json(await svc.hireApplicant(currentActor(c), c.req.param('id'), body), 201);
  });

  // ── Recruitment: interviews (PRD §12.3) ──
  app.get('/applicants/:id/interviews', guard('people.recruit'), async (c) =>
    c.json({ data: await svc.listInterviews(c.req.param('id')) }));

  app.post('/interviews', guard('people.recruit'), async (c) => {
    const body = interviewInputSchema.parse(await c.req.json());
    return c.json({ id: await svc.createInterview(body) }, 201);
  });

  app.patch('/interviews/:id', guard('people.recruit'), async (c) => {
    const body = interviewInputSchema.partial().parse(await c.req.json());
    await svc.updateInterview(c.req.param('id'), body);
    return c.json({ ok: true });
  });

  // ── Resourcing: allocations (PRD §12.4) ──
  app.get('/allocations', guardAny('people.read', 'projects.read'), async (c) =>
    c.json({ data: await svc.listAllocations({
      userId: c.req.query('userId'), projectId: c.req.query('projectId'),
      from: c.req.query('from'), to: c.req.query('to'),
    }) }));

  app.post('/allocations', guard('people.write'), async (c) => {
    const body = allocationInputSchema.parse(await c.req.json());
    return c.json({ id: await svc.createAllocation(currentActor(c), body) }, 201);
  });

  app.delete('/allocations/:id', guard('people.write'), async (c) => {
    await svc.deleteAllocation(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Compensation (PRD §12.5) – people.read_compensation ──
  app.get('/employees/:id/compensation', guard('people.read_compensation'), async (c) =>
    c.json({ data: await svc.listCompensation(currentActor(c), c.req.param('id')) }));

  app.post('/compensation', guard('people.read_compensation'), async (c) => {
    const body = compensationInputSchema.parse(await c.req.json());
    return c.json({ id: await svc.createCompensation(currentActor(c), body) }, 201);
  });

  app.get('/overhead-settings', guardAny('finance.settings', 'people.read_compensation'), async (c) =>
    c.json(await svc.getOverheadSettings()));

  app.put('/overhead-settings', guardAny('finance.settings', 'people.read_compensation'), async (c) => {
    const body = overheadSettingsSchema.parse(await c.req.json());
    return c.json(await svc.putOverheadSettings(currentActor(c), body));
  });

  // ── HR dashboard (PRD §12.6) ──
  app.get('/people/dashboard', guard('people.read'), async (c) => c.json(await svc.peopleDashboard()));

  return app;
}
