import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, X, Building2 } from 'lucide-react';
import { api, qs, ApiError } from '../lib/api';
import { useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import { Button, Input, Select, Badge, PageHeader, EmptyState, Skeleton, cn } from '../components/ui';
import { useT } from '../lib/i18n';

interface Company {
  id: string;
  name: string;
  domain?: string | null;
  status: string;
  ownerId?: string | null;
  ownerName?: string | null;
  defaultCurrency?: string | null;
}

const STATUSES = ['lead', 'active', 'paused', 'archived'] as const;
const STATUS_COLOR: Record<string, string> = {
  lead: '#3b82f6', active: '#22c55e', paused: '#eab308', archived: '#9ca3af',
};
const CURRENCIES = ['USD', 'EUR', 'GBP', 'UAH', 'PLN'];

function favicon(domain?: string | null): string | null {
  if (!domain) return null;
  const clean = domain.replace(/^https?:\/\//, '').split('/')[0];
  return `https://www.google.com/s2/favicons?domain=${clean}`;
}

export function CompaniesPage() {
  const t = useT();
  const navigate = useNavigate();
  const can = useCan();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery<Company[]>({
    queryKey: ['companies', q, status],
    queryFn: () => api.get<{ data: Company[] }>(`/companies${qs({ q, status })}`).then((r) => r.data),
  });

  const companies = data ?? [];
  const canWrite = can('crm.write');

  return (
    <div>
      <PageHeader
        title={t('nav.clients')}
        subtitle={t('crm.subtitle')}
        actions={canWrite && (
          <Button size="sm" onClick={() => setCreating(true)}><Plus size={14} /> {t('crm.newClient')}</Button>
        )}
      />

      <div className="flex items-center gap-2 border-b border-border px-6 py-2">
        <div className="relative flex-1 max-w-xs">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('crm.searchClients')} className="pl-8" />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t('common.allStatuses')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}
        </Select>
      </div>

      <div className="p-6">
        {isLoading ? (
          <div className="space-y-1">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : companies.length === 0 ? (
          <EmptyState
            title={q || status ? t('crm.noMatch') : t('crm.empty')}
            hint={q || status ? t('crm.noMatchHint') : t('crm.emptyHint')}
            action={canWrite && !q && !status ? <Button size="sm" onClick={() => setCreating(true)}><Plus size={14} /> {t('crm.newClient')}</Button> : undefined}
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">{t('common.name')}</th>
                  <th className="px-3 py-2 font-medium">{t('common.status')}</th>
                  <th className="px-3 py-2 font-medium">{t('crm.owner')}</th>
                  <th className="px-3 py-2 font-medium">{t('common.currency')}</th>
                </tr>
              </thead>
              <tbody>
                {companies.map((c) => {
                  const fav = favicon(c.domain);
                  return (
                    <tr key={c.id} onClick={() => navigate(`/companies/${c.id}`)}
                      className="cursor-pointer border-b border-border last:border-0 hover:bg-muted">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          {fav
                            ? <img src={fav} alt="" width={16} height={16} className="h-4 w-4 rounded-sm" />
                            : <Building2 size={16} className="text-muted-foreground" />}
                          <span className="font-medium">{c.name}</span>
                          {c.domain && <span className="text-xs text-muted-foreground">{c.domain}</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <Badge color={STATUS_COLOR[c.status]}>{c.status}</Badge>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{c.ownerName ?? '—'}</td>
                      <td className="px-3 py-2 text-muted-foreground">{c.defaultCurrency ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating && (
        <CreateCompanyModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            qc.invalidateQueries({ queryKey: ['companies'] });
            navigate(`/companies/${id}`);
          }}
        />
      )}
    </div>
  );
}

function CreateCompanyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [status, setStatus] = useState<string>('lead');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => api.post<Company>('/companies', { name, status, defaultCurrency: currency }),
    onSuccess: (c) => onCreated(c.id),
    onError: (e) => setError(e instanceof ApiError ? e.message : t('crm.createFailed')),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError(t('common.nameRequired')); return; }
    mut.mutate();
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className={cn('w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg')} onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t('crm.newClient')}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('common.name')}</label>
            <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('common.status')}</label>
              <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full">
                {STATUSES.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('common.currency')}</label>
              <Select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-full">
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={mut.isPending}>{t('common.create')}</Button>
          </div>
        </form>
      </div>
    </div>
  );
}
