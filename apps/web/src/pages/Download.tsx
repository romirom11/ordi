/**
 * In-app download page for the desktop build, so nobody has to go to GitHub.
 * The instance may have no outbound network, in which case the API returns no
 * download links and we fall back to the releases page.
 */
import { useQuery } from '@tanstack/react-query';
import { Apple, Monitor, Terminal, Download, ExternalLink } from 'lucide-react';
import { api } from '../lib/api';
import { Button, Card, PageBody, PageHeader, Spinner, cn } from '../components/ui';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'download.title': 'Desktop app',
    'download.subtitle': 'Native notifications, a global quick-add shortcut and automatic updates.',
    'download.for': 'Download for {platform}',
    'download.otherPlatforms': 'Other platforms',
    'download.version': 'Version {version}',
    'download.unavailable': 'Download links are unavailable from this instance. Get the app from the releases page.',
    'download.openReleases': 'Open releases page',
    'download.connectHint': 'On first launch the app asks for your ordi address – enter {url} and sign in with your browser.',
    'download.macos': 'macOS',
    'download.windows': 'Windows',
    'download.linux_appimage': 'Linux (AppImage)',
    'download.linux_deb': 'Linux (.deb)',
  },
  uk: {
    'download.title': 'Десктопний застосунок',
    'download.subtitle': 'Нативні сповіщення, глобальний хоткей швидкого створення і автоматичні оновлення.',
    'download.for': 'Завантажити для {platform}',
    'download.otherPlatforms': 'Інші платформи',
    'download.version': 'Версія {version}',
    'download.unavailable': 'Цей інстанс не може отримати посилання на завантаження. Візьміть застосунок зі сторінки релізів.',
    'download.openReleases': 'Відкрити сторінку релізів',
    'download.connectHint': 'При першому запуску застосунок запитає адресу ordi – введіть {url} і увійдіть через браузер.',
    'download.macos': 'macOS',
    'download.windows': 'Windows',
    'download.linux_appimage': 'Linux (AppImage)',
    'download.linux_deb': 'Linux (.deb)',
  },
});

type Platform = 'macos' | 'windows' | 'linux_appimage' | 'linux_deb';

interface LatestRelease {
  version: string | null;
  publishedAt: string | null;
  releaseUrl: string;
  downloads: Partial<Record<Platform, { url: string; size: number }>>;
}

const ICONS: Record<Platform, typeof Apple> = {
  macos: Apple,
  windows: Monitor,
  linux_appimage: Terminal,
  linux_deb: Terminal,
};

/** Best guess at the visitor's platform, so the right button comes first. */
function guessPlatform(): Platform {
  const ua = navigator.userAgent;
  if (/Mac/i.test(ua)) return 'macos';
  if (/Win/i.test(ua)) return 'windows';
  return 'linux_appimage';
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export function DownloadPage() {
  const t = useT();
  const q = useQuery<LatestRelease>({
    queryKey: ['desktop-latest'],
    queryFn: () => api.get<LatestRelease>('/desktop/latest'),
    staleTime: 30 * 60_000,
  });

  const mine = guessPlatform();
  const downloads = q.data?.downloads ?? {};
  const primary = downloads[mine];
  const others = (Object.keys(downloads) as Platform[]).filter((p) => p !== mine || !primary);

  return (
    <PageBody>
      <PageHeader title={t('download.title')} subtitle={t('download.subtitle')} />

      {q.isLoading ? (
        <div className="grid h-40 place-items-center"><Spinner /></div>
      ) : (
        <Card className="max-w-xl p-6">
          {q.data?.version && (
            <p className="mb-4 text-xs text-muted-foreground">
              {t('download.version').replace('{version}', q.data.version)}
            </p>
          )}

          {primary ? (
            <a href={primary.url} download>
              <Button className="w-full justify-center">
                <Download size={15} />
                {t('download.for').replace('{platform}', t(`download.${mine}`))}
                <span className="text-xs opacity-70">{mb(primary.size)}</span>
              </Button>
            </a>
          ) : (
            <p className="text-sm text-muted-foreground">{t('download.unavailable')}</p>
          )}

          {others.length > 0 && (
            <div className="mt-5">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
                {t('download.otherPlatforms')}
              </p>
              <div className="space-y-1">
                {others.map((p) => {
                  const Icon = ICONS[p];
                  const asset = downloads[p]!;
                  return (
                    <a
                      key={p}
                      href={asset.url}
                      download
                      className={cn(
                        'flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors',
                        'hover:bg-muted',
                      )}
                    >
                      <Icon size={15} className="text-muted-foreground" />
                      <span className="flex-1">{t(`download.${p}`)}</span>
                      <span className="text-xs text-faint">{mb(asset.size)}</span>
                    </a>
                  );
                })}
              </div>
            </div>
          )}

          <p className="mt-5 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
            {t('download.connectHint').replace('{url}', window.location.origin)}
          </p>

          <a
            href={q.data?.releaseUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {t('download.openReleases')} <ExternalLink size={11} />
          </a>
        </Card>
      )}
    </PageBody>
  );
}
