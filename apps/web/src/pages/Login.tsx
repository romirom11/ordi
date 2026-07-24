import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound } from 'lucide-react';
import { api, ApiError, setSessionToken } from '../lib/api';
import { isTauri } from '../lib/desktop';
import { Button, Input, Card, Spinner } from '../components/ui';
import { BrandMark } from '../components/BrandMark';
import { useT } from '../lib/i18n';

export function LoginPage() {
  const t = useT();
  // Fresh install (no owner yet) → send to the first-run setup wizard.
  const setupStatus = useQuery<{ needsSetup: boolean }>({
    queryKey: ['setup', 'status'],
    queryFn: () => api.get<{ needsSetup: boolean }>('/setup/status'),
    staleTime: Infinity,
    retry: false,
  });
  if (setupStatus.data?.needsSetup) {
    window.history.replaceState({}, '', '/setup');
    window.location.reload();
  }
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const [loading, setLoading] = useState(false);

  function fail(message: string) {
    setError(message);
    setErrorKey((k) => k + 1);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await api.post<{ ok: boolean; sessionToken?: string }>(
        '/auth/login', { email, password, totp: totp || undefined },
      );
      // Desktop (tauri:// origin) cannot use same-site cookies — keep the
      // session token and send it as a bearer credential instead.
      if (isTauri && res.sessionToken) setSessionToken(res.sessionToken);
      window.location.href = '/';
    } catch (err) {
      if (err instanceof ApiError) {
        const details = err.details as { totpRequired?: boolean } | undefined;
        if (details?.totpRequired && !totpRequired) {
          setTotpRequired(true);
          fail(t('auth.enterTotp'));
        } else {
          fail(err.message);
        }
      } else {
        fail(t('auth.signInFailed'));
      }
      setLoading(false);
    }
  }

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-background px-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(640px circle at 50% 32%, hsl(var(--primary) / 0.08), transparent 70%)' }}
      />

      <Card className="anim-pop-in relative w-full max-w-sm p-7 shadow-pop">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <BrandMark size={40} />
          <div>
            <h1 className="text-base font-semibold">{t('auth.signIn')}</h1>
            <p className="text-sm text-muted-foreground">{t('auth.useWorkEmail')}</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('auth.email')}</label>
            <Input
              type="email"
              autoComplete="email"
              autoFocus
              required
              disabled={loading}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@agency.com"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t('auth.password')}</label>
            <Input
              type="password"
              autoComplete="current-password"
              required
              disabled={loading}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          {totpRequired && (
            <div className="space-y-1.5">
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <KeyRound size={12} /> {t('auth.totp')}
              </label>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                disabled={loading}
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                placeholder="123456"
              />
            </div>
          )}

          {error && (
            <p key={errorKey} style={{ animation: 'shake-x 300ms var(--ease-smooth-out)' }} className="text-sm text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? <Spinner /> : t('auth.signIn')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
