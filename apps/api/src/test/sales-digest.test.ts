import { beforeAll, describe, expect, it } from 'vitest';
import { eq, getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { processOutboxOnce } from '../workers/relay';
import { runSalesWorkDigests } from '../workers/sales-digest';
import { json, reqAs, resetDb, seedRolesAndUsers } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
const digestAt = new Date('2026-07-29T18:05:00.000Z');

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const { db } = getDb();
  const companyId = ulid();
  const leadId = ulid();
  const [owner] = await db.select({ roleId: schema.users.roleId }).from(schema.users)
    .where(eq(schema.users.id, users.owner!.userId));

  await db.update(schema.users).set({
    timezone: 'Pacific/Kiritimati',
    emailNotificationPrefs: { 'sales.work_digest': true },
  }).where(eq(schema.users.id, users.owner!.userId));
  await db.insert(schema.users).values({
    id: ulid(),
    email: 'sales-agent@test.local',
    name: 'Sales agent',
    roleId: owner!.roleId,
    timezone: 'Pacific/Kiritimati',
    actorType: 'agent',
  });
  await db.insert(schema.companies).values({ id: companyId, name: 'Digest Prospect' });
  await db.insert(schema.leads).values({
    id: leadId,
    companyId,
    title: 'Digest Prospect',
    status: 'ready',
    ownerId: users.owner!.userId,
  });
  await db.insert(schema.salesActivities).values({
    id: ulid(),
    leadId,
    companyId,
    type: 'follow_up',
    status: 'planned',
    dueAt: new Date('2026-07-29T09:00:00.000Z'),
    ownerId: users.owner!.userId,
  });
});

describe('timezone-aware sales work digest', () => {
  it('round-trips email preferences through /me', async () => {
    const api = reqAs(users.owner!.cookie);
    expect((await api.patch('/me', {
      emailNotificationPrefs: { 'sales.work_digest': false },
    })).status).toBe(200);
    const disabled = await json(api.get('/me'));
    expect(disabled.user.emailNotificationPrefs).toEqual({ 'sales.work_digest': false });
    await api.patch('/me', {
      emailNotificationPrefs: { 'sales.work_digest': true },
    });
  });

  it('emits one local-morning digest event per seller and date', async () => {
    const first = await runSalesWorkDigests(digestAt);
    const second = await runSalesWorkDigests(digestAt);
    expect(first).toMatchObject({ eligible: 1, emitted: 1 });
    expect(second).toMatchObject({ eligible: 1, emitted: 0 });

    const { db } = getDb();
    const runs = await db.select().from(schema.salesDigestRuns)
      .where(eq(schema.salesDigestRuns.userId, users.owner!.userId));
    expect(runs).toHaveLength(1);
    expect(runs[0]?.localDate).toBe('2026-07-30');

    const events = await db.select().from(schema.events)
      .where(eq(schema.events.type, 'sales.work_digest_due'));
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      userId: users.owner!.userId,
      localDate: '2026-07-30',
      total: 1,
      overdue: 1,
    });
  });

  it('turns the digest event into one in-app notification and queued email', async () => {
    await processOutboxOnce();
    const { db } = getDb();
    const notifications = await db.select().from(schema.notifications)
      .where(eq(schema.notifications.type, 'sales.work_digest'));
    const deliveries = await db.select().from(schema.emailDeliveries);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.userId).toBe(users.owner!.userId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      to: 'owner@test.local',
      status: 'pending',
    });
  });
});
