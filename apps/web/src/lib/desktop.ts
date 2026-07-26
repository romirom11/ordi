/**
 * Desktop (Tauri) glue (PRD §18). The SPA is the single UI for web and desktop;
 * when running inside Tauri (withGlobalTauri exposes window.__TAURI__), this
 * module wires the native extras: OS notifications, dock/taskbar badge, the
 * global quick-add shortcut event and ordi:// deep links. Every call is
 * best-effort – a missing plugin must never break the web app.
 */
import { api, getInstanceUrl, setSessionToken } from './api';
import { sha256Hex as sha256Fallback } from './sha256';

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
export async function restartDesktop(): Promise<boolean> {
  if (!isTauri) return false;
  // The plugin's injected global is the nice path, but it is not guaranteed to
  // exist – falling back to a raw invoke is what makes the button reliable.
  try {
    const relaunch = t()?.process?.relaunch;
    if (typeof relaunch === 'function') { await relaunch(); return true; }
  } catch { /* fall through */ }
  try {
    const invoke = t()?.core?.invoke;
    if (typeof invoke === 'function') { await invoke('plugin:process|restart'); return true; }
  } catch { /* no way to restart */ }
  return false;
}

/**
 * Ask the shell to check for a desktop build and stage it if one is out.
 * Resolves to 'staged' (restart applies it), 'none' (the release is not
 * published yet – routine right after a server update, builds take a while)
 * or 'error' (offline, GitHub unreachable, not a packaged build).
 */
export async function checkDesktopUpdate(): Promise<'staged' | 'none' | 'error'> {
  if (!isTauri) return 'error';
  try {
    const invoke = t()?.core?.invoke;
    if (typeof invoke !== 'function') return 'error';
    const res = await invoke('check_update') as string;
    if (typeof res === 'string' && res.startsWith('staged')) return 'staged';
    return res === 'none' ? 'none' : 'error';
  } catch {
    return 'error';
  }
}

/** Open a URL in the user's real browser, not in the app window. */
export async function openInBrowser(url: string): Promise<boolean> {
  // Optional chaining would swallow a missing invoke and silently open
  // nothing, so check for it before deciding the plugin handled the URL.
  const invoke = t()?.core?.invoke;
  if (typeof invoke === 'function') {
    try {
      await invoke('plugin:opener|open_url', { url });
      return true;
    } catch { /* fall through to the webview's own opener */ }
  }
  return window.open(url, '_blank') !== null;
}

const VERIFIER_KEY = 'ordi:desktopAuthVerifier';
/** A pending sign-in is worthless after the server-side request expires. */
const VERIFIER_TTL_MS = 10 * 60_000;

interface PendingLogin { verifier: string; state: string; at: number }

/**
 * localStorage, not sessionStorage: a deep link can relaunch the app (Windows
 * and Linux always did before single-instance), and a fresh webview would
 * otherwise have no verifier to redeem the code with.
 */
function readPending(): PendingLogin | null {
  try {
    const raw = localStorage.getItem(VERIFIER_KEY);
    if (!raw) return null;
    const pending = JSON.parse(raw) as PendingLogin;
    if (!pending?.verifier || Date.now() - pending.at > VERIFIER_TTL_MS) {
      localStorage.removeItem(VERIFIER_KEY);
      return null;
    }
    return pending;
  } catch { return null; }
}

function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  // getRandomValues is available outside secure contexts; subtle is not.
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * crypto.subtle exists only in a secure context, which the tauri:// origin is
 * not on every platform. Use it when present, and a plain implementation
 * otherwise – PKCE must not depend on the origin being trusted.
 */
async function sha256Hex(value: string): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(value));
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch { /* unavailable or blocked – fall back */ }
  return sha256Fallback(value);
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
export class BrowserLoginError extends Error {
  /** i18n key describing which step failed, so the UI can be specific. */
  messageKey: string;
  /** Set when the request exists but the browser did not open by itself. */
  url?: string;
  constructor(messageKey: string, url?: string) {
    super(messageKey);
    this.messageKey = messageKey;
    this.url = url;
  }
}

export async function beginBrowserLogin(): Promise<void> {
  const verifier = randomToken();
  const state = randomToken(16);
  const codeChallenge = await sha256Hex(verifier);
  localStorage.setItem(VERIFIER_KEY, JSON.stringify({ verifier, state, at: Date.now() }));

  try {
    await api.post('/auth/desktop/start', { state, codeChallenge, deviceLabel: deviceLabel() });
  } catch {
    localStorage.removeItem(VERIFIER_KEY);
    throw new BrowserLoginError('desktop.browserLoginNoServer');
  }

  const url = `${getInstanceUrl()}/desktop-auth?state=${encodeURIComponent(state)}`;
  // The request is live either way; if we could not launch a browser the user
  // can still open the link themselves, so keep it and say so.
  if (!(await openInBrowser(url))) throw new BrowserLoginError('desktop.browserLoginNoBrowser', url);
}

/** True while a browser sign-in is waiting for its code. */
export function hasPendingBrowserLogin(): boolean {
  return readPending() !== null;
}

/**
 * Listen for the ordi://auth deep link from the login screen, where the app
 * shell (and its deep-link listener) is not mounted yet.
 *
 * The app may have been RELAUNCHED by the deep link, in which case the URL
 * arrived as a launch argument rather than an event – ask for it once too.
 */
export function listenForAuthDeepLink(onError: (message: string) => void): () => void {
  if (!isTauri) return () => {};
  let unlisten: (() => void) | null = null;

  const redeem = (url: string): void => {
    if (!url.startsWith('ordi://auth')) return;
    const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
    const code = params.get('code');
    if (!code) return;
    completeBrowserLogin(code, params.get('state') ?? undefined)
      .catch(() => onError('desktop.browserLoginFailed'));
  };

  // Cold start: the launch URL is not replayed as an event.
  try {
    void (t()?.core?.invoke?.('plugin:deep-link|get_current') as Promise<string[] | null> | undefined)
      ?.then((urls) => (urls ?? []).forEach(redeem))
      .catch(() => {});
  } catch { /* plugin absent */ }

  try {
    void t()?.event?.listen?.('deep-link://new-url', (e: { payload: unknown }) => {
      const urls = Array.isArray(e?.payload) ? (e.payload as string[]) : [String(e?.payload ?? '')];
      urls.forEach(redeem);
    }).then((un: () => void) => { unlisten = un; });
  } catch { /* plugin absent */ }
  return () => { unlisten?.(); };
}

/** Redeem a code from the deep link (or pasted by hand) for a session token. */
export async function completeBrowserLogin(code: string, state?: string): Promise<void> {
  const pending = readPending();
  if (!pending) throw new Error('no pending sign-in');
  if (state && state !== pending.state) throw new Error('sign-in state mismatch');

  const res = await api.post<{ sessionToken: string }>('/auth/desktop/exchange', {
    code: code.trim(), verifier: pending.verifier,
  });
  localStorage.removeItem(VERIFIER_KEY);
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
