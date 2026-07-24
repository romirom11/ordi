/**
 * Email sending (PRD §14.3, §11.3) via Nodemailer + SMTP. Without SMTP configured
 * (dev), emails are logged instead of sent. Delivery of documents/reminders is
 * enqueued through pg-boss by the caller; this is the transport.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../env';
import { logger } from './logger';

let transporter: Transporter | null = null;
function getTransport(): Transporter | null {
  if (!env.smtpUrl) return null;
  if (!transporter) transporter = nodemailer.createTransport(env.smtpUrl);
  return transporter;
}

export interface EmailInput {
  to: string;
  subject: string;
  body: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

export async function queueEmail(input: EmailInput): Promise<void> {
  const t = getTransport();
  if (!t) {
    logger.info({ to: input.to, subject: input.subject }, '[email:dev] not sent (no SMTP configured)');
    return;
  }
  await t.sendMail({
    from: env.smtpFrom,
    to: input.to,
    subject: input.subject,
    text: input.body,
    html: input.html,
    attachments: input.attachments,
  });
}
