import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Badge, Card, Skeleton, fmtMoney, fmtDate } from '../../components/ui';
import { Download } from 'lucide-react';
import { useT } from '../../lib/i18n';

const STATUS_COLORS: Record<string, string> = {
  draft: '#6b7280', sent: '#3b82f6', viewed: '#8b5cf6', partially_paid: '#f59e0b', paid: '#22c55e', canceled: '#ef4444',
};

interface PubItem { description?: string | null; quantity?: number | string; unitPrice?: number | string; amount?: number | string }
interface PubInvoice {
  number?: string | null;
  status?: string | null;
  currency?: string | null;
  issueDate?: string | null;
  dueDate?: string | null;
  companyName?: string | null;
  company?: { name?: string | null; address?: unknown } | null;
  issuerName?: string | null;
  workspaceName?: string | null;
  items?: PubItem[];
  subtotal?: number | string | null;
  taxTotal?: number | string | null;
  total?: number | string | null;
  amountPaid?: number | string | null;
  notes?: string | null;
  terms?: string | null;
}

export function PublicInvoicePage({ token }: { token: string }) {
  const t = useT();
  const invoice = useQuery({ queryKey: ['publicInvoice', token], queryFn: () => api.get<PubInvoice>(`/i/${token}`), retry: false });

  if (invoice.isLoading) {
    return <Frame><Skeleton className="h-96 w-full" /></Frame>;
  }
  if (invoice.isError || !invoice.data) {
    return <Frame><Card className="p-10 text-center text-sm text-muted-foreground">{t('public.invoiceInvalid')}</Card></Frame>;
  }

  const iv = invoice.data;
  const cur = iv.currency ?? 'USD';
  const total = Number(iv.total ?? 0);
  const paid = Number(iv.amountPaid ?? 0);
  const outstanding = total - paid;
  const items = iv.items ?? [];
  const client = iv.companyName ?? iv.company?.name ?? t('public.client');
  const issuer = iv.issuerName ?? iv.workspaceName ?? '';

  return (
    <Frame>
      <Card className="p-8 print:border-0 print:shadow-none">
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">{t('public.invoice')} {iv.number ?? ''}</h1>
            {issuer && <p className="mt-1 text-sm text-muted-foreground">{t('public.from')} {issuer}</p>}
          </div>
          <Badge color={(iv.status && STATUS_COLORS[iv.status]) || '#6b7280'}>{iv.status ?? 'draft'}</Badge>
        </div>

        <div className="mb-8 grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('public.billedTo')}</div>
            <div className="mt-1 font-medium">{client}</div>
          </div>
          <div className="text-right">
            <div className="text-muted-foreground">{t('public.issued')} {fmtDate(iv.issueDate)}</div>
            <div className="text-muted-foreground">{t('public.due')} {fmtDate(iv.dueDate)}</div>
          </div>
        </div>

        <table className="mb-6 w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-2 font-medium">{t('public.description')}</th>
              <th className="py-2 text-right font-medium">{t('public.qty')}</th>
              <th className="py-2 text-right font-medium">{t('public.price')}</th>
              <th className="py-2 text-right font-medium">{t('public.amount')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={String(i)} className="border-b border-border last:border-0">
                <td className="py-2">{it.description ?? '—'}</td>
                <td className="py-2 text-right tabular-nums">{Number(it.quantity ?? 0)}</td>
                <td className="py-2 text-right tabular-nums">{fmtMoney(it.unitPrice ?? 0, cur)}</td>
                <td className="py-2 text-right tabular-nums">{fmtMoney(it.amount ?? Number(it.quantity ?? 0) * Number(it.unitPrice ?? 0), cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="ml-auto max-w-xs space-y-1.5 text-sm">
          <SumRow label={t('public.subtotal')} value={fmtMoney(iv.subtotal ?? 0, cur)} />
          <SumRow label={t('public.tax')} value={fmtMoney(iv.taxTotal ?? 0, cur)} />
          <SumRow label={t('common.total')} value={fmtMoney(total, cur)} bold />
          {paid > 0 && <SumRow label={t('public.paid')} value={fmtMoney(paid, cur)} />}
          <SumRow label={t('public.amountDue')} value={fmtMoney(outstanding, cur)} bold />
        </div>

        {(iv.notes || iv.terms) && (
          <div className="mt-8 border-t border-border pt-4 text-xs text-muted-foreground">
            {iv.notes && <p className="mb-1">{iv.notes}</p>}
            {iv.terms && <p>{iv.terms}</p>}
          </div>
        )}

        <div className="mt-8 print:hidden">
          <a href={`/api/v1/i/${token}/pdf`} target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3.5 py-2 text-sm hover:bg-muted">
            <Download size={15} /> {t('finance.downloadPdf')}
          </a>
        </div>
      </Card>
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-background px-4 py-10"><div className="mx-auto max-w-2xl">{children}</div></div>;
}
function SumRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={bold ? 'font-semibold tabular-nums' : 'tabular-nums'}>{value}</span>
    </div>
  );
}
