import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { getDb, schema, eq, and, ne, isNull } from '@ordi/db';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor, SESSION_COOKIE } from '../../core/auth';
import { changePasswordSchema, updateProfileSchema } from '@ordi/shared';
import { accessibleProjectIds } from '../../core/access';
import { err } from '../../lib/errors';
import { hashPassword, verifyPassword } from '../../lib/crypto';
import { checkRate, clearRate } from '../../lib/rate-limit';
import { writeActivity } from '../../core/activity';

export function meRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.get('/', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const pms = [...actor.access.projectMemberships.entries()].map(([projectId, role]) => ({
      projectId, role, canWriteTasks: true,
    }));
    const sms = [...actor.access.spaceMemberships.entries()].map(([spaceId, role]) => ({ spaceId, role }));
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, actor.userId));
    return c.json({
      user: {
        id: actor.userId, email: actor.email, name: actor.name,
        avatar: user?.avatar ?? null, timezone: user?.timezone ?? 'UTC',
        locale: actor.locale, dateFormat: user?.dateFormat ?? 'auto',
        emailNotificationPrefs: user?.emailNotificationPrefs ?? {},
        roleId: actor.roleId, roleName: actor.roleName,
        isActive: user?.isActive ?? true,
      },
      permissions: [...actor.access.permissions],
      projectMemberships: pms,
      spaceMemberships: sms,
      actorType: actor.actorType,
    });
  });

  app.patch('/', async (c) => {
    const actor = currentActor(c);
    const body = updateProfileSchema.parse(await c.req.json());
    const { db } = getDb();
    await db.update(schema.users).set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      ...(body.locale !== undefined ? { locale: body.locale } : {}),
      ...(body.dateFormat !== undefined ? { dateFormat: body.dateFormat } : {}),
      ...(body.avatar !== undefined ? { avatar: body.avatar } : {}),
      ...(body.emailNotificationPrefs !== undefined ? { emailNotificationPrefs: body.emailNotificationPrefs } : {}),
    }).where(eq(schema.users.id, actor.userId));
    return c.json({ ok: true });
  });

  /**
   * Change my own password (PRD §6). Proving the current one is what separates
   * this from a takeover: a borrowed browser tab, or a session token lifted
   * off a device, cannot swap the password without it.
   *
   * Every other session is dropped and any outstanding reset link is retired –
   * whatever prompted the change, the old credential stops opening anything.
   * The session making the request survives, so nobody logs themselves out of
   * the page they are standing on.
   */
  app.post('/password', async (c) => {
    const actor = currentActor(c);
    // An API token is a scoped credential; letting one set the password would
    // turn any leaked read-only token into full account access.
    if (actor.tokenScopes !== null) throw err.forbidden('Sign in to change your password');

    const body = changePasswordSchema.parse(await c.req.json());
    const rateKey = `password-change:${actor.userId}`;
    checkRate(rateKey, 10, 15 * 60_000);

    const { db } = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, actor.userId));
    if (!user) throw err.notFound();
    if (!verifyPassword(body.currentPassword, user.passwordHash)) {
      throw err.validation('Current password is incorrect');
    }
    clearRate(rateKey);

    await db.update(schema.users)
      .set({ passwordHash: hashPassword(body.newPassword), failedLogins: 0, lockedUntil: null })
      .where(eq(schema.users.id, user.id));
    await db.update(schema.passwordResets).set({ usedAt: new Date() })
      .where(and(eq(schema.passwordResets.userId, user.id), isNull(schema.passwordResets.usedAt)));

    const current = c.req.header('Authorization')?.match(/^Bearer (.+)$/)?.[1] ?? getCookie(c, SESSION_COOKIE);
    await db.delete(schema.sessions).where(current
      ? and(eq(schema.sessions.userId, user.id), ne(schema.sessions.token, current))
      : eq(schema.sessions.userId, user.id));

    await writeActivity(db, {
      entityType: 'user', entityId: user.id, action: 'password_changed',
      actorId: actor.userId, actorType: actor.actorType, diff: {},
    });
    return c.json({ ok: true });
  });

  // convenience: my accessible project ids
  app.get('/projects', async (c) => {
    const actor = currentActor(c);
    return c.json({ data: await accessibleProjectIds(actor) });
  });

  return app;
}
