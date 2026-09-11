/**
 * Leave entitlements (ORD-26): what a person still has, and the refusal that
 * keeps them from booking more than that – at submit and again at approval.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

const YEAR = new Date().getFullYear();
const PERIOD = String(YEAR);

/**
 * Entitlements are per period, so the fixtures live in the current year – and
 * the working-day counts must not depend on which weekday a fixed date lands on
 * that year. Every range therefore starts on the first Monday of a month.
 */
function monday(month: number, plusDays = 0): string {
  const d = new Date(Date.UTC(YEAR, month - 1, 1));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + plusDays);
  return d.toISOString().slice(0, 10);
}

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let hr: ReturnType<typeof reqAs>;
let member: ReturnType<typeof reqAs>;
let employeeId: string;
let annualId: string;
let unpaidId: string;

const entitlement = async (req: ReturnType<typeof reqAs>, typeId: string, query = '') => {
  const rows = (await json(req.get(`/leave-entitlements${query}`))).data as any[];
  return rows.find((r) => r.leaveTypeId === typeId);
};

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  hr = reqAs(users.hr!.cookie);
  member = reqAs(users.member!.cookie);
  // The member's own card, so self-service reads and writes go through them.
  employeeId = (await json(hr.post('/employees', { firstName: 'Ivan', lastName: 'P', userId: users.member!.userId }))).id;
  annualId = (await json(hr.post('/leave-types', { name: 'Annual', affectsBalance: true, annualQuota: 5, allowHalfDay: true }))).id;
  unpaidId = (await json(hr.post('/leave-types', { name: 'Unpaid', affectsBalance: false, annualQuota: 0 }))).id;
});

describe('leave entitlements', () => {
  it('falls back to the type quota before HR has accrued the period', async () => {
    const annual = await entitlement(member, annualId);
    expect(annual).toMatchObject({ allocated: 5, used: 0, pending: 0, remaining: 5, tracked: true, period: PERIOD });
    // No quota and no balance draw – nothing to cap.
    expect((await entitlement(member, unpaidId)).tracked).toBe(false);
  });

  it('holds pending days back, then moves them into used on approval', async () => {
    // Mon–Wed = 3 working days.
    const req = await json(member.post('/leave-requests', { leaveTypeId: annualId, fromDate: monday(6), toDate: monday(6, 2) }));
    expect(req.days).toBe(3);
    expect(await entitlement(member, annualId)).toMatchObject({ used: 0, pending: 3, remaining: 2 });

    expect((await hr.post(`/leave-requests/${req.id}/approve`, {})).status).toBe(200);
    expect(await entitlement(member, annualId)).toMatchObject({ used: 3, pending: 0, remaining: 2 });
  });

  it('refuses a request longer than what is left', async () => {
    const res = await member.post('/leave-requests', { leaveTypeId: annualId, fromDate: monday(7), toDate: monday(7, 4) });
    expect(res.status).toBe(422);
    expect((await res.json() as any).error.message).toMatch(/Not enough Annual left/);
  });

  it('still allows a request that fits, and half days count as half a day', async () => {
    const ok = await json(member.post('/leave-requests', { leaveTypeId: annualId, fromDate: monday(7), toDate: monday(7), halfDay: true }));
    expect(ok.days).toBe(0.5);
    expect(await entitlement(member, annualId)).toMatchObject({ pending: 0.5, remaining: 1.5 });
  });

  it('never caps a type that does not draw down a balance', async () => {
    const ok = await json(member.post('/leave-requests', { leaveTypeId: unpaidId, fromDate: monday(9), toDate: monday(9, 25) }));
    expect(ok.days).toBeGreaterThan(5);
  });

  it('re-checks at approval, so a quota lowered after the fact still holds', async () => {
    const req = await json(member.post('/leave-requests', { leaveTypeId: annualId, fromDate: monday(8), toDate: monday(8) }));
    // HR accrues the period at a smaller quota than the pending request needs.
    await json(hr.patch(`/leave-types/${annualId}`, { annualQuota: 1 }));
    await json(hr.post('/leave-balances/accrue', { period: PERIOD, employeeId, leaveTypeId: annualId }));

    const res = await hr.post(`/leave-requests/${req.id}/approve`, {});
    expect(res.status).toBe(422);
    expect((await res.json() as any).error.message).toMatch(/Not enough Annual left/);
    // Rejecting it does not touch the balance, and the request leaves the queue.
    expect((await hr.post(`/leave-requests/${req.id}/reject`, { comment: 'over quota' })).status).toBe(200);
  });
});

describe('leave entitlements after a zero-quota accrual', () => {
  it('keeps the cap once the type gets a quota, until HR re-accrues', async () => {
    const compId = (await json(hr.post('/leave-types', { name: 'Comp', affectsBalance: true, annualQuota: 0 }))).id;
    await json(hr.post('/leave-balances/accrue', { period: PERIOD, employeeId, leaveTypeId: compId }));
    // Nothing allocated and no quota: not capped.
    expect((await entitlement(member, compId)).tracked).toBe(false);

    // The quota is raised but the stored row still says 0 – that is "0 left",
    // not "unlimited".
    await json(hr.patch(`/leave-types/${compId}`, { annualQuota: 3 }));
    expect(await entitlement(member, compId)).toMatchObject({ allocated: 0, remaining: 0, tracked: true });
    const res = await member.post('/leave-requests', { leaveTypeId: compId, fromDate: monday(11), toDate: monday(11) });
    expect(res.status).toBe(422);

    // Re-accruing picks the quota up and the same request goes through.
    await json(hr.post('/leave-balances/accrue', { period: PERIOD, employeeId, leaveTypeId: compId }));
    expect(await entitlement(member, compId)).toMatchObject({ allocated: 3, remaining: 3 });
    expect((await member.post('/leave-requests', { leaveTypeId: compId, fromDate: monday(11), toDate: monday(11) })).status).toBe(201);
  });
});

describe('leave entitlements access', () => {
  it('is self-service for your own card and needs people.read for anyone else', async () => {
    expect((await member.get('/leave-entitlements')).status).toBe(200);
    expect((await member.get(`/leave-entitlements?employeeId=${employeeId}`)).status).toBe(200);

    const other = (await json(hr.post('/employees', { firstName: 'Someone', lastName: 'Else' }))).id;
    expect((await member.get(`/leave-entitlements?employeeId=${other}`)).status).toBe(403);
    expect((await hr.get(`/leave-entitlements?employeeId=${other}`)).status).toBe(200);
  });

  it('tells an unlinked account it has no employee card instead of guessing one', async () => {
    const admin = reqAs(users.admin!.cookie);
    const res = await admin.get('/leave-entitlements');
    expect(res.status).toBe(400);
  });
});
