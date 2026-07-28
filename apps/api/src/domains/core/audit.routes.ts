import { Hono } from 'hono';
import { getDb, schema, eq, and, desc, lt, or } from '@ordi/db';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { activityFeedPermission, scopeActivityToResources } from '../../core/activity';
import { err } from '../../lib/errors';

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

  // Per-entity activity tab. An entity's trail is as readable as the entity:
  // the domain permission for that type, then the resource itself. Unguarded,
  // this answered for any id anyone could name – a private project's history,
  // an employee's, an invoice's – to every authenticated user.
  app.get('/entity/:type/:id', async (c) => {
    const actor = currentActor(c);
    const entityType = c.req.param('type');
    const entityId = c.req.param('id');
    if (!actor.access.permissions.has('audit.read')) {
      const needed = activityFeedPermission(entityType);
      if (!needed || !actor.access.permissions.has(needed)) {
        throw err.forbidden(`Missing permission ${needed ?? 'audit.read'}`, needed ?? 'audit.read');
      }
    }
    const canSeeSensitive = actor.access.permissions.has('people.read_sensitive')
      || actor.access.permissions.has('people.read_compensation');
    const { db } = getDb();
    const rows = await db.select().from(schema.activityLog).where(and(
      eq(schema.activityLog.entityType, entityType),
      eq(schema.activityLog.entityId, entityId),
      canSeeSensitive ? undefined : eq(schema.activityLog.sensitivity, 'normal'),
    )).orderBy(desc(schema.activityLog.createdAt)).limit(200);
    return c.json({ data: await scopeActivityToResources(actor, rows) });
  });

  return app;
}
