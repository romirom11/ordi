/**
 * Keeps the app and the server it is bound to from drifting apart silently.
 *
 * Polls /healthz (which now reports the server version) and compares it with
 * the version baked into this bundle:
 *
 * - Desktop, server BEHIND the app: the person updated the app (or it
 *   auto-updated) but their instance was never redeployed. Amber banner with a
 *   link to the update instructions; dismissable per server version.
 * - Server AHEAD of the app: in the browser the fix is a reload (the server
 *   already serves the new bundle); on desktop it is a restart, which lets the
 *   updater stage and apply the matching build.
 *
 * Equal versions render nothing, which is the permanent state for everyone
 * who updates both sides together.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpCircle, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { api } from '../lib/api';
import { isTauri, restartDesktop } from '../lib/desktop';
import { APP_VERSION, compareVersions, isVersion } from '../lib/version';
import { useT, extendDict } from '../lib/i18n';
import { cn } from './ui';

extendDict({
  en: {
    'version.serverBehind': 'This server runs ordi {server}, but the app is {app}. Some features may not work until the server is updated.',
    'version.updateGuide': 'How to update',
    'version.newVersion': 'ordi {server} is available.',
    'version.reload': 'Reload',
    'version.restartToUpdate': 'Restart the app to update',
    'version.dismiss': 'Dismiss',
  },
  uk: {
    'version.serverBehind': 'Сервер працює на ordi {server}, а застосунок – {app}. Частина функцій може не працювати, поки сервер не оновлять.',
    'version.updateGuide': 'Як оновити',
    'version.newVersion': 'Доступна версія ordi {server}.',
    'version.reload': 'Перезавантажити',
    'version.restartToUpdate': 'Перезапустіть застосунок, щоб оновитись',
    'version.dismiss': 'Приховати',
  },
});

const UPDATE_DOCS_URL = 'https://github.com/romirom11/ordi/blob/master/docs/deployment.md#updating';
const DISMISS_KEY = 'ordi:versionBannerDismissed';

function dismissed(): string {
  try { return localStorage.getItem(DISMISS_KEY) ?? ''; } catch { return ''; }
}

export function VersionGuard() {
  const t = useT();
  const [, bump] = useState(0);

  const health = useQuery({
    queryKey: ['server-version'],
    queryFn: () => api.get<{ status: string; version?: string }>('/healthz').catch(() => null),
    // Long-lived tabs and desktop sessions should notice a deploy within minutes.
    refetchInterval: 5 * 60_000,
    staleTime: 5 * 60_000,
  });

  const server = health.data?.version;
  if (!isVersion(server) || !isVersion(APP_VERSION)) return null;
  const cmp = compareVersions(server, APP_VERSION);
  if (cmp === 0) return null;

  // Server behind the app: only the desktop can be in this state legitimately,
  // and only its owner can fix it – nag softly, allow dismissing per version.
  if (cmp < 0) {
    if (!isTauri) return null;
    if (dismissed() === `behind:${server}:${APP_VERSION}`) return null;
    return (
      <Banner tone="warn" icon={<TriangleAlert size={14} />}>
        <span>{t('version.serverBehind').replace('{server}', `v${server}`).replace('{app}', `v${APP_VERSION}`)}</span>
        <a
          href={UPDATE_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 font-medium underline underline-offset-2 hover:opacity-80"
        >
          {t('version.updateGuide')}
        </a>
        <button
          aria-label={t('version.dismiss')}
          onClick={() => {
            try { localStorage.setItem(DISMISS_KEY, `behind:${server}:${APP_VERSION}`); } catch { /* private mode */ }
            bump((v) => v + 1);
          }}
          className="ml-auto grid h-5 w-5 shrink-0 place-items-center rounded hover:bg-black/10 dark:hover:bg-white/10"
        >
          <X size={13} />
        </button>
      </Banner>
    );
  }

  // Server ahead of the app: reload (web) or restart (desktop) gets the new build.
  return (
    <Banner tone="info" icon={<ArrowUpCircle size={14} />}>
      <span>{t('version.newVersion').replace('{server}', `v${server}`)}</span>
      {isTauri ? (
        <button onClick={() => restartDesktop()} className="shrink-0 font-medium underline underline-offset-2 hover:opacity-80">
          {t('version.restartToUpdate')}
        </button>
      ) : (
        <button onClick={() => window.location.reload()} className="inline-flex shrink-0 items-center gap-1 font-medium underline underline-offset-2 hover:opacity-80">
          <RefreshCw size={12} /> {t('version.reload')}
        </button>
      )}
    </Banner>
  );
}

function Banner({ tone, icon, children }: { tone: 'warn' | 'info'; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        'anim-fade-in mb-1.5 flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs',
        tone === 'warn'
          ? 'border-warning/40 bg-warning/10 text-warning'
          : 'border-primary/40 bg-primary/10 text-primary',
      )}
    >
      <span className="shrink-0">{icon}</span>
      {children}
    </div>
  );
}
