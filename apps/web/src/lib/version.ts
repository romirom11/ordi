/**
 * Version awareness between this UI bundle and the server it talks to.
 *
 * The web UI is served by the server, so the two only drift when a deploy
 * happens under an open tab – the fix is a reload. The desktop app ships its
 * own copy of the UI, so it can genuinely run against an older or newer
 * server for weeks; that skew is what these helpers make visible.
 */

declare const __APP_VERSION__: string;

/** The version this bundle was built from (vite define). */
export const APP_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

/** -1 when a < b, 0 when equal, 1 when a > b. Plain x.y.z only. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Guards against comparing garbage – an old server has no version field at all. */
export function isVersion(v: unknown): v is string {
  return typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);
}
