import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { json, reqAs, resetDb, seedRolesAndUsers } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let qualifiedStageId: string;
let legacyLeadStageId: string;

const research = {
  title: 'kdn.agency — shortlist',
  product: 'AI workflow pilot',
  product_url: 'https://kdn.agency',
  target_customer: 'Small professional services firms',
  generated_at: '2026-07-27',
  verdict: 'Two qualified prospects',
  prospects: [
    {
      name: 'Lea Hough & Co LLP',
      type: 'Partnership · Chartered surveying',
      stage: 'High intent',
      score: 97,
      pain_signal: 'A graduate role owns practice-wide AI adoption.',
      evidence: 'Current public vacancy.',
      why_fit: 'Implementation mandate exceeds the role.',
      why_now: 'The vacancy is active.',
      source_title: 'Business Development & Marketing Graduate',
      source_url: 'https://example.test/lea-hough',
      source_type: 'Current public listing',
      signal_date: '2026-07-27',
      suggested_channel: 'LinkedIn',
      opener: 'Hi Michael — I saw the AI adoption brief.',
      caution: 'Revalidate before outreach.',
      dimensions: { pain_strength: 5, product_fit: 5 },
      secondary_sources: [{ title: 'Our People', url: 'https://example.test/team', supports: 'Team structure' }],
    },
    {
      name: 'Joint Inspection Group',
      stage: 'High intent',
      score: 95,
      pain_signal: 'A seven-person team coordinates auditable documents.',
      source_url: 'https://example.test/jig',
    },
  ],
  patterns: [{ title: 'The role arrives first' }],
  outreach_plan: { first_step: 'Contact manually' },
  limits: ['Public sources only'],
  excluded_candidates: [{ name: 'Expired Ltd', reason: 'Signal expired' }],
};

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();
  legacyLeadStageId = ulid();
  qualifiedStageId = ulid();
  await db.insert(schema.dealStages).values([
    { id: legacyLeadStageId, name: 'Lead', position: 0, probability: 10 },
    { id: qualifiedStageId, name: 'Qualified', position: 1, probability: 30 },
  ]);
});

describe('research import and daily work', () => {
  let leadId: string;
  let companyId: string;

  it('previews active prospects and retained exclusions without writing data', async () => {
    const preview = await json(reqAs(users.owner!.cookie).post('/leads/import/preview', research));
    expect(preview).toMatchObject({ prospects: 2, companiesToCreate: 2, leadsToCreate: 2, exclusions: 1 });
    expect((await json(reqAs(users.owner!.cookie).get('/leads'))).data).toHaveLength(0);
  });

  it('does not double-count duplicate prospects in an import preview', async () => {
    const duplicate = {
      ...research,
      title: 'Duplicate preview',
      prospects: [research.prospects[0], { ...research.prospects[0] }],
    };
    const preview = await json(reqAs(users.owner!.cookie).post('/leads/import/preview', duplicate));
    expect(preview).toMatchObject({ prospects: 2, companiesToCreate: 1, leadsToCreate: 1 });
    expect(preview.matches.map((match: any) => match.action)).toEqual(['create_company_and_lead', 'skip']);
  });

  it('imports structured leads idempotently and creates their review actions', async () => {
    const first = await json(reqAs(users.owner!.cookie).post('/leads/import', research));
    expect(first).toMatchObject({ createdCompanies: 2, createdLeads: 2, exclusions: 1 });
    const second = await json(reqAs(users.owner!.cookie).post('/leads/import', research));
    expect(second).toMatchObject({ createdCompanies: 0, createdLeads: 0, exclusions: 1 });

    const leads = (await json(reqAs(users.owner!.cookie).get('/leads'))).data;
    expect(leads).toHaveLength(2);
    const lea = leads.find((lead: any) => lead.title === 'Lea Hough & Co LLP');
    expect(lea).toMatchObject({
      score: 97,
      status: 'needs_review',
      painSignal: 'A graduate role owns practice-wide AI adoption.',
      opener: 'Hi Michael — I saw the AI adoption brief.',
      sourceCheckedAt: '2026-07-27T00:00:00.000Z',
    });
    leadId = lea.id;
    companyId = lea.companyId;

    const activities = (await json(reqAs(users.owner!.cookie).get(`/sales-activities?leadId=${leadId}`))).data;
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ type: 'review', status: 'planned' });
  });

  it('completes outreach and schedules the follow-up in one command', async () => {
    const existing = (await json(reqAs(users.owner!.cookie).get(`/sales-activities?leadId=${leadId}`))).data[0];
    const dueAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const res = await reqAs(users.owner!.cookie).post(`/sales-activities/${existing.id}/complete`, {
      outcome: 'LinkedIn message sent manually',
      leadStatus: 'waiting_reply',
      nextActivity: { type: 'follow_up', channel: 'linkedin', dueAt },
    });
    expect(res.status).toBe(200);

    const activities = (await json(reqAs(users.owner!.cookie).get(`/sales-activities?leadId=${leadId}`))).data;
    expect(activities.map((a: any) => a.status)).toEqual(['planned', 'completed']);
    expect((await json(reqAs(users.owner!.cookie).get(`/leads/${leadId}`))).status).toBe('waiting_reply');
  });

  it('derives waiting and no-next-action queues', async () => {
    const noAction = await json(reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Second workflow',
      product: 'Automation audit',
      status: 'ready',
    }));
    const nurtureWithoutDate = await json(reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Nurture without a date',
      status: 'nurture',
    }));
    const work = await json(reqAs(users.owner!.cookie).get('/sales-work'));
    expect(work.waitingReply.some((row: any) => row.id === leadId)).toBe(true);
    expect(work.noNextAction.some((row: any) => row.id === noAction.id)).toBe(true);
    expect(work.noNextAction.some((row: any) => row.id === nurtureWithoutDate.id)).toBe(true);
  });

  it('keeps converted status behind the conversion action and rejects unsafe source links', async () => {
    const converted = await reqAs(users.owner!.cookie).patch(`/leads/${leadId}`, { status: 'converted' });
    expect(converted.status).toBe(400);
    const unsafeLink = await reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Unsafe link',
      sourceUrl: 'javascript:alert(1)',
    });
    expect(unsafeLink.status).toBe(400);
    const malformedLink = await reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Malformed link',
      sourceUrl: 'not a URL',
    });
    expect(malformedLink.status).toBe(400);
  });

  it('stops follow-ups when a lead reaches a terminal outcome', async () => {
    const terminalLead = await json(reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Terminal outcome',
      status: 'ready',
    }));
    const dueAt = new Date(Date.now() + 86_400_000).toISOString();
    const first = await json(reqAs(users.owner!.cookie).post('/sales-activities', {
      leadId: terminalLead.id,
      type: 'outreach',
      dueAt,
    }));
    await reqAs(users.owner!.cookie).post('/sales-activities', {
      leadId: terminalLead.id,
      type: 'follow_up',
      dueAt,
    });

    const invalid = await reqAs(users.owner!.cookie).post(`/sales-activities/${first.id}/complete`, {
      leadStatus: 'disqualified',
      nextActivity: { type: 'follow_up', dueAt },
    });
    expect(invalid.status).toBe(400);

    const completed = await reqAs(users.owner!.cookie).post(`/sales-activities/${first.id}/complete`, {
      leadStatus: 'disqualified',
      outcome: 'Not a fit',
    });
    expect(completed.status).toBe(200);
    const activities = (await json(reqAs(users.owner!.cookie).get(`/sales-activities?leadId=${terminalLead.id}`))).data;
    expect(activities.map((activity: any) => activity.status).sort()).toEqual(['cancelled', 'completed']);
  });

  it('enforces CRM write permission', async () => {
    const res = await reqAs(users.member!.cookie).post('/leads', {
      companyId,
      title: 'Member cannot create',
    });
    expect(res.status).toBe(403);
  });
});

describe('sales activity data integrity', () => {
  it('requires exactly one lead or deal parent at the database boundary', async () => {
    const { db } = getDb();
    const companyId = ulid();
    await db.insert(schema.companies).values({ id: companyId, name: 'Parent Check', createdBy: users.owner!.userId });
    await expect(db.insert(schema.salesActivities).values({
      id: ulid(),
      companyId,
      type: 'review',
      status: 'planned',
      dueAt: new Date(),
      createdBy: users.owner!.userId,
    })).rejects.toThrow();
  });
});

describe('lead and deal boundary', () => {
  it('converts once and preserves notes, files, research and planned work', async () => {
    const { db } = getDb();
    const leads = (await json(reqAs(users.owner!.cookie).get('/leads?q=Lea%20Hough'))).data;
    const lead = leads[0];
    await reqAs(users.owner!.cookie).patch(`/leads/${lead.id}`, { status: 'engaged', version: lead.version });
    await reqAs(users.owner!.cookie).post('/notes', {
      leadId: lead.id,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pain confirmed' }] }] },
    });
    const file = await json(reqAs(users.owner!.cookie).post('/attachments/register', {
      entityType: 'lead',
      entityId: lead.id,
      fileKey: 'uploads/research.pdf',
      filename: 'research.pdf',
      size: 20,
      mime: 'application/pdf',
    }));

    const otherCompanyId = ulid();
    const otherContactId = ulid();
    await db.insert(schema.companies).values({ id: otherCompanyId, name: 'Other Company', createdBy: users.owner!.userId });
    await db.insert(schema.contacts).values({
      id: otherContactId,
      companyId: otherCompanyId,
      firstName: 'Wrong',
      lastName: 'Contact',
      createdBy: users.owner!.userId,
    });
    const legacyStage = await reqAs(users.owner!.cookie).post(`/leads/${lead.id}/convert`, {
      stageId: legacyLeadStageId,
    });
    expect(legacyStage.status).toBe(400);
    const invalidContact = await reqAs(users.owner!.cookie).post(`/leads/${lead.id}/convert`, {
      stageId: qualifiedStageId,
      contactId: otherContactId,
    });
    expect(invalidContact.status).toBe(400);

    const converted = await json(reqAs(users.owner!.cookie).post(`/leads/${lead.id}/convert`, {
      stageId: qualifiedStageId,
    }));
    const retry = await json(reqAs(users.owner!.cookie).post(`/leads/${lead.id}/convert`, {
      stageId: qualifiedStageId,
    }));
    expect(retry.dealId).toBe(converted.dealId);

    const deal = await json(reqAs(users.owner!.cookie).get(`/deals/${converted.dealId}`));
    expect(deal).toMatchObject({ sourceLeadId: lead.id, companyId: lead.companyId, amount: null });
    expect((await json(reqAs(users.owner!.cookie).get(`/leads/${lead.id}`))).status).toBe('converted');
    expect((await json(reqAs(users.owner!.cookie).get(`/notes?dealId=${deal.id}`))).data).toHaveLength(1);
    expect((await json(reqAs(users.owner!.cookie).get(`/attachments?entityType=deal&entityId=${deal.id}`))).data[0].id).toBe(file.id);
    expect((await json(reqAs(users.owner!.cookie).get(`/sales-activities?dealId=${deal.id}`))).data.length).toBeGreaterThan(0);
  });

  it('demotes a legacy Lead-stage deal without losing its note', async () => {
    const { db } = getDb();
    const companyId = ulid();
    const dealId = ulid();
    await db.insert(schema.companies).values({ id: companyId, name: 'Legacy Prospect', createdBy: users.owner!.userId });
    await db.insert(schema.deals).values({
      id: dealId,
      companyId,
      stageId: legacyLeadStageId,
      title: 'Legacy speculative deal',
      amount: '9000',
      currency: 'GBP',
      createdBy: users.owner!.userId,
    });
    await reqAs(users.owner!.cookie).post('/notes', {
      dealId,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original research' }] }] },
    });

    const result = await json(reqAs(users.owner!.cookie).post(`/deals/${dealId}/demote-to-lead`, {}));
    const lead = await json(reqAs(users.owner!.cookie).get(`/leads/${result.leadId}`));
    expect(lead).toMatchObject({ legacyDealId: dealId, title: 'Legacy speculative deal', status: 'needs_review' });
    expect((await reqAs(users.owner!.cookie).get(`/deals/${dealId}`)).status).toBe(404);
    expect((await json(reqAs(users.owner!.cookie).get(`/notes?leadId=${lead.id}`))).data).toHaveLength(1);

    const [rawDeal] = await db.select().from(schema.deals).where(eq(schema.deals.id, dealId));
    expect(rawDeal?.deletedAt).not.toBeNull();
  });
});
