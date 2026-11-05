/**
 * Project resources (Overview → Resources): links, files and knowledge-base
 * pages in one ordered list (schema/resources.ts).
 *
 * - Links are created and edited here.
 * - Files arrive through the ordinary upload (POST /attachments with
 *   entityType "project"), which appends their row via appendFileResource;
 *   they rename through PATCH /attachments/:id. Removing a file resource
 *   deletes the file, as the Files section's delete did.
 * - Pages are pinned here by id. A page the reader cannot open (private
 *   space, draft, someone else's private page) is left out of their list
 *   altogether, title included – the same rule search applies.
 *
 * Reads need project viewer, writes project member.
 */
import { Hono } from 'hono';
import { getDb, schema, eq, and, asc, inArray, isNull, sql } from '@ordi/db';
import { ulid } from 'ulid';
import {
  projectResourceInputSchema, projectResourcePatchSchema, projectResourceOrderSchema,
  type ProjectResourceKind,
} from '@ordi/shared';
import type { Actor, AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { assertProject, accessibleSpaceIds, editableSpaceIds } from '../../core/access';
import { writeActivity } from '../../core/activity';
import { err } from '../../lib/errors';

const { projectResources, attachments, kbPages } = schema;

type ResourceRow = typeof projectResources.$inferSelect;
type PageRow = Pick<typeof kbPages.$inferSelect, 'id' | 'title' | 'icon' | 'spaceId' | 'published' | 'visibility' | 'createdBy'>;

export interface ProjectResourceView {
  id: string;
  kind: ProjectResourceKind;
  /** What the row is called: a link's label, a file's name, a page's title. */
  label: string;
  url: string | null;
  position: number;
  createdBy: string | null;
  createdAt: string;
  file?: { id: string; filename: string; size: number; mime: string };
  page?: { id: string; title: string; icon: string | null; spaceId: string; url: string };
}

type Db = ReturnType<typeof getDb>['db'];

async function nextPosition(db: Db, projectId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number | null>`max(${projectResources.position})` })
    .from(projectResources)
    .where(eq(projectResources.projectId, projectId));
  return (row?.max ?? -1) + 1;
}

/**
 * The pages among `ids` the actor may open: live, in a space they can see,
 * and – unless they edit that space – published and either public or theirs
 * (kb/service canSeePage, applied in bulk the way search does).
 */
async function visiblePages(actor: Actor, ids: string[]): Promise<Map<string, PageRow>> {
  const out = new Map<string, PageRow>();
  if (!ids.length) return out;
  const viewer = new Set(await accessibleSpaceIds(actor));
  if (!viewer.size) return out;
  const editor = new Set(await editableSpaceIds(actor));
  const { db } = getDb();
  const rows = await db
    .select({
      id: kbPages.id, title: kbPages.title, icon: kbPages.icon, spaceId: kbPages.spaceId,
      published: kbPages.published, visibility: kbPages.visibility, createdBy: kbPages.createdBy,
    })
    .from(kbPages)
    .where(and(inArray(kbPages.id, ids), isNull(kbPages.deletedAt)));
  for (const pg of rows) {
    if (!viewer.has(pg.spaceId)) continue;
    const ok = editor.has(pg.spaceId) || (pg.published && (pg.visibility === 'public' || pg.createdBy === actor.userId));
    if (ok) out.set(pg.id, pg);
  }
  return out;
}

export async function listResources(actor: Actor, projectId: string): Promise<ProjectResourceView[]> {
  const { db } = getDb();
  const rows = await db
    .select()
    .from(projectResources)
    .where(eq(projectResources.projectId, projectId))
    .orderBy(asc(projectResources.position), asc(projectResources.createdAt));

  const fileIds = rows.map((r) => r.attachmentId).filter((id): id is string => !!id);
  const files = fileIds.length
    ? await db
      .select({ id: attachments.id, filename: attachments.filename, size: attachments.size, mime: attachments.mime })
      .from(attachments)
      .where(inArray(attachments.id, fileIds))
    : [];
  const fileById = new Map(files.map((f) => [f.id, f]));
  const pages = await visiblePages(actor, rows.map((r) => r.kbPageId).filter((id): id is string => !!id));

  const out: ProjectResourceView[] = [];
  for (const r of rows) {
    const base = {
      id: r.id, kind: r.kind as ProjectResourceKind, position: r.position,
      createdBy: r.createdBy, createdAt: r.createdAt.toISOString(),
    };
    if (r.kind === 'link') {
      out.push({ ...base, label: r.label ?? r.url ?? '', url: r.url });
    } else if (r.kind === 'file') {
      const f = r.attachmentId ? fileById.get(r.attachmentId) : undefined;
      if (f) out.push({ ...base, label: f.filename, url: null, file: f });
    } else if (r.kind === 'kb_page') {
      const pg = r.kbPageId ? pages.get(r.kbPageId) : undefined;
      if (pg) {
        out.push({
          ...base, label: pg.title, url: null,
          page: { id: pg.id, title: pg.title, icon: pg.icon, spaceId: pg.spaceId, url: `/kb/${pg.spaceId}/${pg.id}` },
        });
      }
    }
  }
  return out;
}

/**
 * Called by the upload route for a file that lands on a project: the file
 * joins the project's resources at the end of the list.
 */
export async function appendFileResource(
  db: Db, projectId: string, attachmentId: string, filename: string, actor: Pick<Actor, 'userId' | 'actorType'>,
): Promise<void> {
  await db.insert(projectResources).values({
    id: ulid(), projectId, kind: 'file', attachmentId,
    position: await nextPosition(db, projectId), createdBy: actor.userId,
  });
  await writeActivity(db, {
    entityType: 'project', entityId: projectId, action: 'resource_added',
    after: { kind: 'file', name: filename }, actorId: actor.userId, actorType: actor.actorType,
  });
}

async function loadResource(id: string): Promise<ResourceRow> {
  const { db } = getDb();
  const [row] = await db.select().from(projectResources).where(eq(projectResources.id, id));
  if (!row) throw err.notFound('Resource not found');
  return row;
}

async function viewOf(actor: Actor, row: ResourceRow): Promise<ProjectResourceView> {
  const view = (await listResources(actor, row.projectId)).find((r) => r.id === row.id);
  if (!view) throw err.notFound('Resource not found');
  return view;
}

export function projectResourcesRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.get('/projects/:id/resources', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.param('id');
    await assertProject(actor, projectId, 'viewer');
    return c.json({ data: await listResources(actor, projectId) });
  });

  app.post('/projects/:id/resources', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.param('id');
    await assertProject(actor, projectId, 'member');
    const body = projectResourceInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const id = ulid();
    // What the project's activity records. Everyone on the project reads that
    // trail, so a page goes in by id only: its title may come from a space
    // some of them cannot open.
    let logged: Record<string, unknown>;

    if (body.kind === 'link') {
      logged = { kind: 'link', name: body.label };
      await db.insert(projectResources).values({
        id, projectId, kind: 'link', label: body.label, url: body.url,
        position: await nextPosition(db, projectId), createdBy: actor.userId,
      });
    } else {
      const page = (await visiblePages(actor, [body.kbPageId])).get(body.kbPageId);
      if (!page) throw err.notFound('Page not found');
      const [dupe] = await db.select({ id: projectResources.id }).from(projectResources)
        .where(and(eq(projectResources.projectId, projectId), eq(projectResources.kbPageId, page.id)));
      if (dupe) throw err.domain('This page is already one of the project’s resources');
      logged = { kind: 'kb_page', kbPageId: page.id };
      await db.insert(projectResources).values({
        id, projectId, kind: 'kb_page', kbPageId: page.id,
        position: await nextPosition(db, projectId), createdBy: actor.userId,
      });
    }

    await writeActivity(db, {
      entityType: 'project', entityId: projectId, action: 'resource_added',
      after: logged, actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json(await viewOf(actor, await loadResource(id)), 201);
  });

  // static route before /project-resources/:id
  app.put('/projects/:id/resources/order', async (c) => {
    const actor = currentActor(c);
    const projectId = c.req.param('id');
    await assertProject(actor, projectId, 'member');
    const { ids } = projectResourceOrderSchema.parse(await c.req.json());
    const { db } = getDb();
    const rows = await db
      .select({ id: projectResources.id })
      .from(projectResources)
      .where(eq(projectResources.projectId, projectId))
      .orderBy(asc(projectResources.position), asc(projectResources.createdAt));
    const known = new Set(rows.map((r) => r.id));
    // The ids sent first, in their order; anything the sender could not see
    // (a page hidden from them) keeps its relative place after those.
    const sent = [...new Set(ids.filter((id) => known.has(id)))];
    const sentSet = new Set(sent);
    const order = [...sent, ...rows.map((r) => r.id).filter((id) => !sentSet.has(id))];
    await db.transaction(async (tx) => {
      for (const [position, id] of order.entries()) {
        await tx.update(projectResources).set({ position }).where(eq(projectResources.id, id));
      }
    });
    return c.json({ data: await listResources(actor, projectId) });
  });

  app.patch('/project-resources/:id', async (c) => {
    const actor = currentActor(c);
    const row = await loadResource(c.req.param('id'));
    await assertProject(actor, row.projectId, 'member');
    const body = projectResourcePatchSchema.parse(await c.req.json());
    if (row.kind !== 'link') {
      throw err.validation(row.kind === 'file'
        ? 'A file is renamed through PATCH /attachments/:id'
        : 'A page takes its title from the knowledge base');
    }
    const patch: Partial<ResourceRow> = {};
    if (body.label !== undefined) patch.label = body.label;
    if (body.url !== undefined) patch.url = body.url;
    const { db } = getDb();
    if (Object.keys(patch).length) {
      await db.update(projectResources).set(patch).where(eq(projectResources.id, row.id));
    }
    return c.json(await viewOf(actor, await loadResource(row.id)));
  });

  app.delete('/project-resources/:id', async (c) => {
    const actor = currentActor(c);
    const row = await loadResource(c.req.param('id'));
    await assertProject(actor, row.projectId, 'member');
    const { db } = getDb();
    // Same rule as on adding: a page is logged by id, never by title.
    let logged: Record<string, unknown> = row.kind === 'kb_page'
      ? { kind: 'kb_page', kbPageId: row.kbPageId }
      : { kind: row.kind, name: row.label ?? row.url ?? '' };

    if (row.kind === 'file' && row.attachmentId) {
      const [att] = await db.select().from(attachments).where(eq(attachments.id, row.attachmentId));
      // The row goes with its attachment (ON DELETE CASCADE). The S3 object
      // stays behind, as with every other delete.
      if (att) {
        logged = { kind: 'file', name: att.filename };
        await db.delete(attachments).where(eq(attachments.id, att.id));
        await writeActivity(db, {
          entityType: 'attachment', entityId: att.id, action: 'deleted',
          diff: { file: { from: att.filename } }, actorId: actor.userId, actorType: actor.actorType,
        });
      }
    }
    // Unpinning a page leaves the page itself alone.
    await db.delete(projectResources).where(eq(projectResources.id, row.id));

    await writeActivity(db, {
      entityType: 'project', entityId: row.projectId, action: 'resource_removed',
      after: logged, actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ ok: true });
  });

  return app;
}
