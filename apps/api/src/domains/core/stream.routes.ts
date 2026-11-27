import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { canSeePage } from '@ordi/shared';
import type { AppEnv, Actor } from '../../context';
import { requireAuth, currentActor, resolveActor } from '../../core/auth';
import { broadcaster, type SSEMessage } from '../../core/events';
import { accessibleProjectIds, spaceAccessSets } from '../../core/access';
import { isWritePermission } from '../../core/rbac';

/**
 * What a person's own agent hears: the work it does – tasks, their comments
 * and cycles, knowledge-base pages, runs – and only news that names the
 * project or space it is about. Anything else (an invoice paid, a project
 * created, a time entry logged) is not its business, whatever its owner sees.
 */
const PERSONAL_AGENT_NEWS = /^(?:task|comment|cycle|page)\.|^agent\.run_/;

/** How often the stream pings – and re-checks the caller's access. Tests shorten it. */
export const streamTiming = { pingMs: 15_000 };

/** The project and space sets one connection judges events by. */
async function accessOf(actor: Actor) {
  const [projectIds, spaces] = await Promise.all([
    accessibleProjectIds(actor, { fresh: true }), spaceAccessSets(actor, { fresh: true }),
  ]);
  return { projectIds: new Set(projectIds), spaceIds: new Set(spaces.viewer), editorSpaceIds: new Set(spaces.editor) };
}

/** SSE stream (PRD §3.4): server pushes events filtered by the actor's access. */
export function streamRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.get('/', async (c) => {
    let actor = currentActor(c);
    let { projectIds, spaceIds, editorSpaceIds } = await accessOf(actor);
    /** Projects/spaces we re-read for and still could not see – do not re-read again. */
    let denied = new Set<string>();
    let deniedSpaces = new Set<string>();
    /**
     * Bumped each time the caller's access is rebuilt. A re-read that started
     * before the rebuild must not install the old access over the new one –
     * nor decide an event by it.
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
      const sets = await spaceAccessSets(actor, { fresh: true });
      if (gen !== generation) return canSeeSpace(scope);
      spaceIds = new Set(sets.viewer);
      editorSpaceIds = new Set(sets.editor);
      if (scope.some((s) => spaceIds.has(s))) return true;
      for (const s of scope) deniedSpaces.add(s);
      return false;
    };

    /** A page inside a visible space: drafts for its editors, a private page for its author too. */
    const canSeePageOf = (msg: SSEMessage): boolean =>
      !msg.page || canSeePage(msg.page, actor.userId, !!msg.spaceScope?.some((s) => editorSpaceIds.has(s)));

    /** The caller again, as a new request would see it, with its project and space sets. */
    const refreshed = async (userId: string) => {
      // Not a use of the token: an idle stream must not keep "last used" at now.
      const fresh = await resolveActor(c, { touch: false });
      if (!fresh || fresh.userId !== userId) return null;
      return { actor: fresh, ...(await accessOf(fresh)) };
    };

    /** Everyone else hears what they did before; a personal agent, PERSONAL_AGENT_NEWS. */
    const personalAgentHears = (msg: SSEMessage): boolean => {
      if (actor.agentKind !== 'personal') return true;
      if (msg.userScope?.includes(actor.userId)) return true;
      return PERSONAL_AGENT_NEWS.test(msg.event) && !!(msg.projectScope?.length || msg.spaceScope?.length);
    };

    /**
     * Workspace news outside projects goes to those who may read it – by the
     * caller's permissions now, which the refresh below keeps current – and to
     * the people it is about.
     */
    const holdsPermission = (msg: SSEMessage): boolean =>
      msg.permissionScope!.some((p) => actor.access.permissions.has(p) && !(actor.readOnly && isWritePermission(p)))
      || !!msg.involvedUsers?.includes(actor.userId);

    return streamSSE(c, async (stream) => {
      const send = (msg: SSEMessage) => {
        stream.writeSSE({ event: msg.event, data: JSON.stringify(msg.data) }).catch(() => {});
      };
      const unsub = broadcaster.subscribe((msg) => {
        if (msg.userScope?.length && !msg.userScope.includes(actor.userId)) return;
        if (!personalAgentHears(msg)) return;
        if (msg.permissionScope?.length && !holdsPermission(msg)) return;
        if (msg.projectScope?.length) {
          void canSee(msg.projectScope).then((ok) => { if (ok) send(msg); }).catch(() => {});
          return;
        }
        if (msg.spaceScope?.length) {
          void canSeeSpace(msg.spaceScope).then((ok) => { if (ok && canSeePageOf(msg)) send(msg); }).catch(() => {});
          return;
        }
        // Nothing scoped it: deliver only what was meant for everyone. A page
        // event with no space is never "everyone".
        if (msg.page) return;
        if (msg.userScope?.length || msg.permissionScope?.length || msg.workspaceWide) send(msg);
      });
      let closed = false;
      // A wait the abort can cut short, so a closed connection holds no timer.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wake: (() => void) | undefined;
      const nap = () => new Promise<void>((res) => { wake = res; timer = setTimeout(res, streamTiming.pingMs); });
      // Before the first write: an abort is not replayed to a listener added
      // later, and a write to a closed stream does not fail – a client gone by
      // then would leave this loop re-reading its access for as long as its
      // credentials last.
      stream.onAbort(() => { closed = true; unsub(); clearTimeout(timer); wake?.(); });
      await stream.writeSSE({ event: 'connected', data: JSON.stringify({ ok: true }) });
      // However the loop ends – aborted, refused, or a failed read – the
      // subscription goes with it: the stream closing does not fire onAbort.
      try {
        while (!closed && !stream.aborted) {
          await nap();
          if (closed || stream.aborted) break;
          // The caller's reach is re-read as the next request would see it: a
          // revoked token or session, an expired one, a user switched off (or a
          // personal agent's owner), someone taken off a project or a role
          // changed – each ends what this connection hears. The snapshot above
          // only ever grows, so it is rebuilt rather than topped up. A read
          // that fails ends the stream too: the client reconnects through the
          // ordinary checks.
          const next = await refreshed(actor.userId).catch(() => null);
          if (!next || closed) break;
          // All at once, so no event is judged by half of the old access.
          generation++;
          actor = next.actor;
          projectIds = next.projectIds;
          spaceIds = next.spaceIds;
          editorSpaceIds = next.editorSpaceIds;
          // Access can be granted later too; forget the misses so a project or
          // space the user has since been added to gets one more chance.
          denied = new Set();
          deniedSpaces = new Set();
          // Not awaited: a reader that stops reading must not hold up the next
          // refresh, or events would go on being judged by the access it had.
          stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => { closed = true; });
        }
      } finally {
        clearTimeout(timer);
        unsub();
      }
    });
  });

  return app;
}
