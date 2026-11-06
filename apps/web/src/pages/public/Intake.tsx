/**
 * The public intake form (PRD §8.6): rendered from the project's form config,
 * standalone at /intake/:token or inside another site's iframe with
 * `?embed=1` (see the API's embed loader, domains/public/intake-embed.ts).
 *
 * Embedded, the page drops its own backdrop and branding row, takes its
 * theme from `?theme=` (light by default – most host sites are), and tells
 * the parent page its height and when a request went through.
 *
 * Prefill arrives in the URL fragment (`#requesterEmail=…&_page=…&_lock=1`),
 * put there by the loader or by hand on a link: field values matched to keys
 * loosely, the embedding page's address, and whether prefilled fields are
 * read-only. Hidden fields are filled from it and never drawn.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Paperclip, X } from 'lucide-react';
import {
  BLOCKED_FILE_EXTENSIONS, defaultIntakeFormConfig, intakePrefillMatchKey, validateIntakeSubmission,
  type IntakeField, type IntakeFieldError,
} from '@ordi/shared';
import { api, ApiError } from '../../lib/api';
import { accentVars } from '../../lib/accent';
import { Button, Input, Textarea, Card, Select, Skeleton, cn } from '../../components/ui';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'intakeForm.heading': 'Submit a request',
    'intakeForm.forProject': 'For {project}',
    'intakeForm.name': 'Your name',
    'intakeForm.email': 'Email',
    'intakeForm.title': 'Subject',
    'intakeForm.description': 'Details',
    'intakeForm.choose': 'Choose…',
    'intakeForm.submit': 'Send request',
    'intakeForm.sent': 'Request sent',
    'intakeForm.sentHint': 'Thank you – the team will review it and get back to you.',
    'intakeForm.another': 'Send another request',
    'intakeForm.attach': 'Attach files',
    'intakeForm.attachHint': 'Up to {n} files, {mb} MB each',
    'intakeForm.err.required': 'This field is required',
    'intakeForm.err.invalid': 'Check this value',
    'intakeForm.err.too_long': 'This is too long',
    'intakeForm.err.tooMany': 'Up to {n} files',
    'intakeForm.err.tooLarge': '{name} is larger than {mb} MB',
    'intakeForm.err.blocked': 'Files like {name} are not accepted',
    'intakeForm.err.files': 'These files could not be accepted',
    'intakeForm.err.rate': 'Too many requests from your network – try again in a few minutes.',
    'intakeForm.err.generic': 'Something went wrong – try again.',
    'intakeForm.unavailable': 'This form is unavailable',
  },
  uk: {
    'intakeForm.heading': 'Надіслати запит',
    'intakeForm.forProject': 'Для {project}',
    'intakeForm.name': 'Ваше ім’я',
    'intakeForm.email': 'Email',
    'intakeForm.title': 'Тема',
    'intakeForm.description': 'Деталі',
    'intakeForm.choose': 'Оберіть…',
    'intakeForm.submit': 'Надіслати запит',
    'intakeForm.sent': 'Запит надіслано',
    'intakeForm.sentHint': 'Дякуємо! Команда розгляне його та зв’яжеться з вами.',
    'intakeForm.another': 'Надіслати ще один запит',
    'intakeForm.attach': 'Додати файли',
    'intakeForm.attachHint': 'До {n} файлів, до {mb} МБ кожен',
    'intakeForm.err.required': 'Обов’язкове поле',
    'intakeForm.err.invalid': 'Перевірте значення',
    'intakeForm.err.too_long': 'Задовге значення',
    'intakeForm.err.tooMany': 'Не більше {n} файлів',
    'intakeForm.err.tooLarge': '{name} більший за {mb} МБ',
    'intakeForm.err.blocked': 'Файли на кшталт {name} не приймаються',
    'intakeForm.err.files': 'Ці файли не вдалося прийняти',
    'intakeForm.err.rate': 'Забагато запитів з вашої мережі – спробуйте за кілька хвилин.',
    'intakeForm.err.generic': 'Щось пішло не так – спробуйте ще раз.',
    'intakeForm.unavailable': 'Ця форма недоступна',
  },
});

/** A field as the public endpoint hands it out (hidden ones never leave the server). */
type PublicField = Omit<IntakeField, 'hidden'>;

export interface PublicIntakeForm {
  heading: string;
  intro: string;
  submitLabel: string;
  successMessage: string;
  accentColor: string | null;
  fields: PublicField[];
  attachments: { maxFiles: number; maxBytes: number } | null;
}

interface IntakeInfo {
  projectName: string;
  workspaceName: string | null;
  logoUrl: string | null;
  form: PublicIntakeForm;
}

const BUILTIN_LABEL: Record<string, string> = {
  requesterName: 'intakeForm.name',
  requesterEmail: 'intakeForm.email',
  title: 'intakeForm.title',
  description: 'intakeForm.description',
};

function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ''));
}

interface EmbedOptions { embed: boolean; theme: 'light' | 'dark' | null }

function readEmbedOptions(): EmbedOptions {
  const params = new URLSearchParams(window.location.search);
  const embed = params.get('embed') === '1';
  const raw = params.get('theme');
  let theme: 'light' | 'dark' | null = raw === 'light' || raw === 'dark' ? raw : null;
  if (raw === 'auto') theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  if (embed && !theme) theme = 'light';
  return { embed, theme };
}

/** What the site passed in the fragment. */
export interface IntakePrefill {
  /** Values by loose key (see intakePrefillMatchKey). */
  values: Record<string, string>;
  /** The page the form sits on, or was linked from. */
  page: string | null;
  /** Prefilled visible fields are read-only. */
  lock: boolean;
}

function readPrefill(): IntakePrefill {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const values: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!key.startsWith('_') && value.trim()) values[intakePrefillMatchKey(key)] = value;
  }
  return {
    values,
    page: params.get('_page') || document.referrer || null,
    lock: params.get('_lock') === '1',
  };
}

/** The value a field starts with, if the site passed one it can take. */
function prefilledValue(field: PublicField, prefill: IntakePrefill | null | undefined): string | boolean | undefined {
  if (!prefill) return undefined;
  if (field.type === 'hidden' && field.source === 'page') return prefill.page ?? undefined;
  const raw = prefill.values[intakePrefillMatchKey(field.key)];
  if (raw === undefined) return undefined;
  if (field.type === 'checkbox') return ['true', '1', 'on', 'yes'].includes(raw.toLowerCase()) || undefined;
  if (field.type === 'select') return field.options.includes(raw) ? raw : undefined;
  return raw;
}

/**
 * The embedding page's address right now – a single-page site may have
 * navigated since the form loaded. Null when not framed by the loader or it
 * does not answer in time.
 */
function askParentPage(): Promise<string | null> {
  if (window.parent === window) return Promise.resolve(null);
  const id = Math.random().toString(36).slice(2);
  return new Promise((resolve) => {
    const done = (page: string | null) => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve(page);
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; type?: string; id?: string; page?: unknown } | null;
      if (event.source !== window.parent || data?.source !== 'ordi-intake-host' || data.type !== 'context' || data.id !== id) return;
      done(typeof data.page === 'string' ? data.page : null);
    };
    const timer = setTimeout(() => done(null), 400);
    window.addEventListener('message', onMessage);
    notifyParent({ type: 'context-request', id });
  });
}

/** Tell the embedding page something; a no-op when the page is not framed. */
function notifyParent(message: Record<string, unknown>) {
  if (window.parent === window) return;
  window.parent.postMessage({ source: 'ordi-intake', ...message }, '*');
}

export function IntakeFormPage({ token }: { token: string }) {
  const t = useT();
  const options = useMemo(readEmbedOptions, []);
  const prefill = useMemo(readPrefill, []);
  const info = useQuery({ queryKey: ['intake', token], queryFn: () => api.get<IntakeInfo>(`/intake/${token}`), retry: false });

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (options.theme) root.dataset.theme = options.theme;
    if (!options.embed) return;
    // The host page shows through: no glass backdrop, no page background.
    delete root.dataset.style;
    for (const el of [root, document.body, document.getElementById('root')]) {
      if (!el) continue;
      el.style.background = 'transparent';
      el.style.height = 'auto';
    }
  }, [options]);

  if (info.isLoading) return <Frame embed={options.embed}><Skeleton className="h-72 w-full" /></Frame>;
  if (info.isError || !info.data) {
    return (
      <Frame embed={options.embed}>
        <Card className="p-10 text-center text-sm text-muted-foreground">{t('intakeForm.unavailable')}</Card>
      </Frame>
    );
  }

  return (
    <Frame embed={options.embed} accent={info.data.form.accentColor}>
      {!options.embed && (info.data.logoUrl || info.data.workspaceName) && (
        <div className="mb-4 flex items-center gap-2.5 text-sm font-medium text-muted-foreground">
          {info.data.logoUrl && <img src={info.data.logoUrl} alt="" className="h-7 w-auto max-w-[140px] object-contain" />}
          {info.data.workspaceName && <span>{info.data.workspaceName}</span>}
        </div>
      )}
      <IntakeForm token={token} projectName={info.data.projectName} form={info.data.form} embed={options.embed} prefill={prefill} />
    </Frame>
  );
}

/**
 * The form itself. Also rendered by the settings editor as a live preview –
 * `token` null there, and submitting is a no-op.
 */
export function IntakeForm({ token, projectName, form, embed = false, prefill }: {
  token: string | null;
  projectName: string;
  form: PublicIntakeForm;
  embed?: boolean;
  prefill?: IntakePrefill | null;
}) {
  const t = useT();
  const initial = useMemo(() => {
    const out: Record<string, string | boolean> = {};
    for (const field of form.fields) {
      const value = prefilledValue(field, prefill);
      if (value !== undefined) out[field.key] = value;
    }
    return out;
  }, [form.fields, prefill]);
  const locked = (field: PublicField) => Boolean(prefill?.lock && field.type !== 'hidden' && initial[field.key] !== undefined);
  const [values, setValues] = useState<Record<string, string | boolean>>(initial);
  const [files, setFiles] = useState<File[]>([]);
  const [honeypot, setHoneypot] = useState('');
  const [errors, setErrors] = useState<Record<string, IntakeFieldError>>({});
  const [fileError, setFileError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const maxMb = form.attachments ? Math.floor(form.attachments.maxBytes / (1024 * 1024)) : 0;

  const submit = useMutation({
    mutationFn: async () => {
      if (!token) return;
      const sent = { ...values };
      if (form.fields.some((f) => f.type === 'hidden' && f.source === 'page')) {
        const page = await askParentPage();
        if (page) for (const f of form.fields) if (f.type === 'hidden' && f.source === 'page') sent[f.key] = page;
      }
      const payload = { values: sent, honeypot };
      if (files.length) {
        const body = new FormData();
        body.append('payload', JSON.stringify(payload));
        for (const file of files) body.append('files', file);
        await api.postForm(`/intake/${token}`, body);
      } else {
        await api.post(`/intake/${token}`, payload);
      }
    },
    onSuccess: () => notifyParent({ type: 'submitted' }),
    onError: (cause) => {
      const details = cause instanceof ApiError ? (cause.details as { fields?: Record<string, IntakeFieldError>; files?: string } | undefined) : undefined;
      if (details?.fields) setErrors(details.fields);
      if (details?.files) setFileError(t('intakeForm.err.files'));
      if (cause instanceof ApiError && cause.code === 'rate_limited') setFormError(t('intakeForm.err.rate'));
      else if (!details?.fields && !details?.files) setFormError(t('intakeForm.err.generic'));
    },
  });

  const labelOf = (field: PublicField) => field.label || (BUILTIN_LABEL[field.key] ? t(BUILTIN_LABEL[field.key]!) : field.key);

  const setValue = (key: string, value: string | boolean) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors(({ [key]: _gone, ...rest }) => rest);
  };

  const addFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!form.attachments) return;
    setFileError(null);
    const next = [...files];
    for (const file of picked) {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      if (BLOCKED_FILE_EXTENSIONS.includes(ext)) { setFileError(fill(t('intakeForm.err.blocked'), { name: file.name })); continue; }
      if (file.size > form.attachments.maxBytes) { setFileError(fill(t('intakeForm.err.tooLarge'), { name: file.name, mb: maxMb })); continue; }
      if (next.length >= form.attachments.maxFiles) { setFileError(fill(t('intakeForm.err.tooMany'), { n: form.attachments.maxFiles })); break; }
      next.push(file);
    }
    setFiles(next);
  };

  const onSubmit = () => {
    setFormError(null);
    // The same rules the server applies, so most mistakes never leave the page.
    const check = validateIntakeSubmission(
      { ...defaultIntakeFormConfig(), fields: form.fields.map((f) => ({ ...f, hidden: false })) },
      values,
    );
    if (!check.ok) { setErrors(check.errors); return; }
    submit.mutate();
  };

  const reset = () => {
    setValues(initial); setFiles([]); setErrors({}); setFileError(null); setFormError(null);
    submit.reset();
  };

  if (submit.isSuccess) {
    return (
      <Card className="p-10 text-center">
        <h1 className="text-xl font-semibold">{t('intakeForm.sent')}</h1>
        <p className="mx-auto mt-2 max-w-md whitespace-pre-line text-sm text-muted-foreground">
          {form.successMessage || t('intakeForm.sentHint')}
        </p>
        <Button variant="outline" size="sm" className="mt-5" onClick={reset}>{t('intakeForm.another')}</Button>
      </Card>
    );
  }

  return (
    <Card className={cn('p-6 sm:p-8', embed && 'shadow-none')}>
      <h1 className="text-xl font-semibold">{form.heading || t('intakeForm.heading')}</h1>
      {!form.heading && <p className="mt-1 text-sm text-muted-foreground">{fill(t('intakeForm.forProject'), { project: projectName })}</p>}
      {form.intro && <p className="mt-3 whitespace-pre-line text-sm text-muted-foreground">{form.intro}</p>}
      <form
        className="mt-6 space-y-4"
        noValidate
        onSubmit={(event) => { event.preventDefault(); onSubmit(); }}
      >
        {form.fields.filter((field) => field.type !== 'hidden').map((field) => (
          <FieldControl
            key={field.key}
            field={field}
            label={labelOf(field)}
            value={values[field.key]}
            readOnly={locked(field)}
            error={errors[field.key] ? t(`intakeForm.err.${errors[field.key]}`) : null}
            chooseLabel={t('intakeForm.choose')}
            onChange={(value) => setValue(field.key, value)}
          />
        ))}

        {form.attachments && (
          <div className="space-y-2">
            <input ref={fileInput} type="file" multiple className="hidden" onChange={addFiles} />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={files.length >= form.attachments.maxFiles}
                onClick={() => fileInput.current?.click()}
              >
                <Paperclip size={13} /> {t('intakeForm.attach')}
              </Button>
              <span className="text-xs text-faint">{fill(t('intakeForm.attachHint'), { n: form.attachments.maxFiles, mb: maxMb })}</span>
            </div>
            {files.length > 0 && (
              <ul className="flex flex-wrap gap-1.5">
                {files.map((file, index) => (
                  <li key={`${file.name}-${index}`} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/40 py-1 pl-2.5 pr-1 text-xs text-muted-foreground">
                    <span className="truncate">{file.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      className="rounded-full p-0.5 hover:bg-muted hover:text-foreground"
                      onClick={() => setFiles((prev) => prev.filter((_, i) => i !== index))}
                    >
                      <X size={11} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {fileError && <p className="text-xs text-destructive">{fileError}</p>}
          </div>
        )}

        {/* Honeypot: off-screen for people, irresistible to form-filling bots. */}
        <input
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={honeypot}
          onChange={(event) => setHoneypot(event.target.value)}
          aria-hidden="true"
          className="absolute left-[-9999px] h-0 w-0 opacity-0"
        />
        {formError && <p className="text-sm text-destructive">{formError}</p>}
        <Button type="submit" disabled={submit.isPending}>{form.submitLabel || t('intakeForm.submit')}</Button>
      </form>
    </Card>
  );
}

function FieldControl({ field, label, value, readOnly = false, error, chooseLabel, onChange }: {
  field: PublicField;
  label: string;
  value: string | boolean | undefined;
  /** Prefilled by the site and locked: shown, not editable. */
  readOnly?: boolean;
  error: string | null;
  chooseLabel: string;
  onChange: (value: string | boolean) => void;
}) {
  const id = `intake-${field.key}`;
  const describedBy = error ? `${id}-error` : field.help ? `${id}-help` : undefined;
  const common = {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
    className: cn('mt-1', error && '!border-destructive', readOnly && 'bg-muted/50 text-muted-foreground'),
  };
  const text = typeof value === 'string' ? value : '';

  if (field.type === 'checkbox') {
    return (
      <div>
        <label className="flex items-start gap-2 text-[13px]">
          <input
            id={id}
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-[hsl(var(--action))]"
            checked={value === true}
            disabled={readOnly}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{label}{field.required && <Required />}</span>
        </label>
        <FieldNote id={id} help={field.help} error={error} />
      </div>
    );
  }

  let control: ReactNode;
  if (field.type === 'textarea') {
    control = <Textarea {...common} readOnly={readOnly} rows={5} placeholder={field.placeholder} value={text} onChange={(event) => onChange(event.target.value)} />;
  } else if (field.type === 'select') {
    control = (
      <Select {...common} disabled={readOnly} className={cn(common.className, 'w-full')} value={text} onChange={(event) => onChange(event.target.value)}>
        <option value="">{field.placeholder || chooseLabel}</option>
        {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </Select>
    );
  } else {
    const type = field.type === 'phone' ? 'tel' : field.type;
    const autoComplete = field.key === 'requesterName' ? 'name' : field.type === 'email' ? 'email' : field.type === 'phone' ? 'tel' : field.type === 'url' ? 'url' : undefined;
    control = (
      <Input
        {...common}
        type={type}
        readOnly={readOnly}
        inputMode={field.type === 'number' ? 'decimal' : undefined}
        autoComplete={autoComplete}
        placeholder={field.placeholder}
        value={text}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-muted-foreground">
        {label}{field.required && <Required />}
      </label>
      {control}
      <FieldNote id={id} help={field.help} error={error} />
    </div>
  );
}

function Required() {
  return <span aria-hidden="true" className="ml-0.5 text-destructive">*</span>;
}

function FieldNote({ id, help, error }: { id: string; help: string; error: string | null }) {
  if (error) return <p id={`${id}-error`} className="mt-1 text-xs text-destructive">{error}</p>;
  if (help) return <p id={`${id}-help`} className="mt-1 text-xs text-faint">{help}</p>;
  return null;
}

/**
 * The page around the form. Embedded it is only a padded box whose height
 * the parent page is told about, so the iframe fits without a scrollbar.
 */
function Frame({ children, embed, accent }: { children: ReactNode; embed: boolean; accent?: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!embed || !ref.current) return;
    const el = ref.current;
    const report = () => notifyParent({ type: 'resize', height: el.getBoundingClientRect().height });
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [embed]);

  if (embed) {
    return <div ref={ref} className="p-1" style={accentVars(accent)}>{children}</div>;
  }
  return (
    <div className="min-h-screen bg-background px-4 py-10" style={accentVars(accent)}>
      <div className="mx-auto max-w-2xl">{children}</div>
    </div>
  );
}
