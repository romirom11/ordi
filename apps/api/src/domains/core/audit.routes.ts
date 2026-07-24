import { Hono } from 'hono';
import { getDb, schema, eq, and, desc, lt, or } from '@ordi/db';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';

export function auditRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // Global audit feed (PRD §14.4). Sensitive records hidden unless read_sensitive/compensation.
  app.get('/', guard('audit.read'), async (c) => {
    const actor = currentActor(c);
    const canSeeSensitive = actor.access.permissions.has('people.read_sensitive')
      || actor.access.permissions.has('people.read_compensation');
    const { db } = getDb();
    const entityType = c.req.query('entityType');
    const actorId = c.req.query('actorId');
    const before = c.req.query('before');
    const rows = await db.select().from(schema.activityLog).where(and(
      canSeeSensitive ? undefined : eq(schema.activityLog.sensitivity, 'normal'),
      entityType ? eq(schema.activityLog.entityType, entityType) : undefined,
      actorId ? eq(schema.activityLog.actorId, actorId) : undefined,
      before ? lt(schema.activityLog.createdAt, new Date(before)) : undefined,
    )).orderBy(desc(schema.activityLog.createdAt)).limit(100);
    return c.json({ data: rows });
  });

  // Per-entity activity tab.
  app.get('/entity/:type/:id', async (c) => {
    const actor = currentActor(c);
    const canSeeSensitive = actor.access.permissions.has('people.read_sensitive')
      || actor.access.permissions.has('people.read_compensation');
    const { db } = getDb();
    const rows = await db.select().from(schema.activityLog).where(and(
      eq(schema.activityLog.entityType, c.req.param('type')),
      eq(schema.activityLog.entityId, c.req.param('id')),
      canSeeSensitive ? undefined : eq(schema.activityLog.sensitivity, 'normal'),
    )).orderBy(desc(schema.activityLog.createdAt)).limit(200);
    return c.json({ data: rows });
  });

  return app;
}
