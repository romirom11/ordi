/**
 * SMTP and OAuth app credentials, editable in the UI instead of the server
 * .env. Secrets are write-only: the API returns only whether one is stored, so
 * leaving a password field blank keeps the existing value.
 */
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Mail, KeyRound } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Input, Card, Switch, Spinner, cn } from '../ui';
import { toast } from '../overlays';
import { Field } from './primitives';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'settings.emailTitle': 'Email',
    'settings.emailDesc': 'Invites, invoices and reminders are sent from here.',
    'settings.emailCheck': 'Test connection',
    'settings.emailSendTest': 'Send test email',
    'settings.emailOk': 'Connected – outgoing email works.',
    'settings.emailFailed': 'Could not reach the SMTP server. Many hosting providers block outbound SMTP ports.',
    'settings.emailNotConfigured': 'Not configured yet.',
    'settings.emailTestSent': 'Test email sent to {to}',
    'settings.emailTestFailed': 'Could not send: {error}',
    'settings.smtpHost': 'SMTP host',
    'settings.smtpPort': 'Port',
    'settings.smtpSecure': 'Implicit TLS (port 465)',
    'settings.smtpUser': 'Username',
    'settings.smtpPass': 'Password',
    'settings.smtpPassKeep': 'Leave blank to keep the current password',
    'settings.smtpFrom': 'From address',
    'settings.fromEnv': 'Currently taken from the server environment. Saving here overrides it.',
    'settings.oauthClientId': 'Client ID',
    'settings.oauthClientSecret': 'Client secret',
    'settings.oauthSecretKeep': 'Leave blank to keep the current secret',
    'settings.oauthCallback': 'Redirect URL to register with the provider:',
    'settings.credentials': 'Credentials',
  },
  uk: {
    'settings.emailTitle': 'Пошта',
    'settings.emailDesc': 'Звідси надсилаються запрошення, рахунки й нагадування.',
    'settings.emailCheck': 'Перевірити зʼєднання',
    'settings.emailSendTest': 'Надіслати тестовий лист',
    'settings.emailOk': 'Підключено – вихідна пошта працює.',
    'settings.emailFailed': 'Не вдалося досягти SMTP-сервера. Багато хостингів блокують вихідні SMTP-порти.',
    'settings.emailNotConfigured': 'Ще не налаштовано.',
    'settings.emailTestSent': 'Тестовий лист надіслано на {to}',
    'settings.emailTestFailed': 'Не вдалося надіслати: {error}',
    'settings.smtpHost': 'SMTP-хост',
    'settings.smtpPort': 'Порт',
    'settings.smtpSecure': 'Неявний TLS (порт 465)',
    'settings.smtpUser': 'Логін',
    'settings.smtpPass': 'Пароль',
    'settings.smtpPassKeep': 'Залиште порожнім, щоб не змінювати пароль',
    'settings.smtpFrom': 'Адреса відправника',
    'settings.fromEnv': 'Зараз береться зі змінних середовища сервера. Збереження тут перекриє їх.',
    'settings.oauthClientId': 'Client ID',
    'settings.oauthClientSecret': 'Client secret',
    'settings.oauthSecretKeep': 'Залиште порожнім, щоб не змінювати секрет',
    'settings.oauthCallback': 'Redirect URL, який треба вказати у провайдера:',
    'settings.credentials': 'Облікові дані',
  },
});

type Source = 'db' | 'env' | 'none';

interface ConfigResponse {
  smtp: { host: string; port: number; secure: boolean; user: string; from: string; hasPassword: boolean } | null;
  smtpSource: Source;
  github: { clientId: string; hasSecret: boolean } | null;
  githubSource: Source;
  slack: { clientId: string; hasSecret: boolean } | null;
  slackSource: Source;
}

export function useIntegrationsConfig() {
  return useQuery<ConfigResponse>({
    queryKey: ['integrations-config'],
    queryFn: () => api.get<ConfigResponse>('/settings/integrations-config'),
  });
}

/** Shown when the effective value still comes from the server environment. */
function EnvNote({ source }: { source: Source }) {
  const t = useT();
  if (source !== 'env') return null;
  return <p className="mb-3 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground">{t('settings.fromEnv')}</p>;
}

export function EmailCard() {
  const t = useT();
  const qc = useQueryClient();
  const cfg = useIntegrationsConfig();
  const [form, setForm] = useState({ host: '', port: 587, secure: false, user: '', pass: '', from: '' });
  const [health, setHealth] = useState<{ configured: boolean; ok: boolean; error?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const s = cfg.data?.smtp;
    if (s) setForm({ host: s.host, port: s.port, secure: s.secure, user: s.user, pass: '', from: s.from });
  }, [cfg.data]);

  const save = useMutation({
    mutationFn: () => api.patch('/settings/integrations-config', {
      smtp: { ...form, pass: form.pass || undefined },
    }),
    onSuccess: () => {
      setForm((f) => ({ ...f, pass: '' }));
      setHealth(null);
      qc.invalidateQueries({ queryKey: ['integrations-config'] });
      toast(t('common.saved'));
    },
    onError: () => toast.error(t('settings.saveFailed')),
  });

  const check = async () => {
    setChecking(true);
    try {
      setHealth(await api.get<{ configured: boolean; ok: boolean; error?: string }>('/settings/email/health'));
    } catch {
      setHealth({ configured: true, ok: false, error: 'unknown' });
    }
    setChecking(false);
  };

  const sendTest = async () => {
    setSending(true);
    try {
      const r = await api.post<{ sent: boolean; error?: string; to: string }>('/settings/email/test', {});
      if (r.sent) toast(t('settings.emailTestSent').replace('{to}', r.to));
      else toast.error(t('settings.emailTestFailed').replace('{error}', r.error ?? ''));
    } catch {
      toast.error(t('settings.saveFailed'));
    }
    setSending(false);
  };

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
          <Mail size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{t('settings.emailTitle')}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('settings.emailDesc')}</p>
        </div>
      </div>

      <EnvNote source={cfg.data?.smtpSource ?? 'none'} />

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('settings.smtpHost')}>
          <Input value={form.host} placeholder="smtp.example.com"
            onChange={(e) => setForm({ ...form, host: e.target.value })} />
        </Field>
        <Field label={t('settings.smtpPort')}>
          <Input type="number" value={form.port}
            onChange={(e) => setForm({ ...form, port: Number(e.target.value) || 0 })} />
        </Field>
        <Field label={t('settings.smtpUser')}>
          <Input value={form.user} placeholder="you@example.com"
            onChange={(e) => setForm({ ...form, user: e.target.value })} />
        </Field>
        <Field label={t('settings.smtpPass')}>
          <Input type="password" value={form.pass}
            placeholder={cfg.data?.smtp?.hasPassword ? '••••••••' : ''}
            onChange={(e) => setForm({ ...form, pass: e.target.value })} />
          {cfg.data?.smtp?.hasPassword && !form.pass && (
            <p className="mt-1 text-xs text-faint">{t('settings.smtpPassKeep')}</p>
          )}
        </Field>
        <Field label={t('settings.smtpFrom')}>
          <Input value={form.from} placeholder="ordi &lt;no-reply@example.com&gt;"
            onChange={(e) => setForm({ ...form, from: e.target.value })} />
        </Field>
      </div>

      <label className="mt-3 flex items-center gap-2 text-[13px]">
        <Switch checked={form.secure} onChange={(v) => setForm({ ...form, secure: v, port: v ? 465 : 587 })} />
        {t('settings.smtpSecure')}
      </label>
      {health && (
        <p className={cn('mt-3 text-xs', health.ok ? 'text-success' : 'text-destructive')}>
          {!health.configured
            ? t('settings.emailNotConfigured')
            : health.ok ? t('settings.emailOk') : `${t('settings.emailFailed')} (${health.error})`}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!form.host || !form.from || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Spinner /> : t('common.save')}
        </Button>
        <Button size="sm" variant="outline" disabled={checking} onClick={() => void check()}>
          {checking ? <Spinner /> : t('settings.emailCheck')}
        </Button>
        <Button size="sm" variant="ghost" disabled={sending} onClick={() => void sendTest()}>
          {sending ? <Spinner /> : t('settings.emailSendTest')}
        </Button>
      </div>
    </Card>
  );
}

/** Client id/secret for a provider's OAuth app, folded under its own card. */
export function OAuthCredentials({ provider, callbackPath }: { provider: 'github' | 'slack'; callbackPath: string }) {
  const t = useT();
  const qc = useQueryClient();
  const cfg = useIntegrationsConfig();
  const stored = provider === 'github' ? cfg.data?.github : cfg.data?.slack;
  const source = (provider === 'github' ? cfg.data?.githubSource : cfg.data?.slackSource) ?? 'none';
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  useEffect(() => { setClientId(stored?.clientId ?? ''); }, [stored?.clientId]);

  const save = useMutation({
    mutationFn: () => api.patch('/settings/integrations-config', {
      [provider]: { clientId, clientSecret: clientSecret || undefined },
    }),
    onSuccess: () => {
      setClientSecret('');
      qc.invalidateQueries({ queryKey: ['integrations-config'] });
      qc.invalidateQueries({ queryKey: provider === 'github' ? ['gitOAuthStatus'] : ['slackStatus'] });
      toast(t('common.saved'));
    },
    onError: () => toast.error(t('settings.saveFailed')),
  });

  return (
    <div className="mt-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="mb-2.5 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <KeyRound size={12} /> {t('settings.credentials')}
      </div>
      <EnvNote source={source} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('settings.oauthClientId')}>
          <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
        </Field>
        <Field label={t('settings.oauthClientSecret')}>
          <Input type="password" value={clientSecret}
            placeholder={stored?.hasSecret ? '••••••••' : ''}
            onChange={(e) => setClientSecret(e.target.value)} />
        </Field>
      </div>
      {stored?.hasSecret && !clientSecret && (
        <p className="mt-1.5 text-xs text-faint">{t('settings.oauthSecretKeep')}</p>
      )}
      <p className="mt-2.5 text-xs text-muted-foreground">
        {t('settings.oauthCallback')}{' '}
        <code className="font-mono text-[11px] text-foreground">{window.location.origin}{callbackPath}</code>
      </p>
      <Button className="mt-3" size="sm" disabled={!clientId || save.isPending} onClick={() => save.mutate()}>
        {save.isPending ? <Spinner /> : t('common.save')}
      </Button>
    </div>
  );
}
