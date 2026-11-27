import { Hono } from 'hono';
import { getDb, schema, eq, or, and, isNull } from '@ordi/db';
import { ulid } from 'ulid';
import { savedViewInputSchema } from '@ordi/shared';
import type { Actor, AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { rejectReadOnlyWrites } from '../../core/rbac';
import { err } from '../../lib/errors';
import { accessibleProjectIds, assertProject } from '../../core/access';

/**
 * Who may delete a saved view. A personal one is its user's. A shared one
 * (no user: everyone sees it) is its creator's, or whoever runs the
 * workspace's shared setup – settings.manage, which already covers templates
 * and custom fields. It used to be anyone's: a shared view had no user, and
 * "no user" was read as "no owner".
 */
function canDeleteView(actor: Actor, view: { userId: string | null; createdBy: string | null }): boolean {
  if (view.userId) return view.userId === actor.userId;
  return view.createdBy === actor.userId || actor.access.permissions.has('settings.manage');
}

/**
 * The project a view belongs to: its own projectId, or – as the task toolbar
 * saves them – the project named in its filters.
 */
function viewProjectId(view: { projectId?: string | null; filters?: unknown }): string | null {
  if (view.projectId) return view.projectId;
  const named = (view.filters as { projectId?: unknown } | null | undefined)?.projectId;
  return typeof named === 'string' && named ? named : null;
}

export function savedViewsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);
  // Access here is decided per record, not by guard(), so a read-only token
  // has to be refused explicitly or it writes wherever its owner can.
  app.use('*', rejectReadOnlyWrites());

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
    // A shared view of a project is that project's: its name and filters (which
    // may name the project's own fields) are for those who can open it.
    const reach = new Set(await accessibleProjectIds(actor));
    const visible = rows.filter((v) => {
      const projectId = viewProjectId(v);
      return !projectId || v.userId === actor.userId || reach.has(projectId);
    });
    // The answer the delete route gives, so a client never offers what it refuses.
    return c.json({ data: visible.map((v) => ({ ...v, canDelete: canDeleteView(actor, v) })) });
  });

  app.post('/', async (c) => {
    const actor = currentActor(c);
    const body = savedViewInputSchema.parse(await c.req.json());
    const projectId = viewProjectId(body);
    if (projectId) await assertProject(actor, projectId, 'viewer');
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
    if (!canDeleteView(actor, view)) throw err.forbidden('Only whoever saved this view can delete it');
    await db.delete(schema.savedViews).where(eq(schema.savedViews.id, id));
    return c.json({ ok: true });
  });

  return app;
}
