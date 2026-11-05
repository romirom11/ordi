/**
 * Project secrets API (plan 2026-11-05-001, U1). Access is decided per secret
 * in service.ts (secretAccess); the routes only parse and answer.
 *
 *   GET    /projects/:id/secrets            the secrets the actor may list
 *   POST   /projects/:id/secrets            add one
 *   GET    /project-secrets/:id             metadata, never values
 *   PATCH  /project-secrets/:id             edit fields, audience, environment, agent use
 *   DELETE /project-secrets/:id
 *   POST   /project-secrets/:id/reveal      one field's value; POST so nothing caches or prefetches it
 *   GET    /project-secrets/:id/activity    the secret's own trail
 *   GET    /projects/:id/secret-audience            people and departments an audience can name
 *   POST   /projects/:id/secret-audience/preview    who an audience really lets reveal values
 *
 * External stores (U5):
 *   GET    /projects/:id/secret-providers                 connections the project may add from
 *   GET    /projects/:id/secret-providers/:cid/names      the names in one, for the picker
 *   GET    /secret-providers                              the workspace's connections (integrations.manage)
 *   POST   /secret-providers                              connect: the token is verified, then stored encrypted
 *   PATCH  /secret-providers/:id                          rename, or a new token
 *   POST   /secret-providers/:id/check                    ask the provider again
 *   DELETE /secret-providers/:id                          its secrets stay, disconnected
 *   PUT    /secret-providers/:id/projects                 the projects linked to it
 */
import { Hono } from 'hono';
import {
  secretInputSchema, secretPatchSchema, secretRevealSchema, secretAudiencePreviewSchema,
  secretProviderConnectionInputSchema, secretProviderConnectionPatchSchema, secretProviderLinksSchema,
} from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard, rejectReadOnlyWrites } from '../../core/rbac';
import {
  actorContext, audienceOptions, audiencePreview, createSecret, deleteSecret, getSecret, listSecrets,
  projectProviders, providerNames, revealSecretField, secretActivity, updateSecret,
} from './service';
import {
  checkConnection, createConnection, deleteConnection, listConnections, setConnectionProjects, updateConnection,
} from './connections';

export function projectSecretsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);
  // Access is per secret (secretAccess), not through guard(), so read-only tokens are refused here.
  app.use('*', rejectReadOnlyWrites());

  app.get('/projects/:id/secrets', async (c) => {
    const ctx = await actorContext(currentActor(c));
    return c.json({ data: [...(await listSecrets(ctx, c.req.param('id'))).values()] });
  });

  app.post('/projects/:id/secrets', async (c) => {
    const ctx = await actorContext(currentActor(c));
    const body = secretInputSchema.parse(await c.req.json());
    return c.json(await createSecret(ctx, c.req.param('id'), body), 201);
  });

  app.get('/projects/:id/secret-audience', async (c) => {
    const ctx = await actorContext(currentActor(c));
    return c.json(await audienceOptions(ctx, c.req.param('id')));
  });

  // POST although it changes nothing: the audience travels as a body.
  app.post('/projects/:id/secret-audience/preview', async (c) => {
    const ctx = await actorContext(currentActor(c));
    const { audience } = secretAudiencePreviewSchema.parse(await c.req.json());
    return c.json(await audiencePreview(ctx, c.req.param('id'), audience));
  });

  app.get('/project-secrets/:id', async (c) => {
    const ctx = await actorContext(currentActor(c));
    return c.json(await getSecret(ctx, c.req.param('id')));
  });

  app.patch('/project-secrets/:id', async (c) => {
    const ctx = await actorContext(currentActor(c));
    const body = secretPatchSchema.parse(await c.req.json());
    return c.json(await updateSecret(ctx, c.req.param('id'), body));
  });

  app.delete('/project-secrets/:id', async (c) => {
    const ctx = await actorContext(currentActor(c));
    await deleteSecret(ctx, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/project-secrets/:id/reveal', async (c) => {
    const ctx = await actorContext(currentActor(c));
    const { field, purpose } = secretRevealSchema.parse(await c.req.json());
    const out = await revealSecretField(ctx, c.req.param('id'), field, purpose);
    c.header('Cache-Control', 'no-store');
    return c.json(out);
  });

  app.get('/project-secrets/:id/activity', async (c) => {
    const ctx = await actorContext(currentActor(c));
    return c.json({ data: await secretActivity(ctx, c.req.param('id')) });
  });

  // ── External stores ──

  app.get('/projects/:id/secret-providers', async (c) => {
    const ctx = await actorContext(currentActor(c));
    return c.json({ data: await projectProviders(ctx, c.req.param('id')) });
  });

  app.get('/projects/:id/secret-providers/:cid/names', async (c) => {
    const ctx = await actorContext(currentActor(c));
    return c.json(await providerNames(ctx, c.req.param('id'), c.req.param('cid')));
  });

  app.get('/secret-providers', guard('integrations.manage'), async (c) => {
    return c.json({ data: await listConnections(currentActor(c)) });
  });

  app.post('/secret-providers', guard('integrations.manage'), async (c) => {
    const body = secretProviderConnectionInputSchema.parse(await c.req.json());
    return c.json(await createConnection(currentActor(c), body), 201);
  });

  app.patch('/secret-providers/:id', guard('integrations.manage'), async (c) => {
    const body = secretProviderConnectionPatchSchema.parse(await c.req.json());
    return c.json(await updateConnection(currentActor(c), c.req.param('id'), body));
  });

  app.post('/secret-providers/:id/check', guard('integrations.manage'), async (c) => {
    return c.json(await checkConnection(currentActor(c), c.req.param('id')));
  });

  app.delete('/secret-providers/:id', guard('integrations.manage'), async (c) => {
    await deleteConnection(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  app.put('/secret-providers/:id/projects', guard('integrations.manage'), async (c) => {
    const { projectIds } = secretProviderLinksSchema.parse(await c.req.json());
    return c.json(await setConnectionProjects(currentActor(c), c.req.param('id'), projectIds));
  });

  return app;
}
