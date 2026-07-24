import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { RouterProvider, usePathname } from './lib/router';
import { useMeQuery, MeProvider } from './lib/auth';
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

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function Root() {
  const path = usePathname();

  // Public routes (no auth)
  if (path.startsWith('/login')) return <LoginPage />;
  if (path.startsWith('/accept-invite')) return <AcceptInvitePage />;
  if (path.startsWith('/i/')) return <PublicInvoicePage token={path.split('/i/')[1]!} />;
  if (path.startsWith('/q/')) return <PublicQuotePage token={path.split('/q/')[1]!} />;
  if (path.startsWith('/portal/')) return <PortalPage token={path.split('/portal/')[1]!} />;
  if (path.startsWith('/intake/')) return <IntakeFormPage token={path.split('/intake/')[1]!} />;
  if (path.startsWith('/careers/')) return <CareersPage token={path.split('/careers/')[1]!} />;

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
  return (
    <MeProvider me={me.data}>
      <Shell><AppRoutes /></Shell>
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
