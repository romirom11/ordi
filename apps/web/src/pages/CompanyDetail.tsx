/**
 * Company (client) detail — rebuilt for the unified CRM.
 * Header: big avatar, inline-editable name, status pill dropdown, domain link,
 * owner picker. Two columns: main sections (Deals · Contacts · Notes) + a side
 * properties card with linked projects.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Building2, ChevronDown, Plus, Mail, Phone, Star, Pin, Globe, Check,
  FolderKanban, Handshake, Receipt,
} from 'lucide-react';
import { api, qs, ApiError } from '../lib/api';
import { Link, useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import {
  Avatar, Badge, Breadcrumbs, Button, Card, EmptyState, IconButton, Skeleton, Spinner, Tooltip,
  cn, fmtMoney, fmtDate,
} from '../components/ui';
import { DropdownMenu, MenuItem, MenuLabel, toast } from '../components/overlays';
import { RichEditor } from '../components/richtext/RichEditor';
import { RichText, docIsEmpty } from '../components/richtext/RichText';
import { useT } from '../lib/i18n';
import {
  COMPANY_STATUSES, CURRENCIES, StatusPill, useDealStages, useUsersLookup,
  type Company, type Contact, type Deal, type Stage,
} from '../components/crm/shared';
import { AddContactDialog, NewDealDialog } from '../components/crm/dialogs';
import { useWorkspaceSettings, financeEnabled } from '../components/finance/workspace';

interface Note { id: string; body?: unknown; createdAt?: string; authorName?: string; pinned?: boolean }
interface Project { id: string; name: string; key?: string | null; status?: string | null }

function domainHref(domain?: string | null): string | null {
  if (!domain) return null;
  return `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
}

export function CompanyDetailPage({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const canWrite = can('crm.write');

  const companyQ = useQuery<Company>({ queryKey: ['company', id], queryFn: () => api.get<Company>(`/companies/${id}`) });
  const usersQ = useUsersLookup();
  const c = companyQ.data;

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<Company>(`/companies/${id}`, { ...body, version: c?.version }),
    onSuccess: (updated, vars) => {
      qc.setQueryData(['company', id], updated);
      qc.invalidateQueries({ queryKey: ['companies'] });
      if ('name' in vars) toast(t('crm.nameUpdated'));
      else if ('ownerId' in vars) toast(t('crm.ownerUpdated'));
      else if ('status' in vars) toast(t('crm.statusUpdated'));
    },
    onError: (e) => {
      qc.invalidateQueries({ queryKey: ['company', id] });
      if (e instanceof ApiError && (e.code === 'version_conflict' || e.status === 409)) toast.error(t('crm.conflict'));
      else toast.error(e instanceof ApiError ? e.message : t('common.saveFailed'));
    },
  });

  const owner = c?.ownerId ? (usersQ.data ?? []).find((u) => u.id === c.ownerId) : undefined;
  const href = domainHref(c?.domain);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Breadcrumb + header */}
      <div className="border-b border-border px-6 pb-4 pt-3">
        <Breadcrumbs
          className="mb-3"
          items={[
            { label: t('crm.title'), to: '/crm/clients' },
            { label: c?.name ?? '…' },
          ]}
        />
        <div className="flex items-start gap-4">
          {c ? <Avatar name={c.name} size={48} className="text-base" /> : <Skeleton className="h-12 w-12 rounded-full" />}
          <div className="min-w-0 flex-1">
            {companyQ.isLoading ? (
              <Skeleton className="h-6 w-52" />
            ) : c ? (
              <EditableName value={c.name} editable={canWrite} onSave={(name) => patch.mutate({ name })} />
            ) : (
              <div className="flex items-center gap-2 text-muted-foreground"><Building2 size={18} /> {t('common.error')}</div>
            )}
            {c && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {/* Status dropdown */}
                {canWrite ? (
                  <DropdownMenu
                    align="start"
                    trigger={
                      <button className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted">
                        <StatusPill status={c.status} />
                        <ChevronDown size={12} className="text-faint" />
                      </button>
                    }
                  >
                    <MenuLabel>{t('crm.changeStatus')}</MenuLabel>
                    {COMPANY_STATUSES.map((s) => (
                      <MenuItem key={s} checked={c.status === s} onSelect={() => c.status !== s && patch.mutate({ status: s })}>
                        <StatusPill status={s} />
                      </MenuItem>
                    ))}
                  </DropdownMenu>
                ) : (
                  <StatusPill status={c.status} />
                )}

                {href && (
                  <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline">
                    <Globe size={12} /> {c.domain}
                  </a>
                )}

                {/* Owner picker */}
                <OwnerPicker
                  owner={owner}
                  users={usersQ.data ?? []}
                  editable={canWrite}
                  onPick={(uid) => patch.mutate({ ownerId: uid })}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Body: main + side */}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto grid max-w-6xl gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-8">
            {can('deals.read') && <DealsSection companyId={id} canWrite={can('deals.write')} />}
            <InvoicesSection companyId={id} />
            <ContactsSection companyId={id} canWrite={canWrite} />
            <NotesSection companyId={id} canWrite={canWrite} />
          </div>
          <aside className="space-y-4">
            <PropertiesCard company={c} loading={companyQ.isLoading} />
            <ProjectsCard companyId={id} />
          </aside>
        </div>
      </div>
    </div>
  );
}

/* ─────────────── Inline editable name ─────────────── */

function EditableName({ value, editable, onSave }: { value: string; editable: boolean; onSave: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { setDraft(value); }, [value]);
  useEffect(() => { if (editing) ref.current?.select(); }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) onSave(next);
    else setDraft(value);
  };

  if (!editable) return <h1 className="text-xl font-semibold leading-tight">{value}</h1>;
  if (editing) {
    return (
      <input
        ref={ref}
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { setDraft(value); setEditing(false); } }}
        className="-mx-1.5 w-full max-w-md rounded-md border border-primary/40 bg-transparent px-1.5 text-xl font-semibold leading-tight outline-none focus:ring-2 focus:ring-ring/25"
      />
    );
  }
  return (
    <button
      onClick={() => setEditing(true)}
      className="-mx-1.5 rounded-md px-1.5 text-left text-xl font-semibold leading-tight transition-colors hover:bg-muted"
      title={value}
    >
      {value}
    </button>
  );
}

/* ─────────────── Owner picker ─────────────── */

function OwnerPicker({ owner, users, editable, onPick }: {
  owner?: { id: string; name: string; avatar?: string | null };
  users: { id: string; name: string; avatar?: string | null }[];
  editable: boolean;
  onPick: (id: string) => void;
}) {
  const t = useT();
  const content = (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {owner ? <Avatar name={owner.name} src={owner.avatar} size={18} /> : <span className="grid h-[18px] w-[18px] place-items-center rounded-full border border-dashed border-border-strong text-[10px] text-faint">?</span>}
      {owner ? owner.name : t('crm.noOwner')}
    </span>
  );
  if (!editable) return content;
  return (
    <DropdownMenu
      align="start"
      trigger={<button className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted">{content}<ChevronDown size={12} className="text-faint" /></button>}
    >
      <MenuLabel>{t('crm.changeOwner')}</MenuLabel>
      {users.map((u) => (
        <MenuItem key={u.id} onSelect={() => u.id !== owner?.id && onPick(u.id)}>
          <span className="flex items-center gap-2">
            <Avatar name={u.name} src={u.avatar} size={18} />
            <span className="flex-1">{u.name}</span>
            {owner?.id === u.id && <Check size={13} className="text-primary" />}
          </span>
        </MenuItem>
      ))}
    </DropdownMenu>
  );
}

/* ─────────────── Section shell ─────────────── */

function SectionHeader({ icon, title, count, action }: { icon: React.ReactNode; title: string; count?: number; action?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-[13px] font-semibold">
        <span className="text-muted-foreground">{icon}</span>
        {title}
        {count !== undefined && count > 0 && <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">{count}</span>}
      </h2>
      {action}
    </div>
  );
}

/* ─────────────── Deals ─────────────── */

function DealsSection({ companyId, canWrite }: { companyId: string; canWrite: boolean }) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const stagesQ = useDealStages();
  const dealsQ = useQuery<Deal[]>({
    queryKey: ['deals', 'company', companyId],
    queryFn: () => api.get<{ data: Deal[] }>(`/deals${qs({ companyId })}`).then((r) => r.data),
  });
  const stageMap = new Map((stagesQ.data ?? []).map((s: Stage) => [s.id, s]));
  const deals = dealsQ.data ?? [];

  return (
    <section>
      <SectionHeader
        icon={<Handshake size={15} />}
        title={t('crm.deals')}
        count={deals.length}
        action={canWrite && <Button variant="outline" size="xs" onClick={() => setAdding(true)}><Plus size={13} /> {t('crm.addDealForClient')}</Button>}
      />
      {dealsQ.isLoading ? (
        <div className="space-y-1">{[0, 1].map((i) => <Skeleton key={i} className="h-11 rounded-md" />)}</div>
      ) : deals.length === 0 ? (
        <EmptyState icon={<Handshake size={18} />} title={t('deals.empty')} hint={t('crm.noDealsHint')} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {deals.map((d, i) => {
            const stage = d.stageId ? stageMap.get(d.stageId) : undefined;
            const color = stage?.isWon ? '#22c55e' : stage?.isLost ? '#ef4444' : undefined;
            return (
              <div key={d.id} className={cn('flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50', i > 0 && 'border-t border-border')}>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{d.title}</span>
                {stage && <Badge color={color}>{stage.name}</Badge>}
                <span className="w-24 text-right text-[13px] font-semibold tabular-nums">
                  {d.amount != null ? fmtMoney(d.amount, d.currency ?? 'USD') : '—'}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <NewDealDialog open={adding} onClose={() => setAdding(false)} lockedCompanyId={companyId} onCreated={() => dealsQ.refetch()} />
    </section>
  );
}

/* ─────────────── Invoices (finance-gated) ─────────────── */

interface InvoiceRow {
  id: string;
  number?: string | null;
  status?: string | null;
  issueDate?: string | null;
  total?: number | string | null;
  amountPaid?: number | string | null;
  currency?: string | null;
  isOverdue?: boolean;
}

const INV_TONE: Record<string, string> = {
  draft: 'bg-muted text-muted-foreground',
  sent: 'bg-primary/15 text-primary',
  viewed: 'bg-primary/15 text-primary',
  partially_paid: 'bg-warning/15 text-warning',
  paid: 'bg-success/15 text-success',
  canceled: 'bg-muted text-muted-foreground',
  overdue: 'bg-destructive/15 text-destructive',
};

function InvoiceStatusPill({ status, overdue }: { status?: string | null; overdue?: boolean }) {
  const t = useT();
  const key = overdue ? 'overdue' : status ?? 'draft';
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium', INV_TONE[key] ?? INV_TONE.draft)}>
      {t(`finance.status.${key}`, key.replace('_', ' '))}
    </span>
  );
}

function InvoicesSection({ companyId }: { companyId: string }) {
  const t = useT();
  const can = useCan();
  const navigate = useNavigate();
  const wsQ = useWorkspaceSettings();

  const enabled = financeEnabled(wsQ.data) && can('finance.read');

  const invoicesQ = useQuery<InvoiceRow[]>({
    queryKey: ['invoices', 'company', companyId],
    queryFn: () => api.get<{ data: InvoiceRow[] }>(`/invoices${qs({ companyId })}`).then((r) => r.data),
    enabled,
  });

  // Only render once we know finance is enabled and the user can read it.
  if (wsQ.isLoading || !enabled) return null;

  const invoices = invoicesQ.data ?? [];
  const currency = invoices[0]?.currency ?? 'USD';
  const outstanding = invoices.reduce((sum, iv) => {
    if (iv.status === 'canceled') return sum;
    return sum + (Number(iv.total ?? 0) - Number(iv.amountPaid ?? 0));
  }, 0);

  return (
    <section>
      <SectionHeader
        icon={<Receipt size={15} />}
        title={t('crm.invoices')}
        count={invoices.length}
        action={can('finance.write') && (
          <Link to="/finance">
            <Button variant="outline" size="xs"><Plus size={13} /> {t('crm.newInvoice')}</Button>
          </Link>
        )}
      />
      {invoicesQ.isLoading ? (
        <div className="space-y-1">{[0, 1].map((i) => <Skeleton key={i} className="h-11 rounded-md" />)}</div>
      ) : invoices.length === 0 ? (
        <EmptyState icon={<Receipt size={18} />} title={t('crm.noInvoices')} hint={t('crm.noInvoicesHint')} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {invoices.map((iv, i) => {
            const overdue = iv.isOverdue || iv.status === 'overdue';
            return (
              <div
                key={iv.id}
                onClick={() => navigate(`/finance/invoices/${iv.id}`)}
                className={cn('flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50', i > 0 && 'border-t border-border')}
              >
                <span className="w-24 shrink-0 truncate font-mono text-[11px] text-muted-foreground">{iv.number ?? iv.id.slice(0, 8)}</span>
                <InvoiceStatusPill status={iv.status} overdue={overdue} />
                <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground tabular-nums">{fmtDate(iv.issueDate)}</span>
                <span className="w-24 shrink-0 text-right text-[13px] font-semibold tabular-nums">{fmtMoney(iv.total ?? 0, iv.currency ?? 'USD')}</span>
              </div>
            );
          })}
          <div className="flex items-center justify-between border-t border-border bg-muted/20 px-3 py-2 text-[13px]">
            <span className="text-muted-foreground">{t('crm.totalOutstanding')}</span>
            <span className={cn('font-semibold tabular-nums', outstanding > 0 && 'text-destructive')}>{fmtMoney(outstanding, currency)}</span>
          </div>
        </div>
      )}
    </section>
  );
}

/* ─────────────── Contacts ─────────────── */

function ContactsSection({ companyId, canWrite }: { companyId: string; canWrite: boolean }) {
  const t = useT();
  const [adding, setAdding] = useState(false);
  const { data, isLoading } = useQuery<Contact[]>({
    queryKey: ['contacts', companyId],
    queryFn: () => api.get<{ data: Contact[] }>(`/contacts${qs({ companyId })}`).then((r) => r.data),
  });
  const contacts = data ?? [];

  return (
    <section>
      <SectionHeader
        icon={<Building2 size={15} />}
        title={t('crm.contacts')}
        count={contacts.length}
        action={canWrite && <Button variant="outline" size="xs" onClick={() => setAdding(true)}><Plus size={13} /> {t('crm.addContact')}</Button>}
      />
      {isLoading ? (
        <div className="space-y-1">{[0, 1].map((i) => <Skeleton key={i} className="h-12 rounded-md" />)}</div>
      ) : contacts.length === 0 ? (
        <EmptyState icon={<Building2 size={18} />} title={t('crm.noContacts')} hint={t('crm.noContactsHint')} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {contacts.map((ct, i) => {
            const name = [ct.firstName, ct.lastName].filter(Boolean).join(' ') || '—';
            return (
              <div key={ct.id} className={cn('flex items-center gap-3 px-3 py-2.5', i > 0 && 'border-t border-border')}>
                <Avatar name={name} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[13px] font-medium">
                    <span className="truncate">{name}</span>
                    {ct.isPrimary && <Tooltip label={t('crm.primary')}><Star size={12} className="fill-warning text-warning" /></Tooltip>}
                  </div>
                  {ct.position && <div className="truncate text-xs text-faint">{ct.position}</div>}
                </div>
                <div className="flex items-center gap-1">
                  {ct.email && (
                    <Tooltip label={ct.email}>
                      <a href={`mailto:${ct.email}`} aria-label={t('crm.contactEmail')}>
                        <IconButton size="sm"><Mail size={14} /></IconButton>
                      </a>
                    </Tooltip>
                  )}
                  {ct.phone && (
                    <Tooltip label={ct.phone}>
                      <a href={`tel:${ct.phone}`} aria-label={t('crm.contactCall')}>
                        <IconButton size="sm"><Phone size={14} /></IconButton>
                      </a>
                    </Tooltip>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <AddContactDialog open={adding} onClose={() => setAdding(false)} companyId={companyId} />
    </section>
  );
}

/* ─────────────── Notes ─────────────── */

function NotesSection({ companyId, canWrite }: { companyId: string; canWrite: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Note[]>({
    queryKey: ['notes', companyId],
    queryFn: () => api.get<{ data: Note[] }>(`/notes${qs({ companyId })}`).then((r) => r.data),
  });
  const [doc, setDoc] = useState<any>(null);
  const [editorKey, setEditorKey] = useState(0);

  const create = useMutation({
    mutationFn: (body: any) => api.post('/notes', { companyId, body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['notes', companyId] }); setDoc(null); setEditorKey((k) => k + 1); toast(t('common.saved')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('crm.saveNoteFailed')),
  });

  const pin = useMutation({
    mutationFn: (n: Note) => api.patch(`/notes/${n.id}`, { pinned: !n.pinned }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notes', companyId] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const submit = () => { if (docIsEmpty(doc) || create.isPending) return; create.mutate(doc); };
  const notes = data ?? [];

  return (
    <section>
      <SectionHeader icon={<Pin size={15} />} title={t('crm.notes')} count={notes.length} />
      {canWrite && (
        <div className="mb-4 space-y-2">
          <RichEditor key={editorKey} value={doc} onChange={setDoc} compact placeholder={t('crm.notePlaceholder')} onSubmit={submit} />
          <div className="flex justify-end">
            <Button size="sm" onClick={submit} disabled={create.isPending || docIsEmpty(doc)}>
              {create.isPending ? <Spinner /> : t('crm.saveNote')}
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-16 rounded-lg" />)}</div>
      ) : notes.length === 0 ? (
        <EmptyState icon={<Pin size={18} />} title={t('crm.noNotes')} hint={t('crm.noNotesHint')} />
      ) : (
        <div className="space-y-2">
          {notes.map((n) => (
            <Card key={n.id} className={cn('group/note p-3', n.pinned && 'border-primary/30 bg-primary/[0.03]')}>
              <div className="flex items-start justify-between gap-2">
                <RichText doc={n.body} className="min-w-0 flex-1 text-[13px]" />
                {canWrite && (
                  <Tooltip label={n.pinned ? t('crm.unpinNote') : t('crm.pinNote')}>
                    <IconButton
                      size="sm"
                      onClick={() => pin.mutate(n)}
                      className={cn(n.pinned ? 'text-primary opacity-100' : 'opacity-0 group-hover/note:opacity-100')}
                    >
                      <Pin size={13} className={cn(n.pinned && 'fill-current')} />
                    </IconButton>
                  </Tooltip>
                )}
              </div>
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-faint">
                {n.pinned && <span className="font-medium text-primary">{t('crm.pinned')} ·</span>}
                {n.authorName ? `${n.authorName} · ` : ''}{fmtDate(n.createdAt)}
              </p>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

/* ─────────────── Side: properties ─────────────── */

function PropRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-[13px]">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right">{children}</span>
    </div>
  );
}

function PropertiesCard({ company, loading }: { company?: Company; loading: boolean }) {
  const t = useT();
  return (
    <Card className="p-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">{t('crm.properties')}</h3>
      {loading || !company ? (
        <div className="space-y-2 pt-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-4" />)}</div>
      ) : (
        <div className="divide-y divide-border/60">
          <PropRow label={t('common.status')}><StatusPill status={company.status} /></PropRow>
          <PropRow label={t('crm.billingEmail')}>
            {company.billingEmail
              ? <a href={`mailto:${company.billingEmail}`} className="text-primary hover:underline">{company.billingEmail}</a>
              : <span className="text-faint">—</span>}
          </PropRow>
          <PropRow label={t('common.currency')}><span className="tabular-nums">{company.defaultCurrency || '—'}</span></PropRow>
          <PropRow label={t('crm.paymentTerms')}>
            {company.paymentTermsDays != null
              ? <span className="tabular-nums">{t('crm.paymentTermsValue').replace('{n}', String(company.paymentTermsDays))}</span>
              : <span className="text-faint">—</span>}
          </PropRow>
          <PropRow label={t('crm.created')}>{fmtDate(company.createdAt)}</PropRow>
        </div>
      )}
    </Card>
  );
}

function ProjectsCard({ companyId }: { companyId: string }) {
  const t = useT();
  const { data, isLoading } = useQuery<Project[]>({
    queryKey: ['projects', 'company', companyId],
    queryFn: () => api.get<{ data: Project[] }>(`/projects${qs({ companyId })}`).then((r) => r.data).catch(() => []),
  });
  const projects = data ?? [];
  if (isLoading) return <Card className="p-4"><Skeleton className="h-4 w-24" /></Card>;
  if (projects.length === 0) return null;

  return (
    <Card className="p-4">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">{t('crm.linkedProjects')}</h3>
      <div className="space-y-0.5">
        {projects.map((p) => (
          <Link
            key={p.id}
            to={`/projects/${p.id}`}
            className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1.5 text-[13px] transition-colors hover:bg-muted"
          >
            <FolderKanban size={14} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {p.key && <span className="shrink-0 font-mono text-[11px] text-faint">{p.key}</span>}
          </Link>
        ))}
      </div>
    </Card>
  );
}
