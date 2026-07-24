import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, X, ChevronDown } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useCan } from '../lib/auth';
import { Button, Input, Select, Card, PageHeader, Skeleton, EmptyState, Spinner, fmtMoney } from '../components/ui';

interface Stage {
  id: string; name: string; position?: number; probability?: number; isWon?: boolean; isLost?: boolean;
}
interface Deal {
  id: string; title: string; companyId?: string | null; companyName?: string | null;
  amount?: number | string; currency?: string; stageId: string; probability?: number; version?: number;
}
interface CompanyLite { id: string; name: string; defaultCurrency?: string | null }

export function DealsPage() {
  const qc = useQueryClient();
  const can = useCan();
  const canWrite = can('deals.write');
  const [creating, setCreating] = useState(false);

  const stagesQ = useQuery<Stage[]>({ queryKey: ['deal-stages'], queryFn: () => api.get<{ data: Stage[] }>('/deal-stages').then((r) => r.data) });
  const dealsQ = useQuery<Deal[]>({ queryKey: ['deals'], queryFn: () => api.get<{ data: Deal[] }>('/deals').then((r) => r.data) });

  const move = useMutation({
    mutationFn: (vars: { id: string; stageId: string; lostReason?: string; version?: number }) =>
      api.post(`/deals/${vars.id}/move`, { stageId: vars.stageId, lostReason: vars.lostReason, version: vars.version }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deals'] }),
    onError: (e) => alert(e instanceof ApiError ? e.message : 'Could not move deal.'),
  });

  const stages = (stagesQ.data ?? []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const deals = dealsQ.data ?? [];

  const onMove = (deal: Deal, stageId: string) => {
    if (stageId === deal.stageId) return;
    const target = stages.find((s) => s.id === stageId);
    let lostReason: string | undefined;
    if (target?.isLost) {
      const reason = window.prompt('Reason for marking this deal as lost:');
      if (reason == null) return;
      lostReason = reason;
    }
    move.mutate({ id: deal.id, stageId, lostReason, version: deal.version });
  };

  const isLoading = stagesQ.isLoading || dealsQ.isLoading;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Deals"
        subtitle="Your sales pipeline"
        actions={canWrite && stages.length > 0 && <Button size="sm" onClick={() => setCreating(true)}><Plus size={14} /> New deal</Button>}
      />

      {isLoading ? (
        <div className="flex gap-3 p-6">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-64 w-64 shrink-0" />)}
        </div>
      ) : stages.length === 0 ? (
        <EmptyState title="No pipeline stages" hint="Configure deal stages in Settings to start tracking your pipeline." />
      ) : (
        <div className="flex flex-1 gap-3 overflow-x-auto p-6">
          {stages.map((stage) => {
            const stageDeals = deals.filter((d) => d.stageId === stage.id);
            const total = stageDeals.reduce((n, d) => n + Number(d.amount ?? 0), 0);
            const weighted = stageDeals.reduce((n, d) => {
              const p = d.probability ?? stage.probability ?? 0;
              return n + Number(d.amount ?? 0) * (p / 100);
            }, 0);
            return (
              <div key={stage.id} className="flex w-64 shrink-0 flex-col rounded-lg border border-border bg-muted/30">
                <div className="border-b border-border p-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{stage.name}</span>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">{stageDeals.length}</span>
                  </div>
                  <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                    <span className="tabular-nums">{fmtMoney(total)}</span>
                    <span className="tabular-nums" title="Weighted by probability">≈ {fmtMoney(weighted)}</span>
                  </div>
                </div>
                <div className="flex-1 space-y-2 overflow-y-auto p-2">
                  {stageDeals.length === 0 ? (
                    <p className="px-1 py-4 text-center text-xs text-muted-foreground">No deals</p>
                  ) : stageDeals.map((d) => (
                    <Card key={d.id} className="p-2.5">
                      <p className="text-sm font-medium leading-snug">{d.title}</p>
                      {d.companyName && <p className="mt-0.5 text-xs text-muted-foreground">{d.companyName}</p>}
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-sm font-semibold tabular-nums">{d.amount != null ? fmtMoney(d.amount, d.currency ?? 'USD') : '—'}</span>
                        {canWrite && (
                          <div className="relative">
                            <Select
                              value={d.stageId}
                              onChange={(e) => onMove(d, e.target.value)}
                              className="h-7 max-w-[7rem] appearance-none pr-6 text-xs"
                            >
                              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </Select>
                            <ChevronDown size={12} className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                          </div>
                        )}
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {creating && (
        <NewDealModal
          stages={stages}
          onClose={() => setCreating(false)}
          onCreated={() => { setCreating(false); qc.invalidateQueries({ queryKey: ['deals'] }); }}
        />
      )}
    </div>
  );
}

function NewDealModal({ stages, onClose, onCreated }: { stages: Stage[]; onClose: () => void; onCreated: () => void }) {
  const canCrm = useCan()('crm.read');
  const companiesQ = useQuery<CompanyLite[]>({
    queryKey: ['companies', 'lite'],
    queryFn: () => api.get<{ data: CompanyLite[] }>('/companies').then((r) => r.data),
    enabled: canCrm,
  });
  const companies = companiesQ.data ?? [];

  const [title, setTitle] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [stageId, setStageId] = useState(stages[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => api.post('/deals', {
      title,
      companyId: companyId || undefined,
      amount: amount ? Number(amount) : undefined,
      currency,
      stageId,
    }),
    onSuccess: onCreated,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not create deal.'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) { setError('Title is required.'); return; }
    if (!stageId) { setError('Pick a stage.'); return; }
    mut.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">New deal</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Title</label>
            <Input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Website redesign" />
          </div>
          {canCrm && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Client</label>
              <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="w-full">
                <option value="">{companiesQ.isLoading ? 'Loading…' : 'No client'}</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Amount</label>
              <Input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Currency</label>
              <Select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full">
                {['USD', 'EUR', 'GBP', 'UAH', 'PLN'].map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Stage</label>
            <Select value={stageId} onChange={(e) => setStageId(e.target.value)} className="w-full">
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="submit" size="sm" disabled={mut.isPending}>{mut.isPending ? <Spinner /> : 'Create'}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
