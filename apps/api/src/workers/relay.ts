/**
 * Outbox relay (PRD §3.3). Reads unpublished events in occurred_at order and
 * dispatches to idempotent consumers. Dedup via processed_events. Failures retry
 * with exponential backoff; exhausted events go to dead-letter (poison events do
 * not block the queue). An event is marked published only when every consumer
 * has reached a terminal state (processed or dead).
 */
import { getDb, schema, eq, and, isNull, asc, sql } from '@ordi/db';
import { ulid } from 'ulid';
import type { DomainEvent } from '@ordi/shared';
import { logger } from '../lib/logger';
import { consumers } from './consumers';

const BACKOFF_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000];
const MAX_ATTEMPTS = BACKOFF_MS.length;

interface EventRow {
  id: string; type: string; aggregateType: string; aggregateId: string;
  payload: unknown; actorId: string | null; actorType: string; occurredAt: Date;
}

function toDomainEvent(row: EventRow): DomainEvent {
  return {
    id: row.id, type: row.type as DomainEvent['type'],
    aggregateType: row.aggregateType as DomainEvent['aggregateType'],
    aggregateId: row.aggregateId, payload: (row.payload as Record<string, unknown>) ?? {},
    occurredAt: row.occurredAt.toISOString(), actorId: row.actorId,
    actorType: row.actorType as DomainEvent['actorType'],
  };
}

async function isProcessed(consumer: string, eventId: string): Promise<boolean> {
  const { db } = getDb();
  const rows = await db.select().from(schema.processedEvents)
    .where(and(eq(schema.processedEvents.consumer, consumer), eq(schema.processedEvents.eventId, eventId)));
  return rows.length > 0;
}

async function markProcessed(consumer: string, eventId: string): Promise<void> {
  const { db } = getDb();
  await db.insert(schema.processedEvents).values({ consumer, eventId }).onConflictDoNothing();
}

/** Retry state stored in dead_letter_events: status pending until dead. */
async function getRetry(consumer: string, eventId: string) {
  const { db } = getDb();
  const [row] = await db.select().from(schema.deadLetterEvents)
    .where(and(eq(schema.deadLetterEvents.consumer, consumer), eq(schema.deadLetterEvents.eventId, eventId)));
  return row ?? null;
}

async function recordFailure(consumer: string, ev: DomainEvent, error: unknown): Promise<'retry' | 'dead'> {
  const { db } = getDb();
  const existing = await getRetry(consumer, ev.id);
  const attempts = (existing?.attempts ?? 0) + 1;
  const dead = attempts >= MAX_ATTEMPTS;
  const message = error instanceof Error ? error.message : String(error);
  if (existing) {
    await db.update(schema.deadLetterEvents).set({
      attempts, error: message, replayedAt: null,
    }).where(eq(schema.deadLetterEvents.id, existing.id));
  } else {
    await db.insert(schema.deadLetterEvents).values({
      id: ulid(), consumer, eventId: ev.id, error: message, attempts, payload: ev as any,
    });
  }
  if (dead) logger.error({ consumer, eventId: ev.id, error: message }, 'event dead-lettered');
  return dead ? 'dead' : 'retry';
}

async function retryDue(consumer: string, eventId: string): Promise<boolean> {
  const row = await getRetry(consumer, eventId);
  if (!row) return true;
  if (row.attempts >= MAX_ATTEMPTS) return false; // dead => terminal, never retried automatically
  const backoff = BACKOFF_MS[Math.min(row.attempts - 1, BACKOFF_MS.length - 1)]!;
  const dueAt = row.createdAt.getTime() + backoff;
  return Date.now() >= dueAt;
}

export async function processOutboxOnce(limit = 50): Promise<number> {
  const { db } = getDb();
  const rows = await db.select().from(schema.events)
    .where(isNull(schema.events.publishedAt))
    .orderBy(asc(schema.events.occurredAt)).limit(limit) as unknown as EventRow[];

  for (const row of rows) {
    const ev = toDomainEvent(row);
    let allTerminal = true;
    for (const consumer of consumers) {
      if (await isProcessed(consumer.name, ev.id)) continue;
      const retry = await getRetry(consumer.name, ev.id);
      const dead = retry && retry.attempts >= MAX_ATTEMPTS;
      if (dead) continue; // terminal (dead)
      if (retry && !(await retryDue(consumer.name, ev.id))) { allTerminal = false; continue; }
      try {
        await consumer.handle(ev);
        await markProcessed(consumer.name, ev.id);
      } catch (e) {
        const outcome = await recordFailure(consumer.name, ev, e);
        if (outcome === 'retry') allTerminal = false;
      }
    }
    if (allTerminal) {
      await db.update(schema.events).set({ publishedAt: new Date() }).where(eq(schema.events.id, ev.id));
    }
  }
  return rows.length;
}

let running = false;
export function startRelay(intervalMs = 1500): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await processOutboxOnce();
    } catch (e) {
      logger.error({ err: e }, 'relay tick failed');
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, intervalMs);
  logger.info('outbox relay started');
  return () => { stopped = true; clearInterval(handle); };
}
