import type { DraftStore } from './draftSync';

const TTL = 30 * 24 * 60 * 60 * 1000;
type Entry = { value: string; expiresAt: number };

/** A per-window mirror with an expiry; the desktop scope survives app relaunch. */
export function createDraftStore(storage: () => Storage | null, scope: string, now = Date.now): DraftStore {
  const memory = new Map<string, Entry>();
  const keyFor = (key: string) => `${key}:window:${scope}`;
  try {
    const store = storage();
    for (let i = (store?.length ?? 0) - 1; i >= 0; i--) {
      const key = store!.key(i);
      if (!key?.startsWith('ordi:draft:') || !key.includes(':window:')) continue;
      try {
        const entry = JSON.parse(store!.getItem(key) ?? 'null') as Entry | null;
        if (entry && entry.expiresAt <= now()) store!.removeItem(key);
      } catch { /* leave unknown formats alone */ }
    }
  } catch { /* the in-memory mirror still works without storage */ }
  return {
    getItem(key) {
      let entry = memory.get(key);
      try {
        if (!entry) entry = (JSON.parse(storage()?.getItem(keyFor(key)) ?? 'null') as Entry | null) ?? undefined;
      } catch { return null; }
      if (!entry || typeof entry.value !== 'string' || !(entry.expiresAt > now())) {
        memory.delete(key);
        try { storage()?.removeItem(keyFor(key)); } catch { /* storage unavailable */ }
        return null;
      }
      memory.set(key, entry);
      return entry.value;
    },
    setItem(key, value) {
      const entry = { value, expiresAt: now() + TTL };
      memory.set(key, entry);
      const store = storage();
      if (!store) throw new Error('draft storage unavailable');
      store.setItem(keyFor(key), JSON.stringify(entry));
    },
    removeItem(key) {
      memory.delete(key);
      storage()?.removeItem(keyFor(key));
    },
  };
}
