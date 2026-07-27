import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '../lib/router';
import { useCan } from '../lib/auth';
import { usePageTitle } from '../lib/tabs';
import { api, appOrigin, ApiError } from '../lib/api';
import { Button, Input, Select, Card, Breadcrumbs, Skeleton, fmtMoney, fmtDate, cn } from '../components/ui';
import { Dialog, ConfirmDialog, toast } from '../components/overlays';
import { Send, Download, Ban, Plus, ExternalLink, FilePlus2, Eye, Banknote, Landmark } from 'lucide-react';
import { useT, extendDict } from '../lib/i18n';
import { isTauri, openInBrowser } from '../lib/desktop';

/**
 * The PDF endpoint authenticates with the browser cookie. Inside the desktop
 * shell a relative window.open points at tauri://localhost and carries no
 * credential at all, so hand the link to the real browser instead – its
 * session exists whenever browser sign-in was used, and the login page is an
 * honest fallback when it was not.
 */
function openPdf(id: string): void {
  const path = `/api/v1/invoices/${id}/pdf`;
  if (isTauri) void openInBrowser(appOrigin() + path);
  else window.open(path, '_blank');
}
import { useWorkspaceSettings } from '../components/finance/workspace';
import { DateField } from '../components/DatePicker';

extendDict({
  en: {
    'finance.timeline': 'Timeline',
    'finance.timelineCreated': 'Invoice created',
    'finance.timelineSent': 'Sent to client',
    'finance.timelineViewed': 'Viewed by client',
    'finance.timelineCanceled': 'Canceled',
    'finance.timelinePayment': 'Payment received',
    'finance.invoiceCanceled': 'Invoice canceled',
    'finance.cancelFailed': 'Could not cancel the invoice',
    'finance.sendFailed': 'Could not send the invoice',
    'finance.sent': 'Invoice sent',
    'finance.paymentRecorded': 'Payment recorded',
    'finance.status.draft': 'Draft',
    'finance.status.sent': 'Sent',
    'finance.status.viewed': 'Viewed',
    'finance.status.partially_paid': 'Partially paid',
    'finance.status.paid': 'Paid',
    'finance.status.canceled': 'Canceled',
    'finance.paymentDetails': 'Payment details',
    'finance.notes': 'Notes',
    'finance.method.bank': 'Bank transfer',
    'finance.method.card': 'Card',
    'finance.method.cash': 'Cash',
    'finance.method.other': 'Other',
  },
  uk: {
    'finance.timeline': 'Хронологія',
    'finance.timelineCreated': 'Рахунок створено',
    'finance.timelineSent': 'Надіслано клієнту',
    'finance.timelineViewed': 'Переглянуто клієнтом',
    'finance.timelineCanceled': 'Скасовано',
    'finance.timelinePayment': 'Отримано оплату',
    'finance.invoiceCanceled': 'Рахунок скасовано',
    'finance.cancelFailed': 'Не вдалося скасувати рахунок',
    'finance.sendFailed': 'Не вдалося надіслати рахунок',
    'finance.sent': 'Рахунок надіслано',
    'finance.paymentRecorded': 'Оплату зафіксовано',
    'finance.status.draft': 'Чернетка',
    'finance.status.sent': 'Надіслано',
    'finance.status.viewed': 'Переглянуто',
    'finance.status.partially_paid': 'Частково оплачено',
    'finance.status.paid': 'Оплачено',
    'finance.status.canceled': 'Скасовано',
    'finance.paymentDetails': 'Реквізити для оплати',
    'finance.notes': 'Примітки',
    'finance.method.bank': 'Банківський переказ',
    'finance.method.card': 'Картка',
    'finance.method.cash': 'Готівка',
    'finance.method.other': 'Інше',
  },
});

const STATUS_TONE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  sent: 'bg-primary/15 text-primary',
  viewed: 'bg-primary/15 text-primary',
  partially_paid: 'bg-warning/15 text-warning',
  paid: 'bg-success/15 text-success',
  canceled: 'bg-muted text-muted-foreground',
};

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
  createdAt?: string | null;
  sentAt?: string | null;
  viewedAt?: string | null;
}

/** Today as YYYY-MM-DD (local); the API requires a payment date even when the field is left blank. */
function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function InvoiceDetailPage({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const [showPayment, setShowPayment] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const invoice = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<Invoice>(`/invoices/${id}`) });
  const wsQ = useWorkspaceSettings();
  // Tab title shows the invoice number, not a generic "Finance".
  usePageTitle(invoice.data?.number ?? undefined);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['invoice', id] });
    qc.invalidateQueries({ queryKey: ['invoices'] });
  };
  const send = useMutation({
    mutationFn: () => api.post(`/invoices/${id}/send`),
    onSuccess: () => { toast(t('finance.sent')); invalidate(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('finance.sendFailed')),
  });
  const cancel = useMutation({
    mutationFn: () => api.post(`/invoices/${id}/cancel`),
    onSuccess: () => { setShowCancel(false); toast(t('finance.invoiceCanceled')); invalidate(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('finance.cancelFailed')),
  });
  const [pay, setPay] = useState({ amount: '', date: '', method: 'bank' });
  const recordPayment = useMutation({
    mutationFn: () => api.post(`/invoices/${id}/payments`, {
      amount: Number(pay.amount),
      currency: invoice.data?.currency ?? 'USD',
      date: pay.date || todayIso(),
      method: pay.method,
    }),
    onSuccess: () => {
      setShowPayment(false);
      setPay({ amount: '', date: '', method: 'bank' });
      toast(t('finance.paymentRecorded'));
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('finance.paymentFailed')),
  });

  if (invoice.isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-8">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-10 w-1/3" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (invoice.isError || !invoice.data) return <div className="p-8 text-sm text-muted-foreground">{t('finance.invoiceNotFound')}</div>;

  const iv = invoice.data;
  const cur = iv.currency ?? 'USD';
  const total = Number(iv.total ?? 0);
  const paid = Number(iv.amountPaid ?? 0);
  const outstanding = total - paid;
  const items = iv.items ?? [];
  const payments = iv.payments ?? [];
  const cancelable = iv.status !== 'paid' && iv.status !== 'canceled';
  const statusClass = STATUS_TONE[iv.status ?? 'draft'] ?? STATUS_TONE.draft;

  const brand = wsQ.data;
  const settings = brand?.invoiceSettings ?? {};
  const accent = settings.accentColor || undefined;
  const showLogo = settings.showLogo !== false && !!brand?.logo;
  const accentText = accent ? { color: accent } : undefined;

  const timeline = buildTimeline(iv, payments, t);

  return (
    <div className="mx-auto max-w-4xl p-8">
      <Breadcrumbs
        className="mb-4"
        items={[{ label: t('nav.finance'), to: '/finance' }]}
      />

      {/* Branded document header */}
      <div className="mb-3 flex items-center gap-3">
        {showLogo && <img src={brand!.logo!} alt="" className="h-9 w-auto max-w-[160px] object-contain" />}
        {brand?.name && <span className="text-[15px] font-semibold">{brand.name}</span>}
      </div>
      <div className="mb-4 h-1 w-full rounded-full" style={{ backgroundColor: accent ?? 'hsl(var(--border))' }} />

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-2xl font-semibold tracking-tight" style={accentText}>{iv.number ?? t('public.invoice')}</h1>
            <span
              className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', !accent && statusClass)}
              style={accent && iv.status !== 'canceled' ? { backgroundColor: accent + '22', color: accent } : undefined}
            >{t(`finance.status.${iv.status ?? 'draft'}`, (iv.status ?? 'draft').replace('_', ' '))}</span>
          </div>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            {iv.companyId ? <Link to={`/companies/${iv.companyId}`} className="hover:text-foreground hover:underline">{iv.companyName ?? t('public.client')}</Link> : iv.companyName ?? t('public.client')}
            {iv.issueDate && <> · {t('public.issued')} {fmtDate(iv.issueDate)}</>}
            {iv.dueDate && <> · {t('public.due')} {fmtDate(iv.dueDate)}</>}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {can('finance.send') && <Button size="sm" variant="outline" onClick={() => send.mutate()} disabled={send.isPending}><Send size={14} /> {t('common.send')}</Button>}
          <Button size="sm" variant="outline" onClick={() => openPdf(id)}><Download size={14} /> PDF</Button>
          {can('finance.payments') && outstanding > 0 && (
            <Button
              size="sm"
              onClick={() => {
                // Prefill with the outstanding amount and today's date.
                setPay((p) => ({ ...p, amount: String(outstanding), date: todayIso() }));
                setShowPayment(true);
              }}
            >
              <Plus size={14} /> {t('finance.recordPayment')}
            </Button>
          )}
          {can('finance.write') && cancelable && <Button size="sm" variant="destructive" onClick={() => setShowCancel(true)} disabled={cancel.isPending}><Ban size={14} /> {t('common.cancel')}</Button>}
        </div>
      </div>

      {iv.publicToken && (
        <Card className="mb-6 flex items-center justify-between px-4 py-2.5 text-[13px]">
          <span className="text-muted-foreground">{t('finance.publicLink')}</span>
          <a href={`/i/${iv.publicToken}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
            /i/{iv.publicToken} <ExternalLink size={13} />
          </a>
        </Card>
      )}

      <Card className="mb-6 overflow-hidden">
        <table className="w-full text-[13px]">
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
              <tr key={it.id ?? String(i)} className="border-b border-border/70 last:border-0">
                <td className="px-4 py-2.5">{it.description ?? '–'}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{Number(it.quantity ?? 0)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{fmtMoney(it.unitPrice ?? 0, cur)}</td>
                <td className="px-4 py-2.5 text-right font-medium tabular-nums">{fmtMoney(it.amount ?? Number(it.quantity ?? 0) * Number(it.unitPrice ?? 0), cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="border-b border-border px-4 py-2.5 text-[13px] font-medium">{t('finance.timeline')}</div>
          <div className="p-4">
            {timeline.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{t('finance.noPayments')}</p>
            ) : (
              <ul className="space-y-0">
                {timeline.map((ev, i) => (
                  <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
                    {i < timeline.length - 1 && <span className="absolute left-[11px] top-6 h-[calc(100%-8px)] w-px bg-border" aria-hidden />}
                    <span className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-full', ev.tone === 'success' ? 'bg-success/15 text-success' : ev.tone === 'destructive' ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground')}>
                      {ev.icon}
                    </span>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <div className="text-[13px] font-medium">{ev.label}</div>
                      {ev.date && <div className="text-xs text-muted-foreground tabular-nums">{fmtDate(ev.date)}</div>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
        <Card className="p-4">
          <dl className="space-y-2 text-[13px]">
            <Row label={t('public.subtotal')} value={fmtMoney(iv.subtotal ?? 0, cur)} />
            <Row label={t('public.tax')} value={fmtMoney(iv.taxTotal ?? 0, cur)} />
            <div className="border-t border-border pt-2">
              <Row label={t('common.total')} value={fmtMoney(total, cur)} bold />
            </div>
            <Row label={t('public.paid')} value={fmtMoney(paid, cur)} />
            <div className="border-t border-border pt-2">
              <Row label={t('finance.outstanding')} value={fmtMoney(outstanding, cur)} bold accent={outstanding > 0} />
            </div>
          </dl>
        </Card>
      </div>

      {/* Branding: notes / footer + payment details */}
      {(iv.notes || settings.footerNote) && (
        <div className="mt-6 text-[13px] text-muted-foreground">
          {iv.notes && <p className="mb-1">{iv.notes}</p>}
          {settings.footerNote && <p className="whitespace-pre-line">{settings.footerNote}</p>}
        </div>
      )}

      {settings.paymentDetails && (
        <Card className="mt-6 p-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-faint">
            <Landmark size={13} /> {t('finance.paymentDetails')}
          </div>
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground/90">{settings.paymentDetails}</pre>
        </Card>
      )}

      <Dialog open={showPayment} onClose={() => setShowPayment(false)} title={t('finance.recordPayment')} width={400}>
        <form
          className="space-y-3 px-4 pb-4 pt-1"
          onSubmit={(e) => { e.preventDefault(); if (Number(pay.amount) > 0) recordPayment.mutate(); }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('public.amount')}</label>
              <Input autoFocus type="number" min={0} step="0.01" value={pay.amount} onChange={(e) => setPay((p) => ({ ...p, amount: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('common.date')}</label>
              <DateField value={pay.date} onChange={(v) => setPay((p) => ({ ...p, date: v ?? '' }))} clearable={false} />
            </div>
            <div className="col-span-2 space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('finance.method')}</label>
              <Select value={pay.method} onChange={(e) => setPay((p) => ({ ...p, method: e.target.value }))} className="block w-full">
                {['bank', 'card', 'cash', 'other'].map((m) => <option key={m} value={m}>{t(`finance.method.${m}`)}</option>)}
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowPayment(false)}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={recordPayment.isPending}>{t('common.save')}</Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={showCancel}
        onClose={() => setShowCancel(false)}
        onConfirm={() => cancel.mutate()}
        title={t('common.cancel')}
        body={t('finance.cancelInvoiceConfirm')}
        confirmLabel={t('common.cancel')}
        danger
        pending={cancel.isPending}
      />
    </div>
  );
}

interface TimelineEvent { label: string; date?: string | null; icon: ReactNode; tone?: 'success' | 'destructive' | 'muted' }

function buildTimeline(iv: Invoice, payments: Payment[], t: (k: string, f?: string) => string): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  events.push({ label: t('finance.timelineCreated'), date: iv.issueDate ?? iv.createdAt, icon: <FilePlus2 size={13} /> });
  if (iv.sentAt) events.push({ label: t('finance.timelineSent'), date: iv.sentAt, icon: <Send size={13} /> });
  if (iv.viewedAt) events.push({ label: t('finance.timelineViewed'), date: iv.viewedAt, icon: <Eye size={13} /> });
  for (const p of payments) {
    events.push({ label: `${t('finance.timelinePayment')} · ${fmtMoney(p.amount ?? 0, iv.currency ?? 'USD')}`, date: p.date, icon: <Banknote size={13} />, tone: 'success' });
  }
  if (iv.status === 'canceled') events.push({ label: t('finance.timelineCanceled'), icon: <Ban size={13} />, tone: 'destructive' });
  events.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return -1;
    if (!b.date) return 1;
    return new Date(a.date).getTime() - new Date(b.date).getTime();
  });
  return events;
}

function Row({ label, value, bold, accent }: { label: string; value: string; bold?: boolean; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', bold ? 'text-base font-semibold' : 'font-medium', accent && 'text-destructive')}>{value}</dd>
    </div>
  );
}
