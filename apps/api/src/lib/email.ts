/**
 * Email sending (PRD §14.3, §11.3) via Nodemailer + SMTP. Settings come from
 * the workspace (Settings → Integrations) or, as a fallback, SMTP_URL in the
 * server env. With neither configured, emails are logged instead of sent.
 * Delivery of documents/reminders is enqueued through pg-boss by the caller;
 * this is the transport.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { logger } from './logger';
import { runtimeConfig, type SmtpConfig } from './runtime-config';

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

let cached: { key: string; transport: Transporter } | null = null;

/** Identity of a config, so a settings change rebuilds the transport. */
const keyOf = (s: SmtpConfig) => `${s.host}:${s.port}:${s.secure}:${s.user}:${s.pass}`;

async function getTransport(): Promise<{ transport: Transporter; from: string } | null> {
  const { smtp } = await runtimeConfig();
  if (!smtp?.host) return null;
  const key = keyOf(smtp);
  if (!cached || cached.key !== key) cached = { key, transport: transportFor(smtp) };
  return { transport: cached.transport, from: smtp.from };
}

export interface EmailInput {
  to: string;
  subject: string;
  body: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType?: string }[];
}

export async function queueEmail(input: EmailInput): Promise<void> {
  const t = await getTransport();
  if (!t) {
    logger.info({ to: input.to, subject: input.subject }, '[email:dev] not sent (no SMTP configured)');
    return;
  }
  await t.transport.sendMail({
    from: t.from,
    to: input.to,
    subject: input.subject,
    text: input.body,
    html: input.html,
    attachments: input.attachments,
  });
}

/** True when the instance has SMTP configured at all. */
export async function emailConfigured(): Promise<boolean> {
  return !!(await runtimeConfig()).smtp?.host;
}

/**
 * Send and report failure instead of throwing, for mail that accompanies an
 * action rather than being the action – an invite is still valid and shareable
 * by link even when its email bounces off a blocked port.
 */
export async function trySendEmail(input: EmailInput): Promise<{ sent: boolean; error?: string }> {
  try {
    const t = await getTransport();
    if (!t) return { sent: false, error: 'not_configured' };
    await queueEmail(input);
    return { sent: true };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    logger.error({ err: error, to: input.to, subject: input.subject }, 'email send failed');
    return { sent: false, error: (error as NodeJS.ErrnoException).code ?? error.message };
  }
}

/** Probe the configured SMTP server – used by the settings page to test setup. */
export async function verifyEmailTransport(): Promise<{ ok: boolean; error?: string }> {
  try {
    const t = await getTransport();
    if (!t) return { ok: false, error: 'not_configured' };
    await t.transport.verify();
    return { ok: true };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    return { ok: false, error: (error as NodeJS.ErrnoException).code ?? error.message };
  }
}
