import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@fontsource-variable/inter';
import './index.css';
import { applyStoredTheme, ThemeProvider } from './lib/theme';
import { RouterProvider, usePathname } from './lib/router';
import { useMeQuery, MeProvider } from './lib/auth';
import { I18nProvider, guessLocale, rememberLocale } from './lib/i18n';
import { Shell } from './components/Shell';
import { AppRoutes } from './routes';
import { LoginPage } from './pages/Login';
import { SetupPage } from './pages/Setup';
import { AcceptInvitePage } from './pages/AcceptInvite';
import { DesktopAuthPage } from './pages/DesktopAuth';
import { PublicInvoicePage } from './pages/public/Invoice';
import { PublicQuotePage } from './pages/public/Quote';
import { PortalPage } from './pages/public/Portal';
import { IntakeFormPage } from './pages/public/Intake';
import { CareersPage } from './pages/public/Careers';
import { Spinner, Button, Input, Card } from './components/ui';
import { BrandMark } from './components/BrandMark';
import { installErrorReporting } from './lib/sentry';
import { isTauri } from './lib/desktop';
import { getInstanceUrl, setInstanceUrl } from './lib/api';
import { useT } from './lib/i18n';
import { useState } from 'react';

installErrorReporting();
applyStoredTheme();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

/** Desktop first launch (PRD §18): ask for the ordi instance URL. */
function InstanceGate() {
  const t = useT();
  const [url, setUrl] = useState('https://');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const connect = async () => {
    setError(null);
    setChecking(true);
    const clean = url.replace(/\/+$/, '');
    // Probe through the /api/ prefix – deployments route only /api/* to the
    // API service, so a root /healthz would hit the SPA fallback instead
    // (and, served as CORS-less static HTML, fail from the tauri:// origin).
    // The openapi fallback keeps older API versions without /api/v1/healthz
    // connectable.
    const probes = [
      async () => {
        const res = await fetch(`${clean}/api/v1/healthz`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { status?: string };
        if (body.status !== 'ok') throw new Error('not an ordi instance');
      },
      async () => {
        const res = await fetch(`${clean}/api/docs/openapi.json`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { openapi?: string };
        if (!body.openapi) throw new Error('not an ordi instance');
      },
    ];
    for (const probe of probes) {
      try {
        await probe();
        setInstanceUrl(clean);
        window.location.reload();
        return;
      } catch {
        // try the next probe
      }
    }
    setError(t('desktop.connectFailed'));
    setChecking(false);
  };

  return (
    <div className="grid min-h-screen place-items-center bg-muted/30 px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-1 flex items-center gap-2 font-semibold">
          <BrandMark size={24} />
          ordi
        </div>
        <p className="mb-4 text-sm text-muted-foreground">{t('desktop.connectTitle')}</p>
        <label className="block text-xs text-muted-foreground">
          {t('desktop.instanceUrl')}
          <Input autoFocus value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder="https://ordi.example.com" className="mt-1"
            onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }} />
        </label>
        {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
        <Button className="mt-4 w-full" disabled={checking || url.length < 9} onClick={() => void connect()}>
          {checking ? <Spinner /> : t('desktop.connect')}
        </Button>
      </Card>
    </div>
  );
}

function Root() {
  const path = usePathname();

  // Desktop build (tauri:// origin) has no same-origin API – require an
  // instance URL before anything else (PRD §18 first launch).
  if (isTauri && !getInstanceUrl()) {
    return <I18nProvider locale={guessLocale()}><InstanceGate /></I18nProvider>;
  }

  // Public routes (no auth)
  if (path.startsWith('/setup')) return <I18nProvider locale={guessLocale()}><SetupPage /></I18nProvider>;
  if (path.startsWith('/login')) return <I18nProvider locale={guessLocale()}><LoginPage /></I18nProvider>;
  if (path.startsWith('/accept-invite')) return <I18nProvider locale={guessLocale()}><AcceptInvitePage /></I18nProvider>;
  if (path.startsWith('/desktop-auth')) return <I18nProvider locale={guessLocale()}><DesktopAuthPage /></I18nProvider>;
  if (path.startsWith('/i/')) return <I18nProvider locale={guessLocale()}><PublicInvoicePage token={path.split('/i/')[1]!} /></I18nProvider>;
  if (path.startsWith('/q/')) return <I18nProvider locale={guessLocale()}><PublicQuotePage token={path.split('/q/')[1]!} /></I18nProvider>;
  if (path.startsWith('/portal/')) return <I18nProvider locale={guessLocale()}><PortalPage token={path.split('/portal/')[1]!} /></I18nProvider>;
  if (path.startsWith('/intake/')) return <I18nProvider locale={guessLocale()}><IntakeFormPage token={path.split('/intake/')[1]!} /></I18nProvider>;
  if (path.startsWith('/careers/')) return <I18nProvider locale={guessLocale()}><CareersPage token={path.split('/careers/')[1]!} /></I18nProvider>;

  return <AuthedApp />;
}

function AuthedApp() {
  const me = useMeQuery();
  if (me.isLoading) {
    return <div className="grid h-screen place-items-center"><Spinner /></div>;
  }
  if (me.isError || !me.data) {
    window.location.href = '/login';
    return null;
  }
  rememberLocale(me.data.user.locale);
  return (
    <MeProvider me={me.data}>
      <I18nProvider locale={me.data.user.locale}>
        <Shell><AppRoutes /></Shell>
      </I18nProvider>
    </MeProvider>
  );
}

// Reuse the existing root across Vite HMR re-evaluations of this module –
// calling createRoot twice on the same container is a React error.
const hotData = (import.meta as { hot?: { data: { root?: ReactDOM.Root } } }).hot?.data;
const root = hotData?.root ?? ReactDOM.createRoot(document.getElementById('root')!);
if (hotData) hotData.root = root;

root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RouterProvider>
          <Root />
        </RouterProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
