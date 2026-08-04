import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { Button, Input, Select, Card, Badge, Switch, Checkbox, Avatar, PageHeader, PageBody, Breadcrumbs, Skeleton, Spinner, fmtDate } from '../components/ui';
import { toast } from '../components/overlays';
import { Camera, Check, Copy, KeyRound, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { extendDict, useT } from '../lib/i18n';
import { DATE_FORMATS, TIME_ZONES, formatSample, offsetLabel, rememberDateFormat, type DateFormat } from '../lib/dates';
import { downscaleImage } from '../components/settings/image';

extendDict({
  en: {
    'profile.profileInfo': 'Profile',
    'profile.preferences': 'Preferences',
    'profile.security': 'Security',
    'profile.saveFailedShort': 'Could not save changes.',
    'profile.notifSaveFailed': 'Could not update notification preference.',
    'profile.tokenCreated': 'API token created.',
    'profile.tokenRevoked': 'Token revoked.',
    'profile.avatarChange': 'Change photo',
    'profile.avatarRemove': 'Remove',
    'profile.avatarInvalid': "Couldn't read that image.",
    'profile.avatarTooLarge': 'Image too large after processing – try a simpler image.',
    'profile.twoFactorEnabled': 'Two-factor authentication enabled.',
    'profile.twoFactorDisabled': 'Two-factor authentication disabled.',
    'profile.password': 'Password',
    'profile.passwordHint': 'Changing it signs you out everywhere else and cancels any pending reset link.',
    'profile.changePassword': 'Change password',
    'profile.currentPassword': 'Current password',
    'profile.passwordChanged': 'Password changed.',
    'profile.passwordChangeFailed': 'Could not change the password.',
  },
  uk: {
    'profile.profileInfo': 'Профіль',
    'profile.preferences': 'Налаштування',
    'profile.security': 'Безпека',
    'profile.saveFailedShort': 'Не вдалося зберегти зміни.',
    'profile.notifSaveFailed': 'Не вдалося оновити налаштування сповіщень.',
    'profile.tokenCreated': 'API-токен створено.',
    'profile.tokenRevoked': 'Токен відкликано.',
    'profile.avatarChange': 'Змінити фото',
    'profile.avatarRemove': 'Прибрати',
    'profile.avatarInvalid': 'Не вдалося прочитати зображення.',
    'profile.avatarTooLarge': 'Зображення завелике після обробки – оберіть простіше.',
    'profile.twoFactorEnabled': 'Двофакторну автентифікацію увімкнено.',
    'profile.twoFactorDisabled': 'Двофакторну автентифікацію вимкнено.',
    'profile.password': 'Пароль',
    'profile.passwordHint': 'Зміна пароля завершує всі інші сесії та скасовує невикористане посилання на відновлення.',
    'profile.changePassword': 'Змінити пароль',
    'profile.currentPassword': 'Поточний пароль',
    'profile.passwordChanged': 'Пароль змінено.',
    'profile.passwordChangeFailed': 'Не вдалося змінити пароль.',
  },
});

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
  { type: 'sales.work_digest', label: 'profile.notifSalesDigest' },
];

export function ProfilePage() {
  const t = useT();
  const me = useMe();
  return (
    <div>
      <PageHeader
        title={t('profile.title')}
        subtitle={me.user.email}
        breadcrumbs={<Breadcrumbs items={[{ label: t('profile.title') }]} />}
      />
      <PageBody className="space-y-4">
        <ProfileInfoCard />
        <PreferencesCard />
        <NotificationsSection />
        <div>
          <h2 className="mb-2 px-0.5 text-xs font-semibold uppercase tracking-wide text-faint">{t('profile.security')}</h2>
          <div className="space-y-4">
            <PasswordSection />
            <TokensSection />
            <TotpSection />
          </div>
        </div>
      </PageBody>
    </div>
  );
}

function SectionHeader({ title }: { title: string }) {
  return <div className="mb-3 text-sm font-medium">{title}</div>;
}

function SaveRow({ dirty, pending, t }: { dirty: boolean; pending: boolean; t: (k: string) => string }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <Button type="submit" size="sm" disabled={!dirty || pending}>
        {t('common.save')}
      </Button>
    </div>
  );
}

function ProfileInfoCard() {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const [name, setName] = useState(me.user.name);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const dirty = name.trim() !== me.user.name && name.trim().length > 0;

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch('/me', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['users-lookup'] });
      toast(t('common.saved'));
    },
    onError: () => toast.error(t('profile.saveFailedShort')),
  });

  /**
   * Same path the workspace logo takes: downscale in the browser, store the
   * result on the record. The avatar was rendered everywhere and settable
   * nowhere, so everyone stayed on their initials.
   */
  const pickAvatar = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error(t('profile.avatarInvalid')); return; }
    setUploading(true);
    try {
      const { dataUrl, bytes } = await downscaleImage(file);
      if (bytes > 200 * 1024) { toast.error(t('profile.avatarTooLarge')); return; }
      await save.mutateAsync({ avatar: dataUrl });
    } catch {
      toast.error(t('profile.avatarInvalid'));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <Card className="p-4">
      <SectionHeader title={t('profile.profileInfo')} />
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          title={t('profile.avatarChange')}
          className="group relative shrink-0 rounded-full outline-none ring-offset-2 ring-offset-card focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Avatar name={me.user.name} src={me.user.avatar} size={56} />
          <span className="absolute inset-0 grid place-items-center rounded-full bg-black/55 text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100">
            {uploading ? <Spinner className="h-4 w-4" /> : <Camera size={16} />}
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => { void pickAvatar(e.target.files?.[0]); }}
        />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold">{me.user.name}</div>
          <div className="truncate text-sm text-muted-foreground">{me.user.email}</div>
          <div className="mt-1 flex items-center gap-2 text-xs">
            <button type="button" className="text-primary transition-colors hover:underline" onClick={() => fileRef.current?.click()} disabled={uploading}>
              {t('profile.avatarChange')}
            </button>
            {me.user.avatar && (
              <>
                <span className="text-faint">·</span>
                <button type="button" className="text-muted-foreground transition-colors hover:text-destructive" onClick={() => save.mutate({ avatar: null })}>
                  {t('profile.avatarRemove')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      <form
        className="max-w-xs space-y-1.5"
        onSubmit={(e) => { e.preventDefault(); if (dirty) save.mutate({ name: name.trim() }); }}
      >
        <label className="block text-xs text-muted-foreground">{t('profile.name')}</label>
        <Input value={name} onChange={(e) => setName(e.target.value)} />
        <SaveRow dirty={dirty} pending={save.isPending} t={t} />
      </form>
    </Card>
  );
}

function PreferencesCard() {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const [timezone, setTimezone] = useState(me.user.timezone);
  const [locale, setLocale] = useState<string>(me.user.locale);
  const [dateFormat, setDateFormat] = useState<DateFormat>(me.user.dateFormat ?? 'auto');
  const dirty = timezone.trim() !== me.user.timezone || locale !== me.user.locale
    || dateFormat !== (me.user.dateFormat ?? 'auto');

  const save = useMutation({
    mutationFn: () => api.patch('/me', { timezone: timezone.trim(), locale, dateFormat }),
    onSuccess: () => {
      // Formatting reads the mirror, so it has to move with the saved value.
      rememberDateFormat(dateFormat);
      qc.invalidateQueries({ queryKey: ['me'] });
      toast(t('common.saved'));
    },
    onError: () => toast.error(t('profile.saveFailedShort')),
  });

  return (
    <Card className="p-4">
      <SectionHeader title={t('profile.preferences')} />
      <form
        className="grid max-w-md grid-cols-1 gap-3 sm:grid-cols-2"
        onSubmit={(e) => { e.preventDefault(); if (dirty) save.mutate(); }}
      >
        <label className="space-y-1.5 text-xs text-muted-foreground">
          <span className="block">{t('profile.language')}</span>
          <Select value={locale} onChange={(e) => setLocale(e.target.value)} className="block w-full">
            <option value="uk">Українська</option>
            <option value="en">English</option>
          </Select>
        </label>
        <label className="space-y-1.5 text-xs text-muted-foreground">
          <span className="block">{t('profile.timezone')}</span>
          {/* Typed by hand, a zone had to be spelled exactly as the IANA
              database spells it, with no way to see the list or the offset. */}
          <Select value={timezone} onChange={(e) => setTimezone(e.target.value)} className="block w-full">
            {!TIME_ZONES.includes(timezone) && <option value={timezone}>{timezone}</option>}
            {TIME_ZONES.map((tz) => <option key={tz} value={tz}>{tz.replace(/_/g, ' ')} ({offsetLabel(tz)})</option>)}
          </Select>
        </label>
        <label className="space-y-1.5 text-xs text-muted-foreground sm:col-span-2">
          <span className="block">{t('profile.dateFormat')}</span>
          <Select
            value={dateFormat}
            onChange={(e) => setDateFormat(e.target.value as DateFormat)}
            className="block w-full"
          >
            {DATE_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f === 'auto' ? `${t('profile.dateFormatAuto')} – ${formatSample(f)}` : `${f} – ${formatSample(f)}`}
              </option>
            ))}
          </Select>
        </label>
        <div className="sm:col-span-2">
          <SaveRow dirty={dirty} pending={save.isPending} t={t} />
        </div>
      </form>
    </Card>
  );
}

function NotificationsSection() {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const stored = me.user.emailNotificationPrefs;
  const [prefs, setPrefs] = useState<Record<string, boolean>>(() => {
    const initial: Record<string, boolean> = {};
    for (const { type } of NOTIFICATION_TYPES) initial[type] = stored[type] ?? true;
    return initial;
  });
  const save = useMutation({
    mutationFn: (next: Record<string, boolean>) => api.patch('/me', { emailNotificationPrefs: next }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
    onError: () => toast.error(t('profile.notifSaveFailed')),
  });

  const toggle = (type: string, checked: boolean) => {
    const next = { ...prefs, [type]: checked };
    setPrefs(next);
    save.mutate(next);
  };

  return (
    <Card className="p-4">
      <SectionHeader title={t('profile.emailNotifications')} />
      <p className="-mt-2 mb-3 text-xs text-muted-foreground">{t('profile.emailNotificationsHint')}</p>
      <div className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
        {NOTIFICATION_TYPES.map(({ type, label }) => (
          <label key={type} className="flex cursor-pointer items-center justify-between gap-2 text-[13px]">
            <span>{t(label)}</span>
            <Switch checked={prefs[type] ?? true} onChange={(v) => toggle(type, v)} label={t(label)} />
          </label>
        ))}
      </div>
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
      toast(t('profile.tokenCreated'));
    },
    onError: () => toast.error(t('profile.createTokenFailed')),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/auth/tokens/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['apiTokens'] });
      toast(t('profile.tokenRevoked'));
    },
    onError: () => toast.error(t('profile.revokeFailed')),
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
            <label className="flex-1 space-y-1.5 text-xs text-muted-foreground">
              <span className="block">{t('common.name')}</span>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('profile.tokenNamePlaceholder')} />
            </label>
            <label className="flex h-8 cursor-pointer items-center gap-2 text-[13px]">
              <Checkbox checked={readOnly} onChange={(v) => setReadOnly(v)} />
              {t('profile.readOnly')}
            </label>
          </div>
          <div>
            <div className="mb-1.5 text-xs text-muted-foreground">{t('profile.scopes')} ({scopes.length} {t('profile.selected')})</div>
            <div className="grid max-h-40 grid-cols-2 gap-1.5 overflow-y-auto sm:grid-cols-3">
              {me.permissions.map((p) => (
                <label key={p} className="flex cursor-pointer items-center gap-1.5 text-xs">
                  <Checkbox checked={scopes.includes(p)} onChange={() => toggleScope(p)} />
                  <span className="truncate">{p}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={create.isPending || !name.trim() || scopes.length === 0}>{t('profile.createToken')}</Button>
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
                <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">{tok.prefix ?? '–'}</td>
                <td className="py-2 pr-3 tabular-nums">{tok.scopes?.length ?? 0}</td>
                <td className="py-2 pr-3 text-muted-foreground">{tok.lastUsedAt ? fmtDate(tok.lastUsedAt) : t('profile.never')}</td>
                <td className="py-2 text-right">
                  {!tok.revoked && (
                    <button
                      className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
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
    </Card>
  );
}

/**
 * Change my own password. The current one is required, so this stays a change
 * rather than a takeover – and the API drops every other session on success,
 * which the copy says out loud before anyone wonders why their phone signed out.
 */
function PasswordSection() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setCurrent(''); setNext(''); setConfirm(''); setError(null); };

  const change = useMutation({
    mutationFn: () => api.post('/me/password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      setOpen(false);
      reset();
      toast(t('profile.passwordChanged'));
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('profile.passwordChangeFailed')),
  });

  return (
    <Card className="p-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium">
        <KeyRound size={15} className="text-muted-foreground" />
        {t('profile.password')}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('profile.passwordHint')}</p>

      {!open ? (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>{t('profile.changePassword')}</Button>
      ) : (
        <form
          className="max-w-sm space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            if (next.length < 8) { setError(t('auth.passwordMin')); return; }
            if (next !== confirm) { setError(t('auth.passwordsDontMatch')); return; }
            change.mutate();
          }}
        >
          <label className="block space-y-1.5 text-xs text-muted-foreground">
            <span className="block">{t('profile.currentPassword')}</span>
            <Input type="password" autoComplete="current-password" autoFocus required
              value={current} onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label className="block space-y-1.5 text-xs text-muted-foreground">
            <span className="block">{t('auth.newPassword')}</span>
            <Input type="password" autoComplete="new-password" required
              value={next} onChange={(e) => setNext(e.target.value)} placeholder={t('auth.passwordMin')} />
          </label>
          <label className="block space-y-1.5 text-xs text-muted-foreground">
            <span className="block">{t('auth.confirmPassword')}</span>
            <Input type="password" autoComplete="new-password" required
              value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" size="sm" disabled={change.isPending || !current || !next}>
              {change.isPending ? <Spinner /> : t('common.save')}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => { setOpen(false); reset(); }}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      )}
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
    onError: () => toast.error(t('profile.setupFailed')),
  });
  const enable = useMutation({
    mutationFn: () => api.post('/auth/totp/enable', { code: enableCode }),
    onSuccess: () => {
      setSetup(null);
      setEnableCode('');
      qc.invalidateQueries({ queryKey: ['totp'] });
      toast(t('profile.twoFactorEnabled'));
    },
  });
  const disable = useMutation({
    mutationFn: () => api.post('/auth/totp/disable', { code: disableCode }),
    onSuccess: () => {
      setDisableCode('');
      setShowDisable(false);
      qc.invalidateQueries({ queryKey: ['totp'] });
      toast(t('profile.twoFactorDisabled'));
    },
  });

  if (totp.isLoading) return <Skeleton className="h-20 w-full" />;
  // Endpoint missing (404) or errored – hide the section gracefully.
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
        <Button size="sm" onClick={() => startSetup.mutate()} disabled={startSetup.isPending}>{t('profile.enable2fa')}</Button>
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
            <label className="space-y-1.5 text-xs text-muted-foreground">
              <span className="block">{t('profile.sixDigitCode')}</span>
              <Input
                value={enableCode}
                onChange={(e) => setEnableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                placeholder="123456"
                className="w-28 font-mono tracking-widest"
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
          <label className="space-y-1.5 text-xs text-muted-foreground">
            <span className="block">{t('profile.sixDigitCode')}</span>
            <Input
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              placeholder="123456"
              className="w-28 font-mono tracking-widest"
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
