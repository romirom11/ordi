import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, Badge, Card, Textarea, Skeleton, fmtMoney, fmtDate } from '../../components/ui';
import { Check, X } from 'lucide-react';

const STATUS_COLORS: Record<string, string> = {
  draft: '#6b7280', sent: '#3b82f6', viewed: '#8b5cf6', accepted: '#22c55e', declined: '#ef4444', expired: '#6b7280',
};

interface PubItem { description?: string | null; quantity?: number | string; unitPrice?: number | string; amount?: number | string }
interface PubQuote {
  number?: string | null;
  status?: string | null;
  currency?: string | null;
  issueDate?: string | null;
  validUntil?: string | null;
  companyName?: string | null;
  company?: { name?: string | null } | null;
  issuerName?: string | null;
  workspaceName?: string | null;
  items?: PubItem[];
  subtotal?: number | string | null;
  taxTotal?: number | string | null;
  total?: number | string | null;
  notes?: string | null;
}

export function PublicQuotePage({ token }: { token: string }) {
  const qc = useQueryClient();
  const [showDecline, setShowDecline] = useState(false);
  const [comment, setComment] = useState('');
  const quote = useQuery({ queryKey: ['publicQuote', token], queryFn: () => api.get<PubQuote>(`/q/${token}`), retry: false });
  const decide = useMutation({
    mutationFn: (decision: 'accepted' | 'declined') => api.post(`/q/${token}/decision`, { decision, comment: decision === 'declined' ? comment : undefined }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['publicQuote', token] }),
  });

  if (quote.isLoading) return <Frame><Skeleton className="h-96 w-full" /></Frame>;
  if (quote.isError || !quote.data) return <Frame><Card className="p-10 text-center text-sm text-muted-foreground">This quote link is invalid or has expired.</Card></Frame>;

  const q = quote.data;
  const cur = q.currency ?? 'USD';
  const items = q.items ?? [];
  const client = q.companyName ?? q.company?.name ?? 'Client';
  const issuer = q.issuerName ?? q.workspaceName ?? '';
  const decided = q.status === 'accepted' || q.status === 'declined';
  const canDecide = q.status === 'sent' || q.status === 'viewed';

  return (
    <Frame>
      <Card className="p-8">
        <div className="mb-8 flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Quote {q.number ?? ''}</h1>
            {issuer && <p className="mt-1 text-sm text-muted-foreground">From {issuer}</p>}
          </div>
          <Badge color={(q.status && STATUS_COLORS[q.status]) || '#6b7280'}>{q.status ?? 'draft'}</Badge>
        </div>

        <div className="mb-8 grid grid-cols-2 gap-4 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Prepared for</div>
            <div className="mt-1 font-medium">{client}</div>
          </div>
          <div className="text-right">
            <div className="text-muted-foreground">Issued {fmtDate(q.issueDate)}</div>
            <div className="text-muted-foreground">Valid until {fmtDate(q.validUntil)}</div>
          </div>
        </div>

        <table className="mb-6 w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-2 font-medium">Description</th>
              <th className="py-2 text-right font-medium">Qty</th>
              <th className="py-2 text-right font-medium">Price</th>
              <th className="py-2 text-right font-medium">Amount</th>
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
          <SumRow label="Subtotal" value={fmtMoney(q.subtotal ?? 0, cur)} />
          <SumRow label="Tax" value={fmtMoney(q.taxTotal ?? 0, cur)} />
          <SumRow label="Total" value={fmtMoney(q.total ?? 0, cur)} bold />
        </div>

        {q.notes && <p className="mt-8 border-t border-border pt-4 text-xs text-muted-foreground">{q.notes}</p>}

        <div className="mt-8 border-t border-border pt-6">
          {decided || decide.isSuccess ? (
            <div className="rounded-md bg-muted/60 p-4 text-center text-sm">
              {q.status === 'declined' || decide.variables === 'declined'
                ? 'You have declined this quote. Thank you for letting us know.'
                : 'Thank you — this quote has been accepted. We will be in touch shortly.'}
            </div>
          ) : canDecide ? (
            <div>
              <div className="flex gap-3">
                <Button onClick={() => decide.mutate('accepted')} disabled={decide.isPending}><Check size={15} /> Accept</Button>
                <Button variant="outline" onClick={() => setShowDecline((v) => !v)} disabled={decide.isPending}><X size={15} /> Decline</Button>
              </div>
              {showDecline && (
                <div className="mt-3 space-y-2">
                  <Textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3} placeholder="Add an optional comment…" />
                  <Button variant="destructive" size="sm" onClick={() => decide.mutate('declined')} disabled={decide.isPending}>Confirm decline</Button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-center text-sm text-muted-foreground">This quote is no longer awaiting a decision.</p>
          )}
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
