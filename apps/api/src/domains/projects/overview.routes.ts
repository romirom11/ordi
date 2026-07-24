/**
 * Project overview endpoints (Linear-style project page): milestones CRUD,
 * project status updates (health reports) and the progress/burnup series.
 * Reads are membership-gated (viewer); writes need member; update edits need
 * the author or a project admin.
 */
import { Hono } from 'hono';
import { getDb, schema, eq, and, asc, desc, sql } from '@ordi/db';
import { ulid } from 'ulid';
import { milestoneInputSchema, milestonePatchSchema, projectUpdatePostSchema, projectUpdatePatchSchema } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { assertProject } from '../../core/access';
import { writeActivity } from '../../core/activity';
import { err } from '../../lib/errors';

const { milestones, projectUpdates, projects, tasks, taskStatuses, activityLog, users } = schema;

/** Status categories that count as "started" on the burnup chart. */
const STARTED_CATEGORIES = new Set(['in_progress', 'done']);
const MAX_SERIES_POINTS = 180;

async function loadMilestone(id: string) {
  const { db } = getDb();
  const [row] = await db.select().from(milestones).where(eq(milestones.id, id));
  if (!row) throw err.notFound('Milestone not found');
  return row;
}

async function loadUpdate(id: string) {
  const { db } = getDb();
  const [row] = await db.select().from(projectUpdates).where(eq(projectUpdates.id, id));
  if (!row) throw err.notFound('Project update not found');
  return row;
}

/** Author edits own updates; anyone else needs project admin. */
async function assertUpdateEditable(actor: { userId: string } & Record<string, any>, update: { projectId: string; createdBy: string | null }) {
  await assertProject(actor as any, update.projectId, update.createdBy === actor.userId ? 'member' : 'admin');
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Burnup series: scope from tasks.createdAt, started/completed from replayed
 * status transitions in the activity log (diff.statusId {from,to}).
 */
export async function projectProgress(actorAny: any, projectId: string) {
  await assertProject(actorAny, projectId, 'viewer');
  const { db } = getDb();

  const [project] = await db.select({ startDate: projects.startDate })
    .from(projects).where(eq(projects.id, projectId));
  if (!project) throw err.notFound('Project not found');

  const [taskRows, statusRows, transitionRows] = await Promise.all([
    db.select({ id: tasks.id, createdAt: tasks.createdAt, statusId: tasks.statusId })
      .from(tasks).where(and(eq(tasks.projectId, projectId), sql`${tasks.deletedAt} is null`)),
    db.select({ id: taskStatuses.id, category: taskStatuses.category })
      .from(taskStatuses).where(eq(taskStatuses.projectId, projectId)),
    db.execute(sql`
      select a.entity_id as task_id, a.created_at,
             a.diff->'statusId'->>'from' as from_id,
             a.diff->'statusId'->>'to' as to_id
      from activity_log a
      join tasks t on t.id = a.entity_id
      where t.project_id = ${projectId} and t.deleted_at is null
        and a.entity_type = 'task' and a.diff ? 'statusId'
      order by a.created_at asc`) as Promise<any[]>,
  ]);

  const catOf = new Map(statusRows.map((s) => [s.id, s.category]));
  const byTask = new Map<string, { at: Date; from: string | null; to: string | null }[]>();
  for (const r of transitionRows as any[]) {
    const list = byTask.get(r.task_id) ?? [];
    list.push({ at: new Date(r.created_at), from: r.from_id ?? null, to: r.to_id ?? null });
    byTask.set(r.task_id, list);
  }

  const createdTimes: number[] = [];
  const startedTimes: number[] = [];
  const completedTimes: number[] = [];
  for (const t of taskRows) {
    const created = new Date(t.createdAt as unknown as string | Date).getTime();
    createdTimes.push(created);
    const trs = byTask.get(t.id) ?? [];
    // The task's category when it was created: rewind through the first logged
    // transition, else it is still in its current status.
    const initialCat = trs.length ? catOf.get(trs[0]!.from ?? '') : catOf.get(t.statusId);
    let startedAt: number | null = initialCat && STARTED_CATEGORIES.has(initialCat) ? created : null;
    let completedAt: number | null = initialCat === 'done' ? created : null;
    for (const tr of trs) {
      const toCat = catOf.get(tr.to ?? '');
      if (!toCat) continue;
      const at = tr.at.getTime();
      if (startedAt == null && STARTED_CATEGORIES.has(toCat)) startedAt = at;
      if (completedAt == null && toCat === 'done') completedAt = at;
    }
    if (startedAt != null) startedTimes.push(startedAt);
    if (completedAt != null) completedTimes.push(completedAt);
  }
  createdTimes.sort((a, b) => a - b);
  startedTimes.sort((a, b) => a - b);
  completedTimes.sort((a, b) => a - b);

  // Day range: project start (or first task) .. today, capped at 180 points.
  const today = new Date();
  const start = project.startDate
    ? new Date(`${project.startDate.slice(0, 10)}T00:00:00Z`)
    : (createdTimes.length ? new Date(createdTimes[0]!) : today);
  const DAY = 86_400_000;
  let days = Math.max(0, Math.floor((today.getTime() - start.getTime()) / DAY)) + 1;
  if (!Number.isFinite(days) || days < 1) days = 1;
  const stride = Math.max(1, Math.ceil(days / MAX_SERIES_POINTS));

  const series: { date: string; scope: number; started: number; completed: number }[] = [];
  const countUpTo = (sorted: number[], limit: number) => {
    // binary search: first index > limit
    let lo = 0; let hi = sorted.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid]! <= limit) lo = mid + 1; else hi = mid; }
    return lo;
  };
  // Walk backwards from today so the last point is always today, then reverse.
  for (let offset = 0; offset < days; offset += stride) {
    const d = new Date(today.getTime() - offset * DAY);
    const endOfDay = new Date(`${dayKey(d)}T23:59:59.999Z`).getTime();
    series.push({
      date: dayKey(d),
      scope: countUpTo(createdTimes, endOfDay),
      started: countUpTo(startedTimes, endOfDay),
      completed: countUpTo(completedTimes, endOfDay),
    });
  }
  series.reverse();

  return {
    scope: createdTimes.length,
    started: startedTimes.length,
    completed: completedTimes.length,
    series,
  };
}

export function projectOverviewRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // ── Milestones ──
  app.get('/projects/:id/milestones', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.param('id');
    await assertProject(actor, projectId, 'viewer');
    const { db } = getDb();
    const rows = await db.select().from(milestones)
      .where(eq(milestones.projectId, projectId))
      .orderBy(asc(milestones.position), asc(milestones.createdAt));
    return c.json({ data: rows });
  });

  app.post('/projects/:id/milestones', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.param('id');
    await assertProject(actor, projectId, 'member');
    const body = milestoneInputSchema.parse(await c.req.json());
    const { db } = getDb();
    let position = body.position;
    if (position === undefined) {
      const [row] = await db.select({ maxPos: sql<number | null>`max(${milestones.position})` })
        .from(milestones).where(eq(milestones.projectId, projectId));
      position = (row?.maxPos ?? 0) + 1000;
    }
    const id = ulid();
    await db.insert(milestones).values({
      id, projectId, name: body.name, targetDate: body.targetDate ?? null, done: body.done, position,
    });
    await writeActivity(db, { entityType: 'project', entityId: projectId, action: 'milestone_added', after: { name: body.name }, actorId: actor.userId, actorType: actor.actorType });
    const [created] = await db.select().from(milestones).where(eq(milestones.id, id));
    return c.json(created, 201);
  });

  app.patch('/milestones/:id', async (c) => {
    const actor = currentActor(c);
    const ms = await loadMilestone(c.req.param('id'));
    await assertProject(actor, ms.projectId, 'member');
    const body = milestonePatchSchema.parse(await c.req.json());
    const patch: Record<string, unknown> = {};
    for (const k of ['name', 'targetDate', 'done', 'position'] as const) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    const { db } = getDb();
    if (Object.keys(patch).length) await db.update(milestones).set(patch).where(eq(milestones.id, ms.id));
    if (body.done === true && !ms.done) {
      await writeActivity(db, { entityType: 'project', entityId: ms.projectId, action: 'milestone_completed', after: { name: ms.name }, actorId: actor.userId, actorType: actor.actorType });
    }
    const [updated] = await db.select().from(milestones).where(eq(milestones.id, ms.id));
    return c.json(updated);
  });

  app.delete('/milestones/:id', async (c) => {
    const actor = currentActor(c);
    const ms = await loadMilestone(c.req.param('id'));
    await assertProject(actor, ms.projectId, 'member');
    const { db } = getDb();
    await db.delete(milestones).where(eq(milestones.id, ms.id));
    return c.json({ ok: true });
  });

  // ── Project updates (health reports) ──
  app.get('/projects/:id/updates', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.param('id');
    await assertProject(actor, projectId, 'viewer');
    const { db } = getDb();
    const rows = await db.select({
      id: projectUpdates.id,
      projectId: projectUpdates.projectId,
      body: projectUpdates.body,
      health: projectUpdates.health,
      createdBy: projectUpdates.createdBy,
      createdAt: projectUpdates.createdAt,
      updatedAt: projectUpdates.updatedAt,
      authorName: users.name,
      authorAvatar: users.avatar,
    }).from(projectUpdates)
      .leftJoin(users, eq(users.id, projectUpdates.createdBy))
      .where(eq(projectUpdates.projectId, projectId))
      .orderBy(desc(projectUpdates.createdAt));
    return c.json({ data: rows });
  });

  app.post('/projects/:id/updates', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.param('id');
    await assertProject(actor, projectId, 'member');
    const body = projectUpdatePostSchema.parse(await c.req.json());
    const { db } = getDb();
    const id = ulid();
    await db.insert(projectUpdates).values({
      id, projectId, body: body.body ?? {}, health: body.health, createdBy: actor.userId,
    });
    await writeActivity(db, { entityType: 'project', entityId: projectId, action: 'update_posted', after: { health: body.health }, actorId: actor.userId, actorType: actor.actorType });
    const [created] = await db.select().from(projectUpdates).where(eq(projectUpdates.id, id));
    return c.json(created, 201);
  });

  app.patch('/project-updates/:id', async (c) => {
    const actor = currentActor(c);
    const update = await loadUpdate(c.req.param('id'));
    await assertUpdateEditable(actor, update);
    const body = projectUpdatePatchSchema.parse(await c.req.json());
    const patch: Record<string, unknown> = {};
    if (body.body !== undefined) patch.body = body.body;
    if (body.health !== undefined) patch.health = body.health;
    const { db } = getDb();
    if (Object.keys(patch).length) await db.update(projectUpdates).set(patch).where(eq(projectUpdates.id, update.id));
    const [updated] = await db.select().from(projectUpdates).where(eq(projectUpdates.id, update.id));
    return c.json(updated);
  });

  app.delete('/project-updates/:id', async (c) => {
    const actor = currentActor(c);
    const update = await loadUpdate(c.req.param('id'));
    await assertUpdateEditable(actor, update);
    const { db } = getDb();
    await db.delete(projectUpdates).where(eq(projectUpdates.id, update.id));
    return c.json({ ok: true });
  });

  // ── Progress (burnup) ──
  app.get('/projects/:id/progress', async (c) =>
    c.json(await projectProgress(currentActor(c), c.req.param('id'))));

  return app;
}
