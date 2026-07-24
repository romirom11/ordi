import { Hono } from 'hono';
import { getDb, schema, eq, and, isNull, asc, sql } from '@ordi/db';
import { ulid } from 'ulid';
import {
  projectInputSchema, projectUpdateSchema, projectMemberInputSchema,
  taskStatusInputSchema, taskTypeInputSchema, projectTypeInputSchema, projectTypeOrderSchema,
  projectTemplateInputSchema, projectRepositoryInputSchema, gitAutomationRuleInputSchema,
} from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { err } from '../../lib/errors';
import { assertProject } from '../../core/access';
import * as svc from './service';

/** Assert settings.manage for workspace-level config changes. */
function requireSettingsManage(c: any) {
  const actor = currentActor(c);
  if (!actor.access.permissions.has('settings.manage')) throw err.forbidden('Missing permission settings.manage', 'settings.manage');
  return actor;
}

export function projectsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // ── Projects (reads are membership-gated, PRD §4.4) ──
  app.get('/projects', async (c) => {
    const rows = await svc.listProjects(currentActor(c), {
      typeId: c.req.query('typeId'), status: c.req.query('status'), companyId: c.req.query('companyId'),
    });
    return c.json({ data: rows });
  });

  app.post('/projects', guard('projects.create'), async (c) => {
    const body = projectInputSchema.parse(await c.req.json());
    const res = await svc.createProject(currentActor(c), body);
    return c.json(res, 201);
  });

  app.get('/projects/:id', async (c) => c.json(await svc.getProject(currentActor(c), c.req.param('id'))));

  app.patch('/projects/:id', async (c) => {
    const body = projectUpdateSchema.parse(await c.req.json());
    return c.json(await svc.updateProject(currentActor(c), c.req.param('id'), body));
  });

  app.delete('/projects/:id', guard('projects.delete'), async (c) => {
    await svc.softDeleteProject(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Members ──
  app.get('/projects/:id/members', async (c) => c.json({ data: await svc.listMembers(currentActor(c), c.req.param('id')) }));

  app.post('/projects/:id/members', async (c) => {
    const body = projectMemberInputSchema.parse(await c.req.json());
    await svc.upsertMember(currentActor(c), c.req.param('id'), body);
    return c.json({ ok: true }, 201);
  });

  app.delete('/projects/:id/members/:userId', async (c) => {
    await svc.removeMember(currentActor(c), c.req.param('id'), c.req.param('userId'));
    return c.json({ ok: true });
  });

  // ── Repositories (git binding, project admin) ──
  app.get('/projects/:id/repositories', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.param('id');
    await assertProject(actor, projectId, 'admin');
    const { db } = getDb();
    return c.json({ data: await db.select().from(schema.projectRepositories).where(eq(schema.projectRepositories.projectId, projectId)) });
  });

  app.post('/projects/:id/repositories', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.param('id');
    await assertProject(actor, projectId, 'admin');
    const body = projectRepositoryInputSchema.parse(await c.req.json());
    const { db } = getDb();
    await db.insert(schema.projectRepositories).values({ projectId, repositoryId: body.repositoryId }).onConflictDoNothing();
    return c.json({ ok: true }, 201);
  });

  app.delete('/projects/:id/repositories/:repoId', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.param('id');
    await assertProject(actor, projectId, 'admin');
    const { db } = getDb();
    await db.delete(schema.projectRepositories).where(and(eq(schema.projectRepositories.projectId, projectId), eq(schema.projectRepositories.repositoryId, c.req.param('repoId'))));
    return c.json({ ok: true });
  });

  // ── Git automation rules (project admin) ──
  app.get('/projects/:id/automation-rules', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.param('id');
    await assertProject(actor, projectId, 'admin');
    const { db } = getDb();
    return c.json({ data: await db.select().from(schema.gitAutomationRules).where(eq(schema.gitAutomationRules.projectId, projectId)) });
  });

  app.post('/projects/:id/automation-rules', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.param('id');
    await assertProject(actor, projectId, 'admin');
    const body = gitAutomationRuleInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.gitAutomationRules).values({ id, projectId, trigger: body.trigger, targetStatusId: body.targetStatusId });
    return c.json({ id }, 201);
  });

  app.delete('/projects/:id/automation-rules/:ruleId', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.param('id');
    await assertProject(actor, projectId, 'admin');
    const { db } = getDb();
    await db.delete(schema.gitAutomationRules).where(and(eq(schema.gitAutomationRules.id, c.req.param('ruleId')), eq(schema.gitAutomationRules.projectId, projectId)));
    return c.json({ ok: true });
  });

  // ── Task statuses (PRD §8.2) ──
  app.get('/projects/:id/task-statuses', async (c) => c.json({ data: await svc.listTaskStatuses(currentActor(c), c.req.param('id')) }));

  app.post('/projects/:id/task-statuses', async (c) => {
    const body = taskStatusInputSchema.parse(await c.req.json());
    return c.json(await svc.createTaskStatus(currentActor(c), c.req.param('id'), body), 201);
  });

  app.patch('/task-statuses/:statusId', async (c) => {
    const body = taskStatusInputSchema.partial().parse(await c.req.json());
    return c.json(await svc.updateTaskStatus(currentActor(c), c.req.param('statusId'), body));
  });

  app.delete('/task-statuses/:statusId', async (c) =>
    c.json(await svc.deleteTaskStatus(currentActor(c), c.req.param('statusId'), c.req.query('migrateTo'))));

  // ── Task types (workspace-level + project overrides, PRD §8.3) ──
  app.get('/task-types', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.query('projectId');
    const { db } = getDb();
    const workspace = await db.select().from(schema.taskTypes).where(isNull(schema.taskTypes.projectId));
    if (projectId) {
      await assertProject(actor, projectId, 'viewer');
      const rows = await db.select().from(schema.taskTypes).where(eq(schema.taskTypes.projectId, projectId));
      return c.json({ data: [...workspace, ...rows] });
    }
    return c.json({ data: workspace });
  });

  app.post('/task-types', async (c) => {
    const actor = currentActor(c);
    const body = taskTypeInputSchema.parse(await c.req.json());
    if (body.projectId) await assertProject(actor, body.projectId, 'admin');
    else requireSettingsManage(c);
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.taskTypes).values({
      id, projectId: body.projectId ?? null, name: body.name, icon: body.icon, color: body.color, position: body.position,
    });
    return c.json({ id }, 201);
  });

  app.delete('/task-types/:id', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const [type] = await db.select().from(schema.taskTypes).where(eq(schema.taskTypes.id, c.req.param('id')));
    if (!type) throw err.notFound('Task type not found');
    if (type.projectId) await assertProject(actor, type.projectId, 'admin');
    else requireSettingsManage(c);
    await db.delete(schema.taskTypes).where(eq(schema.taskTypes.id, c.req.param('id')));
    return c.json({ ok: true });
  });

  // ── Project types (workspace config, PRD §8.1) ──
  // Readable by any authed user — the new-project dialog needs the list.
  app.get('/project-types', async (c) => {
    const { db } = getDb();
    const rows = await db.select().from(schema.projectTypes).orderBy(asc(schema.projectTypes.position), asc(schema.projectTypes.createdAt));
    return c.json({ data: rows });
  });

  app.post('/project-types', guard('settings.manage'), async (c) => {
    const body = projectTypeInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const id = ulid();
    if (body.isDefault) await db.update(schema.projectTypes).set({ isDefault: false });
    await db.insert(schema.projectTypes).values({
      id, name: body.name, icon: body.icon, color: body.color,
      requiresClient: body.requiresClient, revenueSource: body.revenueSource,
      isDefault: body.isDefault, position: body.position,
    });
    return c.json({ id }, 201);
  });

  app.patch('/project-types/order', guard('settings.manage'), async (c) => {
    const body = projectTypeOrderSchema.parse(await c.req.json());
    const { db } = getDb();
    for (const [i, id] of body.ids.entries()) {
      await db.update(schema.projectTypes).set({ position: i }).where(eq(schema.projectTypes.id, id));
    }
    return c.json({ ok: true });
  });

  app.patch('/project-types/:id', guard('settings.manage'), async (c) => {
    const body = projectTypeInputSchema.partial().parse(await c.req.json());
    const { db } = getDb();
    // A single default: setting one clears the others.
    if (body.isDefault) await db.update(schema.projectTypes).set({ isDefault: false });
    await db.update(schema.projectTypes).set(body).where(eq(schema.projectTypes.id, c.req.param('id')));
    return c.json({ ok: true });
  });

  app.delete('/project-types/:id', guard('settings.manage'), async (c) => {
    const { db } = getDb();
    const id = c.req.param('id');
    const [totalRow] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.projectTypes);
    if ((totalRow?.n ?? 0) <= 1) throw err.domain('Cannot delete the last project type — at least one must remain.');
    const [usedRow] = await db.select({ n: sql<number>`count(*)::int` })
      .from(schema.projects).where(eq(schema.projects.projectTypeId, id));
    const used = usedRow?.n ?? 0;
    if (used > 0) throw err.domain(`This type is used by ${used} project${used === 1 ? '' : 's'} — move them to another type first.`);
    await db.delete(schema.projectTypes).where(eq(schema.projectTypes.id, id));
    return c.json({ ok: true });
  });

  // ── Project templates (PRD §8.1) ──
  app.get('/project-templates', async (c) => {
    const { db } = getDb();
    return c.json({ data: await db.select().from(schema.projectTemplates) });
  });

  app.post('/project-templates', guard('settings.manage'), async (c) => {
    const body = projectTemplateInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.projectTemplates).values({ id, name: body.name, definition: body.definition, createdBy: currentActor(c).userId });
    return c.json({ id }, 201);
  });

  app.post('/projects/:id/save-as-template', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await svc.saveProjectAsTemplate(currentActor(c), c.req.param('id'), body?.name ?? ''), 201);
  });

  return app;
}
