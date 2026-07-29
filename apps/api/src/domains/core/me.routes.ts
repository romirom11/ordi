import { Hono } from 'hono';
import { getDb, schema, eq } from '@ordi/db';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { updateProfileSchema } from '@ordi/shared';
import { accessibleProjectIds } from '../../core/access';

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

  // convenience: my accessible project ids
  app.get('/projects', async (c) => {
    const actor = currentActor(c);
    return c.json({ data: await accessibleProjectIds(actor) });
  });

  return app;
}
