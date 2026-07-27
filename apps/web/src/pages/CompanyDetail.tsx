/**
 * Company (client) detail. Laid out like the project overview it sits next to:
 * a header with the record's identity and its actions, a summary strip that
 * answers "what shape is this client in" without scrolling, one content column
 * (deals · invoices · contacts · notes · files · activity) and a 280px
 * properties rail. Sections that are empty collapse to a single line – a fresh
 * client should not read as three screens of nothing.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Building2, ChevronDown, Plus, Mail, Phone, Star, Globe, MoreHorizontal, StickyNote,
  FolderKanban, Handshake, Pencil, Receipt, Trash2, Link2, ExternalLink,
} from 'lucide-react';
import { api, qs, ApiError } from '../lib/api';
import { Link, useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import { usePageTitle } from '../lib/tabs';
import {
  Avatar, Badge, Breadcrumbs, Button, EmptySection, IconButton, PageBody, RailChip, RailField,
  Select, Skeleton, Spinner, Tooltip, cn, fmtMoney, fmtDate, fmtRelative,
} from '../components/ui';
import { ConfirmDialog, Dialog, DropdownMenu, MenuItem, MenuLabel, MenuSeparator, toast } from '../components/overlays';
import { EntityActivity } from '../components/EntityActivity';
import { useT } from '../lib/i18n';
import {
  COMPANY_STATUSES, CURRENCIES, StatusPill, useDealStages, useUsersLookup,
  type Company, type Contact, type Deal, type Stage,
} from '../components/crm/shared';
import { EditableName, FilesSection, NotesSection, OwnerPicker, SectionHeader } from '../components/crm/detail';
import { ContactDialog, NewDealDialog } from '../components/crm/dialogs';
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

interface AuditRow { id: string; createdAt: string }

function domainHref(domain?: string | null): string | null {
  if (!domain) return null;
  return `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
}

/* Query keys are shared with the sections below so the header strip reuses the
 * cached responses instead of firing its own round trips. */
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
  const [noteFocus, setNoteFocus] = useState(0);

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

  const owner = c?.ownerId ? (usersQ.data ?? []).find((u) => u.id === c.ownerId) : undefined;
  const href = domainHref(c?.domain);
  const canAddDeal = can('deals.write');

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

          {/* Actions – previously buried inside each section header. */}
          {c && (
            <div className="flex shrink-0 items-center gap-2">
              {canWrite && (
                <Button variant="outline" size="sm" onClick={() => setNoteFocus((n) => n + 1)}>
                  <StickyNote size={14} /> {t('crm.addNote')}
                </Button>
              )}
              {canAddDeal && (
                <Button variant="primary" size="sm" onClick={() => setAddingDeal(true)}>
                  <Plus size={14} /> {t('crm.addDealForClient')}
                </Button>
              )}
              <DropdownMenu
                align="end"
                trigger={<IconButton size="sm" aria-label={t('common.more', 'More')}><MoreHorizontal size={15} /></IconButton>}
              >
                {href && (
                  <MenuItem icon={<ExternalLink size={13} />} onSelect={() => window.open(href, '_blank', 'noopener')}>
                    {t('crm.openWebsite')}
                  </MenuItem>
                )}
                <MenuItem
                  icon={<Link2 size={13} />}
                  onSelect={() => { void navigator.clipboard?.writeText(window.location.href); toast(t('crm.linkCopied')); }}
                >
                  {t('crm.copyLink')}
                </MenuItem>
              </DropdownMenu>
            </div>
          )}
        </div>

        {c && <SummaryStrip companyId={id} currency={c.defaultCurrency || 'USD'} />}
      </div>

      {/* Body: main + rail */}
      <div className="min-h-0 flex-1 overflow-auto">
        <PageBody width="wide" className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="order-2 min-w-0 space-y-7 lg:order-1">
            {can('deals.read') && <DealsSection companyId={id} canWrite={canAddDeal} onAdd={() => setAddingDeal(true)} />}
            <InvoicesSection companyId={id} />
            <ContactsSection companyId={id} canWrite={canWrite} />
            <NotesSection companyId={id} canWrite={canWrite} focusToken={noteFocus} />
            <FilesSection entityType="company" entityId={id} canWrite={canWrite} />
            <CompanyActivity companyId={id} users={usersQ.data ?? []} />
          </div>
          <div className="order-1 space-y-6 lg:order-2">
            <CompanyRail company={c} loading={companyQ.isLoading} editable={canWrite} onPatch={(body) => patch.mutate(body)} />
            <ProjectsRail companyId={id} />
          </div>
        </PageBody>
      </div>

      <NewDealDialog
        open={addingDeal}
        onClose={() => setAddingDeal(false)}
        lockedCompanyId={id}
        onCreated={() => qc.invalidateQueries({ queryKey: dealsKey(id) })}
      />
    </div>
  );
}

/* ─────────────── Summary strip ─────────────── */

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'destructive' | 'success' }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className={cn(
        'truncate text-[15px] font-semibold tabular-nums',
        tone === 'destructive' && 'text-destructive',
        tone === 'success' && 'text-success',
      )}>
        {value}
      </div>
    </div>
  );
}

/**
 * The numbers a client is judged by, above the fold. Every query here is keyed
 * identically to the section that owns it, so this costs no extra requests.
 */
function SummaryStrip({ companyId, currency }: { companyId: string; currency: string }) {
  const t = useT();
  const can = useCan();
  const wsQ = useWorkspaceSettings();
  const stagesQ = useDealStages();

  const dealsQ = useQuery<Deal[]>({
    queryKey: dealsKey(companyId),
    queryFn: () => api.get<{ data: Deal[] }>(`/deals${qs({ companyId })}`).then((r) => r.data),
    enabled: can('deals.read'),
  });

  const financeOn = financeEnabled(wsQ.data) && can('finance.read');
  const invoicesQ = useQuery<InvoiceRow[]>({
    queryKey: invoicesKey(companyId),
    queryFn: () => api.get<{ data: InvoiceRow[] }>(`/invoices${qs({ companyId })}`).then((r) => r.data),
    enabled: financeOn,
  });

  const auditQ = useQuery<AuditRow[]>({
    queryKey: auditKey(companyId),
    queryFn: () => api.get<{ data: AuditRow[] }>(`/audit/entity/company/${companyId}`).then((r) => r.data),
  });

  const stageMap = new Map((stagesQ.data ?? []).map((s: Stage) => [s.id, s]));
  const deals = dealsQ.data ?? [];
  let open = 0;
  let won = 0;
  let openCount = 0;
  for (const d of deals) {
    const stage = d.stageId ? stageMap.get(d.stageId) : undefined;
    const amount = Number(d.amount ?? 0);
    if (stage?.isWon) won += amount;
    else if (!stage?.isLost) { open += amount; openCount += 1; }
  }

  const outstanding = (invoicesQ.data ?? []).reduce((sum, iv) => {
    if (iv.status === 'canceled') return sum;
    return sum + (Number(iv.total ?? 0) - Number(iv.amountPaid ?? 0));
  }, 0);

  const lastAt = auditQ.data?.[0]?.createdAt;

  return (
    <div className="mt-4 flex flex-wrap items-start gap-x-8 gap-y-3 pl-[64px]">
      {can('deals.read') && (
        <Metric label={`${t('crm.openDealsValue')} · ${openCount}`} value={fmtMoney(open, currency)} />
      )}
      {can('deals.read') && won > 0 && <Metric label={t('crm.wonValue')} value={fmtMoney(won, currency)} tone="success" />}
      {financeOn && (
        <Metric label={t('crm.outstanding')} value={fmtMoney(outstanding, currency)} tone={outstanding > 0 ? 'destructive' : undefined} />
      )}
      <Metric label={t('crm.lastActivity')} value={lastAt ? fmtRelative(lastAt) : t('crm.never')} />
    </div>
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
  const userMap = new Map((usersQ.data ?? []).map((u) => [u.id, u]));
  const deals = dealsQ.data ?? [];

  return (
    <section>
      <SectionHeader
        icon={<Handshake size={15} />}
        title={t('crm.deals')}
        count={deals.length}
        action={canWrite && <Button variant="outline" size="xs" onClick={onAdd}><Plus size={13} /> {t('crm.addDealForClient')}</Button>}
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
        <div className="overflow-hidden rounded-lg border border-border">
          {deals.map((d, i) => {
            const stage = d.stageId ? stageMap.get(d.stageId) : undefined;
            const color = stage?.isWon ? '#22c55e' : stage?.isLost ? '#ef4444' : undefined;
            const dealOwner = d.ownerId ? userMap.get(d.ownerId) : undefined;
            return (
              <Link key={d.id} to={`/deals/${d.id}`} className={cn('flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-muted/50', i > 0 && 'border-t border-border')}>
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{d.title}</span>
                {stage && <Badge color={color}>{stage.name}</Badge>}
                {/* Close date and owner: without them you cannot tell which deal has gone stale. */}
                <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
                  {d.expectedCloseDate ? fmtDate(d.expectedCloseDate) : '–'}
                </span>
                <span className="w-24 shrink-0 text-right text-[13px] font-semibold tabular-nums">
                  {d.amount != null ? fmtMoney(d.amount, d.currency ?? 'USD') : '–'}
                </span>
                <span className="w-5 shrink-0">
                  {dealOwner
                    ? <Tooltip label={dealOwner.name}><Avatar name={dealOwner.name} src={dealOwner.avatar} size={20} /></Tooltip>
                    : <span className="grid h-5 w-5 place-items-center rounded-full border border-dashed border-border-strong text-[9px] text-faint">?</span>}
                </span>
              </Link>
            );
          })}
        </div>
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

/**
 * Click-to-edit rail value. Renders as the same chip the project rail uses.
 * `display` lets a field read as prose ("14 days") while editing the raw value.
 */
function RailInput({ value, editable, placeholder, type = 'text', display, onSave }: {
  value?: string | null; editable: boolean; placeholder: string;
  type?: 'text' | 'email' | 'number';
  display?: string;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

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
          'min-h-7 w-full rounded-md border border-primary/40 bg-transparent px-1.5 py-1 text-[13px] outline-none focus:ring-2 focus:ring-ring/25',
          type === 'number' && 'tabular-nums',
        )}
      />
    );
  }

  const chip = (
    <RailChip empty={!value} disabled={!editable}>
      <span className={cn('truncate', type === 'number' && 'tabular-nums')}>{(value && (display ?? value)) || placeholder}</span>
    </RailChip>
  );
  if (!editable) return chip;
  return (
    <button type="button" className="block w-full text-left" onClick={() => { setDraft(value ?? ''); setEditing(true); }}>
      {chip}
    </button>
  );
}

function CompanyRail({ company, loading, editable, onPatch }: {
  company?: Company; loading: boolean; editable: boolean; onPatch: (body: Record<string, unknown>) => void;
}) {
  const t = useT();

  if (loading || !company) {
    return <div className="space-y-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-7" />)}</div>;
  }

  return (
    <div>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('crm.details')}</h2>
      <div className="space-y-0.5">
        {/* Status lives in the header pill – repeating it here was pure noise. */}
        <RailField label={t('crm.colDomain')}>
          <RailInput
            value={company.domain}
            editable={editable}
            placeholder={t('crm.noDomain')}
            onSave={(v) => onPatch({ domain: v || null })}
          />
        </RailField>
        <RailField label={t('crm.billingEmail')}>
          <RailInput
            value={company.billingEmail}
            editable={editable}
            type="email"
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
        <RailField label={t('crm.paymentTerms')}>
          <RailInput
            value={company.paymentTermsDays != null ? String(company.paymentTermsDays) : ''}
            display={company.paymentTermsDays != null ? t('crm.paymentTermsValue').replace('{n}', String(company.paymentTermsDays)) : undefined}
            editable={editable}
            type="number"
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
