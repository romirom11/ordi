/**
 * Minimal Sentry reporter (PRD §19.4) — dependency-free. When SENTRY_DSN is set,
 * exceptions are posted to the Sentry store endpoint; otherwise no-ops. The full
 * SDK can replace this behind the same captureException interface.
 */
import { logger } from './logger';

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

const dsn = process.env.SENTRY_DSN ? parseDsn(process.env.SENTRY_DSN) : null;

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  if (!dsn) return;
  const err = error instanceof Error ? error : new Error(String(error));
  const payload = {
    event_id: crypto.randomUUID().replace(/-/g, ''),
    timestamp: new Date().toISOString(),
    platform: 'node',
    level: 'error',
    logger: 'ordi-api',
    exception: {
      values: [{
        type: err.name,
        value: err.message,
        stacktrace: {
          frames: (err.stack ?? '').split('\n').slice(1, 30).reverse().map((line) => ({ function: line.trim() })),
        },
      }],
    },
    extra: context ?? {},
  };
  const url = `${dsn.protocol}://${dsn.host}/api/${dsn.projectId}/store/`;
  fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=ordi/1.0`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  }).catch(() => { /* never fail the request path on telemetry */ });
}

export function installGlobalHandlers(): void {
  if (!dsn) return;
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandledRejection');
    captureException(reason);
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaughtException');
    captureException(err);
  });
  logger.info('sentry reporter enabled');
}
