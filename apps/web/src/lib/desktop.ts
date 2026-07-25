/**
 * Desktop (Tauri) glue (PRD §18). The SPA is the single UI for web and desktop;
 * when running inside Tauri (withGlobalTauri exposes window.__TAURI__), this
 * module wires the native extras: OS notifications, dock/taskbar badge, the
 * global quick-add shortcut event and ordi:// deep links. Every call is
 * best-effort – a missing plugin must never break the web app.
 */
import { api, getInstanceUrl, setSessionToken } from './api';

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
  /** A newer version was downloaded and installed; it applies on restart. */
  onUpdateReady: (version: string) => void;
}

/** Restart into the version staged by the updater. */
export function restartDesktop(): void {
  if (!isTauri) return;
  try {
    t()?.process?.relaunch?.();
  } catch { /* plugin absent */ }
}

/** Open a URL in the user's real browser, not in the app window. */
export async function openInBrowser(url: string): Promise<void> {
  try {
    await t()?.core?.invoke?.('plugin:opener|open_url', { url });
  } catch {
    window.open(url, '_blank');
  }
}

const VERIFIER_KEY = 'ordi:desktopAuthVerifier';

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A human-readable name for this machine, shown on the browser approval screen. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Mac/.test(ua) ? 'macOS' : /Win/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Desktop';
  return `ordi for ${os}`;
}

/**
 * Start the browser sign-in: register the request, remember the verifier, and
 * hand the browser only its hash so an app that hijacks the ordi:// scheme
 * cannot redeem the code it sees.
 */
export async function beginBrowserLogin(): Promise<void> {
  const verifier = randomToken();
  const state = randomToken(16);
  const codeChallenge = await sha256Hex(verifier);
  sessionStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, state }));

  await api.post('/auth/desktop/start', { state, codeChallenge, deviceLabel: deviceLabel() });
  await openInBrowser(`${getInstanceUrl()}/desktop-auth?state=${encodeURIComponent(state)}`);
}

/**
 * Listen for the ordi://auth deep link from the login screen, where the app
 * shell (and its deep-link listener) is not mounted yet.
 */
export function listenForAuthDeepLink(onError: (message: string) => void): () => void {
  if (!isTauri) return () => {};
  let unlisten: (() => void) | null = null;
  try {
    void t()?.event?.listen?.('deep-link://new-url', (e: { payload: unknown }) => {
      const urls = Array.isArray(e?.payload) ? (e.payload as string[]) : [String(e?.payload ?? '')];
      for (const url of urls) {
        if (!url.startsWith('ordi://auth')) continue;
        const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
        const code = params.get('code');
        if (code) {
          completeBrowserLogin(code, params.get('state') ?? undefined)
            .catch(() => onError('desktop.browserLoginFailed'));
        }
      }
    }).then((un: () => void) => { unlisten = un; });
  } catch { /* plugin absent */ }
  return () => { unlisten?.(); };
}

/** Redeem a code from the deep link (or pasted by hand) for a session token. */
export async function completeBrowserLogin(code: string, state?: string): Promise<void> {
  const raw = sessionStorage.getItem(VERIFIER_KEY);
  if (!raw) throw new Error('no pending sign-in');
  const pending = JSON.parse(raw) as { verifier: string; state: string };
  if (state && state !== pending.state) throw new Error('sign-in state mismatch');

  const res = await api.post<{ sessionToken: string }>('/auth/desktop/exchange', {
    code, verifier: pending.verifier,
  });
  sessionStorage.removeItem(VERIFIER_KEY);
  setSessionToken(res.sessionToken);
  window.location.href = '/';
}

/** Resolve an ordi://task/KEY-42 deep link to an in-app route via search. */
async function resolveDeepLink(raw: string, onNavigate: (to: string) => void): Promise<void> {
  // ordi://auth?code=… finishes a browser sign-in rather than navigating.
  if (raw.startsWith('ordi://auth')) {
    const params = new URLSearchParams(raw.slice(raw.indexOf('?') + 1));
    const code = params.get('code');
    if (code) await completeBrowserLogin(code, params.get('state') ?? undefined).catch(() => {});
    return;
  }
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
      // The Rust side stages updates on launch and announces the staged version.
      unlisteners.push(ev.listen('ordi://update-ready', (e: { payload: unknown }) => {
        handlers.onUpdateReady(String(e?.payload ?? ''));
      }));
    }
  } catch { /* best-effort */ }
  return () => {
    for (const p of unlisteners) p.then((un) => un()).catch(() => {});
  };
}
