import { Hono } from 'hono';
import { getDb, schema, eq, and, desc } from '@ordi/db';
import { ulid } from 'ulid';
import { MAX_UPLOAD_BYTES, BLOCKED_FILE_EXTENSIONS, type Permission } from '@ordi/shared';
import type { Actor, AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { assertProject } from '../../core/access';
import { writeActivity } from '../../core/activity';
import { putObject } from '../../lib/s3';
import { fileSrc } from '../../lib/file-tokens';
import { err } from '../../lib/errors';

/** Which permission covers files hanging off each entity type. */
const READ_PERM: Record<string, Permission> = { company: 'crm.read', lead: 'crm.read', deal: 'deals.read', task: 'projects.read', project: 'projects.read', employee: 'people.read_documents' };
const WRITE_PERM: Record<string, Permission> = { company: 'crm.write', lead: 'crm.write', deal: 'deals.write', task: 'projects.read', project: 'projects.read', employee: 'people.write' };

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

  /**
   * The upload: one multipart POST carrying the file and (optionally) the
   * record it hangs off. The API puts the bytes in the bucket itself, so
   * storage never has to be reachable from a browser – the old
   * presign → PUT → register dance handed the browser a URL to an endpoint
   * that, on a self-hosted MinIO, only exists inside the docker network.
   * Registering used to mint a public link for any key the caller named;
   * with the key generated server-side that hole is gone with the dance.
   */
  app.post('/', async (c) => {
    const actor = currentActor(c);
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) throw err.validation('file field required (multipart/form-data)');
    if (!file.name) throw err.validation('filename required');
    if (file.size < 1 || file.size > MAX_UPLOAD_BYTES) throw err.validation('File exceeds the size cap');
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (BLOCKED_FILE_EXTENSIONS.includes(ext)) throw err.domain('File type not allowed');
    const entityType = typeof form['entityType'] === 'string' && form['entityType'] ? form['entityType'] : null;
    const entityId = typeof form['entityId'] === 'string' && form['entityId'] ? form['entityId'] : null;
    if (entityType) {
      requireEntityPerm(actor.access.permissions, WRITE_PERM, entityType);
      await assertEntityAccess(actor, entityType, entityId, 'member');
    }

    const mime = file.type || 'application/octet-stream';
    const key = `uploads/${ulid()}/${file.name}`;
    const stored = await putObject(key, new Uint8Array(await file.arrayBuffer()), mime);
    if (!stored) throw err.domain('Object storage is not configured');

    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.attachments).values({
      id, entityType, entityId,
      fileKey: key, filename: file.name, size: file.size, mime,
      createdBy: actor.userId,
    });
    if (entityType) {
      await writeActivity(db, {
        entityType: 'attachment', entityId: id, action: 'created',
        diff: { file: { to: file.name }, on: { to: `${entityType}:${entityId}` } },
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
    // Both are the signed API path now: the file streams back through /files,
    // so storage stays private.
    return c.json({
      url: fileSrc(att.id), src: fileSrc(att.id),
      filename: att.filename, mime: att.mime,
    });
  });

  return app;
}
