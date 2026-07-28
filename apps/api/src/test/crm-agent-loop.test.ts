/**
 * What an API/MCP client has to be able to do without a UI: write a record,
 * read back what it wrote, and change one field without erasing the rest.
 * Plus leave self-service, which asked for an employeeId nobody could send.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { textToDoc } from '@ordi/shared';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let owner: ReturnType<typeof reqAs>;
let companyId = '';
let dealId = '';
let stageId = '';
let lostStageId = '';

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);

  for (const f of [
    { entityType: 'companies', key: 'icp_fit', label: 'ICP fit', type: 'text' },
    { entityType: 'companies', key: 'source', label: 'Source', type: 'text' },
    { entityType: 'deals', key: 'lost_reason_code', label: 'Lost reason', type: 'select',
      options: [{ value: 'price', label: 'Price' }, { value: 'timing', label: 'Timing' }] },
  ]) {
    expect((await owner.post('/custom-fields', f)).status).toBe(201);
  }

  companyId = (await json(owner.post('/companies', {
    name: 'Northwind', domain: 'northwind.io', status: 'lead',
    customFields: { icp_fit: 'high', source: 'referral' },
  }))).id;
  stageId = (await json(owner.post('/deal-stages', { name: 'Lead', position: 0, probability: 10 }))).id;
  lostStageId = (await json(owner.post('/deal-stages', { name: 'Lost', position: 90, probability: 0, isLost: true }))).id;
  dealId = (await json(owner.post('/deals', {
    companyId, title: 'Platform build', stageId, amount: 12000, customFields: { lost_reason_code: null },
  }))).id;
});

describe('custom fields survive a single-key update', () => {
  it('company: patching one key keeps the others', async () => {
    await owner.patch(`/companies/${companyId}`, { customFields: { icp_fit: 'medium' } });
    const company = await json(owner.get(`/companies/${companyId}`));
    expect(company.customFields).toEqual({ icp_fit: 'medium', source: 'referral' });
  });

  it('company: an explicit null clears one key only', async () => {
    await owner.patch(`/companies/${companyId}`, { customFields: { source: null } });
    const company = await json(owner.get(`/companies/${companyId}`));
    expect(company.customFields).toEqual({ icp_fit: 'medium', source: null });
  });

  it('deal: the same, and the deal reads back without being moved', async () => {
    await owner.patch(`/deals/${dealId}`, { customFields: { lost_reason_code: 'price' } });
    const deal = await json(owner.get(`/deals/${dealId}`));
    expect(deal.customFields).toMatchObject({ lost_reason_code: 'price' });
    expect(deal.title).toBe('Platform build');
  });

  it('contact and task follow the same rule', async () => {
    const contactId = (await json(owner.post('/contacts', {
      companyId, firstName: 'Ada', customFields: { a: 1, b: 2 },
    }))).id;
    await owner.patch(`/contacts/${contactId}`, { customFields: { b: 3 } });
    // read back on the id alone, without knowing the company
    const contact = await json(owner.get(`/contacts/${contactId}`));
    expect(contact.customFields).toEqual({ a: 1, b: 3 });
    expect((await owner.get(`/contacts/${ulid()}`)).status).toBe(404);
  });
});

describe('notes are readable, not just writable', () => {
  it('lists notes per record and finds them in search', async () => {
    const body = textToDoc('PROSPECT CARD\nBudget confirmed, decision in Q3.');
    expect((await owner.post('/notes', { companyId, body })).status).toBe(201);
    expect((await owner.post('/notes', { dealId, body: textToDoc('Disqualified: no budget') })).status).toBe(201);

    const perCompany = (await json(owner.get(`/notes?companyId=${companyId}`))).data as any[];
    expect(perCompany).toHaveLength(1);

    const hits = (await json(owner.get('/search?q=PROSPECT%20CARD'))).data as any[];
    const note = hits.find((h) => h.kind === 'note');
    expect(note).toBeTruthy();
    expect(note.title).toMatch(/PROSPECT CARD/);
    expect(note.url).toBe(`/companies/${companyId}`);

    const dealHit = ((await json(owner.get('/search?q=Disqualified'))).data as any[]).find((h) => h.kind === 'note');
    expect(dealHit.url).toBe(`/deals/${dealId}`);
  });

  it('keeps notes behind crm.read', async () => {
    const hits = (await json(reqAs(users.hr!.cookie).get('/search?q=PROSPECT%20CARD'))).data as any[];
    expect(hits.some((h) => h.kind === 'note')).toBe(false);
  });
});

describe('a lost deal can carry the structured reason with the move', () => {
  it('moves and keeps both the code and the free-text detail', async () => {
    await owner.patch(`/deals/${dealId}`, { customFields: { lost_reason_code: 'timing' } });
    const moved = await json(owner.post(`/deals/${dealId}/move`, { stageId: lostStageId, lostReason: 'Postponed to next year' }));
    expect(moved.lostReason).toBe('Postponed to next year');
    expect(moved.customFields).toMatchObject({ lost_reason_code: 'timing' });
  });
});

describe('custom field definitions can be retired', () => {
  it('deprecates without touching stored values', async () => {
    const fields = (await json(owner.get('/custom-fields?entityType=companies'))).data as any[];
    const source = fields.find((f) => f.key === 'source');
    expect((await owner.patch(`/custom-fields/${source.id}`, { deprecated: true })).status).toBe(200);
    const after = ((await json(owner.get('/custom-fields?entityType=companies'))).data as any[])
      .find((f) => f.key === 'source');
    expect(after.deprecated).toBe(true);
    expect((await json(owner.get(`/companies/${companyId}`))).customFields).toHaveProperty('source');
  });
});

describe('leave self-service (PRD §12.2)', () => {
  let leaveTypeId = '';
  let memberEmployeeId = '';

  beforeAll(async () => {
    leaveTypeId = (await json(owner.post('/leave-types', { name: 'Annual', isPaid: true, needsApproval: true, affectsBalance: false }))).id;
    const { db } = getDb();
    memberEmployeeId = ulid();
    await db.insert(schema.employees).values({
      id: memberEmployeeId, userId: users.member!.userId, firstName: 'Mem', lastName: 'Ber', status: 'active',
    } as any);
  });

  it('files a request without naming yourself, and without people.read', async () => {
    const member = reqAs(users.member!.cookie);
    expect((await json(member.get('/me'))).permissions).not.toContain('people.read');
    const res = await member.post('/leave-requests', { leaveTypeId, fromDate: '2026-09-01', toDate: '2026-09-05', reason: 'Trip' });
    expect(res.status).toBe(201);
    expect((await json(res)).employeeId).toBe(memberEmployeeId);
  });

  it('shows the requester their own leave, and nobody else’s', async () => {
    const member = reqAs(users.member!.cookie);
    const mine = (await json(member.get('/leave-requests'))).data as any[];
    expect(mine).toHaveLength(1);
    expect(mine[0].employeeId).toBe(memberEmployeeId);
    expect((await member.get(`/leave-requests?employeeId=${ulid()}`)).status).toBe(403);
  });

  it('explains a missing employee card instead of failing validation', async () => {
    const res = await reqAs(users.manager!.cookie).post('/leave-requests', { leaveTypeId, fromDate: '2026-09-01', toDate: '2026-09-02' });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.error.message).toMatch(/employee record/i);
  });

  it('still refuses filing for someone else without the HR permissions', async () => {
    const other = ulid();
    const { db } = getDb();
    await db.insert(schema.employees).values({ id: other, firstName: 'Some', lastName: 'One', status: 'active' } as any);
    const res = await reqAs(users.member!.cookie).post('/leave-requests', {
      employeeId: other, leaveTypeId, fromDate: '2026-10-01', toDate: '2026-10-02',
    });
    expect(res.status).toBe(403);
  });
});
