/** HTTP helpers: cursor pagination (PRD §15.1) and small response utilities. */
import type { Context } from 'hono';

/** Opaque cursor = base64url of the last row's sort key(s). */
export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor(cursor?: string): Record<string, unknown> | null {
  if (!cursor) return null;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

export function page<T>(data: T[], limit: number, cursorFn: (row: T) => Record<string, unknown>) {
  let nextCursor: string | null = null;
  if (data.length > limit) {
    const extra = data.pop()!;
    nextCursor = encodeCursor(cursorFn(extra));
  }
  return { data, nextCursor };
}

/**
 * Read the `limit` + `cursor` pair for a list paged on its ULID primary key.
 *
 * Ids are ULIDs (see `pk()` in the db schema), so they sort lexicographically by
 * creation time: newest-first is `id desc`, and the cursor compares as exact
 * text. A `createdAt` cursor cannot work — Postgres `timestamptz` keeps
 * microseconds, drizzle hands back a millisecond-precision JS `Date`, and the
 * truncated value round-tripped through the cursor matches no row at all.
 *
 * The clamp lives here rather than in each service so the value `page()` is
 * handed is the same one the query used: when they disagreed, asking for more
 * than the maximum returned the capped rows with `nextCursor: null` and
 * pagination stopped without saying so.
 */
export function idPage(c: Context, fallback: number, maximum: number): {
  limit: number;
  cursor: { id?: string } | null;
} {
  const raw = Number(c.req.query('limit'));
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(Math.trunc(raw), maximum)) : fallback;
  const decoded = decodeCursor(c.req.query('cursor'));
  const id = typeof decoded?.id === 'string' ? decoded.id : undefined;
  return { limit, cursor: id ? { id } : null };
}

/** Companion to `idPage`: mint the next cursor from the extra row. */
export function pageById<T extends { id: string }>(rows: T[], limit: number) {
  return page(rows, limit, (row) => ({ id: row.id }));
}

export function noStore(c: Context): void {
  c.header('Cache-Control', 'no-store');
}
