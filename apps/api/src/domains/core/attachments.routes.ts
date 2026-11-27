import { Hono } from 'hono';
import { getDb, schema, eq, and, desc } from '@ordi/db';
import { ulid } from 'ulid';
import { MAX_FILENAME_LENGTH, MAX_UPLOAD_BYTES, attachmentPatchSchema, isBlockedFilename } from '@ordi/shared';
import { z } from 'zod';
import type { Actor, AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { rejectReadOnlyWrites } from '../../core/rbac';
import {
  READ_PERM, WRITE_PERM, PROJECT_SCOPED, requireEntityPerm, assertEntityAccess, canReadAttachment,
} from '../../core/file-access';
import { writeActivity } from '../../core/activity';
import { putObject } from '../../lib/s3';
import { fileSrc } from '../../lib/file-tokens';
import { vetFilePaths } from '../../core/file-links';
import { err } from '../../lib/errors';
import { appendFileResource } from '../projects/resources.routes';

/**
 * Who may rename or delete a file that already exists.
 *
 * - A file embedded in a document answers to no record: only its uploader.
 * - A file on a project, a task or an intake item: its uploader as a project
 *   member, anyone else only as a project admin – the rule a comment follows
 *   (projects/service deleteComment). Membership alone let any member rename or
 *   delete the files a colleague, or the public intake form, had put there.
 * - A file on a CRM record or an employee: whoever may change that record
 *   (WRITE_PERM). Those records have no per-record owner or admin to defer to;
 *   the write permission is the whole of their edit rule.
 */
async function assertCanChange(
  actor: Actor,
  att: { entityType: string | null; entityId: string | null; createdBy: string | null },
): Promise<void> {
  const own = att.createdBy === actor.userId;
  if (!att.entityType) {
    if (!own) throw err.forbidden('Only the uploader can change this file');
    return;
  }
  requireEntityPerm(actor.access.permissions, WRITE_PERM, att.entityType);
  if (!PROJECT_SCOPED.has(att.entityType)) return;
  // A project-scoped file that names no record has no project to defer to.
  if (!att.entityId) {
    if (!own) throw err.forbidden('Only the uploader can change this file');
    return;
  }
  await assertEntityAccess(actor, att.entityType, att.entityId, own ? 'member' : 'admin');
}

export function attachmentsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);
  // Access here is decided per record, not by guard(), so a read-only token
  // has to be refused explicitly or it writes wherever its owner can.
  app.use('*', rejectReadOnlyWrites());

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
    if (file.name.length > MAX_FILENAME_LENGTH) throw err.validation(`Filename is longer than ${MAX_FILENAME_LENGTH} characters`);
    if (file.size < 1 || file.size > MAX_UPLOAD_BYTES) throw err.validation('File exceeds the size cap');
    if (isBlockedFilename(file.name)) throw err.domain('File type not allowed');
    // The name is shown back in every list: a file path in it is vetted like
    // one in a document (multipart bodies are not, core/file-links).
    const filename = await vetFilePaths(file.name, actor);
    const entityType = typeof form['entityType'] === 'string' && form['entityType'] ? form['entityType'] : null;
    const entityId = typeof form['entityId'] === 'string' && form['entityId'] ? form['entityId'] : null;
    // A type with no id would hang the file off nothing: only the permission
    // would ever guard it, never the record.
    if (entityType && !entityId) throw err.validation('entityId required with entityType');
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
      fileKey: key, filename, size: file.size, mime,
      createdBy: actor.userId,
    });
    if (entityType) {
      await writeActivity(db, {
        entityType: 'attachment', entityId: id, action: 'created',
        diff: { file: { to: filename }, on: { to: `${entityType}:${entityId}` } },
        actorId: actor.userId, actorType: actor.actorType,
      });
      // A project's files are listed among its resources.
      if (entityType === 'project' && entityId) await appendFileResource(db, entityId, id, filename, actor);
    }
    // `src` is what an editor stores in the document: a signed path that an
    // <img> can fetch with no session at all. It expires within the hour;
    // the document's readers get it signed afresh with every read of the
    // document (lib/file-tokens, core/file-links).
    return c.json({ id, src: fileSrc(id) }, 201);
  });

  /**
   * Rename. Only the display/download name changes: the bytes and their
   * storage key stay put, so every embedded src keeps working. The blocked
   * extensions apply here too, or a rename would undo the upload check.
   */
  app.patch('/:id', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const [att] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, c.req.param('id')));
    if (!att) throw err.notFound();
    await assertCanChange(actor, att);
    const { filename } = attachmentPatchSchema.parse(await c.req.json());
    if (isBlockedFilename(filename)) throw err.domain('File type not allowed');
    if (filename !== att.filename) {
      await db.update(schema.attachments).set({ filename }).where(eq(schema.attachments.id, att.id));
      await writeActivity(db, {
        entityType: 'attachment', entityId: att.id, action: 'updated',
        diff: { file: { from: att.filename, to: filename } },
        actorId: actor.userId, actorType: actor.actorType,
      });
    }
    const [updated] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, att.id));
    return c.json(updated);
  });

  app.delete('/:id', async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const [att] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, c.req.param('id')));
    if (!att) throw err.notFound();
    await assertCanChange(actor, att);
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
    // A file hanging off a record answers to that record. A loose one opens
    // here for its uploader and for readers of a record that names it; a
    // document's readers get its embedded files signed with the document
    // itself (core/file-links). Knowing the id used to be enough.
    if (att.entityType) {
      requireEntityPerm(actor.access.permissions, READ_PERM, att.entityType);
      await assertEntityAccess(actor, att.entityType, att.entityId, 'viewer');
    } else if (!(await canReadAttachment(actor, att))) {
      throw err.notFound();
    }
    // Both are the signed API path: the file streams back through /files,
    // so storage stays private. The link expires within the hour.
    return c.json({
      url: fileSrc(att.id), src: fileSrc(att.id),
      filename: att.filename, mime: att.mime,
    });
  });

  /**
   * Fresh links for paths a client already holds – an image that failed to
   * load because the page around it has been open longer than its link
   * lives. The answer is the request itself: every path that comes in is
   * checked (core/file-links: the caller was handed it within the last day,
   * or may open the file on their own) and every path that goes out is
   * signed afresh, so echoing them is the whole of the work.
   */
  app.post('/refresh', async (c) => {
    const { srcs } = z.object({ srcs: z.array(z.string().max(2048)).max(50) }).parse(await c.req.json());
    return c.json({ srcs });
  });

  return app;
}
