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

/**
 * `col = any($1)` with the ids as one array parameter: a workspace's project
 * and space lists can run to thousands, past what a parameter per id allows.
 */
const anyOf = (col: SQL, ids: string[]): SQL => (ids.length ? sql`${col} = any(${sql.param(ids)}::text[])` : sql`false`);

/**
 * The rows of the caller's bell they can still open. A row is written only for
 * someone who could open its project or page at the time; one who has since
 * lost it – taken off a private project, the project deleted, moved out of a
 * page's space, the page made private – must not keep reading its title and
 * link. Hidden, not deleted: the row returns if access does. Checked in SQL so
 * the list's limit and the unread count are both of what is shown.
 *
 * The project is the payload's projectId or, on rows written before events
 * carried one, its task's. A row about a page (page.mentioned, or the
 * comment.mentioned that page mentions were filed under before they had a type
 * of their own) follows canSeePage: a space the caller reads, and then a
 * published page that is not private to its author, unless they edit the
 * space.
 */
async function visibleToCaller(actor: Actor): Promise<SQL> {
  const [projectIds, spaces] = await Promise.all([accessibleProjectIds(actor), spaceAccessSets(actor)]);
  const n = schema.notifications;
  const projectOf = sql`coalesce(${n.payload}->>'projectId',
    (select t.project_id from tasks t where t.id = coalesce(${n.payload}->>'taskId', ${n.payload}->>'id')))`;
  const pageOk = spaces.viewer.length
    ? sql`exists (select 1 from kb_pages pg
        where pg.id = ${n.payload}->>'pageId' and pg.deleted_at is null
          and ${anyOf(sql`pg.space_id`, spaces.viewer)}
          and (${anyOf(sql`pg.space_id`, spaces.editor)}
            or (pg.published and (pg.visibility <> 'private' or pg.created_by = ${actor.userId}))))`
    : sql`false`;
  return sql`(
    (${n.payload}->>'pageId' is null or ${pageOk})
    and (${n.payload}->>'pageId' is not null
      or split_part(${n.type}, '.', 1) <> all(${sql.param(PROJECT_WORK_TYPES)}::text[])
      or ${projectOf} is null or ${anyOf(projectOf, projectIds)})
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

  // A hidden row is not the caller's to mark from a stale bell: it comes back as it was.
  app.post('/:id/read', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    await db.update(schema.notifications).set({ readAt: new Date() })
      .where(and(eq(schema.notifications.id, c.req.param('id')), eq(schema.notifications.userId, actor.userId), await visibleToCaller(actor)));
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
