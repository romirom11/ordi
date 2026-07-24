import { useState, type FormEvent } from 'react';
import { KeyRound } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Button, Input, Card, Spinner } from '../components/ui';
import { useT } from '../lib/i18n';

export function LoginPage() {
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [totpRequired, setTotpRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.post('/auth/login', { email, password, totp: totp || undefined });
      window.location.href = '/';
    } catch (err) {
      if (err instanceof ApiError) {
        const details = err.details as { totpRequired?: boolean } | undefined;
        if (details?.totpRequired && !totpRequired) {
          setTotpRequired(true);
          setError(t('auth.enterTotp'));
        } else {
          setError(err.message);
        }
      } else {
        setError(t('auth.signInFailed'));
      }
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-muted/30 px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded bg-primary text-sm text-primary-foreground">o</div>
          <span className="text-lg font-semibold">ordi</span>
        </div>
        <h1 className="mb-1 text-base font-semibold">{t('auth.signIn')}</h1>
        <p className="mb-5 text-sm text-muted-foreground">{t('auth.useWorkEmail')}</p>

        <form onSubmit={onSubmit} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('auth.email')}</label>
            <Input
              type="email"
              autoComplete="email"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@agency.com"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('auth.password')}</label>
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>
          {totpRequired && (
            <div className="space-y-1">
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <KeyRound size={12} /> {t('auth.totp')}
              </label>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                placeholder="123456"
              />
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={loading} className="w-full">
            {loading ? <Spinner /> : t('auth.signIn')}
          </Button>
        </form>
      </Card>
    </div>
  );
}
