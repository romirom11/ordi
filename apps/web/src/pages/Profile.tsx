import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { Button, Input, Select, Card, Badge, PageHeader, Skeleton, fmtDate } from '../components/ui';
import { Check, Copy, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useT } from '../lib/i18n';

interface ApiToken {
  id: string;
  name: string;
  prefix?: string | null;
  scopes?: string[] | null;
  readOnly?: boolean;
  lastUsedAt?: string | null;
  revoked?: boolean;
}
interface TotpState { enabled: boolean }
interface TotpSetup { secret: string; otpauthUrl: string }

// `label` is an i18n dictionary key, translated at render time.
const NOTIFICATION_TYPES: { type: string; label: string }[] = [
  { type: 'task.assigned', label: 'profile.notifTaskAssigned' },
  { type: 'comment.mentioned', label: 'profile.notifMentioned' },
  { type: 'task.status_changed', label: 'profile.notifTaskStatus' },
  { type: 'invoice.paid', label: 'profile.notifInvoicePaid' },
  { type: 'quote.accepted', label: 'profile.notifQuoteAccepted' },
  { type: 'leave.requested', label: 'profile.notifLeaveRequested' },
  { type: 'leave.decided', label: 'profile.notifLeaveDecided' },
];

export function ProfilePage() {
  const t = useT();
  const me = useMe();
  return (
    <div>
      <PageHeader title={t('profile.title')} subtitle={me.user.email} />
      <div className="max-w-3xl space-y-4 p-6">
        <ProfileSection />
        <NotificationsSection />
        <TokensSection />
        <TotpSection />
      </div>
    </div>
  );
}

function ProfileSection() {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: me.user.name, timezone: me.user.timezone, locale: me.user.locale as string });
  const save = useMutation({
    mutationFn: () => api.patch('/me', { name: form.name, timezone: form.timezone, locale: form.locale }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });

  return (
    <Card className="p-4">
      <div className="mb-3 text-sm font-medium">{t('profile.title')}</div>
      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (form.name.trim()) save.mutate();
        }}
      >
        <label className="text-xs text-muted-foreground">
          {t('profile.name')}
          <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} className="mt-1" />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('profile.timezone')}
          <Input value={form.timezone} onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))} placeholder="Europe/Kyiv" className="mt-1" />
        </label>
        <label className="text-xs text-muted-foreground">
          {t('profile.language')}
          <Select value={form.locale} onChange={(e) => setForm((f) => ({ ...f, locale: e.target.value }))} className="mt-1 block w-full">
            <option value="uk">Українська</option>
            <option value="en">English</option>
          </Select>
        </label>
        <div className="flex items-center gap-3 sm:col-span-3">
          <Button type="submit" size="sm" disabled={save.isPending || !form.name.trim()}>{t('common.save')}</Button>
          {save.isSuccess && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Check size={13} /> {t('common.saved')}</span>}
          {save.isError && <span className="text-xs text-destructive">{t('common.saveFailed')}</span>}
        </div>
      </form>
    </Card>
  );
}

function NotificationsSection() {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const stored = ((me.user as unknown as Record<string, unknown>).emailNotificationPrefs ?? (me as unknown as Record<string, unknown>).emailNotificationPrefs ?? {}) as Record<string, boolean>;
  const [prefs, setPrefs] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const { type } of NOTIFICATION_TYPES) initial[type] = stored[type] ?? true;
    return initial;
  });
  const save = useMutation({
    mutationFn: (next: Record<string, boolean>) => api.patch('/me', { emailNotificationPrefs: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });

  const toggle = (type: string) => {
    const next = { ...prefs, [type]: !prefs[type] };
    setPrefs(next);
    save.mutate(next);
  };

  return (
    <Card className="p-4">
      <div className="mb-1 text-sm font-medium">{t('profile.emailNotifications')}</div>
      <p className="mb-3 text-xs text-muted-foreground">{t('profile.emailNotificationsHint')}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {NOTIFICATION_TYPES.map(({ type, label }) => (
          <label key={type} className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="accent-primary" checked={prefs[type] ?? true} onChange={() => toggle(type)} />
            {t(label)}
          </label>
        ))}
      </div>
      {save.isError && <p className="mt-2 text-xs text-destructive">{t('common.saveFailed')}</p>}
    </Card>
  );
}

function CopyField({ value, mono = true }: { value: string; mono?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-1.5">
      <Input
        readOnly
        value={value}
        className={mono ? 'font-mono text-xs' : undefined}
        onFocus={(e) => e.target.select()}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </Button>
    </div>
  );
}

function TokensSection() {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const tokens = useQuery({
    queryKey: ['apiTokens'],
    queryFn: () => api.get<{ data: ApiToken[] }>('/auth/tokens'),
  });

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [scopes, setScopes] = useState<string[]>([]);
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<{ id: string; token: string }>('/auth/tokens', { name, readOnly, scopes }),
    onSuccess: (res) => {
      setCreatedToken(res.token);
      setName('');
      setReadOnly(false);
      setScopes([]);
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ['apiTokens'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/auth/tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['apiTokens'] }),
  });

  const toggleScope = (scope: string) => {
    setScopes((s) => (s.includes(scope) ? s.filter((x) => x !== scope) : [...s, scope]));
  };

  const rows = tokens.data?.data ?? [];

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium"><KeyRound size={15} className="text-muted-foreground" /> {t('profile.apiTokens')}</div>
        <Button size="sm" variant="outline" onClick={() => setShowForm((s) => !s)}><Plus size={13} /> {t('profile.newToken')}</Button>
      </div>

      {createdToken && (
        <div className="mb-3 rounded-md border border-border bg-muted/40 p-3">
          <p className="mb-2 text-xs font-medium text-destructive">{t('profile.tokenCopyOnce')}</p>
          <CopyField value={createdToken} />
          <button className="mt-2 text-xs text-muted-foreground hover:underline" onClick={() => setCreatedToken(null)}>{t('common.close')}</button>
        </div>
      )}

      {showForm && (
        <form
          className="mb-4 space-y-3 rounded-md border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && scopes.length > 0) create.mutate();
          }}
        >
          <div className="flex items-end gap-3">
            <label className="flex-1 text-xs text-muted-foreground">
              {t('common.name')}
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('profile.tokenNamePlaceholder')} className="mt-1" />
            </label>
            <label className="flex h-9 cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" className="accent-primary" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
              {t('profile.readOnly')}
            </label>
          </div>
          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">{t('profile.scopes')} ({scopes.length} {t('profile.selected')})</div>
            <div className="grid max-h-40 grid-cols-2 gap-1 overflow-y-auto sm:grid-cols-3">
              {me.permissions.map((p) => (
                <label key={p} className="flex cursor-pointer items-center gap-1.5 text-xs">
                  <input type="checkbox" className="accent-primary" checked={scopes.includes(p)} onChange={() => toggleScope(p)} />
                  <span className="truncate">{p}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={create.isPending || !name.trim() || scopes.length === 0}>{t('profile.createToken')}</Button>
            {create.isError && <span className="text-xs text-destructive">{t('profile.createTokenFailed')}</span>}
          </div>
        </form>
      )}

      {tokens.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : tokens.isError ? (
        <p className="text-sm text-destructive">{t('profile.loadTokensFailed')}</p>
      ) : rows.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{t('profile.noTokens')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-medium">{t('common.name')}</th>
              <th className="py-2 pr-3 font-medium">{t('profile.prefix')}</th>
              <th className="py-2 pr-3 font-medium">{t('profile.scopes')}</th>
              <th className="py-2 pr-3 font-medium">{t('profile.lastUsed')}</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {rows.map((tok) => (
              <tr key={tok.id} className="border-b border-border last:border-0">
                <td className="py-2 pr-3">
                  <span className="font-medium">{tok.name}</span>
                  {tok.readOnly && <Badge className="ml-2 bg-muted text-muted-foreground">{t('profile.readOnly')}</Badge>}
                  {tok.revoked && <Badge className="ml-2 bg-destructive/10 text-destructive">{t('profile.revoked')}</Badge>}
                </td>
                <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{tok.prefix ?? '—'}</td>
                <td className="py-2 pr-3 tabular-nums">{tok.scopes?.length ?? 0}</td>
                <td className="py-2 pr-3 text-muted-foreground">{tok.lastUsedAt ? fmtDate(tok.lastUsedAt) : t('profile.never')}</td>
                <td className="py-2 text-right">
                  {!tok.revoked && (
                    <button
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                      title={t('profile.revokeToken')}
                      onClick={() => revoke.mutate(tok.id)}
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {revoke.isError && <p className="mt-2 text-xs text-destructive">{t('profile.revokeFailed')}</p>}
    </Card>
  );
}

function TotpSection() {
  const t = useT();
  const qc = useQueryClient();
  const totp = useQuery({
    queryKey: ['totp'],
    queryFn: async (): Promise<TotpState | null> => {
      try {
        return await api.get<TotpState>('/auth/totp');
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
    retry: false,
  });

  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [enableCode, setEnableCode] = useState('');
  const [disableCode, setDisableCode] = useState('');
  const [showDisable, setShowDisable] = useState(false);

  const startSetup = useMutation({
    mutationFn: () => api.post<TotpSetup>('/auth/totp/setup'),
    onSuccess: (res) => setSetup(res),
  });
  const enable = useMutation({
    mutationFn: () => api.post('/auth/totp/enable', { code: enableCode }),
    onSuccess: () => {
      setSetup(null);
      setEnableCode('');
      qc.invalidateQueries({ queryKey: ['totp'] });
    },
  });
  const disable = useMutation({
    mutationFn: () => api.post('/auth/totp/disable', { code: disableCode }),
    onSuccess: () => {
      setDisableCode('');
      setShowDisable(false);
      qc.invalidateQueries({ queryKey: ['totp'] });
    },
  });

  if (totp.isLoading) return <Skeleton className="h-20 w-full" />;
  // Endpoint missing (404) or errored — hide the section gracefully.
  if (totp.isError || totp.data == null) return null;

  const enabled = totp.data.enabled;

  return (
    <Card className="p-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium">
        <ShieldCheck size={15} className="text-muted-foreground" />
        {t('profile.twoFactor')}
        {enabled && <Badge className="bg-primary/10 text-primary">{t('profile.enabled')}</Badge>}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('profile.twoFactorHint')}</p>

      {!enabled && !setup && (
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => startSetup.mutate()} disabled={startSetup.isPending}>{t('profile.enable2fa')}</Button>
          {startSetup.isError && <span className="text-xs text-destructive">{t('profile.setupFailed')}</span>}
        </div>
      )}

      {!enabled && setup && (
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-xs text-muted-foreground">{t('profile.totpSecretHint')}</div>
            <CopyField value={setup.secret} />
          </div>
          <div>
            <div className="mb-1 text-xs text-muted-foreground">{t('profile.totpUrlHint')}</div>
            <CopyField value={setup.otpauthUrl} />
          </div>
          <form
            className="flex items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (enableCode.trim().length === 6) enable.mutate();
            }}
          >
            <label className="text-xs text-muted-foreground">
              {t('profile.sixDigitCode')}
              <Input
                value={enableCode}
                onChange={(e) => setEnableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                placeholder="123456"
                className="mt-1 w-28 font-mono tracking-widest"
              />
            </label>
            <Button type="submit" size="sm" disabled={enable.isPending || enableCode.length !== 6}>{t('profile.confirm')}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setSetup(null)}>{t('common.cancel')}</Button>
          </form>
          {enable.isError && <p className="text-xs text-destructive">{t('profile.invalidCodeRetry')}</p>}
        </div>
      )}

      {enabled && !showDisable && (
        <Button size="sm" variant="outline" onClick={() => setShowDisable(true)}>{t('profile.disable2fa')}</Button>
      )}

      {enabled && showDisable && (
        <form
          className="flex items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (disableCode.trim().length === 6) disable.mutate();
          }}
        >
          <label className="text-xs text-muted-foreground">
            {t('profile.sixDigitCode')}
            <Input
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              placeholder="123456"
              className="mt-1 w-28 font-mono tracking-widest"
            />
          </label>
          <Button type="submit" size="sm" variant="destructive" disabled={disable.isPending || disableCode.length !== 6}>{t('profile.disable')}</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => { setShowDisable(false); setDisableCode(''); }}>{t('common.cancel')}</Button>
          {disable.isError && <span className="text-xs text-destructive">{t('profile.invalidCode')}</span>}
        </form>
      )}
    </Card>
  );
}
