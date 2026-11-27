import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor, resolveActor } from '../../core/auth';
import { broadcaster, type SSEMessage } from '../../core/events';
import { accessibleProjectIds, accessibleSpaceIds } from '../../core/access';

/**
 * What a person's own agent hears: the work it does – tasks, their comments
 * and cycles, knowledge-base pages, runs – and only news that names the
 * project or space it is about. Anything else (an invoice paid, a project
 * created, a time entry logged) is not its business, whatever its owner sees.
 */
const PERSONAL_AGENT_NEWS = /^(?:task|comment|cycle|page)\.|^agent\.run_/;

/** How often the stream pings – and re-checks a personal agent's access. Tests shorten it. */
export const streamTiming = { pingMs: 15_000 };

/** SSE stream (PRD §3.4): server pushes events filtered by the actor's access. */
export function streamRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.get('/', async (c) => {
    let actor = currentActor(c);
    let projectIds = new Set(await accessibleProjectIds(actor));
    let spaceIds = new Set(await accessibleSpaceIds(actor));
    /** Projects/spaces we re-read for and still could not see – do not re-read again. */
    let denied = new Set<string>();
    let deniedSpaces = new Set<string>();
    /**
     * Bumped each time a personal agent's access is rebuilt. A re-read that
     * started before the rebuild must not install the old access over the new
     * one – nor decide an event by it.
     */
    let generation = 0;

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
      const gen = generation;
      const ids = new Set(await accessibleProjectIds(actor, { fresh: true }));
      if (gen !== generation) return canSee(scope);
      projectIds = ids;
      if (scope.some((p) => projectIds.has(p))) return true;
      for (const p of scope) denied.add(p);
      return false;
    };

    /** Same snapshot-then-re-read dance for KB spaces (page.* events). */
    const canSeeSpace = async (scope: string[]): Promise<boolean> => {
      if (scope.some((s) => spaceIds.has(s))) return true;
      if (scope.every((s) => deniedSpaces.has(s))) return false;
      const gen = generation;
      const ids = new Set(await accessibleSpaceIds(actor, { fresh: true }));
      if (gen !== generation) return canSeeSpace(scope);
      spaceIds = ids;
      if (scope.some((s) => spaceIds.has(s))) return true;
      for (const s of scope) deniedSpaces.add(s);
      return false;
    };

    /** The caller again, as a new request would see it, with its project and space sets. */
    const refreshed = async (userId: string) => {
      // Not a use of the token: an idle stream must not keep "last used" at now.
      const fresh = await resolveActor(c, { touch: false });
      if (!fresh || fresh.userId !== userId) return null;
      const [projectIds, spaceIds] = await Promise.all([
        accessibleProjectIds(fresh, { fresh: true }), accessibleSpaceIds(fresh, { fresh: true }),
      ]);
      return { actor: fresh, projectIds, spaceIds };
    };

    /** Everyone else hears what they did before; a personal agent, PERSONAL_AGENT_NEWS. */
    const personalAgentHears = (msg: SSEMessage): boolean => {
      if (actor.agentKind !== 'personal') return true;
      if (msg.userScope?.includes(actor.userId)) return true;
      return PERSONAL_AGENT_NEWS.test(msg.event) && !!(msg.projectScope?.length || msg.spaceScope?.length);
    };

    return streamSSE(c, async (stream) => {
      const unsub = broadcaster.subscribe((msg) => {
        if (msg.userScope?.length && !msg.userScope.includes(actor.userId)) return;
        if (!personalAgentHears(msg)) return;
        const gate = msg.projectScope?.length
          ? canSee(msg.projectScope)
          : msg.spaceScope?.length
            ? canSeeSpace(msg.spaceScope)
            : null;
        if (!gate) {
          stream.writeSSE({ event: msg.event, data: JSON.stringify(msg.data) }).catch(() => {});
          return;
        }
        void gate.then((allowed) => {
          if (allowed) stream.writeSSE({ event: msg.event, data: JSON.stringify(msg.data) }).catch(() => {});
        }).catch(() => {});
      });
      await stream.writeSSE({ event: 'connected', data: JSON.stringify({ ok: true }) });
      let closed = false;
      stream.onAbort(() => { closed = true; unsub(); });
      // However the loop ends – aborted, refused, or a failed read – the
      // subscription goes with it: the stream closing does not fire onAbort.
      try {
        while (!closed) {
          await stream.sleep(streamTiming.pingMs);
          if (closed) break;
          // A personal agent's reach is its owner's, now: a revoked token, an
          // owner switched off or taken off a project ends what this connection
          // hears, as it would end the next request. The snapshot above only
          // ever grows, so it is rebuilt rather than topped up. A read that
          // fails ends the stream too: the client reconnects through the
          // ordinary checks.
          if (actor.agentKind === 'personal') {
            const next = await refreshed(actor.userId).catch(() => null);
            if (!next) break;
            // All at once, so no event is judged by half of the old access.
            generation++;
            actor = next.actor;
            projectIds = new Set(next.projectIds);
            spaceIds = new Set(next.spaceIds);
          }
          // Access can be granted later too; forget the misses so a project or
          // space the user has since been added to gets one more chance.
          denied = new Set();
          deniedSpaces = new Set();
          await stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => { closed = true; });
        }
      } finally {
        unsub();
      }
    });
  });

  return app;
}
