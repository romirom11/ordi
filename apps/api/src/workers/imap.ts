/**
 * IMAP intake polling (PRD §8.6). For every project with a configured intake
 * mailbox, fetch UNSEEN messages, turn each into a pending intake_items row
 * (source 'email') and mark it \Seen. A broken mailbox only logs a warning —
 * it must never crash the worker.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getDb, schema, isNotNull } from '@ordi/db';
import { ulid } from 'ulid';
import { logger } from '../lib/logger';

interface MailboxConfig {
  host: string;
  port?: number;
  secure?: boolean;
  user: string;
  pass: string; // plaintext in dev
  folder?: string;
}

const CONNECT_TIMEOUT_MS = 10_000;

async function pollMailbox(projectId: string, cfg: MailboxConfig): Promise<number> {
  const { db } = getDb();
  const secure = cfg.secure ?? true;
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port ?? (secure ? 993 : 143),
    secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: 60_000,
  });

  let created = 0;
  await client.connect();
  try {
    const lock = await client.getMailboxLock(cfg.folder || 'INBOX');
    try {
      const unseen = await client.search({ seen: false }, { uid: true });
      for (const uid of unseen || []) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        const from = parsed.from?.value?.[0];
        await db.insert(schema.intakeItems).values({
          id: ulid(),
          projectId,
          source: 'email',
          status: 'pending',
          title: (parsed.subject || '(no subject)').slice(0, 500),
          description: (parsed.text || '').slice(0, 20_000),
          requesterName: from?.name || null,
          requesterEmail: from?.address || null,
        });
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        created += 1;
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } finally {
    // logout() already closes the socket on success; close() is a no-op then.
    client.close();
  }
  return created;
}

/** Poll every configured intake mailbox once. Per-mailbox failures are warnings only. */
export async function pollIntakeMailboxes(): Promise<void> {
  const { db } = getDb();
  const rows = await db.select().from(schema.intakeSettings)
    .where(isNotNull(schema.intakeSettings.mailbox));

  for (const row of rows) {
    const cfg = row.mailbox as MailboxConfig | null;
    if (!cfg || !cfg.host || !cfg.user || !cfg.pass) continue;
    try {
      const created = await pollMailbox(row.projectId, cfg);
      if (created > 0) logger.info({ projectId: row.projectId, created }, 'intake mailbox: new items');
    } catch (e) {
      logger.warn({ err: e, projectId: row.projectId, host: cfg.host }, 'intake mailbox poll failed');
    }
  }
}
