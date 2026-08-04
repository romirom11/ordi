import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useNavigate, useSearchParams } from '../lib/router';
import { Button, Input, Card, Spinner } from '../components/ui';
import { BrandMark } from '../components/BrandMark';
import { useT } from '../lib/i18n';

interface ResetPreview {
  email: string;
  name?: string | null;
}

/**
 * The other end of a reset link, from the "forgot password" form or from an
 * admin. The token is checked before the form is shown, so an expired or
 * already-used link says so instead of failing after the password is typed.
 */
export function ResetPasswordPage() {
  const t = useT();
  const navigate = useNavigate();
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const grant = useQuery<ResetPreview>({
    queryKey: ['passwordReset', token],
    queryFn: () => api.get<ResetPreview>(`/auth/reset-password/${token}`),
    enabled: !!token,
    retry: false,
  });

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  function fail(message: string) {
    setError(message);
    setErrorKey((k) => k + 1);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      fail(t('auth.passwordMin'));
      return;
    }
    if (password !== confirm) {
      fail(t('auth.passwordsDontMatch'));
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/auth/reset-password', { token, password });
      setDone(true);
    } catch (err) {
      fail(err instanceof ApiError ? err.message : t('auth.resetFailed'));
      setSubmitting(false);
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
          {!token || grant.isError ? null : (
            <div>
              <h1 className="text-base font-semibold">{done ? t('auth.resetDone') : t('auth.resetPassword')}</h1>
              {!grant.isLoading && !done && (
                <p className="text-sm text-muted-foreground">
                  {t('auth.resetFor')} <span className="font-medium text-foreground">{grant.data?.email}</span>
                </p>
              )}
            </div>
          )}
        </div>

        {!token ? (
          <p className="text-center text-sm text-destructive">{t('auth.resetTokenMissing')}</p>
        ) : grant.isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : done ? (
          <div className="flex flex-col items-center gap-4">
            <CheckCircle2 size={28} className="text-success" />
            <Button className="w-full" onClick={() => navigate('/login')}>{t('auth.signIn')}</Button>
          </div>
        ) : grant.isError ? (
          <div className="space-y-3 text-center">
            <h1 className="text-base font-semibold">{t('auth.resetUnavailable')}</h1>
            <p className="text-sm text-muted-foreground">{t('auth.resetTokenInvalid')}</p>
            <Button variant="outline" className="w-full" onClick={() => navigate('/forgot-password')}>
              {t('auth.sendResetLink')}
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t('auth.newPassword')}</label>
              <Input
                type="password"
                autoComplete="new-password"
                autoFocus
                required
                disabled={submitting}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('auth.passwordMin')}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t('auth.confirmPassword')}</label>
              <Input
                type="password"
                autoComplete="new-password"
                required
                disabled={submitting}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            {error && (
              <p key={errorKey} style={{ animation: 'shake-x 300ms var(--ease-smooth-out)' }} className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={submitting} className="w-full">
              {submitting ? <Spinner /> : t('auth.resetPassword')}
            </Button>
          </form>
        )}
      </Card>
    </div>
  );
}
