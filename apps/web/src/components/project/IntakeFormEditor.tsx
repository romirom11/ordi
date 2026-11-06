/**
 * Intake form settings beyond the on/off switch: the form editor (texts,
 * accent, fields, files, receipt) with a live preview, and the embed dialog
 * with the snippets to put the form on another site.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Copy, EyeOff, Plus, Trash2 } from 'lucide-react';
import {
  INTAKE_FIELD_TYPES, INTAKE_MAX_ATTACHMENTS, INTAKE_MAX_FIELDS, MAX_UPLOAD_BYTES, intakeFormConfigSchema, intakePrefillAttribute,
  isBuiltinIntakeKey, type IntakeField, type IntakeFieldType, type IntakeFormConfig, type IntakeHiddenSource,
} from '@ordi/shared';
import { api, ApiError } from '../../lib/api';
import { accentVars } from '../../lib/accent';
import { Badge, Button, IconButton, Input, Select, Spinner, Switch, Textarea, cn } from '../ui';
import { Dialog, toast } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';
import { IntakeForm, type PublicIntakeForm } from '../../pages/public/Intake';
import { CodeSnippet } from '../richtext/CodeSnippet';

extendDict({
  en: {
    'intakeEditor.title': 'Customize the form',
    'intakeEditor.texts': 'Texts',
    'intakeEditor.heading': 'Heading',
    'intakeEditor.intro': 'Introduction',
    'intakeEditor.introPh': 'What to include, how soon you reply…',
    'intakeEditor.submitLabel': 'Button label',
    'intakeEditor.success': 'Message after sending',
    'intakeEditor.accent': 'Accent colour',
    'intakeEditor.accentDefault': 'Default',
    'intakeEditor.fields': 'Fields',
    'intakeEditor.addField': 'Add field',
    'intakeEditor.fieldLimit': 'A form holds up to {n} fields.',
    'intakeEditor.label': 'Label',
    'intakeEditor.placeholder': 'Placeholder',
    'intakeEditor.help': 'Hint under the field',
    'intakeEditor.type': 'Type',
    'intakeEditor.options': 'Choices, one per line',
    'intakeEditor.required': 'Required',
    'intakeEditor.shown': 'Shown on the form',
    'intakeEditor.hidden': 'Hidden',
    'intakeEditor.builtin': 'Built in',
    'intakeEditor.titleNote': 'Becomes the task title, so it is always shown and required.',
    'intakeEditor.descriptionNote': 'Becomes the task description.',
    'intakeEditor.emailNote': 'Receipts and decision emails go to this address. Hide it and nobody is emailed.',
    'intakeEditor.customNote': 'The answer is shown on the request and added to the task description.',
    'intakeEditor.moveUp': 'Move up',
    'intakeEditor.moveDown': 'Move down',
    'intakeEditor.remove': 'Remove field',
    'intakeEditor.newField': 'New field',
    'intakeEditor.extras': 'Files and emails',
    'intakeEditor.files': 'Let people attach files',
    'intakeEditor.filesHint': 'Up to {mb} MB each. Files arrive on the request and move to the task on accept.',
    'intakeEditor.filesNoStorage': 'File storage (S3) is not configured on this server, so the form cannot take files.',
    'intakeEditor.maxFiles': 'Files per request',
    'intakeEditor.receipt': 'Email a receipt to the requester',
    'intakeEditor.receiptHint': 'Sent when they leave an email address.',
    'intakeEditor.preview': 'Preview',
    'intakeEditor.saved': 'Form saved',
    'intakeEditor.type.text': 'Short text',
    'intakeEditor.type.textarea': 'Long text',
    'intakeEditor.type.email': 'Email',
    'intakeEditor.type.phone': 'Phone',
    'intakeEditor.type.url': 'Link',
    'intakeEditor.type.number': 'Number',
    'intakeEditor.type.date': 'Date',
    'intakeEditor.type.select': 'Choice',
    'intakeEditor.type.checkbox': 'Checkbox',
    'intakeEditor.type.hidden': 'Hidden value',
    'intakeEditor.key': 'Key',
    'intakeEditor.keyHint': 'Your site passes a value as {attr}.',
    'intakeEditor.keyInvalid': 'Letters, digits and _ only, starting with a letter',
    'intakeEditor.keyTaken': 'Another field already uses this key',
    'intakeEditor.source': 'Value',
    'intakeEditor.source.prefill': 'Passed by your site',
    'intakeEditor.source.page': 'Address of the page the form is on',
    'intakeEditor.hiddenNote': 'Not shown to the visitor. The value arrives with the request, for example which page or account it came from.',
    'intakeEmbed.title': 'Embed on a website',
    'intakeEmbed.hint': 'Paste this where the form should appear. The frame grows with the form, so there is no inner scrollbar.',
    'intakeEmbed.theme': 'Theme',
    'intakeEmbed.themeLight': 'Light',
    'intakeEmbed.themeDark': 'Dark',
    'intakeEmbed.themeAuto': 'Follow the visitor',
    'intakeEmbed.lang': 'Language',
    'intakeEmbed.langAuto': 'Visitor’s browser',
    'intakeEmbed.script': 'Script (recommended)',
    'intakeEmbed.iframe': 'Plain iframe',
    'intakeEmbed.iframeHint': 'For site builders that strip scripts. The height is fixed, so set it to fit your form.',
    'intakeEmbed.event': 'After a request goes through, the container fires an ordi:intake-submitted event – handy for analytics.',
    'intakeEmbed.prefill': 'Prefill from your site',
    'intakeEmbed.prefillHint': 'Add these attributes to the container to fill fields in for the visitor – for example their name and email from your own login. Leave out the ones you do not need.',
    'intakeEmbed.lock': 'Make prefilled fields read-only',
    'intakeEmbed.prefillTrust': 'Prefilled values are whatever the page sets, so treat them as convenience, not proof of who sent the request.',
    'intakeEmbed.prefillIframe': 'For the plain iframe, put the same values after # in its address: #requesterEmail=…&orderId=…',
    'intakeEmbed.copy': 'Copy',
    'intakeEmbed.copied': 'Snippet copied',
  },
  uk: {
    'intakeEditor.title': 'Налаштувати форму',
    'intakeEditor.texts': 'Тексти',
    'intakeEditor.heading': 'Заголовок',
    'intakeEditor.intro': 'Вступ',
    'intakeEditor.introPh': 'Що варто описати, як швидко ви відповідаєте…',
    'intakeEditor.submitLabel': 'Текст кнопки',
    'intakeEditor.success': 'Повідомлення після надсилання',
    'intakeEditor.accent': 'Колір акценту',
    'intakeEditor.accentDefault': 'Типовий',
    'intakeEditor.fields': 'Поля',
    'intakeEditor.addField': 'Додати поле',
    'intakeEditor.fieldLimit': 'У формі може бути до {n} полів.',
    'intakeEditor.label': 'Назва',
    'intakeEditor.placeholder': 'Підказка в полі',
    'intakeEditor.help': 'Пояснення під полем',
    'intakeEditor.type': 'Тип',
    'intakeEditor.options': 'Варіанти, по одному на рядок',
    'intakeEditor.required': 'Обов’язкове',
    'intakeEditor.shown': 'Показувати у формі',
    'intakeEditor.hidden': 'Приховане',
    'intakeEditor.builtin': 'Вбудоване',
    'intakeEditor.titleNote': 'Стає назвою задачі, тому завжди показане й обов’язкове.',
    'intakeEditor.descriptionNote': 'Стає описом задачі.',
    'intakeEditor.emailNote': 'Сюди йдуть підтвердження й листи з рішенням. Якщо приховати, листів не буде.',
    'intakeEditor.customNote': 'Відповідь видно в запиті, і вона потрапляє в опис задачі.',
    'intakeEditor.moveUp': 'Вище',
    'intakeEditor.moveDown': 'Нижче',
    'intakeEditor.remove': 'Видалити поле',
    'intakeEditor.newField': 'Нове поле',
    'intakeEditor.extras': 'Файли та листи',
    'intakeEditor.files': 'Дозволити прикріплювати файли',
    'intakeEditor.filesHint': 'До {mb} МБ кожен. Файли потрапляють у запит, а після прийняття – в задачу.',
    'intakeEditor.filesNoStorage': 'На цьому сервері не налаштоване сховище файлів (S3), тож форма не може приймати файли.',
    'intakeEditor.maxFiles': 'Файлів на запит',
    'intakeEditor.receipt': 'Надсилати автору підтвердження на email',
    'intakeEditor.receiptHint': 'Якщо людина залишила адресу.',
    'intakeEditor.preview': 'Попередній перегляд',
    'intakeEditor.saved': 'Форму збережено',
    'intakeEditor.type.text': 'Короткий текст',
    'intakeEditor.type.textarea': 'Довгий текст',
    'intakeEditor.type.email': 'Email',
    'intakeEditor.type.phone': 'Телефон',
    'intakeEditor.type.url': 'Посилання',
    'intakeEditor.type.number': 'Число',
    'intakeEditor.type.date': 'Дата',
    'intakeEditor.type.select': 'Вибір зі списку',
    'intakeEditor.type.checkbox': 'Прапорець',
    'intakeEditor.type.hidden': 'Приховане значення',
    'intakeEditor.key': 'Ключ',
    'intakeEditor.keyHint': 'Сайт передає значення як {attr}.',
    'intakeEditor.keyInvalid': 'Лише латинські літери, цифри й _, на початку літера',
    'intakeEditor.keyTaken': 'Цей ключ уже має інше поле',
    'intakeEditor.source': 'Значення',
    'intakeEditor.source.prefill': 'Передає ваш сайт',
    'intakeEditor.source.page': 'Адреса сторінки, на якій форма',
    'intakeEditor.hiddenNote': 'Відвідувач його не бачить. Значення приходить разом із запитом: наприклад, з якої сторінки чи акаунта його надіслали.',
    'intakeEmbed.title': 'Вбудувати на сайт',
    'intakeEmbed.hint': 'Вставте цей код туди, де має бути форма. Рамка підлаштовується під висоту форми, тож внутрішньої прокрутки не буде.',
    'intakeEmbed.theme': 'Тема',
    'intakeEmbed.themeLight': 'Світла',
    'intakeEmbed.themeDark': 'Темна',
    'intakeEmbed.themeAuto': 'Як у відвідувача',
    'intakeEmbed.lang': 'Мова',
    'intakeEmbed.langAuto': 'Як у браузері',
    'intakeEmbed.script': 'Скрипт (рекомендовано)',
    'intakeEmbed.iframe': 'Звичайний iframe',
    'intakeEmbed.iframeHint': 'Для конструкторів сайтів, що вирізають скрипти. Висота фіксована – підберіть її під форму.',
    'intakeEmbed.event': 'Після надсилання контейнер генерує подію ordi:intake-submitted – зручно для аналітики.',
    'intakeEmbed.prefill': 'Передзаповнення з вашого сайту',
    'intakeEmbed.prefillHint': 'Додайте ці атрибути до контейнера, щоб заповнити поля за відвідувача: наприклад, ім’я та email з вашого входу. Непотрібні можна прибрати.',
    'intakeEmbed.lock': 'Заборонити змінювати передзаповнені поля',
    'intakeEmbed.prefillTrust': 'Передзаповнені значення – це те, що вказала сторінка, тож вони для зручності, а не доказ того, хто надіслав запит.',
    'intakeEmbed.prefillIframe': 'Для звичайного iframe додайте ті самі значення після # в адресі: #requesterEmail=…&orderId=…',
    'intakeEmbed.copy': 'Копіювати',
    'intakeEmbed.copied': 'Код скопійовано',
  },
});

const BUILTIN_LABEL_KEY: Record<string, string> = {
  requesterName: 'intakeForm.name',
  requesterEmail: 'intakeForm.email',
  title: 'intakeForm.title',
  description: 'intakeForm.description',
};

function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? ''));
}

function newFieldKey(): string {
  return `f_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** The draft as the public endpoint would hand it out, for the preview. */
function toPublicForm(config: IntakeFormConfig, storageConfigured: boolean): PublicIntakeForm {
  return {
    heading: config.heading,
    intro: config.intro,
    submitLabel: config.submitLabel,
    successMessage: config.successMessage,
    accentColor: config.accentColor,
    fields: config.fields
      .filter((f) => !f.hidden)
      .map(({ hidden: _hidden, ...field }) => ({ ...field, options: field.type === 'select' ? field.options : [] })),
    attachments: config.allowAttachments && storageConfigured ? { maxFiles: config.maxAttachments, maxBytes: MAX_UPLOAD_BYTES } : null,
  };
}

export function IntakeFormEditor({ projectId, projectName, config, storageConfigured, onClose }: {
  projectId: string;
  projectName: string;
  config: IntakeFormConfig;
  storageConfigured: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<IntakeFormConfig>(config);
  const [accentText, setAccentText] = useState(config.accentColor ?? '');
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = useMemo(() => toPublicForm(draft, storageConfigured), [draft, storageConfigured]);

  const labelOf = (field: IntakeField) => field.label || (BUILTIN_LABEL_KEY[field.key] ? t(BUILTIN_LABEL_KEY[field.key]!) : field.key);
  const set = <K extends keyof IntakeFormConfig>(key: K, value: IntakeFormConfig[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const setField = (key: string, patch: Partial<IntakeField>) =>
    setDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.key === key ? { ...f, ...patch } : f)) }));
  const move = (index: number, by: -1 | 1) => setDraft((d) => {
    const fields = [...d.fields];
    const [field] = fields.splice(index, 1);
    fields.splice(index + by, 0, field!);
    return { ...d, fields };
  });
  /** A custom field's key changed: null when it took, else why not. */
  const renameField = (from: string, to: string): string | null => {
    if (to === from) return null;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(to)) return t('intakeEditor.keyInvalid');
    if (isBuiltinIntakeKey(to) || draft.fields.some((f) => f.key === to)) return t('intakeEditor.keyTaken');
    setDraft((d) => ({ ...d, fields: d.fields.map((f) => (f.key === from ? { ...f, key: to } : f)) }));
    setOpen(to);
    return null;
  };
  const addField = () => {
    const key = newFieldKey();
    setDraft((d) => ({
      ...d,
      fields: [...d.fields, { key, type: 'text', label: t('intakeEditor.newField'), placeholder: '', help: '', required: false, hidden: false, options: [], source: 'prefill' }],
    }));
    setOpen(key);
  };

  const save = useMutation({
    mutationFn: () => api.patch(`/projects/${projectId}/intake-settings`, { formConfig: draft }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['intake-settings', projectId] });
      toast(t('intakeEditor.saved'));
      onClose();
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : t('common.saveFailed')),
  });

  /** The server's own rules, checked first so a problem points at its field. */
  const trySave = () => {
    setError(null);
    const parsed = intakeFormConfigSchema.safeParse(draft);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const field = issue.path[0] === 'fields' ? draft.fields[Number(issue.path[1])] : undefined;
      if (field) setOpen(field.key);
      setError(field ? `${labelOf(field)}: ${issue.message}` : issue.message);
      return;
    }
    save.mutate();
  };

  return (
    <Dialog open onClose={onClose} title={t('intakeEditor.title')} width={1080}>
      <div className="grid gap-6 px-4 pb-4 pt-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0 space-y-6">
          <section className="space-y-3">
            <SectionTitle>{t('intakeEditor.texts')}</SectionTitle>
            <LabeledInput label={t('intakeEditor.heading')} value={draft.heading} placeholder={t('intakeForm.heading')} onChange={(v) => set('heading', v)} />
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('intakeEditor.intro')}</label>
              <Textarea rows={3} value={draft.intro} placeholder={t('intakeEditor.introPh')} onChange={(e) => set('intro', e.target.value)} />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <LabeledInput label={t('intakeEditor.submitLabel')} value={draft.submitLabel} placeholder={t('intakeForm.submit')} onChange={(v) => set('submitLabel', v)} />
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{t('intakeEditor.accent')}</label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    aria-label={t('intakeEditor.accent')}
                    className="h-8 w-10 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
                    value={draft.accentColor ?? '#5e6ad2'}
                    onChange={(e) => { set('accentColor', e.target.value); setAccentText(e.target.value); }}
                  />
                  <Input
                    value={accentText}
                    placeholder={t('intakeEditor.accentDefault')}
                    aria-label={t('intakeEditor.accent')}
                    onChange={(e) => {
                      // Half-typed hex stays in the box; only a whole #rrggbb (or nothing) reaches the form.
                      setAccentText(e.target.value);
                      const v = e.target.value.trim();
                      if (!v) set('accentColor', null);
                      else if (/^#[0-9a-fA-F]{6}$/.test(v)) set('accentColor', v.toLowerCase());
                    }}
                  />
                  {draft.accentColor && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => { set('accentColor', null); setAccentText(''); }}>{t('intakeEditor.accentDefault')}</Button>
                  )}
                </div>
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('intakeEditor.success')}</label>
              <Textarea rows={2} value={draft.successMessage} placeholder={t('intakeForm.sentHint')} onChange={(e) => set('successMessage', e.target.value)} />
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <SectionTitle>{t('intakeEditor.fields')}</SectionTitle>
              <Button type="button" size="xs" variant="outline" disabled={draft.fields.length >= INTAKE_MAX_FIELDS} onClick={addField}>
                <Plus size={12} /> {t('intakeEditor.addField')}
              </Button>
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {draft.fields.map((field, index) => (
                <FieldRow
                  key={field.key}
                  field={field}
                  label={labelOf(field)}
                  expanded={open === field.key}
                  first={index === 0}
                  last={index === draft.fields.length - 1}
                  onToggle={() => setOpen(open === field.key ? null : field.key)}
                  onChange={(patch) => setField(field.key, patch)}
                  onRename={(to) => renameField(field.key, to)}
                  onMove={(by) => move(index, by)}
                  onRemove={() => setDraft((d) => ({ ...d, fields: d.fields.filter((f) => f.key !== field.key) }))}
                />
              ))}
            </ul>
            {draft.fields.length >= INTAKE_MAX_FIELDS && <p className="text-xs text-faint">{fill(t('intakeEditor.fieldLimit'), { n: INTAKE_MAX_FIELDS })}</p>}
          </section>

          <section className="space-y-3">
            <SectionTitle>{t('intakeEditor.extras')}</SectionTitle>
            <ToggleRow
              label={t('intakeEditor.files')}
              hint={storageConfigured ? fill(t('intakeEditor.filesHint'), { mb: Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024)) }) : t('intakeEditor.filesNoStorage')}
              checked={draft.allowAttachments && storageConfigured}
              disabled={!storageConfigured}
              onChange={(v) => set('allowAttachments', v)}
            />
            {draft.allowAttachments && storageConfigured && (
              <div className="flex items-center justify-between gap-4 pl-0.5">
                <label className="text-[13px]" htmlFor="intake-max-files">{t('intakeEditor.maxFiles')}</label>
                <Input
                  id="intake-max-files"
                  type="number"
                  min={1}
                  max={INTAKE_MAX_ATTACHMENTS}
                  className="w-20"
                  value={draft.maxAttachments}
                  onChange={(e) => set('maxAttachments', Math.min(INTAKE_MAX_ATTACHMENTS, Math.max(1, Number(e.target.value) || 1)))}
                />
              </div>
            )}
            <ToggleRow
              label={t('intakeEditor.receipt')}
              hint={t('intakeEditor.receiptHint')}
              checked={draft.acknowledge}
              onChange={(v) => set('acknowledge', v)}
            />
          </section>

          {error && <p className="text-[13px] text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="button" size="sm" disabled={save.isPending} onClick={trySave}>
              {save.isPending ? <Spinner /> : t('common.save')}
            </Button>
          </div>
        </div>

        <div className="min-w-0">
          <div className="lg:sticky lg:top-0">
            <SectionTitle>{t('intakeEditor.preview')}</SectionTitle>
            <div className="mt-2 rounded-lg border border-dashed border-border bg-background p-3">
              <div style={accentVars(draft.accentColor)}>
                <IntakeForm token={null} projectName={projectName} form={preview} embed />
              </div>
            </div>
          </div>
        </div>
      </div>
    </Dialog>
  );
}


function FieldRow({ field, label, expanded, first, last, onToggle, onChange, onRename, onMove, onRemove }: {
  field: IntakeField;
  label: string;
  expanded: boolean;
  first: boolean;
  last: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<IntakeField>) => void;
  onRename: (key: string) => string | null;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const [optionsText, setOptionsText] = useState(field.options.join('\n'));
  const [keyText, setKeyText] = useState(field.key);
  const [keyError, setKeyError] = useState<string | null>(null);
  const builtin = isBuiltinIntakeKey(field.key);
  const isTitle = field.key === 'title';
  const isHidden = field.type === 'hidden';
  const note = isTitle ? t('intakeEditor.titleNote')
    : field.key === 'description' ? t('intakeEditor.descriptionNote')
      : field.key === 'requesterEmail' ? t('intakeEditor.emailNote')
        : builtin ? null : isHidden ? t('intakeEditor.hiddenNote') : t('intakeEditor.customNote');
  // A typed key is applied on blur, so a half-typed one never clashes with another field's.
  const commitKey = () => {
    const problem = onRename(keyText.trim());
    setKeyError(problem);
  };

  return (
    <li>
      <div className="flex items-center gap-2 px-2.5 py-2">
        <button type="button" onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" aria-expanded={expanded}>
          {expanded ? <ChevronDown size={13} className="shrink-0 text-faint" /> : <ChevronRight size={13} className="shrink-0 text-faint" />}
          <span className={cn('truncate text-[13px] font-medium', field.hidden && 'text-faint line-through decoration-1')}>{label}</span>
          {field.required && !field.hidden && <span className="text-destructive" aria-label={t('intakeEditor.required')}>*</span>}
          <span className="ml-1 shrink-0 text-xs text-faint">{t(`intakeEditor.type.${field.type}`)}</span>
          {builtin && <Badge className="ml-1 shrink-0">{t('intakeEditor.builtin')}</Badge>}
          {field.hidden && <EyeOff size={12} className="ml-1 shrink-0 text-faint" aria-label={t('intakeEditor.hidden')} />}
        </button>
        <IconButton type="button" size="sm" disabled={first} onClick={() => onMove(-1)} aria-label={t('intakeEditor.moveUp')}><ArrowUp size={13} /></IconButton>
        <IconButton type="button" size="sm" disabled={last} onClick={() => onMove(1)} aria-label={t('intakeEditor.moveDown')}><ArrowDown size={13} /></IconButton>
        {!builtin && (
          <IconButton type="button" size="sm" onClick={onRemove} aria-label={t('intakeEditor.remove')}><Trash2 size={13} /></IconButton>
        )}
      </div>
      {expanded && (
        <div className="space-y-3 border-t border-border bg-muted/20 px-3 py-3">
          {note && <p className="text-xs text-faint">{note}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <LabeledInput
              label={t('intakeEditor.label')}
              value={field.label}
              placeholder={builtin ? t(BUILTIN_LABEL_KEY[field.key]!) : ''}
              onChange={(v) => onChange({ label: v })}
            />
            {builtin ? (
              <div />
            ) : (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{t('intakeEditor.type')}</label>
                <Select className="w-full" value={field.type} onChange={(e) => onChange({ type: e.target.value as IntakeFieldType })}>
                  {INTAKE_FIELD_TYPES.map((type) => <option key={type} value={type}>{t(`intakeEditor.type.${type}`)}</option>)}
                </Select>
              </div>
            )}
          </div>
          {!builtin && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground" htmlFor={`key-${field.key}`}>{t('intakeEditor.key')}</label>
                <Input
                  id={`key-${field.key}`}
                  className={cn('font-mono text-xs', keyError && '!border-destructive')}
                  value={keyText}
                  onChange={(e) => { setKeyText(e.target.value); setKeyError(null); }}
                  onBlur={commitKey}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitKey(); } }}
                />
                {(keyError || !(isHidden && field.source === 'page')) && (
                  <p className={cn('text-xs', keyError ? 'text-destructive' : 'text-faint')}>
                    {keyError ?? fill(t('intakeEditor.keyHint'), { attr: intakePrefillAttribute(field.key) })}
                  </p>
                )}
              </div>
              {isHidden && (
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{t('intakeEditor.source')}</label>
                  <Select className="w-full" value={field.source} onChange={(e) => onChange({ source: e.target.value as IntakeHiddenSource })}>
                    <option value="prefill">{t('intakeEditor.source.prefill')}</option>
                    <option value="page">{t('intakeEditor.source.page')}</option>
                  </Select>
                </div>
              )}
            </div>
          )}
          {field.type !== 'checkbox' && !isHidden && (
            <LabeledInput label={t('intakeEditor.placeholder')} value={field.placeholder} onChange={(v) => onChange({ placeholder: v })} />
          )}
          {!isHidden && <LabeledInput label={t('intakeEditor.help')} value={field.help} onChange={(v) => onChange({ help: v })} />}
          {field.type === 'select' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('intakeEditor.options')}</label>
              <Textarea
                rows={4}
                value={optionsText}
                onChange={(e) => {
                  // The raw text stays as typed (a trailing newline is the next choice being started).
                  setOptionsText(e.target.value);
                  onChange({ options: e.target.value.split('\n').map((o) => o.trim()).filter(Boolean) });
                }}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex items-center gap-2 text-[13px]">
              <Switch
                checked={!field.hidden}
                disabled={isTitle}
                label={t('intakeEditor.shown')}
                onChange={(shown) => onChange({ hidden: !shown, ...(shown ? {} : { required: false }) })}
              />
              {t('intakeEditor.shown')}
            </label>
            <label className="flex items-center gap-2 text-[13px]">
              <Switch
                checked={field.required && !isHidden}
                disabled={isTitle || field.hidden || isHidden}
                label={t('intakeEditor.required')}
                onChange={(required) => onChange({ required })}
              />
              {t('intakeEditor.required')}
            </label>
          </div>
        </div>
      )}
    </li>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>;
}

function LabeledInput({ label, value, placeholder, onChange }: {
  label: string; value: string; placeholder?: string; onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <Input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function ToggleRow({ label, hint, checked, disabled, onChange }: {
  label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} disabled={disabled} label={label} onChange={onChange} />
    </div>
  );
}

/* ─────────────────────────── Embed ─────────────────────────── */

/** Example prefill values, so the snippet reads as what to put there. */
function prefillExample(field: IntakeField): string {
  if (field.key === 'requesterName') return 'Jane Doe';
  if (field.key === 'requesterEmail') return 'jane@example.com';
  return '…';
}

export function IntakeEmbedDialog({ origin, token, config, onClose }: {
  origin: string; token: string; config: IntakeFormConfig; onClose: () => void;
}) {
  const t = useT();
  const [theme, setTheme] = useState<'light' | 'dark' | 'auto'>('light');
  const [lang, setLang] = useState<'' | 'en' | 'uk'>('');
  const [lock, setLock] = useState(false);

  // What a site would want to fill in: who is asking, and the hidden values it supplies.
  const prefillable = config.fields.filter((f) => !f.hidden
    && (f.key === 'requesterName' || f.key === 'requesterEmail' || (f.type === 'hidden' && f.source === 'prefill')));
  const prefillAttrs = prefillable.map((f) => `${intakePrefillAttribute(f.key)}="${prefillExample(f)}"`);
  const attrs = [`data-ordi-intake="${token}"`, theme !== 'light' ? `data-theme="${theme}"` : '', lang ? `data-lang="${lang}"` : '']
    .filter(Boolean).join(' ');
  const script = `<div ${attrs}></div>\n<script src="${origin}/api/v1/embed/intake.js" async></script>`;
  const prefilled = `<div ${attrs}\n  ${[...prefillAttrs, ...(lock ? ['data-lock-prefilled'] : [])].join('\n  ')}></div>\n<script src="${origin}/api/v1/embed/intake.js" async></script>`;
  const query = ['embed=1', theme !== 'light' ? `theme=${theme}` : '', lang ? `lang=${lang}` : ''].filter(Boolean).join('&');
  const iframe = `<iframe src="${origin}/intake/${token}?${query}" title="Request form" style="width:100%;height:760px;border:0" loading="lazy"></iframe>`;

  return (
    <Dialog open onClose={onClose} title={t('intakeEmbed.title')} width={640}>
      <div className="space-y-4 px-4 pb-4 pt-2">
        <p className="text-[13px] text-muted-foreground">{t('intakeEmbed.hint')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('intakeEmbed.theme')}</label>
            <Select className="w-full" value={theme} onChange={(e) => setTheme(e.target.value as typeof theme)}>
              <option value="light">{t('intakeEmbed.themeLight')}</option>
              <option value="dark">{t('intakeEmbed.themeDark')}</option>
              <option value="auto">{t('intakeEmbed.themeAuto')}</option>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('intakeEmbed.lang')}</label>
            <Select className="w-full" value={lang} onChange={(e) => setLang(e.target.value as typeof lang)}>
              <option value="">{t('intakeEmbed.langAuto')}</option>
              <option value="en">English</option>
              <option value="uk">Українська</option>
            </Select>
          </div>
        </div>
        <Snippet title={t('intakeEmbed.script')} code={script} note={t('intakeEmbed.event')} />
        <Snippet title={t('intakeEmbed.iframe')} code={iframe} note={t('intakeEmbed.iframeHint')} />
        {prefillAttrs.length > 0 && (
          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">{t('intakeEmbed.prefillHint')}</p>
            <label className="flex items-center gap-2 text-[13px]">
              <Switch checked={lock} label={t('intakeEmbed.lock')} onChange={setLock} />
              {t('intakeEmbed.lock')}
            </label>
            <Snippet title={t('intakeEmbed.prefill')} code={prefilled} note={`${t('intakeEmbed.prefillTrust')} ${t('intakeEmbed.prefillIframe')}`} />
          </div>
        )}
      </div>
    </Dialog>
  );
}

function Snippet({ title, code, note }: { title: string; code: string; note?: string }) {
  const t = useT();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast(t('intakeEmbed.copied'));
    } catch {
      toast.error(t('common.error'));
    }
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium">{title}</p>
        <Button type="button" size="xs" variant="outline" onClick={copy}><Copy size={12} /> {t('intakeEmbed.copy')}</Button>
      </div>
      <CodeSnippet code={code} language="xml" className="whitespace-pre-wrap break-all" />
      {note && <p className="text-xs text-faint">{note}</p>}
    </div>
  );
}
