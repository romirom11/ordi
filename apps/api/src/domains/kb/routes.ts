/**
 * Knowledge Base routes (PRD §9). Mounted at /api/v1 (spaces + pages). Access is
 * resource-gated via assertSpace inside the service; workspace space create/delete
 * additionally requires the kb.manage_spaces capability.
 */
import { Hono } from 'hono';
import {
  spaceInputSchema,
  spaceMemberInputSchema,
  pageInputSchema,
  pageUpdateSchema,
  pageCommentSchema,
  pageRestoreSchema,
} from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import * as svc from './service';

export function kbRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // ── Spaces ──
  app.get('/spaces', async (c) => c.json({ data: await svc.listSpaces(currentActor(c)) }));

  app.post('/spaces', async (c) => {
    const body = spaceInputSchema.parse(await c.req.json());
    const id = await svc.createSpace(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.get('/spaces/:id', async (c) => c.json(await svc.getSpace(currentActor(c), c.req.param('id'))));

  app.patch('/spaces/:id', async (c) => {
    const body = await c.req.json();
    return c.json(await svc.updateSpace(currentActor(c), c.req.param('id'), body));
  });

  app.delete('/spaces/:id', async (c) => {
    await svc.deleteSpace(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Space members ──
  app.get('/spaces/:id/members', async (c) =>
    c.json({ data: await svc.listMembers(currentActor(c), c.req.param('id')) }));

  app.post('/spaces/:id/members', async (c) => {
    const body = spaceMemberInputSchema.parse(await c.req.json());
    await svc.addMember(currentActor(c), c.req.param('id'), body);
    return c.json({ ok: true }, 201);
  });

  app.delete('/spaces/:id/members/:userId', async (c) => {
    await svc.removeMember(currentActor(c), c.req.param('id'), c.req.param('userId'));
    return c.json({ ok: true });
  });

  // ── Page tree ──
  app.get('/spaces/:id/pages', async (c) =>
    c.json({ data: await svc.listPages(currentActor(c), c.req.param('id')) }));

  // ── Templates (before /pages/:id to avoid collision) ──
  app.get('/pages/templates', async (c) =>
    c.json({ data: await svc.listTemplates(currentActor(c), c.req.query('spaceId') || undefined) }));

  // ── Pages ──
  app.post('/pages', async (c) => {
    const body = pageInputSchema.parse(await c.req.json());
    const id = await svc.createPage(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.get('/pages/:id', async (c) => {
    const includeBacklinks = (c.req.query('include') ?? '').split(',').includes('backlinks');
    return c.json(await svc.getPage(currentActor(c), c.req.param('id'), includeBacklinks));
  });

  app.patch('/pages/:id', async (c) => {
    const body = pageUpdateSchema.parse(await c.req.json());
    return c.json(await svc.updatePage(currentActor(c), c.req.param('id'), body));
  });

  app.delete('/pages/:id', async (c) => {
    await svc.deletePage(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Versions ──
  app.get('/pages/:id/versions', async (c) =>
    c.json({ data: await svc.listVersions(currentActor(c), c.req.param('id')) }));

  app.post('/pages/:id/restore', async (c) => {
    const body = pageRestoreSchema.parse(await c.req.json());
    return c.json(await svc.restoreVersion(currentActor(c), c.req.param('id'), body.versionNo));
  });

  // ── Soft-lock ──
  app.post('/pages/:id/lock', async (c) => c.json(await svc.lockPage(currentActor(c), c.req.param('id'))));
  app.post('/pages/:id/unlock', async (c) => c.json(await svc.unlockPage(currentActor(c), c.req.param('id'))));
  app.post('/pages/:id/lock/heartbeat', async (c) =>
    c.json(await svc.heartbeatLock(currentActor(c), c.req.param('id'))));

  // ── Export ──
  app.get('/pages/:id/export', async (c) => c.json(await svc.exportPage(currentActor(c), c.req.param('id'))));

  // ── Comments ──
  app.get('/pages/:id/comments', async (c) =>
    c.json({ data: await svc.listComments(currentActor(c), c.req.param('id')) }));

  app.post('/pages/:id/comments', async (c) => {
    const body = pageCommentSchema.parse(await c.req.json());
    const id = await svc.addComment(currentActor(c), c.req.param('id'), body);
    return c.json({ id }, 201);
  });

  app.delete('/page-comments/:id', async (c) => {
    await svc.deleteComment(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Duplicate from template ──
  app.post('/pages/:id/duplicate', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const id = await svc.duplicatePage(currentActor(c), c.req.param('id'), body);
    return c.json({ id }, 201);
  });

  // ── Convert page block → task (returns prefilled payload) ──
  app.post('/pages/:id/to-task', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await svc.pageToTask(currentActor(c), c.req.param('id'), body));
  });

  return app;
}
