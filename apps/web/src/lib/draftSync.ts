/**
 * Local drafts of server-backed text (a task's title and description, a
 * knowledge page's title and body) and the rules for writing them back.
 *
 * The page used to keep one copy of the text and trust that a PATCH sent was a
 * PATCH stored. A refused write (409) then either left the text on screen with
 * nothing behind it, or swapped it for the server's version – typed work gone
 * either way. Here three copies are kept apart:
 *
 *  - `server`   the latest snapshot the server reported, with its version;
 *  - `baseline` per field, the server value the draft was written against;
 *  - `draft`    what the person sees and edits.
 *
 * A field is dirty while draft ≠ baseline, and in conflict when the server has
 * moved on from the baseline to something else. A conflict is never resolved
 * automatically – both sides edited the same field and only the person can say
 * which one wins. A server change to a field nobody here touched (a colleague
 * moved the status) is not a conflict: clean fields simply follow the server.
 *
 * Everything below is pure; useDraftSync wires it to React, the API and
 * storage.
 */

export type DraftFields = Record<string, unknown>;

export interface DraftSyncState<F extends DraftFields> {
  baseline: F;
  draft: F;
  server: F;
  version: number | undefined;
  /** The fields on their way to the server and the values sent. */
  sending: Partial<F> | null;
  /** A write was refused for a stale version: nothing goes out until a fresher snapshot arrives. */
  stale: boolean;
  /** The last write failed for another reason; a retry resends the current draft. */
  failed: boolean;
  /** Restored from an earlier visit: shown, but sent only once the person edits or saves. */
  held: boolean;
}

export type SyncStatus = 'saved' | 'unsaved' | 'restored' | 'saving' | 'failed' | 'conflict';

/** Order-independent comparison: jsonb hands object keys back in its own order. */
export function stableKey(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = (v as Record<string, unknown>)[k];
    return out;
  }) ?? 'undefined';
}

export function sameValue(a: unknown, b: unknown): boolean {
  return a === b || stableKey(a) === stableKey(b);
}

function keysOf<F extends DraftFields>(s: DraftSyncState<F>): (keyof F)[] {
  return Object.keys({ ...s.server, ...s.draft }) as (keyof F)[];
}

export function dirtyKeys<F extends DraftFields>(s: DraftSyncState<F>): (keyof F)[] {
  return keysOf(s).filter((k) => !sameValue(s.draft[k], s.baseline[k]));
}

/** Dirty fields the server has meanwhile changed to something else. */
export function conflictKeys<F extends DraftFields>(s: DraftSyncState<F>): (keyof F)[] {
  return dirtyKeys(s).filter((k) => !sameValue(s.server[k], s.baseline[k]) && !sameValue(s.server[k], s.draft[k]));
}

export function isDirty<F extends DraftFields>(s: DraftSyncState<F>): boolean {
  return s.sending !== null || dirtyKeys(s).length > 0;
}

export function syncStatus<F extends DraftFields>(s: DraftSyncState<F>): SyncStatus {
  if (conflictKeys(s).length) return 'conflict';
  if (s.sending || s.stale) return 'saving';
  const dirty = dirtyKeys(s).length > 0;
  if (dirty && s.failed) return 'failed';
  if (dirty) return s.held ? 'restored' : 'unsaved';
  return 'saved';
}

export function initDraft<F extends DraftFields>(server: F, version: number | undefined, stored?: StoredDraft<F> | null): DraftSyncState<F> {
  const fresh: DraftSyncState<F> = {
    baseline: server, draft: server, server, version,
    sending: null, stale: false, failed: false, held: false,
  };
  if (!stored) return fresh;
  const restored: DraftSyncState<F> = {
    ...fresh,
    baseline: { ...server, ...stored.baseline },
    draft: { ...server, ...stored.draft },
    server: { ...server, ...stored.baseline },
    version: stored.version,
    held: true,
  };
  return receiveServer(restored, server, version);
}

export function edit<F extends DraftFields>(s: DraftSyncState<F>, patch: Partial<F>): DraftSyncState<F> {
  return { ...s, draft: { ...s.draft, ...patch }, held: false, failed: false };
}

/**
 * Start a write of every dirty field. Null when nothing may go out: a write is
 * already in flight (the next one needs the version it returns), the version
 * is known to be stale, a conflict waits for the person, or – unless forced by
 * an explicit Save/Retry – the draft was only restored or the last write failed.
 */
export function begin<F extends DraftFields>(
  s: DraftSyncState<F>,
  opts: { force?: boolean; allowEmpty?: boolean } = {},
): { state: DraftSyncState<F>; payload: Partial<F>; version: number | undefined } | null {
  if (s.sending || s.stale || conflictKeys(s).length) return null;
  if (!opts.force && (s.held || s.failed)) return null;
  const keys = dirtyKeys(s);
  if (!keys.length && !opts.allowEmpty) return null;
  const payload = {} as Partial<F>;
  for (const k of keys) payload[k] = s.draft[k];
  return { state: { ...s, sending: payload, failed: false, held: false }, payload, version: s.version };
}

/**
 * The server stored what was sent. Edits made while the write was in flight
 * stay dirty against the new baseline, so they go out next instead of being
 * mistaken for saved.
 */
export function ack<F extends DraftFields>(s: DraftSyncState<F>, server?: F, version?: number): DraftSyncState<F> {
  const sent = s.sending ?? {};
  const acked: DraftSyncState<F> = {
    ...s,
    baseline: { ...s.baseline, ...sent },
    server: { ...s.server, ...sent },
    sending: null,
    stale: false,
    failed: false,
  };
  // A realtime refetch can overtake this write's response. Acknowledge the
  // sent fields against the newer snapshot instead of rolling its version back.
  if (version !== undefined && s.version !== undefined && version < s.version) {
    return receiveServer(acked, s.server, s.version);
  }
  return server ? receiveServer(acked, server, version) : acked;
}

/** The write did not land. A conflict waits for a fresher snapshot; anything else for a retry. */
export function fail<F extends DraftFields>(s: DraftSyncState<F>, conflict: boolean): DraftSyncState<F> {
  return { ...s, sending: null, stale: conflict, failed: !conflict };
}

/**
 * A new server snapshot (refetch, realtime, the response to someone's write).
 * Clean fields take it; a dirty field the server now agrees with is settled;
 * a dirty field it changed to something else becomes a conflict – the draft
 * itself is never touched.
 */
export function receiveServer<F extends DraftFields>(s: DraftSyncState<F>, server: F, version: number | undefined): DraftSyncState<F> {
  if (version !== undefined && s.version !== undefined && version < s.version) return s;
  const baseline = { ...s.baseline };
  const draft = { ...s.draft };
  for (const k of Object.keys(server) as (keyof F)[]) {
    if (s.sending && k in s.sending) continue; // settled by the write's own answer
    if (sameValue(draft[k], baseline[k]) || sameValue(draft[k], server[k])) {
      baseline[k] = server[k];
      draft[k] = server[k];
    }
  }
  const next: DraftSyncState<F> = {
    ...s, server, version, baseline, draft,
    stale: s.stale && version === s.version,
  };
  return dirtyKeys(next).length ? next : { ...next, held: false, failed: false };
}

/** Keep my text for the conflicting fields: it is now written against the latest version. */
export function keepMine<F extends DraftFields>(s: DraftSyncState<F>): DraftSyncState<F> {
  const baseline = { ...s.baseline };
  for (const k of conflictKeys(s)) baseline[k] = s.server[k];
  return { ...s, baseline, held: false, failed: false };
}

/** Take the server's text for the conflicting fields; other unsaved fields stay. */
export function takeTheirs<F extends DraftFields>(s: DraftSyncState<F>): DraftSyncState<F> {
  const baseline = { ...s.baseline };
  const draft = { ...s.draft };
  for (const k of conflictKeys(s)) { baseline[k] = s.server[k]; draft[k] = s.server[k]; }
  return { ...s, baseline, draft };
}

/** Drop every unsaved change and show the server's version. */
export function discardAll<F extends DraftFields>(s: DraftSyncState<F>): DraftSyncState<F> {
  return { ...s, baseline: s.server, draft: s.server, held: false, failed: false, stale: false };
}

/* ── Storage ── */

export interface StoredDraft<F extends DraftFields> {
  v: 1;
  draft: Partial<F>;
  baseline: Partial<F>;
  version: number | undefined;
}

/** Narrow store interface for the device mirror and test doubles. */
export interface DraftStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** One key per person and entity, so two pages (or two accounts) never trade drafts. */
export function draftStorageKey(userId: string, kind: string, id: string): string {
  return `ordi:draft:${userId}:${kind}:${id}`;
}

/**
 * Mirror the draft into the store: the dirty fields while there are any, and
 * nothing once they are saved or discarded. Returns whether the unsaved text
 * is safely stored (trivially true when there is none).
 */
export function writeStoredDraft<F extends DraftFields>(store: DraftStore | null, key: string, s: DraftSyncState<F>): boolean {
  const keys = dirtyKeys(s);
  // In flight counts as unsaved until the server answers.
  for (const k of Object.keys(s.sending ?? {}) as (keyof F)[]) if (!keys.includes(k)) keys.push(k);
  try {
    if (!store) return keys.length === 0;
    if (!keys.length) { store.removeItem(key); return true; }
    const draft: Partial<F> = {};
    const baseline: Partial<F> = {};
    for (const k of keys) {
      draft[k] = s.draft[k];
      // A field in flight was written against what it replaced; until the
      // answer comes the safe base to restore against is the old baseline.
      baseline[k] = s.baseline[k];
    }
    const stored: StoredDraft<F> = { v: 1, draft, baseline, version: s.version };
    store.setItem(key, JSON.stringify(stored));
    return true;
  } catch {
    return false; // quota or private mode – the caller must not claim the text is safe
  }
}

export function readStoredDraft<F extends DraftFields>(store: DraftStore | null, key: string): StoredDraft<F> | null {
  try {
    const raw = store?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft<F>;
    if (parsed?.v !== 1 || !parsed.draft || typeof parsed.draft !== 'object' || !parsed.baseline) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearStoredDraft(store: DraftStore | null, key: string): void {
  try { store?.removeItem(key); } catch { /* nothing to protect */ }
}
