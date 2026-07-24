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

let boss: PgBoss | null = null;

export async function startWorkers(): Promise<void> {
  logConsumers();
  startRelay();

  try {
    boss = new PgBoss({ connectionString: env.databaseUrl, schema: 'pgboss' });
    boss.on('error', (e) => logger.error({ err: e }, 'pg-boss error'));
    await boss.start();
    const queue = 'daily-jobs';
    await boss.createQueue(queue);
    await boss.work(queue, async () => { await runAllDailyJobs(); });
    // Every day at 00:05 UTC
    await boss.schedule(queue, '5 0 * * *');

    // IMAP intake polling (PRD §8.6): every 10 minutes
    const imapQueue = 'imap-poll';
    await boss.createQueue(imapQueue);
    await boss.work(imapQueue, async () => { await pollIntakeMailboxes(); });
    await boss.schedule(imapQueue, '*/10 * * * *');
    logger.info('pg-boss scheduled daily jobs + imap polling');
  } catch (e) {
    logger.warn({ err: e }, 'pg-boss unavailable; using interval fallback for daily jobs');
    setInterval(() => { runAllDailyJobs().catch((err) => logger.error({ err }, 'daily jobs failed')); }, 6 * 3600_000);
    setInterval(() => { pollIntakeMailboxes().catch((err) => logger.error({ err }, 'imap poll failed')); }, 10 * 60_000);
  }

  // run once shortly after boot so a fresh instance catches up
  setTimeout(() => { runAllDailyJobs().catch((err) => logger.error({ err }, 'initial daily jobs failed')); }, 5_000);
}

export async function stopWorkers(): Promise<void> {
  if (boss) await boss.stop();
}
