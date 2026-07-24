import { Hono } from 'hono';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { z } from 'zod';
import { MAX_UPLOAD_BYTES, BLOCKED_FILE_EXTENSIONS } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { presignUpload, presignDownload } from '../../lib/s3';
import { err } from '../../lib/errors';

const presignSchema = z.object({
  filename: z.string().min(1),
  size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  mime: z.string().min(1),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
});

export function attachmentsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.post('/presign', async (c) => {
    const body = presignSchema.parse(await c.req.json());
    const ext = body.filename.split('.').pop()?.toLowerCase() ?? '';
    if (BLOCKED_FILE_EXTENSIONS.includes(ext)) throw err.domain('File type not allowed');
    const key = `uploads/${ulid()}/${body.filename}`;
    const url = await presignUpload(key, body.mime);
    return c.json({ uploadUrl: url, fileKey: key });
  });

  app.post('/register', async (c) => {
    const actor = currentActor(c);
    const body = await c.req.json();
    const { db } = getDb();
    const id = ulid();
    await db.insert(schema.attachments).values({
      id, entityType: body.entityType ?? null, entityId: body.entityId ?? null,
      fileKey: body.fileKey, filename: body.filename, size: body.size, mime: body.mime,
      createdBy: actor.userId,
    });
    return c.json({ id }, 201);
  });

  app.get('/:id/url', async (c) => {
    const { db } = getDb();
    const [att] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, c.req.param('id')));
    if (!att) throw err.notFound();
    return c.json({ url: await presignDownload(att.fileKey), filename: att.filename, mime: att.mime });
  });

  return app;
}
