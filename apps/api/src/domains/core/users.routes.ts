import { Hono } from 'hono';
import { getDb, schema, eq, and, isNull, gt, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { inviteUserSchema, changeRoleSchema } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { generateToken } from '../../lib/crypto';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { trySendEmail } from '../../lib/email';
import { asLocale, loadBranding, renderEmail, tr } from '../../lib/email-templates';
import { createPasswordReset, sendPasswordResetEmail } from '../../core/password-reset';
import { env } from '../../env';

export function usersRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.get('/', guard('users.manage'), async (c) => {
    const { db } = getDb();
    const rows = await db.select({
      id: schema.users.id, email: schema.users.email, name: schema.users.name,
      roleId: schema.users.roleId, isActive: schema.users.isActive, avatar: schema.users.avatar,
      actorType: schema.users.actorType, createdAt: schema.users.createdAt,
    }).from(schema.users);
    return c.json({ data: rows });
  });

  // Lightweight directory for assignee pickers and @mentions: any authenticated
  // user; only public fields (id, name, avatar) – no emails or role data.
  app.get('/lookup', async (c) => {
    const { db } = getDb();
    const rows = await db.select({
      id: schema.users.id, name: schema.users.name, avatar: schema.users.avatar,
    }).from(schema.users).where(eq(schema.users.isActive, true));
    return c.json({ data: rows });
  });

  /**
   * Invites that have not been accepted yet. Without this the person you just
   * invited is invisible until they sign up, which reads as "nothing happened".
   * The link is included because the admin who sent it may need to pass it on
   * by hand – this route already requires users.manage.
   */
  app.get('/invites', guard('users.manage'), async (c) => {
    const { db } = getDb();
    const rows = await db.select({
      id: schema.invites.id, email: schema.invites.email, name: schema.invites.name,
      roleId: schema.invites.roleId, expiresAt: schema.invites.expiresAt,
      createdAt: schema.invites.createdAt, token: schema.invites.token,
    }).from(schema.invites)
      .where(and(isNull(schema.invites.acceptedAt), gt(schema.invites.expiresAt, new Date())));
    return c.json({
      data: rows.map(({ token, ...r }) => ({ ...r, inviteUrl: `${env.appUrl}/accept-invite?token=${token}` })),
    });
  });

  app.delete('/invites/:id', guard('users.manage'), async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const id = c.req.param('id');
    const [invite] = await db.select().from(schema.invites).where(eq(schema.invites.id, id));
    if (!invite) throw err.notFound('Invite not found');
    await db.delete(schema.invites).where(eq(schema.invites.id, id));
    await writeActivity(db, {
      entityType: 'user', entityId: id, action: 'invite_revoked',
      actorId: actor.userId, actorType: actor.actorType, diff: { email: invite.email },
    });
    return c.json({ ok: true });
  });

  /** Send the invite again and push its expiry out, without a new token. */
  app.post('/invites/:id/resend', guard('users.manage'), async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const [invite] = await db.select().from(schema.invites).where(eq(schema.invites.id, c.req.param('id')));
    if (!invite || invite.acceptedAt) throw err.notFound('Invite not found');

    const expiresAt = new Date(Date.now() + 7 * 24 * 3600_000);
    await db.update(schema.invites).set({ expiresAt }).where(eq(schema.invites.id, invite.id));

    const inviteUrl = `${env.appUrl}/accept-invite?token=${invite.token}`;
    const branding = await loadBranding();
    const locale = asLocale(actor.locale);
    const vars = { workspace: branding.workspaceName };
    const rendered = renderEmail({
      locale, branding,
      heading: tr(locale, 'invite.heading', vars),
      paragraphs: [tr(locale, 'invite.body', vars)],
      cta: { label: tr(locale, 'invite.cta'), url: inviteUrl },
      note: tr(locale, 'invite.expiry'),
    });
    const delivery = await trySendEmail({
      to: invite.email, subject: tr(locale, 'invite.subject', vars),
      body: rendered.text, html: rendered.html,
    });
    return c.json({ inviteUrl, emailSent: delivery.sent, emailError: delivery.error });
  });

  app.post('/invite', guard('users.manage'), async (c) => {
    const actor = currentActor(c);
    const body = inviteUserSchema.parse(await c.req.json());
    const { db } = getDb();
    const [role] = await db.select().from(schema.roles).where(eq(schema.roles.id, body.roleId));
    if (!role) throw err.validation('Unknown role');
    const token = generateToken();
    const id = ulid();
    await db.insert(schema.invites).values({
      id, email: body.email.toLowerCase(), name: body.name, roleId: body.roleId, token,
      expiresAt: new Date(Date.now() + 7 * 24 * 3600_000), createdBy: actor.userId,
    });
    const inviteUrl = `${env.appUrl}/accept-invite?token=${token}`;
    const branding = await loadBranding();
    const locale = asLocale(actor.locale);
    const vars = { workspace: branding.workspaceName };
    const rendered = renderEmail({
      locale,
      branding,
      heading: tr(locale, 'invite.heading', vars),
      paragraphs: [tr(locale, 'invite.body', vars)],
      cta: { label: tr(locale, 'invite.cta'), url: inviteUrl },
      note: tr(locale, 'invite.expiry'),
    });
    // The invite exists whether or not the mail goes out; hand the link back so
    // the admin can pass it on themselves when SMTP is unavailable.
    const delivery = await trySendEmail({
      to: body.email,
      subject: tr(locale, 'invite.subject', vars),
      body: rendered.text,
      html: rendered.html,
    });
    return c.json({ id, inviteUrl, emailSent: delivery.sent, emailError: delivery.error }, 201);
  });

  /**
   * Reset someone's password for them – the answer to "I lost mine and the
   * email never arrives". The admin never learns or sets the password: they
   * hand over a one-time link and the user picks their own, exactly like the
   * self-serve flow. The link comes back in the response too, because a
   * self-hosted instance without SMTP is the common case.
   */
  app.post('/:id/reset-password', guard('users.manage'), async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const [target] = await db.select().from(schema.users).where(eq(schema.users.id, c.req.param('id')));
    if (!target) throw err.notFound();
    if (!target.isActive) throw err.domain('Reactivate this user before resetting their password');
    if (target.actorType !== 'user') throw err.domain('Agents sign in with API tokens, not a password');

    const { resetUrl, expiresAt } = await createPasswordReset(target.id, 'admin');
    const delivery = await sendPasswordResetEmail({
      to: target.email, resetUrl, locale: target.locale, byAdmin: true,
    });
    await writeActivity(db, {
      entityType: 'user', entityId: target.id, action: 'password_reset_requested',
      actorId: actor.userId, actorType: actor.actorType, diff: { by: 'admin' },
    });
    return c.json({
      resetUrl, expiresAt, emailSent: delivery.sent, emailError: delivery.error,
    });
  });

  app.patch('/:id/role', guard('users.manage'), async (c) => {
    const actor = currentActor(c);
    const body = changeRoleSchema.parse(await c.req.json());
    const { db } = getDb();
    const id = c.req.param('id');
    const [target] = await db.select().from(schema.users).where(eq(schema.users.id, id));
    if (!target) throw err.notFound();
    // Cannot demote the last Owner (PRD §4.3).
    await ensureNotLastOwner(target, body.roleId);
    await db.update(schema.users).set({ roleId: body.roleId }).where(eq(schema.users.id, id));
    await writeActivity(db, {
      entityType: 'user', entityId: id, action: 'role_changed',
      before: { roleId: target.roleId }, after: { roleId: body.roleId },
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ ok: true });
  });

  app.post('/:id/deactivate', guard('users.manage'), async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const id = c.req.param('id');
    const [target] = await db.select().from(schema.users).where(eq(schema.users.id, id));
    if (!target) throw err.notFound();
    await ensureNotLastOwner(target, null);
    await db.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, id));
    await db.delete(schema.sessions).where(eq(schema.sessions.userId, id));
    await db.update(schema.apiTokens).set({ revokedAt: new Date() }).where(eq(schema.apiTokens.userId, id));
    await writeActivity(db, {
      entityType: 'user', entityId: id, action: 'deactivated',
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ ok: true });
  });

  app.post('/:id/reactivate', guard('users.manage'), async (c) => {
    const { db } = getDb();
    await db.update(schema.users).set({ isActive: true }).where(eq(schema.users.id, c.req.param('id')));
    return c.json({ ok: true });
  });

  return app;
}

async function ensureNotLastOwner(target: { roleId: string }, newRoleId: string | null): Promise<void> {
  const { db } = getDb();
  const [ownerRole] = await db.select().from(schema.roles).where(eq(schema.roles.key, 'owner'));
  if (!ownerRole || target.roleId !== ownerRole.id) return;
  if (newRoleId === ownerRole.id) return;
  const rows = await db.select({ count: sql<number>`count(*)::int` })
    .from(schema.users).where(eq(schema.users.roleId, ownerRole.id));
  if (Number(rows[0]?.count ?? 0) <= 1) throw err.domain('Cannot remove the last Owner');
}
