import { Hono } from 'hono';
import { getDb, schema, eq, sql } from '@ordi/db';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';

/** Workspace settings (PRD §14.7). Trash/restore also here. */
export function settingsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.get('/workspace', async (c) => {
    const { db } = getDb();
    const [ws] = await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.id, 'workspace'));
    return c.json(ws ?? { id: 'workspace', name: 'ordi' });
  });

  app.patch('/workspace', guard('settings.manage'), async (c) => {
    const patch = await c.req.json();
    const { db } = getDb();
    const allowed: Record<string, unknown> = {};
    for (const k of ['name', 'logo', 'legalDetails', 'workingDays', 'defaultCurrency', 'defaultBillable', 'defaultEstimateUnit', 'sensitiveAuditRetentionMonths']) {
      if (patch[k] !== undefined) allowed[k] = patch[k];
    }
    const [existing] = await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.id, 'workspace'));
    if (existing) {
      await db.update(schema.workspaceSettings).set(allowed).where(eq(schema.workspaceSettings.id, 'workspace'));
    } else {
      await db.insert(schema.workspaceSettings).values({ id: 'workspace', ...(allowed as any) });
    }
    return c.json({ ok: true });
  });

  // Trash (PRD §14.7): list soft-deleted across the main business entities.
  app.get('/trash', guard('settings.manage'), async (c) => {
    const { db } = getDb();
    const [projects, tasks, invoices] = await Promise.all([
      db.execute(sql`select id, name, deleted_at from projects where deleted_at is not null limit 50`),
      db.execute(sql`select id, title, deleted_at from tasks where deleted_at is not null limit 50`),
      db.execute(sql`select id, number, deleted_at from invoices where deleted_at is not null limit 50`),
    ]);
    return c.json({ projects, tasks, invoices });
  });

  return app;
}
