import { Hono } from 'hono';
import { getDb, schema, eq, and, or, isNull, inArray, sql, desc } from '@ordi/db';
import { ulid } from 'ulid';
import { dashboardInputSchema, dashboardWidgetInputSchema } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { visibleActivityTypes } from '../../core/activity';
import { accessibleProjectIds } from '../../core/access';
import { err } from '../../lib/errors';

export function dashboardRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // Home dashboard (PRD §14.1): one response, widgets gated by permissions.
  app.get('/dashboard', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const perms = actor.access.permissions;
    const projectIds = await accessibleProjectIds(actor);
    const out: Record<string, unknown> = {};
    const today = new Date().toISOString().slice(0, 10);

    // My tasks today / overdue
    const myTasks = await db.execute(sql`
      select t.id, t.title, t.due_date, t.priority, p.key, t.number, ts.category
      from tasks t
      join task_assignees ta on ta.task_id = t.id and ta.user_id = ${actor.userId}
      join projects p on p.id = t.project_id
      join task_statuses ts on ts.id = t.status_id
      where t.deleted_at is null and ts.category not in ('done','canceled')
      order by t.due_date nulls last limit 50`);
    out.myTasks = {
      overdue: (myTasks as any[]).filter((t) => t.due_date && t.due_date < today),
      today: (myTasks as any[]).filter((t) => t.due_date === today),
      upcoming: (myTasks as any[]).filter((t) => !t.due_date || t.due_date > today),
    };

    if (perms.has('finance.read')) {
      const rec = await db.execute(sql`
        select currency, coalesce(sum(total - amount_paid),0) as outstanding
        from invoices where deleted_at is null and status not in ('paid','canceled','draft')
        group by currency`);
      const overdue = await db.execute(sql`
        select count(*)::int as count, coalesce(sum(total - amount_paid),0) as amount
        from invoices where deleted_at is null and status not in ('paid','canceled','draft') and due_date < ${today}`);
      out.receivables = rec;
      out.overdue = (overdue as any[])[0];
    }

    if (perms.has('deals.read')) {
      const deals = await db.execute(sql`
        select s.name as stage, count(*)::int as count, coalesce(sum(d.amount),0) as amount
        from deals d join deal_stages s on s.id = d.stage_id
        where d.deleted_at is null and s.is_won = false and s.is_lost = false
        group by s.name, s.position order by s.position`);
      out.dealsByStage = deals;
    }

    // Recent activity, filtered by access: sensitivity (normal only unless privileged)
    // and entity domain (only types the actor's permissions cover; own actions always visible).
    const canSensitive = perms.has('people.read_sensitive') || perms.has('people.read_compensation');
    const visibleTypes = visibleActivityTypes(perms);
    const activity = await db.select().from(schema.activityLog)
      .where(and(
        canSensitive ? undefined : eq(schema.activityLog.sensitivity, 'normal'),
        visibleTypes === null ? undefined : or(
          eq(schema.activityLog.actorId, actor.userId),
          visibleTypes.length ? inArray(schema.activityLog.entityType, visibleTypes) : undefined,
        ),
      ))
      .orderBy(desc(schema.activityLog.createdAt)).limit(15);
    out.recentActivity = activity;
    out.projectCount = projectIds.length;

    return c.json(out);
  });

  // ── Custom dashboards (PRD §14.1) ──
  app.get('/dashboards', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const rows = await db.select().from(schema.dashboards).where(
      or(eq(schema.dashboards.ownerId, actor.userId), eq(schema.dashboards.visibility, 'workspace')),
    );
    return c.json({ data: rows });
  });

  app.post('/dashboards', async (c) => {
    const actor = currentActor(c);
    const body = dashboardInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.dashboards).values({ id, ownerId: actor.userId, name: body.name, visibility: body.visibility });
    return c.json({ id }, 201);
  });

  app.get('/dashboards/:id', async (c) => {
    const { db } = getDb();
    const id = c.req.param('id');
    const [dash] = await db.select().from(schema.dashboards).where(eq(schema.dashboards.id, id));
    if (!dash) throw err.notFound();
    const widgets = await db.select().from(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.dashboardId, id));
    return c.json({ ...dash, widgets });
  });

  app.post('/dashboards/:id/widgets', async (c) => {
    const body = dashboardWidgetInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.dashboardWidgets).values({
      id, dashboardId: c.req.param('id'), widgetType: body.widgetType, source: body.source,
      config: body.config, layout: body.layout,
    });
    return c.json({ id }, 201);
  });

  app.delete('/dashboards/:id/widgets/:widgetId', async (c) => {
    const { db } = getDb();
    await db.delete(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.id, c.req.param('widgetId')));
    return c.json({ ok: true });
  });

  // Widget data – computed server-side with forced permission overlay (PRD §14.1).
  app.get('/dashboards/:id/widgets/:widgetId/data', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const [widget] = await db.select().from(schema.dashboardWidgets).where(eq(schema.dashboardWidgets.id, c.req.param('widgetId')));
    if (!widget) throw err.notFound();
    const source = widget.source;
    const perms = actor.access.permissions;
    const sourcePerm: Record<string, string> = {
      invoices: 'finance.read', deals: 'deals.read', profitability: 'finance.read_costs', tasks: 'projects.read', time: 'time.read_all',
    };
    const needed = sourcePerm[source];
    if (needed && !perms.has(needed) && !(source === 'tasks')) {
      throw err.forbidden(`Widget requires ${needed}`, needed);
    }
    const cfg = widget.config as any;
    const data = await computeWidget(source, cfg, actor);
    return c.json({ data });
  });

  return app;
}

async function computeWidget(source: string, cfg: any, actor: any): Promise<any[]> {
  const { db } = getDb();
  const metric = cfg.metric ?? 'count';
  if (source === 'tasks') {
    const projectIds = await accessibleProjectIds(actor);
    if (!projectIds.length) return [];
    const groupExpr = cfg.groupBy === 'priority' ? sql`t.priority`
      : cfg.groupBy === 'assignee' ? sql`ta.user_id`
      : sql`ts.category`;
    const rows = await db.execute(sql`
      select ${groupExpr} as key,
        ${metric === 'sum_estimate' ? sql`coalesce(sum(t.estimate),0)` : sql`count(*)::int`} as value
      from tasks t
      join task_statuses ts on ts.id = t.status_id
      left join task_assignees ta on ta.task_id = t.id
      where t.deleted_at is null and t.project_id in ${sql.raw('(' + projectIds.map((id: string) => `'${id}'`).join(',') + ')')}
      group by key`);
    return rows as any[];
  }
  if (source === 'invoices') {
    const rows = await db.execute(sql`
      select status as key, ${metric === 'sum_amount' ? sql`coalesce(sum(total),0)` : sql`count(*)::int`} as value
      from invoices where deleted_at is null group by status`);
    return rows as any[];
  }
  if (source === 'deals') {
    const rows = await db.execute(sql`
      select s.name as key, ${metric === 'sum_amount' ? sql`coalesce(sum(d.amount),0)` : sql`count(*)::int`} as value
      from deals d join deal_stages s on s.id = d.stage_id where d.deleted_at is null group by s.name`);
    return rows as any[];
  }
  return [];
}
