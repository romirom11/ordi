/**
 * Finance → Expenses → "Повторювані витрати": recurring outgoing payments
 * (SaaS, hosting, rent…) rendered as a section at the top of the Expenses tab.
 * A compact header (title + count + monthly-total chip + add button) sits above
 * a next-30-days strip and the list. Rows toggle active inline and expose
 * edit/delete via a row menu. Create/edit happens in a Dialog.
 *
 * Contracts (verified):
 *   GET  /recurring-payments?active=
 *   GET  /recurring-payments/summary   → { monthlyTotal, upcoming[] }
 *   POST /recurring-payments
 *   PATCH /recurring-payments/:id (+version)
 *   DELETE /recurring-payments/:id
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Repeat, CalendarClock, MoreHorizontal, Pencil, Trash2, Wallet,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { useT, extendDict } from '../../lib/i18n';
import {
  Badge, Button, EmptyState, Input, Select, Skeleton, Switch, Spinner,
  cn, fmtMoney, fmtDate,
} from '../ui';
import { DropdownMenu, MenuItem, MenuSeparator, Dialog, ConfirmDialog, toast } from '../overlays';
import { Hint } from '../Hint';

extendDict({
  en: {
    'subs.title': 'Subscriptions',
    'subs.recurringTitle': 'Recurring expenses',
    'subs.addRecurring': 'Add recurring',
    'subs.new': 'New subscription',
    'subs.edit': 'Edit subscription',
    'subs.monthlyTotal': 'Monthly total',
    'subs.activeCount': '{n} active',
    'subs.upcoming': 'Next 30 days',
    'subs.noUpcoming': 'Nothing due in the next 30 days',
    'subs.empty': 'No subscriptions tracked yet',
    'subs.emptyHint': 'Track recurring costs – hosting, SaaS tools, office rent, retainers – to see your true monthly burn.',
    'subs.hintTitle': 'What to track here',
    'subs.hintBody': 'Add recurring payments like hosting, SaaS subscriptions, rent or retainers. Amounts are normalized to a monthly figure so you always see the real burn.',
    'subs.name': 'Name',
    'subs.namePlaceholder': 'Figma, AWS, Office rent…',
    'subs.vendor': 'Vendor',
    'subs.vendorPlaceholder': 'Who you pay',
    'subs.amount': 'Amount',
    'subs.interval': 'Interval',
    'subs.nextDate': 'Next payment',
    'subs.category': 'Category',
    'subs.categoryPlaceholder': 'Software, Office…',
    'subs.company': 'Linked client',
    'subs.notes': 'Notes',
    'subs.autoExpense': 'Auto-create expense',
    'subs.autoExpenseHint': 'Автоматично створювати витрату при кожному списанні',
    'subs.autoExpenseHintEn': 'Create an expense automatically on each charge',
    'subs.perMonth': '/mo',
    'subs.every.weekly': 'Weekly',
    'subs.every.monthly': 'Monthly',
    'subs.every.quarterly': 'Quarterly',
    'subs.every.yearly': 'Yearly',
    'subs.created': 'Subscription created',
    'subs.updated': 'Subscription updated',
    'subs.deleted': 'Subscription deleted',
    'subs.deleteTitle': 'Delete subscription',
    'subs.deleteBody': 'This removes “{name}” from your tracked subscriptions. This cannot be undone.',
    'subs.noneSelected': 'None',
  },
  uk: {
    'subs.title': 'Підписки',
    'subs.recurringTitle': 'Повторювані витрати',
    'subs.addRecurring': 'Додати повторювану',
    'subs.new': 'Нова підписка',
    'subs.edit': 'Редагувати підписку',
    'subs.monthlyTotal': 'Щомісяця всього',
    'subs.activeCount': 'активних: {n}',
    'subs.upcoming': 'Наступні 30 днів',
    'subs.noUpcoming': 'Найближчі 30 днів – без списань',
    'subs.empty': 'Підписки ще не додано',
    'subs.emptyHint': 'Додавайте регулярні витрати – хостинг, SaaS, оренду офісу, ретейнери – щоб бачити реальні щомісячні витрати.',
    'subs.hintTitle': 'Що тут відстежувати',
    'subs.hintBody': 'Додавайте регулярні платежі: хостинг, SaaS-підписки, оренду чи ретейнери. Суми нормалізуються до місячних, тож ви завжди бачите реальні витрати.',
    'subs.name': 'Назва',
    'subs.namePlaceholder': 'Figma, AWS, Оренда офісу…',
    'subs.vendor': 'Постачальник',
    'subs.vendorPlaceholder': 'Кому платите',
    'subs.amount': 'Сума',
    'subs.interval': 'Періодичність',
    'subs.nextDate': 'Наступний платіж',
    'subs.category': 'Категорія',
    'subs.categoryPlaceholder': 'Софт, Офіс…',
    'subs.company': 'Повʼязаний клієнт',
    'subs.notes': 'Нотатки',
    'subs.autoExpense': 'Автоматична витрата',
    'subs.autoExpenseHint': 'Автоматично створювати витрату при кожному списанні',
    'subs.autoExpenseHintEn': 'Автоматично створювати витрату при кожному списанні',
    'subs.perMonth': '/міс',
    'subs.every.weekly': 'Щотижня',
    'subs.every.monthly': 'Щомісяця',
    'subs.every.quarterly': 'Щокварталу',
    'subs.every.yearly': 'Щороку',
    'subs.created': 'Підписку створено',
    'subs.updated': 'Підписку оновлено',
    'subs.deleted': 'Підписку видалено',
    'subs.deleteTitle': 'Видалити підписку',
    'subs.deleteBody': 'Це видалить «{name}» зі списку відстежуваних підписок. Дію не можна скасувати.',
    'subs.noneSelected': 'Немає',
  },
});

const INTERVALS = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
type Interval = (typeof INTERVALS)[number];
const CURRENCIES = ['USD', 'EUR', 'GBP', 'UAH', 'PLN'];

/** Monthly-normalization factor matching the API summary math. */
const MONTHLY_FACTOR: Record<Interval, number> = {
  weekly: 52 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
};

interface Subscription {
  id: string;
  name: string;
  vendor?: string | null;
  companyId?: string | null;
  amount: string;
  currency: string;
  interval: Interval;
  nextDate: string;
  category?: string | null;
  notes?: string | null;
  isActive: boolean;
  autoCreateExpense: boolean;
  version: number;
}
interface Summary {
  monthlyTotal: Record<string, number>;
  upcoming: { id: string; name: string; amount: number; currency: string; date: string }[];
}
interface CompanyLite { id: string; name: string; defaultCurrency?: string | null }

function daysUntil(iso: string): number {
  const d = new Date(iso + 'T00:00:00');
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - now.getTime()) / 86_400_000);
}

export function RecurringExpensesSection() {
  const t = useT();
  const can = useCan();
  const canWrite = can('finance.write');
  const qc = useQueryClient();

  const listQ = useQuery({
    queryKey: ['recurring-payments'],
    queryFn: () => api.get<{ data: Subscription[] }>('/recurring-payments'),
  });
  const summaryQ = useQuery({
    queryKey: ['recurring-payments', 'summary'],
    queryFn: () => api.get<Summary>('/recurring-payments/summary'),
  });
  const companiesQ = useQuery({
    queryKey: ['companies', 'finance'],
    queryFn: () => api.get<{ data: CompanyLite[] }>('/companies'),
    staleTime: 5 * 60_000,
  });

  const rows = listQ.data?.data ?? [];
  const summary = summaryQ.data;
  const companies = companiesQ.data?.data ?? [];
  const companyMap = useMemo(() => new Map(companies.map((c) => [c.id, c.name])), [companies]);

  const [dialog, setDialog] = useState<{ mode: 'create' | 'edit'; sub?: Subscription } | null>(null);
  const [toDelete, setToDelete] = useState<Subscription | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['recurring-payments'] });
  };

  const toggle = useMutation({
    mutationFn: (s: Subscription) =>
      api.patch<Subscription>(`/recurring-payments/${s.id}`, { isActive: !s.isActive, version: s.version }),
    onSuccess: () => invalidate(),
    onError: (e) => {
      invalidate();
      toast.error(e instanceof ApiError ? e.message : t('common.saveFailed'));
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/recurring-payments/${id}`),
    onSuccess: () => { setToDelete(null); invalidate(); toast(t('subs.deleted')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const activeCount = rows.filter((r) => r.isActive).length;

  return (
    <section className="space-y-3">
      {/* Header row: title + count + monthly-total chip + add button */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          <Repeat size={15} className="text-muted-foreground" />
          {t('subs.recurringTitle')}
          {rows.length > 0 && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">{rows.length}</span>
          )}
        </h2>
        <MonthlyTotalChip
          monthlyTotal={summary?.monthlyTotal}
          activeCount={activeCount}
          loading={summaryQ.isLoading}
        />
        {canWrite && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setDialog({ mode: 'create' })}>
            <Plus size={14} /> {t('subs.addRecurring')}
          </Button>
        )}
      </div>

      {/* Next-30-days strip */}
      <UpcomingStrip upcoming={summary?.upcoming ?? []} loading={summaryQ.isLoading} />

      {/* List */}
      {listQ.isLoading ? (
        <div className="space-y-px">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Repeat size={20} />}
          title={t('subs.empty')}
          hint={t('subs.emptyHint')}
          action={canWrite ? <Button size="sm" onClick={() => setDialog({ mode: 'create' })}><Plus size={14} /> {t('subs.addRecurring')}</Button> : undefined}
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((s, i) => (
            <SubscriptionRow
              key={s.id}
              sub={s}
              companyName={s.companyId ? companyMap.get(s.companyId) : undefined}
              index={i}
              canWrite={canWrite}
              onToggle={() => toggle.mutate(s)}
              onEdit={() => setDialog({ mode: 'edit', sub: s })}
              onDelete={() => setToDelete(s)}
            />
          ))}
        </div>
      )}

      {rows.length === 0 && !listQ.isLoading && (
        <Hint id="subs-intro" title={t('subs.hintTitle')}>{t('subs.hintBody')}</Hint>
      )}

      {dialog && (
        <SubscriptionDialog
          mode={dialog.mode}
          sub={dialog.sub}
          companies={companies}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); invalidate(); }}
        />
      )}

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
        title={t('subs.deleteTitle')}
        body={toDelete ? t('subs.deleteBody').replace('{name}', toDelete.name) : ''}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </section>
  );
}

function MonthlyTotalCard({ monthlyTotal, activeCount, loading }: {
  monthlyTotal?: Record<string, number>; activeCount: number; loading: boolean;
}) {
  const t = useT();
  const entries = Object.entries(monthlyTotal ?? {}).filter(([, v]) => v > 0);
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Wallet size={14} /> {t('subs.monthlyTotal')}
      </div>
      {loading ? (
        <Skeleton className="mt-2 h-8 w-32" />
      ) : entries.length === 0 ? (
        <div className="mt-1 text-2xl font-semibold tabular-nums text-muted-foreground">—</div>
      ) : (
        <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          {entries.map(([cur, val]) => (
            <span key={cur} className="text-2xl font-semibold tabular-nums">{fmtMoney(val, cur)}</span>
          ))}
        </div>
      )}
      <div className="mt-1.5 text-xs text-faint">{t('subs.activeCount').replace('{n}', String(activeCount))}</div>
    </Card>
  );
}

function UpcomingCard({ upcoming, loading }: {
  upcoming: Summary['upcoming']; loading: boolean;
}) {
  const t = useT();
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CalendarClock size={14} /> {t('subs.upcoming')}
      </div>
      {loading ? (
        <div className="mt-3 flex gap-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-40 rounded-lg" />)}</div>
      ) : upcoming.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted-foreground">{t('subs.noUpcoming')}</p>
      ) : (
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {upcoming.map((u) => {
            const soon = daysUntil(u.date) <= 7;
            return (
              <div
                key={u.id}
                className="flex min-w-[150px] shrink-0 items-center gap-2.5 rounded-lg border border-border bg-muted/30 px-3 py-2"
              >
                <span className={cn(
                  'grid h-8 w-8 shrink-0 place-items-center rounded-md text-[11px] font-semibold leading-none tabular-nums',
                  soon ? 'bg-warning/15 text-warning' : 'bg-muted text-muted-foreground',
                )}>
                  {fmtDate(u.date)}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[13px] font-medium">{u.name}</div>
                  <div className="text-xs tabular-nums text-muted-foreground">{fmtMoney(u.amount, u.currency)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function SubscriptionRow({ sub, companyName, index, canWrite, onToggle, onEdit, onDelete }: {
  sub: Subscription; companyName?: string; index: number; canWrite: boolean;
  onToggle: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const t = useT();
  const monthly = Number(sub.amount) * MONTHLY_FACTOR[sub.interval];
  const days = daysUntil(sub.nextDate);
  const soon = sub.isActive && days >= 0 && days <= 7;
  return (
    <div
      className={cn(
        'row-enter flex items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-muted/40',
        index > 0 && 'border-t border-border',
        !sub.isActive && 'opacity-60',
      )}
      style={{ ['--i' as string]: Math.min(index, 10) }}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate text-[13px] font-medium">
          {sub.name}
        </div>
        <div className="truncate text-xs text-faint">
          {[sub.vendor, companyName].filter(Boolean).join(' · ') || '—'}
        </div>
      </div>

      <div className="hidden w-28 shrink-0 sm:block">
        {sub.category ? <Badge>{sub.category}</Badge> : <span className="text-xs text-faint">—</span>}
      </div>

      <div className="w-24 shrink-0">
        <Badge className="bg-primary/10 text-primary">{t(`subs.every.${sub.interval}`)}</Badge>
      </div>

      <div className="w-28 shrink-0 text-right">
        <div className="text-[13px] font-semibold tabular-nums">{fmtMoney(sub.amount, sub.currency)}</div>
        <div className="text-[11px] tabular-nums text-faint">≈ {fmtMoney(monthly, sub.currency)}{t('subs.perMonth')}</div>
      </div>

      <div className={cn('w-20 shrink-0 text-right text-xs tabular-nums', soon ? 'font-medium text-warning' : 'text-muted-foreground')}>
        {fmtDate(sub.nextDate)}
      </div>

      <div className="flex w-14 shrink-0 items-center justify-end gap-1">
        <Switch checked={sub.isActive} onChange={onToggle} disabled={!canWrite} />
        {canWrite && (
          <DropdownMenu
            align="end"
            trigger={
              <button className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                <MoreHorizontal size={15} />
              </button>
            }
          >
            <MenuItem icon={<Pencil size={14} />} onSelect={onEdit}>{t('common.edit')}</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 size={14} />} danger onSelect={onDelete}>{t('common.delete')}</MenuItem>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function SubscriptionDialog({ mode, sub, companies, onClose, onSaved }: {
  mode: 'create' | 'edit'; sub?: Subscription; companies: CompanyLite[];
  onClose: () => void; onSaved: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(sub?.name ?? '');
  const [vendor, setVendor] = useState(sub?.vendor ?? '');
  const [amount, setAmount] = useState(sub ? String(sub.amount) : '');
  const [currency, setCurrency] = useState(sub?.currency ?? 'USD');
  const [interval, setInterval] = useState<Interval>(sub?.interval ?? 'monthly');
  const [nextDate, setNextDate] = useState(sub?.nextDate ?? '');
  const [category, setCategory] = useState(sub?.category ?? '');
  const [companyId, setCompanyId] = useState(sub?.companyId ?? '');
  const [notes, setNotes] = useState(sub?.notes ?? '');
  const [autoCreateExpense, setAuto] = useState(sub?.autoCreateExpense ?? false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        vendor: vendor.trim() || undefined,
        companyId: companyId || undefined,
        amount: Number(amount),
        currency,
        interval,
        nextDate,
        category: category.trim() || undefined,
        notes: notes.trim() || undefined,
        autoCreateExpense,
      };
      return mode === 'edit' && sub
        ? api.patch(`/recurring-payments/${sub.id}`, { ...payload, isActive: sub.isActive, version: sub.version })
        : api.post('/recurring-payments', { ...payload, isActive: true });
    },
    onSuccess: () => { toast(mode === 'edit' ? t('subs.updated') : t('subs.created')); onSaved(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError(t('common.nameRequired')); return; }
    if (!(Number(amount) > 0)) { setError(t('subs.amount')); return; }
    if (!nextDate) { setError(t('subs.nextDate')); return; }
    save.mutate();
  };

  return (
    <Dialog open onClose={onClose} title={mode === 'edit' ? t('subs.edit') : t('subs.new')} width={480}>
      <form onSubmit={submit} className="space-y-3 px-4 pb-4 pt-1">
        <LabeledField label={t('subs.name')}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('subs.namePlaceholder')} />
        </LabeledField>
        <LabeledField label={t('subs.vendor')}>
          <Input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder={t('subs.vendorPlaceholder')} />
        </LabeledField>
        <div className="grid grid-cols-[minmax(0,1fr)_90px] gap-3">
          <LabeledField label={t('subs.amount')}>
            <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </LabeledField>
          <LabeledField label={t('common.currency')}>
            <Select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full">
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </LabeledField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <LabeledField label={t('subs.interval')}>
            <Select value={interval} onChange={(e) => setInterval(e.target.value as Interval)} className="w-full">
              {INTERVALS.map((iv) => <option key={iv} value={iv}>{t(`subs.every.${iv}`)}</option>)}
            </Select>
          </LabeledField>
          <LabeledField label={t('subs.nextDate')}>
            <Input type="date" value={nextDate} onChange={(e) => setNextDate(e.target.value)} />
          </LabeledField>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <LabeledField label={t('subs.category')}>
            <Input value={category} onChange={(e) => setCategory(e.target.value)} placeholder={t('subs.categoryPlaceholder')} />
          </LabeledField>
          <LabeledField label={t('subs.company')}>
            <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="w-full">
              <option value="">{t('subs.noneSelected')}</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </LabeledField>
        </div>
        <LabeledField label={t('subs.notes')}>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </LabeledField>

        <div className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">{t('subs.autoExpense')}</div>
            <div className="text-xs text-muted-foreground">{t('subs.autoExpenseHint')}</div>
          </div>
          <Switch checked={autoCreateExpense} onChange={setAuto} />
        </div>

        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={save.isPending}>
            {save.isPending ? <Spinner /> : mode === 'edit' ? t('common.save') : t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
