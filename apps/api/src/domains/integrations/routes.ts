import { Hono } from 'hono';
import { getDb, schema, eq, desc } from '@ordi/db';
import { ulid } from 'ulid';
import {
  gitConnectionInputSchema, gitRepositoryInputSchema, webhookSubscriptionInputSchema,
} from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { encrypt, generateToken } from '../../lib/crypto';

/**
 * Integrations domain (PRD §13): git connections/repositories, manual resync,
 * and outbound webhook subscriptions. Secrets and credentials are NEVER returned
 * in any response — credentials are stored AES-GCM encrypted, webhook secrets
 * write-only.
 */
export function integrationsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // ── Git connections ──
  app.get('/integrations/git/connections', guard('integrations.manage'), async (c) => {
    const { db } = getDb();
    const rows = await db.select({
      id: schema.gitConnections.id,
      provider: schema.gitConnections.provider,
      status: schema.gitConnections.status,
      instanceUrl: schema.gitConnections.instanceUrl,
      createdAt: schema.gitConnections.createdAt,
    }).from(schema.gitConnections).orderBy(desc(schema.gitConnections.createdAt));
    return c.json({ data: rows });
  });

  app.post('/integrations/git/connections', guard('integrations.manage'), async (c) => {
    const body = gitConnectionInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const actor = currentActor(c);
    const id = ulid();
    await db.insert(schema.gitConnections).values({
      id,
      provider: body.provider,
      instanceUrl: body.instanceUrl ?? null,
      // Credentials at rest: AES-GCM encrypted blob (PRD §13.1). Never returned.
      credentials: encrypt(JSON.stringify(body.credentials)),
      webhookSecret: generateToken(),
      status: 'connected',
      createdBy: actor.userId,
    });
    await writeActivity(db, {
      entityType: 'git_connection', entityId: id, action: 'created',
      after: { provider: body.provider, instanceUrl: body.instanceUrl ?? null },
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ id }, 201);
  });

  app.delete('/integrations/git/connections/:id', guard('integrations.manage'), async (c) => {
    const { db } = getDb();
    const id = c.req.param('id');
    const [existing] = await db.select({ id: schema.gitConnections.id })
      .from(schema.gitConnections).where(eq(schema.gitConnections.id, id));
    if (!existing) throw err.notFound();
    await db.delete(schema.gitConnections).where(eq(schema.gitConnections.id, id));
    const actor = currentActor(c);
    await writeActivity(db, {
      entityType: 'git_connection', entityId: id, action: 'deleted',
      actorId: actor.userId, actorType: actor.actorType,
    });
    return c.json({ ok: true });
  });

  // ── Repositories (manual registration; a real system pulls these from the provider) ──
  app.get('/integrations/git/repositories', guard('integrations.manage'), async (c) => {
    const { db } = getDb();
    const connectionId = c.req.query('connectionId');
    const rows = await db.select().from(schema.gitRepositories)
      .where(connectionId ? eq(schema.gitRepositories.connectionId, connectionId) : undefined)
      .orderBy(desc(schema.gitRepositories.createdAt));
    return c.json({ data: rows });
  });

  app.post('/integrations/git/repositories', guard('integrations.manage'), async (c) => {
    const body = gitRepositoryInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const [conn] = await db.select({ id: schema.gitConnections.id })
      .from(schema.gitConnections).where(eq(schema.gitConnections.id, body.connectionId));
    if (!conn) throw err.notFound('Connection not found');
    const id = ulid();
    await db.insert(schema.gitRepositories).values({
      id,
      connectionId: body.connectionId,
      externalId: body.externalId,
      fullName: body.fullName,
      defaultBranch: body.defaultBranch,
    });
    return c.json({ id }, 201);
  });

  // ── Manual resync (documented no-op; real link resync runs via provider API) ──
  app.post('/integrations/git/resync', guard('integrations.manage'), async (c) => {
    return c.json({ ok: true });
  });

  // ── Outbound webhooks (PRD §13.2) ── secret is write-only, never returned.
  app.get('/webhooks', guard('integrations.manage'), async (c) => {
    const { db } = getDb();
    const rows = await db.select({
      id: schema.webhookSubscriptions.id,
      url: schema.webhookSubscriptions.url,
      eventTypes: schema.webhookSubscriptions.eventTypes,
      active: schema.webhookSubscriptions.active,
      createdAt: schema.webhookSubscriptions.createdAt,
    }).from(schema.webhookSubscriptions).orderBy(desc(schema.webhookSubscriptions.createdAt));
    return c.json({ data: rows });
  });

  app.post('/webhooks', guard('integrations.manage'), async (c) => {
    const body = webhookSubscriptionInputSchema.parse(await c.req.json());
    const { db } = getDb();
    const actor = currentActor(c);
    const id = ulid();
    await db.insert(schema.webhookSubscriptions).values({
      id,
      url: body.url,
      secret: body.secret,
      eventTypes: body.eventTypes,
      active: body.active,
      createdBy: actor.userId,
    });
    return c.json({ id }, 201);
  });

  app.patch('/webhooks/:id', guard('integrations.manage'), async (c) => {
    const { db } = getDb();
    const id = c.req.param('id');
    const [existing] = await db.select({ id: schema.webhookSubscriptions.id })
      .from(schema.webhookSubscriptions).where(eq(schema.webhookSubscriptions.id, id));
    if (!existing) throw err.notFound();
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const patch: Record<string, unknown> = {};
    if (typeof body.active === 'boolean') patch.active = body.active;
    if (Array.isArray(body.eventTypes)) patch.eventTypes = body.eventTypes;
    if (typeof body.url === 'string') patch.url = body.url;
    if (Object.keys(patch).length > 0) {
      await db.update(schema.webhookSubscriptions).set(patch)
        .where(eq(schema.webhookSubscriptions.id, id));
    }
    return c.json({ ok: true });
  });

  app.delete('/webhooks/:id', guard('integrations.manage'), async (c) => {
    const { db } = getDb();
    await db.delete(schema.webhookSubscriptions).where(eq(schema.webhookSubscriptions.id, c.req.param('id')));
    return c.json({ ok: true });
  });

  app.get('/webhooks/:id/deliveries', guard('integrations.manage'), async (c) => {
    const { db } = getDb();
    const rows = await db.select().from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.subscriptionId, c.req.param('id')))
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(50);
    return c.json({ data: rows });
  });

  return app;
}
