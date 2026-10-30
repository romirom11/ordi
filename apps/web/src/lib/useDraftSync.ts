import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from './desktop';
import { createDraftStore } from './draftStorage';
import {
  ack, begin, clearStoredDraft, conflictKeys, discardAll, edit as editDraft, fail, initDraft, isDirty,
  keepMine as keepMineDraft, readStoredDraft, receiveServer, syncStatus, takeTheirs as takeTheirsDraft,
  writeStoredDraft, type DraftFields, type DraftSyncState, type SyncStatus,
} from './draftSync';

function localStore(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
function windowScope(): string {
  if (isTauri || typeof window === 'undefined') return 'desktop';
  // Window names survive reloads and keep two browser tabs' drafts separate.
  if (!window.name) window.name = `ordi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return window.name;
}
export const appDraftStore = createDraftStore(localStore, windowScope());

/**
 * `skipped`: nothing went out – nothing to send, a conflict waits for the
 * person, or a write is in flight (an explicit save then follows it).
 */
export type SaveOutcome = 'saved' | 'failed' | 'conflict' | 'skipped';

export interface DraftSync<F extends DraftFields> {
  /** Null until the first server snapshot has loaded. */
  draft: F | null;
  server: F | null;
  status: SyncStatus;
  dirty: boolean;
  conflicts: (keyof F)[];
  /** Unsaved text is stored in this browser tab and survives navigation and reload. */
  persisted: boolean;
  /** Message of the last failed write, for the failed state. */
  error: string | null;
  edit: (patch: Partial<F>) => void;
  /**
   * Write the dirty fields now. `auto` is the background save (debounce, blur)
   * and respects a restored or failed draft; without it this is the person's
   * explicit Save/Retry. `extra` rides along in the same request – publishing
   * sends the current text together with the flag, never the stale body.
   */
  save: (opts?: { auto?: boolean; extra?: Record<string, unknown> }) => Promise<SaveOutcome>;
  keepMine: () => void;
  takeTheirs: () => void;
  discard: () => void;
}

export function useDraftSync<F extends DraftFields, D>(opts: {
  storageKey: string;
  /** The query's data; a new identity is a new server snapshot. */
  snapshot: D | undefined;
  fields: (d: D) => F;
  version: (d: D) => number | undefined;
  send: (payload: Record<string, unknown>, version: number | undefined) => Promise<D>;
  isConflict: (e: unknown) => boolean;
  /** Ask for a fresher snapshot after a refused (409) write. */
  refresh: () => Promise<unknown>;
  /** Re-send by itself once a write lands with newer edits behind it, or after a 409 that was no real conflict. */
  autosave?: boolean;
  /** Ask before unloading the page while anything is unsaved, even if it is stored. */
  confirmUnload?: boolean;
  onSaved?: (resp: D, extra?: Record<string, unknown>) => void;
}): DraftSync<F> {
  const o = useRef(opts);
  o.current = opts;
  const sRef = useRef<DraftSyncState<F> | null>(null);
  const [persisted, setPersisted] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  /** An explicit save (and what rode along) still owed after a 409 that turned out harmless. */
  const owed = useRef<{ extra?: Record<string, unknown> } | null>(null);

  const apply = useCallback((next: DraftSyncState<F>) => {
    sRef.current = next;
    setPersisted(writeStoredDraft(appDraftStore, o.current.storageKey, next));
    setTick((n) => n + 1);
  }, []);

  const run = useCallback(async (mode: { auto: boolean; extra?: Record<string, unknown> }): Promise<SaveOutcome> => {
    const s = sRef.current;
    if (!s) return 'skipped';
    const started = begin(s, { force: !mode.auto, allowEmpty: !!mode.extra });
    if (!started) {
      // Busy: an explicit save is owed once the write in flight (or the
      // fresher snapshot after a 409) arrives.
      if (!mode.auto && (s.sending || s.stale)) owed.current = { extra: mode.extra };
      return 'skipped';
    }
    apply(started.state);
    try {
      const resp = await o.current.send({ ...started.payload, ...(mode.extra ?? {}) }, started.version);
      const cur = sRef.current ?? started.state;
      apply(ack(cur, o.current.fields(resp), o.current.version(resp)));
      setError(null);
      o.current.onSaved?.(resp, mode.extra);
      const rest = sRef.current;
      const again = owed.current;
      owed.current = null;
      if (again) void run({ auto: false, extra: again.extra });
      else if (rest && dirtyNow(rest) && o.current.autosave) void run({ auto: true });
      return 'saved';
    } catch (e) {
      const conflict = o.current.isConflict(e);
      apply(fail(sRef.current ?? started.state, conflict));
      if (conflict) {
        // Remember an explicit save so a 409 caused by a field nobody here
        // touched goes through once the newer version is known.
        if (!mode.auto) owed.current = { extra: mode.extra };
        try { await o.current.refresh(); }
        catch (refreshError) {
          // A failed conflict refetch must not leave a permanent "Saving…".
          // The draft remains intact; Retry can fetch the current version again.
          if (sRef.current) apply(fail(sRef.current, false));
          setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
        }
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
      return conflict ? 'conflict' : 'failed';
    }
  }, [apply]);

  // Server snapshots: the first one starts the draft (restoring a stored one),
  // later ones are merged without touching what the person typed.
  const { snapshot } = opts;
  useEffect(() => {
    if (snapshot === undefined) return;
    const fields = o.current.fields(snapshot);
    const version = o.current.version(snapshot);
    const cur = sRef.current;
    if (!cur) {
      apply(initDraft(fields, version, readStoredDraft<F>(appDraftStore, o.current.storageKey)));
      return;
    }
    const wasStale = cur.stale;
    const next = receiveServer(cur, fields, version);
    apply(next);
    if (wasStale && !next.stale && conflictKeys(next).length === 0) {
      const again = owed.current;
      owed.current = null;
      if (again) void run({ auto: false, extra: again.extra });
      else if (o.current.autosave) void run({ auto: true });
    } else if (conflictKeys(next).length) {
      owed.current = null; // the person decides now
    }
  }, [snapshot, apply, run]);

  const s = sRef.current;
  const dirty = !!s && isDirty(s);

  // Reload/close: the browser asks when the text is not stored, or always for
  // documents with an explicit Save. The desktop shell has no such prompt.
  useEffect(() => {
    if (!dirty || isTauri) return;
    if (persisted && !o.current.confirmUnload) return;
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [dirty, persisted]);

  const edit = useCallback((patch: Partial<F>) => {
    if (sRef.current) apply(editDraft(sRef.current, patch));
  }, [apply]);
  const save = useCallback((mode?: { auto?: boolean; extra?: Record<string, unknown> }) =>
    run({ auto: !!mode?.auto, extra: mode?.extra }), [run]);
  const keepMine = useCallback(() => {
    if (!sRef.current) return;
    apply(keepMineDraft(sRef.current));
    void run({ auto: false });
  }, [apply, run]);
  const takeTheirs = useCallback(() => {
    if (sRef.current) apply(takeTheirsDraft(sRef.current));
  }, [apply]);
  const discard = useCallback(() => {
    if (!sRef.current) return;
    owed.current = null;
    apply(discardAll(sRef.current));
    clearStoredDraft(appDraftStore, o.current.storageKey);
    setError(null);
  }, [apply]);

  return {
    draft: s?.draft ?? null,
    server: s?.server ?? null,
    status: s ? syncStatus(s) : 'saved',
    dirty,
    conflicts: s ? conflictKeys(s) : [],
    persisted,
    error,
    edit, save, keepMine, takeTheirs, discard,
  };
}

function dirtyNow<F extends DraftFields>(s: DraftSyncState<F>): boolean {
  return !s.sending && isDirty(s);
}
