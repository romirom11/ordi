/**
 * Company (client) detail, built on the same shape as the project and task
 * records: one thin identity row (breadcrumb · avatar · name), the content at
 * full width, and a properties rail pinned to the right edge. Everything that
 * describes the client – status, owner, domain, billing – lives in the rail,
 * not the header, and every action lives in the section it acts on rather
 * than being repeated in a toolbar. Empty sections collapse to a single line.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Building2, ChevronRight, Plus, Mail, Phone, Star,
  FolderKanban, Handshake, Pencil, Receipt, Target, Trash2, ExternalLink,
} from 'lucide-react';
import { api, qs, ApiError } from '../lib/api';
import { Link, useNavigate, useOpen } from '../lib/router';
import { useCan } from '../lib/auth';
import { usePageTitle } from '../lib/tabs';
import {
  Avatar, Button, EmptySection, IconButton, RailChip, RailField,
  Select, Skeleton, Spinner, Tooltip, cn, fmtMoney, fmtDate,
} from '../components/ui';
import { ConfirmDialog, Dialog, DropdownMenu, MenuItem, MenuLabel, MenuSeparator, toast } from '../components/overlays';
import { EntityActivity } from '../components/EntityActivity';
import { useT } from '../lib/i18n';
import {
  COMPANY_STATUSES, CURRENCIES, StatusPill, useDealStages, useLeads, useUsersLookup,
  type Company, type Contact, type Deal, type Stage,
} from '../components/crm/shared';
import {
  EditableName, FilesSection, InlineEdit, NotesSection, OwnerRailValue, SectionHeader,
} from '../components/crm/detail';
import { DealRows } from '../components/crm/DealRows';
import { ContactDialog, NewDealDialog, NewLeadDialog } from '../components/crm/dialogs';
import { NewProjectModal } from './Projects';
import { useWorkspaceSettings, financeEnabled } from '../components/finance/workspace';

interface Project { id: string; name: string; key?: string | null; status?: string | null }

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

function domainHref(domain?: string | null): string | null {
  if (!domain) return null;
  return `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
}

/* Shared so sections and the activity feed hit one cache entry each. */
const dealsKey = (companyId: string) => ['deals', 'company', companyId];
const invoicesKey = (companyId: string) => ['invoices', 'company', companyId];
const auditKey = (companyId: string) => ['audit', 'company', companyId];

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

  const [addingDeal, setAddingDeal] = useState(false);
  const [addingLead, setAddingLead] = useState(false);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<Company>(`/companies/${id}`, { ...body, version: c?.version }),
    onSuccess: (updated, vars) => {
      qc.setQueryData(['company', id], updated);
      qc.invalidateQueries({ queryKey: ['companies'] });
      qc.invalidateQueries({ queryKey: auditKey(id) });
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

  const canAddDeal = can('deals.write');

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Identity row only – one line, like the project and task headers. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <Link to="/crm" className="hidden shrink-0 text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground sm:block">
          {t('crm.title')}
        </Link>
        <ChevronRight size={12} className="hidden shrink-0 text-faint sm:block" aria-hidden />
        <Link to="/crm/companies" className="hidden shrink-0 text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground sm:block">
          {t('crm.tabCompanies')}
        </Link>
        <ChevronRight size={12} className="hidden shrink-0 text-faint sm:block" aria-hidden />

        {companyQ.isLoading ? (
          <Skeleton className="h-4 w-40" />
        ) : c ? (
          <>
            <Avatar name={c.name} size={20} className="shrink-0 text-[9px]" />
            <EditableName value={c.name} editable={canWrite} size="sm" onSave={(name) => patch.mutate({ name })} />
          </>
        ) : (
          <span className="flex items-center gap-2 text-[13px] text-muted-foreground"><Building2 size={15} /> {t('common.error')}</span>
        )}
      </div>

      {/* Body: content at full width, rail pinned to the edge. Below 1100px the
        * rail moves above the content instead of disappearing – status and
        * owner live only there now, so hiding them would strand them. */}
      <div className="flex min-h-0 flex-1 flex-col min-[1100px]:flex-row">
        <div className="order-2 min-w-0 flex-1 overflow-auto min-[1100px]:order-1">
          <div className="space-y-7 px-6 py-6">
            <LeadsSection companyId={id} canWrite={canWrite} onAdd={() => setAddingLead(true)} />
            {can('deals.read') && <DealsSection companyId={id} canWrite={canAddDeal} onAdd={() => setAddingDeal(true)} />}
            <InvoicesSection companyId={id} />
            <ContactsSection companyId={id} canWrite={canWrite} />
            <NotesSection companyId={id} canWrite={canWrite} />
            <CompanyActivity companyId={id} users={usersQ.data ?? []} />
          </div>
        </div>
        <aside className="order-1 shrink-0 space-y-6 overflow-auto border-b border-border p-4 min-[1100px]:order-2 min-[1100px]:w-80 min-[1100px]:border-b-0 min-[1100px]:border-l">
          <CompanyRail
            company={c}
            loading={companyQ.isLoading}
            editable={canWrite}
            users={usersQ.data ?? []}
            onPatch={(body) => patch.mutate(body)}
          />
          <ProjectsRail companyId={id} />
          <FilesSection entityType="company" entityId={id} canWrite={canWrite} variant="rail" />
        </aside>
      </div>

      <NewDealDialog
        open={addingDeal}
        onClose={() => setAddingDeal(false)}
        lockedCompanyId={id}
        onCreated={() => qc.invalidateQueries({ queryKey: dealsKey(id) })}
      />
      <NewLeadDialog
        open={addingLead}
        onClose={() => setAddingLead(false)}
        lockedCompanyId={id}
        onCreated={() => qc.invalidateQueries({ queryKey: ['leads'] })}
      />
    </div>
  );
}

/* ─────────────── Leads ─────────────── */

function LeadsSection({ companyId, canWrite, onAdd }: { companyId: string; canWrite: boolean; onAdd: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const open = useOpen();
  const leadsQ = useLeads({ companyId });
  const leads = leadsQ.data ?? [];
  return (
    <section>
      <SectionHeader
        icon={<Target size={15} />}
        title={t('crm.tabLeads')}
        count={leads.length}
        action={canWrite && <Button variant="outline" size="xs" onClick={onAdd}><Plus size={13} /> {t('crm.newLead')}</Button>}
      />
      {leadsQ.isLoading ? (
        <div className="space-y-1">{[0, 1].map((key) => <Skeleton key={key} className="h-11 rounded-md" />)}</div>
      ) : leads.length === 0 ? (
        <EmptySection
          icon={<Target size={14} />}
          title={t('crm.noActivity')}
          action={canWrite && <Button variant="ghost" size="xs" onClick={onAdd}><Plus size={13} /> {t('crm.newLead')}</Button>}
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {leads.map((lead, index) => (
            <button
              key={lead.id}
              type="button"
              onClick={(e) => open(`/leads/${lead.id}`, e)}
              onAuxClick={(e) => open(`/leads/${lead.id}`, e)}
              className={cn('flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50', index > 0 && 'border-t border-border')}
            >
              <Target size={14} className="shrink-0 text-warning" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{lead.title}</span>
                <span className="block truncate text-xs text-muted-foreground">{lead.product || lead.signal || '—'}</span>
              </span>
              <StatusPill status={lead.status} />
              <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{lead.score ?? '—'}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/* ─────────────── Deals ─────────────── */

function DealsSection({ companyId, canWrite, onAdd }: { companyId: string; canWrite: boolean; onAdd: () => void }) {
  const t = useT();
  const stagesQ = useDealStages();
  const usersQ = useUsersLookup();
  const dealsQ = useQuery<Deal[]>({
    queryKey: dealsKey(companyId),
    queryFn: () => api.get<{ data: Deal[] }>(`/deals${qs({ companyId })}`).then((r) => r.data),
  });
  const stageMap = new Map((stagesQ.data ?? []).map((s: Stage) => [s.id, s]));
  const deals = dealsQ.data ?? [];

  // Open pipeline sits next to the count rather than in a banner of its own –
  // the number belongs to this list, not to the whole page.
  let open = 0;
  let openCurrency = 'USD';
  for (const d of deals) {
    const stage = d.stageId ? stageMap.get(d.stageId) : undefined;
    if (stage?.isWon || stage?.isLost) continue;
    open += Number(d.amount ?? 0);
    openCurrency = d.currency ?? openCurrency;
  }

  return (
    <section>
      <SectionHeader
        icon={<Handshake size={15} />}
        title={t('crm.deals')}
        count={deals.length}
        action={
          <div className="flex items-center gap-3">
            {open > 0 && (
              <span className="text-[13px] text-muted-foreground tabular-nums">
                {fmtMoney(open, openCurrency)} <span className="text-faint">{t('crm.openDealsValue')}</span>
              </span>
            )}
            {canWrite && <Button variant="outline" size="xs" onClick={onAdd}><Plus size={13} /> {t('crm.addDealForClient')}</Button>}
          </div>
        }
      />
      {dealsQ.isLoading ? (
        <div className="space-y-1">{[0, 1].map((i) => <Skeleton key={i} className="h-11 rounded-md" />)}</div>
      ) : deals.length === 0 ? (
        <EmptySection
          icon={<Handshake size={14} />}
          title={t('deals.empty')}
          action={canWrite && <Button variant="ghost" size="xs" onClick={onAdd}><Plus size={13} /> {t('crm.addDealForClient')}</Button>}
        />
      ) : (
        <DealRows deals={deals} stages={stagesQ.data ?? []} users={usersQ.data ?? []} />
      )}
    </section>
  );
}

/* ─────────────── Invoices (finance-gated) ─────────────── */

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
  const open = useOpen();
  const wsQ = useWorkspaceSettings();

  const enabled = financeEnabled(wsQ.data) && can('finance.read');

  const invoicesQ = useQuery<InvoiceRow[]>({
    queryKey: invoicesKey(companyId),
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
        <EmptySection icon={<Receipt size={14} />} title={t('crm.noInvoices')} />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {invoices.map((iv, i) => {
            const overdue = iv.isOverdue || iv.status === 'overdue';
            return (
              <div
                key={iv.id}
                onClick={(e) => open(`/finance/invoices/${iv.id}`, e)}
                onAuxClick={(e) => open(`/finance/invoices/${iv.id}`, e)}
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
        <EmptySection
          icon={<Building2 size={14} />}
          title={t('crm.noContacts')}
          action={canWrite && <Button variant="ghost" size="xs" onClick={() => setAdding(true)}><Plus size={13} /> {t('crm.addContact')}</Button>}
        />
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
                  {/* Position and email on one line – the row was showing a title and hiding the address. */}
                  <div className="flex min-w-0 items-center gap-1.5 text-xs text-faint">
                    {ct.position && <span className="truncate">{ct.position}</span>}
                    {ct.position && ct.email && <span aria-hidden>·</span>}
                    {ct.email && <span className="truncate">{ct.email}</span>}
                  </div>
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

/* ─────────────── Activity ─────────────── */

function CompanyActivity({ companyId, users }: { companyId: string; users: { id: string; name: string; avatar?: string | null }[] }) {
  const t = useT();
  return (
    <EntityActivity
      entityType="company"
      entityId={companyId}
      users={users}
      title={t('crm.activity')}
      emptyLabel={t('crm.activity.empty')}
      labelFor={(action) => t(`crm.activity.${action}`, action.replace(/_/g, ' '))}
      queryKey={auditKey(companyId)}
    />
  );
}

/* ─────────────── Rail: properties ─────────────── */

function CompanyRail({ company, loading, editable, users, onPatch }: {
  company?: Company; loading: boolean; editable: boolean;
  users: { id: string; name: string; avatar?: string | null }[];
  onPatch: (body: Record<string, unknown>) => void;
}) {
  const t = useT();

  if (loading || !company) {
    return <div className="space-y-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-7" />)}</div>;
  }

  const href = domainHref(company.domain);

  return (
    <div>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('crm.properties')}</h2>
      <div className="space-y-0.5">
        <RailField label={t('common.status')}>
          {editable ? (
            <DropdownMenu
              align="start"
              className="w-full"
              trigger={<RailChip caret><StatusPill status={company.status} /></RailChip>}
            >
              <MenuLabel>{t('crm.changeStatus')}</MenuLabel>
              {COMPANY_STATUSES.map((s) => (
                <MenuItem key={s} checked={company.status === s} onSelect={() => company.status !== s && onPatch({ status: s })}>
                  <StatusPill status={s} />
                </MenuItem>
              ))}
            </DropdownMenu>
          ) : (
            <RailChip disabled><StatusPill status={company.status} /></RailChip>
          )}
        </RailField>
        <RailField label={t('crm.owner')}>
          <OwnerRailValue
            ownerId={company.ownerId}
            users={users}
            editable={editable}
            onPick={(ownerId) => onPatch({ ownerId })}
          />
        </RailField>
        <RailField label={t('crm.colDomain')}>
          {/* Editing is the primary act; opening the site is a hover affordance,
            * which is why the header no longer carries a separate link. */}
          <div className="group/domain flex items-center gap-1">
            <div className="min-w-0 flex-1">
              <InlineEdit
                value={company.domain}
                editable={editable}
                placeholder={t('crm.noDomain')}
                onSave={(v) => onPatch({ domain: v || null })}
              />
            </div>
            {href && (
              <Tooltip label={t('crm.openWebsite')}>
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={t('crm.openWebsite')}
                  className="shrink-0 rounded p-1 text-faint opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover/domain:opacity-100"
                >
                  <ExternalLink size={12} />
                </a>
              </Tooltip>
            )}
          </div>
        </RailField>
        <RailField label={t('crm.billingEmail')}>
          <InlineEdit
            value={company.billingEmail}
            editable={editable}
            inputType="email"
            placeholder="–"
            onSave={(v) => onPatch({ billingEmail: v || null })}
          />
        </RailField>
        <RailField label={t('common.currency')}>
          {editable ? (
            <DropdownMenu
              align="start"
              className="w-full"
              trigger={<RailChip caret><span className="tabular-nums">{company.defaultCurrency || 'USD'}</span></RailChip>}
            >
              {CURRENCIES.map((cur) => (
                <MenuItem key={cur} checked={cur === company.defaultCurrency} onSelect={() => cur !== company.defaultCurrency && onPatch({ defaultCurrency: cur })}>{cur}</MenuItem>
              ))}
            </DropdownMenu>
          ) : (
            <RailChip disabled><span className="tabular-nums">{company.defaultCurrency || '–'}</span></RailChip>
          )}
        </RailField>
        {/* Short label: "Payment terms" wraps to two lines in a 76px column. */}
        <RailField label={t('crm.paymentTermsShort')}>
          <InlineEdit
            value={company.paymentTermsDays != null ? String(company.paymentTermsDays) : ''}
            display={company.paymentTermsDays != null ? t('crm.paymentTermsValue').replace('{n}', String(company.paymentTermsDays)) : undefined}
            editable={editable}
            inputType="number"
            placeholder="–"
            onSave={(v) => {
              const n = Number(v);
              if (v !== '' && Number.isInteger(n) && n >= 0) onPatch({ paymentTermsDays: n });
            }}
          />
        </RailField>
        <RailField label={t('crm.created')}>
          <RailChip disabled><span className="tabular-nums">{fmtDate(company.createdAt)}</span></RailChip>
        </RailField>
      </div>
    </div>
  );
}

/* ─────────────── Rail: linked projects ─────────────── */

interface LinkableProject extends Project { companyId?: string | null; version?: number }

function ProjectsRail({ companyId }: { companyId: string }) {
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

  if (isLoading) return <Skeleton className="h-7 w-24" />;

  const canCreate = can('projects.create');
  const canLink = can('projects.write') || canCreate;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-faint">{t('crm.linkedProjects')}</h2>
        {(canCreate || canLink) && (
          <DropdownMenu
            align="end"
            trigger={<IconButton size="sm" aria-label={t('crm.newProjectForClient')}><Plus size={13} /></IconButton>}
          >
            {canCreate && <MenuItem icon={<Plus size={13} />} onSelect={() => setCreating(true)}>{t('crm.newProjectForClient')}</MenuItem>}
            {canCreate && canLink && <MenuSeparator />}
            {canLink && <MenuItem icon={<FolderKanban size={13} />} onSelect={() => setLinking(true)}>{t('crm.linkExistingProject')}</MenuItem>}
          </DropdownMenu>
        )}
      </div>
      {projects.length === 0 ? (
        <p className="px-1.5 py-1 text-[13px] text-faint">{t('crm.noProjects')}</p>
      ) : (
        <div className="space-y-0.5">
          {projects.map((p) => (
            <Link
              key={p.id}
              to={`/projects/${p.id}`}
              className="flex min-h-7 items-center gap-2 rounded-md px-1.5 py-1 text-[13px] transition-colors hover:bg-muted"
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
    </div>
  );
}
