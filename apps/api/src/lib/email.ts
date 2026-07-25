/**
 * Email sending (PRD §14.3, §11.3) via Nodemailer + SMTP. Without SMTP configured
 * (dev), emails are logged instead of sent. Delivery of documents/reminders is
 * enqueued through pg-boss by the caller; this is the transport.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { env } from '../env';
import { logger } from './logger';

/**
 * SMTP_URL as explicit transport options.
 *
 * Passing the URL string straight to createTransport() works, but its second
 * argument is per-message defaults, not connection settings – so the timeouts
 * below would be silently ignored and a blocked port would hang the request
 * for nodemailer's two-minute default. Hosting providers block outbound SMTP
 * often enough that this is worth getting right.
 */
function transportOptions(url: string): SMTPTransport.Options {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'smtps:' ? 465 : 587),
    secure: u.protocol === 'smtps:',
    auth: u.username ? {
      user: decodeURIComponent(u.username),
      pass: decodeURIComponent(u.password),
    } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}

let transporter: Transporter | null = null;
function getTransport(): Transporter | null {
  if (!env.smtpUrl) return null;
  if (!transporter) transporter = nodemailer.createTransport(transportOptions(env.smtpUrl));
  return transporter;
}

/** Probe the configured SMTP server – used by the settings page to test setup. */
export async function verifyEmailTransport(): Promise<{ ok: boolean; error?: string }> {
  const t = getTransport();
  if (!t) return { ok: false, error: 'not_configured' };
  try {
    await t.verify();
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return { ok: false, error: (error as NodeJS.ErrnoException).code ?? error.message };
  }
}

/** True when the instance has SMTP configured at all. */
export function emailConfigured(): boolean {
  return !!env.smtpUrl;
}

/**
 * Send and report failure instead of throwing, for mail that accompanies an
 * action rather than being the action – an invite is still valid and shareable
 * by link even when its email bounces off a blocked port.
 */
export async function trySendEmail(input: EmailInput): Promise<{ sent: boolean; error?: string }> {
  if (!emailConfigured()) return { sent: false, error: 'not_configured' };
  try {
    await queueEmail(input);
    return { sent: true };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error({ err: error, to: input.to, subject: input.subject }, 'email send failed');
    return { sent: false, error: (error as NodeJS.ErrnoException).code ?? error.message };
  }
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
