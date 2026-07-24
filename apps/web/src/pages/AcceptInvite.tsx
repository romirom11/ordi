import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useSearchParams } from '../lib/router';
import { Button, Input, Card, Spinner } from '../components/ui';
import { useT } from '../lib/i18n';

interface InvitePreview {
  email: string;
  name?: string | null;
  roleName?: string | null;
}

export function AcceptInvitePage() {
  const t = useT();
  const params = useSearchParams();
  const token = params.get('token') ?? '';

  const invite = useQuery<InvitePreview>({
    queryKey: ['invite', token],
    queryFn: () => api.get<InvitePreview>(`/auth/invite/${token}`),
    enabled: !!token,
    retry: false,
  });

  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError(t('auth.passwordMin'));
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/auth/accept-invite', { token, name, password });
      window.location.href = '/login';
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('auth.acceptInviteFailed'));
      setSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-muted/30 px-4">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-6 flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded bg-primary text-sm text-primary-foreground">o</div>
          <span className="text-lg font-semibold">ordi</span>
        </div>

        {!token ? (
          <p className="text-sm text-destructive">{t('auth.inviteMissingToken')}</p>
        ) : invite.isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : invite.isError ? (
          <div className="space-y-2">
            <h1 className="text-base font-semibold">{t('auth.inviteUnavailable')}</h1>
            <p className="text-sm text-muted-foreground">
              {t('auth.inviteInvalid')}
            </p>
          </div>
        ) : (
          <>
            <h1 className="mb-1 text-base font-semibold">{t('auth.acceptInvite')}</h1>
            <p className="mb-5 text-sm text-muted-foreground">
              {t('auth.settingUp')} <span className="font-medium text-foreground">{invite.data?.email}</span>
              {invite.data?.roleName ? ` ${t('auth.asRole')} ${invite.data.roleName}` : ''}.
            </p>

            <form onSubmit={onSubmit} className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{t('auth.fullName')}</label>
                <Input
                  autoFocus
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Jane Doe"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{t('auth.password')}</label>
                <Input
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t('auth.passwordPlaceholder')}
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button type="submit" disabled={submitting} className="w-full">
                {submitting ? <Spinner /> : t('auth.createAccount')}
              </Button>
            </form>
          </>
        )}
      </Card>
    </div>
  );
}
