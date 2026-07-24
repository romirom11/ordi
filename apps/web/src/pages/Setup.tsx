import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Building2, Eye, EyeOff, UserCog } from 'lucide-react';
import { api, ApiError, setSessionToken } from '../lib/api';
import { isTauri } from '../lib/desktop';
import { Button, Card, Input, Spinner, cn } from '../components/ui';
import { BrandMark } from '../components/BrandMark';
import { extendDict, useT } from '../lib/i18n';

extendDict({
  en: {
    'setup.tagline': 'CRM, projects, knowledge base, time and finance — all in one place.',
    'setup.step1Title': 'Create your workspace',
    'setup.step1Sub': 'This is the home for your whole team.',
    'setup.workspaceName': 'Workspace name',
    'setup.step2Title': 'Owner account',
    'setup.step2Sub': "You'll be the first admin. Invite others later.",
    'setup.name': 'Your name',
    'setup.email': 'Email',
    'setup.password': 'Password',
    'setup.passwordHint': 'At least 8 characters.',
    'setup.continue': 'Continue',
    'setup.back': 'Back',
    'setup.create': 'Create workspace',
    'setup.creating': 'Setting things up…',
    'setup.done': 'All set! Taking you in…',
    'setup.errWorkspace': 'Enter a workspace name.',
    'setup.errName': 'Enter your name.',
    'setup.errEmail': 'Enter a valid email.',
    'setup.errPassword': 'Password must be at least 8 characters.',
    'setup.errGeneric': 'Setup failed. Please try again.',
    'setup.showPassword': 'Show password',
    'setup.hidePassword': 'Hide password',
  },
  uk: {
    'setup.tagline': 'CRM, проєкти, база знань, час і фінанси — в одному місці.',
    'setup.step1Title': 'Створіть робочий простір',
    'setup.step1Sub': 'Це домівка для всієї вашої команди.',
    'setup.workspaceName': 'Назва робочого простору',
    'setup.step2Title': 'Обліковий запис власника',
    'setup.step2Sub': 'Ви станете першим адміністратором. Інших запросите пізніше.',
    'setup.name': "Ваше ім'я",
    'setup.email': 'Електронна пошта',
    'setup.password': 'Пароль',
    'setup.passwordHint': 'Мінімум 8 символів.',
    'setup.continue': 'Далі',
    'setup.back': 'Назад',
    'setup.create': 'Створити простір',
    'setup.creating': 'Готуємо все…',
    'setup.done': 'Готово! Заходимо…',
    'setup.errWorkspace': 'Введіть назву робочого простору.',
    'setup.errName': "Введіть ваше ім'я.",
    'setup.errEmail': 'Введіть коректну електронну пошту.',
    'setup.errPassword': 'Пароль має містити щонайменше 8 символів.',
    'setup.errGeneric': 'Не вдалося налаштувати. Спробуйте ще раз.',
    'setup.showPassword': 'Показати пароль',
    'setup.hidePassword': 'Приховати пароль',
  },
});

const SLIDE = 'var(--ease-smooth-out)';

interface SetupStatus { needsSetup: boolean }
interface SetupResult { ok: boolean; sessionToken?: string }

/** A wizard panel: absolutely stacked so steps slide side-by-side (transitions.dev №8). */
function StepPanel({ index, current, children }: { index: number; current: number; children: React.ReactNode }) {
  const active = index === current;
  return (
    <div
      aria-hidden={!active}
      className="absolute inset-0"
      style={{
        opacity: active ? 1 : 0,
        transform: active ? 'translateX(0)' : `translateX(${index < current ? -8 : 8}px)`,
        filter: active ? 'blur(0)' : 'blur(3px)',
        pointerEvents: active ? 'auto' : 'none',
        transition: `opacity 250ms ${SLIDE}, transform 250ms ${SLIDE}, filter 250ms ${SLIDE}`,
      }}
    >
      {children}
    </div>
  );
}

function ProgressDots({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            'h-1.5 rounded-full transition-all duration-[250ms] ease-smooth-out',
            i === step ? 'w-5 bg-primary' : i < step ? 'w-1.5 bg-primary/50' : 'w-1.5 bg-border-strong',
          )}
        />
      ))}
    </div>
  );
}

function SuccessCheck() {
  return (
    <span className="anim-pop-in inline-block" aria-hidden>
      <svg width="72" height="72" viewBox="0 0 52 52" fill="none" style={{ display: 'block', overflow: 'visible' }}>
        <circle cx="26" cy="26" r="24" fill="hsl(var(--primary) / 0.10)" stroke="hsl(var(--primary))" strokeWidth="2" />
        <path
          d="M15 27 l7 7 l15 -16"
          stroke="hsl(var(--primary))"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            strokeDasharray: 44,
            strokeDashoffset: 44,
            animation: `check-draw var(--duration-very-slow) ${SLIDE} var(--duration-micro) both`,
          }}
        />
      </svg>
    </span>
  );
}

export function SetupPage() {
  const t = useT();
  const [step, setStep] = useState(0); // 0 = workspace, 1 = owner, 2 = submitting/success
  const [workspaceName, setWorkspaceName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const wsRef = useRef<HTMLInputElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const status = useQuery<SetupStatus>({
    queryKey: ['setup', 'status'],
    queryFn: () => api.get<SetupStatus>('/setup/status'),
    staleTime: Infinity,
    retry: false,
  });

  // Already set up → this page has no purpose; send to login.
  useEffect(() => {
    if (status.data && !status.data.needsSetup) {
      window.history.replaceState({}, '', '/login');
      window.location.reload();
    }
  }, [status.data]);

  // Focus the first field of the active step as it appears.
  useEffect(() => {
    if (step === 0) wsRef.current?.focus();
    else if (step === 1) nameRef.current?.focus();
  }, [step]);

  function fail(message: string) {
    setError(message);
    setErrorKey((k) => k + 1);
  }

  function goToOwner() {
    if (!workspaceName.trim()) { fail(t('setup.errWorkspace')); return; }
    setError(null);
    setStep(1);
  }

  async function submit() {
    if (!name.trim()) { fail(t('setup.errName')); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { fail(t('setup.errEmail')); return; }
    if (password.length < 8) { fail(t('setup.errPassword')); return; }
    setError(null);
    setSubmitting(true);
    setStep(2);
    try {
      const res = await api.post<SetupResult>('/setup', {
        workspaceName: workspaceName.trim(),
        name: name.trim(),
        email: email.trim().toLowerCase(),
        password,
      });
      // Desktop (tauri:// origin) cannot use same-site cookies — keep the token.
      if (isTauri && res.sessionToken) setSessionToken(res.sessionToken);
      setSuccess(true);
      window.setTimeout(() => { window.location.href = '/'; }, 900);
    } catch (err) {
      setSubmitting(false);
      setStep(1);
      if (err instanceof ApiError && err.status === 403) {
        window.history.replaceState({}, '', '/login');
        window.location.reload();
        return;
      }
      fail(err instanceof ApiError ? err.message : t('setup.errGeneric'));
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (step === 0) goToOwner();
    else if (step === 1) void submit();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') { e.preventDefault(); onSubmit(e); }
  }

  if (status.isLoading) {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-background px-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(640px circle at 50% 32%, hsl(var(--primary) / 0.08), transparent 70%)' }}
      />

      <Card className="anim-pop-in relative w-full max-w-sm p-7 shadow-pop">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <BrandMark size={40} />
          <ProgressDots step={step} total={3} />
        </div>

        <form onSubmit={onSubmit}>
          <div className="relative" style={{ minHeight: 302 }}>
            {/* Step 1 — workspace */}
            <StepPanel index={0} current={step}>
              <div className="space-y-4">
                <div className="text-center">
                  <h1 className="text-base font-semibold">{t('setup.step1Title')}</h1>
                  <p className="mt-1 text-[13px] text-muted-foreground">{t('setup.tagline')}</p>
                </div>
                <div className="space-y-1.5">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Building2 size={12} /> {t('setup.workspaceName')}
                  </label>
                  <Input
                    ref={wsRef}
                    disabled={step !== 0 || submitting}
                    value={workspaceName}
                    onChange={(e) => setWorkspaceName(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Acme Agency"
                  />
                </div>
              </div>
            </StepPanel>

            {/* Step 2 — owner account */}
            <StepPanel index={1} current={step}>
              <div className="space-y-3.5">
                <div className="text-center">
                  <h1 className="text-base font-semibold">{t('setup.step2Title')}</h1>
                  <p className="mt-1 text-[13px] text-muted-foreground">{t('setup.step2Sub')}</p>
                </div>
                <div className="space-y-1.5">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <UserCog size={12} /> {t('setup.name')}
                  </label>
                  <Input
                    ref={nameRef}
                    disabled={step !== 1 || submitting}
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="Jane Doe"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">{t('setup.email')}</label>
                  <Input
                    type="email"
                    disabled={step !== 1 || submitting}
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder="you@agency.com"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">{t('setup.password')}</label>
                  <div className="relative">
                    <Input
                      type={showPassword ? 'text' : 'password'}
                      disabled={step !== 1 || submitting}
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={onKeyDown}
                      placeholder="••••••••"
                      className="pr-9"
                    />
                    <button
                      type="button"
                      tabIndex={step === 1 ? 0 : -1}
                      aria-label={showPassword ? t('setup.hidePassword') : t('setup.showPassword')}
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-1.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded text-faint transition-colors duration-150 hover:text-foreground"
                    >
                      {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <p className="text-xs text-faint">{t('setup.passwordHint')}</p>
                </div>
              </div>
            </StepPanel>

            {/* Step 3 — submitting / success */}
            <StepPanel index={2} current={step}>
              <div className="flex h-full min-h-[302px] flex-col items-center justify-center gap-4 text-center">
                {success ? (
                  <>
                    <SuccessCheck />
                    <p className="anim-fade-in text-sm font-medium">{t('setup.done')}</p>
                  </>
                ) : (
                  <>
                    <Spinner className="h-6 w-6" />
                    <p className="text-sm text-muted-foreground">{t('setup.creating')}</p>
                  </>
                )}
              </div>
            </StepPanel>
          </div>

          {error && (
            <p
              key={errorKey}
              style={{ animation: `shake-x 300ms ${SLIDE}` }}
              className="mt-3 text-center text-sm text-destructive"
            >
              {error}
            </p>
          )}

          {step < 2 && (
            <div className="mt-6 flex items-center gap-2">
              {step === 1 && (
                <Button type="button" variant="outline" disabled={submitting} onClick={() => { setError(null); setStep(0); }}>
                  <ArrowLeft size={14} /> {t('setup.back')}
                </Button>
              )}
              <Button type="submit" disabled={submitting} className="flex-1">
                {step === 0 ? (
                  <>{t('setup.continue')} <ArrowRight size={14} /></>
                ) : (
                  t('setup.create')
                )}
              </Button>
            </div>
          )}
        </form>
      </Card>
    </div>
  );
}
