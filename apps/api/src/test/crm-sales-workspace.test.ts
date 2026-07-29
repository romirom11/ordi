import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, schema, eq, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { json, reqAs, resetDb, seedRolesAndUsers } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let qualifiedStageId: string;
let legacyLeadStageId: string;
let nurtureDealStageId: string;

function localDateAfter(days: number): string {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function zonedDateKey(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: string) => parts.find((item) => item.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function offsetAt(value: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(value);
  const number = (type: string) => Number(parts.find((item) => item.type === type)!.value);
  const wallAsUtc = Date.UTC(
    number('year'),
    number('month') - 1,
    number('day'),
    number('hour'),
    number('minute'),
    number('second'),
  );
  return wallAsUtc - Math.floor(value.getTime() / 1000) * 1000;
}

function zonedMidnight(dateKey: string, timeZone: string): Date {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  const wallAsUtc = Date.UTC(year, month - 1, day);
  let instant = wallAsUtc;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = wallAsUtc - offsetAt(new Date(instant), timeZone);
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}

function nextDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

function timezoneBoundaryCase(now: Date): { timeZone: string; dueAt: Date } {
  const serverStart = new Date(now);
  serverStart.setHours(0, 0, 0, 0);
  const serverNext = new Date(serverStart);
  serverNext.setDate(serverNext.getDate() + 1);

  for (const timeZone of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
    const today = zonedDateKey(now, timeZone);
    const start = zonedMidnight(today, timeZone).getTime();
    const next = zonedMidnight(nextDateKey(today), timeZone).getTime();
    for (const candidate of [start + 60_000, next - 60_000]) {
      if (candidate < serverStart.getTime() || candidate >= serverNext.getTime()) {
        return { timeZone, dueAt: new Date(candidate) };
      }
    }
  }
  throw new Error('Could not find a timezone boundary outside the server-local day');
}

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
      source_url: 'https://uk.indeed.com/viewjob?jk=lea-hough',
      source_type: 'Current public listing',
      signal_date: '2026-07-27',
      suggested_channel: 'LinkedIn',
      opener: 'Hi Michael — I saw the AI adoption brief.',
      caution: 'Revalidate before outreach.',
      dimensions: { pain_strength: 5, product_fit: 5 },
      secondary_sources: [{ title: 'Our People', url: 'https://www.leahough.co.uk/our-people/', supports: 'Team structure' }],
    },
    {
      name: 'Joint Inspection Group',
      stage: 'High intent',
      score: 95,
      pain_signal: 'A seven-person team coordinates auditable documents.',
      source_url: 'https://uk.indeed.com/viewjob?jk=jig',
      secondary_sources: [{ title: 'JIG Team', url: 'https://www.jig.org/about/company-structure/jig-staff/' }],
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
  nurtureDealStageId = ulid();
  await db.insert(schema.dealStages).values([
    { id: legacyLeadStageId, name: 'Lead', position: 0, probability: 10 },
    { id: qualifiedStageId, name: 'Qualified', position: 1, probability: 30 },
    { id: nurtureDealStageId, name: 'Nurture', position: 2, probability: 20 },
  ]);
});

describe('research import and daily work', () => {
  let leadId: string;
  let companyId: string;

  it('keeps the legacy Lead stage out of the qualified pipeline', async () => {
    const stages = (await json(reqAs(users.owner!.cookie).get('/deal-stages'))).data;
    expect(stages.some((stage: any) => stage.name.trim().toLowerCase() === 'lead')).toBe(false);

    const recreate = await reqAs(users.owner!.cookie).post('/deal-stages', {
      name: ' Lead ',
      position: 0,
      probability: 10,
    });
    expect(recreate.status).toBe(400);
  });

  it('rejects creating or moving an opportunity into a legacy Lead stage', async () => {
    const { db } = getDb();
    const pipelineCompanyId = ulid();
    await db.insert(schema.companies).values({
      id: pipelineCompanyId,
      name: 'Qualified Pipeline Ltd',
      createdBy: users.owner!.userId,
    });

    const direct = await reqAs(users.owner!.cookie).post('/deals', {
      companyId: pipelineCompanyId,
      title: 'Not qualified',
      stageId: legacyLeadStageId,
    });
    expect(direct.status).toBe(400);

    const qualified = await json(reqAs(users.owner!.cookie).post('/deals', {
      companyId: pipelineCompanyId,
      title: 'Qualified opportunity',
      stageId: qualifiedStageId,
    }));
    const move = await reqAs(users.owner!.cookie).post(`/deals/${qualified.id}/move`, {
      stageId: legacyLeadStageId,
    });
    expect(move.status).toBe(400);

    const current = await json(reqAs(users.owner!.cookie).get(`/deals/${qualified.id}`));
    const patch = await reqAs(users.owner!.cookie).patch(`/deals/${qualified.id}`, {
      stageId: legacyLeadStageId,
      version: current.version,
    });
    expect(patch.status).toBe(400);
  });

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
      nextActivity: { type: 'review', status: 'planned' },
    });
    leadId = lea.id;
    companyId = lea.companyId;

    const activities = (await json(reqAs(users.owner!.cookie).get(`/sales-activities?leadId=${leadId}`))).data;
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ type: 'review', status: 'planned' });
  });

  it('matches company aliases by domain before normalized name', async () => {
    const preview = await json(reqAs(users.owner!.cookie).post('/leads/import/preview', {
      ...research,
      title: 'Domain alias preview',
      prospects: [{
        ...research.prospects[0],
        name: 'Lea Hough and Co',
        company_url: 'https://leahough.co.uk',
      }],
    }));
    expect(preview).toMatchObject({ companiesToCreate: 0, leadsToCreate: 0 });
    expect(preview.matches[0]).toMatchObject({ companyId, action: 'skip', domain: 'leahough.co.uk' });
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

  it('derives owner-scoped waiting and no-next-action queues', async () => {
    const noAction = await json(reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Second workflow',
      product: 'Automation audit',
      status: 'ready',
    }));
    const nurtureWithoutDate = await reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Nurture without a date',
      status: 'nurture',
    });
    const someoneElsesLead = await json(reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Owned by another seller',
      status: 'ready',
      ownerId: users.member!.userId,
    }));
    const ownerlessDeal = await json(reqAs(users.owner!.cookie).post('/deals', {
      companyId,
      title: 'Unassigned deal',
      stageId: qualifiedStageId,
    }));
    const workResponse = await reqAs(users.owner!.cookie).get('/sales-work');
    expect(workResponse.status, await workResponse.clone().text()).toBe(200);
    const work = await json(workResponse);
    expect(nurtureWithoutDate.status).toBe(400);
    expect(work.waitingReply.rows.some((row: any) => row.id === leadId)).toBe(true);
    expect(work.noNextAction.rows.some((row: any) => row.id === noAction.id)).toBe(true);
    expect(work.noNextAction.rows.some((row: any) => row.id === ownerlessDeal.id)).toBe(true);
    expect(Object.values(work).flatMap((bucket: any) => bucket.rows)
      .some((row: any) => row.id === someoneElsesLead.id)).toBe(false);
    const teamWork = await json(reqAs(users.owner!.cookie).get('/sales-work?scope=all'));
    expect(teamWork.noNextAction.rows.some((row: any) => row.id === someoneElsesLead.id)).toBe(true);
    const bounded = await json(reqAs(users.owner!.cookie).get('/sales-work?scope=all&limit=1'));
    expect(Object.values(bounded).every((bucket: any) => bucket.rows.length <= 1)).toBe(true);
    expect(bounded.noNextAction.rows).toHaveLength(1);
    expect(bounded.noNextAction.total).toBeGreaterThan(1);
  });

  it('snoozes nurture independently and returns it only on the chosen date', async () => {
    const nurtureLead = await json(reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Nurture return date',
      status: 'ready',
    }));
    const activity = await json(reqAs(users.owner!.cookie).post('/sales-activities', {
      leadId: nurtureLead.id,
      type: 'follow_up',
      dueAt: new Date().toISOString(),
    }));
    const conflictingActivity = await json(reqAs(users.owner!.cookie).post('/sales-activities', {
      leadId: nurtureLead.id,
      type: 'follow_up',
      dueAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    }));
    const missingDate = await reqAs(users.owner!.cookie).post(`/sales-activities/${activity.id}/complete`, {
      leadStatus: 'nurture',
    });
    expect(missingDate.status).toBe(400);

    const tomorrow = localDateAfter(1);
    const conflictingFollowUp = await reqAs(users.owner!.cookie).post(`/sales-activities/${activity.id}/complete`, {
      leadStatus: 'nurture',
      nurtureUntil: tomorrow,
      nextActivity: {
        type: 'follow_up',
        dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      },
    });
    expect(conflictingFollowUp.status).toBe(400);
    const completed = await reqAs(users.owner!.cookie).post(`/sales-activities/${activity.id}/complete`, {
      leadStatus: 'nurture',
      nurtureUntil: tomorrow,
    });
    expect(completed.status).toBe(200);
    const snoozed = await json(reqAs(users.owner!.cookie).get(`/leads/${nurtureLead.id}`));
    expect(snoozed).toMatchObject({ status: 'nurture', nurtureUntil: tomorrow });
    const parkedActivities = (await json(reqAs(users.owner!.cookie)
      .get(`/sales-activities?leadId=${nurtureLead.id}`))).data;
    expect(parkedActivities.find((row: any) => row.id === conflictingActivity.id)?.status).toBe('cancelled');
    const beforeReturn = await json(reqAs(users.owner!.cookie).get('/sales-work'));
    expect(Object.values(beforeReturn).flatMap((bucket: any) => bucket.rows)
      .some((row: any) => row.id === nurtureLead.id)).toBe(false);

    const today = localDateAfter(0);
    await reqAs(users.owner!.cookie).patch(`/leads/${nurtureLead.id}`, {
      nurtureUntil: today,
      version: snoozed.version,
    });
    const due = await json(reqAs(users.owner!.cookie).get('/sales-work'));
    expect(due.nurtureDue.rows.some((row: any) => row.id === nurtureLead.id)).toBe(true);

    const resumedActivity = await reqAs(users.owner!.cookie).post('/sales-activities', {
      leadId: nurtureLead.id,
      type: 'follow_up',
      dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    });
    expect(resumedActivity.status).toBe(201);
    const resumedActivityId = ((await resumedActivity.json()) as { id: string }).id;
    const resumed = await json(reqAs(users.owner!.cookie).get(`/leads/${nurtureLead.id}`));
    expect(resumed).toMatchObject({ status: 'ready', nurtureUntil: null });
    const resumedActivities = (await json(reqAs(users.owner!.cookie)
      .get(`/sales-activities?leadId=${nurtureLead.id}`))).data;
    expect(resumedActivities.find((row: any) => row.id === resumedActivityId)?.status).toBe('planned');
    const afterResume = await json(reqAs(users.owner!.cookie).get('/sales-work'));
    expect(afterResume.nurtureDue.rows.some((row: any) => row.id === nurtureLead.id)).toBe(false);
  });

  it('keeps deal stage names out of lead lifecycle classification', async () => {
    const deal = await json(reqAs(users.owner!.cookie).post('/deals', {
      companyId,
      title: 'Deal in a stage named Nurture',
      stageId: nurtureDealStageId,
      ownerId: users.owner!.userId,
    }));
    const work = await json(reqAs(users.owner!.cookie).get('/sales-work'));
    expect(work.noNextAction.rows.some((row: any) => row.id === deal.id && row.entityType === 'deal')).toBe(true);
  });

  it('uses the current seller timezone for due-today boundaries', async () => {
    const { db } = getDb();
    const boundary = timezoneBoundaryCase(new Date());
    await db.update(schema.users).set({ timezone: boundary.timeZone })
      .where(eq(schema.users.id, users.owner!.userId));
    try {
      const lead = await json(reqAs(users.owner!.cookie).post('/leads', {
        companyId,
        title: 'Timezone boundary',
        status: 'ready',
      }));
      await reqAs(users.owner!.cookie).post('/sales-activities', {
        leadId: lead.id,
        type: 'follow_up',
        dueAt: boundary.dueAt.toISOString(),
      });

      const work = await json(reqAs(users.owner!.cookie).get('/sales-work'));
      expect(work.dueToday.rows.some((row: any) => row.id === lead.id)).toBe(true);
      expect(work.overdue.rows.some((row: any) => row.id === lead.id)).toBe(false);
    } finally {
      await db.update(schema.users).set({ timezone: 'UTC' })
        .where(eq(schema.users.id, users.owner!.userId));
    }
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
    const invalidNurtureDate = await reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Invalid nurture date',
      nurtureUntil: 'next quarter',
    });
    expect(invalidNurtureDate.status).toBe(400);
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
  it('edits and cancels planned activities with optimistic locking and audit history', async () => {
    const { db } = getDb();
    const companyId = ulid();
    await db.insert(schema.companies).values({
      id: companyId,
      name: 'Activity Lifecycle',
      createdBy: users.owner!.userId,
    });
    const lead = await json(reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Activity lifecycle lead',
      status: 'ready',
    }));
    const editId = (await json(reqAs(users.owner!.cookie).post('/sales-activities', {
      leadId: lead.id,
      type: 'follow_up',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    }))).id;
    const cancelId = (await json(reqAs(users.owner!.cookie).post('/sales-activities', {
      leadId: lead.id,
      type: 'call',
      dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    }))).id;
    const before = (await json(reqAs(users.owner!.cookie)
      .get(`/sales-activities?leadId=${lead.id}`))).data;
    const editBefore = before.find((activity: any) => activity.id === editId);
    const cancelBefore = before.find((activity: any) => activity.id === cancelId);
    const dueAt = new Date(Date.now() + 3 * 86_400_000).toISOString();

    const edited = await json(reqAs(users.owner!.cookie).patch(`/sales-activities/${editId}`, {
      type: 'meeting',
      subject: 'Discovery call',
      dueAt,
      version: editBefore.version,
    }));
    expect(edited).toMatchObject({
      id: editId,
      type: 'meeting',
      subject: 'Discovery call',
      status: 'planned',
      version: editBefore.version + 1,
    });
    const stale = await reqAs(users.owner!.cookie).patch(`/sales-activities/${editId}`, {
      subject: 'Stale edit',
      version: editBefore.version,
    });
    expect(stale.status).toBe(409);

    const cancelled = await reqAs(users.owner!.cookie).post(`/sales-activities/${cancelId}/cancel`, {
      version: cancelBefore.version,
    });
    expect(cancelled.status).toBe(200);
    const invalidVersion = await reqAs(users.owner!.cookie).post(`/sales-activities/${editId}/cancel`, {
      version: 'wrong',
    });
    expect(invalidVersion.status).toBe(400);

    const after = (await json(reqAs(users.owner!.cookie)
      .get(`/sales-activities?leadId=${lead.id}`))).data;
    expect(after.find((activity: any) => activity.id === cancelId).status).toBe('cancelled');
    const audit = await db.select().from(schema.activityLog).where(eq(schema.activityLog.entityId, lead.id));
    expect(audit.filter((row) => row.action === 'sales_activity_updated')).toHaveLength(1);
    expect(audit.filter((row) => row.action === 'sales_activity_cancelled')).toHaveLength(1);
  });

  it('rolls back an activity edit when its audit write fails', async () => {
    const { db } = getDb();
    const companyId = ulid();
    await db.insert(schema.companies).values({
      id: companyId,
      name: 'Atomic Activity Edit',
      createdBy: users.owner!.userId,
    });
    const lead = await json(reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Atomic edit lead',
      status: 'ready',
    }));
    const created = await json(reqAs(users.owner!.cookie).post('/sales-activities', {
      leadId: lead.id,
      type: 'follow_up',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    }));
    const before = (await json(reqAs(users.owner!.cookie)
      .get(`/sales-activities?leadId=${lead.id}`))).data[0];

    await db.execute(sql.raw(`
      alter table activity_log
      add constraint activity_log_test_no_sales_activity_updated
      check (action <> 'sales_activity_updated') not valid
    `));
    try {
      const response = await reqAs(users.owner!.cookie).patch(`/sales-activities/${created.id}`, {
        subject: 'Rejected atomic edit',
        version: before.version,
      });
      expect(response.status).toBe(500);

      const after = (await json(reqAs(users.owner!.cookie)
        .get(`/sales-activities?leadId=${lead.id}`))).data[0];
      expect(after).toMatchObject({
        id: created.id,
        subject: null,
        version: before.version,
      });
    } finally {
      await db.execute(sql.raw(`
        alter table activity_log
        drop constraint if exists activity_log_test_no_sales_activity_updated
      `));
    }
  });

  it('rolls back an activity cancellation when its audit write fails', async () => {
    const { db } = getDb();
    const companyId = ulid();
    await db.insert(schema.companies).values({
      id: companyId,
      name: 'Atomic Activity Cancel',
      createdBy: users.owner!.userId,
    });
    const lead = await json(reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Atomic cancel lead',
      status: 'ready',
    }));
    const created = await json(reqAs(users.owner!.cookie).post('/sales-activities', {
      leadId: lead.id,
      type: 'follow_up',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    }));
    const before = (await json(reqAs(users.owner!.cookie)
      .get(`/sales-activities?leadId=${lead.id}`))).data[0];

    await db.execute(sql.raw(`
      alter table activity_log
      add constraint activity_log_test_no_sales_activity_cancelled
      check (action <> 'sales_activity_cancelled') not valid
    `));
    try {
      const response = await reqAs(users.owner!.cookie).post(`/sales-activities/${created.id}/cancel`, {
        version: before.version,
      });
      expect(response.status).toBe(500);

      const after = (await json(reqAs(users.owner!.cookie)
        .get(`/sales-activities?leadId=${lead.id}`))).data[0];
      expect(after).toMatchObject({
        id: created.id,
        status: 'planned',
        version: before.version,
      });
    } finally {
      await db.execute(sql.raw(`
        alter table activity_log
        drop constraint if exists activity_log_test_no_sales_activity_cancelled
      `));
    }
  });

  it('rolls back a lead transition when cancelling its activities fails', async () => {
    const { db } = getDb();
    const companyId = ulid();
    await db.insert(schema.companies).values({
      id: companyId,
      name: 'Atomic Lead Update',
      createdBy: users.owner!.userId,
    });
    const lead = await json(reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Atomic transition',
      status: 'ready',
    }));
    await reqAs(users.owner!.cookie).post('/sales-activities', {
      leadId: lead.id,
      type: 'follow_up',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const before = await json(reqAs(users.owner!.cookie).get(`/leads/${lead.id}`));

    await db.execute(sql.raw(`
      alter table sales_activities
      add constraint sales_activities_test_no_cancelled
      check (status <> 'cancelled') not valid
    `));
    try {
      const response = await reqAs(users.owner!.cookie).patch(`/leads/${lead.id}`, {
        status: 'nurture',
        nurtureUntil: localDateAfter(30),
        version: before.version,
      });
      expect(response.status).toBe(500);

      const after = await json(reqAs(users.owner!.cookie).get(`/leads/${lead.id}`));
      expect(after).toMatchObject({
        status: 'ready',
        nurtureUntil: null,
        version: before.version,
      });
      const activities = (await json(reqAs(users.owner!.cookie)
        .get(`/sales-activities?leadId=${lead.id}`))).data;
      expect(activities).toHaveLength(1);
      expect(activities[0].status).toBe('planned');
    } finally {
      await db.execute(sql.raw(`
        alter table sales_activities
        drop constraint if exists sales_activities_test_no_cancelled
      `));
    }
  });

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

  it('requires a due date for every sales activity and rejects clearing it', async () => {
    const { db } = getDb();
    const companyId = ulid();
    const leadId = ulid();
    await db.insert(schema.companies).values({ id: companyId, name: 'Due Date Check', createdBy: users.owner!.userId });
    await db.insert(schema.leads).values({
      id: leadId,
      companyId,
      title: 'Due date lead',
      createdBy: users.owner!.userId,
    });
    await expect(db.insert(schema.salesActivities).values({
      id: ulid(),
      leadId,
      companyId,
      type: 'review',
      status: 'planned',
      createdBy: users.owner!.userId,
    } as any)).rejects.toThrow();

    const activity = await json(reqAs(users.owner!.cookie).post('/sales-activities', {
      leadId,
      type: 'review',
      dueAt: new Date().toISOString(),
    }));
    expect((await reqAs(users.owner!.cookie).patch(`/sales-activities/${activity.id}`, {
      dueAt: null,
    })).status).toBe(400);
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
    const filePresign = await json(reqAs(users.owner!.cookie).post('/attachments/presign', {
      filename: 'research.pdf', size: 20, mime: 'application/pdf',
      entityType: 'lead', entityId: lead.id,
    }));
    const file = await json(reqAs(users.owner!.cookie).post('/attachments/register', {
      entityType: 'lead',
      entityId: lead.id,
      fileKey: filePresign.fileKey,
      keyToken: filePresign.keyToken,
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
    const listedDeal = (await json(reqAs(users.owner!.cookie).get('/deals'))).data
      .find((row: any) => row.id === deal.id);
    expect(listedDeal.nextActivity).toMatchObject({ dealId: deal.id, status: 'planned' });
  });

});
