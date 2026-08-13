/**
 * The open employee card: any authenticated user reads the public slice of an
 * employee (identity + org seat), while contacts, employment dates and custom
 * fields stay behind people.read. Leave self-service works without people.read:
 * own requests/balance, and a manager decides their reports' leave.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let managerEmpId: string;
let memberEmpId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const hr = reqAs(users.hr!.cookie);
  managerEmpId = (await json(hr.post('/employees', {
    firstName: 'Marta', lastName: 'M', userId: users.manager!.userId,
  }))).id;
  memberEmpId = (await json(hr.post('/employees', {
    firstName: 'Mykola', lastName: 'K', userId: users.member!.userId,
    email: 'private@example.com', phone: '+380000000000', location: 'Київ',
    managerId: managerEmpId, customFields: { tg: '@mykola' },
  }))).id;
});

describe('open employee card', () => {
  it('serves the public slice to a user without people.read', async () => {
    const member = reqAs(users.member!.cookie);
    const e = await json(member.get(`/employees/${memberEmpId}`));
    expect(e.firstName).toBe('Mykola');
    expect(e.location).toBe('Київ');
    expect(e.managerId).toBe(managerEmpId);
    // Contacts and ungrouped custom fields are not public.
    expect(e.email).toBeUndefined();
    expect(e.phone).toBeUndefined();
    expect(e.customFields).toEqual({});
  });

  it('serves the full record to people.read holders', async () => {
    const hr = reqAs(users.hr!.cookie);
    const e = await json(hr.get(`/employees/${memberEmpId}`));
    expect(e.email).toBe('private@example.com');
    expect(e.customFields).toMatchObject({ tg: '@mykola' });
  });

  it('opens the list and the directory to everyone signed in', async () => {
    const member = reqAs(users.member!.cookie);
    const list = (await json(member.get('/employees'))).data as any[];
    expect(list.length).toBe(2);
    expect(list[0].email).toBeUndefined();
    const dir = await member.get('/people/directory');
    expect(dir.status).toBe(200);
  });

  it('rejects writes of the retired sensitive columns', async () => {
    const hr = reqAs(users.hr!.cookie);
    await json(hr.patch(`/employees/${memberEmpId}`, { sensitive: { note: 'x' } }));
    const e = await json(hr.get(`/employees/${memberEmpId}`));
    // The write was dropped by the contract; the legacy column stays empty.
    expect(e.sensitive ?? null).toBeNull();
  });
});

describe('leave self-service without people.read', () => {
  let requestId: string;

  it('a member files their own leave and sees their balance', async () => {
    const hr = reqAs(users.hr!.cookie);
    const member = reqAs(users.member!.cookie);
    const type = await json(hr.post('/leave-types', { name: 'Annual', annualQuota: 20 }));

    const filed = await json(member.post('/leave-requests', {
      leaveTypeId: type.id, fromDate: '2026-09-07', toDate: '2026-09-09',
    }));
    requestId = filed.id;
    expect(filed.employeeId).toBe(memberEmpId);
    expect(filed.approverId).toBe(users.manager!.userId);

    const own = (await json(member.get('/leave-requests'))).data as any[];
    expect(own).toHaveLength(1);

    const balances = await member.get('/leave-balances');
    expect(balances.status).toBe(200);
  });

  it('the manager sees it under scope=approvals and can approve', async () => {
    const manager = reqAs(users.manager!.cookie);
    const queue = (await json(manager.get('/leave-requests?scope=approvals'))).data as any[];
    expect(queue.map((r) => r.id)).toContain(requestId);

    const decided = await json(manager.post(`/leave-requests/${requestId}/approve`, {}));
    expect(decided.status).toBe('approved');
  });

  it('a stranger without people.read cannot list someone else’s leave', async () => {
    const sales = reqAs(users.sales!.cookie);
    const res = await sales.get(`/leave-requests?employeeId=${memberEmpId}`);
    expect(res.status).toBe(403);
  });
});
