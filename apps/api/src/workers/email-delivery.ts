import { eq, getDb, schema, sql, type Database } from '@ordi/db';
import { ulid } from 'ulid';
import { sendEmailNow, type EmailInput } from '../lib/email';
import { logger } from '../lib/logger';

const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 12 * 3_600_000];
const MAX_ATTEMPTS = RETRY_MS.length + 1;
const STALE_CLAIM_MS = 5 * 60_000;

type EmailDeliveryWriter = Pick<Database, 'insert'>;

export interface QueuedEmailInput extends Omit<EmailInput, 'attachments'> {
  idempotencyKey: string;
}

/**
 * Persist one idempotent delivery request. The caller may pass its transaction
 * so the business change and the delivery request commit atomically.
 */
export async function enqueueEmail(
  input: QueuedEmailInput,
  writer: EmailDeliveryWriter = getDb().db,
): Promise<void> {
  await writer.insert(schema.emailDeliveries).values({
    id: ulid(),
    idempotencyKey: input.idempotencyKey,
    to: input.to,
    subject: input.subject,
    body: input.body,
    html: input.html ?? null,
  }).onConflictDoNothing({ target: schema.emailDeliveries.idempotencyKey });
}

interface ClaimedDelivery {
  id: string;
  to: string;
  subject: string;
  body: string;
  html: string | null;
  attempts: number;
}

export interface ProcessEmailDeliveriesOptions {
  now?: Date;
  limit?: number;
  send?: (input: EmailInput) => Promise<void>;
}

export interface EmailDeliveryResult {
  claimed: number;
  sent: number;
  failed: number;
  dead: number;
}

/**
 * Claim due rows with SKIP LOCKED so multiple API instances can safely run the
 * worker. A stale sending claim is recovered after five minutes.
 */
export async function processEmailDeliveries(
  options: ProcessEmailDeliveriesOptions = {},
): Promise<EmailDeliveryResult> {
  const { db } = getDb();
  const now = options.now ?? new Date();
  const limit = Math.max(1, Math.min(options.limit ?? 25, 100));
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);
  const nowIso = now.toISOString();
  const staleBeforeIso = staleBefore.toISOString();
  const send = options.send ?? sendEmailNow;

  const claimed = await db.execute(sql`
    with due as (
      select id
      from email_deliveries
      where
        (status = 'pending' and next_attempt_at <= ${nowIso}::timestamptz)
        or (status = 'sending' and updated_at <= ${staleBeforeIso}::timestamptz)
      order by next_attempt_at asc, created_at asc
      for update skip locked
      limit ${limit}
    )
    update email_deliveries as delivery
    set
      status = 'sending',
      attempts = delivery.attempts + 1,
      updated_at = ${nowIso}::timestamptz
    from due
    where delivery.id = due.id
    returning
      delivery.id,
      delivery."to",
      delivery.subject,
      delivery.body,
      delivery.html,
      delivery.attempts
  `) as unknown as ClaimedDelivery[];

  const result: EmailDeliveryResult = {
    claimed: claimed.length,
    sent: 0,
    failed: 0,
    dead: 0,
  };

  for (const delivery of claimed) {
    try {
      await send({
        to: delivery.to,
        subject: delivery.subject,
        body: delivery.body,
        html: delivery.html ?? undefined,
      });
      await db.update(schema.emailDeliveries).set({
        status: 'sent',
        sentAt: now,
        lastError: null,
      }).where(eq(schema.emailDeliveries.id, delivery.id));
      result.sent++;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      const dead = delivery.attempts >= MAX_ATTEMPTS;
      const retryDelay = RETRY_MS[Math.min(delivery.attempts - 1, RETRY_MS.length - 1)]!;
      await db.update(schema.emailDeliveries).set({
        status: dead ? 'dead' : 'pending',
        nextAttemptAt: new Date(now.getTime() + retryDelay),
        lastError: error.message.slice(0, 2_000),
      }).where(eq(schema.emailDeliveries.id, delivery.id));
      result.failed++;
      if (dead) result.dead++;
      logger[dead ? 'error' : 'warn'](
        { err: error, deliveryId: delivery.id, attempts: delivery.attempts },
        dead ? 'email delivery dead-lettered' : 'email delivery failed; retry scheduled',
      );
    }
  }

  return result;
}

let running = false;

export function startEmailDeliveryWorker(intervalMs = 1_500): () => void {
  let stopped = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await processEmailDeliveries();
    } catch (error) {
      logger.error({ err: error }, 'email delivery tick failed');
    } finally {
      running = false;
    }
  };
  const handle = setInterval(tick, intervalMs);
  void tick();
  logger.info('email delivery worker started');
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
