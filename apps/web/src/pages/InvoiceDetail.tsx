import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '../lib/router';
import { useCan } from '../lib/auth';
import { api } from '../lib/api';
import { Button, Input, Select, Card, Badge, Skeleton, fmtMoney, fmtDate, cn } from '../components/ui';
import { ArrowLeft, Send, Download, Ban, Plus, ExternalLink } from 'lucide-react';
import { useT } from '../lib/i18n';

const STATUS_COLORS: Record<string, string> = {
  draft: '#6b7280', sent: '#3b82f6', viewed: '#8b5cf6', partially_paid: '#f59e0b',
  paid: '#22c55e', canceled: '#ef4444',
};
function statusColor(s?: string | null): string { return (s && STATUS_COLORS[s]) || '#6b7280'; }

interface InvoiceItem { id?: string; description?: string | null; quantity?: number | string; unitPrice?: number | string; amount?: number | string }
interface Payment { id: string; amount?: number | string; date?: string | null; method?: string | null; reference?: string | null }
interface Invoice {
  id: string;
  number?: string | null;
  status?: string | null;
  companyName?: string | null;
  companyId?: string | null;
  currency?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  subtotal?: number | string | null;
  taxTotal?: number | string | null;
  total?: number | string | null;
  amountPaid?: number | string | null;
  publicToken?: string | null;
  items?: InvoiceItem[];
  payments?: Payment[];
  notes?: string | null;
  terms?: string | null;
}

export function InvoiceDetailPage({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const [showPayment, setShowPayment] = useState(false);
  const invoice = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<Invoice>(`/invoices/${id}`) });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['invoice', id] });
    qc.invalidateQueries({ queryKey: ['invoices'] });
  };
  const send = useMutation({ mutationFn: () => api.post(`/invoices/${id}/send`), onSuccess: invalidate });
  const cancel = useMutation({ mutationFn: () => api.post(`/invoices/${id}/cancel`), onSuccess: invalidate });
  const [pay, setPay] = useState({ amount: '', date: '', method: 'bank' });
  const recordPayment = useMutation({
    mutationFn: () => api.post(`/invoices/${id}/payments`, { amount: Number(pay.amount), date: pay.date || undefined, method: pay.method }),
    onSuccess: () => {
      setShowPayment(false);
      setPay({ amount: '', date: '', method: 'bank' });
      invalidate();
    },
  });

  if (invoice.isLoading) return <div className="mx-auto max-w-4xl space-y-4 p-8"><Skeleton className="h-10 w-1/3" /><Skeleton className="h-48 w-full" /></div>;
  if (invoice.isError || !invoice.data) return <div className="p-8 text-sm text-muted-foreground">{t('finance.invoiceNotFound')}</div>;

  const iv = invoice.data;
  const cur = iv.currency ?? 'USD';
  const total = Number(iv.total ?? 0);
  const paid = Number(iv.amountPaid ?? 0);
  const outstanding = total - paid;
  const items = iv.items ?? [];
  const payments = iv.payments ?? [];
  const cancelable = iv.status !== 'paid' && iv.status !== 'canceled';

  return (
    <div className="mx-auto max-w-4xl p-8">
      <Link to="/finance" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"><ArrowLeft size={14} /> {t('nav.finance')}</Link>

      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">{iv.number ?? t('public.invoice')}</h1>
            <Badge color={statusColor(iv.status)}>{iv.status ?? 'draft'}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {iv.companyId ? <Link to={`/companies/${iv.companyId}`} className="hover:underline">{iv.companyName ?? t('public.client')}</Link> : iv.companyName ?? t('public.client')}
            {iv.dueDate && <> · {t('public.due')} {fmtDate(iv.dueDate)}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {can('finance.send') && <Button size="sm" variant="outline" onClick={() => send.mutate()} disabled={send.isPending}><Send size={14} /> {t('common.send')}</Button>}
          <Button size="sm" variant="outline" onClick={() => window.open(`/api/v1/invoices/${id}/pdf`, '_blank')}><Download size={14} /> PDF</Button>
          {can('finance.payments') && outstanding > 0 && <Button size="sm" onClick={() => setShowPayment((v) => !v)}><Plus size={14} /> {t('finance.recordPayment')}</Button>}
          {can('finance.write') && cancelable && <Button size="sm" variant="destructive" onClick={() => { if (confirm(t('finance.cancelInvoiceConfirm'))) cancel.mutate(); }} disabled={cancel.isPending}><Ban size={14} /> {t('common.cancel')}</Button>}
        </div>
      </div>

      {iv.publicToken && (
        <Card className="mb-6 flex items-center justify-between px-4 py-2 text-sm">
          <span className="text-muted-foreground">{t('finance.publicLink')}</span>
          <a href={`/i/${iv.publicToken}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
            /i/{iv.publicToken} <ExternalLink size={13} />
          </a>
        </Card>
      )}

      {showPayment && can('finance.payments') && (
        <Card className="mb-6 p-4">
          <div className="mb-3 text-sm font-medium">{t('finance.recordPayment')}</div>
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (Number(pay.amount) > 0) recordPayment.mutate(); }}>
            <label className="text-xs text-muted-foreground">{t('public.amount')}<Input type="number" min={0} step="0.01" value={pay.amount} onChange={(e) => setPay((p) => ({ ...p, amount: e.target.value }))} className="mt-1 w-32" /></label>
            <label className="text-xs text-muted-foreground">{t('common.date')}<Input type="date" value={pay.date} onChange={(e) => setPay((p) => ({ ...p, date: e.target.value }))} className="mt-1" /></label>
            <label className="text-xs text-muted-foreground">{t('finance.method')}
              <Select value={pay.method} onChange={(e) => setPay((p) => ({ ...p, method: e.target.value }))} className="mt-1 block h-9">
                {['bank', 'card', 'cash', 'other'].map((m) => <option key={m} value={m}>{m}</option>)}
              </Select>
            </label>
            <Button type="submit" size="sm" disabled={recordPayment.isPending}>{t('common.save')}</Button>
            {recordPayment.isError && <span className="text-xs text-destructive">{t('finance.paymentFailed')}</span>}
          </form>
        </Card>
      )}

      <Card className="mb-6 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">{t('public.description')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('public.qty')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('finance.unitPrice')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('public.amount')}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">{t('finance.noLineItems')}</td></tr>}
            {items.map((it, i) => (
              <tr key={it.id ?? String(i)} className="border-b border-border last:border-0">
                <td className="px-4 py-2">{it.description ?? '—'}</td>
                <td className="px-4 py-2 text-right tabular-nums">{Number(it.quantity ?? 0)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(it.unitPrice ?? 0, cur)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{fmtMoney(it.amount ?? Number(it.quantity ?? 0) * Number(it.unitPrice ?? 0), cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <div className="border-b border-border px-4 py-2 text-sm font-medium">{t('finance.payments')}</div>
          <div className="divide-y divide-border">
            {payments.length === 0 && <p className="px-4 py-4 text-sm text-muted-foreground">{t('finance.noPayments')}</p>}
            {payments.map((p) => (
              <div key={p.id} className="flex items-center justify-between px-4 py-2 text-sm">
                <span>{fmtDate(p.date)} · <span className="text-muted-foreground">{p.method ?? ''}</span></span>
                <span className="tabular-nums">{fmtMoney(p.amount ?? 0, cur)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-4">
          <dl className="space-y-1.5 text-sm">
            <Row label={t('public.subtotal')} value={fmtMoney(iv.subtotal ?? 0, cur)} />
            <Row label={t('public.tax')} value={fmtMoney(iv.taxTotal ?? 0, cur)} />
            <Row label={t('common.total')} value={fmtMoney(total, cur)} bold />
            <Row label={t('public.paid')} value={fmtMoney(paid, cur)} />
            <Row label={t('finance.outstanding')} value={fmtMoney(outstanding, cur)} bold accent={outstanding > 0} />
          </dl>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value, bold, accent }: { label: string; value: string; bold?: boolean; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', bold && 'font-semibold', accent && 'text-destructive')}>{value}</dd>
    </div>
  );
}
