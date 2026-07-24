import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Card, Badge, Skeleton, fmtMoney, fmtDate } from '../../components/ui';

const STATUS_COLORS: Record<string, string> = {
  draft: '#6b7280', sent: '#3b82f6', viewed: '#8b5cf6', partially_paid: '#f59e0b', paid: '#22c55e',
  canceled: '#ef4444', accepted: '#22c55e', declined: '#ef4444', expired: '#6b7280',
};
function color(s?: string | null): string { return (s && STATUS_COLORS[s]) || '#6b7280'; }

interface PortalDoc {
  id: string;
  number?: string | null;
  status?: string | null;
  total?: number | string | null;
  currency?: string | null;
  publicToken?: string | null;
  dueDate?: string | null;
  validUntil?: string | null;
}
interface Portal {
  companyName?: string | null;
  company?: { name?: string | null } | null;
  workspaceName?: string | null;
  invoices?: PortalDoc[];
  quotes?: PortalDoc[];
}

export function PortalPage({ token }: { token: string }) {
  const portal = useQuery({ queryKey: ['portal', token], queryFn: () => api.get<Portal>(`/portal/${token}`), retry: false });

  if (portal.isLoading) return <Frame><Skeleton className="h-64 w-full" /></Frame>;
  if (portal.isError || !portal.data) return <Frame><Card className="p-10 text-center text-sm text-muted-foreground">This portal link is invalid or has expired.</Card></Frame>;

  const p = portal.data;
  const name = p.companyName ?? p.company?.name ?? 'Client portal';
  const invoices = p.invoices ?? [];
  const quotes = p.quotes ?? [];

  return (
    <Frame>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">{name}</h1>
        {p.workspaceName && <p className="mt-1 text-sm text-muted-foreground">{p.workspaceName}</p>}
      </div>

      <DocList title="Invoices" docs={invoices} base="i" dateKey="dueDate" empty="No invoices yet." />
      <div className="h-6" />
      <DocList title="Quotes" docs={quotes} base="q" dateKey="validUntil" empty="No quotes yet." />
    </Frame>
  );
}

function DocList({ title, docs, base, dateKey, empty }: { title: string; docs: PortalDoc[]; base: 'i' | 'q'; dateKey: 'dueDate' | 'validUntil'; empty: string }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-border px-4 py-2 text-sm font-medium">{title}</div>
      {docs.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">{empty}</p>
      ) : (
        <div className="divide-y divide-border">
          {docs.map((d) => {
            const inner = (
              <>
                <span className="font-medium">{d.number ?? d.id}</span>
                <Badge color={color(d.status)}>{d.status ?? 'draft'}</Badge>
                <span className="ml-auto text-muted-foreground">{fmtDate(d[dateKey])}</span>
                <span className="w-24 text-right tabular-nums">{fmtMoney(d.total ?? 0, d.currency ?? 'USD')}</span>
              </>
            );
            return d.publicToken ? (
              <a key={d.id} href={`/${base}/${d.publicToken}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-muted/60">{inner}</a>
            ) : (
              <div key={d.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">{inner}</div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-background px-4 py-10"><div className="mx-auto max-w-2xl">{children}</div></div>;
}
