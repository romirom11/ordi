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
import { handOffOpenTasks, openTasksAssignedTo } from '../projects/service';
import { assertCanGrantRole, externalAgentsOwnedBy, handOverOwnedAgents } from '../agents/external';

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
  // user; only public fields (id, name, avatar, isActive) – no emails or role
  // data. Deactivated users ARE included: historical records (comments, audit
  // rows, memberships) still name them, and hiding them here rendered every
  // ex-colleague as "Someone" with an initials circle. Pickers filter by
  // isActive; renderers must not.
  //
  // The name prefers the linked HR employee card: users.name is whatever the
  // person typed at signup (often just a first name), while the employee card
  // is where HR keeps the real full name – without this, member lists and
  // pickers showed "Vasyl" next to fully-named colleagues.
  app.get('/lookup', async (c) => {
    const { db } = getDb();
    const [rows, emps, managed] = await Promise.all([
      db.select({
        id: schema.users.id, name: schema.users.name, avatar: schema.users.avatar, isActive: schema.users.isActive,
        actorType: schema.users.actorType,
      }).from(schema.users),
      db.select({
        userId: schema.employees.userId, firstName: schema.employees.firstName,
        lastName: schema.employees.lastName, status: schema.employees.status,
      }).from(schema.employees),
      db.select({ userId: schema.agentProfiles.userId }).from(schema.agentProfiles),
    ]);
    // An agent ordi runs ('managed') or one that connects from outside
    // ('external'): only the first has runs to show on a task.
    const managedIds = new Set(managed.map((m) => m.userId));
    const agentKind = (u: { id: string; actorType: string }) =>
      (u.actorType !== 'agent' ? null : managedIds.has(u.id) ? 'managed' : 'external');
    const cardName = new Map<string, { name: string; active: boolean }>();
    for (const e of emps) {
      if (!e.userId) continue;
      const full = [e.firstName, e.lastName].map((s) => (s ?? '').trim()).filter(Boolean).join(' ');
      if (!full) continue;
      const active = e.status !== 'terminated';
      const seen = cardName.get(e.userId);
      // Two cards can point at one user (a rehire keeps the old card): the
      // active one names them.
      if (!seen || (active && !seen.active)) cardName.set(e.userId, { name: full, active });
    }
    return c.json({ data: rows.map((u) => ({ ...u, name: cardName.get(u.id)?.name ?? u.name, agentKind: agentKind(u) })) });
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
    // Agents keep the rules their own settings enforce: never Owner, and an
    // external agent – whose tokens are in someone's hands – gets no role
    // wider than the person giving it.
    if (target.actorType === 'agent') {
      const [role] = await db.select({ key: schema.roles.key }).from(schema.roles).where(eq(schema.roles.id, body.roleId));
      if (!role) throw err.validation('Unknown role');
      if (role.key === 'owner') throw err.domain('An agent cannot hold the Owner role');
      const [ext] = await db.select({ userId: schema.externalAgents.userId }).from(schema.externalAgents).where(eq(schema.externalAgents.userId, id));
      if (ext) await assertCanGrantRole(actor, body.roleId);
    }
    await db.update(schema.users).set({ roleId: body.roleId }).where(eq(schema.users.id, id));
    await writeActivity(db, {
      entityType: 'user', entityId: id, action: 'role_changed',
      before: { roleId: target.roleId }, after: { roleId: body.roleId },
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ ok: true });
  });

  // What deactivating this person would orphan (ORD-20): the open tasks they
  // hold, so the admin can decide who takes them over before pulling the plug.
  app.get('/:id/open-tasks', guard('users.manage'), async (c) => {
    const rows = await openTasksAssignedTo(c.req.param('id'));
    // External agents that work for them are left behind too: shown here so
    // the admin sees their tokens will be revoked and who takes them over.
    const ownedAgents = await externalAgentsOwnedBy(c.req.param('id'));
    return c.json({ count: rows.length, data: rows.slice(0, 20), ownedAgents });
  });

  app.post('/:id/deactivate', guard('users.manage'), async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const id = c.req.param('id');
    const [target] = await db.select().from(schema.users).where(eq(schema.users.id, id));
    if (!target) throw err.notFound();
    await ensureNotLastOwner(target, null);

    // Open tasks go to a named successor, or become unassigned – never stay
    // with someone who can no longer sign in (ORD-20). The body is optional so
    // older callers keep working; they get the unassign behaviour.
    const body = (await c.req.json().catch(() => ({}))) as { reassignTo?: unknown };
    const reassignTo = typeof body.reassignTo === 'string' && body.reassignTo ? body.reassignTo : null;
    if (reassignTo) {
      if (reassignTo === id) throw err.validation('Tasks cannot be handed over to the user being deactivated');
      const [successor] = await db.select({ id: schema.users.id, isActive: schema.users.isActive })
        .from(schema.users).where(eq(schema.users.id, reassignTo));
      if (!successor) throw err.validation('Unknown user to hand tasks over to', { reassignTo });
      if (!successor.isActive) throw err.validation('Tasks cannot be handed over to a deactivated user');
      // One of their own agents is about to be switched off with them.
      const [owned] = await db.select({ userId: schema.externalAgents.userId }).from(schema.externalAgents)
        .where(and(eq(schema.externalAgents.userId, reassignTo), eq(schema.externalAgents.ownerUserId, id)));
      if (owned) throw err.validation('That agent works for the person being deactivated and is switched off with them – pick someone else');
    }

    // One step: tasks, their external agents and the account itself change
    // together or not at all. The person's row is locked first – owner changes
    // and token issuance lock it before any agent – so nothing slips between.
    const { handedOff, agents } = await db.transaction(async (tx) => {
      await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, id)).for('update');
      const handedOff = await handOffOpenTasks(actor, id, reassignTo, tx);
      // Their external agents lose every token and move to the successor (a
      // person), or are switched off: a copied token must not outlive them.
      const agents = await handOverOwnedAgents(tx, actor, id, reassignTo);
      await tx.update(schema.users).set({ isActive: false }).where(eq(schema.users.id, id));
      await tx.delete(schema.sessions).where(eq(schema.sessions.userId, id));
      await tx.update(schema.apiTokens).set({ revokedAt: new Date() }).where(eq(schema.apiTokens.userId, id));
      await writeActivity(tx, {
        entityType: 'user', entityId: id, action: 'deactivated',
        after: { reassignTo, handedOffTasks: handedOff.count, externalAgents: agents },
        actorId: actor.userId, actorType: actor.actorType,
      });
      return { handedOff, agents };
    });
    return c.json({ ok: true, handedOffTasks: handedOff.count, reassignTo, externalAgents: agents });
  });

  app.post('/:id/reactivate', guard('users.manage'), async (c) => {
    const { db } = getDb();
    // An external agent comes back on in Settings -> Agents, where its owner
    // and tokens are checked – not as a side door from the user list.
    const [ext] = await db.select({ userId: schema.externalAgents.userId }).from(schema.externalAgents)
      .where(eq(schema.externalAgents.userId, c.req.param('id')));
    if (ext) throw err.domain('Switch an external agent on in Settings → Agents');
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
