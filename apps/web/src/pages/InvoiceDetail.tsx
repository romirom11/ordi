import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '../lib/router';
import { useCan } from '../lib/auth';
import { usePageTitle } from '../lib/tabs';
import { api, appOrigin, ApiError } from '../lib/api';
import { Button, Input, Select, Textarea, Card, Breadcrumbs, Skeleton, Tooltip, Spinner, fmtMoney, fmtDate, cn } from '../components/ui';
import { Dialog, ConfirmDialog, toast } from '../components/overlays';
import { Send, Download, Ban, Plus, ExternalLink, FilePlus2, Eye, Banknote, Landmark, Mail, Paperclip, AlertTriangle } from 'lucide-react';
import { useT, extendDict } from '../lib/i18n';
import { openExternal } from '../lib/desktop';
import { InlineEdit } from '../components/crm/detail';

/**
 * The PDF endpoint authenticates with the browser cookie. Inside the desktop
 * shell a relative URL points at tauri://localhost and carries no credential
 * at all, so build the instance address and hand it to the real browser – its
 * session exists whenever browser sign-in was used, and the login page is an
 * honest fallback when it was not.
 */
function openPdf(id: string): void {
  openExternal(`${appOrigin()}/api/v1/invoices/${id}/pdf`);
}
import { useWorkspaceSettings } from '../components/finance/workspace';
import { CustomFieldsSection } from '../components/crm/CustomFieldsSection';
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
    'finance.sentTo': 'Sent to {to}',
    'finance.sendTitle': 'Send invoice {number}',
    'finance.sendFrom': 'From',
    'finance.sendTo': 'To',
    'finance.sendSubject': 'Subject',
    'finance.sendMessage': 'Message',
    'finance.sendAttached': '{file} attached, plus a link to the public invoice page.',
    'finance.sendConfirm': 'Send to {to}',
    'finance.sendNoRecipient': 'This company has no billing email. Enter an address here or set it on the company page.',
    'finance.sendInvalidEmail': 'Enter a valid email address.',
    'finance.mailNotConfigured': 'Outgoing email is not configured. Set up SMTP in Settings → Integrations to send invoices.',
    'finance.mailNotConfiguredShort': 'Email is not configured (Settings → Integrations)',
    'finance.mailSettings': 'Open email settings',
    'finance.resend': 'Send again',
    'finance.sending': 'Sending…',
    'finance.paymentRecorded': 'Payment recorded',
    'finance.status.draft': 'Draft',
    'finance.status.sent': 'Sent',
    'finance.status.viewed': 'Viewed',
    'finance.status.partially_paid': 'Partially paid',
    'finance.status.paid': 'Paid',
    'finance.status.canceled': 'Canceled',
    'finance.paymentDetails': 'Payment details',
    'finance.notes': 'Notes',
    'finance.terms': 'Terms',
    'finance.from': 'From',
    'finance.billTo': 'Bill to',
    'finance.taxId': 'Tax ID',
    'finance.noRequisites': 'No requisites yet – add them on the company page.',
    'finance.noIssuerRequisites': 'Add your requisites in Settings → Invoices.',
    'finance.addNotes': 'Add notes…',
    'finance.addTerms': 'Add terms…',
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
    'finance.sentTo': 'Надіслано на {to}',
    'finance.sendTitle': 'Надіслати рахунок {number}',
    'finance.sendFrom': 'Від',
    'finance.sendTo': 'Кому',
    'finance.sendSubject': 'Тема',
    'finance.sendMessage': 'Текст листа',
    'finance.sendAttached': 'Додається {file} і посилання на публічну сторінку рахунку.',
    'finance.sendConfirm': 'Надіслати на {to}',
    'finance.sendNoRecipient': 'У компанії немає email для рахунків. Введіть адресу тут або задайте її на сторінці компанії.',
    'finance.sendInvalidEmail': 'Введіть коректну email-адресу.',
    'finance.mailNotConfigured': 'Вихідна пошта не налаштована. Налаштуйте SMTP у Налаштування → Інтеграції, щоб надсилати рахунки.',
    'finance.mailNotConfiguredShort': 'Пошта не налаштована (Налаштування → Інтеграції)',
    'finance.mailSettings': 'Відкрити налаштування пошти',
    'finance.resend': 'Надіслати ще раз',
    'finance.sending': 'Надсилаємо…',
    'finance.paymentRecorded': 'Оплату зафіксовано',
    'finance.status.draft': 'Чернетка',
    'finance.status.sent': 'Надіслано',
    'finance.status.viewed': 'Переглянуто',
    'finance.status.partially_paid': 'Частково оплачено',
    'finance.status.paid': 'Оплачено',
    'finance.status.canceled': 'Скасовано',
    'finance.paymentDetails': 'Реквізити для оплати',
    'finance.notes': 'Примітки',
    'finance.terms': 'Умови',
    'finance.from': 'Постачальник',
    'finance.billTo': 'Платник',
    'finance.taxId': 'Код',
    'finance.noRequisites': 'Реквізитів ще немає – додайте їх на сторінці компанії.',
    'finance.noIssuerRequisites': 'Додайте свої реквізити в Налаштування → Рахунки.',
    'finance.addNotes': 'Додати примітки…',
    'finance.addTerms': 'Додати умови…',
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
  company?: { name?: string | null; billingEmail?: string | null; legalName?: string | null; taxId?: string | null; address?: string | null } | null;
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
  /** Every send, newest first: who was mailed and when (from the activity log). */
  sends?: { at: string; to: string | null; actorId?: string | null }[];
  version?: number;
  customFields?: Record<string, unknown>;
}

/** GET /invoices/:id/send-preview – what the Send dialog confirms before anything goes out. */
interface SendPreview {
  mailConfigured: boolean;
  from: string | null;
  to: string | null;
  subject: string;
  body: string;
  link: string;
  attachment: string;
  canSend: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const [showSend, setShowSend] = useState(false);
  const [mail, setMail] = useState({ to: '', subject: '', body: '' });
  const invoice = useQuery({ queryKey: ['invoice', id], queryFn: () => api.get<Invoice>(`/invoices/${id}`) });
  // Loaded up front, so the Send button already knows whether mail can go out at all.
  const preview = useQuery({
    queryKey: ['invoice-send-preview', id],
    queryFn: () => api.get<SendPreview>(`/invoices/${id}/send-preview`),
    enabled: can('finance.send'),
  });
  const wsQ = useWorkspaceSettings();
  // Tab title shows the invoice number, not a generic "Finance".
  usePageTitle(invoice.data?.number ?? undefined);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['invoice', id] });
    qc.invalidateQueries({ queryKey: ['invoices'] });
  };
  const saveCustomFields = useMutation({
    mutationFn: (customFields: Record<string, unknown>) =>
      api.patch(`/invoices/${id}`, { customFields, version: invoice.data?.version }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });
  // Notes/terms stay editable after sending: they are wording, not amounts.
  const saveText = useMutation({
    mutationFn: (patch: { notes?: string; terms?: string }) =>
      api.patch(`/invoices/${id}`, { ...patch, version: invoice.data?.version }),
    onSuccess: invalidate,
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const send = useMutation({
    mutationFn: () => api.post<Invoice & { delivery?: { to: string } }>(`/invoices/${id}/send`, {
      to: mail.to.trim(),
      subject: mail.subject.trim() || undefined,
      body: mail.body.trim() || undefined,
    }),
    onSuccess: (r) => {
      setShowSend(false);
      toast(t('finance.sentTo').replace('{to}', r?.delivery?.to ?? mail.to.trim()));
      invalidate();
    },
    // The API's message names the real cause (no SMTP, a rejected address,
    // a connection refused) – show it rather than a generic failure.
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('finance.sendFailed')),
  });
  const openSend = () => {
    send.reset();
    const p = preview.data;
    setMail({ to: p?.to ?? '', subject: p?.subject ?? '', body: p?.body ?? '' });
    setShowSend(true);
  };
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
  const from = brand?.legalDetails ?? {};
  const fromLines = [from.taxId ? `${t('finance.taxId')}: ${from.taxId}` : null, from.address, from.email, from.phone].filter((v): v is string => !!v && !!v.trim());
  const client = iv.company;
  const clientLines = [client?.taxId ? `${t('finance.taxId')}: ${client.taxId}` : null, client?.address, client?.billingEmail].filter((v): v is string => !!v && !!v.trim());
  const canEditText = can('finance.write') && iv.status !== 'canceled';

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
          {can('finance.send') && cancelable && (
            preview.data && !preview.data.mailConfigured ? (
              <Tooltip label={t('finance.mailNotConfiguredShort')}>
                <span className="inline-flex">
                  <Button size="sm" variant="outline" disabled><Send size={14} /> {t('common.send')}</Button>
                </span>
              </Tooltip>
            ) : (
              <Button size="sm" variant="outline" onClick={openSend} disabled={preview.isLoading || send.isPending}>
                <Send size={14} /> {(iv.sends?.length ?? 0) > 0 || iv.sentAt ? t('finance.resend') : t('common.send')}
              </Button>
            )
          )}
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

      {can('finance.send') && preview.data && !preview.data.mailConfigured && cancelable && (
        <div className="mb-6 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[13px]">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
          <div>
            {t('finance.mailNotConfigured')}
            {can('settings.manage') && <> <Link to="/settings/integrations" className="text-primary hover:underline">{t('finance.mailSettings')}</Link></>}
          </div>
        </div>
      )}

      {iv.publicToken && (
        <Card className="mb-6 flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
          <span className="text-muted-foreground">{t('finance.publicLink')}</span>
          {/* Absolute: inside the desktop shell a relative link points at tauri://localhost. */}
          <a
            href={`${appOrigin()}/i/${iv.publicToken}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => { e.preventDefault(); openExternal(`${appOrigin()}/i/${iv.publicToken}`); }}
            className="inline-flex min-w-0 items-center gap-1 text-primary hover:underline"
          >
            <span className="truncate">{appOrigin()}/i/{iv.publicToken}</span> <ExternalLink size={13} className="shrink-0" />
          </a>
        </Card>
      )}

      {/* Parties: the issuer's requisites (Settings → Invoices) and the client's (company page). */}
      <div className="mb-6 grid gap-4 text-[13px] sm:grid-cols-2">
        <Card className="p-4">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('finance.from')}</div>
          <div className="font-medium">{from.legalName || brand?.name || 'ordi'}</div>
          {fromLines.length
            ? <div className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">{fromLines.join('\n')}</div>
            : <Link to="/settings/invoices" className="mt-0.5 block text-xs text-muted-foreground hover:text-foreground hover:underline">{t('finance.noIssuerRequisites')}</Link>}
        </Card>
        <Card className="p-4">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('finance.billTo')}</div>
          <div className="font-medium">{client?.legalName || client?.name || iv.companyName || t('public.client')}</div>
          {client?.legalName && client.legalName !== client.name && <div className="text-xs text-muted-foreground">{client.name}</div>}
          {clientLines.length
            ? <div className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">{clientLines.join('\n')}</div>
            : iv.companyId
              ? <Link to={`/companies/${iv.companyId}`} className="mt-0.5 block text-xs text-muted-foreground hover:text-foreground hover:underline">{t('finance.noRequisites')}</Link>
              : null}
        </Card>
      </div>

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

      {/* Notes and terms: printed on the PDF and the public page, editable inline. */}
      <div className="mt-6 grid gap-4 text-[13px] sm:grid-cols-2">
        <Card className="p-4">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('finance.notes')}</div>
          <InlineEdit
            value={iv.notes}
            editable={canEditText}
            multiline
            rows={3}
            placeholder={canEditText ? t('finance.addNotes') : '–'}
            onSave={(v) => saveText.mutate({ notes: v ?? '' })}
          />
        </Card>
        <Card className="p-4">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('finance.terms')}</div>
          <InlineEdit
            value={iv.terms}
            editable={canEditText}
            multiline
            rows={3}
            placeholder={canEditText ? t('finance.addTerms') : '–'}
            onSave={(v) => saveText.mutate({ terms: v ?? '' })}
          />
        </Card>
      </div>
      {settings.footerNote && <p className="mt-4 whitespace-pre-line text-center text-[13px] italic text-muted-foreground">{settings.footerNote}</p>}

      {settings.paymentDetails && (
        <Card className="mt-6 p-4">
          <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-faint">
            <Landmark size={13} /> {t('finance.paymentDetails')}
          </div>
          <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground/90">{settings.paymentDetails}</pre>
        </Card>
      )}

      {/* Internal, not part of the printable document */}
      <div className="mt-6">
        <CustomFieldsSection
          entityType="invoices"
          values={iv.customFields}
          editable={can('finance.write')}
          onSave={(customFields) => saveCustomFields.mutate(customFields)}
        />
      </div>

      <Dialog open={showSend} onClose={() => setShowSend(false)} title={t('finance.sendTitle').replace('{number}', iv.number ?? '')} width={520}>
        <form
          className="space-y-3 px-4 pb-4 pt-1"
          onSubmit={(e) => { e.preventDefault(); if (EMAIL_RE.test(mail.to.trim())) send.mutate(); }}
        >
          <div className="grid grid-cols-[64px,1fr] items-center gap-x-3 gap-y-2 text-[13px]">
            <span className="text-xs font-medium text-muted-foreground">{t('finance.sendFrom')}</span>
            <span className="truncate text-muted-foreground">{preview.data?.from ?? '–'}</span>
            <label className="text-xs font-medium text-muted-foreground" htmlFor="send-to">{t('finance.sendTo')}</label>
            <Input
              id="send-to"
              autoFocus
              type="email"
              value={mail.to}
              onChange={(e) => setMail((m) => ({ ...m, to: e.target.value }))}
              placeholder="client@example.com"
              className={cn(mail.to.trim() && !EMAIL_RE.test(mail.to.trim()) && 'border-destructive')}
            />
            <label className="text-xs font-medium text-muted-foreground" htmlFor="send-subject">{t('finance.sendSubject')}</label>
            <Input id="send-subject" value={mail.subject} onChange={(e) => setMail((m) => ({ ...m, subject: e.target.value }))} />
          </div>
          {!preview.data?.to && !mail.to.trim() && (
            <p className="text-xs text-warning">{t('finance.sendNoRecipient')}</p>
          )}
          {mail.to.trim() && !EMAIL_RE.test(mail.to.trim()) && (
            <p className="text-xs text-destructive">{t('finance.sendInvalidEmail')}</p>
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="send-body">{t('finance.sendMessage')}</label>
            <Textarea id="send-body" rows={4} value={mail.body} onChange={(e) => setMail((m) => ({ ...m, body: e.target.value }))} className="w-full" />
          </div>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Paperclip size={12} /> {t('finance.sendAttached').replace('{file}', preview.data?.attachment ?? `${iv.number ?? 'invoice'}.pdf`)}
          </p>
          {/* The failure stays on screen until the next attempt: a toast is
              gone by the time a 10-second SMTP timeout has been read. */}
          {send.isError && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{send.error instanceof ApiError ? send.error.message : t('finance.sendFailed')}</span>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowSend(false)} disabled={send.isPending}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={send.isPending || !EMAIL_RE.test(mail.to.trim())}>
              {send.isPending ? <><Spinner /> {t('finance.sending')}</> : <><Mail size={14} /> {EMAIL_RE.test(mail.to.trim()) ? t('finance.sendConfirm').replace('{to}', mail.to.trim()) : t('common.send')}</>}
            </Button>
          </div>
        </form>
      </Dialog>

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
  if (iv.sends?.length) {
    for (const snd of iv.sends) {
      events.push({ label: snd.to ? `${t('finance.timelineSent')} · ${snd.to}` : t('finance.timelineSent'), date: snd.at, icon: <Send size={13} /> });
    }
  } else if (iv.sentAt) {
    events.push({ label: t('finance.timelineSent'), date: iv.sentAt, icon: <Send size={13} /> });
  }
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
