import { Hono } from 'hono';
import { getDb, schema, eq, or, and, isNull } from '@ordi/db';
import { ulid } from 'ulid';
import { savedViewInputSchema } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { err } from '../../lib/errors';

export function savedViewsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.get('/', async (c) => {
    const actor = currentActor(c);
    const entityType = c.req.query('entityType');
    const { db } = getDb();
    const rows = await db.select().from(schema.savedViews).where(
      and(
        entityType ? eq(schema.savedViews.entityType, entityType) : undefined,
        or(eq(schema.savedViews.userId, actor.userId), eq(schema.savedViews.isShared, true), isNull(schema.savedViews.userId)),
      ),
    );
    return c.json({ data: rows });
  });

  app.post('/', async (c) => {
    const actor = currentActor(c);
    const body = savedViewInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.savedViews).values({
      id, userId: body.isShared ? null : actor.userId, projectId: body.projectId ?? null,
      entityType: body.entityType, name: body.name, filters: body.filters, sort: body.sort,
      layout: body.layout, isShared: body.isShared, createdBy: actor.userId,
    });
    return c.json({ id }, 201);
  });

  app.delete('/:id', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const id = c.req.param('id');
    const [view] = await db.select().from(schema.savedViews).where(eq(schema.savedViews.id, id));
    if (!view) throw err.notFound();
    if (view.userId && view.userId !== actor.userId) throw err.forbidden();
    await db.delete(schema.savedViews).where(eq(schema.savedViews.id, id));
    return c.json({ ok: true });
  });

  return app;
}
