/**
 * IMAP intake polling (PRD §8.6). For every project with a configured intake
 * mailbox, fetch UNSEEN messages, turn each into a pending intake_items row
 * (source 'email') and mark it \Seen. A broken mailbox only logs a warning –
 * it must never crash the worker.
 */
import { ImapFlow } from 'imapflow';
import { simpleParser, type Attachment } from 'mailparser';
import { getDb, schema, isNotNull } from '@ordi/db';
import { ulid } from 'ulid';
import { MAX_UPLOAD_BYTES, BLOCKED_FILE_EXTENSIONS } from '@ordi/shared';
import { logger } from '../lib/logger';
import { decrypt } from '../lib/crypto';
import { putObject } from '../lib/s3';

interface MailboxConfig {
  host: string;
  port?: number;
  secure?: boolean;
  user: string;
  /** AES-GCM ciphertext (legacy rows may still hold plaintext). */
  pass: string;
  folder?: string;
}

const CONNECT_TIMEOUT_MS = 10_000;
/** A runaway mail must not turn into a runaway upload loop. */
const MAX_MAIL_ATTACHMENTS = 10;

/**
 * Store a mail's attachments (PRD §8.6: "вкладення переносяться") and return
 * the intake item's attachment manifest. Anything unstorable – oversized,
 * blocked extension, storage not configured – is skipped with a warning; the
 * item itself must still be created.
 */
async function storeMailAttachments(itemId: string, attachments: Attachment[]): Promise<
  Array<{ attachmentId: string; filename: string; size: number; mime: string }>
> {
  const { db } = getDb();
  const stored: Array<{ attachmentId: string; filename: string; size: number; mime: string }> = [];
  for (const att of attachments.slice(0, MAX_MAIL_ATTACHMENTS)) {
    const filename = att.filename || 'attachment';
    const size = att.content?.length ?? 0;
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    if (!att.content || size < 1 || size > MAX_UPLOAD_BYTES || BLOCKED_FILE_EXTENSIONS.includes(ext)) {
      logger.warn({ itemId, filename, size }, 'intake mail attachment skipped');
      continue;
    }
    const mime = att.contentType || 'application/octet-stream';
    const key = `uploads/${ulid()}/${filename}`;
    const ok = await putObject(key, new Uint8Array(att.content), mime);
    if (!ok) {
      logger.warn({ itemId, filename }, 'intake mail attachment skipped: storage not configured');
      continue;
    }
    const id = ulid();
    // Bound to the intake item from the first byte – access to the file goes
    // through the item's project (attachments.routes).
    await db.insert(schema.attachments).values({
      id, entityType: 'intake_item', entityId: itemId,
      fileKey: key, filename, size, mime, createdBy: null,
    });
    stored.push({ attachmentId: id, filename, size, mime });
  }
  return stored;
}

/** Mailbox passwords are stored encrypted; rows written before that are plain. */
function readSecret(value: string): string {
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

async function pollMailbox(projectId: string, cfg: MailboxConfig): Promise<number> {
  const { db } = getDb();
  const secure = cfg.secure ?? true;
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port ?? (secure ? 993 : 143),
    secure,
    auth: { user: cfg.user, pass: readSecret(cfg.pass) },
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
        const itemId = ulid();
        const stored = await storeMailAttachments(itemId, parsed.attachments ?? []);
        await db.insert(schema.intakeItems).values({
          id: itemId,
          projectId,
          source: 'email',
          status: 'pending',
          title: (parsed.subject || '(no subject)').slice(0, 500),
          description: (parsed.text || '').slice(0, 20_000),
          requesterName: from?.name || null,
          requesterEmail: from?.address || null,
          attachments: stored,
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
