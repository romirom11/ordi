/**
 * Password resets (PRD §6). One grant model serves both ways in:
 * "forgot password" from the sign-in screen, and an admin with users.manage
 * resetting the password of someone who lost theirs.
 *
 * The token is single-use, short-lived, and stored hashed – the raw value only
 * ever exists in the link. Issuing a new grant retires the outstanding ones so
 * a forwarded older link stops working.
 */
import { getDb, schema, eq, and, isNull, gt } from '@ordi/db';
import { ulid } from 'ulid';
import { env } from '../env';
import { generateToken, sha256 } from '../lib/crypto';
import { trySendEmail } from '../lib/email';
import { asLocale, loadBranding, renderEmail, tr, type EmailLocale } from '../lib/email-templates';

/** Long enough to reach the person, short enough that a stale mailbox is not a key. */
const TTL_MS = 60 * 60_000;

export interface PasswordResetGrant {
  resetUrl: string;
  expiresAt: Date;
}

export function resetUrlFor(token: string): string {
  return `${env.appUrl}/reset-password?token=${token}`;
}

/**
 * Issue a reset link for a user. Returns the raw link – the caller decides
 * whether it goes out by email, is handed back to an admin, or both.
 */
export async function createPasswordReset(
  userId: string,
  requestedBy: 'self' | 'admin',
): Promise<PasswordResetGrant> {
  const { db } = getDb();
  const now = new Date();
  // Retire outstanding grants: only the newest link should open the door.
  await db.update(schema.passwordResets).set({ usedAt: now })
    .where(and(eq(schema.passwordResets.userId, userId), isNull(schema.passwordResets.usedAt)));

  const token = generateToken(32);
  const expiresAt = new Date(now.getTime() + TTL_MS);
  await db.insert(schema.passwordResets).values({
    id: ulid(), userId, tokenHash: sha256(token), requestedBy, expiresAt,
  });
  return { resetUrl: resetUrlFor(token), expiresAt };
}

/** The user a live (unused, unexpired) token belongs to, or null. */
export async function resolvePasswordReset(token: string): Promise<{ id: string; userId: string } | null> {
  const { db } = getDb();
  const [row] = await db.select().from(schema.passwordResets).where(and(
    eq(schema.passwordResets.tokenHash, sha256(token)),
    isNull(schema.passwordResets.usedAt),
    gt(schema.passwordResets.expiresAt, new Date()),
  ));
  return row ? { id: row.id, userId: row.userId } : null;
}

export async function consumePasswordReset(id: string): Promise<void> {
  const { db } = getDb();
  await db.update(schema.passwordResets).set({ usedAt: new Date() })
    .where(eq(schema.passwordResets.id, id));
}

/**
 * Mail the link. Delivery may fail (no SMTP configured on a fresh self-hosted
 * instance is the normal case), so the outcome is reported rather than thrown –
 * an admin can still pass the link on by hand.
 */
export async function sendPasswordResetEmail(input: {
  to: string;
  resetUrl: string;
  locale?: unknown;
  /** An admin-initiated reset says so, instead of implying the person asked. */
  byAdmin?: boolean;
}): Promise<{ sent: boolean; error?: string }> {
  const branding = await loadBranding();
  const locale: EmailLocale = asLocale(input.locale);
  const vars = { workspace: branding.workspaceName };
  const rendered = renderEmail({
    locale, branding,
    heading: tr(locale, 'reset.heading', vars),
    paragraphs: [tr(locale, input.byAdmin ? 'reset.bodyAdmin' : 'reset.body', vars)],
    cta: { label: tr(locale, 'reset.cta'), url: input.resetUrl },
    note: tr(locale, 'reset.note'),
  });
  return trySendEmail({
    to: input.to,
    subject: tr(locale, 'reset.subject', vars),
    body: rendered.text,
    html: rendered.html,
  });
}
