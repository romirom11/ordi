/**
 * Public, client-facing invoice document (GET /i/:token).
 * Deliberately a light "paper" document on a subtle backdrop regardless of the
 * viewer's theme – branded with the workspace logo/name and the workspace
 * accent color, and print-friendly. Consumes the nested public payload:
 *   { invoice, items, company, workspace, invoiceSettings, amountPaid, outstanding }
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Skeleton, fmtMoney, fmtDate, cn } from '../../components/ui';
import { Download, Landmark, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useT, extendDict, I18nProvider, guessLocale } from '../../lib/i18n';

extendDict({
  en: {
    'public.paidInFull': 'Paid in full',
    'public.overdueBanner': 'Overdue',
    'public.thankYou': 'Thank you for your business',
    'public.paymentDetails': 'Payment details',
    'public.taxId': 'Tax ID',
    'public.notes': 'Notes',
    'public.terms': 'Terms',
  },
  uk: {
    'public.paidInFull': 'Оплачено повністю',
    'public.overdueBanner': 'Прострочено',
    'public.thankYou': 'Дякуємо за співпрацю',
    'public.paymentDetails': 'Реквізити для оплати',
    'public.taxId': 'Код',
    'public.notes': 'Примітки',
    'public.terms': 'Умови',
  },
});

const DEFAULT_ACCENT = '#5E6AD2';

interface PubItem { description?: string | null; quantity?: number | string; unitPrice?: number | string; amount?: number | string }
interface InvoiceSettings { accentColor?: string | null; footerNote?: string | null; paymentDetails?: string | null; showLogo?: boolean }
interface Requisites { legalName?: string | null; taxId?: string | null; address?: string | null; email?: string | null; phone?: string | null }
interface PublicPayload {
  invoice: {
    number?: string | null; status?: string | null; currency?: string | null;
    language?: string | null;
    issueDate?: string | null; dueDate?: string | null;
    subtotal?: number | string | null; taxTotal?: number | string | null; total?: number | string | null;
    notes?: string | null; terms?: string | null;
  };
  items?: PubItem[];
  company?: { name?: string | null; legalName?: string | null; taxId?: string | null; address?: string | null } | null;
  workspace?: { name?: string | null; logo?: string | null; legalDetails?: Requisites | null } | null;
  invoiceSettings?: InvoiceSettings | null;
  amountPaid?: number | string;
  outstanding?: number | string;
}

export function PublicInvoicePage({ token }: { token: string }) {
  const t = useT();
  const q = useQuery({ queryKey: ['publicInvoice', token], queryFn: () => api.get<PublicPayload>(`/i/${token}`), retry: false });

  if (q.isLoading) return <Frame><div className="mx-auto max-w-2xl rounded-2xl bg-white p-10 shadow-xl"><Skeleton className="h-96 w-full" /></div></Frame>;
  if (q.isError || !q.data) {
    return (
      <Frame>
        <div className="mx-auto max-w-md rounded-2xl bg-white p-10 text-center text-sm text-slate-500 shadow-xl">
          {t('public.invoiceInvalid')}
        </div>
      </Frame>
    );
  }

  // The document is labelled in the language it was issued in (the same one
  // its PDF uses); the browser's locale only decides the error page above.
  return (
    <I18nProvider locale={q.data.invoice.language ?? guessLocale()}>
      <InvoiceDocument token={token} data={q.data} />
    </I18nProvider>
  );
}

function InvoiceDocument({ token, data }: { token: string; data: PublicPayload }) {
  const t = useT();
  const { invoice: iv, items = [], company, workspace, invoiceSettings } = data;
  const cur = iv.currency ?? 'USD';
  const total = Number(iv.total ?? 0);
  const paid = Number(data.amountPaid ?? 0);
  const outstanding = Number(data.outstanding ?? total - paid);
  const accent = invoiceSettings?.accentColor || DEFAULT_ACCENT;
  const showLogo = invoiceSettings?.showLogo !== false && !!workspace?.logo;
  const client = company?.name ?? t('public.client');
  const issuer = workspace?.name ?? 'ordi';
  const from = workspace?.legalDetails ?? {};

  const isPaid = iv.status === 'paid' || (paid > 0 && outstanding <= 0);
  const isOverdue = !isPaid && iv.status !== 'canceled' && !!iv.dueDate && new Date(iv.dueDate) < new Date() && outstanding > 0;

  return (
    <Frame>
      <div className="mx-auto max-w-2xl">
        <div className="overflow-hidden rounded-2xl bg-white text-slate-800 shadow-xl ring-1 ring-slate-900/5 print:rounded-none print:shadow-none print:ring-0">
          {/* Accent top rule */}
          <div className="h-1.5 w-full" style={{ backgroundColor: accent }} />

          <div className="p-8 sm:p-10">
            {/* Header: brand + invoice meta */}
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                {showLogo
                  ? <img src={workspace!.logo!} alt={issuer} className="mb-2 h-10 w-auto max-w-[180px] object-contain" />
                  : <div className="text-lg font-semibold text-slate-900">{issuer}</div>}
                {showLogo && <div className="text-sm text-slate-500">{issuer}</div>}
              </div>
              <div className="text-right">
                <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{t('public.invoice')}</div>
                <div className="font-mono text-xl font-semibold" style={{ color: accent }}>{iv.number ?? ''}</div>
              </div>
            </div>

            {/* Status banner */}
            {(isPaid || isOverdue) && (
              <div
                className={cn('mt-6 flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium')}
                style={isPaid
                  ? { backgroundColor: '#dcfce7', color: '#15803d' }
                  : { backgroundColor: '#fee2e2', color: '#b91c1c' }}
              >
                {isPaid ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
                {isPaid ? t('public.paidInFull') : t('public.overdueBanner')}
              </div>
            )}

            {/* Parties + dates */}
            <div className="mt-8 grid grid-cols-2 gap-6 text-sm sm:grid-cols-3">
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{t('public.from')}</div>
                <div className="mt-1 font-medium text-slate-900">{from.legalName || issuer}</div>
                <Requisites taxId={from.taxId} address={from.address} extra={[from.email, from.phone]} taxLabel={t('public.taxId')} />
              </div>
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-slate-400">{t('public.billedTo')}</div>
                <div className="mt-1 font-medium text-slate-900">{company?.legalName || client}</div>
                {company?.legalName && company.legalName !== client && <div className="text-slate-500">{client}</div>}
                <Requisites taxId={company?.taxId} address={company?.address} taxLabel={t('public.taxId')} />
              </div>
              <div className="col-span-2 space-y-0.5 sm:col-span-1 sm:text-right">
                <div className="text-slate-500">{t('public.issued')} <span className="font-medium text-slate-700">{fmtDate(iv.issueDate)}</span></div>
                <div className="text-slate-500">{t('public.due')} <span className="font-medium text-slate-700">{fmtDate(iv.dueDate)}</span></div>
              </div>
            </div>

            {/* Line items */}
            <table className="mt-8 w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-400" style={{ borderBottom: `2px solid ${accent}` }}>
                  <th className="pb-2 font-medium">{t('public.description')}</th>
                  <th className="pb-2 text-right font-medium">{t('public.qty')}</th>
                  <th className="pb-2 text-right font-medium">{t('public.price')}</th>
                  <th className="pb-2 text-right font-medium">{t('public.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={String(i)} className="border-b border-slate-100">
                    <td className="py-2.5 text-slate-800">{it.description ?? '–'}</td>
                    <td className="py-2.5 text-right tabular-nums text-slate-600">{Number(it.quantity ?? 0)}</td>
                    <td className="py-2.5 text-right tabular-nums text-slate-600">{fmtMoney(it.unitPrice ?? 0, cur)}</td>
                    <td className="py-2.5 text-right font-medium tabular-nums text-slate-900">{fmtMoney(it.amount ?? Number(it.quantity ?? 0) * Number(it.unitPrice ?? 0), cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Totals */}
            <div className="mt-6 flex justify-end">
              <div className="w-full max-w-xs space-y-1.5 text-sm">
                <SumRow label={t('public.subtotal')} value={fmtMoney(iv.subtotal ?? 0, cur)} />
                <SumRow label={t('public.tax')} value={fmtMoney(iv.taxTotal ?? 0, cur)} />
                <div className="my-1 border-t border-slate-200" />
                <SumRow label={t('common.total')} value={fmtMoney(total, cur)} bold />
                {paid > 0 && <SumRow label={t('public.paid')} value={fmtMoney(paid, cur)} />}
                <div
                  className="mt-1 flex items-center justify-between rounded-lg px-3 py-2 text-[15px] font-semibold"
                  style={{ backgroundColor: accent + '14', color: accent }}
                >
                  <span>{t('public.amountDue')}</span>
                  <span className="tabular-nums">{fmtMoney(outstanding, cur)}</span>
                </div>
              </div>
            </div>

            {/* Payment details */}
            {invoiceSettings?.paymentDetails && (
              <div className="mt-8 rounded-xl border border-slate-200 bg-slate-50 p-4">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                  <Landmark size={13} /> {t('public.paymentDetails')}
                </div>
                <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-700">{invoiceSettings.paymentDetails}</pre>
              </div>
            )}

            {/* Notes / terms / footer */}
            {(iv.notes || iv.terms || invoiceSettings?.footerNote) && (
              <div className="mt-8 space-y-3 border-t border-slate-100 pt-4 text-xs leading-relaxed text-slate-500">
                {iv.notes && <div><div className="mb-0.5 font-semibold uppercase tracking-wide text-slate-400">{t('public.notes')}</div><p className="whitespace-pre-line text-slate-600">{iv.notes}</p></div>}
                {iv.terms && <div><div className="mb-0.5 font-semibold uppercase tracking-wide text-slate-400">{t('public.terms')}</div><p className="whitespace-pre-line text-slate-600">{iv.terms}</p></div>}
                {invoiceSettings?.footerNote && <p className="whitespace-pre-line text-center italic">{invoiceSettings.footerNote}</p>}
              </div>
            )}

            <p className="mt-8 text-center text-xs text-slate-400">{t('public.thankYou')}</p>
          </div>
        </div>

        {/* Download (hidden in print) */}
        <div className="mt-5 flex justify-center print:hidden">
          <a
            href={`/api/v1/i/${token}/pdf`} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm ring-1 ring-slate-900/5 transition-colors hover:bg-slate-50"
          >
            <Download size={15} /> {t('finance.downloadPdf')}
          </a>
        </div>
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-slate-100 px-4 py-10 print:bg-white print:py-0">{children}</div>;
}

/** The requisite lines under a party's name; renders nothing when the party has none. */
function Requisites({ taxId, address, extra = [], taxLabel }: { taxId?: string | null; address?: string | null; extra?: (string | null | undefined)[]; taxLabel: string }) {
  const lines = [taxId ? `${taxLabel}: ${taxId}` : null, address, ...extra].filter((v): v is string => !!v && !!v.trim());
  if (!lines.length) return null;
  return <div className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-slate-500">{lines.join('\n')}</div>;
}

function SumRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={bold ? 'font-medium text-slate-700' : 'text-slate-500'}>{label}</span>
      <span className={cn('tabular-nums', bold ? 'font-semibold text-slate-900' : 'text-slate-700')}>{value}</span>
    </div>
  );
}
