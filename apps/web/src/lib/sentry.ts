/**
 * Minimal Sentry reporter for the SPA (PRD §19.4) – dependency-free.
 * Enabled when VITE_SENTRY_DSN is set at build time.
 */

interface DsnParts { publicKey: string; host: string; projectId: string; protocol: string }

function parseDsn(dsn: string): DsnParts | null {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\//, '');
    if (!u.username || !projectId) return null;
    return { publicKey: u.username, host: u.host, projectId, protocol: u.protocol.replace(':', '') };
  } catch {
    return null;
  }
}

const raw = (import.meta as any).env?.VITE_SENTRY_DSN as string | undefined;
const dsn = raw ? parseDsn(raw) : null;

export function captureException(error: unknown): void {
  if (!dsn) return;
  const err = error instanceof Error ? error : new Error(String(error));
  const payload = {
    event_id: crypto.randomUUID().replace(/-/g, ''),
    timestamp: new Date().toISOString(),
    platform: 'javascript',
    level: 'error',
    logger: 'ordi-web',
    request: { url: window.location.href },
    exception: {
      values: [{ type: err.name, value: err.message }],
    },
  };
  fetch(`${dsn.protocol}://${dsn.host}/api/${dsn.projectId}/store/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=ordi-web/1.0`,
    },
    body: JSON.stringify(payload),
  }).catch(() => {});
}

export function installErrorReporting(): void {
  if (!dsn) return;
  window.addEventListener('error', (e) => captureException(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => captureException(e.reason));
}
