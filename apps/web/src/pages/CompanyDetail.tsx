import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, Star } from 'lucide-react';
import { api, qs, ApiError } from '../lib/api';
import { Link } from '../lib/router';
import { useCan } from '../lib/auth';
import { Button, Input, Badge, Card, EmptyState, Skeleton, Spinner, fmtMoney, fmtDate, cn } from '../components/ui';
import { RichEditor } from '../components/richtext/RichEditor';
import { RichText, docIsEmpty } from '../components/richtext/RichText';
import { useT } from '../lib/i18n';

interface Company {
  id: string;
  name: string;
  domain?: string | null;
  status: string;
  ownerName?: string | null;
  defaultCurrency?: string | null;
}
interface Overview {
  activeProjects?: number;
  openTasks?: number;
  billing?: unknown;
}
interface Contact {
  id: string; firstName?: string; lastName?: string; email?: string | null; phone?: string | null; position?: string | null; isPrimary?: boolean;
}
interface Deal {
  id: string; title: string; amount?: number | string; currency?: string; stageName?: string; stageId?: string;
}
interface Note {
  id: string; body?: unknown; createdAt?: string; authorName?: string; pinned?: boolean;
}
interface AuditEntry {
  id: string; action?: string; actorName?: string; summary?: string; createdAt?: string;
}

const STATUS_COLOR: Record<string, string> = {
  lead: '#3b82f6', active: '#22c55e', paused: '#eab308', archived: '#9ca3af',
};

type BillingRow = { currency: string; invoiced: number; paid: number; receivable: number };
function billingRows(billing: unknown): BillingRow[] {
  if (!billing) return [];
  const one = (v: unknown): BillingRow => {
    const o = (v ?? {}) as Record<string, unknown>;
    return {
      currency: String(o.currency ?? 'USD'),
      invoiced: Number(o.invoiced ?? o.billed ?? 0),
      paid: Number(o.paid ?? 0),
      receivable: Number(o.receivable ?? o.outstanding ?? o.due ?? 0),
    };
  };
  return Array.isArray(billing) ? billing.map(one) : [one(billing)];
}

const TABS = ['overview', 'contacts', 'deals', 'notes', 'activity'] as const;
type Tab = typeof TABS[number];

const TAB_LABELS: Record<Tab, string> = {
  overview: 'crm.tabOverview',
  contacts: 'crm.tabContacts',
  deals: 'nav.deals',
  notes: 'crm.tabNotes',
  activity: 'crm.tabActivity',
};

export function CompanyDetailPage({ id }: { id: string }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>('overview');
  const can = useCan();

  const company = useQuery<Company>({
    queryKey: ['company', id],
    queryFn: () => api.get<Company>(`/companies/${id}`),
  });

  const c = company.data;
  const fav = c?.domain ? `https://www.google.com/s2/favicons?domain=${c.domain.replace(/^https?:\/\//, '').split('/')[0]}` : null;

  const visibleTabs = TABS.filter((t) => !(t === 'deals' && !can('deals.read')));

  return (
    <div>
      <div className="border-b border-border px-6 pt-4">
        <div className="mb-3 flex items-center gap-3">
          {fav ? <img src={fav} alt="" width={24} height={24} className="h-6 w-6 rounded" /> : <Building2 size={22} className="text-muted-foreground" />}
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              {company.isLoading ? <Skeleton className="h-5 w-40" /> : c?.name}
              {c && <Badge color={STATUS_COLOR[c.status]}>{c.status}</Badge>}
            </h1>
            {c?.domain && <a href={`https://${c.domain.replace(/^https?:\/\//, '')}`} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground hover:underline">{c.domain}</a>}
          </div>
        </div>
        <nav className="flex gap-1 text-sm">
          {visibleTabs.map((tb) => (
            <button key={tb} onClick={() => setTab(tb)}
              className={cn('rounded-t-md px-3 py-1.5 capitalize', tab === tb ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground hover:text-foreground')}>
              {t(TAB_LABELS[tb])}
            </button>
          ))}
        </nav>
      </div>

      <div className="p-6">
        {tab === 'overview' && <OverviewTab id={id} />}
        {tab === 'contacts' && <ContactsTab id={id} canWrite={can('crm.write')} />}
        {tab === 'deals' && can('deals.read') && <DealsTab id={id} />}
        {tab === 'notes' && <NotesTab id={id} canWrite={can('crm.write')} />}
        {tab === 'activity' && <ActivityTab id={id} />}
      </div>
    </div>
  );
}

function Tile({ label, value }: { label: string; value: ReactNode }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
    </Card>
  );
}

function OverviewTab({ id }: { id: string }) {
  const t = useT();
  const { data, isLoading } = useQuery<Overview>({
    queryKey: ['company', id, 'overview'],
    queryFn: () => api.get<Overview>(`/companies/${id}/overview`),
  });

  if (isLoading) return <div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>;

  const billing = billingRows(data?.billing);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Tile label={t('crm.activeProjects')} value={data?.activeProjects ?? 0} />
        <Tile label={t('crm.openTasks')} value={data?.openTasks ?? 0} />
      </div>

      {billing.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('nav.finance')}</h3>
          <div className="space-y-3">
            {billing.map((b, i) => (
              <div key={i} className="grid gap-4 sm:grid-cols-3">
                <Tile label={`${t('crm.invoiced')} (${b.currency})`} value={fmtMoney(b.invoiced, b.currency)} />
                <Tile label={`${t('public.paid')} (${b.currency})`} value={fmtMoney(b.paid, b.currency)} />
                <Tile label={`${t('finance.receivable')} (${b.currency})`} value={fmtMoney(b.receivable, b.currency)} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ContactsTab({ id, canWrite }: { id: string; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Contact[]>({
    queryKey: ['contacts', id],
    queryFn: () => api.get<{ data: Contact[] }>(`/contacts${qs({ companyId: id })}`).then((r) => r.data),
  });
  const [adding, setAdding] = useState(false);
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => api.post('/contacts', { companyId: id, firstName: first, lastName: last, email: email || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['contacts', id] }); setAdding(false); setFirst(''); setLast(''); setEmail(''); },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('crm.addContactFailed')),
  });

  const contacts = data ?? [];

  return (
    <div className="max-w-2xl space-y-3">
      {canWrite && !adding && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus size={14} /> {t('crm.addContact')}</Button>}
      {adding && (
        <Card className="p-4">
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); setError(null); if (!first.trim()) { setError(t('crm.firstNameRequired')); return; } mut.mutate(); }} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Input autoFocus placeholder={t('crm.firstName')} value={first} onChange={(e) => setFirst(e.target.value)} />
              <Input placeholder={t('crm.lastName')} value={last} onChange={(e) => setLast(e.target.value)} />
            </div>
            <Input type="email" placeholder={t('auth.email')} value={email} onChange={(e) => setEmail(e.target.value)} />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setAdding(false)}>{t('common.cancel')}</Button>
              <Button type="submit" size="sm" disabled={mut.isPending}>{t('common.add')}</Button>
            </div>
          </form>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-1">{[0, 1].map((i) => <Skeleton key={i} className="h-12" />)}</div>
      ) : contacts.length === 0 ? (
        <EmptyState title={t('crm.noContacts')} hint={t('crm.noContactsHint')} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {contacts.map((ct, i) => (
            <div key={ct.id} className={cn('flex items-center gap-3 px-3 py-2 text-sm', i > 0 && 'border-t border-border')}>
              <div className="flex-1">
                <div className="flex items-center gap-1.5 font-medium">
                  {[ct.firstName, ct.lastName].filter(Boolean).join(' ') || '—'}
                  {ct.isPrimary && <Star size={12} className="fill-current text-yellow-500" />}
                </div>
                {ct.position && <p className="text-xs text-muted-foreground">{ct.position}</p>}
              </div>
              <div className="text-right text-xs text-muted-foreground">
                {ct.email && <div>{ct.email}</div>}
                {ct.phone && <div>{ct.phone}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DealsTab({ id }: { id: string }) {
  const t = useT();
  const { data, isLoading } = useQuery<Deal[]>({
    queryKey: ['deals', 'company', id],
    queryFn: () => api.get<{ data: Deal[] }>(`/deals${qs({ companyId: id })}`).then((r) => r.data),
  });
  const deals = data ?? [];

  if (isLoading) return <div className="space-y-1 max-w-2xl">{[0, 1].map((i) => <Skeleton key={i} className="h-12" />)}</div>;
  if (deals.length === 0) return <EmptyState title={t('deals.empty')} hint={t('crm.noDealsHint')} />;

  return (
    <div className="max-w-2xl overflow-hidden rounded-lg border border-border bg-card">
      {deals.map((d, i) => (
        <Link key={d.id} to="/deals" className={cn('flex items-center justify-between px-3 py-2 text-sm hover:bg-muted', i > 0 && 'border-t border-border')}>
          <div>
            <span className="font-medium">{d.title}</span>
            {d.stageName && <Badge className="ml-2 bg-muted text-muted-foreground">{d.stageName}</Badge>}
          </div>
          <span className="tabular-nums">{d.amount != null ? fmtMoney(d.amount, d.currency ?? 'USD') : '—'}</span>
        </Link>
      ))}
    </div>
  );
}

function NotesTab({ id, canWrite }: { id: string; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Note[]>({
    queryKey: ['notes', id],
    queryFn: () => api.get<{ data: Note[] }>(`/notes${qs({ companyId: id })}`).then((r) => r.data),
  });
  const [doc, setDoc] = useState<any>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: (body: any) => api.post('/notes', { companyId: id, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notes', id] });
      setDoc(null);
      setEditorKey((k) => k + 1); // remount the editor to clear it
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('crm.saveNoteFailed')),
  });

  const submit = () => {
    setError(null);
    if (docIsEmpty(doc) || mut.isPending) return;
    mut.mutate(doc);
  };

  const notes = data ?? [];

  return (
    <div className="max-w-2xl space-y-4">
      {canWrite && (
        <div className="space-y-2">
          <RichEditor key={editorKey} value={doc} onChange={setDoc} compact placeholder={t('crm.notePlaceholder')} onSubmit={submit} />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={submit} disabled={mut.isPending || docIsEmpty(doc)}>{t('crm.addNote')}</Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : notes.length === 0 ? (
        <EmptyState title={t('crm.noNotes')} hint={t('crm.noNotesHint')} />
      ) : (
        <div className="space-y-2">
          {notes.map((n) => (
            <Card key={n.id} className="p-3">
              <RichText doc={n.body} className="text-sm" />
              <p className="mt-2 text-xs text-muted-foreground">{n.authorName ? `${n.authorName} · ` : ''}{fmtDate(n.createdAt)}</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityTab({ id }: { id: string }) {
  const t = useT();
  const { data, isLoading } = useQuery<AuditEntry[]>({
    queryKey: ['audit', 'company', id],
    queryFn: () => api.get<{ data: AuditEntry[] }>(`/audit/entity/company/${id}`).then((r) => r.data),
  });
  const entries = data ?? [];

  if (isLoading) return <div className="space-y-2 max-w-2xl">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>;
  if (entries.length === 0) return <EmptyState title={t('crm.noActivity')} hint={t('crm.noActivityHint')} />;

  return (
    <ul className="max-w-2xl space-y-2">
      {entries.map((a) => (
        <li key={a.id} className="flex items-start gap-2 text-sm">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
          <span className="flex-1">
            {a.actorName && <span className="font-medium">{a.actorName} </span>}
            <span className="text-muted-foreground">{a.summary ?? a.action ?? t('dashboard.madeChange')}</span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{fmtDate(a.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
