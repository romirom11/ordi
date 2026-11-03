/**
 * Keeps the app and the server it is bound to from drifting apart, without
 * getting in the way. Nothing shows until there is something to do; then one
 * quiet row sits in the sidebar footer, above Settings.
 *
 * Polls /healthz (which reports the server version) and compares it with the
 * version baked into this bundle:
 *
 * - Desktop, new build downloaded: the shell looks for builds at launch, every
 *   half hour and whenever the server is seen to move ahead, downloading them
 *   silently. Once one is ready the row reads "Update to vX" and a click
 *   installs and relaunches. A build that is not published yet (routine right
 *   after a server deploy) shows nothing at all.
 * - Web, server ahead: the server already serves the new bundle, so the next
 *   page change becomes a full load and picks it up unnoticed. The row offers
 *   a reload for someone who stays on one page.
 * - Desktop, server behind the app: the person updated the app but their
 *   instance was never redeployed. An amber row links to the update guide and
 *   can be dismissed per version.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpCircle, TriangleAlert, X } from 'lucide-react';
import { api } from '../lib/api';
import {
  checkDesktopUpdate, installDesktopUpdate, isTauri, onDesktopUpdateReady, openExternal, pendingDesktopUpdate,
} from '../lib/desktop';
import { usePathname } from '../lib/router';
import { APP_VERSION, compareVersions, isVersion } from '../lib/version';
import { useT, extendDict } from '../lib/i18n';
import { cn } from './ui';

extendDict({
  en: {
    'version.updateTo': 'Update to {version}',
    'version.updating': 'Updating…',
    'version.updateFailed': 'Could not update. Click to try again',
    'version.updateHint': 'Restarts ordi on the new version',
    'version.reloadNew': 'New version – reload',
    'version.serverBehindShort': 'Server needs an update',
    'version.serverBehind': 'This server runs ordi {server}, but the app is {app}. Some features may not work until the server is updated. Click for the update guide.',
    'version.dismiss': 'Dismiss',
  },
  uk: {
    'version.updateTo': 'Оновити до {version}',
    'version.updating': 'Оновлюю…',
    'version.updateFailed': 'Не вдалося оновити. Натисніть, щоб спробувати ще раз',
    'version.updateHint': 'Перезапустить ordi на новій версії',
    'version.reloadNew': 'Нова версія – перезавантажити',
    'version.serverBehindShort': 'Сервер треба оновити',
    'version.serverBehind': 'Сервер працює на ordi {server}, а застосунок – {app}. Частина функцій може не працювати, поки сервер не оновлять. Натисніть, щоб відкрити інструкцію.',
    'version.dismiss': 'Приховати',
  },
});

const UPDATE_DOCS_URL = 'https://github.com/romirom11/ordi/blob/master/docs/deployment.md#updating';
const DISMISS_KEY = 'ordi:versionBannerDismissed';
const RELOAD_KEY = 'ordi:versionReloaded';

function dismissed(): string {
  try { return localStorage.getItem(DISMISS_KEY) ?? ''; } catch { return ''; }
}

/** The desktop build downloaded and waiting to be installed, if any. */
function useDesktopUpdate(serverAhead: string | null): string | null {
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri) return;
    void pendingDesktopUpdate().then((v) => { if (v) setReady(v); });
    return onDesktopUpdateReady((v) => { if (v) setReady(v); });
  }, []);
  // The server just moved ahead: ask right away instead of waiting for the
  // shell's next half-hourly round. Once per server version.
  useEffect(() => {
    if (!isTauri || !serverAhead) return;
    void checkDesktopUpdate().then((v) => { if (v) setReady(v); });
  }, [serverAhead]);
  return ready;
}

export function UpdateIndicator() {
  const t = useT();
  const path = usePathname();
  const [, bump] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'installing' | 'failed'>('idle');

  const health = useQuery({
    queryKey: ['server-version'],
    queryFn: () => api.get<{ status: string; version?: string }>('/healthz').catch(() => null),
    // Long-lived tabs and desktop sessions should notice a deploy within minutes.
    refetchInterval: 5 * 60_000,
    staleTime: 5 * 60_000,
  });

  const server = health.data?.version;
  const known = isVersion(server) && isVersion(APP_VERSION);
  const cmp = known ? compareVersions(server, APP_VERSION) : 0;
  const desktopReady = useDesktopUpdate(cmp > 0 ? server! : null);

  // Web: the server already serves the new bundle, so turn the next page
  // change into a full load. The person was leaving the page anyway, and
  // nothing on it is lost. Once per server version: if a cache still hands
  // out the old bundle, every navigation must not become a reload.
  const startPath = useRef(path);
  useEffect(() => {
    if (isTauri || cmp <= 0) { startPath.current = path; return; }
    if (path === startPath.current) return;
    const mark = `reload:${server}`;
    try {
      if (sessionStorage.getItem(RELOAD_KEY) === mark) return;
      sessionStorage.setItem(RELOAD_KEY, mark);
    } catch { return; }
    window.location.reload();
  }, [path, cmp, server]);

  // A build of this app's own version or older is nothing to offer.
  if (isTauri && desktopReady && (!isVersion(desktopReady) || compareVersions(desktopReady, APP_VERSION) > 0)) {
    const label = phase === 'installing'
      ? t('version.updating')
      : phase === 'failed' ? t('version.updateFailed') : t('version.updateTo').replace('{version}', `v${desktopReady}`);
    return (
      <button
        type="button"
        title={t('version.updateHint')}
        disabled={phase === 'installing'}
        onClick={() => {
          setPhase('installing');
          void installDesktopUpdate().then((ok) => { if (!ok) setPhase('failed'); });
        }}
        className={rowCls('info')}
      >
        <ArrowUpCircle size={16} className="shrink-0" />
        <span className="flex-1 truncate text-left">{label}</span>
      </button>
    );
  }

  if (!known || cmp === 0) return null;

  if (cmp > 0) {
    // Desktop with no build yet: say nothing, the shell keeps looking.
    if (isTauri) return null;
    return (
      <button type="button" onClick={() => window.location.reload()} className={rowCls('info')}>
        <ArrowUpCircle size={16} className="shrink-0" />
        <span className="flex-1 truncate text-left">{t('version.reloadNew')}</span>
      </button>
    );
  }

  // Server behind the app: only the desktop can be in this state legitimately,
  // and only its owner can fix it – nag softly, allow dismissing per version.
  const key = `behind:${server}:${APP_VERSION}`;
  if (!isTauri || dismissed() === key) return null;
  return (
    <div
      className={cn(rowCls('warn'), 'group/upd pr-1')}
      title={t('version.serverBehind').replace('{server}', `v${server}`).replace('{app}', `v${APP_VERSION}`)}
    >
      <button type="button" onClick={() => openExternal(UPDATE_DOCS_URL)} className="flex min-w-0 flex-1 items-center gap-2.5">
        <TriangleAlert size={16} className="shrink-0" />
        <span className="flex-1 truncate text-left">{t('version.serverBehindShort')}</span>
      </button>
      <button
        type="button"
        aria-label={t('version.dismiss')}
        onClick={() => {
          try { localStorage.setItem(DISMISS_KEY, key); } catch { /* private mode */ }
          bump((v) => v + 1);
        }}
        className="grid h-5 w-5 shrink-0 place-items-center rounded opacity-0 transition-opacity hover:bg-black/10 focus-visible:opacity-100 group-hover/upd:opacity-100 dark:hover:bg-white/10"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/** Same shape as the sidebar's nav rows, tinted so it reads as a notice. */
function rowCls(tone: 'info' | 'warn'): string {
  return cn(
    'anim-fade-in flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-[13px] font-medium transition-colors duration-150 disabled:opacity-70',
    tone === 'warn'
      ? 'text-warning hover:bg-warning/10'
      : 'bg-primary/10 text-primary hover:bg-primary/15',
  );
}
