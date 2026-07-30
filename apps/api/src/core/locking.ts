/** Optimistic locking via monotonic `version` (PRD §3.4). */
import { err } from '../lib/errors';

/** Throw 409 with the current entity if the client's known version is stale. */
export function assertVersion(current: { version: number }, expected: number | undefined, entity?: unknown): void {
  if (expected === undefined) return; // version optional; skip check when omitted
  if (current.version !== expected) {
    throw err.conflict('The record was modified by someone else', entity ?? current);
  }
}

/**
 * Confirm a version-filtered UPDATE actually matched. `assertVersion` catches a
 * stale version the caller told us about; this catches the window between the
 * read and the write, where the filter quietly matches zero rows and the caller
 * would otherwise be told the edit was stored.
 */
export function assertUpdated<T>(updated: T | undefined, before: unknown): T {
  if (!updated) throw err.conflict('The record was modified by someone else', before);
  return updated;
}
