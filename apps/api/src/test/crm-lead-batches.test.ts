/**
 * Working leads in volume: bulk owner/status changes, the truncation flag on
 * the bounded list, CSV import (auto-creating companies) and sales analytics.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let companyId: string;
let openStageId: string;
let wonStageId: string;
let lostStageId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();

  companyId = ulid();
  await db.insert(schema.companies).values({ id: companyId, name: 'Batch Co', createdBy: users.owner!.userId });

  openStageId = ulid();
  wonStageId = ulid();
  lostStageId = ulid();
  await db.insert(schema.dealStages).values([
    { id: openStageId, name: 'Qualified', position: 0, probability: 20 },
    { id: wonStageId, name: 'Won', position: 1, probability: 100, isWon: true },
    { id: lostStageId, name: 'Lost', position: 2, probability: 0, isLost: true },
  ]);
});

async function createLead(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await reqAs(users.owner!.cookie).post('/leads', { companyId, title, ...extra });
  expect(res.status).toBe(201);
  return (await json(res)).id;
}

describe('bulk lead updates', () => {
  it('reassigns owner and moves status across many leads', async () => {
    const a = await createLead('Bulk A');
    const b = await createLead('Bulk B');
    const res = await reqAs(users.owner!.cookie).post('/leads/bulk', {
      ids: [a, b], ownerId: users.sales!.userId, status: 'ready',
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.updated).toBe(2);
    expect(body.errors).toEqual([]);
    const lead = await json(reqAs(users.owner!.cookie).get(`/leads/${a}`));
    expect(lead.ownerId).toBe(users.sales!.userId);
    expect(lead.status).toBe('ready');
  });

  it('a terminal bulk status cancels planned activities', async () => {
    const id = await createLead('Bulk with plan', { status: 'ready' });
    const activity = await reqAs(users.owner!.cookie).post('/sales-activities', {
      leadId: id, type: 'outreach', dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(activity.status).toBe(201);
    const res = await reqAs(users.owner!.cookie).post('/leads/bulk', { ids: [id], status: 'disqualified' });
    expect((await json(res)).updated).toBe(1);
    const activities = await json(reqAs(users.owner!.cookie).get(`/sales-activities?leadId=${id}`));
    expect(activities.data.every((row: { status: string }) => row.status !== 'planned')).toBe(true);
  });

  it('collects per-lead failures instead of aborting the batch', async () => {
    const ok = await createLead('Bulk OK', { status: 'engaged' });
    const converted = await createLead('Bulk converted', { status: 'engaged' });
    const convert = await reqAs(users.owner!.cookie).post(`/leads/${converted}/convert`, {});
    expect(convert.status).toBe(200);
    const res = await reqAs(users.owner!.cookie).post('/leads/bulk', {
      ids: [ok, converted, ulid()], status: 'waiting_reply',
    });
    const body = await json(res);
    expect(body.updated).toBe(1);
    expect(body.errors).toHaveLength(2);
  });

  it('rejects a batch that changes nothing, and bulk nurture without a date', async () => {
    const id = await createLead('Bulk noop');
    expect((await reqAs(users.owner!.cookie).post('/leads/bulk', { ids: [id] })).status).toBe(400);
    expect((await reqAs(users.owner!.cookie).post('/leads/bulk', { ids: [id], status: 'nurture' })).status).toBe(400);
  });
});

describe('lead list truncation', () => {
  it('says out loud when the bounded list is cut', async () => {
    await createLead('Trunc A');
    await createLead('Trunc B');
    const cut = await json(reqAs(users.owner!.cookie).get('/leads?limit=1&q=Trunc'));
    expect(cut.data).toHaveLength(1);
    expect(cut.truncated).toBe(true);
    const full = await json(reqAs(users.owner!.cookie).get('/leads?q=Trunc'));
    expect(full.truncated).toBe(false);
  });
});

describe('leads CSV import/export', () => {
  const csv = [
    'companyName,title,product,status,score,signal,sourceUrl',
    'Batch Co,Imported lead,Site,ready,80,Hiring spree,https://example.com/post',
    'Fresh Import Co,Second lead,,engaged,notanumber,,',
    ',Missing company,,,,,',
    'Bad URL Co,Broken link,,,,,ftp://nope',
  ].join('\n');

  it('dry run reports valid rows and companies to create without writing', async () => {
    const res = await json(reqAs(users.owner!.cookie).post('/import/leads', { csv, dryRun: true }));
    expect(res.rows).toBe(4);
    expect(res.valid).toBe(2);
    expect(res.newCompanies).toBe(1);
    expect(res.errors).toHaveLength(2);
    const leads = await json(reqAs(users.owner!.cookie).get('/leads?q=Imported%20lead'));
    expect(leads.data).toHaveLength(0);
  });

  it('imports rows and creates unknown companies as prospects', async () => {
    const res = await json(reqAs(users.owner!.cookie).post('/import/leads', { csv, dryRun: false }));
    expect(res.imported).toBe(2);
    expect(res.newCompanies).toBe(1);
    const { db } = getDb();
    const [created] = await db.select().from(schema.companies).where(eq(schema.companies.name, 'Fresh Import Co'));
    expect(created?.status).toBe('lead');
    const leads = await json(reqAs(users.owner!.cookie).get('/leads?q=Imported%20lead'));
    expect(leads.data).toHaveLength(1);
    expect(leads.data[0].status).toBe('ready');
    expect(leads.data[0].score).toBe(80);
    // The importer owns what they brought in.
    expect(leads.data[0].ownerId).toBe(users.owner!.userId);
  });

  it('exports leads as CSV', async () => {
    const res = await reqAs(users.owner!.cookie).get('/export/leads.csv');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.split('\n')[0]).toContain('companyName');
    expect(text).toContain('Imported lead');
  });
});

describe('sales analytics', () => {
  it('reports the funnel, conversion, win rate and lost reasons', async () => {
    const { db } = getDb();
    const wonId = ulid();
    const lostId = ulid();
    await db.insert(schema.deals).values([
      { id: wonId, companyId, title: 'Won deal', stageId: wonStageId, amount: '1000', currency: 'USD', createdBy: users.owner!.userId },
      { id: lostId, companyId, title: 'Lost deal', stageId: lostStageId, lostReason: 'Budget', currency: 'USD', createdBy: users.owner!.userId },
    ]);

    const res = await json(reqAs(users.owner!.cookie).get('/sales-analytics'));
    expect(res.leads.total).toBeGreaterThan(0);
    expect(res.leads.byStatus.converted).toBeGreaterThanOrEqual(1);
    // At least one lead converted and one was disqualified in the suites above.
    expect(res.leads.conversionRate).toBeGreaterThan(0);
    expect(res.leads.conversionRate).toBeLessThanOrEqual(1);

    expect(res.deals).not.toBeNull();
    expect(res.deals.wonCount).toBe(1);
    expect(res.deals.lostCount).toBe(1);
    expect(res.deals.winRate).toBe(0.5);
    expect(res.deals.wonTotals).toEqual([{ currency: 'USD', amount: 1000 }]);
    expect(res.deals.lostReasons).toEqual([{ reason: 'Budget', count: 1 }]);
    const openStage = res.deals.stages.find((stage: { id: string }) => stage.id === openStageId);
    expect(openStage).toBeTruthy();
  });

  it('hides the deals half from a role without deals.read', async () => {
    const res = await json(reqAs(users.finance!.cookie).get('/sales-analytics'));
    expect(res.leads).toBeTruthy();
    expect(res.deals).toBeNull();
  });

  it('requires crm.read', async () => {
    expect((await reqAs(users.hr!.cookie).get('/sales-analytics')).status).toBe(403);
  });
});
