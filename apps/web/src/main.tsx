import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { RouterProvider, usePathname } from './lib/router';
import { useMeQuery, MeProvider } from './lib/auth';
import { I18nProvider, guessLocale, rememberLocale } from './lib/i18n';
import { Shell } from './components/Shell';
import { AppRoutes } from './routes';
import { LoginPage } from './pages/Login';
import { AcceptInvitePage } from './pages/AcceptInvite';
import { PublicInvoicePage } from './pages/public/Invoice';
import { PublicQuotePage } from './pages/public/Quote';
import { PortalPage } from './pages/public/Portal';
import { IntakeFormPage } from './pages/public/Intake';
import { CareersPage } from './pages/public/Careers';
import { Spinner } from './components/ui';
import { installErrorReporting } from './lib/sentry';

installErrorReporting();

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function Root() {
  const path = usePathname();

  // Public routes (no auth)
  if (path.startsWith('/login')) return <I18nProvider locale={guessLocale()}><LoginPage /></I18nProvider>;
  if (path.startsWith('/accept-invite')) return <I18nProvider locale={guessLocale()}><AcceptInvitePage /></I18nProvider>;
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider>
        <Root />
      </RouterProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
