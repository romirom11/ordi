import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, getDb, schema } from '@ordi/db';
import { emit } from '../core/events';
import { enqueueEmail, processEmailDeliveries } from '../workers/email-delivery';
import { processOutboxOnce } from '../workers/relay';
import { resetDb, seedRolesAndUsers } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
});

describe('durable email delivery', () => {
  it('deduplicates enqueue requests by their stable delivery key', async () => {
    await enqueueEmail({
      idempotencyKey: 'test:dedupe',
      to: 'seller@example.com',
      subject: 'Sales work',
      body: 'One item is overdue.',
    });
    await enqueueEmail({
      idempotencyKey: 'test:dedupe',
      to: 'seller@example.com',
      subject: 'Sales work',
      body: 'One item is overdue.',
    });

    const { db } = getDb();
    const rows = await db.select().from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.idempotencyKey, 'test:dedupe'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'pending', attempts: 0 });
    await db.delete(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.idempotencyKey, 'test:dedupe'));
  });

  it('retries SMTP failures in the delivery worker instead of the event relay', async () => {
    const queuedAt = new Date();
    await enqueueEmail({
      idempotencyKey: 'test:retry',
      to: 'seller@example.com',
      subject: 'Retry me',
      body: 'Transient failure',
    });

    const firstAttemptAt = new Date(queuedAt.getTime() + 1_000);
    const first = await processEmailDeliveries({
      now: firstAttemptAt,
      send: async () => { throw new Error('smtp unavailable'); },
    });
    expect(first).toMatchObject({ claimed: 1, sent: 0, failed: 1 });

    const { db } = getDb();
    const [failed] = await db.select().from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.idempotencyKey, 'test:retry'));
    expect(failed).toMatchObject({ status: 'pending', attempts: 1, lastError: 'smtp unavailable' });
    expect(failed?.nextAttemptAt.getTime()).toBeGreaterThan(firstAttemptAt.getTime());

    const delivered: string[] = [];
    const second = await processEmailDeliveries({
      now: new Date(firstAttemptAt.getTime() + 60_000),
      send: async (email) => { delivered.push(email.subject); },
    });
    expect(second).toMatchObject({ claimed: 1, sent: 1, failed: 0 });
    expect(delivered).toEqual(['Retry me']);
  });

  it('uses every retry delay before dead-lettering a delivery', async () => {
    await enqueueEmail({
      idempotencyKey: 'test:dead-letter',
      to: 'seller@example.com',
      subject: 'Eventually dead',
      body: 'Permanent failure',
    });

    const { db } = getDb();
    // Step forward from the row's own schedule, not a hard-coded date. With a
    // literal base the first tick stopped claiming the moment the wall clock
    // passed it, so this test was set to start failing on a calendar day.
    const [queued] = await db.select().from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.idempotencyKey, 'test:dead-letter'));
    const base = queued!.nextAttemptAt;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await processEmailDeliveries({
        now: new Date(base.getTime() + attempt * 86_400_000),
        send: async () => { throw new Error('permanent smtp failure'); },
      });
    }

    const [retrying] = await db.select().from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.idempotencyKey, 'test:dead-letter'));
    expect(retrying).toMatchObject({ status: 'pending', attempts: 5 });

    const final = await processEmailDeliveries({
      now: new Date(base.getTime() + 6 * 86_400_000),
      send: async () => { throw new Error('permanent smtp failure'); },
    });
    expect(final).toMatchObject({ claimed: 1, failed: 1, dead: 1 });

    const [dead] = await db.select().from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.idempotencyKey, 'test:dead-letter'));
    expect(dead).toMatchObject({ status: 'dead', attempts: 6 });
  });

  it('creates one notification and one queued email across an outbox retry', async () => {
    const eventId = await emit({
      type: 'task.assigned',
      aggregateType: 'task',
      aggregateId: 'task-email-dedupe',
      payload: {
        assigneeIds: [users.owner!.userId],
        ref: 'ORD-42',
        title: 'Follow up',
      },
    });

    await processOutboxOnce();

    const { db } = getDb();
    await db.delete(schema.processedEvents).where(and(
      eq(schema.processedEvents.consumer, 'notifications'),
      eq(schema.processedEvents.eventId, eventId),
    ));
    await db.update(schema.events).set({ publishedAt: null }).where(eq(schema.events.id, eventId));
    await processOutboxOnce();

    const notifications = await db.select().from(schema.notifications)
      .where(eq(schema.notifications.dedupeKey, `${eventId}:notifications:${users.owner!.userId}:task.assigned`));
    const deliveries = await db.select().from(schema.emailDeliveries)
      .where(eq(schema.emailDeliveries.idempotencyKey, `${eventId}:email:${users.owner!.userId}:task.assigned`));
    expect(notifications).toHaveLength(1);
    expect(deliveries).toHaveLength(1);
  });
});
