/**
 * View state that survives navigation: sort, filters, chosen tabs. Every page
 * remounts on route change (routes.tsx keys the tree by path), so list state
 * held in useState dies the moment the user walks away. This hook is useState
 * with a localStorage spine – same idiom as taskViewPrefs / Shell's nav prefs:
 * lazy read on mount, write-through on set, and a caller-supplied reviver so
 * stale or corrupt JSON degrades to the default instead of crashing the page.
 *
 * Keys live under `ordi:view:<scope>` – one key per list, one object per key.
 */
import { useCallback, useState } from 'react';

export function loadPref<T>(key: string | undefined, fallback: T, revive?: (raw: unknown) => T): T {
  if (!key) return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw) as unknown;
    return revive ? revive(parsed) : (parsed as T);
  } catch {
    /* private mode / bad JSON */
    return fallback;
  }
}

export function savePref(key: string | undefined, value: unknown): void {
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

/** Reviver for a plain string pref (filter values, search text). */
export function stringPref(fallback = ''): (raw: unknown) => string {
  return (raw) => (typeof raw === 'string' ? raw : fallback);
}

/** Reviver constrained to a fixed set – a renamed tab or removed option falls back. */
export function oneOfPref<T extends string>(allowed: readonly T[], fallback: T): (raw: unknown) => T {
  return (raw) => (allowed.includes(raw as T) ? (raw as T) : fallback);
}

export function usePersistedState<T>(
  key: string | undefined,
  fallback: T,
  revive?: (raw: unknown) => T,
): [T, (v: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState(() => ({ key, value: loadPref(key, fallback, revive) }));
  // A key change (e.g. another project's list) must read that key's state, not
  // carry the previous one over – adjust during render, per React's derived-state escape hatch.
  if (state.key !== key) setState({ key, value: loadPref(key, fallback, revive) });
  const set = useCallback((v: T | ((prev: T) => T)) => {
    setState((prev) => {
      const value = typeof v === 'function' ? (v as (prev: T) => T)(prev.value) : v;
      savePref(key, value);
      return { key, value };
    });
  }, [key]);
  return [state.value, set];
}
