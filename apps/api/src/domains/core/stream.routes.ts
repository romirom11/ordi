import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { broadcaster } from '../../core/events';
import { accessibleProjectIds } from '../../core/access';

/** SSE stream (PRD §3.4): server pushes events filtered by the actor's access. */
export function streamRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.get('/', async (c) => {
    const actor = currentActor(c);
    const projectIds = new Set(await accessibleProjectIds(actor));
    return streamSSE(c, async (stream) => {
      const unsub = broadcaster.subscribe((msg) => {
        if (msg.userScope?.length && !msg.userScope.includes(actor.userId)) return;
        if (msg.projectScope?.length && !msg.projectScope.some((p) => projectIds.has(p))) return;
        stream.writeSSE({ event: msg.event, data: JSON.stringify(msg.data) }).catch(() => {});
      });
      await stream.writeSSE({ event: 'connected', data: JSON.stringify({ ok: true }) });
      let closed = false;
      stream.onAbort(() => { closed = true; unsub(); });
      while (!closed) {
        await stream.sleep(15_000);
        if (closed) break;
        await stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => { closed = true; });
      }
      unsub();
    });
  });

  return app;
}
