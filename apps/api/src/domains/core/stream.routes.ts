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
    let projectIds = new Set(await accessibleProjectIds(actor));
    /** Projects we re-read for and still could not see – do not re-read again. */
    let denied = new Set<string>();

    /**
     * The set is a snapshot, and this connection outlives it: the app reuses one
     * stream across its in-app tabs, so a project created (or shared with the
     * user) afterwards would never stream anything.
     *
     * When an event names a project we have not seen before, re-read access and
     * judge that same event again, so the first event after the change is
     * delivered rather than dropped. Each unknown project costs at most one
     * extra read, because misses are remembered.
     */
    const canSee = async (scope: string[]): Promise<boolean> => {
      if (scope.some((p) => projectIds.has(p))) return true;
      if (scope.every((p) => denied.has(p))) return false;
      projectIds = new Set(await accessibleProjectIds(actor, { fresh: true }));
      if (scope.some((p) => projectIds.has(p))) return true;
      for (const p of scope) denied.add(p);
      return false;
    };

    return streamSSE(c, async (stream) => {
      const unsub = broadcaster.subscribe((msg) => {
        if (msg.userScope?.length && !msg.userScope.includes(actor.userId)) return;
        if (!msg.projectScope?.length) {
          stream.writeSSE({ event: msg.event, data: JSON.stringify(msg.data) }).catch(() => {});
          return;
        }
        void canSee(msg.projectScope).then((allowed) => {
          if (allowed) stream.writeSSE({ event: msg.event, data: JSON.stringify(msg.data) }).catch(() => {});
        }).catch(() => {});
      });
      await stream.writeSSE({ event: 'connected', data: JSON.stringify({ ok: true }) });
      let closed = false;
      stream.onAbort(() => { closed = true; unsub(); });
      while (!closed) {
        await stream.sleep(15_000);
        if (closed) break;
        // Access can be granted later too; forget the misses so a project the
        // user has since been added to gets one more chance.
        denied = new Set();
        await stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => { closed = true; });
      }
      unsub();
    });
  });

  return app;
}
