import { useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, Plus, Star } from 'lucide-react';
import { api, qs, ApiError } from '../lib/api';
import { Link } from '../lib/router';
import { useCan } from '../lib/auth';
import { Button, Input, Textarea, Badge, Card, EmptyState, Skeleton, Spinner, fmtMoney, fmtDate, cn } from '../components/ui';

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

function docToText(body: unknown): string {
  if (!body) return '';
  if (typeof body === 'string') return body;
  const walk = (node: unknown): string => {
    const n = node as { text?: string; content?: unknown[] } | null;
    if (!n) return '';
    if (typeof n.text === 'string') return n.text;
    if (Array.isArray(n.content)) return n.content.map(walk).join('');
    return '';
  };
  const b = body as { content?: unknown[] };
  if (Array.isArray(b.content)) return b.content.map((n) => walk(n)).join('\n');
  return walk(body);
}

function textToDoc(text: string) {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

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

export function CompanyDetailPage({ id }: { id: string }) {
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
          {visibleTabs.map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={cn('rounded-t-md px-3 py-1.5 capitalize', tab === t ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground hover:text-foreground')}>
              {t}
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
  const { data, isLoading } = useQuery<Overview>({
    queryKey: ['company', id, 'overview'],
    queryFn: () => api.get<Overview>(`/companies/${id}/overview`),
  });

  if (isLoading) return <div className="grid gap-4 sm:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-24" />)}</div>;

  const billing = billingRows(data?.billing);

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Tile label="Active projects" value={data?.activeProjects ?? 0} />
        <Tile label="Open tasks" value={data?.openTasks ?? 0} />
      </div>

      {billing.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Finance</h3>
          <div className="space-y-3">
            {billing.map((b, i) => (
              <div key={i} className="grid gap-4 sm:grid-cols-3">
                <Tile label={`Invoiced (${b.currency})`} value={fmtMoney(b.invoiced, b.currency)} />
                <Tile label={`Paid (${b.currency})`} value={fmtMoney(b.paid, b.currency)} />
                <Tile label={`Receivable (${b.currency})`} value={fmtMoney(b.receivable, b.currency)} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ContactsTab({ id, canWrite }: { id: string; canWrite: boolean }) {
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
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not add contact.'),
  });

  const contacts = data ?? [];

  return (
    <div className="max-w-2xl space-y-3">
      {canWrite && !adding && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus size={14} /> Add contact</Button>}
      {adding && (
        <Card className="p-4">
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); setError(null); if (!first.trim()) { setError('First name is required.'); return; } mut.mutate(); }} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Input autoFocus placeholder="First name" value={first} onChange={(e) => setFirst(e.target.value)} />
              <Input placeholder="Last name" value={last} onChange={(e) => setLast(e.target.value)} />
            </div>
            <Input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={mut.isPending}>Add</Button>
            </div>
          </form>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-1">{[0, 1].map((i) => <Skeleton key={i} className="h-12" />)}</div>
      ) : contacts.length === 0 ? (
        <EmptyState title="No contacts yet" hint="Add the people you work with at this client so documents and mentions can reach them." />
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
  const { data, isLoading } = useQuery<Deal[]>({
    queryKey: ['deals', 'company', id],
    queryFn: () => api.get<{ data: Deal[] }>(`/deals${qs({ companyId: id })}`).then((r) => r.data),
  });
  const deals = data ?? [];

  if (isLoading) return <div className="space-y-1 max-w-2xl">{[0, 1].map((i) => <Skeleton key={i} className="h-12" />)}</div>;
  if (deals.length === 0) return <EmptyState title="No deals" hint="Deals for this client will show up here. Create one from the Deals board." />;

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
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Note[]>({
    queryKey: ['notes', id],
    queryFn: () => api.get<{ data: Note[] }>(`/notes${qs({ companyId: id })}`).then((r) => r.data),
  });
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => api.post('/notes', { companyId: id, body: textToDoc(text) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['notes', id] }); setText(''); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save note.'),
  });

  const notes = data ?? [];

  return (
    <div className="max-w-2xl space-y-4">
      {canWrite && (
        <form onSubmit={(e: FormEvent) => { e.preventDefault(); setError(null); if (!text.trim()) return; mut.mutate(); }} className="space-y-2">
          <Textarea rows={3} placeholder="Write a note…" value={text} onChange={(e) => setText(e.target.value)} />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={mut.isPending || !text.trim()}>Add note</Button>
          </div>
        </form>
      )}

      {isLoading ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : notes.length === 0 ? (
        <EmptyState title="No notes yet" hint="Capture context, meeting takeaways, or reminders about this client." />
      ) : (
        <div className="space-y-2">
          {notes.map((n) => (
            <Card key={n.id} className="p-3">
              <p className="whitespace-pre-wrap text-sm">{docToText(n.body)}</p>
              <p className="mt-2 text-xs text-muted-foreground">{n.authorName ? `${n.authorName} · ` : ''}{fmtDate(n.createdAt)}</p>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityTab({ id }: { id: string }) {
  const { data, isLoading } = useQuery<AuditEntry[]>({
    queryKey: ['audit', 'company', id],
    queryFn: () => api.get<{ data: AuditEntry[] }>(`/audit/entity/company/${id}`).then((r) => r.data),
  });
  const entries = data ?? [];

  if (isLoading) return <div className="space-y-2 max-w-2xl">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>;
  if (entries.length === 0) return <EmptyState title="No activity" hint="Changes to this client and its records will be logged here." />;

  return (
    <ul className="max-w-2xl space-y-2">
      {entries.map((a) => (
        <li key={a.id} className="flex items-start gap-2 text-sm">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
          <span className="flex-1">
            {a.actorName && <span className="font-medium">{a.actorName} </span>}
            <span className="text-muted-foreground">{a.summary ?? a.action ?? 'made a change'}</span>
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{fmtDate(a.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}
