/**
 * Dead-letter queue admin (PRD §3.3). An event is dead for a consumer when its
 * dead_letter_events row has attempts >= MAX (5) – the relay never retries it
 * automatically. Replay resets the retry state and re-opens the event in the
 * outbox; reprocess deliberately re-runs an already-processed (consumer, event)
 * pair. Both require audit.read AND settings.manage.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb, schema, eq, and, gte, lt, isNull, desc, inArray, count } from '@ordi/db';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guardAll } from '../../core/rbac';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';

/** Mirrors MAX_ATTEMPTS in workers/relay.ts. */
const DEAD_THRESHOLD = 5;

const reprocessSchema = z.object({
  consumer: z.string().min(1),
  eventId: z.string().min(1),
});

export function dlqRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);
  app.use('*', guardAll('audit.read', 'settings.manage'));

  // Dead events (exhausted retries, not yet replayed) with their payloads + counts.
  app.get('/', async (c) => {
    const { db } = getDb();
    const dead = await db.select().from(schema.deadLetterEvents)
      .where(and(gte(schema.deadLetterEvents.attempts, DEAD_THRESHOLD), isNull(schema.deadLetterEvents.replayedAt)))
      .orderBy(desc(schema.deadLetterEvents.createdAt)).limit(200);

    const eventIds = [...new Set(dead.map((d) => d.eventId))];
    const events = eventIds.length
      ? await db.select().from(schema.events).where(inArray(schema.events.id, eventIds))
      : [];
    const byId = new Map(events.map((e) => [e.id, e]));

    const [deadCount] = await db.select({ value: count() }).from(schema.deadLetterEvents)
      .where(and(gte(schema.deadLetterEvents.attempts, DEAD_THRESHOLD), isNull(schema.deadLetterEvents.replayedAt)));
    const [retryingCount] = await db.select({ value: count() }).from(schema.deadLetterEvents)
      .where(lt(schema.deadLetterEvents.attempts, DEAD_THRESHOLD));

    return c.json({
      data: dead.map((d) => ({ ...d, event: byId.get(d.eventId) ?? null })),
      counts: { dead: Number(deadCount?.value ?? 0), retrying: Number(retryingCount?.value ?? 0) },
    });
  });

  // Replay one dead event: reset retry state and put the event back on the outbox.
  app.post('/:id/replay', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const [row] = await db.select().from(schema.deadLetterEvents)
      .where(eq(schema.deadLetterEvents.id, c.req.param('id')));
    if (!row) throw err.notFound('Dead-letter entry not found');

    await db.update(schema.deadLetterEvents)
      .set({ attempts: 0, error: '', replayedAt: new Date() })
      .where(eq(schema.deadLetterEvents.id, row.id));
    await db.update(schema.events).set({ publishedAt: null }).where(eq(schema.events.id, row.eventId));

    await writeActivity(db, {
      entityType: 'dead_letter_event', entityId: row.id, action: 'dlq_replayed',
      actorId: actor.userId, actorType: actor.actorType,
      diff: { consumer: row.consumer, eventId: row.eventId },
    });
    return c.json({ ok: true });
  });

  // Deliberate re-run of an already-processed event for a single consumer.
  app.post('/reprocess', async (c) => {
    const actor = currentActor(c);
    const body = reprocessSchema.parse(await c.req.json());
    const { db } = getDb();
    const [event] = await db.select().from(schema.events).where(eq(schema.events.id, body.eventId));
    if (!event) throw err.notFound('Event not found');

    await db.delete(schema.processedEvents).where(and(
      eq(schema.processedEvents.consumer, body.consumer),
      eq(schema.processedEvents.eventId, body.eventId),
    ));
    await db.update(schema.events).set({ publishedAt: null }).where(eq(schema.events.id, body.eventId));

    await writeActivity(db, {
      entityType: 'event', entityId: body.eventId, action: 'dlq_reprocessed',
      actorId: actor.userId, actorType: actor.actorType,
      diff: { consumer: body.consumer },
    });
    return c.json({ ok: true });
  });

  return app;
}
