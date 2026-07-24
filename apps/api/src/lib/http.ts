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

export function noStore(c: Context): void {
  c.header('Cache-Control', 'no-store');
}
