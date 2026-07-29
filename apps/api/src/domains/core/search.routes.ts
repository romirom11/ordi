import { Hono } from 'hono';
import { getDb, sql } from '@ordi/db';
import { docToText, snippet } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { accessibleProjectIds, accessibleSpaceIds } from '../../core/access';

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

    if (perms.has('crm.read')) {
      const rows = await db.execute(sql`
        select id, title, 'lead' as kind, company_id from leads
        where deleted_at is null
          and (${tsq ? sql`search_vector @@ to_tsquery('simple', ${tsq})` : sql`false`}
            or title ilike ${'%' + q + '%'}
            or pain_signal ilike ${'%' + q + '%'})
        order by score desc nulls last, created_at desc
        limit 6`);
      results.push(...(rows as any[]).map((r) => ({
        id: r.id,
        title: r.title,
        kind: 'lead',
        url: `/leads/${r.id}`,
      })));
    }

    if (projectIds.length) {
      const rows = await db.execute(sql`
        select id, name, key, 'project' as kind from projects
        where deleted_at is null and id in ${sql.raw('(' + projectIds.map((id) => `'${id}'`).join(',') + ')')}
        and (name ilike ${'%' + q + '%'} or key ilike ${'%' + q + '%'})
        order by case when key ilike ${'%' + q + '%'} then 0 else 1 end, name
        limit 6`);
      results.push(...(rows as any[]).map((r) => ({ id: r.id, title: `${r.key} ${r.name}`, kind: 'project', url: `/projects/${r.id}` })));
    }

    if (projectIds.length) {
      const rows = await db.execute(sql`
        select t.id, (p.key || '-' || t.number) as ref, t.title, 'task' as kind, t.project_id
        from tasks t join projects p on p.id = t.project_id
        where t.deleted_at is null and t.project_id in ${sql.raw('(' + projectIds.map((id) => `'${id}'`).join(',') + ')')}
        and (${tsq ? sql`t.search_vector @@ to_tsquery('simple', ${tsq})` : sql`false`}
          or t.title ilike ${'%' + q + '%'}
          or (p.key || '-' || t.number) ilike ${'%' + q + '%'})
        order by case when (p.key || '-' || t.number) ilike ${'%' + q + '%'} then 0 else 1 end, t.number desc
        limit 8`);
      results.push(...(rows as any[]).map((r) => ({ id: r.id, title: `${r.ref} ${r.title}`, kind: 'task', url: `/projects/${r.project_id}/tasks/${r.id}` })));
    }

    // Notes carry the qualitative half of the CRM (call summaries, prospect
    // cards), which was writable and then unreadable: nothing listed them and
    // search did not look inside. No FTS column here – the body is tiptap JSON,
    // so this matches its text and renders a snippet for the hit.
    if (perms.has('crm.read')) {
      const rows = await db.execute(sql`
        select n.id, n.body, n.company_id, n.contact_id, n.lead_id, n.deal_id,
               coalesce(c.name, cc.name, l.title, d.title) as parent_title,
               coalesce(n.company_id, ct.company_id, l.company_id, d.company_id) as owner_company_id
        from notes n
        left join companies c on c.id = n.company_id
        left join contacts ct on ct.id = n.contact_id
        left join companies cc on cc.id = ct.company_id
        left join leads l on l.id = n.lead_id
        left join deals d on d.id = n.deal_id
        where n.deleted_at is null and n.body::text ilike ${'%' + q + '%'}
        order by n.created_at desc limit 6`);
      results.push(...(rows as any[]).map((r) => ({
        id: r.id,
        title: snippet(docToText(r.body), q),
        kind: 'note',
        parentTitle: r.parent_title ?? null,
        url: r.lead_id ? `/leads/${r.lead_id}` : r.deal_id ? `/deals/${r.deal_id}` : r.owner_company_id ? `/companies/${r.owner_company_id}` : '/crm',
      })));
    }

    if (perms.has('finance.read')) {
      const rows = await db.execute(sql`
        select id, number as title, 'invoice' as kind from invoices
        where deleted_at is null and number ilike ${'%' + q + '%'} limit 5`);
      results.push(...(rows as any[]).map((r) => ({ ...r, url: `/finance/invoices/${r.id}` })));
    }

    // Pages live in spaces, and a space can be private – searching them without
    // that scope surfaced titles from spaces the actor cannot open.
    const spaceIds = await accessibleSpaceIds(actor);
    if (spaceIds.length) {
      const rows = await db.execute(sql`
        select pg.id, pg.title, 'page' as kind, pg.space_id from kb_pages pg
        where pg.deleted_at is null
        and pg.space_id in ${sql.raw('(' + spaceIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',') + ')')}
        and (${tsq ? sql`pg.search_vector @@ to_tsquery('simple', ${tsq})` : sql`false`} or pg.title ilike ${'%' + q + '%'})
        limit 6`);
      results.push(...(rows as any[]).map((r) => ({ id: r.id, title: r.title, kind: 'page', url: `/kb/${r.space_id}/${r.id}` })));
    }

    return c.json({ data: results });
  });

  return app;
}
