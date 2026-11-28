import { Hono } from 'hono';
import { getDb, schema, eq, and, isNull, desc, sql, type SQL } from '@ordi/db';
import type { AppEnv, Actor } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { accessibleProjectIds, spaceAccessSets } from '../../core/access';

/**
 * Notification types about a project's work, stored with its projectId in the
 * payload: the ones the notifications consumer gates by project before
 * writing (workers/consumers.ts, aboutProjectWork), plus the secret reminders
 * and overrides the secrets service writes itself. Finance, leave and sales
 * news may name a project its audience cannot open, and stays.
 */
const PROJECT_WORK_TYPES = ['task', 'comment', 'agent', 'git', 'secret'];

const inList = (ids: string[]): SQL => sql.join(ids.map((id) => sql`${id}`), sql`, `);

/**
 * The rows of the caller's bell they can still open. A row is written only for
 * someone who could open its project or page at the time; one who has since
 * lost it – taken off a private project, the project deleted, moved out of a
 * page's space, the page made private – must not keep reading its title and
 * link. Hidden, not deleted: the row returns if access does. Checked in SQL so
 * the list's limit and the unread count are both of what is shown.
 *
 * A page mention follows canSeePage: a space the caller reads, and then
 * a published page that is not private to its author, unless they edit
 * the space.
 */
async function visibleToCaller(actor: Actor): Promise<SQL> {
  const [projectIds, spaces] = await Promise.all([accessibleProjectIds(actor), spaceAccessSets(actor)]);
  const n = schema.notifications;
  const projectOk = projectIds.length
    ? sql`(${n.payload}->>'projectId') in (${inList(projectIds)})`
    : sql`false`;
  const editorOk = spaces.editor.length ? sql`pg.space_id in (${inList(spaces.editor)})` : sql`false`;
  const pageOk = spaces.viewer.length
    ? sql`exists (select 1 from kb_pages pg
        where pg.id = ${n.payload}->>'pageId' and pg.deleted_at is null
          and pg.space_id in (${inList(spaces.viewer)})
          and (${editorOk} or (pg.published and (pg.visibility <> 'private' or pg.created_by = ${actor.userId}))))`
    : sql`false`;
  return sql`(
    (split_part(${n.type}, '.', 1) not in (${inList(PROJECT_WORK_TYPES)})
      or ${n.payload}->>'projectId' is null or ${projectOk})
    and (${n.type} <> 'page.mentioned' or ${n.payload}->>'pageId' is null or ${pageOk})
  )`;
}

export function notificationsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.get('/', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const visible = await visibleToCaller(actor);
    const rows = await db.select().from(schema.notifications)
      .where(and(eq(schema.notifications.userId, actor.userId), visible))
      .orderBy(desc(schema.notifications.createdAt)).limit(100);
    const countRows = await db.select({ count: sql<number>`count(*)::int` }).from(schema.notifications)
      .where(and(eq(schema.notifications.userId, actor.userId), isNull(schema.notifications.readAt), visible));
    return c.json({ data: rows, unread: Number(countRows[0]?.count ?? 0) });
  });

  app.post('/:id/read', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    await db.update(schema.notifications).set({ readAt: new Date() })
      .where(and(eq(schema.notifications.id, c.req.param('id')), eq(schema.notifications.userId, actor.userId)));
    return c.json({ ok: true });
  });

  // What the bell shows: a hidden row keeps its state, and comes back as it
  // was if access does.
  app.post('/read-all', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    await db.update(schema.notifications).set({ readAt: new Date() })
      .where(and(eq(schema.notifications.userId, actor.userId), isNull(schema.notifications.readAt), await visibleToCaller(actor)));
    return c.json({ ok: true });
  });

  return app;
}
