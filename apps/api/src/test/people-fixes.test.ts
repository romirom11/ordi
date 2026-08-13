/**
 * People-module hardening: holidays in leave math, custom-field merge on PATCH,
 * lifecycle transitions, and the employee-documents permission.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let employeeId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const hr = reqAs(users.hr!.cookie);
  employeeId = (await json(hr.post('/employees', { firstName: 'Olha', lastName: 'K' }))).id;
});

describe('holidays count out of leave days', () => {
  it('a holiday inside the range does not charge a leave day', async () => {
    const hr = reqAs(users.hr!.cookie);
    const cal = await json(hr.post('/holiday-calendars', { name: 'UA' }));
    // 2026-08-24 is a Monday.
    await json(hr.post('/holidays', { calendarId: cal.id, date: '2026-08-24', name: 'Independence Day' }));

    const leaveType = await json(hr.post('/leave-types', { name: 'Annual', annualQuota: 20 }));
    const req = await json(hr.post('/leave-requests', {
      employeeId, leaveTypeId: leaveType.id,
      fromDate: '2026-08-24', toDate: '2026-08-28',
    }));
    // Mon–Fri = 5 working days, minus the holiday Monday.
    expect(req.days).toBe(4);
  });
});

describe('employee PATCH merges custom fields', () => {
  it('sending one key keeps the others', async () => {
    const hr = reqAs(users.hr!.cookie);
    await json(hr.patch(`/employees/${employeeId}`, { customFields: { a: 'one', b: 'two' } }));
    await json(hr.patch(`/employees/${employeeId}`, { customFields: { a: 'nine' } }));
    const e = await json(hr.get(`/employees/${employeeId}`));
    expect(e.customFields).toMatchObject({ a: 'nine', b: 'two' });
  });
});

describe('lifecycle transitions', () => {
  it('exit sets an exit date; reactivate clears it', async () => {
    const hr = reqAs(users.hr!.cookie);
    const exited = await json(hr.post(`/employees/${employeeId}/lifecycle`, { action: 'exit' }));
    expect(exited.status).toBe('terminated');
    expect(exited.exitDate).toBeTruthy();

    const again = await hr.post(`/employees/${employeeId}/lifecycle`, { action: 'exit' });
    expect(again.status).toBe(422);

    const back = await json(hr.post(`/employees/${employeeId}/lifecycle`, { action: 'reactivate' }));
    expect(back.status).toBe('active');
    expect(back.exitDate).toBeNull();
  });
});

describe('employee documents permission', () => {
  it('demands people.read_documents to list, and a real attachment to bind', async () => {
    const hr = reqAs(users.hr!.cookie);
    const member = reqAs(users.member!.cookie);

    const asMember = await member.get(`/employees/${employeeId}/documents`);
    expect(asMember.status).toBe(403);

    const asHr = await hr.get(`/employees/${employeeId}/documents`);
    expect(asHr.status).toBe(200);

    const bogus = await hr.post(`/employees/${employeeId}/documents`, { attachmentId: 'no-such-attachment' });
    expect(bogus.status).toBe(400);
  });
});
