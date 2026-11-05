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
 */
import { Hono } from 'hono';
import { secretInputSchema, secretPatchSchema, secretRevealSchema } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import {
  actorContext, createSecret, deleteSecret, getSecret, listSecrets, revealSecretField, secretActivity, updateSecret,
} from './service';

export function projectSecretsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.get('/projects/:id/secrets', async (c) => {
    const ctx = await actorContext(currentActor(c));
    return c.json({ data: [...(await listSecrets(ctx, c.req.param('id'))).values()] });
  });

  app.post('/projects/:id/secrets', async (c) => {
    const ctx = await actorContext(currentActor(c));
    const body = secretInputSchema.parse(await c.req.json());
    return c.json(await createSecret(ctx, c.req.param('id'), body), 201);
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

  return app;
}
