/**
 * One form for an invoice or quote, used to create a draft and to edit an
 * existing document: dates (a due date is optional – without one the invoice
 * is never overdue and prints no deadline), currency, language, the tax rate
 * applied to every line, a discount, and the line items. Items lock once an
 * invoice has been sent (the API refuses them); everything else stays
 * editable, because dates, wording and tax are what a client asks to change.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Input, Select, fmtMoney } from '../ui';
import { DateField } from '../DatePicker';
import { currencyOptions } from '../../lib/currency';
import { byName } from '../../lib/queries';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'finance.issueDate': 'Issue date',
    'finance.dueDateOptional': 'Due date (optional)',
    'finance.validUntilOptional': 'Valid until (optional)',
    'finance.language': 'Document language',
    'finance.taxRate': 'Tax',
    'finance.noTax': 'No tax',
    'finance.discount': 'Discount',
    'finance.discountNone': 'None',
    'finance.discountPercent': 'Percent',
    'finance.discountFixed': 'Fixed amount',
    'finance.itemsLocked': 'Line items are fixed once an invoice has been sent. Cancel and duplicate it to change them.',
    'finance.editInvoice': 'Edit invoice',
    'finance.subtotal': 'Subtotal',
    'finance.taxAmount': 'Tax',
    'finance.saveChanges': 'Save changes',
    'finance.lang.uk': 'Ukrainian',
    'finance.lang.en': 'English',
  },
  uk: {
    'finance.issueDate': 'Дата виставлення',
    'finance.dueDateOptional': 'Термін оплати (необов’язково)',
    'finance.validUntilOptional': 'Дійсна до (необов’язково)',
    'finance.language': 'Мова документа',
    'finance.taxRate': 'Податок',
    'finance.noTax': 'Без податку',
    'finance.discount': 'Знижка',
    'finance.discountNone': 'Немає',
    'finance.discountPercent': 'Відсоток',
    'finance.discountFixed': 'Фіксована сума',
    'finance.itemsLocked': 'Позиції надісланого рахунку не змінюються. Скасуйте його і продублюйте, щоб змінити.',
    'finance.editInvoice': 'Редагувати рахунок',
    'finance.subtotal': 'Проміжна сума',
    'finance.taxAmount': 'Податок',
    'finance.saveChanges': 'Зберегти зміни',
    'finance.lang.uk': 'Українська',
    'finance.lang.en': 'Англійська',
  },
});

export interface TaxRate { id: string; name: string; ratePercent: number | string }
export interface FormCompany { id: string; name: string; defaultCurrency?: string | null }
export interface FormLine { description: string; quantity: string; unitPrice: string }

export interface DocumentFormValues {
  companyId: string;
  issueDate: string;
  /** Due date for an invoice, valid-until for a quote; null when left empty. */
  endDate: string | null;
  currency: string;
  language: 'uk' | 'en';
  taxRateId: string | null;
  discountType: 'none' | 'percent' | 'fixed';
  discountValue: number;
  items: { description: string; quantity: number; unitPrice: number; taxRateId: string | null; position: number }[];
}

export interface DocumentFormInitial {
  companyId?: string | null;
  issueDate?: string | null;
  endDate?: string | null;
  currency?: string | null;
  language?: string | null;
  taxRateId?: string | null;
  discountType?: string | null;
  discountValue?: number | string | null;
  items?: { description?: string | null; quantity?: number | string | null; unitPrice?: number | string | null; taxRateId?: string | null }[];
}

const emptyLine: FormLine = { description: '', quantity: '1', unitPrice: '' };

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function useTaxRates() {
  return useQuery({ queryKey: ['taxRates'], queryFn: () => api.get<{ data: TaxRate[] }>('/tax-rates'), staleTime: 60_000 });
}

export function DocumentForm({ kind, mode, companies, initial, defaultCurrency, itemsEditable = true, onSubmit, onCancel, pending, submitLabel }: {
  kind: 'invoice' | 'quote';
  mode: 'create' | 'edit';
  /** Needed in create mode; an edit keeps the document's company. */
  companies?: FormCompany[];
  initial?: DocumentFormInitial;
  defaultCurrency?: string;
  itemsEditable?: boolean;
  onSubmit: (values: DocumentFormValues) => void;
  onCancel?: () => void;
  pending: boolean;
  submitLabel: string;
}) {
  const t = useT();
  const taxRates = useTaxRates();
  const rates = taxRates.data?.data ?? [];

  const [companyId, setCompanyId] = useState(initial?.companyId ?? '');
  const [issueDate, setIssueDate] = useState(initial?.issueDate ?? todayIso());
  const [endDate, setEndDate] = useState<string>(initial?.endDate ?? '');
  const [currency, setCurrency] = useState(initial?.currency ?? defaultCurrency ?? 'USD');
  const [language, setLanguage] = useState<'uk' | 'en'>(initial?.language === 'uk' ? 'uk' : 'en');
  const [taxRateId, setTaxRateId] = useState<string>(initial?.taxRateId ?? '');
  const [discountType, setDiscountType] = useState<'none' | 'percent' | 'fixed'>(
    initial?.discountType === 'percent' || initial?.discountType === 'fixed' ? initial.discountType : 'none',
  );
  const [discountValue, setDiscountValue] = useState(initial?.discountValue != null && Number(initial.discountValue) > 0 ? String(Number(initial.discountValue)) : '');
  const [items, setItems] = useState<FormLine[]>(
    initial?.items?.length
      ? initial.items.map((it) => ({ description: it.description ?? '', quantity: String(Number(it.quantity ?? 1)), unitPrice: String(Number(it.unitPrice ?? 0)) }))
      : [{ ...emptyLine }],
  );

  // A new invoice follows the company's own currency once one is picked.
  useEffect(() => {
    if (mode !== 'create' || !companyId) return;
    const c = companies?.find((x) => x.id === companyId);
    if (c?.defaultCurrency) setCurrency(c.defaultCurrency);
  }, [companyId, companies, mode]);

  const setItem = (idx: number, patch: Partial<FormLine>) => setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  const subtotal = items.reduce((a, it) => a + Number(it.quantity || 0) * Number(it.unitPrice || 0), 0);
  const ratePct = Number(rates.find((r) => r.id === taxRateId)?.ratePercent ?? 0);
  const discount = discountType === 'percent' ? subtotal * (Number(discountValue || 0) / 100) : discountType === 'fixed' ? Number(discountValue || 0) : 0;
  const taxable = Math.max(0, subtotal - discount);
  const tax = taxRateId ? taxable * ratePct / 100 : 0;
  const total = taxable + tax;

  const valid = (mode === 'edit' || !!companyId) && !!issueDate && items.every((it) => it.description.trim());

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onSubmit({
          companyId,
          issueDate,
          endDate: endDate || null,
          currency,
          language,
          taxRateId: taxRateId || null,
          discountType,
          discountValue: discountType === 'none' ? 0 : Number(discountValue || 0),
          items: items.map((it, i) => ({
            description: it.description.trim(), quantity: Number(it.quantity || 0), unitPrice: Number(it.unitPrice || 0),
            taxRateId: taxRateId || null, position: (i + 1) * 1000,
          })),
        });
      }}
      className="space-y-4 px-4 pb-4 pt-1"
    >
      {mode === 'create' && (
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('common.company')}</label>
          <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="block w-full">
            <option value="">{t('common.select')}</option>
            {byName(companies ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('finance.issueDate')}</label>
          <DateField value={issueDate} onChange={(v) => setIssueDate(v ?? todayIso())} clearable={false} />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{kind === 'invoice' ? t('finance.dueDateOptional') : t('finance.validUntilOptional')}</label>
          <DateField value={endDate} onChange={(v) => setEndDate(v ?? '')} min={issueDate} />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('common.currency')}</label>
          <Select value={currency} onChange={(e) => setCurrency(e.target.value)} className="block w-full">
            {currencyOptions(currency).map((cur) => <option key={cur} value={cur}>{cur}</option>)}
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('finance.language')}</label>
          <Select value={language} onChange={(e) => setLanguage(e.target.value === 'uk' ? 'uk' : 'en')} className="block w-full">
            <option value="uk">{t('finance.lang.uk')}</option>
            <option value="en">{t('finance.lang.en')}</option>
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('finance.taxRate')}</label>
          <Select value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)} className="block w-full" disabled={!itemsEditable}>
            <option value="">{t('finance.noTax')}</option>
            {rates.map((r) => <option key={r.id} value={r.id}>{r.name.includes(`${Number(r.ratePercent)}%`) ? r.name : `${r.name} ${Number(r.ratePercent)}%`}</option>)}
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('finance.discount')}</label>
          <div className="flex gap-2">
            <Select value={discountType} onChange={(e) => setDiscountType(e.target.value as 'none' | 'percent' | 'fixed')} className="block w-full">
              <option value="none">{t('finance.discountNone')}</option>
              <option value="percent">{t('finance.discountPercent')}</option>
              <option value="fixed">{t('finance.discountFixed')}</option>
            </Select>
            {discountType !== 'none' && (
              <Input type="number" min={0} step="0.01" value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} className="w-24 shrink-0" placeholder={discountType === 'percent' ? '%' : currency} />
            )}
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {!itemsEditable && <p className="text-xs text-muted-foreground">{t('finance.itemsLocked')}</p>}
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Input placeholder={t('public.description')} value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} disabled={!itemsEditable} />
            </div>
            <div className="w-16 shrink-0">
              <Input type="number" min={0} step="0.01" placeholder={t('public.qty')} value={it.quantity} onChange={(e) => setItem(i, { quantity: e.target.value })} disabled={!itemsEditable} />
            </div>
            <div className="w-24 shrink-0">
              <Input type="number" min={0} step="0.01" placeholder={t('public.price')} value={it.unitPrice} onChange={(e) => setItem(i, { unitPrice: e.target.value })} disabled={!itemsEditable} />
            </div>
            {itemsEditable && (
              <button type="button" className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive" onClick={() => setItems((arr) => arr.filter((_, j) => j !== i))} disabled={items.length === 1} aria-label={t('common.delete')}>
                <Trash2 size={14} />
              </button>
            )}
          </div>
        ))}
        {itemsEditable && (
          <Button type="button" variant="outline" size="sm" onClick={() => setItems((arr) => [...arr, { ...emptyLine }])}><Plus size={13} /> {t('finance.addLine')}</Button>
        )}
      </div>

      <div className="flex items-end justify-between gap-4 border-t border-border pt-3">
        <dl className="space-y-0.5 text-[13px] text-muted-foreground">
          {(discount > 0 || tax > 0) && <div className="flex gap-3"><dt>{t('finance.subtotal')}</dt><dd className="tabular-nums">{fmtMoney(subtotal, currency)}</dd></div>}
          {discount > 0 && <div className="flex gap-3"><dt>{t('finance.discount')}</dt><dd className="tabular-nums">-{fmtMoney(discount, currency)}</dd></div>}
          {tax > 0 && <div className="flex gap-3"><dt>{t('finance.taxAmount')} ({ratePct}%)</dt><dd className="tabular-nums">{fmtMoney(tax, currency)}</dd></div>}
          <div className="flex gap-3"><dt>{t('common.total')}</dt><dd className="font-semibold tabular-nums text-foreground">{fmtMoney(total, currency)}</dd></div>
        </dl>
        <div className="flex gap-2">
          {onCancel && <Button type="button" variant="ghost" size="sm" onClick={onCancel}>{t('common.cancel')}</Button>}
          <Button type="submit" size="sm" disabled={pending || !valid}>{submitLabel}</Button>
        </div>
      </div>
    </form>
  );
}
