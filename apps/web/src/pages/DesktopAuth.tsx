/**
 * The browser half of "sign in to the desktop app through the browser".
 *
 * The desktop app opens this page with the `state` it generated. Once a
 * signed-in user approves, the API returns a one-time code which we hand back
 * over the ordi:// deep link – and also show, because deep links do not fire
 * reliably on every Linux desktop.
 */
import { useEffect, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Monitor, Check, Copy } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useMeQuery } from '../lib/auth';
import { Button, Card, Spinner } from '../components/ui';
import { BrandMark } from '../components/BrandMark';
import { toast } from '../components/overlays';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'desktopAuth.title': 'Sign in to the desktop app',
    'desktopAuth.subtitle': 'A device is asking to sign in to your workspace.',
    'desktopAuth.as': 'You are signed in as',
    'desktopAuth.approve': 'Sign in on this device',
    'desktopAuth.cancel': 'Cancel',
    'desktopAuth.expired': 'This sign-in request has expired. Start again from the desktop app.',
    'desktopAuth.done': 'Done – back to the app',
    'desktopAuth.doneHint': 'The ordi app should be signed in now. If it did not open, paste this code into it:',
    'desktopAuth.copied': 'Code copied',
    'desktopAuth.failed': 'Could not complete the sign-in. Start again from the desktop app.',
    'desktopAuth.unknownDevice': 'Desktop app',
  },
  uk: {
    'desktopAuth.title': 'Вхід у десктопний застосунок',
    'desktopAuth.subtitle': 'Пристрій просить дозвіл увійти у ваш воркспейс.',
    'desktopAuth.as': 'Ви увійшли як',
    'desktopAuth.approve': 'Увійти на цьому пристрої',
    'desktopAuth.cancel': 'Скасувати',
    'desktopAuth.expired': 'Термін дії запиту минув. Почніть знову з десктопного застосунку.',
    'desktopAuth.done': 'Готово – поверніться в застосунок',
    'desktopAuth.doneHint': 'Застосунок ordi вже має бути авторизований. Якщо він не відкрився, вставте цей код у нього:',
    'desktopAuth.copied': 'Код скопійовано',
    'desktopAuth.failed': 'Не вдалося завершити вхід. Почніть знову з десктопного застосунку.',
    'desktopAuth.unknownDevice': 'Десктопний застосунок',
  },
});

export function DesktopAuthPage() {
  const t = useT();
  const me = useMeQuery();
  const state = new URLSearchParams(window.location.search).get('state') ?? '';
  const [code, setCode] = useState<string | null>(null);

  const request = useQuery({
    queryKey: ['desktop-auth-request', state],
    queryFn: () => api.get<{ deviceLabel: string; approved: boolean }>(
      `/auth/desktop/request?state=${encodeURIComponent(state)}`,
    ),
    retry: false,
    enabled: !!state,
  });

  // Send the user to the login screen, then straight back here.
  useEffect(() => {
    if (me.isLoading) return;
    if (me.isError || !me.data) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.href = `/login?next=${encodeURIComponent(next)}`;
    }
  }, [me.isLoading, me.isError, me.data]);

  const approve = useMutation({
    mutationFn: () => api.post<{ code: string }>('/auth/desktop/approve', { state }),
    onSuccess: (res) => {
      setCode(res.code);
      window.location.href = `ordi://auth?code=${encodeURIComponent(res.code)}&state=${encodeURIComponent(state)}`;
    },
    onError: () => toast.error(t('desktopAuth.failed')),
  });

  if (!state || (request.isError && (request.error as ApiError)?.status === 404)) {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">{t('desktopAuth.expired')}</p>
      </Shell>
    );
  }
  if (me.isLoading || request.isLoading || !me.data) {
    return <Shell><Spinner /></Shell>;
  }

  if (code) {
    return (
      <Shell>
        <div className="mb-3 grid size-10 place-items-center rounded-full bg-success/10 text-success">
          <Check size={20} />
        </div>
        <h1 className="text-[15px] font-semibold">{t('desktopAuth.done')}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('desktopAuth.doneHint')}</p>
        <button
          onClick={() => { void navigator.clipboard?.writeText(code); toast(t('desktopAuth.copied')); }}
          className="mt-3 flex w-full items-center justify-between gap-2 rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs transition-colors hover:border-border-strong"
        >
          <span className="truncate">{code}</span>
          <Copy size={13} className="shrink-0 text-faint" />
        </button>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="mb-3 grid size-10 place-items-center rounded-full bg-primary/10 text-primary">
        <Monitor size={20} />
      </div>
      <h1 className="text-[15px] font-semibold">{t('desktopAuth.title')}</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{t('desktopAuth.subtitle')}</p>

      <div className="mt-4 rounded-md border border-border bg-muted/40 px-3 py-2.5 text-[13px]">
        <p className="font-medium">{request.data?.deviceLabel || t('desktopAuth.unknownDevice')}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t('desktopAuth.as')} <span className="text-foreground">{me.data.user.email}</span>
        </p>
      </div>

      <div className="mt-5 flex items-center gap-2">
        <Button className="flex-1" disabled={approve.isPending} onClick={() => approve.mutate()}>
          {approve.isPending ? <Spinner /> : t('desktopAuth.approve')}
        </Button>
        <Button variant="ghost" onClick={() => { window.location.href = '/'; }}>
          {t('desktopAuth.cancel')}
        </Button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-muted/30 px-4">
      <Card className="w-full max-w-sm p-6 text-center">
        <div className="mb-4 flex items-center justify-center gap-2 text-[15px] font-semibold">
          <BrandMark size={22} />
          ordi
        </div>
        <div className="flex flex-col items-center">{children}</div>
      </Card>
    </div>
  );
}
