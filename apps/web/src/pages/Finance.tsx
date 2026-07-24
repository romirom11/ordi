import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import { Button, Input, Select, Card, Badge, PageHeader, EmptyState, Skeleton, fmtMoney, fmtDate, cn } from '../components/ui';
import { Plus, Trash2, AlertTriangle } from 'lucide-react';
import { useT } from '../lib/i18n';

const STATUS_COLORS: Record<string, string> = {
  draft: '#6b7280', sent: '#3b82f6', viewed: '#8b5cf6', partially_paid: '#f59e0b',
  paid: '#22c55e', canceled: '#ef4444', overdue: '#ef4444',
  accepted: '#22c55e', declined: '#ef4444', expired: '#6b7280', open: '#3b82f6',
};
function statusColor(s?: string | null): string { return (s && STATUS_COLORS[s]) || '#6b7280'; }

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
}
interface Expense { id: string; description?: string | null; category?: string | null; amount?: number | string; currency?: string; date?: string | null; projectName?: string | null }
interface ProfitRow { name?: string; label?: string; revenue?: number | string; cost?: number | string; margin?: number | string; marginPct?: number | string; currency?: string }
type Tab = 'dashboard' | 'invoices' | 'quotes' | 'expenses';

export function FinancePage() {
  const t = useT();
  const [tab, setTab] = useState<Tab>('dashboard');
  const tabs: { id: Tab; label: string }[] = [
    { id: 'dashboard', label: t('nav.dashboard') },
    { id: 'invoices', label: t('finance.invoices') },
    { id: 'quotes', label: t('finance.quotes') },
    { id: 'expenses', label: t('finance.expenses') },
  ];
  return (
    <div>
      <PageHeader
        title={t('nav.finance')}
        actions={
          <div className="flex rounded-md border border-border p-0.5 text-sm">
            {tabs.map((tb) => (
              <button key={tb.id} className={cn('rounded px-3 py-1', tab === tb.id && 'bg-muted font-medium')} onClick={() => setTab(tb.id)}>{tb.label}</button>
            ))}
          </div>
        }
      />
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

function DashboardView() {
  const t = useT();
  const can = useCan();
  const dash = useQuery({ queryKey: ['financeDashboard'], queryFn: () => api.get<any>('/finance/dashboard') });
  const d = dash.data;
  const aging = d?.aging ?? {};
  const agingBuckets: { label: string; keys: string[] }[] = [
    { label: '0–30', keys: ['b0_30', '0_30', 'current'] },
    { label: '31–60', keys: ['b31_60', '31_60'] },
    { label: '61–90', keys: ['b61_90', '61_90'] },
    { label: '90+', keys: ['b90_plus', '90_plus', 'over90'] },
  ];
  const agingVal = (keys: string[]): number => {
    for (const k of keys) if (aging[k] != null) return Number(aging[k]);
    return 0;
  };
  const currency = d?.currency ?? 'USD';

  if (dash.isLoading) return <div className="p-6"><Skeleton className="h-64 w-full" /></div>;

  return (
    <div className="space-y-6 p-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Tile label={t('finance.receivables')} value={fmtMoney(d?.receivables ?? d?.totalReceivables ?? 0, currency)} />
        <Tile label={t('common.overdue')} value={fmtMoney(d?.overdueTotal ?? 0, currency)} accent />
        <Tile label={t('finance.invoicedPeriod')} value={fmtMoney(d?.invoiced ?? 0, currency)} />
        <Tile label={t('finance.paidPeriod')} value={fmtMoney(d?.paid ?? 0, currency)} />
      </div>

      <Card className="overflow-hidden">
        <div className="border-b border-border px-4 py-2 text-sm font-medium">{t('finance.receivablesAging')}</div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              {agingBuckets.map((b) => <th key={b.label} className="px-4 py-2 font-medium">{b.label}</th>)}
            </tr>
          </thead>
          <tbody>
            <tr>
              {agingBuckets.map((b) => <td key={b.label} className="px-4 py-2 tabular-nums">{fmtMoney(agingVal(b.keys), currency)}</td>)}
            </tr>
          </tbody>
        </table>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <div className="border-b border-border px-4 py-2 text-sm font-medium">{t('finance.overdueInvoices')}</div>
          <div className="divide-y divide-border">
            {(d?.overdue ?? []).length === 0 && <p className="px-4 py-6 text-sm text-muted-foreground">{t('finance.nothingOverdue')}</p>}
            {(d?.overdue ?? []).map((iv: any) => (
              <div key={iv.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span className="font-medium">{iv.number ?? iv.id}</span>
                <span className="text-muted-foreground">{iv.companyName ?? ''}</span>
                <span className="tabular-nums">{fmtMoney(iv.total ?? 0, iv.currency ?? currency)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <div className="border-b border-border px-4 py-2 text-sm font-medium">{t('finance.unbilledHours')}</div>
          <div className="p-4 text-sm">
            <div className="text-2xl font-semibold tabular-nums">{Number(d?.unbilledHours ?? d?.unbilled?.hours ?? 0).toFixed(1)}h</div>
            <p className="mt-1 text-muted-foreground">{t('finance.unbilledHint')}</p>
          </div>
        </Card>
      </div>

      {can('finance.read_costs') && <ProfitabilityView />}
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-xl font-semibold tabular-nums', accent && 'text-destructive')}>{value}</div>
    </Card>
  );
}

function ProfitabilityView() {
  const t = useT();
  const prof = useQuery({ queryKey: ['profitability', 'project'], queryFn: () => api.get<{ data: ProfitRow[] }>('/finance/profitability' + qs({ scope: 'project' })) });
  const rows = prof.data?.data ?? [];
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-4 py-2 text-sm font-medium">{t('finance.profitabilityByProject')}</div>
      <table className="w-full text-sm">
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
            const margin = Number(r.margin ?? 0);
            return (
              <tr key={r.name ?? r.label ?? String(i)} className="border-t border-border">
                <td className="px-4 py-2">{r.label ?? r.name ?? '—'}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(r.revenue ?? 0, cur)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(r.cost ?? 0, cur)}</td>
                <td className={cn('px-4 py-2 text-right tabular-nums', margin < 0 && 'text-destructive')}>{fmtMoney(margin, cur)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{r.marginPct != null ? `${Number(r.marginPct).toFixed(0)}%` : '—'}</td>
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
    <Card className="mb-4 p-4">
      <div className="mb-3 text-sm font-medium">{kind === 'invoice' ? t('finance.newInvoice') : t('finance.newQuote')}</div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (companyId) onSubmit({ companyId, date, items });
        }}
        className="space-y-3"
      >
        <div className="flex flex-wrap gap-3">
          <label className="text-xs text-muted-foreground">
            {t('common.company')}
            <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="mt-1 block h-9 min-w-48">
              <option value="">{t('common.select')}</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </label>
          <label className="text-xs text-muted-foreground">
            {kind === 'invoice' ? t('finance.dueDate') : t('public.validUntil')}
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 block" />
          </label>
        </div>
        <div className="space-y-2">
          {items.map((it, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input placeholder={t('public.description')} value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} className="flex-1" />
              <Input type="number" min={0} placeholder={t('public.qty')} value={it.quantity} onChange={(e) => setItem(i, { quantity: e.target.value })} className="w-20" />
              <Input type="number" min={0} step="0.01" placeholder={t('public.price')} value={it.unitPrice} onChange={(e) => setItem(i, { unitPrice: e.target.value })} className="w-28" />
              <button type="button" className="rounded p-1.5 text-muted-foreground hover:bg-muted" onClick={() => setItems((arr) => arr.filter((_, j) => j !== i))} disabled={items.length === 1}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setItems((arr) => [...arr, { ...emptyLine }])}><Plus size={13} /> {t('finance.addLine')}</Button>
        </div>
        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-sm text-muted-foreground">{t('common.total')} <span className="font-medium text-foreground tabular-nums">{fmtMoney(total)}</span></span>
          <Button type="submit" size="sm" disabled={pending || !companyId}>{t('finance.createDraft')}</Button>
        </div>
      </form>
    </Card>
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
      if (r?.id) navigate(`/finance/invoices/${r.id}`);
    },
  });
  const rows = invoices.data?.data ?? [];

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('common.allStatuses')}</option>
          {['draft', 'sent', 'viewed', 'partially_paid', 'paid', 'canceled'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </Select>
        {can('finance.write') && <Button size="sm" className="ml-auto" onClick={() => setShowForm((v) => !v)}><Plus size={14} /> {t('finance.newInvoice')}</Button>}
      </div>
      {showForm && can('finance.write') && <DocForm kind="invoice" companies={companies.data?.data ?? []} onSubmit={(v) => create.mutate(v)} pending={create.isPending} />}
      <DocTable rows={rows} loading={invoices.isLoading} kind="invoice" onRow={(id) => navigate(`/finance/invoices/${id}`)} />
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
    },
  });
  const rows = quotes.data?.data ?? [];

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('common.allStatuses')}</option>
          {['draft', 'sent', 'viewed', 'accepted', 'declined', 'expired'].map((s) => <option key={s} value={s}>{s}</option>)}
        </Select>
        {can('finance.write') && <Button size="sm" className="ml-auto" onClick={() => setShowForm((v) => !v)}><Plus size={14} /> {t('finance.newQuote')}</Button>}
      </div>
      {showForm && can('finance.write') && <DocForm kind="quote" companies={companies.data?.data ?? []} onSubmit={(v) => create.mutate(v)} pending={create.isPending} />}
      <DocTable rows={rows} loading={quotes.isLoading} kind="quote" />
    </div>
  );
}

function DocTable({ rows, loading, kind, onRow }: { rows: DocRow[]; loading: boolean; kind: 'invoice' | 'quote'; onRow?: (id: string) => void }) {
  const t = useT();
  if (loading) return <Card className="p-4"><Skeleton className="h-40 w-full" /></Card>;
  if (rows.length === 0) {
    return kind === 'invoice'
      ? <EmptyState title={t('public.noInvoices')} hint={t('finance.noInvoicesHint')} />
      : <EmptyState title={t('public.noQuotes')} hint={t('finance.noQuotesHint')} />;
  }
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="px-4 py-2 font-medium">{t('finance.number')}</th>
            <th className="px-4 py-2 font-medium">{t('common.company')}</th>
            <th className="px-4 py-2 font-medium">{t('common.status')}</th>
            <th className="px-4 py-2 text-right font-medium">{t('common.total')}</th>
            <th className="px-4 py-2 font-medium">{kind === 'invoice' ? t('public.due') : t('public.validUntil')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className={cn('border-b border-border last:border-0', onRow && 'cursor-pointer hover:bg-muted/60')}
              onClick={onRow ? () => onRow(r.id) : undefined}
            >
              <td className="px-4 py-2 font-medium">{r.number ?? r.id}</td>
              <td className="px-4 py-2 text-muted-foreground">{r.companyName ?? '—'}</td>
              <td className="px-4 py-2"><Badge color={statusColor(r.status)}>{r.status ?? 'draft'}</Badge></td>
              <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(r.total ?? 0, r.currency ?? 'USD')}</td>
              <td className="px-4 py-2">
                <span className="inline-flex items-center gap-1">
                  {fmtDate(kind === 'invoice' ? r.dueDate : r.validUntil)}
                  {kind === 'invoice' && r.isOverdue && <AlertTriangle size={13} className="text-destructive" />}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function ExpensesView() {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const expenses = useQuery({ queryKey: ['expenses'], queryFn: () => api.get<{ data: Expense[] }>('/expenses') });
  const [form, setForm] = useState({ description: '', amount: '', currency: 'USD', date: '', category: '' });
  const create = useMutation({
    mutationFn: () => api.post('/expenses', { description: form.description, amount: Number(form.amount), currency: form.currency, date: form.date || undefined, category: form.category || undefined }),
    onSuccess: () => {
      setForm({ description: '', amount: '', currency: 'USD', date: '', category: '' });
      qc.invalidateQueries({ queryKey: ['expenses'] });
    },
  });
  const rows = expenses.data?.data ?? [];

  return (
    <div className="p-6">
      {can('finance.write') && (
        <Card className="mb-4 p-4">
          <div className="mb-3 text-sm font-medium">{t('finance.addExpense')}</div>
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (Number(form.amount) > 0) create.mutate(); }}>
            <label className="text-xs text-muted-foreground">{t('public.description')}<Input value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} className="mt-1 w-56" /></label>
            <label className="text-xs text-muted-foreground">{t('public.amount')}<Input type="number" min={0} step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} className="mt-1 w-28" /></label>
            <label className="text-xs text-muted-foreground">{t('common.currency')}<Input value={form.currency} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))} className="mt-1 w-20" /></label>
            <label className="text-xs text-muted-foreground">{t('common.date')}<Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className="mt-1" /></label>
            <label className="text-xs text-muted-foreground">{t('finance.category')}<Input value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))} className="mt-1 w-32" /></label>
            <Button type="submit" size="sm" disabled={create.isPending}><Plus size={14} /> {t('common.add')}</Button>
          </form>
        </Card>
      )}
      {expenses.isLoading ? (
        <Card className="p-4"><Skeleton className="h-40 w-full" /></Card>
      ) : rows.length === 0 ? (
        <EmptyState title={t('finance.noExpenses')} hint={t('finance.noExpensesHint')} />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">{t('common.date')}</th>
                <th className="px-4 py-2 font-medium">{t('public.description')}</th>
                <th className="px-4 py-2 font-medium">{t('finance.category')}</th>
                <th className="px-4 py-2 font-medium">{t('time.groupProject')}</th>
                <th className="px-4 py-2 text-right font-medium">{t('public.amount')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2">{fmtDate(e.date)}</td>
                  <td className="px-4 py-2">{e.description ?? '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground">{e.category ?? '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground">{e.projectName ?? '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(e.amount ?? 0, e.currency ?? 'USD')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
