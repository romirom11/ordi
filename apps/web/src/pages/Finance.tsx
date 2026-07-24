import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import { Button, Input, Select, Card, PageHeader, EmptyState, Skeleton, SegmentedControl, fmtMoney, fmtDate, cn } from '../components/ui';
import { Dialog, toast } from '../components/overlays';
import { Plus, Trash2, Wallet, AlertTriangle, CheckCircle2, Receipt, FileStack } from 'lucide-react';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'finance.newExpense': 'New expense',
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
  },
  uk: {
    'finance.newExpense': 'Нова витрата',
    'finance.status.draft': 'Чернетка',
    'finance.status.sent': 'Надіслано',
    'finance.status.viewed': 'Переглянуто',
    'finance.status.partially_paid': 'Частково оплачено',
    'finance.status.paid': 'Оплачено',
    'finance.status.canceled': 'Скасовано',
    'finance.status.overdue': 'Прострочено',
    'finance.status.accepted': 'Прийнято',
    'finance.status.declined': 'Відхилено',
    'finance.status.expired': 'Прострочено (пропозиція)',
    'finance.status.open': 'Відкрито',
  },
});

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

interface Company { id: string; name: string; defaultCurrency?: string }
interface DocRow {
  id: string;
  number?: string | null;
  companyName?: string | null;
  status?: string | null;
  total?: number | string | null;
  currency?: string | null;
  dueDate?: string | null;
  validUntil?: string | null;
  isOverdue?: boolean;
  is_overdue?: boolean;
}
interface Expense { id: string; description?: string | null; category?: string | null; amount?: number | string; currency?: string; date?: string | null; projectName?: string | null }
interface ProfitRow {
  projectId?: string; name?: string; label?: string; revenue?: number | string; cost?: number | string;
  laborCost?: number | string; expenseCost?: number | string;
  margin?: number | string; marginPct?: number | string; marginPercent?: number | string; currency?: string;
}
type Tab = 'dashboard' | 'invoices' | 'quotes' | 'expenses';

export function FinancePage() {
  const t = useT();
  const [tab, setTab] = useState<Tab>('dashboard');
  const tabs: { key: Tab; label: string }[] = [
    { key: 'dashboard', label: t('nav.dashboard') },
    { key: 'invoices', label: t('finance.invoices') },
    { key: 'quotes', label: t('finance.quotes') },
    { key: 'expenses', label: t('finance.expenses') },
  ];
  return (
    <div>
      <PageHeader title={t('nav.finance')} actions={<SegmentedControl options={tabs} value={tab} onChange={setTab} />} />
      {tab === 'dashboard' && <DashboardView />}
      {tab === 'invoices' && <InvoicesView />}
      {tab === 'quotes' && <QuotesView />}
      {tab === 'expenses' && <ExpensesView />}
    </div>
  );
}

function useCompanies() {
  return useQuery({ queryKey: ['companies', 'finance'], queryFn: () => api.get<{ data: Company[] }>('/companies') });
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

  const outstandingTotal = sumValues(d?.receivables?.total);
  const overdueTotal = (d?.overdue ?? []).reduce((a, r) => a + Number(r.outstanding || 0), 0);
  const paidPeriod = (d?.invoicedPaid ?? []).reduce((a, r) => a + Number(r.paid || 0), 0);
  const invoicedPeriod = (d?.invoicedPaid ?? []).reduce((a, r) => a + Number(r.invoiced || 0), 0);

  if (dash.isLoading) {
    return (
      <div className="space-y-6 p-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Tile icon={<Wallet size={16} />} label={t('finance.outstanding')} value={fmtMoney(outstandingTotal, currency)} />
        <Tile icon={<AlertTriangle size={16} />} label={t('common.overdue')} value={fmtMoney(overdueTotal, currency)} tone="destructive" />
        <Tile icon={<CheckCircle2 size={16} />} label={t('finance.paidPeriod')} value={fmtMoney(paidPeriod, currency)} tone="success" />
        <Tile icon={<Receipt size={16} />} label={t('finance.invoicedPeriod')} value={fmtMoney(invoicedPeriod, currency)} />
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-2.5 text-[13px] font-medium">{t('finance.receivablesAging')}</div>
        <table className="w-full text-[13px]">
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

function ProfitabilityView() {
  const t = useT();
  const prof = useQuery({ queryKey: ['profitability', 'project'], queryFn: () => api.get<{ rows: ProfitRow[] }>('/finance/profitability' + qs({ scope: 'project' })) });
  const rows = prof.data?.rows ?? [];
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-4 py-2.5 text-[13px] font-medium">{t('finance.profitabilityByProject')}</div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th className="px-4 py-2 font-medium">{t('time.groupProject')}</th>
            <th className="px-4 py-2 text-right font-medium">{t('finance.revenue')}</th>
            <th className="px-4 py-2 text-right font-medium">{t('finance.cost')}</th>
            <th className="px-4 py-2 text-right font-medium">{t('finance.margin')}</th>
            <th className="px-4 py-2 text-right font-medium">%</th>
          </tr>
        </thead>
        <tbody>
          {prof.isLoading && <tr><td colSpan={5} className="px-4 py-3"><Skeleton className="h-5 w-full" /></td></tr>}
          {!prof.isLoading && rows.length === 0 && <tr><td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">{t('finance.noProfitability')}</td></tr>}
          {rows.map((r, i) => {
            const cur = r.currency ?? 'USD';
            const cost = Number(r.cost ?? (Number(r.laborCost ?? 0) + Number(r.expenseCost ?? 0)));
            const margin = Number(r.margin ?? Number(r.revenue ?? 0) - cost);
            const marginPct = r.marginPct ?? r.marginPercent;
            return (
              <tr key={r.projectId ?? r.name ?? r.label ?? String(i)} className="border-t border-border">
                <td className="px-4 py-2">{r.label ?? r.name ?? '—'}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(r.revenue ?? 0, cur)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(cost, cur)}</td>
                <td className={cn('px-4 py-2 text-right tabular-nums', margin < 0 && 'text-destructive')}>{fmtMoney(margin, cur)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{marginPct != null ? `${Number(marginPct).toFixed(0)}%` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

interface LineItem { description: string; quantity: string; unitPrice: string }
const emptyLine: LineItem = { description: '', quantity: '1', unitPrice: '' };

function DocForm({ kind, companies, onSubmit, pending }: { kind: 'invoice' | 'quote'; companies: Company[]; onSubmit: (v: { companyId: string; date: string; items: LineItem[] }) => void; pending: boolean }) {
  const t = useT();
  const [companyId, setCompanyId] = useState('');
  const [date, setDate] = useState('');
  const [items, setItems] = useState<LineItem[]>([{ ...emptyLine }]);
  const setItem = (idx: number, patch: Partial<LineItem>) => setItems((arr) => arr.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const total = items.reduce((a, it) => a + Number(it.quantity || 0) * Number(it.unitPrice || 0), 0);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (companyId) onSubmit({ companyId, date, items });
      }}
      className="space-y-3 px-4 pb-4 pt-1"
    >
      <div className="flex flex-wrap gap-3">
        <div className="min-w-48 flex-1 space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('common.company')}</label>
          <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="block w-full">
            <option value="">{t('common.select')}</option>
            {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{kind === 'invoice' ? t('finance.dueDate') : t('public.validUntil')}</label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>
      <div className="space-y-2">
        {items.map((it, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input placeholder={t('public.description')} value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} className="flex-1" />
            <Input type="number" min={0} placeholder={t('public.qty')} value={it.quantity} onChange={(e) => setItem(i, { quantity: e.target.value })} className="w-16" />
            <Input type="number" min={0} step="0.01" placeholder={t('public.price')} value={it.unitPrice} onChange={(e) => setItem(i, { unitPrice: e.target.value })} className="w-24" />
            <button type="button" className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-destructive" onClick={() => setItems((arr) => arr.filter((_, j) => j !== i))} disabled={items.length === 1}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => setItems((arr) => [...arr, { ...emptyLine }])}><Plus size={13} /> {t('finance.addLine')}</Button>
      </div>
      <div className="flex items-center justify-between border-t border-border pt-3">
        <span className="text-[13px] text-muted-foreground">{t('common.total')} <span className="font-semibold text-foreground tabular-nums">{fmtMoney(total)}</span></span>
        <Button type="submit" size="sm" disabled={pending || !companyId}>{t('finance.createDraft')}</Button>
      </div>
    </form>
  );
}

function InvoicesView() {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const can = useCan();
  const [status, setStatus] = useState('');
  const [showForm, setShowForm] = useState(false);
  const companies = useCompanies();
  const invoices = useQuery({ queryKey: ['invoices', status], queryFn: () => api.get<{ data: DocRow[] }>('/invoices' + qs({ status })) });
  const create = useMutation({
    mutationFn: (v: { companyId: string; date: string; items: LineItem[] }) =>
      api.post<{ id: string }>('/invoices', {
        companyId: v.companyId,
        dueDate: v.date || undefined,
        items: v.items.map((it) => ({ description: it.description, quantity: Number(it.quantity), unitPrice: Number(it.unitPrice) })),
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

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('common.allStatuses')}</option>
          {['draft', 'sent', 'viewed', 'partially_paid', 'paid', 'canceled'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </Select>
        {can('finance.write') && <Button size="sm" className="ml-auto" onClick={() => setShowForm(true)}><Plus size={14} /> {t('finance.newInvoice')}</Button>}
      </div>
      <DocTable rows={rows} loading={invoices.isLoading} kind="invoice" onRow={(id) => navigate(`/finance/invoices/${id}`)} />

      {can('finance.write') && (
        <Dialog open={showForm} onClose={() => setShowForm(false)} title={t('finance.newInvoice')} width={560}>
          <DocForm kind="invoice" companies={companies.data?.data ?? []} onSubmit={(v) => create.mutate(v)} pending={create.isPending} />
        </Dialog>
      )}
    </div>
  );
}

function QuotesView() {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const [status, setStatus] = useState('');
  const [showForm, setShowForm] = useState(false);
  const companies = useCompanies();
  const quotes = useQuery({ queryKey: ['quotes', status], queryFn: () => api.get<{ data: DocRow[] }>('/quotes' + qs({ status })) });
  const create = useMutation({
    mutationFn: (v: { companyId: string; date: string; items: LineItem[] }) =>
      api.post('/quotes', {
        companyId: v.companyId,
        validUntil: v.date || undefined,
        items: v.items.map((it) => ({ description: it.description, quantity: Number(it.quantity), unitPrice: Number(it.unitPrice) })),
      }),
    onSuccess: () => {
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ['quotes'] });
      toast(t('common.saved'));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });
  const rows = quotes.data?.data ?? [];

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('common.allStatuses')}</option>
          {['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired'].map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        {can('finance.write') && <Button size="sm" className="ml-auto" onClick={() => setShowForm(true)}><Plus size={14} /> {t('finance.newQuote')}</Button>}
      </div>
      <DocTable rows={rows} loading={quotes.isLoading} kind="quote" />

      {can('finance.write') && (
        <Dialog open={showForm} onClose={() => setShowForm(false)} title={t('finance.newQuote')} width={560}>
          <DocForm kind="quote" companies={companies.data?.data ?? []} onSubmit={(v) => create.mutate(v)} pending={create.isPending} />
        </Dialog>
      )}
    </div>
  );
}

function DocTable({ rows, loading, kind, onRow }: { rows: DocRow[]; loading: boolean; kind: 'invoice' | 'quote'; onRow?: (id: string) => void }) {
  const t = useT();
  if (loading) {
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
  if (rows.length === 0) {
    return kind === 'invoice'
      ? <EmptyState icon={<Receipt size={20} />} title={t('public.noInvoices')} hint={t('finance.noInvoicesHint')} />
      : <EmptyState icon={<FileStack size={20} />} title={t('public.noQuotes')} hint={t('finance.noQuotesHint')} />;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {rows.map((r, i) => {
        const overdue = kind === 'invoice' && (r.isOverdue || r.status === 'overdue');
        return (
          <div
            key={r.id}
            role={onRow ? 'button' : undefined}
            tabIndex={onRow ? 0 : undefined}
            onClick={onRow ? () => onRow(r.id) : undefined}
            onKeyDown={onRow ? (e) => { if (e.key === 'Enter') onRow(r.id); } : undefined}
            className={cn(
              'row-enter flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150',
              i > 0 && 'border-t border-border',
              onRow && 'cursor-pointer hover:bg-muted/60',
            )}
            style={{ ['--i' as string]: Math.min(i, 10) }}
          >
            <span className="w-20 shrink-0 truncate font-mono text-xs text-muted-foreground">{r.number ?? r.id.slice(0, 8)}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{r.companyName ?? '—'}</span>
            <StatusPill status={r.status} overdue={overdue} />
            <span className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
              {fmtDate(kind === 'invoice' ? r.dueDate : r.validUntil)}
            </span>
            <span className="w-24 shrink-0 text-right text-[13px] font-semibold tabular-nums">{fmtMoney(r.total ?? 0, r.currency ?? 'USD')}</span>
          </div>
        );
      })}
    </div>
  );
}

function ExpensesView() {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const expenses = useQuery({ queryKey: ['expenses'], queryFn: () => api.get<{ data: Expense[] }>('/expenses') });
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ description: '', amount: '', currency: 'USD', date: '', category: '' });
  const create = useMutation({
    mutationFn: () => api.post('/expenses', { description: form.description, amount: Number(form.amount), currency: form.currency, date: form.date || undefined, category: form.category || undefined }),
    onSuccess: () => {
      setForm({ description: '', amount: '', currency: 'USD', date: '', category: '' });
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ['expenses'] });
      toast(t('common.saved'));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });
  const rows = expenses.data?.data ?? [];

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-end">
        {can('finance.write') && <Button size="sm" onClick={() => setShowForm(true)}><Plus size={14} /> {t('finance.newExpense')}</Button>}
      </div>
      {expenses.isLoading ? (
        <div className="overflow-hidden rounded-xl border border-border">
          {[0, 1, 2].map((i) => (
            <div key={i} className={cn('flex items-center gap-3 px-4 py-3', i > 0 && 'border-t border-border')}>
              <Skeleton className="h-4 w-16" /><Skeleton className="h-4 w-40" /><Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<Receipt size={20} />} title={t('finance.noExpenses')} hint={t('finance.noExpensesHint')} action={can('finance.write') ? <Button size="sm" variant="outline" onClick={() => setShowForm(true)}><Plus size={13} /> {t('finance.newExpense')}</Button> : undefined} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((e, i) => (
            <div key={e.id} className={cn('row-enter flex items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-muted/40', i > 0 && 'border-t border-border')} style={{ ['--i' as string]: Math.min(i, 10) }}>
              <span className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">{fmtDate(e.date)}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{e.description ?? '—'}</div>
                <div className="truncate text-xs text-muted-foreground">{[e.category, e.projectName].filter(Boolean).join(' · ') || '—'}</div>
              </div>
              <span className="shrink-0 text-[13px] font-semibold tabular-nums">{fmtMoney(e.amount ?? 0, e.currency ?? 'USD')}</span>
            </div>
          ))}
        </div>
      )}

      {can('finance.write') && (
        <Dialog open={showForm} onClose={() => setShowForm(false)} title={t('finance.newExpense')} width={440}>
          <form className="space-y-3 px-4 pb-4 pt-1" onSubmit={(e) => { e.preventDefault(); if (Number(form.amount) > 0) create.mutate(); }}>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('public.description')}</label>
              <Input autoFocus value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{t('public.amount')}</label>
                <Input type="number" min={0} step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{t('common.currency')}</label>
                <Input value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{t('common.date')}</label>
                <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">{t('finance.category')}</label>
                <Input value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} />
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
