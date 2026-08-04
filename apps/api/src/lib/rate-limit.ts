/**
 * In-process rate limiting for credential endpoints (PRD §6): login, password
 * reset requests, password changes. One counter per key per window.
 *
 * Per process, not per deployment – a multi-instance install limits per
 * instance. That is enough for its purpose here: slowing credential guessing,
 * not enforcing a quota.
 */
import { err } from './errors';

const buckets = new Map<string, { count: number; resetAt: number }>();

/** Throws `rate_limited` once `key` exceeds `max` hits inside `windowMs`. */
export function checkRate(key: string, max: number, windowMs: number): void {
  const now = Date.now();
  const rec = buckets.get(key);
  if (!rec || rec.resetAt < now) {
    // Some keys are attacker-chosen (the address on a forgot-password form),
    // so finished windows get swept instead of accumulating forever.
    if (buckets.size > 5_000) {
      for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  rec.count += 1;
  if (rec.count > max) throw err.rateLimited('Too many attempts');
}

/**
 * Clear a counter after a success, so someone who mistyped their own password
 * twice is not held back by their own mistakes for the rest of the window.
 */
export function clearRate(key: string): void {
  buckets.delete(key);
}
