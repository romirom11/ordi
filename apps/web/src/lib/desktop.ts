/**
 * Desktop (Tauri) glue (PRD §18). The SPA is the single UI for web and desktop;
 * when running inside Tauri (withGlobalTauri exposes window.__TAURI__), this
 * module wires the native extras: OS notifications, dock/taskbar badge, the
 * global quick-add shortcut event and ordi:// deep links. Every call is
 * best-effort – a missing plugin must never break the web app.
 */
import { api } from './api';

export const isTauri: boolean =
  typeof window !== 'undefined' &&
  (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window));

function t(): any {
  return (window as any).__TAURI__;
}

/** OS notification via the notification plugin. */
export function notifyDesktop(title: string, body: string): void {
  if (!isTauri) return;
  try {
    t()?.core?.invoke?.('plugin:notification|notify', { options: { title, body } })?.catch?.(() => {});
  } catch { /* plugin absent */ }
}

/** Unread badge on the dock/taskbar icon (macOS/Linux; no-op elsewhere). */
export function setBadge(count: number): void {
  if (!isTauri) return;
  try {
    const win = t()?.window?.getCurrentWindow?.();
    win?.setBadgeCount?.(count > 0 ? count : undefined)?.catch?.(() => {});
  } catch { /* older runtime */ }
}

interface DesktopHandlers {
  onQuickAdd: () => void;
  onNavigate: (to: string) => void;
}

/** Resolve an ordi://task/KEY-42 deep link to an in-app route via search. */
async function resolveDeepLink(raw: string, onNavigate: (to: string) => void): Promise<void> {
  const m = raw.match(/^ordi:\/\/task\/([A-Za-z]+-\d+)/);
  if (!m) return;
  try {
    const res = await api.get<{ data: { kind: string; url: string; title: string }[] }>(
      `/search?q=${encodeURIComponent(m[1]!)}`,
    );
    const task = res.data.find((r) => r.kind === 'task');
    if (task) onNavigate(task.url);
  } catch { /* not found / offline */ }
}

/** Wire native events once per app mount. Returns an unsubscribe function. */
export function initDesktop(handlers: DesktopHandlers): () => void {
  if (!isTauri) return () => {};
  const unlisteners: Promise<() => void>[] = [];
  try {
    const ev = t()?.event;
    if (ev?.listen) {
      // Global shortcut (registered in Rust) → open the quick-create modal.
      unlisteners.push(ev.listen('ordi://quick-add', () => handlers.onQuickAdd()));
      // Deep links: the deep-link plugin emits this event with the URL list.
      unlisteners.push(ev.listen('deep-link://new-url', (e: { payload: unknown }) => {
        const urls = Array.isArray(e?.payload) ? (e.payload as string[]) : [String(e?.payload ?? '')];
        for (const u of urls) void resolveDeepLink(u, handlers.onNavigate);
      }));
    }
  } catch { /* best-effort */ }
  return () => {
    for (const p of unlisteners) p.then((un) => un()).catch(() => {});
  };
}
