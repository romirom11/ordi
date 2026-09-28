import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, Badge, Card, Textarea, Skeleton, fmtMoney, fmtDate } from '../../components/ui';
import { Check, X, Download } from 'lucide-react';
import { useT, extendDict, I18nProvider, guessLocale } from '../../lib/i18n';

extendDict({
  en: { 'public.taxId': 'Tax ID' },
  uk: { 'public.taxId': 'Код' },
});

const STATUS_COLORS: Record<string, string> = {
  draft: '#6b7280', sent: '#3b82f6', viewed: '#8b5cf6', accepted: '#22c55e', declined: '#ef4444', expired: '#6b7280',
};

interface PubItem { description?: string | null; quantity?: number | string; unitPrice?: number | string; amount?: number | string }
interface Requisites { legalName?: string | null; taxId?: string | null; address?: string | null; email?: string | null; phone?: string | null }
/** GET /q/:token – the same nested shape as the public invoice payload. */
interface PubQuotePayload {
  quote: {
    number?: string | null;
    status?: string | null;
    currency?: string | null;
    issueDate?: string | null;
    validUntil?: string | null;
    language?: string | null;
    subtotal?: number | string | null;
    taxTotal?: number | string | null;
    total?: number | string | null;
    notes?: string | null;
    terms?: string | null;
  };
  items?: PubItem[];
  company?: { name?: string | null; legalName?: string | null; taxId?: string | null; address?: string | null } | null;
  workspace?: { name?: string | null; logo?: string | null; legalDetails?: Requisites | null } | null;
  invoiceSettings?: { accentColor?: string | null; showLogo?: boolean } | null;
}

export function PublicQuotePage({ token }: { token: string }) {
  const t = useT();
  const quote = useQuery({ queryKey: ['publicQuote', token], queryFn: () => api.get<PubQuotePayload>(`/q/${token}`), retry: false });

  if (quote.isLoading) return <Frame><Skeleton className="h-96 w-full" /></Frame>;
  if (quote.isError || !quote.data) return <Frame><Card className="p-10 text-center text-sm text-muted-foreground">{t('public.quoteInvalid')}</Card></Frame>;

  // Labelled in the language the quote was issued in, like its PDF.
  return (
    <I18nProvider locale={quote.data.quote.language ?? guessLocale()}>
      <QuoteDocument token={token} data={quote.data} />
    </I18nProvider>
  );
}

function QuoteDocument({ token, data }: { token: string; data: PubQuotePayload }) {
  const t = useT();
  const qc = useQueryClient();
  const [showDecline, setShowDecline] = useState(false);
  const [comment, setComment] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'accepted' | 'declined') => api.post(`/q/${token}/decision`, { decision, comment: decision === 'declined' ? comment : undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publicQuote', token] }),
  });

  const { quote: q, items = [], company, workspace, invoiceSettings } = data;
  const cur = q.currency ?? 'USD';
  const client = company?.name ?? t('public.client');
  const issuer = workspace?.name ?? '';
  const from = workspace?.legalDetails ?? {};
  const accent = invoiceSettings?.accentColor || undefined;
  const showLogo = invoiceSettings?.showLogo !== false && !!workspace?.logo;
  const decided = q.status === 'accepted' || q.status === 'declined';
  const canDecide = q.status === 'sent' || q.status === 'viewed';
  const requisites = (r: { taxId?: string | null; address?: string | null; email?: string | null; phone?: string | null } | null | undefined) =>
    [r?.taxId ? `${t('public.taxId')}: ${r.taxId}` : null, r?.address, r?.email, r?.phone].filter((v): v is string => !!v && !!v.trim());

  return (
    <Frame>
      <Card className="overflow-hidden p-8">
        {accent && <div className="-mx-8 -mt-8 mb-8 h-1.5" style={{ backgroundColor: accent }} />}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div className="min-w-0">
            {showLogo && <img src={workspace!.logo!} alt={issuer} className="mb-2 h-10 w-auto max-w-[180px] object-contain" />}
            <h1 className="text-2xl font-semibold" style={accent ? { color: accent } : undefined}>{t('public.quote')} {q.number ?? ''}</h1>
            {issuer && <p className="mt-1 text-sm text-muted-foreground">{t('public.from')} {issuer}</p>}
          </div>
          <Badge color={(q.status && STATUS_COLORS[q.status]) || '#6b7280'}>{q.status ?? 'draft'}</Badge>
        </div>

        <div className="mb-8 grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('public.from')}</div>
            <div className="mt-1 font-medium">{from.legalName || issuer}</div>
            {requisites(from).map((l, i) => <div key={i} className="text-xs text-muted-foreground">{l}</div>)}
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">{t('public.preparedFor')}</div>
            <div className="mt-1 font-medium">{company?.legalName || client}</div>
            {company?.legalName && company.legalName !== client && <div className="text-xs text-muted-foreground">{client}</div>}
            {requisites(company).map((l, i) => <div key={i} className="whitespace-pre-line text-xs text-muted-foreground">{l}</div>)}
          </div>
          <div className="col-span-2 sm:col-span-1 sm:text-right">
            <div className="text-muted-foreground">{t('public.issued')} {fmtDate(q.issueDate)}</div>
            <div className="text-muted-foreground">{t('public.validUntil')} {fmtDate(q.validUntil)}</div>
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
                <td className="py-2">{it.description ?? '–'}</td>
                <td className="py-2 text-right tabular-nums">{Number(it.quantity ?? 0)}</td>
                <td className="py-2 text-right tabular-nums">{fmtMoney(it.unitPrice ?? 0, cur)}</td>
                <td className="py-2 text-right tabular-nums">{fmtMoney(it.amount ?? Number(it.quantity ?? 0) * Number(it.unitPrice ?? 0), cur)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="ml-auto max-w-xs space-y-1.5 text-sm">
          <SumRow label={t('public.subtotal')} value={fmtMoney(q.subtotal ?? 0, cur)} />
          <SumRow label={t('public.tax')} value={fmtMoney(q.taxTotal ?? 0, cur)} />
          <SumRow label={t('common.total')} value={fmtMoney(q.total ?? 0, cur)} bold />
        </div>

        {(q.notes || q.terms) && (
          <div className="mt-8 space-y-2 border-t border-border pt-4 text-xs text-muted-foreground">
            {q.notes && <p className="whitespace-pre-line">{q.notes}</p>}
            {q.terms && <p className="whitespace-pre-line">{q.terms}</p>}
          </div>
        )}

        <div className="mt-8 border-t border-border pt-6">
          {decided || decide.isSuccess ? (
            <div className="rounded-md bg-muted/60 p-4 text-center text-sm">
              {q.status === 'declined' || decide.variables === 'declined'
                ? t('public.quoteDeclined')
                : t('public.quoteAccepted')}
            </div>
          ) : canDecide ? (
            <div>
              <div className="flex gap-3">
                <Button onClick={() => decide.mutate('accepted')} disabled={decide.isPending}><Check size={15} /> {t('public.accept')}</Button>
                <Button variant="outline" onClick={() => setShowDecline((v) => !v)} disabled={decide.isPending}><X size={15} /> {t('public.decline')}</Button>
              </div>
              {showDecline && (
                <div className="mt-3 space-y-2">
                  <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} placeholder={t('public.declineCommentPlaceholder')} />
                  <Button variant="destructive" size="sm" onClick={() => decide.mutate('declined')} disabled={decide.isPending}>{t('public.confirmDecline')}</Button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-center text-sm text-muted-foreground">{t('public.quoteClosed')}</p>
          )}
        </div>
      </Card>
      <div className="mt-5 flex justify-center print:hidden">
        <a
          href={`/api/v1/q/${token}/pdf`} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium shadow-sm transition-colors hover:bg-muted"
        >
          <Download size={15} /> {t('finance.downloadPdf')}
        </a>
      </div>
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
