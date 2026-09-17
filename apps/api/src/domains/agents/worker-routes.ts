/**
 * The run backend over HTTP, for a worker process that has no database.
 *
 * Not a user API: the caller is infrastructure, so the credential is one
 * shared secret (AGENT_WORKER_SECRET) rather than a user's token, and every
 * route maps onto the same function the in-process worker calls directly.
 * With no secret configured the whole router answers 503: a worker outside
 * the API process is then simply not a thing this install does.
 *
 * What travels here is what a run needs and nothing else - which does
 * include the decrypted model credential and the repository token for the
 * one run being prepared. The worker has to hold those to do its job; the
 * point of the split is that it holds nothing beyond them.
 */
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../context';
import { env } from '../../env';
import * as service from './run-service';
import type { RunReport } from './run-backend';

function secretMatches(given: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(env.agentWorkerSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const workerInfo = z.object({
  workerId: z.string().min(1), concurrency: z.number().int().min(1), running: z.number().int().min(0),
  runtimeAvailable: z.boolean(), version: z.string(),
});
const claimInput = z.object({ workerId: z.string().min(1), limit: z.number().int().min(1).max(50) });
const startInput = z.object({
  branch: z.string().nullable(), reused: z.boolean(), repoFullName: z.string().nullable(), pullRequestTemplate: z.string().nullable(),
});
const progressInput = z.object({ sessionId: z.string().nullable().optional(), branch: z.string().nullable().optional() });
const eventInput = z.object({ type: z.string().min(1), payload: z.record(z.unknown()) });
const parkInput = z.object({ retryAt: z.string().datetime(), reason: z.string(), sessionId: z.string().nullable(), branch: z.string().nullable() });
const failInput = z.object({ error: z.string() });
/** The report is the runtime's own shape; the fields the platform reads are checked, the rest passes. */
const reportInput = z.object({
  outcome: z.object({
    status: z.enum(['succeeded', 'failed', 'rate_limited', 'needs_input']),
    sessionId: z.string().nullable(), message: z.string(), error: z.string().nullable(), retryAt: z.number().nullable(),
    report: z.record(z.unknown()).nullable(), usage: z.record(z.unknown()),
  }).passthrough(),
  usedCredentialId: z.string().nullable(),
  aborted: z.enum(['timeout', 'cancelled']).nullable(),
  publish: z.object({ pushed: z.boolean(), prUrl: z.string().nullable(), commits: z.number().nullable(), error: z.string().nullable() }).nullable(),
  branch: z.string().nullable(),
});

export function agentWorkerRoutes() {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    if (!env.agentWorkerSecret) return c.json({ error: 'agent_worker_disabled', error_description: 'AGENT_WORKER_SECRET is not set' }, 503);
    const auth = c.req.header('authorization') ?? '';
    if (!auth.startsWith('Bearer ') || !secretMatches(auth.slice(7).trim())) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });

  app.post('/heartbeat', async (c) => {
    await service.heartbeat(workerInfo.parse(await c.req.json()));
    return c.json({ ok: true });
  });

  app.post('/claim', async (c) => {
    const { workerId, limit } = claimInput.parse(await c.req.json());
    return c.json({ data: await service.claim(workerId, limit) });
  });

  app.post('/runs/:id/prepare', async (c) => c.json(await service.prepare(c.req.param('id'))));

  app.post('/runs/:id/start', async (c) => {
    const started = await service.start(c.req.param('id'), startInput.parse(await c.req.json()));
    return c.json({ started });
  });

  app.post('/runs/:id/progress', async (c) => {
    await service.localRunBackend.progress(c.req.param('id'), progressInput.parse(await c.req.json()));
    return c.json({ ok: true });
  });

  app.post('/runs/:id/touch', async (c) => {
    await service.localRunBackend.touch(c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/runs/:id/events', async (c) => {
    const { type, payload } = eventInput.parse(await c.req.json());
    await service.localRunBackend.event(c.req.param('id'), type as Parameters<typeof service.localRunBackend.event>[1], payload);
    return c.json({ ok: true });
  });

  app.get('/runs/:id/control', async (c) => c.json({ cancel: await service.localRunBackend.cancelRequested(c.req.param('id')) }));

  app.get('/runs/:id/repository', async (c) => c.json({ repo: await service.repository(c.req.param('id')) }));

  app.post('/runs/:id/park', async (c) => {
    await service.park(c.req.param('id'), parkInput.parse(await c.req.json()));
    return c.json({ ok: true });
  });

  app.post('/runs/:id/finish', async (c) => {
    await service.finish(c.req.param('id'), reportInput.parse(await c.req.json()) as unknown as RunReport);
    return c.json({ ok: true });
  });

  app.post('/runs/:id/fail', async (c) => {
    await service.fail(c.req.param('id'), failInput.parse(await c.req.json()).error);
    return c.json({ ok: true });
  });

  return app;
}
