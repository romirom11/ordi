import { Hono } from 'hono';
import { getDb, schema, eq, and, isNull, desc, sql } from '@ordi/db';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';

export function notificationsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.get('/', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const rows = await db.select().from(schema.notifications)
      .where(eq(schema.notifications.userId, actor.userId))
      .orderBy(desc(schema.notifications.createdAt)).limit(100);
    const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(schema.notifications)
      .where(and(eq(schema.notifications.userId, actor.userId), isNull(schema.notifications.readAt)));
    return c.json({ data: rows, unread: Number(countRows[0]?.count ?? 0) });
  });

  app.post('/:id/read', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    await db.update(schema.notifications).set({ readAt: new Date() })
      .where(and(eq(schema.notifications.id, c.req.param('id')), eq(schema.notifications.userId, actor.userId)));
    return c.json({ ok: true });
  });

  app.post('/read-all', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    await db.update(schema.notifications).set({ readAt: new Date() })
      .where(and(eq(schema.notifications.userId, actor.userId), isNull(schema.notifications.readAt)));
    return c.json({ ok: true });
  });

  return app;
}
