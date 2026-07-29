import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { json, reqAs, resetDb, seedRolesAndUsers } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let leadId: string;
let templateId: string;
let sequenceId: string;
let enrollmentId: string;
let firstActivityId: string;
let companyId: string;
let contactId: string;
let openStageId: string;
let wonStageId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();
  companyId = ulid();
  contactId = ulid();
  openStageId = ulid();
  wonStageId = ulid();
  leadId = ulid();
  await db.insert(schema.companies).values({ id: companyId, name: 'Lea Hough & Co LLP' });
  await db.insert(schema.contacts).values({
    id: contactId,
    companyId,
    firstName: 'Michael',
    lastName: 'Harrison',
  });
  await db.insert(schema.dealStages).values([
    { id: openStageId, name: 'Qualified', position: 10, probability: 30 },
    { id: wonStageId, name: 'Won', position: 20, probability: 100, isWon: true },
  ]);
  await db.insert(schema.leads).values({
    id: leadId,
    companyId,
    contactId,
    title: 'Lea Hough workflow pilot',
    status: 'ready',
    ownerId: users.owner!.userId,
  });
});

describe('sales templates and sequences', () => {
  it('creates a reusable message template', async () => {
    const owner = reqAs(users.owner!.cookie);
    const created = await json(owner.post('/sales-message-templates', {
      name: 'LinkedIn opener',
      activityType: 'outreach',
      channel: 'linkedin',
      subject: 'Hello {{contactFirstName}}',
      body: '{{companyName}} has a workflow opportunity. Owner: {{ownerName}}.',
    }));
    templateId = created.id;

    const listed = await json(owner.get('/sales-message-templates'));
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]).toMatchObject({
      id: templateId,
      name: 'LinkedIn opener',
      active: true,
    });
    expect((await reqAs(users.member!.cookie).post('/sales-message-templates', {
      name: 'Forbidden',
      activityType: 'outreach',
      body: 'No',
    })).status).toBe(403);
  });

  it('creates a multi-step sequence from templates and inline copy', async () => {
    const created = await json(reqAs(users.owner!.cookie).post('/sales-sequences', {
      name: 'Signal outreach',
      description: 'Manual LinkedIn touch and follow-up',
      steps: [
        { delayDays: 0, templateId },
        {
          delayDays: 5,
          activityType: 'follow_up',
          channel: 'linkedin',
          context: 'Follow up with {{contactName}} about {{leadTitle}}.',
        },
      ],
    }));
    sequenceId = created.id;

    const listed = await json(reqAs(users.owner!.cookie).get('/sales-sequences'));
    expect(listed.data[0]).toMatchObject({
      id: sequenceId,
      name: 'Signal outreach',
      active: true,
    });
    expect(listed.data[0].steps).toHaveLength(2);
    expect(listed.data[0].steps[0]).toMatchObject({
      position: 1,
      activityType: 'outreach',
      channel: 'linkedin',
    });
  });

  it('enrolls a lead and renders the first manual activity', async () => {
    const enrolled = await json(reqAs(users.owner!.cookie).post(`/sales-sequences/${sequenceId}/enroll`, {
      leadId,
    }));
    enrollmentId = enrolled.id;
    firstActivityId = enrolled.activityId;

    const activities = await json(reqAs(users.owner!.cookie).get(`/sales-activities?leadId=${leadId}`));
    expect(activities.data).toHaveLength(1);
    expect(activities.data[0]).toMatchObject({
      id: firstActivityId,
      type: 'outreach',
      channel: 'linkedin',
      subject: 'Hello Michael',
      context: 'Lea Hough & Co LLP has a workflow opportunity. Owner: Owner.',
      sequenceEnrollmentId: enrollmentId,
      messageTemplateId: templateId,
      status: 'planned',
    });
  });

  it('protects an active sequence from structural edits and manual branching', async () => {
    const owner = reqAs(users.owner!.cookie);
    const sequence = (await json(owner.get('/sales-sequences'))).data[0];
    expect((await owner.patch(`/sales-sequences/${sequenceId}`, {
      version: sequence.version,
      steps: [{ delayDays: 0, activityType: 'call' }],
    })).status).toBe(422);

    const activity = (await json(owner.get(`/sales-activities?leadId=${leadId}`))).data[0];
    const res = await owner.post(`/sales-activities/${activity.id}/complete`, {
      version: activity.version,
      nextActivity: {
        type: 'follow_up',
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    expect(res.status).toBe(422);
  });

  it('advances to the next step and completes the enrollment', async () => {
    const owner = reqAs(users.owner!.cookie);
    const first = (await json(owner.get(`/sales-activities?leadId=${leadId}`))).data
      .find((activity: { id: string }) => activity.id === firstActivityId);
    const firstCompleted = await json(owner.post(`/sales-activities/${firstActivityId}/complete`, {
      version: first.version,
      outcome: 'Message sent manually',
    }));
    expect(firstCompleted.nextActivityId).toBeTruthy();

    const activities = (await json(owner.get(`/sales-activities?leadId=${leadId}`))).data;
    const next = activities.find((activity: { id: string }) => activity.id === firstCompleted.nextActivityId);
    expect(next).toMatchObject({
      type: 'follow_up',
      channel: 'linkedin',
      context: 'Follow up with Michael Harrison about Lea Hough workflow pilot.',
      sequenceEnrollmentId: enrollmentId,
      status: 'planned',
    });
    expect(new Date(next.dueAt).getTime()).toBeGreaterThan(Date.now() + 4 * 86_400_000);

    const completed = await json(owner.post(`/sales-activities/${next.id}/complete`, {
      version: next.version,
      outcome: 'No reply',
    }));
    expect(completed.nextActivityId).toBeNull();

    const enrollments = await json(owner.get(`/sales-sequence-enrollments?leadId=${leadId}`));
    expect(enrollments.data[0]).toMatchObject({
      id: enrollmentId,
      status: 'completed',
      currentStepPosition: 2,
    });
  });

  it('stops an enrollment when its planned activity is cancelled', async () => {
    const owner = reqAs(users.owner!.cookie);
    const enrolled = await json(owner.post(`/sales-sequences/${sequenceId}/enroll`, { leadId }));
    const activity = (await json(owner.get(`/sales-activities?leadId=${leadId}`))).data
      .find((row: { id: string }) => row.id === enrolled.activityId);
    expect((await owner.post(`/sales-activities/${activity.id}/cancel`, {
      version: activity.version,
    })).status).toBe(200);

    const enrollments = await json(owner.get(`/sales-sequence-enrollments?leadId=${leadId}`));
    expect(enrollments.data.find((row: { id: string }) => row.id === enrolled.id)).toMatchObject({
      status: 'stopped',
    });
  });

  it('renders a reusable template when scheduling a normal activity', async () => {
    const owner = reqAs(users.owner!.cookie);
    const scheduled = await json(owner.post('/sales-activities', {
      leadId,
      type: 'outreach',
      templateId,
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    }));
    const activity = (await json(owner.get(`/sales-activities?leadId=${leadId}`))).data
      .find((row: { id: string }) => row.id === scheduled.id);
    expect(activity).toMatchObject({
      subject: 'Hello Michael',
      context: 'Lea Hough & Co LLP has a workflow opportunity. Owner: Owner.',
      messageTemplateId: templateId,
    });
    await owner.post(`/sales-activities/${activity.id}/cancel`, { version: activity.version });
  });

  it('explicitly stops a sequence and cancels its pending step', async () => {
    const owner = reqAs(users.owner!.cookie);
    const enrolled = await json(owner.post(`/sales-sequences/${sequenceId}/enroll`, { leadId }));
    const enrollment = (await json(owner.get(`/sales-sequence-enrollments?leadId=${leadId}`))).data
      .find((row: { id: string }) => row.id === enrolled.id);
    expect((await owner.post(`/sales-sequence-enrollments/${enrollment.id}/stop`, {
      version: enrollment.version,
    })).status).toBe(200);
    const activity = (await json(owner.get(`/sales-activities?leadId=${leadId}`))).data
      .find((row: { id: string }) => row.id === enrolled.activityId);
    expect(activity.status).toBe('cancelled');
  });

  it('checks lead/deal write permission again inside enrollment transactions', async () => {
    const owner = reqAs(users.owner!.cookie);
    const member = reqAs(users.member!.cookie);
    const leadEnrollment = await json(owner.post(
      `/sales-sequences/${sequenceId}/enroll`,
      { leadId },
    ));
    expect((await member.post(
      `/sales-sequence-enrollments/${leadEnrollment.id}/stop`,
      {},
    )).status).toBe(403);
    await owner.post(`/sales-sequence-enrollments/${leadEnrollment.id}/stop`, {});

    const deal = await json(member.post('/deals', {
      companyId,
      title: 'Member-owned pilot',
      stageId: openStageId,
    }));
    const dealEnrollment = await json(member.post(
      `/sales-sequences/${sequenceId}/enroll`,
      { dealId: deal.id, contactId },
    ));
    expect((await member.post(
      `/sales-sequence-enrollments/${dealEnrollment.id}/stop`,
      {},
    )).status).toBe(200);
  });

  it('serializes a concurrent step completion and sequence stop without deadlocking', async () => {
    const owner = reqAs(users.owner!.cookie);
    const enrolled = await json(owner.post(`/sales-sequences/${sequenceId}/enroll`, { leadId }));
    const activity = (await json(owner.get(`/sales-activities?leadId=${leadId}`))).data
      .find((row: { id: string }) => row.id === enrolled.activityId);
    const enrollment = (await json(owner.get(`/sales-sequence-enrollments?leadId=${leadId}`))).data
      .find((row: { id: string }) => row.id === enrolled.id);

    const [completed, stopped] = await Promise.all([
      owner.post(`/sales-activities/${activity.id}/complete`, {
        version: activity.version,
        outcome: 'Sent while stopping',
      }),
      owner.post(`/sales-sequence-enrollments/${enrollment.id}/stop`, {
        version: enrollment.version,
      }),
    ]);

    expect([200, 409, 422]).toContain(completed.status);
    expect([200, 409]).toContain(stopped.status);
    expect([completed.status, stopped.status]).toContain(200);

    const latest = (await json(owner.get(`/sales-sequence-enrollments?leadId=${leadId}`))).data
      .find((row: { id: string }) => row.id === enrolled.id);
    if (latest.status === 'active') {
      expect((await owner.post(`/sales-sequence-enrollments/${latest.id}/stop`, {
        version: latest.version,
      })).status).toBe(200);
    }
    const activities = (await json(owner.get(`/sales-activities?leadId=${leadId}`))).data
      .filter((row: { sequenceEnrollmentId: string }) => row.sequenceEnrollmentId === enrolled.id);
    expect(activities.some((row: { status: string }) => row.status === 'planned')).toBe(false);
  });

  it('stops deal sequences atomically when the deal is won', async () => {
    const owner = reqAs(users.owner!.cookie);
    const deal = await json(owner.post('/deals', {
      companyId,
      title: 'Lea Hough pilot',
      stageId: openStageId,
    }));
    const enrolled = await json(owner.post(`/sales-sequences/${sequenceId}/enroll`, {
      dealId: deal.id,
      contactId,
    }));
    const before = await json(owner.get(`/deals/${deal.id}`));
    expect((await owner.post(`/deals/${deal.id}/move`, {
      stageId: wonStageId,
      version: before.version,
    })).status).toBe(200);

    const enrollments = await json(owner.get(`/sales-sequence-enrollments?dealId=${deal.id}`));
    const activities = await json(owner.get(`/sales-activities?dealId=${deal.id}`));
    expect(enrollments.data.find((row: { id: string }) => row.id === enrolled.id).status).toBe('stopped');
    expect(activities.data.find((row: { id: string }) => row.id === enrolled.activityId).status).toBe('cancelled');
    expect((await owner.post('/sales-activities', {
      dealId: deal.id,
      type: 'follow_up',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    })).status).toBe(422);
  });
});
