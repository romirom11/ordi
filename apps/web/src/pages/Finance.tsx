import { useId, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { appOrigin, api, qs, ApiError } from '../lib/api';
import { useNavigate, useOpen, type OpenIntent } from '../lib/router';
import { useCan } from '../lib/auth';
import { useTabs } from '../lib/tabs';
import { Button, Input, Select, Card, PageHeader, EmptyState, Reveal, Skeleton, SegmentedControl, fmtMoney, fmtDate, cn } from '../components/ui';
import { Dialog, ContextMenu, toast, type ContextMenuEntry } from '../components/overlays';
import { Plus, Wallet, AlertTriangle, CheckCircle2, Receipt, FileStack, Copy, ExternalLink, Link2, RotateCw } from 'lucide-react';
import { useT, extendDict } from '../lib/i18n';
import { usePersistedState, oneOfPref, stringPref } from '../lib/prefs';
import { byName } from '../lib/queries';
import { currencyOptions } from '../lib/currency';
import { useDefaultCurrency } from '../components/finance/workspace';
import { RecurringExpensesSection } from '../components/finance/subscriptions';
import { SortHeader, sortRows, useStatusRank, useTableSort } from '../components/tableSort';
import { TransactionsTab, AddIncomeDialog } from '../components/finance/ledger';
import { DateField } from '../components/DatePicker';
import { DocumentForm, type DocumentFormValues } from '../components/finance/DocumentForm';
import { queryView, type QueryView } from '../components/finance/queryState';

extendDict({
  en: {
    'finance.newExpense': 'New expense',
    'finance.oneOffTitle': 'One-off expenses',
    'finance.status.draft': 'Draft',
    'finance.status.sent': 'Sent',
    'finance.status.viewed': 'Viewed',
    'finance.status.partially_paid': 'Partially paid',
    'finance.status.paid': 'Paid',
    'finance.status.canceled': 'Canceled',
    'finance.status.overdue': 'Overdue',
    'finance.status.accepted': 'Accepted',
    'finance.status.declined': 'Declined',
    'finance.status.expired': 'Expired',
    'finance.status.open': 'Open',
    'finance.openInNewTab': 'Open in new tab',
    'finance.copyLink': 'Copy link',
    'finance.copyPublicLink': 'Copy public link',
    'finance.linkCopied': 'Link copied',
    'finance.colNumber': 'Number',
  },
  uk: {
    'finance.newExpense': 'Нова витрата',
    'finance.oneOffTitle': 'Разові витрати',
    'finance.status.draft': 'Чернетка',
    'finance.status.sent': 'Надіслано',
    'finance.status.viewed': 'Переглянуто',
    'finance.status.partially_paid': 'Частково оплачено',
    'finance.status.paid': 'Оплачено',
    'finance.status.canceled': 'Скасовано',
    'finance.status.overdue': 'Прострочено',
    'finance.status.accepted': 'Прийнято',
    'finance.status.declined': 'Відхилено',
    'finance.status.expired': 'Термін минув',
    'finance.status.open': 'Відкрито',
    'finance.openInNewTab': 'Відкрити в новій вкладці',
    'finance.copyLink': 'Скопіювати посилання',
    'finance.copyPublicLink': 'Скопіювати публічне посилання',
    'finance.linkCopied': 'Посилання скопійовано',
    'finance.colNumber': 'Номер',
  },
});

function copyToClipboard(text: string, msg: string) {
  navigator.clipboard?.writeText(text).then(() => toast(msg)).catch(() => toast.error(msg));
}

type Tone = 'faint' | 'primary' | 'success' | 'warning' | 'destructive';
const STATUS_TONE: Record<string, Tone> = {
  draft: 'faint', open: 'primary', sent: 'primary', viewed: 'primary',
  partially_paid: 'warning', paid: 'success', accepted: 'success',
  canceled: 'faint', declined: 'destructive', expired: 'faint', overdue: 'destructive',
};
const TONE_CLASS: Record<Tone, string> = {
  faint: 'bg-muted text-muted-foreground',
  primary: 'bg-primary/15 text-primary',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  destructive: 'bg-destructive/15 text-destructive',
};

function StatusPill({ status, overdue }: { status?: string | null; overdue?: boolean }) {
  const t = useT();
  const key = overdue ? 'overdue' : status ?? 'draft';
  const tone = STATUS_TONE[key] ?? 'faint';
  return (
    <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium', TONE_CLASS[tone])}>
      {overdue && <span className="h-1.5 w-1.5 rounded-full bg-destructive" />}
      {t(`finance.status.${key}`, key.replace('_', ' '))}
    </span>
  );
}

/**
 * A first load that failed. Deliberately not an empty state: "no invoices" or
 * a 0 total would be a claim about the business the app cannot make.
 */
function LoadFailed({ onRetry, retrying, compact }: { onRetry: () => void; retrying: boolean; compact?: boolean }) {
  const t = useT();
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center gap-1.5 text-center', compact ? 'px-4 py-6' : 'rounded-xl border border-border py-12')}>
      <AlertTriangle size={18} className="text-warning" aria-hidden />
      <p className="text-sm font-medium">{t('finance.loadFailed', 'Couldn’t load this data')}</p>
      <p className="max-w-sm text-[13px] text-muted-foreground">{t('finance.loadFailedHint', 'Check your connection and try again.')}</p>
      <Button size="sm" variant="outline" className="mt-2" onClick={onRetry} disabled={retrying}>
        <RotateCw size={13} className={cn(retrying && 'animate-spin')} /> {t('common.retry', 'Retry')}
      </Button>
    </div>
  );
}

/** A refetch failed; what is on screen is the last data that did load. */
function StaleNotice({ onRetry, retrying, className }: { onRetry: () => void; retrying: boolean; className?: string }) {
  const t = useT();
  return (
    <div role="status" className={cn('flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-xs', className)}>
      <AlertTriangle size={13} className="shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 flex-1">{t('finance.staleData', 'Couldn’t refresh – showing the last loaded data.')}</span>
      <Button size="xs" variant="ghost" onClick={onRetry} disabled={retrying}>
        <RotateCw size={12} className={cn(retrying && 'animate-spin')} /> {t('common.retry', 'Retry')}
      </Button>
    </div>
  );
}

interface Company { id: string; name: string; defaultCurrency?: string }
interface DocRow {
  id: string;
  number?: string | null;
  companyId?: string | null;
  companyName?: string | null;
  status?: string | null;
  total?: number | string | null;
  currency?: string | null;
  dueDate?: string | null;
  validUntil?: string | null;
  isOverdue?: boolean;
  is_overdue?: boolean;
  publicToken?: string | null;
}
interface Expense { id: string; description?: string | null; category?: string | null; amount?: number | string; currency?: string; date?: string | null; projectName?: string | null }
interface ProfitRow {
  projectId?: string; name?: string; label?: string; revenue?: number | string; cost?: number | string;
  laborCost?: number | string; expenseCost?: number | string;
  margin?: number | string; marginPct?: number | string; marginPercent?: number | string; currency?: string;
}
type Tab = 'dashboard' | 'invoices' | 'quotes' | 'expenses' | 'transactions';

export function FinancePage() {
  const t = useT();
  const can = useCan();
  const [tab, setTab] = usePersistedState<Tab>(
    'ordi:view:finance.tab', 'dashboard',
    oneOfPref(['dashboard', 'invoices', 'quotes', 'expenses', 'transactions'], 'dashboard'),
  );
  const [incomeOpen, setIncomeOpen] = useState(false);
  const tabs: { key: Tab; label: string }[] = [
    { key: 'dashboard', label: t('nav.dashboard') },
    { key: 'invoices', label: t('finance.invoices') },
    { key: 'quotes', label: t('finance.quotes') },
    { key: 'expenses', label: t('finance.expenses') },
    { key: 'transactions', label: t('ledger.transactions') },
  ];
  return (
    <div>
      <PageHeader
        title={t('nav.finance')}
        actions={
          <div className="flex items-center gap-2">
            {can('finance.write') && (
              <Button size="sm" variant="outline" className="text-success" onClick={() => setIncomeOpen(true)}>
                <Plus size={14} /> {t('ledger.addIncome')}
              </Button>
            )}
            {/* Five segments do not fit a phone-width header; there the same
              * choice is a select, so nothing is pushed off-screen. */}
            <div className="hidden md:block">
              <SegmentedControl options={tabs} value={tab} onChange={setTab} />
            </div>
            <Select
              aria-label={t('finance.section', 'Finance section')}
              value={tab}
              onChange={(e) => setTab(e.target.value as Tab)}
              className="md:hidden"
            >
              {tabs.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </Select>
          </div>
        }
      />
      <Reveal key={tab}>
        {tab === 'dashboard' && <DashboardView />}
        {tab === 'invoices' && <InvoicesView />}
        {tab === 'quotes' && <QuotesView />}
        {tab === 'expenses' && <ExpensesView />}
        {tab === 'transactions' && <TransactionsTab />}
      </Reveal>
      {incomeOpen && <AddIncomeDialog onClose={() => setIncomeOpen(false)} />}
    </div>
  );
}

function useCompanies() {
  // The default page is the 50 newest companies – a picker needs all of them.
  return useQuery({ queryKey: ['companies', 'finance'], queryFn: () => api.get<{ data: Company[] }>('/companies?limit=200') });
}

interface AgingRow { currency: string; bucket_0_30: number; bucket_31_60: number; bucket_61_90: number; bucket_90_plus: number; total: number }
interface OverdueRow { id: string; number?: string | null; companyId?: string; companyName?: string | null; currency: string; dueDate: string; outstanding: number }
interface InvoicedPaidRow { currency: string; invoiced: number; paid: number }
interface FinanceDashboard {
  asOf?: string;
  receivables?: { total?: Record<string, number>; aging?: AgingRow[] };
  invoicedPaid?: InvoicedPaidRow[];
  overdue?: OverdueRow[];
  unbilledBillableHours?: number;
}

/** Sums a per-currency map/array of {currency, amount} rows into one number for display (single-currency workspaces are the common case). */
function sumValues(rec?: Record<string, number>): number {
  return Object.values(rec ?? {}).reduce((a, v) => a + Number(v || 0), 0);
}
function primaryCurrency(d?: FinanceDashboard): string {
  return Object.keys(d?.receivables?.total ?? {})[0] ?? d?.invoicedPaid?.[0]?.currency ?? d?.overdue?.[0]?.currency ?? 'USD';
}

function DashboardView() {
  const t = useT();
  const can = useCan();
  const dash = useQuery({ queryKey: ['financeDashboard'], queryFn: () => api.get<FinanceDashboard>('/finance/dashboard') });
  const d = dash.data;
  const currency = primaryCurrency(d);
  const agingRows = d?.receivables?.aging ?? [];
  const agingBuckets: { label: string; key: keyof AgingRow }[] = [
    { label: '0–30', key: 'bucket_0_30' },
    { label: '31–60', key: 'bucket_31_60' },
    { label: '61–90', key: 'bucket_61_90' },
    { label: '90+', key: 'bucket_90_plus' },
  ];
  const agingVal = (key: keyof AgingRow): number => agingRows.reduce((a, r) => a + Number(r[key] ?? 0), 0);
  const { view, stale } = queryView(dash);
  const retry = () => { void dash.refetch(); };

  const outstandingTotal = sumValues(d?.receivables?.total);
  const overdueTotal = (d?.overdue ?? []).reduce((a, r) => a + Number(r.outstanding || 0), 0);
  const paidPeriod = (d?.invoicedPaid ?? []).reduce((a, r) => a + Number(r.paid || 0), 0);
  const invoicedPeriod = (d?.invoicedPaid ?? []).reduce((a, r) => a + Number(r.invoiced || 0), 0);

  if (view === 'loading') {
    return (
      <div className="space-y-6 p-6">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      {view === 'error' ? <LoadFailed onRetry={retry} retrying={dash.isFetching} /> : <>
      {stale && <StaleNotice onRetry={retry} retrying={dash.isFetching} />}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(13rem,1fr))] gap-4">
        <Tile icon={<Wallet size={16} />} label={t('finance.outstanding')} value={fmtMoney(outstandingTotal, currency)} />
        <Tile icon={<AlertTriangle size={16} />} label={t('common.overdue')} value={fmtMoney(overdueTotal, currency)} tone="destructive" />
        <Tile icon={<CheckCircle2 size={16} />} label={t('finance.paidPeriod')} value={fmtMoney(paidPeriod, currency)} tone="success" />
        <Tile icon={<Receipt size={16} />} label={t('finance.invoicedPeriod')} value={fmtMoney(invoicedPeriod, currency)} />
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-2.5 text-[13px] font-medium">{t('finance.receivablesAging')}</div>
        <div className="overflow-x-auto">
        <table className="w-full min-w-[22rem] text-[13px]">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              {agingBuckets.map((b) => <th key={b.label} className="px-4 py-2 font-medium">{b.label}</th>)}
            </tr>
          </thead>
          <tbody>
            <tr>
              {agingBuckets.map((b) => <td key={b.label} className="px-4 py-2 tabular-nums">{fmtMoney(agingVal(b.key), currency)}</td>)}
            </tr>
          </tbody>
        </table>
        </div>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-2.5 text-[13px] font-medium">{t('finance.overdueInvoices')}</div>
          <div className="divide-y divide-border">
            {(d?.overdue ?? []).length === 0 && <p className="px-4 py-6 text-[13px] text-muted-foreground">{t('finance.nothingOverdue')}</p>}
            {(d?.overdue ?? []).map((iv) => (
              <div key={iv.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                <span className="font-medium">{iv.number ?? iv.id}</span>
                <span className="min-w-0 flex-1 truncate text-center text-muted-foreground">{iv.companyName ?? ''}</span>
                <span className="tabular-nums font-medium text-destructive">{fmtMoney(iv.outstanding ?? 0, iv.currency ?? currency)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-4">
          <div className="text-[13px] font-medium text-muted-foreground">{t('finance.unbilledHours')}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{Number(d?.unbilledBillableHours ?? 0).toFixed(1)}h</div>
          <p className="mt-1 text-xs text-muted-foreground">{t('finance.unbilledHint')}</p>
        </Card>
      </div>
      </>}

      {can('finance.read_costs') && <ProfitabilityView />}
    </div>
  );
}

function Tile({ label, value, icon, tone }: { label: string; value: string; icon: ReactNode; tone?: 'success' | 'destructive' }) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <div className={cn(
        'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
        tone === 'destructive' ? 'bg-destructive/15 text-destructive' : tone === 'success' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground',
      )}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="truncate text-xs text-muted-foreground">{label}</div>
        <div className={cn('text-xl font-semibold tabular-nums', tone === 'destructive' && 'text-destructive')}>{value}</div>
      </div>
    </Card>
  );
}

type ProfitSortKey = 'name' | 'revenue' | 'cost' | 'margin' | 'pct';

/** Cost and margin come in several API shapes – one place derives them for cells and sorting alike. */
function profitDerived(r: ProfitRow) {
  const cost = Number(r.cost ?? (Number(r.laborCost ?? 0) + Number(r.expenseCost ?? 0)));
  const margin = Number(r.margin ?? Number(r.revenue ?? 0) - cost);
  const marginPct = r.marginPct ?? r.marginPercent;
  return { cost, margin, marginPct };
}

function ProfitabilityView() {
  const t = useT();
  const prof = useQuery({ queryKey: ['profitability', 'project'], queryFn: () => api.get<{ rows: ProfitRow[] }>('/finance/profitability' + qs({ scope: 'project' })) });
  const rows = prof.data?.rows ?? [];
  const { view, stale } = queryView(prof, (d) => ((d as { rows?: ProfitRow[] }).rows ?? []).length === 0);
  const retry = () => { void prof.refetch(); };
  const { sort, toggle: toggleSort } = useTableSort<ProfitSortKey>();
  const sorted = sortRows(rows, sort, (r, key) => {
    const d = profitDerived(r);
    switch (key) {
      case 'name': return (r.label ?? r.name ?? '').toLowerCase() || null;
      case 'revenue': return Number(r.revenue ?? 0);
      case 'cost': return d.cost;
      case 'margin': return d.margin;
      case 'pct': return d.marginPct != null ? Number(d.marginPct) : null;
    }
  });
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-4 py-2.5 text-[13px] font-medium">{t('finance.profitabilityByProject')}</div>
      {stale && <StaleNotice onRetry={retry} retrying={prof.isFetching} className="m-3" />}
      {view === 'error' ? <LoadFailed compact onRetry={retry} retrying={prof.isFetching} /> : (
      <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-[13px]">
        <thead>
          <tr className="text-left text-[11px]">
            <th className="px-4 py-2"><SortHeader label={t('time.groupProject')} sortKey="name" sort={sort} onToggle={toggleSort} /></th>
            <th className="px-4 py-2"><SortHeader label={t('finance.revenue')} sortKey="revenue" sort={sort} onToggle={toggleSort} className="w-full justify-end" /></th>
            <th className="px-4 py-2"><SortHeader label={t('finance.cost')} sortKey="cost" sort={sort} onToggle={toggleSort} className="w-full justify-end" /></th>
            <th className="px-4 py-2"><SortHeader label={t('finance.margin')} sortKey="margin" sort={sort} onToggle={toggleSort} className="w-full justify-end" /></th>
            <th className="px-4 py-2"><SortHeader label="%" sortKey="pct" sort={sort} onToggle={toggleSort} className="w-full justify-end" /></th>
          </tr>
        </thead>
        <tbody>
          {view === 'loading' && <tr><td colSpan={5} className="px-4 py-3"><Skeleton className="h-5 w-full" /></td></tr>}
          {view === 'empty' && <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">{t('finance.noProfitability')}</td></tr>}
          {sorted.map((r, i) => {
            const cur = r.currency ?? 'USD';
            const { cost, margin, marginPct } = profitDerived(r);
            return (
              <tr key={r.projectId ?? r.name ?? r.label ?? String(i)} className="border-t border-border">
                <td className="px-4 py-2">{r.label ?? r.name ?? '–'}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(r.revenue ?? 0, cur)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(cost, cur)}</td>
                <td className={cn('px-4 py-2 text-right tabular-nums', margin < 0 && 'text-destructive')}>{fmtMoney(margin, cur)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{marginPct != null ? `${Number(marginPct).toFixed(0)}%` : '–'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
      )}
    </Card>
  );
}

function InvoicesView() {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const open = useOpen();
  const can = useCan();
  const [status, setStatus] = usePersistedState('ordi:view:finance.invoices.status', '', stringPref());
  const [showForm, setShowForm] = useState(false);
  const companies = useCompanies();
  const invoices = useQuery({ queryKey: ['invoices', status], queryFn: () => api.get<{ data: DocRow[] }>('/invoices' + qs({ status })) });
  const defaultCurrency = useDefaultCurrency();
  const create = useMutation({
    mutationFn: (v: DocumentFormValues) =>
      api.post<{ id: string }>('/invoices', {
        companyId: v.companyId,
        issueDate: v.issueDate,
        dueDate: v.endDate,
        currency: v.currency,
        language: v.language,
        discountType: v.discountType,
        discountValue: v.discountValue,
        items: v.items,
      }),
    onSuccess: (r) => {
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ['invoices'] });
      toast(t('common.saved'));
      if (r?.id) navigate(`/finance/invoices/${r.id}`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });
  const rows = invoices.data?.data ?? [];
  const { view, stale } = queryView(invoices, docsEmpty);

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select aria-label={t('common.status')} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('common.allStatuses')}</option>
          {['draft', 'sent', 'viewed', 'partially_paid', 'paid', 'canceled'].map((s) => <option key={s} value={s}>{t(`finance.status.${s}`, s.replace('_', ' '))}</option>)}
        </Select>
        {can('finance.write') && <Button size="sm" className="ml-auto" onClick={() => setShowForm(true)}><Plus size={14} /> {t('finance.newInvoice')}</Button>}
      </div>
      {stale && <StaleNotice className="mb-3" onRetry={() => void invoices.refetch()} retrying={invoices.isFetching} />}
      <DocTable rows={rows} view={view} onRetry={() => void invoices.refetch()} retrying={invoices.isFetching} kind="invoice" companies={companies.data?.data} onRow={(id, e) => open(`/finance/invoices/${id}`, e)} />

      {can('finance.write') && (
        <Dialog open={showForm} onClose={() => setShowForm(false)} title={t('finance.newInvoice')} width={560}>
          {showForm && (
            <DocumentForm kind="invoice" mode="create" companies={companies.data?.data ?? []} defaultCurrency={defaultCurrency} onSubmit={(v) => create.mutate(v)} onCancel={() => setShowForm(false)} pending={create.isPending} submitLabel={t('finance.createDraft')} />
          )}
        </Dialog>
      )}
    </div>
  );
}

function QuotesView() {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const [status, setStatus] = usePersistedState('ordi:view:finance.quotes.status', '', stringPref());
  const [showForm, setShowForm] = useState(false);
  const companies = useCompanies();
  const quotes = useQuery({ queryKey: ['quotes', status], queryFn: () => api.get<{ data: DocRow[] }>('/quotes' + qs({ status })) });
  const defaultCurrency = useDefaultCurrency();
  const create = useMutation({
    mutationFn: (v: DocumentFormValues) =>
      api.post('/quotes', {
        companyId: v.companyId,
        issueDate: v.issueDate,
        validUntil: v.endDate,
        currency: v.currency,
        language: v.language,
        discountType: v.discountType,
        discountValue: v.discountValue,
        items: v.items,
      }),
    onSuccess: () => {
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ['quotes'] });
      toast(t('common.saved'));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });
  const rows = quotes.data?.data ?? [];
  const { view, stale } = queryView(quotes, docsEmpty);

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select aria-label={t('common.status')} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('common.allStatuses')}</option>
          {['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired'].map((s) => <option key={s} value={s}>{t(`finance.status.${s}`, s)}</option>)}
        </Select>
        {can('finance.write') && <Button size="sm" className="ml-auto" onClick={() => setShowForm(true)}><Plus size={14} /> {t('finance.newQuote')}</Button>}
      </div>
      {stale && <StaleNotice className="mb-3" onRetry={() => void quotes.refetch()} retrying={quotes.isFetching} />}
      <DocTable rows={rows} view={view} onRetry={() => void quotes.refetch()} retrying={quotes.isFetching} kind="quote" companies={companies.data?.data} />

      {can('finance.write') && (
        <Dialog open={showForm} onClose={() => setShowForm(false)} title={t('finance.newQuote')} width={560}>
          {showForm && (
            <DocumentForm kind="quote" mode="create" companies={companies.data?.data ?? []} defaultCurrency={defaultCurrency} onSubmit={(v) => create.mutate(v)} onCancel={() => setShowForm(false)} pending={create.isPending} submitLabel={t('finance.createDraft')} />
          )}
        </Dialog>
      )}
    </div>
  );
}

/** Lifecycle order per document kind, so the status column sorts by progress. */
const INVOICE_STATUS_ORDER = ['draft', 'sent', 'viewed', 'partially_paid', 'overdue', 'paid', 'canceled'];
const QUOTE_STATUS_ORDER = ['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired'];

type DocSortKey = 'number' | 'company' | 'status' | 'date' | 'total';

const docsEmpty = (d: unknown): boolean => ((d as { data?: DocRow[] }).data ?? []).length === 0;

function DocTable({ rows, view, onRetry, retrying, kind, onRow, companies }: {
  rows: DocRow[]; view: QueryView; onRetry: () => void; retrying: boolean;
  kind: 'invoice' | 'quote'; onRow?: (id: string, e?: OpenIntent) => void; companies?: Company[];
}) {
  const t = useT();
  const tabs = useTabs();
  // The list endpoints return companyId only – resolve names client-side.
  const companyName = (r: DocRow): string | null =>
    r.companyName ?? (r.companyId ? companies?.find((c) => c.id === r.companyId)?.name ?? null : null);

  const { sort, toggle: toggleSort } = useTableSort<DocSortKey>({
    key: `ordi:view:finance.${kind}s.sort`,
    keys: ['number', 'company', 'status', 'date', 'total'],
  });
  const statusRank = useStatusRank(kind === 'invoice' ? INVOICE_STATUS_ORDER : QUOTE_STATUS_ORDER);
  const sorted = useMemo(() => sortRows(rows, sort, (r, key) => {
    switch (key) {
      case 'number': return r.number?.toLowerCase() || null;
      case 'company': return companyName(r)?.toLowerCase() || null;
      case 'status': {
        const s = (kind === 'invoice' && (r.isOverdue || r.is_overdue)) ? 'overdue' : r.status;
        return s ? statusRank.get(s) ?? null : null;
      }
      case 'date': return (kind === 'invoice' ? r.dueDate : r.validUntil) ?? null;
      case 'total': return r.total != null ? Number(r.total) : null;
    }
  }), [rows, sort, statusRank, kind, companies]);

  if (view === 'loading') {
    return (
      <div className="overflow-hidden rounded-xl border border-border">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={cn('flex items-center gap-3 px-4 py-3', i > 0 && 'border-t border-border')}>
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="ml-auto h-4 w-20" />
          </div>
        ))}
      </div>
    );
  }
  if (view === 'error') return <LoadFailed onRetry={onRetry} retrying={retrying} />;
  if (rows.length === 0) {
    return kind === 'invoice'
      ? <EmptyState icon={<Receipt size={20} />} title={t('public.noInvoices')} hint={t('finance.noInvoicesHint')} />
      : <EmptyState icon={<FileStack size={20} />} title={t('public.noQuotes')} hint={t('finance.noQuotesHint')} />;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {/* The lists never had a header – these double as the sort controls.
        * Below sm a row is two lines – company and amount first, then number,
        * status and date – so the company never collapses to nothing; the
        * header keeps the two sorts that still have a column. */}
      <div className="flex items-center gap-3 border-b border-border bg-muted/30 px-4 py-2 text-[11px]">
        <SortHeader label={t('finance.colNumber')} sortKey="number" sort={sort} onToggle={toggleSort} className="hidden w-28 shrink-0 sm:flex" />
        <SortHeader label={t('common.company')} sortKey="company" sort={sort} onToggle={toggleSort} className="min-w-0 flex-1" />
        <SortHeader label={t('common.status')} sortKey="status" sort={sort} onToggle={toggleSort} className="hidden w-24 shrink-0 sm:flex" />
        <SortHeader
          label={kind === 'invoice' ? t('finance.dueDate') : t('public.validUntil')}
          sortKey="date" sort={sort} onToggle={toggleSort} className="hidden w-20 shrink-0 justify-end sm:flex"
        />
        <SortHeader label={t('public.amount')} sortKey="total" sort={sort} onToggle={toggleSort} className="w-24 shrink-0 justify-end" />
      </div>
      {sorted.map((r, i) => {
        const overdue = kind === 'invoice' && (r.isOverdue || r.is_overdue || r.status === 'overdue');
        const detailUrl = `/finance/invoices/${r.id}`;
        const row = (
          <div
            role={onRow ? 'button' : undefined}
            tabIndex={onRow ? 0 : undefined}
            onClick={onRow ? (e) => onRow(r.id, e) : undefined}
            onAuxClick={onRow ? (e) => onRow(r.id, e) : undefined}
            onKeyDown={onRow ? (e) => { if (e.key === 'Enter' || e.key === ' ') onRow(r.id, e); } : undefined}
            className={cn(
              'row-enter grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left transition-colors duration-150 sm:flex sm:gap-3',
              i > 0 && 'border-t border-border',
              onRow && 'cursor-pointer hover:bg-muted/60',
            )}
            style={{ ['--i' as string]: Math.min(i, 10) }}
          >
            <span className="order-1 min-w-0 truncate text-[13px] font-medium sm:order-2 sm:flex-1">{companyName(r) ?? '–'}</span>
            <span className="order-2 text-right text-[13px] font-semibold tabular-nums sm:order-5 sm:w-24 sm:shrink-0">{fmtMoney(r.total ?? 0, r.currency ?? 'USD')}</span>
            <span className="order-3 col-span-2 flex min-w-0 items-center gap-2 sm:contents">
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground sm:order-1 sm:w-28 sm:shrink-0">{r.number ?? r.id.slice(0, 8)}</span>
              <span className="flex shrink-0 sm:order-3 sm:w-24"><StatusPill status={r.status} overdue={overdue} /></span>
              <span className="ml-auto shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:order-4 sm:ml-0 sm:w-20">
                {fmtDate(kind === 'invoice' ? r.dueDate : r.validUntil)}
              </span>
            </span>
          </div>
        );
        if (kind !== 'invoice' || !onRow) return <div key={r.id}>{row}</div>;
        const menu: ContextMenuEntry[] = [
          { key: 'open', label: t('finance.openInNewTab'), icon: <ExternalLink size={14} />, onSelect: () => tabs?.openInNewTab(detailUrl) },
          { key: 'copy', label: t('finance.copyLink'), icon: <Copy size={14} />, onSelect: () => copyToClipboard(`${appOrigin()}${detailUrl}`, t('finance.linkCopied')) },
          ...(r.publicToken
            ? [{ key: 'copyPublic', label: t('finance.copyPublicLink'), icon: <Link2 size={14} />, onSelect: () => copyToClipboard(`${appOrigin()}/i/${r.publicToken}`, t('finance.linkCopied')) } as ContextMenuEntry]
            : []),
        ];
        return <ContextMenu key={r.id} items={menu}>{row}</ContextMenu>;
      })}
    </div>
  );
}

function ExpensesView() {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const expenses = useQuery({ queryKey: ['expenses'], queryFn: () => api.get<{ data: Expense[] }>('/expenses') });
  // The form's currency starts at the workspace default (ORD-24): it used to
  // be a free-text box stuck on USD, so every UAH expense landed in dollars.
  const defaultCurrency = useDefaultCurrency();
  const [showForm, setShowForm] = useState(false);
  const uid = useId();
  const blankForm = (currency: string) => ({ description: '', amount: '', currency, date: '', category: '' });
  const [form, setForm] = useState(() => blankForm(defaultCurrency));
  const openForm = () => { setForm(blankForm(defaultCurrency)); setShowForm(true); };
  const create = useMutation({
    mutationFn: () => api.post('/expenses', { description: form.description, amount: Number(form.amount), currency: form.currency, date: form.date || undefined, category: form.category || undefined }),
    onSuccess: () => {
      setForm(blankForm(defaultCurrency));
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ['expenses'] });
      toast(t('common.saved'));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });
  const rows = expenses.data?.data ?? [];
  const { view: expView, stale: expStale } = queryView(expenses, (d) => ((d as { data?: Expense[] }).data ?? []).length === 0);
  const retryExpenses = () => { void expenses.refetch(); };

  return (
    <div className="space-y-8 p-6">
      {/* Recurring expenses (subscriptions merged in: підписки самі по собі і є витратами) */}
      <RecurringExpensesSection />

      {/* One-off expenses */}
      <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold">
          <Receipt size={15} className="text-muted-foreground" />
          {t('finance.oneOffTitle')}
          {rows.length > 0 && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">{rows.length}</span>
          )}
        </h2>
        {can('finance.write') && <Button size="sm" variant="outline" onClick={openForm}><Plus size={14} /> {t('finance.newExpense')}</Button>}
      </div>
      {expStale && <StaleNotice onRetry={retryExpenses} retrying={expenses.isFetching} />}
      {expView === 'loading' ? (
        <div className="overflow-hidden rounded-xl border border-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className={cn('flex items-center gap-3 px-4 py-3', i > 0 && 'border-t border-border')}>
              <Skeleton className="h-4 w-16" /><Skeleton className="h-4 w-40" /><Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      ) : expView === 'error' ? (
        <LoadFailed onRetry={retryExpenses} retrying={expenses.isFetching} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Receipt size={20} />} title={t('finance.noExpenses')} hint={t('finance.noExpensesHint')} action={can('finance.write') ? <Button size="sm" variant="outline" onClick={openForm}><Plus size={13} /> {t('finance.newExpense')}</Button> : undefined} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((e, i) => (
            <div key={e.id} className={cn('row-enter flex items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-muted/40', i > 0 && 'border-t border-border')} style={{ ['--i' as string]: Math.min(i, 10) }}>
              <span className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">{fmtDate(e.date)}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{e.description ?? '–'}</div>
                {(e.category || e.projectName) && (
                  <div className="truncate text-xs text-muted-foreground">{[e.category, e.projectName].filter(Boolean).join(' · ')}</div>
                )}
              </div>
              <span className="shrink-0 text-[13px] font-semibold tabular-nums">{fmtMoney(e.amount ?? 0, e.currency ?? 'USD')}</span>
            </div>
          ))}
        </div>
      )}
      </section>

      {can('finance.write') && (
        <Dialog open={showForm} onClose={() => setShowForm(false)} title={t('finance.newExpense')} width={440}>
          <form className="space-y-3 px-4 pb-4 pt-1" onSubmit={(e) => { e.preventDefault(); if (Number(form.amount) > 0) create.mutate(); }}>
            <div className="space-y-1">
              <label htmlFor={`${uid}-description`} className="text-xs font-medium text-muted-foreground">{t('public.description')}</label>
              <Input id={`${uid}-description`} autoFocus value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <label htmlFor={`${uid}-amount`} className="text-xs font-medium text-muted-foreground">{t('public.amount')}</label>
                <Input id={`${uid}-amount`} type="number" min={0} step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label htmlFor={`${uid}-currency`} className="text-xs font-medium text-muted-foreground">{t('common.currency')}</label>
                <Select id={`${uid}-currency`} value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))} className="w-full">
                  {currencyOptions(form.currency).map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </div>
              <div className="space-y-1">
                <label htmlFor={`${uid}-date`} className="text-xs font-medium text-muted-foreground">{t('common.date')}</label>
                <DateField id={`${uid}-date`} name="date" value={form.date} onChange={(v) => setForm((f) => ({ ...f, date: v ?? '' }))} clearable={false} />
              </div>
              <div className="space-y-1">
                <label htmlFor={`${uid}-category`} className="text-xs font-medium text-muted-foreground">{t('finance.category')}</label>
                <Input id={`${uid}-category`} value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>{t('common.cancel')}</Button>
              <Button type="submit" size="sm" disabled={create.isPending}><Plus size={14} /> {t('common.add')}</Button>
            </div>
          </form>
        </Dialog>
      )}
    </div>
  );
}
