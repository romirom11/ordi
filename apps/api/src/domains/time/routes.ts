import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  timeEntryInputSchema, timeEntryUpdateSchema, timerStartSchema,
  projectRateInputSchema, timeReportQuerySchema, type Permission,
} from '@ordi/shared';
import type { AppEnv, Actor } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard, hasPerm, isMutatingMethod, isWritePermission } from '../../core/rbac';
import { assertProject } from '../../core/access';
import { err } from '../../lib/errors';
import { page } from '../../lib/http';
import * as svc from './service';

/**
 * cost_rate is derived from compensation (PRD §11.10), so an entry only carries
 * it for finance.read_costs – time.read_all alone must not reveal pay.
 */
function withoutCost<T extends { costRate?: unknown }>(actor: Actor, entry: T): T | Omit<T, 'costRate'> {
  if (hasPerm(actor, 'finance.read_costs')) return entry;
  const { costRate: _costRate, ...rest } = entry;
  return rest;
}

/** Passes when the actor holds ANY of the given permissions (PRD §4.5). */
function guardAny(...perms: Permission[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = currentActor(c);
    const held = perms.filter((p) => actor.access.permissions.has(p));
    if (held.length === 0) throw err.forbidden(`Missing permission ${perms.join(' or ')}`, perms[0]);
    if (actor.readOnly && (isMutatingMethod(c.req.method) || held.every(isWritePermission))) throw err.forbidden('Read-only token', held[0]);
    await next();
  };
}

/** Passes when the actor holds `perm` OR is an admin of the requested project. */
function guardProjectAdminOr(perm: Permission): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = currentActor(c);
    if (actor.access.permissions.has(perm)) { await next(); return; }
    const projectId = c.req.query('projectId');
    if (!projectId) throw err.validation('projectId required');
    await assertProject(actor, projectId, 'admin'); // 404 if not a project admin
    await next();
  };
}

export function timeRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // ── Entries ──
  app.get('/time/entries', guardAny('time.track', 'time.read_all'), async (c) => {
    const actor = currentActor(c);
    const limit = Number(c.req.query('limit') ?? 50);
    const rows = await svc.listEntries(actor, {
      from: c.req.query('from'), to: c.req.query('to'), projectId: c.req.query('projectId'),
      userId: c.req.query('userId'), taskId: c.req.query('taskId'), limit,
    }, hasPerm(actor, 'time.read_all'));
    const res = page(rows, limit, (r) => ({ startedAt: r.startedAt }));
    return c.json({ ...res, data: res.data.map((r) => withoutCost(actor, r)) });
  });

  app.post('/time/entries', guard('time.track'), async (c) => {
    const body = timeEntryInputSchema.parse(await c.req.json());
    const id = await svc.createEntry(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.patch('/time/entries/:id', guardAny('time.track', 'time.manage'), async (c) => {
    const body = timeEntryUpdateSchema.parse(await c.req.json());
    const actor = currentActor(c);
    return c.json(withoutCost(actor, await svc.updateEntry(actor, c.req.param('id'), body, hasPerm(actor, 'time.manage'))));
  });

  app.delete('/time/entries/:id', guardAny('time.track', 'time.manage'), async (c) => {
    const actor = currentActor(c);
    await svc.deleteEntry(actor, c.req.param('id'), hasPerm(actor, 'time.manage'));
    return c.json({ ok: true });
  });

  // ── Timer ──
  app.post('/time/timer/start', guard('time.track'), async (c) => {
    const body = timerStartSchema.parse(await c.req.json());
    return c.json(await svc.startTimer(currentActor(c), body));
  });

  app.post('/time/timer/stop', guard('time.track'), async (c) =>
    c.json(await svc.stopTimer(currentActor(c))));

  app.get('/time/timer', guard('time.track'), async (c) =>
    c.json(await svc.getTimer(currentActor(c))));

  // ── Rates ──
  app.get('/time/rates', guardProjectAdminOr('time.read_all'), async (c) => {
    const projectId = c.req.query('projectId');
    if (!projectId) throw err.validation('projectId required');
    return c.json({ data: await svc.listRates(projectId) });
  });

  app.post('/time/rates', guardAny('time.manage', 'finance.settings'), async (c) => {
    const body = projectRateInputSchema.parse(await c.req.json());
    const id = await svc.upsertRate(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.delete('/time/rates/:id', guardAny('time.manage', 'finance.settings'), async (c) => {
    await svc.deleteRate(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Reports ──
  app.get('/time/reports', guard('time.read_all'), async (c) => {
    const q = timeReportQuerySchema.parse({
      from: c.req.query('from'), to: c.req.query('to'),
      groupBy: c.req.query('groupBy') ?? undefined, billable: c.req.query('billable') ?? undefined,
      projectId: c.req.query('projectId') ?? undefined,
    });
    return c.json({ data: await svc.report(q) });
  });

  app.get('/time/unbilled', guardAny('time.read_all', 'finance.read'), async (c) =>
    c.json({ data: await svc.unbilled({ companyId: c.req.query('companyId'), from: c.req.query('from'), to: c.req.query('to') }) }));

  app.get('/time/my-week', guard('time.track'), async (c) => {
    const weekStart = c.req.query('weekStart');
    if (!weekStart) throw err.validation('weekStart required');
    const actor = currentActor(c);
    const week = await svc.myWeek(actor, weekStart);
    return c.json({ ...week, days: week.days.map((d) => ({ ...d, entries: d.entries.map((e) => withoutCost(actor, e)) })) });
  });

  return app;
}
