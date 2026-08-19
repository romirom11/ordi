import { Hono } from 'hono';
import { getDb, schema, eq, and, isNull, desc } from '@ordi/db';
import { ulid } from 'ulid';
import {
  taskInputSchema, taskUpdateSchema, taskMoveSchema, taskRelationSchema, taskLinkSchema,
  bulkTaskUpdateSchema, commentInputSchema, labelInputSchema, labelPatchSchema, cycleInputSchema, cycleCompleteSchema,
  taskTemplateInputSchema, recurringTaskInputSchema, intakeAcceptSchema, intakeDeclineSchema, intakeSettingsSchema,
  LABEL_SCOPES,
  type CustomFieldFilter, type LabelScope,
} from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { err } from '../../lib/errors';
import { idPage } from '../../lib/http';
import { assertProject } from '../../core/access';
import * as svc from './service';

function parseCfFilters(c: any): CustomFieldFilter[] {
  const raw = c.req.query('cf');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

function requireSettingsManage(c: any) {
  const actor = currentActor(c);
  if (!actor.access.permissions.has('settings.manage')) throw err.forbidden('Missing permission settings.manage', 'settings.manage');
  return actor;
}

/** Next run date from a recurring frequency (PRD §8.7). */
function nextRunFrom(frequency: string): string {
  const d = new Date();
  if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (frequency === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else d.setUTCDate(d.getUTCDate() + 1); // daily | custom default
  return d.toISOString().slice(0, 10);
}

export function tasksRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // ── My tasks (cross-project, PRD §8.5) ──
  app.get('/me/tasks', async (c) => c.json(await svc.myTasks(currentActor(c))));

  // ── Tasks ──
  app.get('/tasks', async (c) => {
    // The list minted a `nextCursor` long before it read one back, so every
    // caller silently saw the newest page and nothing behind it.
    const { limit, cursor } = idPage(c, 50, 200);
    return c.json(await svc.listTasks(currentActor(c), {
      projectId: c.req.query('projectId'), status: c.req.query('status'), priority: c.req.query('priority'),
      assignee: c.req.query('assignee'), cycleId: c.req.query('cycleId'), type: c.req.query('type'),
      parentId: c.req.query('parentId'), milestoneId: c.req.query('milestoneId'),
      // `label` takes one id or a comma-separated set; a set means all of them.
      labels: (c.req.query('label') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      q: c.req.query('q'), dueFrom: c.req.query('dueFrom'), dueTo: c.req.query('dueTo'),
      cfFilters: parseCfFilters(c), cursor, limit,
    }));
  });

  // static route before /tasks/:id
  app.post('/tasks/bulk', async (c) => {
    const body = bulkTaskUpdateSchema.parse(await c.req.json());
    return c.json(await svc.bulkUpdateTasks(currentActor(c), body));
  });

  app.post('/tasks', async (c) => {
    const body = taskInputSchema.parse(await c.req.json());
    return c.json(await svc.createTask(currentActor(c), body), 201);
  });

  app.get('/tasks/:id', async (c) => {
    const include = (c.req.query('include') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    return c.json(await svc.getTask(currentActor(c), c.req.param('id'), include));
  });

  app.patch('/tasks/:id', async (c) => {
    const body = taskUpdateSchema.parse(await c.req.json());
    return c.json(await svc.updateTask(currentActor(c), c.req.param('id'), body));
  });

  app.delete('/tasks/:id', async (c) => {
    await svc.softDeleteTask(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/tasks/:id/move', async (c) => {
    const body = taskMoveSchema.parse(await c.req.json());
    return c.json(await svc.moveTask(currentActor(c), c.req.param('id'), body.targetProjectId));
  });

  app.post('/tasks/:id/duplicate', async (c) => c.json(await svc.duplicateTask(currentActor(c), c.req.param('id')), 201));

  app.get('/tasks/:id/branch-name', async (c) => c.json(await svc.branchName(currentActor(c), c.req.param('id'))));

  // ── Relations ──
  app.post('/tasks/:id/relations', async (c) => {
    const body = taskRelationSchema.parse(await c.req.json());
    return c.json(await svc.addRelation(currentActor(c), c.req.param('id'), body), 201);
  });

  app.delete('/tasks/:id/relations/:relId', async (c) =>
    c.json(await svc.deleteRelation(currentActor(c), c.req.param('id'), c.req.param('relId'))));

  // ── External links ──
  app.post('/tasks/:id/links', async (c) => {
    const body = taskLinkSchema.parse(await c.req.json());
    return c.json(await svc.addLink(currentActor(c), c.req.param('id'), body), 201);
  });

  app.delete('/tasks/:id/links/:linkId', async (c) =>
    c.json(await svc.deleteLink(currentActor(c), c.req.param('id'), c.req.param('linkId'))));

  // ── Comments ──
  app.get('/tasks/:id/comments', async (c) => c.json({ data: await svc.listComments(currentActor(c), c.req.param('id')) }));

  app.post('/tasks/:id/comments', async (c) => {
    const body = commentInputSchema.parse(await c.req.json());
    return c.json(await svc.addComment(currentActor(c), c.req.param('id'), body), 201);
  });

  app.patch('/comments/:id', async (c) => {
    const body = commentInputSchema.partial().parse(await c.req.json());
    return c.json(await svc.editComment(currentActor(c), c.req.param('id'), body.body));
  });

  app.delete('/comments/:id', async (c) => c.json(await svc.deleteComment(currentActor(c), c.req.param('id'))));

  // ── Labels (workspace-level, PRD §8.3) ──
  // Scoped vocabularies in one table: `?scope=task|project|lead` picks one, no
  // scope returns the whole catalog. Pickers always ask for their own scope –
  // a task has no business offering "retainer", nor a project "Bug".
  app.get('/labels', async (c) => {
    const { db } = getDb();
    const scope = c.req.query('scope');
    if (scope && !LABEL_SCOPES.includes(scope as LabelScope)) throw err.domain(`Unknown label scope ${scope}`);
    return c.json({
      data: await db.select().from(schema.labels)
        .where(scope ? eq(schema.labels.scope, scope) : undefined),
    });
  });

  app.post('/labels', guard('settings.manage'), async (c) => {
    const body = labelInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.labels).values({ id, name: body.name, color: body.color, scope: body.scope });
    return c.json({ id, scope: body.scope }, 201);
  });

  app.patch('/labels/:id', guard('settings.manage'), async (c) => {
    const body = labelPatchSchema.parse(await c.req.json());
    if (body.name === undefined && body.color === undefined) throw err.validation('Nothing to update – pass name and/or color');
    const { db } = getDb();
    const [label] = await db.select().from(schema.labels).where(eq(schema.labels.id, c.req.param('id')));
    if (!label) throw err.notFound('Label not found');
    await db.update(schema.labels).set({
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.color === undefined ? {} : { color: body.color }),
    }).where(eq(schema.labels.id, label.id));
    return c.json({ ok: true });
  });

  app.delete('/labels/:id', guard('settings.manage'), async (c) => {
    const { db } = getDb();
    await db.delete(schema.labels).where(eq(schema.labels.id, c.req.param('id')));
    return c.json({ ok: true });
  });

  // ── Cycles (PRD §8.4) ──
  app.get('/projects/:id/cycles', async (c) => c.json({ data: await svc.listCycles(currentActor(c), c.req.param('id')) }));

  app.post('/cycles', async (c) => {
    const body = cycleInputSchema.parse(await c.req.json());
    return c.json(await svc.createCycle(currentActor(c), body), 201);
  });

  app.get('/cycles/:id', async (c) => c.json(await svc.cycleProgress(currentActor(c), c.req.param('id'))));

  app.get('/cycles/:id/snapshots', async (c) => c.json({ data: await svc.cycleSnapshots(currentActor(c), c.req.param('id')) }));

  app.patch('/cycles/:id', async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = cycleInputSchema.partial().parse(raw);
    return c.json(await svc.updateCycle(currentActor(c), c.req.param('id'), { ...parsed, status: raw?.status, version: raw?.version }));
  });

  app.post('/cycles/:id/complete', async (c) => {
    const body = cycleCompleteSchema.parse(await c.req.json().catch(() => ({})));
    return c.json(await svc.completeCycle(currentActor(c), c.req.param('id'), body));
  });

  // ── Drafts (PRD §8.3) ──
  app.get('/drafts', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    return c.json({ data: await db.select().from(schema.taskDrafts).where(eq(schema.taskDrafts.userId, actor.userId)).orderBy(desc(schema.taskDrafts.updatedAt)) });
  });

  app.post('/drafts', async (c) => {
    const actor = currentActor(c);
    const body = await c.req.json().catch(() => ({}));
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.taskDrafts).values({ id, userId: actor.userId, projectId: body?.projectId ?? null, payload: body?.payload ?? {} });
    return c.json({ id }, 201);
  });

  app.delete('/drafts/:id', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    await db.delete(schema.taskDrafts).where(and(eq(schema.taskDrafts.id, c.req.param('id')), eq(schema.taskDrafts.userId, actor.userId)));
    return c.json({ ok: true });
  });

  // ── Task templates (workspace + project, PRD §8.7) ──
  app.get('/task-templates', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.query('projectId');
    const { db } = getDb();
    const workspace = await db.select().from(schema.taskTemplates).where(isNull(schema.taskTemplates.projectId));
    if (projectId) {
      await assertProject(actor, projectId, 'viewer');
      const rows = await db.select().from(schema.taskTemplates).where(eq(schema.taskTemplates.projectId, projectId));
      return c.json({ data: [...workspace, ...rows] });
    }
    return c.json({ data: workspace });
  });

  app.post('/task-templates', async (c) => {
    const actor = currentActor(c);
    const body = taskTemplateInputSchema.parse(await c.req.json());
    if (body.projectId) await assertProject(actor, body.projectId, 'admin');
    else requireSettingsManage(c);
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.taskTemplates).values({ id, projectId: body.projectId ?? null, name: body.name, definition: body.definition });
    return c.json({ id }, 201);
  });

  app.delete('/task-templates/:id', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const [tpl] = await db.select().from(schema.taskTemplates).where(eq(schema.taskTemplates.id, c.req.param('id')));
    if (!tpl) throw err.notFound('Task template not found');
    if (tpl.projectId) await assertProject(actor, tpl.projectId, 'admin');
    else requireSettingsManage(c);
    await db.delete(schema.taskTemplates).where(eq(schema.taskTemplates.id, c.req.param('id')));
    return c.json({ ok: true });
  });

  // ── Recurring tasks (PRD §8.7) ──
  app.get('/recurring-tasks', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.query('projectId');
    if (!projectId) throw err.validation('projectId required');
    await assertProject(actor, projectId, 'viewer');
    const { db } = getDb();
    return c.json({ data: await db.select().from(schema.recurringTasks).where(eq(schema.recurringTasks.projectId, projectId)) });
  });

  app.post('/recurring-tasks', async (c) => {
    const actor = currentActor(c);
    const body = recurringTaskInputSchema.parse(await c.req.json());
    await assertProject(actor, body.projectId, 'admin');
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.recurringTasks).values({
      id, projectId: body.projectId, templateId: body.templateId, frequency: body.frequency,
      cron: body.cron ?? null, nextRun: nextRunFrom(body.frequency), active: body.active,
    });
    return c.json({ id }, 201);
  });

  app.patch('/recurring-tasks/:id', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const [row] = await db.select().from(schema.recurringTasks).where(eq(schema.recurringTasks.id, c.req.param('id')));
    if (!row) throw err.notFound('Recurring task not found');
    await assertProject(actor, row.projectId, 'admin');
    const body = recurringTaskInputSchema.partial().parse(await c.req.json());
    const patch: Record<string, unknown> = {};
    for (const k of ['templateId', 'frequency', 'cron', 'active'] as const) if (body[k] !== undefined) patch[k] = body[k];
    if (body.frequency !== undefined) patch.nextRun = nextRunFrom(body.frequency);
    if (Object.keys(patch).length) await db.update(schema.recurringTasks).set(patch).where(eq(schema.recurringTasks.id, c.req.param('id')));
    return c.json({ ok: true });
  });

  app.delete('/recurring-tasks/:id', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const [row] = await db.select().from(schema.recurringTasks).where(eq(schema.recurringTasks.id, c.req.param('id')));
    if (!row) throw err.notFound('Recurring task not found');
    await assertProject(actor, row.projectId, 'admin');
    await db.delete(schema.recurringTasks).where(eq(schema.recurringTasks.id, c.req.param('id')));
    return c.json({ ok: true });
  });

  // ── Intake triage (PRD §8.6) ──
  app.get('/projects/:id/intake', async (c) => c.json({ data: await svc.listIntake(currentActor(c), c.req.param('id')) }));

  app.post('/intake/:itemId/accept', async (c) => {
    const body = intakeAcceptSchema.parse(await c.req.json());
    return c.json(await svc.acceptIntake(currentActor(c), c.req.param('itemId'), body), 201);
  });

  app.post('/intake/:itemId/decline', async (c) => {
    const body = intakeDeclineSchema.parse(await c.req.json());
    return c.json(await svc.declineIntake(currentActor(c), c.req.param('itemId'), body));
  });

  app.get('/projects/:id/intake-settings', async (c) => c.json(await svc.getIntakeSettings(currentActor(c), c.req.param('id'))));

  app.patch('/projects/:id/intake-settings', async (c) => {
    const body = intakeSettingsSchema.parse(await c.req.json());
    return c.json(await svc.updateIntakeSettings(currentActor(c), c.req.param('id'), body));
  });

  return app;
}
