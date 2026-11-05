/**
 * Intake requests from outside (PRD §8.6): the public form's submission,
 * the files that come with a request (form or email), the receipt mailed to
 * the requester, and the task description a request turns into on accept.
 *
 * Triage itself (list / accept / decline / settings) lives in service.ts.
 */
import { getDb, schema, and, eq, gt, sql } from '@ordi/db';
import { ulid } from 'ulid';
import {
  MAX_UPLOAD_BYTES, BLOCKED_FILE_EXTENSIONS,
  normalizeIntakeFormConfig, validateIntakeSubmission, intakeAnswerText, intakeSubmitSchema,
  type IntakeAnswer,
} from '@ordi/shared';
import { env } from '../../env';
import { err } from '../../lib/errors';
import { logger } from '../../lib/logger';
import { hmacSha256 } from '../../lib/crypto';
import { isStorageConfigured, putObject } from '../../lib/s3';
import { asLocale, loadBranding, renderEmail, tr } from '../../lib/email-templates';
import { enqueueEmail } from '../../workers/email-delivery';

export interface IntakeFile {
  filename: string;
  mime: string;
  content: Uint8Array;
}

export interface IntakeAttachmentRef {
  attachmentId: string;
  filename: string;
  size: number;
  mime: string;
}

/** A name from outside, safe as the last segment of a storage key. */
function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // Trailing dots and spaces are dropped too: `setup.exe.` must not pass the
  // extension check as "no extension" and then be saved as setup.exe.
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/[.\s]+$/, '').slice(0, 200);
  return clean || 'attachment';
}

/** Why a file cannot be stored, or null when it can. */
export function intakeFileProblem(file: IntakeFile): 'empty' | 'too_large' | 'blocked' | null {
  const size = file.content.length;
  if (size < 1) return 'empty';
  if (size > MAX_UPLOAD_BYTES) return 'too_large';
  const ext = safeFilename(file.filename).split('.').pop()?.toLowerCase() ?? '';
  if (BLOCKED_FILE_EXTENSIONS.includes(ext)) return 'blocked';
  return null;
}

/**
 * Store a request's files bound to its intake item and return the item's
 * manifest. Anything unstorable – a problem file, storage not configured –
 * is skipped with a warning: the request itself must still be created.
 * Access to the files goes through the item's project (attachments.routes),
 * and accepting the request re-binds them to the task.
 */
export async function storeIntakeFiles(itemId: string, files: IntakeFile[]): Promise<IntakeAttachmentRef[]> {
  const { db } = getDb();
  const stored: IntakeAttachmentRef[] = [];
  for (const file of files) {
    const filename = safeFilename(file.filename);
    const problem = intakeFileProblem(file);
    if (problem) {
      logger.warn({ itemId, filename, size: file.content.length, problem }, 'intake attachment skipped');
      continue;
    }
    const mime = file.mime || 'application/octet-stream';
    const key = `uploads/${ulid()}/${filename}`;
    if (!(await putObject(key, file.content, mime))) {
      logger.warn({ itemId, filename }, 'intake attachment skipped: storage not configured');
      continue;
    }
    const id = ulid();
    await db.insert(schema.attachments).values({
      id, entityType: 'intake_item', entityId: itemId,
      fileKey: key, filename, size: file.content.length, mime, createdBy: null,
    });
    stored.push({ attachmentId: id, filename, size: file.content.length, mime });
  }
  return stored;
}

/** Submissions one address may make: a burst, and a ceiling per hour. */
const PER_MINUTE = 5;
const PER_HOUR = 30;
/** Receipts one recipient may get per hour, so the form cannot mail-bomb someone. */
const RECEIPTS_PER_HOUR = 3;
/** Receipts one project's form may send per hour, whatever the addresses. */
const PROJECT_RECEIPTS_PER_HOUR = 50;
/** A JSON body, or a multipart one without files: answers only. */
const ANSWERS_BODY_BYTES = 256 * 1024;

/** The largest request body the form can legitimately send. */
export function intakeBodyLimit(formConfig: unknown): number {
  const config = normalizeIntakeFormConfig(formConfig);
  return config.allowAttachments && isStorageConfigured()
    ? ANSWERS_BODY_BYTES + config.maxAttachments * (MAX_UPLOAD_BYTES + 64 * 1024)
    : ANSWERS_BODY_BYTES;
}

/** The IP is not kept: only an HMAC of it, enough to recognise the same submitter again. */
export function intakeSubmitterKey(ip: string): string {
  return hmacSha256(env.authSecret, `intake:${ip}`);
}

/**
 * Counted on the stored requests rather than in process memory, so the limit
 * survives a restart and holds across instances. Checked before the body is
 * read (a flood is refused without buffering its files) and again right
 * before the insert.
 */
export async function assertPublicIntakeRate(submitterKey: string): Promise<void> {
  const { db } = getDb();
  const [row] = await db.select({
    minute: sql<number>`count(*) filter (where ${schema.intakeItems.createdAt} > now() - interval '1 minute')`.mapWith(Number),
    hour: sql<number>`count(*)`.mapWith(Number),
  }).from(schema.intakeItems).where(and(
    eq(schema.intakeItems.submitterKey, submitterKey),
    gt(schema.intakeItems.createdAt, sql`now() - interval '1 hour'`),
  ));
  if ((row?.minute ?? 0) >= PER_MINUTE || (row?.hour ?? 0) >= PER_HOUR) throw err.rateLimited();
}

async function receiptAllowed(projectId: string, email: string): Promise<boolean> {
  const { db } = getDb();
  const [row] = await db.select({
    forAddress: sql<number>`count(*) filter (where ${schema.intakeItems.requesterEmail} = ${email})`.mapWith(Number),
    forProject: sql<number>`count(*) filter (where ${schema.intakeItems.requesterEmail} is not null)`.mapWith(Number),
  }).from(schema.intakeItems).where(and(
    eq(schema.intakeItems.projectId, projectId),
    eq(schema.intakeItems.source, 'form'),
    gt(schema.intakeItems.createdAt, sql`now() - interval '1 hour'`),
  ));
  // The request just stored is one of them.
  return (row?.forAddress ?? 0) <= RECEIPTS_PER_HOUR && (row?.forProject ?? 0) <= PROJECT_RECEIPTS_PER_HOUR;
}

/**
 * Queue the "we received your request" mail. Never fails the submission.
 * The only text from the form in it is the title, cut short: anything a
 * stranger types goes out under the workspace's sender, so the receipt
 * must not be a vehicle for their message.
 */
async function queueReceipt(projectId: string, itemId: string, to: string, title: string): Promise<void> {
  try {
    if (!(await receiptAllowed(projectId, to))) return;
    const shortTitle = title.length > 80 ? `${title.slice(0, 79).trimEnd()}…` : title;
    const branding = await loadBranding();
    const locale = asLocale(undefined);
    const rendered = renderEmail({
      locale,
      branding,
      heading: tr(locale, 'intakeReceived.heading'),
      paragraphs: [tr(locale, 'intakeReceived.body', { title: shortTitle }), tr(locale, 'intakeReceived.next')],
    });
    await enqueueEmail({
      idempotencyKey: `intake-receipt:${itemId}`,
      to,
      subject: tr(locale, 'intakeReceived.subject'),
      body: rendered.text,
      html: rendered.html,
    });
  } catch (e) {
    logger.warn({ err: e, itemId }, 'intake receipt not queued');
  }
}

export interface PublicSubmission {
  projectId: string;
  formConfig: unknown;
  /** The parsed JSON body, or the `payload` part of a multipart body. */
  body: unknown;
  files: IntakeFile[];
  submitterKey: string;
}

/**
 * A public form submission → a pending intake item. Answers are checked
 * against the project's form; a bot that filled the honeypot gets the same
 * `ok` as everyone else and creates nothing.
 */
export async function submitPublicIntake(input: PublicSubmission): Promise<void> {
  const body = intakeSubmitSchema.parse(input.body ?? {});
  if (body.honeypot && body.honeypot.trim() !== '') return;

  const config = normalizeIntakeFormConfig(input.formConfig);
  const values: Record<string, unknown> = {
    requesterName: body.requesterName,
    requesterEmail: body.requesterEmail,
    title: body.title,
    description: body.description,
    ...body.values,
  };
  const result = validateIntakeSubmission(config, values);
  if (!result.ok) throw err.validation('Some answers need another look', { fields: result.errors });

  if (input.files.length) {
    if (!config.allowAttachments || !isStorageConfigured()) throw err.validation('This form does not take files', { files: 'not_allowed' });
    if (input.files.length > config.maxAttachments) throw err.validation('Too many files', { files: 'too_many' });
    for (const file of input.files) {
      const problem = intakeFileProblem(file);
      if (problem) throw err.validation(`File refused: ${safeFilename(file.filename)}`, { files: problem, filename: safeFilename(file.filename) });
    }
  }

  const { submitterKey } = input;
  await assertPublicIntakeRate(submitterKey);

  const itemId = ulid();
  const attachments = input.files.length ? await storeIntakeFiles(itemId, input.files) : [];
  const { db } = getDb();
  await db.insert(schema.intakeItems).values({
    id: itemId,
    projectId: input.projectId,
    source: 'form',
    requesterName: result.requesterName,
    requesterEmail: result.requesterEmail,
    title: result.title,
    description: result.description,
    answers: result.answers,
    attachments,
    submitterKey,
    status: 'pending',
  });

  if (config.acknowledge && result.requesterEmail) {
    await queueReceipt(input.projectId, itemId, result.requesterEmail, result.title);
  }
}

type Paragraph = { type: 'paragraph'; content?: Array<{ type: 'text'; text: string; marks?: Array<{ type: string }> }> };

/**
 * The description of the task a request becomes: the requester's text, one
 * paragraph per line, then each custom answer as a bold-labelled line.
 */
export function intakeTaskDescription(description: string, answers: IntakeAnswer[]): { type: 'doc'; content: Paragraph[] } | null {
  const content: Paragraph[] = description
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .map((line): Paragraph => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }));
  while (content.length && !content[content.length - 1]!.content) content.pop();
  if (answers.length) {
    if (content.length) content.push({ type: 'paragraph' });
    for (const answer of answers) {
      content.push({
        type: 'paragraph',
        content: [
          { type: 'text', text: `${answer.label}: `, marks: [{ type: 'bold' }] },
          { type: 'text', text: intakeAnswerText(answer) },
        ],
      });
    }
  }
  return content.length ? { type: 'doc', content } : null;
}
