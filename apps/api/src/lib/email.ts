/**
 * Email sending (PRD §14.3, §11.3) via Nodemailer + SMTP. Mail goes out
 * through one of the workspace's senders (Settings → Email): the system
 * sender unless the caller names another, with SMTP_URL in the server env as
 * a read-only sender of its own. With none configured, emails are logged
 * instead of sent.
 * This module is the synchronous SMTP transport. Background delivery must go
 * through the durable email-delivery worker.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { logger } from './logger';
import { pickSender, runtimeConfig, type MailSender, type SmtpConfig } from './runtime-config';

/**
 * The timeouts matter: nodemailer waits two minutes by default, and hosting
 * providers block outbound SMTP ports often enough that a misconfigured
 * instance would otherwise hang every request that sends mail.
 */
function transportFor(smtp: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/** One transport per distinct server login; a settings change gets a new one. */
const transports = new Map<string, Transporter>();

/** Identity of a config, so a settings change rebuilds the transport. */
const keyOf = (s: SmtpConfig) => `${s.host}:${s.port}:${s.secure}:${s.user}:${s.pass}`;

type Role = 'system' | 'invoices';

async function getTransport(senderId?: string | null, role: Role = 'system'): Promise<{ transport: Transporter; sender: MailSender } | null> {
  const sender = pickSender(await runtimeConfig(), senderId, role);
  if (!sender?.smtp.host) return null;
  const key = keyOf(sender.smtp);
  let transport = transports.get(key);
  if (!transport) {
    transport = transportFor(sender.smtp);
    transports.set(key, transport);
  }
  return { transport, sender };
}

export interface EmailInput {
  to: string;
  subject: string;
  body: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
  /** The sender to go out through; the system sender when omitted or unknown. */
  senderId?: string | null;
}

export async function sendEmailNow(input: EmailInput): Promise<void> {
  const t = await getTransport(input.senderId);
  if (!t) {
    logger.info({ to: input.to, subject: input.subject }, '[email:dev] not sent (no SMTP configured)');
    return;
  }
  await t.transport.sendMail({
    from: t.sender.smtp.from,
    replyTo: t.sender.replyTo ?? undefined,
    to: input.to,
    subject: input.subject,
    text: input.body,
    html: input.html,
    attachments: input.attachments,
  });
}

/** True when there is a sender for the role (the system one by default). */
export async function emailConfigured(role: Role = 'system'): Promise<boolean> {
  return !!pickSender(await runtimeConfig(), null, role)?.smtp.host;
}

/**
 * Send and report failure instead of throwing, for mail that accompanies an
 * action rather than being the action – an invite is still valid and shareable
 * by link even when its email bounces off a blocked port.
 */
export async function trySendEmail(input: EmailInput): Promise<{ sent: boolean; error?: string }> {
  try {
    const t = await getTransport(input.senderId);
    if (!t) return { sent: false, error: 'not_configured' };
    await sendEmailNow(input);
    return { sent: true };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error({ err: error, to: input.to, subject: input.subject }, 'email send failed');
    return { sent: false, error: (error as NodeJS.ErrnoException).code ?? error.message };
  }
}

/** Probe a sender's SMTP server (the system one by default) – the settings page's "Test connection". */
export async function verifyEmailTransport(senderId?: string | null): Promise<{ ok: boolean; error?: string }> {
  try {
    const t = await getTransport(senderId);
    if (!t) return { ok: false, error: 'not_configured' };
    await t.transport.verify();
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return { ok: false, error: (error as NodeJS.ErrnoException).code ?? error.message };
  }
}
