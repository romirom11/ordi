import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getDb, schema, eq, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { json, reqAs, resetDb, seedRolesAndUsers } from './helpers';

vi.mock('../lib/s3', () => import('./s3-mock'));

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let qualifiedStageId: string;
let leadNamedStageId: string;
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

/**
 * Leads are created through the normal API now that the research-JSON import is
 * gone. Two of them, so the queue tests still have more than one row to sort.
 */
const seedLeads = [
  {
    title: 'Lea Hough & Co LLP',
    product: 'AI workflow pilot',
    status: 'needs_review',
    score: 97,
    signal: 'High intent · Partnership',
    painSignal: 'A graduate role owns practice-wide AI adoption.',
    evidence: 'Current public vacancy.',
    whyFit: 'Implementation mandate exceeds the role.',
    whyNow: 'The vacancy is active.',
    sourceTitle: 'Business Development & Marketing Graduate',
    sourceUrl: 'https://www.leahough.co.uk/careers/',
    sourceType: 'Current public listing',
    signalDate: '2026-07-27',
    sourceCheckedAt: '2026-07-27T00:00:00.000Z',
    suggestedChannel: 'LinkedIn',
    opener: 'Hi Michael — I saw the AI adoption brief.',
    caution: 'Revalidate before outreach.',
  },
  {
    title: 'Joint Inspection Group',
    product: 'AI workflow pilot',
    status: 'needs_review',
    score: 95,
    signal: 'High intent',
    painSignal: 'A seven-person team coordinates auditable documents.',
    sourceUrl: 'https://www.jig.org/about/',
  },
];

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();
  leadNamedStageId = ulid();
  qualifiedStageId = ulid();
  nurtureDealStageId = ulid();
  await db.insert(schema.dealStages).values([
    { id: leadNamedStageId, name: 'Lead', position: 0, probability: 10 },
    { id: qualifiedStageId, name: 'Qualified', position: 1, probability: 30 },
    { id: nurtureDealStageId, name: 'Nurture', position: 2, probability: 20 },
  ]);
});

describe('lead intake and daily work', () => {
  let leadId: string;
  let companyId: string;

  it('lets a pipeline stage carry any name, including Lead', async () => {
    const stages = (await json(reqAs(users.owner!.cookie).get('/deal-stages'))).data;
    expect(stages.some((stage: any) => stage.id === leadNamedStageId)).toBe(true);

    const created = await reqAs(users.owner!.cookie).post('/deal-stages', {
      name: ' Lead ',
      position: 9,
      probability: 10,
    });
    expect(created.status).toBe(201);
  });

  it('accepts any configured stage and still refuses an unknown id', async () => {
    const { db } = getDb();
    const pipelineCompanyId = ulid();
    await db.insert(schema.companies).values({
      id: pipelineCompanyId,
      name: 'Qualified Pipeline Ltd',
      createdBy: users.owner!.userId,
    });

    const unknown = await reqAs(users.owner!.cookie).post('/deals', {
      companyId: pipelineCompanyId,
      title: 'Nowhere stage',
      stageId: ulid(),
    });
    expect(unknown.status).toBe(400);

    const qualified = await json(reqAs(users.owner!.cookie).post('/deals', {
      companyId: pipelineCompanyId,
      title: 'Qualified opportunity',
      stageId: qualifiedStageId,
    }));
    const move = await reqAs(users.owner!.cookie).post(`/deals/${qualified.id}/move`, {
      stageId: leadNamedStageId,
    });
    expect(move.status).toBe(200);

    const current = await json(reqAs(users.owner!.cookie).get(`/deals/${qualified.id}`));
    const patch = await reqAs(users.owner!.cookie).patch(`/deals/${qualified.id}`, {
      stageId: qualifiedStageId,
      version: current.version,
    });
    expect(patch.status).toBe(200);
    const stale = await reqAs(users.owner!.cookie).patch(`/deals/${qualified.id}`, {
      title: 'Stale write',
      version: current.version,
    });
    expect(stale.status).toBe(409);
  });

  it('stores a lead with its qualification notes and its first review action', async () => {
    companyId = (await json(reqAs(users.owner!.cookie).post('/companies', {
      name: 'Lea Hough & Co LLP',
      domain: 'leahough.co.uk',
    }))).id;
    for (const seed of seedLeads) {
      const created = await reqAs(users.owner!.cookie).post('/leads', { companyId, ...seed });
      expect(created.status, await created.clone().text()).toBe(201);
    }

    const leads = (await json(reqAs(users.owner!.cookie).get('/leads'))).data;
    expect(leads).toHaveLength(2);
    const lea = leads.find((lead: any) => lead.title === 'Lea Hough & Co LLP');
    expect(lea).toMatchObject({
      score: 97,
      status: 'needs_review',
      painSignal: 'A graduate role owns practice-wide AI adoption.',
      opener: 'Hi Michael — I saw the AI adoption brief.',
      sourceCheckedAt: '2026-07-27T00:00:00.000Z',
      nextActivity: null,
    });
    leadId = lea.id;

    const review = await reqAs(users.owner!.cookie).post('/sales-activities', {
      leadId,
      type: 'review',
      subject: 'Validate signal and choose outreach',
      dueAt: new Date().toISOString(),
    });
    expect(review.status).toBe(201);

    const activities = (await json(reqAs(users.owner!.cookie).get(`/sales-activities?leadId=${leadId}`))).data;
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({ type: 'review', status: 'planned' });
  });

  it('no longer exposes the research import endpoints', async () => {
    for (const path of ['/leads/import', '/leads/import/preview']) {
      const res = await reqAs(users.owner!.cookie).post(path, { title: 'x', prospects: [{ name: 'y' }] });
      expect(res.status, path).toBe(404);
    }
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

  it('keeps work booked beyond today visible instead of dropping it', async () => {
    const booked = await json(reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Booked ahead',
      status: 'ready',
    }));
    await reqAs(users.owner!.cookie).post('/sales-activities', {
      leadId: booked.id,
      type: 'outreach',
      dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });

    const work = await json(reqAs(users.owner!.cookie).get('/sales-work'));
    // A lead with its next step planned belongs in `upcoming` – it used to match
    // no bucket at all and vanish from the queue entirely.
    expect(work.upcoming.rows.some((row: any) => row.id === booked.id)).toBe(true);
    expect(work.noNextAction.rows.some((row: any) => row.id === booked.id)).toBe(false);
    expect(Object.values(work).flatMap((bucket: any) => bucket.rows)
      .filter((row: any) => row.id === booked.id)).toHaveLength(1);
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
  it('converts once and preserves notes, files and planned work', async () => {
    const { db } = getDb();
    const leads = (await json(reqAs(users.owner!.cookie).get('/leads?q=Lea%20Hough'))).data;
    const lead = leads[0];
    await reqAs(users.owner!.cookie).patch(`/leads/${lead.id}`, { status: 'engaged', version: lead.version });
    await reqAs(users.owner!.cookie).post('/notes', {
      leadId: lead.id,
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Pain confirmed' }] }] },
    });
    const fileForm = new FormData();
    fileForm.append('file', new File([new Uint8Array(20)], 'research.pdf', { type: 'application/pdf' }), 'research.pdf');
    fileForm.append('entityType', 'lead');
    fileForm.append('entityId', lead.id);
    const file = await json(reqAs(users.owner!.cookie).postForm('/attachments', fileForm));

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
    const unknownStage = await reqAs(users.owner!.cookie).post(`/leads/${lead.id}/convert`, {
      stageId: ulid(),
    });
    expect(unknownStage.status).toBe(400);
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

describe('stale writes and lead cleanup', () => {
  let companyId: string;

  beforeAll(async () => {
    companyId = (await json(reqAs(users.owner!.cookie).post('/companies', {
      name: 'Stale Write Ltd',
    }))).id;
  });

  it('answers a stale company edit with 409 instead of a silent no-op', async () => {
    const before = await json(reqAs(users.owner!.cookie).get(`/companies/${companyId}`));
    const first = await reqAs(users.owner!.cookie).patch(`/companies/${companyId}`, {
      billingEmail: 'first@stale.test',
      version: before.version,
    });
    expect(first.status).toBe(200);

    // Same version the first writer used: the edit is refused, not swallowed.
    const second = await reqAs(users.owner!.cookie).patch(`/companies/${companyId}`, {
      billingEmail: 'second@stale.test',
      version: before.version,
    });
    expect(second.status).toBe(409);
    const after = await json(reqAs(users.owner!.cookie).get(`/companies/${companyId}`));
    expect(after.billingEmail).toBe('first@stale.test');
  });

  it('answers a stale contact edit with 409 and keeps the primary flag consistent', async () => {
    const primary = await json(reqAs(users.owner!.cookie).post('/contacts', {
      companyId,
      firstName: 'Ada',
      lastName: 'First',
      isPrimary: true,
    }));
    const other = await json(reqAs(users.owner!.cookie).post('/contacts', {
      companyId,
      firstName: 'Grace',
      lastName: 'Second',
    }));
    const stale = (await json(reqAs(users.owner!.cookie).get(`/contacts/${other.id}`))).version;
    expect((await reqAs(users.owner!.cookie).patch(`/contacts/${other.id}`, {
      position: 'CTO',
      version: stale,
    })).status).toBe(200);

    const conflict = await reqAs(users.owner!.cookie).patch(`/contacts/${other.id}`, {
      isPrimary: true,
      version: stale,
    });
    expect(conflict.status).toBe(409);
    // The rejected edit must not have demoted the existing primary on its way out.
    const contacts = (await json(reqAs(users.owner!.cookie).get(`/contacts?companyId=${companyId}`))).data;
    expect(contacts.find((row: any) => row.id === primary.id).isPrimary).toBe(true);
    expect(contacts.find((row: any) => row.id === other.id).isPrimary).toBe(false);
  });

  it('cancels planned work and stops the sequence when a lead is deleted', async () => {
    const { db } = getDb();
    const lead = await json(reqAs(users.owner!.cookie).post('/leads', {
      companyId,
      title: 'Deleted mid-sequence',
      status: 'ready',
    }));
    const sequenceId = (await json(reqAs(users.owner!.cookie).post('/sales-sequences', {
      name: 'Delete cleanup',
      steps: [{ activityType: 'outreach' }, { activityType: 'follow_up', delayDays: 3 }],
    }))).id;
    const enrollment = await json(reqAs(users.owner!.cookie)
      .post(`/sales-sequences/${sequenceId}/enroll`, { leadId: lead.id }));

    expect((await reqAs(users.owner!.cookie).del(`/leads/${lead.id}`)).status).toBe(200);

    const [stopped] = await db.select().from(schema.salesSequenceEnrollments)
      .where(eq(schema.salesSequenceEnrollments.id, enrollment.id));
    expect(stopped!.status).toBe('stopped');
    expect(stopped!.stoppedAt).not.toBeNull();

    const activities = await db.select().from(schema.salesActivities)
      .where(eq(schema.salesActivities.leadId, lead.id));
    expect(activities.length).toBeGreaterThan(0);
    expect(activities.every((row) => row.status === 'cancelled')).toBe(true);

    // The stopped enrollment no longer inflates the sequence's active total.
    const sequence = (await json(reqAs(users.owner!.cookie).get('/sales-sequences'))).data
      .find((row: any) => row.id === sequenceId);
    expect(sequence.activeEnrollments).toBe(0);
  });
});
