import { Hono } from 'hono';
import { getDb, schema, eq, and, desc } from '@ordi/db';
import { ulid } from 'ulid';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES, BLOCKED_FILE_EXTENSIONS, type Permission } from '@ordi/shared';
import type { Actor, AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { assertProject } from '../../core/access';
import { writeActivity } from '../../core/activity';
import { presignUpload, presignDownload } from '../../lib/s3';
import { fileSrc, signUploadKey, verifyUploadKey } from '../../lib/file-tokens';
import { err } from '../../lib/errors';

const presignSchema = z.object({
  filename: z.string().min(1),
  size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  mime: z.string().min(1),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});

const registerSchema = z.object({
  fileKey: z.string().min(1),
  /** The signature /presign returned alongside fileKey. */
  keyToken: z.string().min(1),
  filename: z.string().min(1),
  size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  mime: z.string().min(1),
  /** Absent for a file embedded in rich text: it belongs to a document, not a record. */
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});

/** Which permission covers files hanging off each entity type. */
const READ_PERM: Record<string, Permission> = { company: 'crm.read', lead: 'crm.read', deal: 'deals.read', task: 'projects.read', project: 'projects.read' };
const WRITE_PERM: Record<string, Permission> = { company: 'crm.write', lead: 'crm.write', deal: 'deals.write', task: 'projects.read', project: 'projects.read' };

function requireEntityPerm(perms: ReadonlySet<string>, map: Record<string, Permission>, entityType: string): void {
  const needed = map[entityType];
  if (!needed) throw err.validation('Unknown entity type');
  if (!perms.has(needed)) throw err.forbidden(`Requires ${needed}`, needed);
}

/**
 * A workspace-wide `projects.read` is not access to a *private* project, and
 * files are exactly what a private project keeps private. Anything hanging off
 * a project or one of its tasks is therefore membership-gated too, the same way
 * the project's own reads are (core/access).
 */
async function assertEntityAccess(
  actor: Actor, entityType: string, entityId: string | null | undefined, minRole: 'viewer' | 'member',
): Promise<void> {
  if (!entityId) return;
  if (entityType === 'project') {
    await assertProject(actor, entityId, minRole);
    return;
  }
  if (entityType === 'task') {
    const { db } = getDb();
    const [task] = await db.select({ projectId: schema.tasks.projectId }).from(schema.tasks).where(eq(schema.tasks.id, entityId));
    if (!task) throw err.notFound('Task not found');
    await assertProject(actor, task.projectId, minRole);
  }
}

export function attachmentsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // Files of one entity (a company's or deal's Files section).
  app.get('/', async (c) => {
    const actor = currentActor(c);
    const entityType = c.req.query('entityType');
    const entityId = c.req.query('entityId');
    if (!entityType || !entityId) throw err.validation('entityType and entityId required');
    requireEntityPerm(actor.access.permissions, READ_PERM, entityType);
    await assertEntityAccess(actor, entityType, entityId, 'viewer');
    const { db } = getDb();
    const rows = await db.select().from(schema.attachments)
      .where(and(eq(schema.attachments.entityType, entityType), eq(schema.attachments.entityId, entityId)))
      .orderBy(desc(schema.attachments.createdAt));
    return c.json({ data: rows });
  });

  app.post('/presign', async (c) => {
    const body = presignSchema.parse(await c.req.json());
    const ext = body.filename.split('.').pop()?.toLowerCase() ?? '';
    if (BLOCKED_FILE_EXTENSIONS.includes(ext)) throw err.domain('File type not allowed');
    const key = `uploads/${ulid()}/${body.filename}`;
    const url = await presignUpload(key, body.mime);
    // keyToken is what register demands back, so a caller cannot register a key
    // this endpoint never issued (lib/file-tokens).
    return c.json({ uploadUrl: url, fileKey: key, keyToken: signUploadKey(key) });
  });

  app.post('/register', async (c) => {
    const actor = currentActor(c);
    const body = registerSchema.parse(await c.req.json());
    if (!verifyUploadKey(body.fileKey, body.keyToken)) throw err.validation('fileKey was not issued by /presign');
    if (body.entityType) {
      requireEntityPerm(actor.access.permissions, WRITE_PERM, body.entityType);
      await assertEntityAccess(actor, body.entityType, body.entityId, 'member');
    }
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.attachments).values({
      id, entityType: body.entityType ?? null, entityId: body.entityId ?? null,
      fileKey: body.fileKey, filename: body.filename, size: body.size, mime: body.mime,
      createdBy: actor.userId,
    });
    if (body.entityType) {
      await writeActivity(db, {
        entityType: 'attachment', entityId: id, action: 'created',
        diff: { file: { to: body.filename }, on: { to: `${body.entityType}:${body.entityId}` } },
        actorId: actor.userId, actorType: actor.actorType,
      });
    }
    // `src` is what an editor stores in the document: a signed, non-expiring
    // path that an <img> can fetch with no session at all (lib/file-tokens).
    return c.json({ id, src: fileSrc(id) }, 201);
  });

  app.delete('/:id', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const [att] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, c.req.param('id')));
    if (!att) throw err.notFound();
    if (att.entityType) {
      requireEntityPerm(actor.access.permissions, WRITE_PERM, att.entityType);
      await assertEntityAccess(actor, att.entityType, att.entityId, 'member');
    }
    // The S3 object stays behind (cheap, recoverable); only the reference goes.
    await db.delete(schema.attachments).where(eq(schema.attachments.id, att.id));
    await writeActivity(db, {
      entityType: 'attachment', entityId: att.id, action: 'deleted',
      diff: { file: { from: att.filename } },
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ ok: true });
  });

  app.get('/:id/url', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const [att] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, c.req.param('id')));
    if (!att) throw err.notFound();
    // A file with no entity is embedded in a document and is reached through
    // its own signed src; one hanging off a record answers to that record.
    if (att.entityType) {
      requireEntityPerm(actor.access.permissions, READ_PERM, att.entityType);
      await assertEntityAccess(actor, att.entityType, att.entityId, 'viewer');
    }
    return c.json({
      url: await presignDownload(att.fileKey), src: fileSrc(att.id),
      filename: att.filename, mime: att.mime,
    });
  });

  return app;
}
