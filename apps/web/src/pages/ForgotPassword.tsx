import { useState, type FormEvent } from 'react';
import { MailCheck } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Link, useNavigate } from '../lib/router';
import { Button, Input, Card, Spinner } from '../components/ui';
import { BrandMark } from '../components/BrandMark';
import { useT } from '../lib/i18n';

/**
 * "I lost my password". The API answers the same whether or not the address
 * belongs to anyone, so this page confirms delivery in the same words either
 * way – a login screen must not double as a way to find out who works here.
 */
export function ForgotPasswordPage() {
  const t = useT();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
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
    setSubmitting(true);
    try {
      await api.post('/auth/forgot-password', { email });
      setSent(true);
    } catch (err) {
      fail(err instanceof ApiError ? err.message : t('auth.resetLinkFailed'));
    }
    setSubmitting(false);
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
            <h1 className="text-base font-semibold">
              {sent ? t('auth.resetLinkSent') : t('auth.forgotPasswordTitle')}
            </h1>
            <p className="text-sm text-muted-foreground">
              {sent
                ? t('auth.resetLinkSentHint').replace('{email}', email)
                : t('auth.forgotPasswordHint')}
            </p>
          </div>
        </div>

        {sent ? (
          <div className="flex flex-col items-center gap-4">
            <MailCheck size={28} className="text-success" />
            <Button variant="outline" className="w-full" onClick={() => navigate('/login')}>
              {t('auth.backToSignIn')}
            </Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t('auth.email')}</label>
              <Input
                type="email"
                autoComplete="email"
                autoFocus
                required
                disabled={submitting}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@agency.com"
              />
            </div>

            {error && (
              <p key={errorKey} style={{ animation: 'shake-x 300ms var(--ease-smooth-out)' }} className="text-sm text-destructive">
                {error}
              </p>
            )}

            <Button type="submit" disabled={submitting || !email} className="w-full">
              {submitting ? <Spinner /> : t('auth.sendResetLink')}
            </Button>
            <div className="pt-1 text-center">
              <Link to="/login" className="text-xs text-muted-foreground hover:text-foreground">
                {t('auth.backToSignIn')}
              </Link>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
