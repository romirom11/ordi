/**
 * Worker bootstrap. Starts the outbox relay and schedules daily jobs. Uses
 * pg-boss for cron when available; falls back to an interval scheduler otherwise
 * (both drive the same idempotent job functions).
 */
import PgBoss from 'pg-boss';
import { env } from '../env';
import { logger } from '../lib/logger';
import { startRelay } from './relay';
import { logConsumers } from './consumers';
import { runAllDailyJobs } from './scheduled';
import { pollIntakeMailboxes } from './imap';
import { startEmailDeliveryWorker } from './email-delivery';
import { runSalesWorkDigests } from './sales-digest';

let boss: PgBoss | null = null;
let stopEmailDelivery: (() => void) | null = null;

export async function startWorkers(): Promise<void> {
  logConsumers();
  startRelay();
  stopEmailDelivery = startEmailDeliveryWorker();

  try {
    boss = new PgBoss({ connectionString: env.databaseUrl, schema: 'pgboss' });
    boss.on('error', (e) => logger.error({ err: e }, 'pg-boss error'));
    await boss.start();
    const queue = 'daily-jobs';
    await boss.createQueue(queue);
    await boss.work(queue, async () => { await runAllDailyJobs(); });
    // Every day at 00:05 UTC
    await boss.schedule(queue, '5 0 * * *');

    const digestQueue = 'sales-work-digests';
    await boss.createQueue(digestQueue);
    await boss.work(digestQueue, async () => { await runSalesWorkDigests(); });
    await boss.schedule(digestQueue, '5 * * * *');

    // IMAP intake polling (PRD §8.6): every 10 minutes
    const imapQueue = 'imap-poll';
    await boss.createQueue(imapQueue);
    await boss.work(imapQueue, async () => { await pollIntakeMailboxes(); });
    await boss.schedule(imapQueue, '*/10 * * * *');
    logger.info('pg-boss scheduled daily jobs + sales digests + imap polling');
  } catch (e) {
    logger.warn({ err: e }, 'pg-boss unavailable; using interval fallback for daily jobs');
    setInterval(() => { runAllDailyJobs().catch((err) => logger.error({ err }, 'daily jobs failed')); }, 6 * 3600_000);
    setInterval(() => { runSalesWorkDigests().catch((err) => logger.error({ err }, 'sales digest failed')); }, 60 * 60_000);
    setInterval(() => { pollIntakeMailboxes().catch((err) => logger.error({ err }, 'imap poll failed')); }, 10 * 60_000);
  }

  // run once shortly after boot so a fresh instance catches up
  setTimeout(() => { runAllDailyJobs().catch((err) => logger.error({ err }, 'initial daily jobs failed')); }, 5_000);
  setTimeout(() => { runSalesWorkDigests().catch((err) => logger.error({ err }, 'initial sales digest failed')); }, 7_000);
}

export async function stopWorkers(): Promise<void> {
  stopEmailDelivery?.();
  stopEmailDelivery = null;
  if (boss) await boss.stop();
}
