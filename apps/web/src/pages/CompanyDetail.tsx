/**
 * Company (client) detail – rebuilt for the unified CRM.
 * Header: big avatar, inline-editable name, status pill dropdown, domain link,
 * owner picker. Two columns: main sections (Deals · Contacts · Notes) + a side
 * properties card with linked projects.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Building2, ChevronDown, Plus, Mail, Phone, Star, Globe,
  FolderKanban, Handshake, Pencil, Receipt, Trash2,
} from 'lucide-react';
import { api, qs, ApiError } from '../lib/api';
import { Link, useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import { usePageTitle } from '../lib/tabs';
import {
  Avatar, Badge, Breadcrumbs, Button, Card, EmptyState, IconButton, Select, Skeleton, Spinner, Tooltip,
  cn, fmtMoney, fmtDate,
} from '../components/ui';
import { ConfirmDialog, Dialog, DropdownMenu, MenuItem, MenuLabel, toast } from '../components/overlays';
import { useT } from '../lib/i18n';
import {
  COMPANY_STATUSES, CURRENCIES, StatusPill, useDealStages, useUsersLookup,
  type Company, type Contact, type Deal, type Stage,
} from '../components/crm/shared';
import { EditableName, FilesSection, NotesSection, OwnerPicker, PropRow, SectionHeader } from '../components/crm/detail';
import { ContactDialog, NewDealDialog } from '../components/crm/dialogs';
import { NewProjectModal } from './Projects';
import { useWorkspaceSettings, financeEnabled } from '../components/finance/workspace';

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
  // Tab and window title carry the client's name, not a generic "CRM".
  usePageTitle(c?.name);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<Company>(`/companies/${id}`, { ...body, version: c?.version }),
    onSuccess: (updated, vars) => {
      qc.setQueryData(['company', id], updated);
      qc.invalidateQueries({ queryKey: ['companies'] });
      if ('name' in vars) toast(t('crm.nameUpdated'));
      else if ('ownerId' in vars) toast(t('crm.ownerUpdated'));
      else if ('status' in vars) toast(t('crm.statusUpdated'));
      else toast(t('common.saved'));
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
            { label: t('crm.title'), to: '/crm' },
            { label: t('crm.tabClients'), to: '/crm/clients' },
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
        <div className="mx-auto grid max-w-6xl gap-6 p-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="space-y-8">
            {can('deals.read') && <DealsSection companyId={id} canWrite={can('deals.write')} />}
            <InvoicesSection companyId={id} />
            <ContactsSection companyId={id} canWrite={canWrite} />
            <NotesSection companyId={id} canWrite={canWrite} />
            <FilesSection entityType="company" entityId={id} canWrite={canWrite} />
          </div>
          <aside className="space-y-4">
            <PropertiesCard company={c} loading={companyQ.isLoading} editable={canWrite} onPatch={(body) => patch.mutate(body)} />
            <ProjectsCard companyId={id} />
          </aside>
        </div>
      </div>
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
              <Link key={d.id} to={`/deals/${d.id}`} className={cn('flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50', i > 0 && 'border-t border-border')}>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{d.title}</span>
                {stage && <Badge color={color}>{stage.name}</Badge>}
                <span className="w-24 text-right text-[13px] font-semibold tabular-nums">
                  {d.amount != null ? fmtMoney(d.amount, d.currency ?? 'USD') : '–'}
                </span>
              </Link>
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
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [toDelete, setToDelete] = useState<Contact | null>(null);
  const { data, isLoading } = useQuery<Contact[]>({
    queryKey: ['contacts', companyId],
    queryFn: () => api.get<{ data: Contact[] }>(`/contacts${qs({ companyId })}`).then((r) => r.data),
  });
  const contacts = data ?? [];

  const invalidate = () => qc.invalidateQueries({ queryKey: ['contacts', companyId] });
  const setPrimary = useMutation({
    mutationFn: (ct: Contact) => api.patch(`/contacts/${ct.id}`, { isPrimary: !ct.isPrimary }),
    onSuccess: () => { invalidate(); toast(t('common.saved')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/contacts/${id}`),
    onSuccess: () => { setToDelete(null); invalidate(); toast(t('crm.contactDeleted')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const contactName = (ct: Contact) => [ct.firstName, ct.lastName].filter(Boolean).join(' ') || '–';

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
            const name = contactName(ct);
            return (
              <div key={ct.id} className={cn('group/contact flex items-center gap-3 px-3 py-2.5', i > 0 && 'border-t border-border')}>
                <Avatar name={name} size={30} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[13px] font-medium">
                    <span className="truncate">{name}</span>
                    {canWrite ? (
                      <Tooltip label={ct.isPrimary ? t('crm.unsetPrimary') : t('crm.setPrimary')}>
                        <button
                          aria-label={ct.isPrimary ? t('crm.unsetPrimary') : t('crm.setPrimary')}
                          onClick={() => setPrimary.mutate(ct)}
                          className={cn('grid h-5 w-5 place-items-center rounded transition-all duration-150 hover:bg-muted',
                            ct.isPrimary ? 'opacity-100' : 'opacity-0 group-hover/contact:opacity-100')}
                        >
                          <Star size={12} className={cn(ct.isPrimary ? 'fill-warning text-warning' : 'text-faint')} />
                        </button>
                      </Tooltip>
                    ) : (
                      ct.isPrimary && <Tooltip label={t('crm.primary')}><Star size={12} className="fill-warning text-warning" /></Tooltip>
                    )}
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
                  {canWrite && (
                    <>
                      <Tooltip label={t('common.edit')}>
                        <IconButton size="sm" aria-label={t('common.edit')} onClick={() => setEditing(ct)}
                          className="opacity-0 transition-opacity duration-150 group-hover/contact:opacity-100">
                          <Pencil size={13} />
                        </IconButton>
                      </Tooltip>
                      <Tooltip label={t('common.delete')}>
                        <IconButton size="sm" aria-label={t('common.delete')} onClick={() => setToDelete(ct)}
                          className="opacity-0 transition-opacity duration-150 hover:text-destructive group-hover/contact:opacity-100">
                          <Trash2 size={13} />
                        </IconButton>
                      </Tooltip>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <ContactDialog open={adding} onClose={() => setAdding(false)} companyId={companyId} />
      <ContactDialog open={!!editing} onClose={() => setEditing(null)} companyId={companyId} contact={editing ?? undefined} />
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
        title={t('crm.deleteContactTitle')}
        body={toDelete ? t('crm.deleteContactBody').replace('{name}', contactName(toDelete)) : ''}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </section>
  );
}

/* ─────────────── Side: properties ─────────────── */

/** Payment terms keep their "N days" wording while staying click-to-edit. */
function EditablePaymentTerms({ days, onSave }: { days?: number | null; onSave: (n: number) => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (editing) {
    const commit = () => {
      setEditing(false);
      const n = Number(draft);
      if (draft !== '' && Number.isInteger(n) && n >= 0 && n !== days) onSave(n);
    };
    return (
      <input
        autoFocus type="number" min={0} value={draft}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
        className="w-20 rounded-md border border-primary/40 bg-transparent px-1 text-right text-[13px] tabular-nums outline-none focus:ring-2 focus:ring-ring/25"
      />
    );
  }
  return (
    <button
      onClick={() => { setDraft(days != null ? String(days) : ''); setEditing(true); }}
      className="-mx-1 rounded-md px-1 tabular-nums transition-colors hover:bg-muted"
    >
      {days != null ? t('crm.paymentTermsValue').replace('{n}', String(days)) : <span className="text-faint">–</span>}
    </button>
  );
}

/** Small click-to-edit text value for the properties card. */
function EditableProp({ value, editable, placeholder, type = 'text', align = 'right', onSave }: {
  value?: string | null; editable: boolean; placeholder?: string;
  type?: 'text' | 'email' | 'number'; align?: 'left' | 'right';
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  if (!editable && !value) return <span className="text-faint">–</span>;
  if (editing) {
    const commit = () => {
      setEditing(false);
      const next = draft.trim();
      if (next !== (value ?? '')) onSave(next);
    };
    return (
      <input
        autoFocus
        type={type}
        value={draft}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
        className={cn(
          'w-full min-w-[140px] rounded-md border border-primary/40 bg-transparent px-1 text-[13px] outline-none focus:ring-2 focus:ring-ring/25',
          align === 'right' && 'text-right',
          type === 'number' && 'tabular-nums',
        )}
      />
    );
  }
  const display = value || <span className="text-faint">{placeholder ?? '–'}</span>;
  if (!editable) return <span>{display}</span>;
  return (
    <button
      onClick={() => { setDraft(value ?? ''); setEditing(true); }}
      className={cn('-mx-1 max-w-full break-words rounded-md px-1 transition-colors hover:bg-muted', align === 'right' && 'text-right')}
    >
      {display}
    </button>
  );
}

function PropertiesCard({ company, loading, editable, onPatch }: {
  company?: Company; loading: boolean; editable: boolean; onPatch: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  return (
    <Card className="p-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">{t('crm.properties')}</h3>
      {loading || !company ? (
        <div className="space-y-2 pt-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-4" />)}</div>
      ) : (
        <div className="divide-y divide-border/60">
          {/* Status lives in the header pill – repeating it here was pure noise. */}
          <PropRow label={t('crm.colDomain')}>
            <EditableProp value={company.domain} editable={editable} placeholder={t('crm.noDomain')}
              onSave={(v) => onPatch({ domain: v || null })} />
          </PropRow>
          <PropRow label={t('crm.billingEmail')}>
            {editable ? (
              <EditableProp value={company.billingEmail} editable type="email" onSave={(v) => onPatch({ billingEmail: v || null })} />
            ) : company.billingEmail ? (
              <a href={`mailto:${company.billingEmail}`} className="text-primary hover:underline">{company.billingEmail}</a>
            ) : (
              <span className="text-faint">–</span>
            )}
          </PropRow>
          <PropRow label={t('common.currency')}>
            {editable ? (
              <DropdownMenu
                align="end"
                trigger={<button className="-mx-1 rounded-md px-1 tabular-nums transition-colors hover:bg-muted">{company.defaultCurrency || 'USD'} <ChevronDown size={11} className="inline text-faint" /></button>}
              >
                {CURRENCIES.map((cur) => (
                  <MenuItem key={cur} checked={cur === company.defaultCurrency} onSelect={() => cur !== company.defaultCurrency && onPatch({ defaultCurrency: cur })}>{cur}</MenuItem>
                ))}
              </DropdownMenu>
            ) : (
              <span className="tabular-nums">{company.defaultCurrency || '–'}</span>
            )}
          </PropRow>
          <PropRow label={t('crm.paymentTerms')}>
            {editable ? (
              <EditablePaymentTerms days={company.paymentTermsDays} onSave={(n) => onPatch({ paymentTermsDays: n })} />
            ) : company.paymentTermsDays != null ? (
              <span className="tabular-nums">{t('crm.paymentTermsValue').replace('{n}', String(company.paymentTermsDays))}</span>
            ) : (
              <span className="text-faint">–</span>
            )}
          </PropRow>
          <PropRow label={t('crm.created')}>{fmtDate(company.createdAt)}</PropRow>
        </div>
      )}
    </Card>
  );
}

interface LinkableProject extends Project { companyId?: string | null; version?: number }

function ProjectsCard({ companyId }: { companyId: string }) {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const can = useCan();
  const [creating, setCreating] = useState(false);
  const [linking, setLinking] = useState(false);
  const [linkId, setLinkId] = useState('');

  const { data, isLoading } = useQuery<LinkableProject[]>({
    queryKey: ['projects', 'company', companyId],
    queryFn: () => api.get<{ data: LinkableProject[] }>(`/projects${qs({ companyId })}`).then((r) => r.data).catch(() => []),
  });
  // Candidates for linking: projects with no client yet.
  const allQ = useQuery<LinkableProject[]>({
    queryKey: ['projects'],
    queryFn: () => api.get<{ data: LinkableProject[] }>('/projects').then((r) => r.data),
    enabled: linking,
  });
  const projects = data ?? [];
  const candidates = (allQ.data ?? []).filter((p) => !p.companyId);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['projects', 'company', companyId] });
    qc.invalidateQueries({ queryKey: ['projects'] });
  };
  const link = useMutation({
    mutationFn: (p: LinkableProject) => api.patch(`/projects/${p.id}`, { companyId, version: p.version }),
    onSuccess: () => { setLinking(false); setLinkId(''); invalidate(); toast(t('common.saved')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  if (isLoading) return <Card className="p-4"><Skeleton className="h-4 w-24" /></Card>;

  const canCreate = can('projects.create');
  const canLink = can('projects.write') || canCreate;

  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-faint">{t('crm.linkedProjects')}</h3>
        {(canCreate || canLink) && (
          <DropdownMenu
            align="end"
            trigger={<IconButton size="sm" aria-label={t('crm.newProjectForClient')}><Plus size={13} /></IconButton>}
          >
            {canCreate && <MenuItem icon={<Plus size={13} />} onSelect={() => setCreating(true)}>{t('crm.newProjectForClient')}</MenuItem>}
            {canLink && <MenuItem icon={<FolderKanban size={13} />} onSelect={() => setLinking(true)}>{t('crm.linkExistingProject')}</MenuItem>}
          </DropdownMenu>
        )}
      </div>
      {projects.length === 0 ? (
        <p className="py-1 text-[13px] text-faint">{t('crm.noProjects')}</p>
      ) : (
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
      )}

      {/* Create in place – no navigation, so Back never resurrects a dialog. */}
      <NewProjectModal
        open={creating}
        onClose={() => setCreating(false)}
        defaultCompanyId={companyId}
        onCreated={(pid) => { setCreating(false); invalidate(); navigate(`/projects/${pid}`); }}
      />

      <Dialog open={linking} onClose={() => { setLinking(false); setLinkId(''); }} title={t('crm.linkExistingProject')} width={420}>
        <div className="space-y-3 px-4 pb-4 pt-1">
          {allQ.isLoading ? (
            <Skeleton className="h-8" />
          ) : candidates.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('crm.noUnlinkedProjects')}</p>
          ) : (
            <Select value={linkId} onChange={(e) => setLinkId(e.target.value)} className="w-full">
              <option value="">{t('common.select')}</option>
              {candidates.map((p) => <option key={p.id} value={p.id}>{p.name}{p.key ? ` (${p.key})` : ''}</option>)}
            </Select>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => { setLinking(false); setLinkId(''); }}>{t('common.cancel')}</Button>
            <Button
              size="sm"
              disabled={!linkId || link.isPending}
              onClick={() => { const p = candidates.find((x) => x.id === linkId); if (p) link.mutate(p); }}
            >
              {link.isPending ? <Spinner /> : t('crm.linkProject')}
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}
