/**
 * Last-resort error boundary: a render crash in one page must not white-screen
 * the whole app. Resets automatically on navigation (keyed by pathname in
 * AppRoutes) and reports through the same minimal Sentry pipe as window errors.
 */
import React from 'react';
import { Button } from './ui';
import { extendDict, useT } from '../lib/i18n';
import { captureException } from '../lib/sentry';

extendDict({
  en: {
    'errorBoundary.title': 'Something went wrong',
    'errorBoundary.body': 'This page hit an unexpected error. Your data is safe – try reloading, or go back to the dashboard.',
    'errorBoundary.reload': 'Reload page',
    'errorBoundary.home': 'Go to dashboard',
  },
  uk: {
    'errorBoundary.title': 'Щось пішло не так',
    'errorBoundary.body': 'На цій сторінці сталася неочікувана помилка. Ваші дані в безпеці – спробуйте перезавантажити або поверніться на дашборд.',
    'errorBoundary.reload': 'Перезавантажити',
    'errorBoundary.home': 'На дашборд',
  },
});

function CrashScreen({ error }: { error: Error }) {
  const t = useT();
  return (
    <div className="grid min-h-[60vh] place-items-center px-4">
      <div className="w-full max-w-md text-center">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-full bg-destructive/10 text-destructive">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 9v4" /><path d="M12 17h.01" />
            <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
        </div>
        <h1 className="text-lg font-semibold">{t('errorBoundary.title')}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{t('errorBoundary.body')}</p>
        <p className="mt-3 truncate rounded-md bg-muted px-3 py-1.5 font-mono text-xs text-faint" title={error.message}>
          {error.name}: {error.message}
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <Button onClick={() => window.location.reload()}>{t('errorBoundary.reload')}</Button>
          <Button variant="ghost" onClick={() => { window.location.href = '/'; }}>{t('errorBoundary.home')}</Button>
        </div>
      </div>
    </div>
  );
}

interface State { error: Error | null }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error) {
    captureException(error);
  }

  override render() {
    if (this.state.error) return <CrashScreen error={this.state.error} />;
    return this.props.children;
  }
}
