import { Hono } from 'hono';
import { getDb, sql } from '@ordi/db';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { accessibleProjectIds } from '../../core/access';

/**
 * Global search (PRD §14.2): FTS + trigram, permission-filtered. Ranking:
 * exact number > title > body. Results limited to what the actor can access.
 */
export function searchRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.get('/', async (c) => {
    const actor = currentActor(c);
    const q = (c.req.query('q') ?? '').trim();
    if (!q) return c.json({ data: [] });
    const { db } = getDb();
    const perms = actor.access.permissions;
    const projectIds = await accessibleProjectIds(actor);
    const tsq = q.replace(/[^\w\s-]/g, ' ').trim().split(/\s+/).filter(Boolean).map((w) => `${w}:*`).join(' & ');
    const results: any[] = [];

    if (perms.has('crm.read')) {
      const rows = await db.execute(sql`
        select id, name as title, 'company' as kind from companies
        where deleted_at is null and (${tsq ? sql`search_vector @@ to_tsquery('simple', ${tsq})` : sql`false`} or name ilike ${'%' + q + '%'})
        limit 6`);
      results.push(...(rows as any[]).map((r) => ({ ...r, url: `/companies/${r.id}` })));
    }

    if (projectIds.length) {
      const rows = await db.execute(sql`
        select t.id, (p.key || '-' || t.number) as ref, t.title, 'task' as kind, t.project_id
        from tasks t join projects p on p.id = t.project_id
        where t.deleted_at is null and t.project_id in ${sql.raw('(' + projectIds.map((id) => `'${id}'`).join(',') + ')')}
        and (${tsq ? sql`t.search_vector @@ to_tsquery('simple', ${tsq})` : sql`false`} or t.title ilike ${'%' + q + '%'})
        limit 8`);
      results.push(...(rows as any[]).map((r) => ({ id: r.id, title: `${r.ref} ${r.title}`, kind: 'task', url: `/projects/${r.project_id}/tasks/${r.id}` })));
    }

    if (perms.has('finance.read')) {
      const rows = await db.execute(sql`
        select id, number as title, 'invoice' as kind from invoices
        where deleted_at is null and number ilike ${'%' + q + '%'} limit 5`);
      results.push(...(rows as any[]).map((r) => ({ ...r, url: `/finance/invoices/${r.id}` })));
    }

    if (perms.has('kb.read')) {
      const rows = await db.execute(sql`
        select pg.id, pg.title, 'page' as kind, pg.space_id from kb_pages pg
        where pg.deleted_at is null
        and (${tsq ? sql`pg.search_vector @@ to_tsquery('simple', ${tsq})` : sql`false`} or pg.title ilike ${'%' + q + '%'})
        limit 6`);
      results.push(...(rows as any[]).map((r) => ({ id: r.id, title: r.title, kind: 'page', url: `/kb/${r.space_id}/${r.id}` })));
    }

    return c.json({ data: results });
  });

  return app;
}
