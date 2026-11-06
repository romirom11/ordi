import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Plus, Trash2 } from 'lucide-react';
import type { PaymentAccount } from '@ordi/shared';
import { api } from '../../lib/api';
import { currencyOptions } from '../../lib/currency';
import { Button, Input, Select, Textarea, Switch, Skeleton, Spinner, cn } from '../ui';
import { toast } from '../overlays';
import { SectionHead, SettingRow } from './primitives';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'settings.invoicesDesc': 'Branding applied to every invoice you send and its public page.',
    'settings.invoiceShowLogo': 'Show workspace logo',
    'settings.invoiceShowLogoHint': 'Display your logo in the invoice header.',
    'settings.invoiceAccent': 'Accent colour',
    'settings.invoiceAccentHint': 'Used for the accent bar and the invoice number.',
    'settings.invoiceCustomHex': 'Custom hex',
    'settings.invoiceFooter': 'Footer note',
    'settings.invoiceFooterPlaceholder': 'Дякуємо за співпрацю!',
    'settings.invoicePayment': 'Payment details',
    'settings.invoicePaymentPlaceholder': 'IBAN UA00 0000 0000 …\nПризначення платежу: …',
    'settings.invoiceAccounts': 'Payment accounts',
    'settings.invoiceAccountsHint': 'One account per currency you take payments in. An invoice prints the account in the currency the client pays in; the first one in each currency is picked by default.',
    'settings.invoiceAccountName': 'Account name',
    'settings.invoiceAccountNamePlaceholder': 'e.g. PrivatBank, UAH',
    'settings.invoiceAccountCurrency': 'Account currency',
    'settings.invoiceAccountDetails': 'Payment details',
    'settings.invoiceAccountDetailsRequired': 'Enter the details the client pays to.',
    'settings.invoiceAccountAdd': 'Add account',
    'settings.invoiceAccountRemove': 'Remove account',
    'settings.invoiceAccountDefault': 'Default for {currency}',
    'settings.invoiceAccountMakeDefault': 'Make default for {currency}',
    'settings.invoiceAccountsEmpty': 'No accounts yet: invoices print no payment details.',
    'settings.invoicePreview': 'Preview',
    'settings.invoicePreviewNumber': 'INV-0001',
    'settings.invoicePreviewFrom': 'From',
    'settings.invoicePreviewTotal': 'Total due',
    'settings.invoiceLogoWebp': 'This logo is stored as WebP, which the PDF cannot embed – upload it again in Settings → Workspace to get it on the PDF.',
    'settings.invoiceIssuer': 'Your details',
    'settings.invoiceIssuerHint': 'Printed in the “From” block of every invoice and quote.',
    'settings.invoiceLegalName': 'Legal name',
    'settings.invoiceTaxId': 'Tax ID',
    'settings.invoiceAddress': 'Address',
    'settings.invoiceEmail': 'Email',
    'settings.invoicePhone': 'Phone',
    'settings.invoiceDefaults': 'Defaults for new documents',
    'settings.invoiceDefaultsHint': 'Every new invoice and quote starts with this text; edit it per document when needed.',
    'settings.invoiceDefaultNotes': 'Notes',
    'settings.invoiceDefaultTerms': 'Terms',
    'settings.invoiceDefaultNotesPlaceholder': 'Thank you for your business!',
    'settings.invoiceDefaultTermsPlaceholder': 'Payment within 14 days of the issue date. Bank fees are on the payer.',
  },
  uk: {
    'settings.invoicesDesc': 'Оформлення, що застосовується до кожного інвойсу та його публічної сторінки.',
    'settings.invoiceShowLogo': 'Показувати логотип',
    'settings.invoiceShowLogoHint': 'Відображати ваш логотип у шапці інвойсу.',
    'settings.invoiceAccent': 'Акцентний колір',
    'settings.invoiceAccentHint': 'Використовується для акцентної смуги та номера інвойсу.',
    'settings.invoiceCustomHex': 'Власний hex',
    'settings.invoiceFooter': 'Примітка у футері',
    'settings.invoiceFooterPlaceholder': 'Дякуємо за співпрацю!',
    'settings.invoicePayment': 'Платіжні реквізити',
    'settings.invoicePaymentPlaceholder': 'IBAN UA00 0000 0000 …\nПризначення платежу: …',
    'settings.invoiceAccounts': 'Рахунки для оплати',
    'settings.invoiceAccountsHint': 'По рахунку на кожну валюту, в якій ви приймаєте оплату. Інвойс показує рахунок у валюті, якою платить клієнт; за замовчуванням береться перший рахунок цієї валюти.',
    'settings.invoiceAccountName': 'Назва рахунку',
    'settings.invoiceAccountNamePlaceholder': 'Напр. ПриватБанк, гривня',
    'settings.invoiceAccountCurrency': 'Валюта рахунку',
    'settings.invoiceAccountDetails': 'Реквізити',
    'settings.invoiceAccountDetailsRequired': 'Вкажіть реквізити, на які платить клієнт.',
    'settings.invoiceAccountAdd': 'Додати рахунок',
    'settings.invoiceAccountRemove': 'Видалити рахунок',
    'settings.invoiceAccountDefault': 'Типовий для {currency}',
    'settings.invoiceAccountMakeDefault': 'Зробити типовим для {currency}',
    'settings.invoiceAccountsEmpty': 'Рахунків ще немає: інвойси не показують реквізитів.',
    'settings.invoicePreview': 'Попередній перегляд',
    'settings.invoicePreviewNumber': 'INV-0001',
    'settings.invoicePreviewFrom': 'Від',
    'settings.invoicePreviewTotal': 'До сплати',
    'settings.invoiceLogoWebp': 'Логотип збережено у WebP, який PDF не вміє вбудовувати – завантажте його ще раз у Налаштування → Робочий простір, і він з’явиться в PDF.',
    'settings.invoiceIssuer': 'Ваші реквізити',
    'settings.invoiceIssuerHint': 'Друкуються в блоці «Постачальник» кожного рахунку та комерційної пропозиції.',
    'settings.invoiceLegalName': 'Юридична назва',
    'settings.invoiceTaxId': 'ЄДРПОУ / ІПН',
    'settings.invoiceAddress': 'Адреса',
    'settings.invoiceEmail': 'Email',
    'settings.invoicePhone': 'Телефон',
    'settings.invoiceDefaults': 'Типовий текст нових документів',
    'settings.invoiceDefaultsHint': 'Кожен новий рахунок і пропозиція починаються з цього тексту; за потреби його можна змінити в конкретному документі.',
    'settings.invoiceDefaultNotes': 'Примітки',
    'settings.invoiceDefaultTerms': 'Умови',
    'settings.invoiceDefaultNotesPlaceholder': 'Дякуємо за співпрацю!',
    'settings.invoiceDefaultTermsPlaceholder': 'Оплата протягом 14 днів з дати виставлення. Банківські комісії – за рахунок платника.',
  },
});

interface InvoiceSettings {
  showLogo?: boolean;
  accentColor?: string | null;
  footerNote?: string | null;
  paymentDetails?: string | null;
  paymentAccounts?: PaymentAccount[];
  defaultNotes?: string | null;
  defaultTerms?: string | null;
}
interface LegalDetails {
  legalName?: string | null;
  taxId?: string | null;
  address?: string | null;
  email?: string | null;
  phone?: string | null;
}
interface WorkspaceData {
  name?: string;
  logo?: string | null;
  defaultCurrency?: string | null;
  legalDetails?: LegalDetails | null;
  invoiceSettings?: InvoiceSettings;
}

const ISSUER_KEYS: (keyof LegalDetails)[] = ['legalName', 'taxId', 'address', 'email', 'phone'];
function issuerOf(ws?: WorkspaceData): Record<keyof LegalDetails, string> {
  const raw = ws?.legalDetails ?? {};
  return Object.fromEntries(ISSUER_KEYS.map((k) => [k, typeof raw[k] === 'string' ? (raw[k] as string) : ''])) as Record<keyof LegalDetails, string>;
}

/**
 * The accounts the editor starts from. A workspace that still has only the
 * older single text sees it as one account in its default currency, and the
 * next save stores it as such.
 */
function accountsOf(ws?: WorkspaceData): PaymentAccount[] {
  const inv = ws?.invoiceSettings ?? {};
  if (inv.paymentAccounts?.length) return inv.paymentAccounts.map((a) => ({ id: a.id, name: a.name ?? '', currency: a.currency, details: a.details }));
  const legacy = inv.paymentDetails?.trim();
  return legacy ? [{ id: 'default', name: '', currency: ws?.defaultCurrency || 'USD', details: legacy }] : [];
}

function newAccountId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 14);
}

const DEFAULT_ACCENT = '#6366f1';
const PRESETS = ['#6366f1', '#3b82f6', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#64748b'];
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function InvoicesPanel() {
  const t = useT();
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: ['workspace-settings'], queryFn: () => api.get<WorkspaceData>('/settings/workspace') });

  const [showLogo, setShowLogo] = useState(true);
  const [accent, setAccent] = useState(DEFAULT_ACCENT);
  const [footer, setFooter] = useState('');
  const [accounts, setAccounts] = useState<PaymentAccount[]>([]);
  /** The account the preview shows: the one last focused, else the first. */
  const [previewIdx, setPreviewIdx] = useState(0);
  const [defaultNotes, setDefaultNotes] = useState('');
  const [defaultTerms, setDefaultTerms] = useState('');
  const [issuer, setIssuer] = useState<Record<keyof LegalDetails, string>>(issuerOf());
  /** The preview highlights whichever region is being edited. */
  const [focus, setFocus] = useState<'accent' | 'footer' | 'payment' | 'logo' | 'issuer' | null>(null);

  useEffect(() => {
    if (ws.data) {
      const inv = ws.data.invoiceSettings ?? {};
      setShowLogo(inv.showLogo ?? true);
      setAccent(inv.accentColor ?? DEFAULT_ACCENT);
      setFooter(inv.footerNote ?? '');
      setAccounts(accountsOf(ws.data));
      setDefaultNotes(inv.defaultNotes ?? '');
      setDefaultTerms(inv.defaultTerms ?? '');
      setIssuer(issuerOf(ws.data));
    }
  }, [ws.data]);

  const patch = useMutation({
    mutationFn: (body: { invoiceSettings: InvoiceSettings; legalDetails: LegalDetails }) => api.patch('/settings/workspace', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace-settings'] });
      qc.invalidateQueries({ queryKey: ['workspace'] });
      toast(t('common.saved'));
    },
    onError: () => toast.error(t('settings.saveFailed')),
  });

  const validHex = HEX_RE.test(accent);
  const safeAccent = validHex ? accent : DEFAULT_ACCENT;
  const logo = ws.data?.logo ?? null;
  const name = ws.data?.name ?? 'ordi';

  const stored = ws.data?.invoiceSettings ?? {};
  const storedIssuer = issuerOf(ws.data);
  const dirty = !!ws.data && (
    showLogo !== (stored.showLogo ?? true) ||
    accent !== (stored.accentColor ?? DEFAULT_ACCENT) ||
    footer !== (stored.footerNote ?? '') ||
    JSON.stringify(accounts) !== JSON.stringify(accountsOf(ws.data)) ||
    defaultNotes !== (stored.defaultNotes ?? '') ||
    defaultTerms !== (stored.defaultTerms ?? '') ||
    ISSUER_KEYS.some((k) => issuer[k] !== storedIssuer[k])
  );
  const logoIsWebp = !!logo && logo.startsWith('data:image/webp');
  const accountsValid = accounts.every((a) => a.details.trim());
  const payment = accounts[Math.min(previewIdx, accounts.length - 1)]?.details ?? '';

  const setAccount = (idx: number, patch: Partial<PaymentAccount>) => setAccounts((cur) => cur.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  /** The first account in a currency is its default: moving one in front of the others makes it so. */
  const makeDefault = (idx: number) => setAccounts((cur) => {
    const acc = cur[idx]!;
    const first = cur.findIndex((a) => a.currency === acc.currency);
    const rest = cur.filter((_, i) => i !== idx);
    return [...rest.slice(0, first), acc, ...rest.slice(first)];
  });
  const addAccount = () => {
    const used = new Set(accounts.map((a) => a.currency));
    const currency = currencyOptions(ws.data?.defaultCurrency).find((c) => !used.has(c)) ?? ws.data?.defaultCurrency ?? 'USD';
    setAccounts((cur) => [...cur, { id: newAccountId(), name: '', currency, details: '' }]);
    setPreviewIdx(accounts.length);
  };

  const save = () => {
    if (!validHex || !accountsValid) return;
    patch.mutate({
      invoiceSettings: {
        showLogo,
        accentColor: accent,
        footerNote: footer.trim() || null,
        // The accounts replace the older single text for good.
        paymentAccounts: accounts.map((a) => ({ id: a.id, name: a.name.trim(), currency: a.currency, details: a.details.trim() })),
        paymentDetails: null,
        defaultNotes: defaultNotes.trim() || null,
        defaultTerms: defaultTerms.trim() || null,
      },
      legalDetails: Object.fromEntries(ISSUER_KEYS.map((k) => [k, issuer[k].trim() || null])) as LegalDetails,
    });
  };
  const setIssuerField = (k: keyof LegalDetails) => (e: { target: { value: string } }) => setIssuer((cur) => ({ ...cur, [k]: e.target.value }));

  if (ws.isLoading) {
    return <div className="space-y-4"><Skeleton className="h-6 w-40" /><Skeleton className="h-40 w-full" /><Skeleton className="h-56 w-full" /></div>;
  }

  return (
    <div>
      <SectionHead title={t('settings.invoices')} desc={t('settings.invoicesDesc')} />

      <div className="grid grid-cols-1 items-start gap-10 lg:grid-cols-[minmax(0,380px),minmax(0,1fr)]">
        {/* Form: stacked, full-width – the page has the room, use it. Fields sit
            in a card like every other settings section; Save stays outside. */}
        <div className="space-y-4">
        <div className="space-y-6 rounded-lg border border-border bg-card p-4">
          <div
            className="flex items-center justify-between gap-4"
            onMouseEnter={() => setFocus('logo')}
            onMouseLeave={() => setFocus(null)}
          >
            <div>
              <div className="text-[13px] font-medium">{t('settings.invoiceShowLogo')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t('settings.invoiceShowLogoHint')}</div>
            </div>
            <Switch checked={showLogo} onChange={setShowLogo} />
          </div>
          {showLogo && logoIsWebp && (
            <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground/80">{t('settings.invoiceLogoWebp')}</p>
          )}

          {/* Issuer requisites: the "From" block of every document. */}
          <div onFocus={() => setFocus('issuer')} onBlur={() => setFocus(null)}>
            <div className="text-[13px] font-medium">{t('settings.invoiceIssuer')}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{t('settings.invoiceIssuerHint')}</div>
            <div className="mt-2.5 space-y-2">
              <Input value={issuer.legalName} onChange={setIssuerField('legalName')} placeholder={t('settings.invoiceLegalName')} aria-label={t('settings.invoiceLegalName')} />
              <Input value={issuer.taxId} onChange={setIssuerField('taxId')} placeholder={t('settings.invoiceTaxId')} aria-label={t('settings.invoiceTaxId')} />
              <Textarea value={issuer.address} onChange={setIssuerField('address')} placeholder={t('settings.invoiceAddress')} aria-label={t('settings.invoiceAddress')} rows={2} className="w-full" />
              <div className="grid grid-cols-2 gap-2">
                <Input value={issuer.email} onChange={setIssuerField('email')} placeholder={t('settings.invoiceEmail')} aria-label={t('settings.invoiceEmail')} type="email" />
                <Input value={issuer.phone} onChange={setIssuerField('phone')} placeholder={t('settings.invoicePhone')} aria-label={t('settings.invoicePhone')} />
              </div>
            </div>
          </div>

          <div onMouseEnter={() => setFocus('accent')} onMouseLeave={() => setFocus(null)}>
            <div className="text-[13px] font-medium">{t('settings.invoiceAccent')}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{t('settings.invoiceAccentHint')}</div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {PRESETS.map((c) => {
                const active = accent.toLowerCase() === c.toLowerCase();
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setAccent(c)}
                    title={c}
                    aria-label={c}
                    className={cn(
                      'grid h-7 w-7 place-items-center rounded-full ring-offset-2 ring-offset-card transition-transform duration-150 hover:scale-110',
                      active && 'ring-2 ring-foreground',
                    )}
                    style={{ backgroundColor: c }}
                  >
                    {active && <Check size={13} className="text-white" strokeWidth={3} />}
                  </button>
                );
              })}
              <span className="mx-1 h-5 w-px bg-border" />
              <span className="h-7 w-7 shrink-0 rounded-md border border-border" style={{ backgroundColor: safeAccent }} />
              <Input
                value={accent}
                onChange={(e) => setAccent(e.target.value)}
                placeholder={DEFAULT_ACCENT}
                aria-label={t('settings.invoiceCustomHex')}
                className={cn('w-28 font-mono text-xs', !validHex && 'border-destructive')}
              />
            </div>
          </div>

          <div>
            <div className="text-[13px] font-medium">{t('settings.invoiceFooter')}</div>
            <Textarea
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              onFocus={() => setFocus('footer')}
              onBlur={() => setFocus(null)}
              placeholder={t('settings.invoiceFooterPlaceholder')}
              rows={2}
              className="mt-1.5 w-full"
            />
          </div>

          {/* Payment accounts: one per currency the client may pay in. */}
          <div>
            <div className="text-[13px] font-medium">{t('settings.invoiceAccounts')}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{t('settings.invoiceAccountsHint')}</div>
            <div className="mt-2.5 space-y-3">
              {accounts.length === 0 && <p className="text-xs text-faint">{t('settings.invoiceAccountsEmpty')}</p>}
              {accounts.map((a, i) => {
                const isDefault = accounts.findIndex((x) => x.currency === a.currency) === i;
                const multiple = accounts.filter((x) => x.currency === a.currency).length > 1;
                const missing = !a.details.trim();
                return (
                  <div
                    key={a.id}
                    className="space-y-2 rounded-md border border-border p-2.5"
                    onFocus={() => { setFocus('payment'); setPreviewIdx(i); }}
                    onBlur={() => setFocus(null)}
                  >
                    <div className="flex items-center gap-2">
                      <Input
                        value={a.name}
                        onChange={(e) => setAccount(i, { name: e.target.value })}
                        placeholder={t('settings.invoiceAccountNamePlaceholder')}
                        aria-label={t('settings.invoiceAccountName')}
                        className="min-w-0 flex-1"
                      />
                      <Select
                        value={a.currency}
                        onChange={(e) => setAccount(i, { currency: e.target.value })}
                        aria-label={t('settings.invoiceAccountCurrency')}
                        className="w-[5.5rem] shrink-0"
                      >
                        {currencyOptions(a.currency).map((c) => <option key={c} value={c}>{c}</option>)}
                      </Select>
                      <button
                        type="button"
                        onClick={() => { setAccounts((cur) => cur.filter((_, j) => j !== i)); setPreviewIdx(0); }}
                        aria-label={t('settings.invoiceAccountRemove')}
                        title={t('settings.invoiceAccountRemove')}
                        className="grid h-8 w-8 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <Textarea
                      value={a.details}
                      onChange={(e) => setAccount(i, { details: e.target.value })}
                      placeholder={t('settings.invoicePaymentPlaceholder')}
                      aria-label={t('settings.invoiceAccountDetails')}
                      aria-invalid={missing || undefined}
                      rows={4}
                      className={cn('w-full font-mono text-xs', missing && 'border-destructive')}
                    />
                    {missing && <p className="text-xs text-destructive">{t('settings.invoiceAccountDetailsRequired')}</p>}
                    {multiple && (
                      isDefault
                        ? <p className="text-xs text-muted-foreground">{t('settings.invoiceAccountDefault').replace('{currency}', a.currency)}</p>
                        : <button type="button" onClick={() => makeDefault(i)} className="text-xs text-primary hover:underline">{t('settings.invoiceAccountMakeDefault').replace('{currency}', a.currency)}</button>
                    )}
                  </div>
                );
              })}
              <Button type="button" variant="outline" size="sm" onClick={addAccount}><Plus size={13} /> {t('settings.invoiceAccountAdd')}</Button>
            </div>
          </div>

          {/* Defaults: what every new invoice/quote starts with. */}
          <div>
            <div className="text-[13px] font-medium">{t('settings.invoiceDefaults')}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{t('settings.invoiceDefaultsHint')}</div>
            <label className="mt-2.5 block text-xs font-medium text-muted-foreground">{t('settings.invoiceDefaultNotes')}</label>
            <Textarea value={defaultNotes} onChange={(e) => setDefaultNotes(e.target.value)} placeholder={t('settings.invoiceDefaultNotesPlaceholder')} rows={2} className="mt-1 w-full" />
            <label className="mt-2.5 block text-xs font-medium text-muted-foreground">{t('settings.invoiceDefaultTerms')}</label>
            <Textarea value={defaultTerms} onChange={(e) => setDefaultTerms(e.target.value)} placeholder={t('settings.invoiceDefaultTermsPlaceholder')} rows={3} className="mt-1 w-full" />
          </div>
        </div>

          <div className="flex h-8 items-center gap-3">
            {dirty && (
              <Button size="sm" onClick={save} disabled={patch.isPending || !validHex || !accountsValid}>
                {patch.isPending ? <Spinner /> : null} {t('common.save')}
              </Button>
            )}
          </div>
        </div>

        {/* Live preview: big enough to read, sticky while the form scrolls,
            and it highlights the region you are editing. */}
        <div className="lg:sticky lg:top-6">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('settings.invoicePreview')}</div>
          <div className="mx-auto w-full max-w-md">
            <InvoicePreview
              accent={safeAccent}
              showLogo={showLogo}
              logo={logo}
              name={name}
              issuer={issuer}
              footer={footer}
              payment={payment}
              focus={focus}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function InvoicePreview({ accent, showLogo, logo, name, issuer, footer, payment, focus }: {
  accent: string; showLogo: boolean; logo: string | null; name: string; issuer: Record<keyof LegalDetails, string>; footer: string; payment: string;
  focus?: 'accent' | 'footer' | 'payment' | 'logo' | 'issuer' | null;
}) {
  const t = useT();
  const hi = (key: string) =>
    cn('rounded-md transition-shadow duration-200', focus === key && 'shadow-[0_0_0_2px_hsl(var(--primary)/0.5)]');
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card shadow-pop">
      <div className={cn('h-2 w-full transition-shadow duration-200', focus === 'accent' && 'shadow-[0_0_0_2px_hsl(var(--primary)/0.5)]')} style={{ backgroundColor: accent }} />
      <div className="p-6">
        {/* header */}
        <div className="flex items-start justify-between gap-3">
          <div className={cn('flex min-w-0 items-center gap-2.5 p-1', hi('logo'))}>
            {showLogo && (
              logo ? (
                <img src={logo} alt="" className="h-10 w-10 shrink-0 rounded object-cover" />
              ) : (
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded text-sm font-bold text-white" style={{ backgroundColor: accent }}>
                  {name.slice(0, 1).toUpperCase()}
                </div>
              )
            )}
            <div className={cn('min-w-0', hi('issuer'))}>
              <div className="break-words text-sm font-semibold leading-tight">{issuer.legalName.trim() || name}</div>
              {[issuer.taxId, issuer.address, issuer.email, issuer.phone].filter((v) => v.trim()).length
                ? [issuer.taxId, issuer.address, issuer.email, issuer.phone].filter((v) => v.trim()).map((v, i) => <div key={i} className="truncate text-[11px] text-muted-foreground">{v}</div>)
                : <div className="text-[11px] text-faint">{t('settings.invoicePreviewFrom')}</div>}
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="whitespace-nowrap text-[17px] font-bold tabular-nums" style={{ color: accent }}>{t('settings.invoicePreviewNumber')}</div>
            <div className="text-[11px] text-faint">2026</div>
          </div>
        </div>

        {/* fake line rows */}
        <div className="mt-6 space-y-2.5">
          {[0.9, 0.7, 0.55, 0.65].map((w, i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <div className="h-2 rounded-full bg-muted" style={{ width: `${w * 100}%` }} />
              <div className="h-2 w-10 shrink-0 rounded-full bg-muted" />
            </div>
          ))}
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-border pt-3.5">
          <span className="text-xs text-muted-foreground">{t('settings.invoicePreviewTotal')}</span>
          <span className="text-[15px] font-bold tabular-nums" style={{ color: accent }}>$1,240.00</span>
        </div>

        {/* payment details */}
        <div className={cn('mt-4 whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 text-[11px] leading-relaxed text-muted-foreground', hi('payment'), !payment.trim() && 'text-faint')}>
          {payment.trim() || t('settings.invoicePaymentPlaceholder')}
        </div>

        {/* footer */}
        <div className={cn('mt-4 border-t border-border p-2 pt-3 text-center text-xs italic text-muted-foreground', hi('footer'))}>
          {footer.trim() || t('settings.invoiceFooterPlaceholder')}
        </div>
      </div>
    </div>
  );
}
