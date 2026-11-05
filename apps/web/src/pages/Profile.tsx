import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useMe } from '../lib/auth';
import { Button, Input, Select, Card, Badge, Switch, Avatar, PageBody, Breadcrumbs, Skeleton, Spinner, cn } from '../components/ui';
import { toast } from '../components/overlays';
import { Bell, Bot, Camera, Check, Copy, IdCard, KeyRound, ShieldCheck, UserRound } from 'lucide-react';
import { extendDict, useT } from '../lib/i18n';
import { Link, useNavigate } from '../lib/router';
import { usePageTitle } from '../lib/tabs';
import { McpPanel } from '../components/settings/McpPanel';
import { SectionHead } from '../components/settings/primitives';
import { DATE_FORMATS, TIME_ZONES, formatSample, offsetLabel, rememberDateFormat, type DateFormat } from '../lib/dates';
import { downscaleImage } from '../components/settings/image';
import { usePersistedState, oneOfPref } from '../lib/prefs';

extendDict({
  en: {
    'profile.profileInfo': 'Profile',
    'profile.preferences': 'Preferences',
    'profile.security': 'Security',
    'profile.saveFailedShort': 'Could not save changes.',
    'profile.notifSaveFailed': 'Could not update notification preference.',
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
    'profile.myCard': 'My HR card',
    'profile.myCardHint': 'Contacts, the questionnaire and leave live on your card.',
    'profile.notifications': 'Notifications',
    'profile.notificationsDesc': 'What reaches you by email, and the sound on this device.',
    'profile.securityDesc': 'Your password and the second factor for signing in.',
    'profile.mcp': 'MCP & API',
  },
  uk: {
    'profile.profileInfo': 'Профіль',
    'profile.preferences': 'Налаштування',
    'profile.security': 'Безпека',
    'profile.saveFailedShort': 'Не вдалося зберегти зміни.',
    'profile.notifSaveFailed': 'Не вдалося оновити налаштування сповіщень.',
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
    'profile.myCard': 'Моя HR-картка',
    'profile.myCardHint': 'Контакти, анкета і відпустки живуть на вашій картці.',
    'profile.notifications': 'Сповіщення',
    'profile.notificationsDesc': 'Що приходить вам на пошту і звук на цьому пристрої.',
    'profile.securityDesc': 'Пароль і другий фактор для входу.',
    'profile.mcp': 'MCP і API',
  },
});

interface TotpState { enabled: boolean }
interface TotpSetup { secret: string; otpauthUrl: string }

// `label` is an i18n dictionary key, translated at render time.
const NOTIFICATION_TYPES: { type: string; label: string }[] = [
  { type: 'task.assigned', label: 'profile.notifTaskAssigned' },
  { type: 'comment.mentioned', label: 'profile.notifMentioned' },
  { type: 'comment.created', label: 'profile.notifCommented' },
  { type: 'page.mentioned', label: 'profile.notifPageMentioned' },
  { type: 'task.status_changed', label: 'profile.notifTaskStatus' },
  { type: 'git.pr_merged', label: 'profile.notifPrMerged' },
  { type: 'invoice.paid', label: 'profile.notifInvoicePaid' },
  { type: 'payment.recorded', label: 'profile.notifPaymentRecorded' },
  { type: 'quote.accepted', label: 'profile.notifQuoteAccepted' },
  { type: 'quote.declined', label: 'profile.notifQuoteDeclined' },
  { type: 'leave.requested', label: 'profile.notifLeaveRequested' },
  { type: 'leave.decided', label: 'profile.notifLeaveDecided' },
  { type: 'sales.work_digest', label: 'profile.notifSalesDigest' },
];

/**
 * Personal settings, one section at a time. It used to be a single long
 * column (profile, preferences, thirteen notification switches, password,
 * tokens, 2FA) – the thing you came for was always a scroll away. The nav
 * mirrors Settings, so both pages read the same; this one is only ever about
 * the signed-in person, which is why personal MCP/API access lives here.
 */
const SECTIONS = [
  { id: 'account', label: 'profile.profileInfo', icon: UserRound },
  { id: 'notifications', label: 'profile.notifications', icon: Bell },
  { id: 'security', label: 'profile.security', icon: ShieldCheck },
  { id: 'mcp', label: 'profile.mcp', icon: Bot },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

/** The default section keeps the bare /profile url (Cmd/Ctrl+, lands there). */
const sectionPath = (id: SectionId) => (id === 'account' ? '/profile' : `/profile/${id}`);

export function ProfilePage({ section }: { section?: string }) {
  const t = useT();
  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  usePageTitle(active.id === 'account' ? t('profile.title') : `${t('profile.title')} · ${t(active.label)}`);

  return (
    <div className="flex flex-col">
      <div className="flex h-11 shrink-0 items-center border-b border-border px-4">
        <Breadcrumbs items={[{ label: t('profile.title'), to: '/profile' }, ...(active.id === 'account' ? [] : [{ label: t(active.label) }])]} />
      </div>
      <div className="flex min-h-[calc(100vh-53px)] flex-col md:flex-row">
        <aside className="shrink-0 border-b border-border p-2 md:w-52 md:border-b-0 md:border-r md:p-3">
          <nav className="flex gap-1 overflow-x-auto md:flex-col md:gap-0.5 md:overflow-visible">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const isActive = s.id === active.id;
              return (
                <Link
                  key={s.id}
                  to={sectionPath(s.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors duration-150',
                    isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  <Icon size={15} />
                  <span className="truncate">{t(s.label)}</span>
                </Link>
              );
            })}
          </nav>
        </aside>
        <div className="min-w-0 flex-1">
          <PageBody key={active.id} width="default" className="anim-fade-in">
            {active.id === 'account' && (
              <div className="space-y-4">
                {/* Identity lives on the HR card (ORD-19): the questionnaire and
                  * leave moved to the person's own employee page; the profile
                  * keeps account things and links over. */}
                <ProfileInfoCard />
                <PreferencesCard />
              </div>
            )}
            {active.id === 'notifications' && (
              <>
                <SectionHead title={t('profile.notifications')} desc={t('profile.notificationsDesc')} />
                <NotificationsSection />
              </>
            )}
            {active.id === 'security' && (
              <>
                <SectionHead title={t('profile.security')} desc={t('profile.securityDesc')} />
                <div className="space-y-4">
                  <PasswordSection />
                  <TotpSection />
                </div>
              </>
            )}
            {active.id === 'mcp' && <McpPanel />}
          </PageBody>
        </div>
      </div>
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
  const navigate = useNavigate();
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
      {me.employee && (
        <button
          type="button"
          onClick={() => navigate(`/people/${me.employee!.id}`)}
          className="mt-4 flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-[13px] transition-colors duration-150 hover:border-border-strong hover:bg-muted/40"
        >
          <IdCard size={15} className="shrink-0 text-faint" />
          <span className="font-medium">{t('profile.myCard')}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{t('profile.myCardHint')}</span>
        </button>
      )}
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
  const [sound, setSound] = usePersistedState('ordi:notificationSound', 'on', oneOfPref(['on', 'off'], 'on'));
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
      <div className="mb-4 flex items-center justify-between gap-3 text-sm">
        <span>{t('profile.notificationSound', 'Notification sound on this device')}</span>
        <Switch checked={sound === 'on'} onChange={(on) => setSound(on ? 'on' : 'off')} label={t('profile.notificationSound', 'Notification sound on this device')} />
      </div>
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
