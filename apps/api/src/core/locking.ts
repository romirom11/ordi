/** Optimistic locking via monotonic `version` (PRD §3.4). */
import { err } from '../lib/errors';

/** Throw 409 with the current entity if the client's known version is stale. */
export function assertVersion(current: { version: number }, expected: number | undefined, entity?: unknown): void {
  if (expected === undefined) return; // version optional; skip check when omitted
  if (current.version !== expected) {
    throw err.conflict('The record was modified by someone else', entity ?? current);
  }
}
