/**
 * Deal detail, in the same shape as the company and project records: a one-line
 * identity header, content at full width (custom fields + notes + activity
 * trail) and a rail carrying the short properties – stage, client, project,
 * owner, money, dates and files. Moving to a lost stage still prompts for a
 * reason.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Activity as ActivityIcon, CalendarClock, ChevronDown, ChevronRight,
  ExternalLink as ExternalLinkIcon, FolderKanban, Handshake, SlidersHorizontal, Target, UserCircle2,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Link } from '../lib/router';
import { useCan, useMe } from '../lib/auth';
import { usePageTitle } from '../lib/tabs';
import { useT } from '../lib/i18n';
import {
  Avatar, Badge, Button, Card, EmptySection, Input, RailChip, RailField, Skeleton,
  cn, fmtMoney, fmtDate, fmtRelative,
} from '../components/ui';
import { DropdownMenu, MenuItem, MenuLabel, toast } from '../components/overlays';
import {
  useDealStages, useLead, useProjectsLookup, useUsersLookup,
  CURRENCIES, type Company, type Deal, type ProjectLite, type Stage,
} from '../components/crm/shared';
import { DetailField, EditableName, NotesSection, SectionHeader } from '../components/crm/detail';
import { FilesSection } from '../components/FilesSection';
import { LostReasonDialog } from '../components/crm/dialogs';
import { SalesActivityPanel } from '../components/crm/SalesActivityPanel';
import { DateField } from '../components/DatePicker';
import { DateRailPicker } from '../components/project/pickers';

interface DealFull extends Deal { customFields?: Record<string, unknown>; createdAt?: string | null }
interface FieldDef { id: string; key: string; label: string; type: string; options?: { value: string; label: string }[]; deprecated?: boolean }
interface ActivityRow { id: string; action?: string; actorId?: string | null; createdAt?: string; sensitivity?: string }

export function DealDetailPage({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const canWrite = can('deals.write');

  const dealQ = useQuery<DealFull>({ queryKey: ['deal', id], queryFn: () => api.get<DealFull>(`/deals/${id}`) });
  const stagesQ = useDealStages();
  const usersQ = useUsersLookup();
  const companyQ = useQuery<Company>({
    queryKey: ['company', dealQ.data?.companyId],
    queryFn: () => api.get<Company>(`/companies/${dealQ.data!.companyId}`),
    enabled: !!dealQ.data?.companyId && can('crm.read'),
  });

  const projectsQ = useProjectsLookup();

  const d = dealQ.data;
  const sourceLeadQ = useLead(d?.sourceLeadId, can('crm.read'));
  // Tab and window title carry the deal, not a generic "CRM".
  usePageTitle(d?.title);
  const stages = stagesQ.data ?? [];
  const stage = stages.find((s) => s.id === d?.stageId);
  const owner = d?.ownerId ? (usersQ.data ?? []).find((u) => u.id === d.ownerId) : undefined;
  const project = d?.projectId ? (projectsQ.data ?? []).find((p) => p.id === d.projectId) : undefined;

  const [lostFor, setLostFor] = useState<string | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['deal', id] });
    qc.invalidateQueries({ queryKey: ['deals'] });
    qc.invalidateQueries({ queryKey: ['activity', 'deal', id] });
  };

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch<DealFull>(`/deals/${id}`, { ...body, version: d?.version }),
    onSuccess: (updated) => { qc.setQueryData(['deal', id], updated); qc.invalidateQueries({ queryKey: ['deals'] }); toast(t('common.saved')); },
    onError: (e) => {
      qc.invalidateQueries({ queryKey: ['deal', id] });
      if (e instanceof ApiError && (e.code === 'version_conflict' || e.status === 409)) toast.error(t('crm.conflict'));
      else toast.error(e instanceof ApiError ? e.message : t('common.saveFailed'));
    },
  });

  const move = useMutation({
    mutationFn: (v: { stageId: string; lostReason?: string }) =>
      api.post(`/deals/${id}/move`, { ...v, version: d?.version }),
    onSuccess: () => { refresh(); toast(t('crm.moved')); },
    onError: (e) => {
      refresh();
      if (e instanceof ApiError && (e.code === 'version_conflict' || e.status === 409)) toast.error(t('crm.conflict'));
      else toast.error(e instanceof ApiError ? e.message : t('deals.moveFailed'));
    },
  });

  const pickStage = (s: Stage) => {
    if (!d || s.id === d.stageId) return;
    if (s.isLost) { setLostFor(s.id); return; }
    move.mutate({ stageId: s.id });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Identity row only – the deal's properties all live in the rail. */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <Link to="/crm" className="hidden shrink-0 text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground sm:block">
          {t('crm.title')}
        </Link>
        <ChevronRight size={12} className="hidden shrink-0 text-faint sm:block" aria-hidden />
        <Link to="/crm/deals" className="hidden shrink-0 text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground sm:block">
          {t('crm.tabPipeline')}
        </Link>
        <ChevronRight size={12} className="hidden shrink-0 text-faint sm:block" aria-hidden />

        {dealQ.isLoading ? (
          <Skeleton className="h-4 w-52" />
        ) : d ? (
          <>
            <Handshake size={16} className="shrink-0 text-muted-foreground" />
            <EditableName value={d.title} editable={canWrite} size="sm" onSave={(title) => patch.mutate({ title })} />
          </>
        ) : (
          <span className="flex items-center gap-2 text-[13px] text-muted-foreground"><Handshake size={15} /> {t('common.error')}</span>
        )}
      </div>

      {/* Body: content at full width, rail pinned to the edge. */}
      <div className="flex min-h-0 flex-1 flex-col min-[1100px]:flex-row">
        <div className="order-2 min-w-0 flex-1 overflow-auto min-[1100px]:order-1">
          <div className="space-y-7 px-6 py-6">
            {sourceLeadQ.data && (
              <Card className="flex items-start gap-3 border-primary/20 p-4">
                <Target size={17} className="mt-0.5 shrink-0 text-warning" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{t('crm.qualifiedFromLead')}</p>
                  <p className="mt-0.5 line-clamp-2 text-[13px] text-muted-foreground">
                    {sourceLeadQ.data.painSignal || sourceLeadQ.data.whyFit || sourceLeadQ.data.title}
                  </p>
                  {sourceLeadQ.data.contact && (
                    <p className="mt-1 text-xs text-faint">
                      {[sourceLeadQ.data.contact.firstName, sourceLeadQ.data.contact.lastName].filter(Boolean).join(' ')}
                    </p>
                  )}
                </div>
                <Link
                  to={`/leads/${sourceLeadQ.data.id}`}
                  className="shrink-0 text-[13px] font-medium text-primary hover:underline"
                >
                  {t('crm.viewResearch')}
                </Link>
              </Card>
            )}
            <CustomFieldsSection deal={d} editable={canWrite} onPatch={(body) => patch.mutate(body)} />
            <SalesActivityPanel
              dealId={id}
              companyId={d?.companyId}
              contactId={sourceLeadQ.data?.contactId}
              canWrite={canWrite}
              canSchedule={canWrite && !!stage && !stage.isWon && !stage.isLost}
            />
            {can('crm.read') && <NotesSection dealId={id} canWrite={can('crm.write')} />}
            <ActivitySection dealId={id} />
          </div>
        </div>
        <aside className="order-1 shrink-0 space-y-6 overflow-auto border-b border-border p-4 min-[1100px]:order-2 min-[1100px]:w-80 min-[1100px]:border-b-0 min-[1100px]:border-l">
          <DealRail
            deal={d}
            stage={stage}
            stages={stages}
            loading={dealQ.isLoading}
            editable={canWrite}
            company={companyQ.data}
            project={project}
            projects={projectsQ.data ?? []}
            owner={owner}
            users={usersQ.data ?? []}
            onPickStage={pickStage}
            onPatch={(body) => patch.mutate(body)}
          />
          <FilesSection entityType="deal" entityId={id} canWrite={canWrite} variant="rail" />
        </aside>
      </div>

      <LostReasonDialog
        open={!!lostFor}
        pending={move.isPending}
        onClose={() => setLostFor(null)}
        onConfirm={(reason) => {
          if (lostFor) move.mutate({ stageId: lostFor, lostReason: reason || undefined });
          setLostFor(null);
        }}
      />
    </div>
  );
}

/* ─────────────── Rail ─────────────── */

function stageColor(stage?: Stage): string | undefined {
  if (stage?.isWon) return '#22c55e';
  if (stage?.isLost) return '#ef4444';
  return undefined;
}

/**
 * Every property of the deal, in the rail. The header used to carry stage,
 * company, project and owner as chips; they read better as labelled rows and
 * leave the header to identity alone.
 */
function DealRail({
  deal, stage, stages, loading, editable, company, project, projects, owner, users, onPickStage, onPatch,
}: {
  deal?: DealFull; stage?: Stage; stages: Stage[]; loading: boolean; editable: boolean;
  company?: Company; project?: ProjectLite; projects: ProjectLite[];
  owner?: { id: string; name: string; avatar?: string | null };
  users: { id: string; name: string; avatar?: string | null }[];
  onPickStage: (s: Stage) => void;
  onPatch: (body: Record<string, unknown>) => void;
}) {
  const t = useT();

  if (loading || !deal) {
    return <div className="space-y-3">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-7" />)}</div>;
  }

  return (
    <div>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('crm.properties')}</h2>
      <div className="space-y-0.5">
        <RailField label={t('deals.stage')}>
          {editable ? (
            <DropdownMenu
              align="start"
              className="w-full"
              trigger={<RailChip caret><Badge color={stageColor(stage)}>{stage?.name ?? t('deals.stage')}</Badge></RailChip>}
            >
              <MenuLabel>{t('crm.moveToStage')}</MenuLabel>
              {stages.map((s) => (
                <MenuItem key={s.id} checked={s.id === stage?.id} onSelect={() => onPickStage(s)}>
                  <Badge color={stageColor(s)}>{s.name}</Badge>
                </MenuItem>
              ))}
            </DropdownMenu>
          ) : (
            <RailChip disabled><Badge color={stageColor(stage)}>{stage?.name ?? '–'}</Badge></RailChip>
          )}
        </RailField>

        <RailField label={t('crm.client', 'Client')}>
          {company ? (
            <Link to={`/companies/${company.id}`} className="block">
              <RailChip>
                <Avatar name={company.name} size={18} />
                <span className="truncate">{company.name}</span>
              </RailChip>
            </Link>
          ) : (
            <RailChip empty disabled>–</RailChip>
          )}
        </RailField>

        <RailField label={t('crm.project')}>
          <div className="group/project flex items-center gap-1">
            <div className="min-w-0 flex-1">
              {editable ? (
                <DropdownMenu
                  align="start"
                  className="w-full"
                  trigger={
                    <RailChip empty={!project} caret>
                      <FolderKanban size={14} className={project ? 'shrink-0 text-muted-foreground' : 'shrink-0 text-faint'} />
                      <span className="truncate">{project ? project.name : t('crm.noProject')}</span>
                    </RailChip>
                  }
                >
                  <MenuLabel>{t('crm.linkProjectHint')}</MenuLabel>
                  <MenuItem checked={!project} onSelect={() => project && onPatch({ projectId: null })}>{t('crm.noProject')}</MenuItem>
                  {projects.map((p) => (
                    <MenuItem key={p.id} checked={p.id === project?.id} onSelect={() => p.id !== project?.id && onPatch({ projectId: p.id })}>
                      <span className="flex items-center gap-2">
                        <FolderKanban size={13} className="text-muted-foreground" />
                        <span className="flex-1 truncate">{p.name}</span>
                        {p.key && <span className="font-mono text-[10px] text-faint">{p.key}</span>}
                      </span>
                    </MenuItem>
                  ))}
                </DropdownMenu>
              ) : (
                <RailChip empty={!project} disabled>
                  <FolderKanban size={14} className="shrink-0 text-faint" />
                  <span className="truncate">{project ? project.name : t('crm.noProject')}</span>
                </RailChip>
              )}
            </div>
            {project && (
              <Link
                to={`/projects/${project.id}`}
                aria-label={t('crm.viewProject')}
                className="shrink-0 rounded p-1 text-faint opacity-0 transition-opacity hover:text-foreground focus:opacity-100 group-hover/project:opacity-100"
              >
                <ExternalLinkIcon size={12} />
              </Link>
            )}
          </div>
        </RailField>

        <RailField label={t('crm.owner')}>
          {editable ? (
            <DropdownMenu
              align="start"
              className="w-full"
              width={220}
              trigger={
                <RailChip empty={!owner} caret>
                  {owner
                    ? <><Avatar name={owner.name} src={owner.avatar} size={18} /><span className="truncate">{owner.name}</span></>
                    : <><UserCircle2 size={16} className="text-faint" /><span className="truncate">{t('crm.noOwner')}</span></>}
                </RailChip>
              }
            >
              <MenuLabel>{t('crm.changeOwner')}</MenuLabel>
              {users.map((u) => (
                <MenuItem key={u.id} checked={u.id === deal.ownerId} onSelect={() => u.id !== deal.ownerId && onPatch({ ownerId: u.id })}>
                  <span className="flex items-center gap-2">
                    <Avatar name={u.name} src={u.avatar} size={18} />
                    <span className="flex-1 truncate">{u.name}</span>
                  </span>
                </MenuItem>
              ))}
            </DropdownMenu>
          ) : (
            <RailChip empty={!owner} disabled>
              {owner ? <><Avatar name={owner.name} src={owner.avatar} size={18} /><span className="truncate">{owner.name}</span></> : t('crm.noOwner')}
            </RailChip>
          )}
        </RailField>

        <RailField label={t('public.amount')}>
          <EditableAmount amount={deal.amount} currency={deal.currency ?? 'USD'} editable={editable} onSave={(v) => onPatch({ amount: v })} />
        </RailField>

        <RailField label={t('common.currency')}>
          {editable ? (
            <DropdownMenu
              align="start"
              className="w-full"
              trigger={<RailChip caret><span className="tabular-nums">{deal.currency ?? 'USD'}</span></RailChip>}
            >
              {CURRENCIES.map((cur) => (
                <MenuItem key={cur} checked={cur === (deal.currency ?? 'USD')} onSelect={() => cur !== deal.currency && onPatch({ currency: cur })}>{cur}</MenuItem>
              ))}
            </DropdownMenu>
          ) : (
            <RailChip disabled><span className="tabular-nums">{deal.currency ?? 'USD'}</span></RailChip>
          )}
        </RailField>

        {/* Short label: "Expected close" wraps in the 76px label column. */}
        <RailField label={t('crm.expectedCloseShort')}>
          <DateRailPicker
            value={deal.expectedCloseDate ?? null}
            onChange={(v) => onPatch({ expectedCloseDate: v })}
            placeholder={t('crm.noCloseDate')}
            icon={<CalendarClock size={15} className="text-faint" />}
            disabled={!editable}
          />
        </RailField>

        {stage?.isLost && deal.lostReason && (
          <RailField label={t('crm.lostReasonLabel')}>
            <RailChip disabled><span className="truncate text-destructive">{deal.lostReason}</span></RailChip>
          </RailField>
        )}

        <RailField label={t('crm.created')}>
          <RailChip disabled><span className="tabular-nums">{fmtDate(deal.createdAt)}</span></RailChip>
        </RailField>
      </div>
    </div>
  );
}


function EditableAmount({ amount, currency, editable, onSave }: {
  amount?: string | number | null; currency: string; editable: boolean; onSave: (v: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const display = amount != null ? fmtMoney(amount, currency) : '–';

  if (!editable) return <span className="font-semibold tabular-nums">{display}</span>;
  if (editing) {
    const commit = () => {
      setEditing(false);
      if (draft === '') {
        if (amount != null) onSave(null);
        return;
      }
      const v = Number(draft);
      if (Number.isFinite(v) && v >= 0 && v !== Number(amount ?? 0)) onSave(v);
    };
    return (
      <Input
        autoFocus
        type="number"
        min="0"
        step="0.01"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
        className="h-6 w-28 text-right text-[13px] tabular-nums"
      />
    );
  }
  return (
    <button
      onClick={() => { setDraft(amount != null ? String(Number(amount)) : ''); setEditing(true); }}
      className="-mx-1 rounded-md px-1 font-semibold tabular-nums transition-colors hover:bg-muted"
    >
      {display}
    </button>
  );
}

/* ─────────────── Custom fields ─────────────── */

/**
 * Workspace-defined fields carry free text and URLs – prose-length values that
 * truncated into unreadability in the rail, under labels wrapping at 150px.
 * They render in the wide column instead, same as the lead's Details card.
 */
function CustomFieldsSection({ deal, editable, onPatch }: {
  deal?: DealFull; editable: boolean; onPatch: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  const usersQ = useUsersLookup();
  const defsQ = useQuery<FieldDef[]>({
    queryKey: ['custom-fields', 'deals'],
    queryFn: () => api.get<{ data: FieldDef[] }>('/custom-fields?entityType=deals').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const defs = (defsQ.data ?? []).filter((f) => !f.deprecated);
  if (!deal || defs.length === 0) return null;
  const values = deal.customFields ?? {};
  const save = (key: string, v: unknown) => onPatch({ customFields: { ...values, [key]: v } });

  return (
    <section>
      <SectionHeader icon={<SlidersHorizontal size={15} />} title={t('crm.customFields')} />
      <Card className="p-4">
        <div className="grid gap-x-6 gap-y-3 md:grid-cols-2">
          {defs.map((f) => (
            <DetailField key={f.id} label={f.label}>
              <CustomFieldValue field={f} value={values[f.key]} editable={editable} users={usersQ.data ?? []} onSave={(v) => save(f.key, v)} />
            </DetailField>
          ))}
        </div>
      </Card>
    </section>
  );
}

/** One custom field value: read view + per-type editor. */
function CustomFieldValue({ field: f, value: v, editable, users, onSave }: {
  field: FieldDef; value: unknown; editable: boolean;
  users: { id: string; name: string; avatar?: string | null }[];
  onSave: (v: unknown) => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const empty = <span className="text-faint">–</span>;

  // ── Always-live controls (no separate edit state needed) ──
  if (f.type === 'checkbox') {
    if (!editable) return v ? <span>✓</span> : empty;
    return (
      <button
        role="checkbox"
        aria-checked={!!v}
        onClick={() => onSave(!v)}
        className={cn('grid h-4 w-4 place-items-center rounded border transition-colors',
          v ? 'border-primary bg-primary text-white' : 'border-border-strong hover:border-primary/60')}
      >
        {v ? '✓' : ''}
      </button>
    );
  }
  if (f.type === 'select') {
    const label = f.options?.find((o) => o.value === v)?.label ?? (v ? String(v) : null);
    if (!editable) return label ? <span>{label}</span> : empty;
    return (
      <DropdownMenu
        align="start"
        trigger={<button className="block w-full rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted">{label ?? empty} <ChevronDown size={11} className="inline text-faint" /></button>}
      >
        <MenuItem checked={v == null || v === ''} onSelect={() => onSave(null)}>–</MenuItem>
        {(f.options ?? []).map((o) => (
          <MenuItem key={o.value} checked={o.value === v} onSelect={() => o.value !== v && onSave(o.value)}>{o.label}</MenuItem>
        ))}
      </DropdownMenu>
    );
  }
  if (f.type === 'multiselect') {
    const arr = Array.isArray(v) ? (v as string[]) : [];
    const label = arr.length ? arr.map((x) => f.options?.find((o) => o.value === x)?.label ?? x).join(', ') : null;
    if (!editable) return label ? <span>{label}</span> : empty;
    return (
      <DropdownMenu
        align="start"
        trigger={<button className="block w-full rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted">{label ?? empty} <ChevronDown size={11} className="inline text-faint" /></button>}
      >
        {(f.options ?? []).map((o) => (
          <MenuItem
            key={o.value}
            checked={arr.includes(o.value)}
            onSelect={() => onSave(arr.includes(o.value) ? arr.filter((x) => x !== o.value) : [...arr, o.value])}
          >
            {o.label}
          </MenuItem>
        ))}
      </DropdownMenu>
    );
  }
  if (f.type === 'date') {
    if (!editable) return v ? <span className="tabular-nums">{fmtDate(String(v))}</span> : empty;
    return <DateField size="sm" value={(v as string) ?? null} onChange={(next) => onSave(next)} className="w-full" />;
  }
  if (f.type === 'user') {
    const u = users.find((x) => x.id === v);
    if (!editable) return u ? <span className="inline-flex items-center gap-1.5"><Avatar name={u.name} src={u.avatar} size={16} /> {u.name}</span> : empty;
    return (
      <DropdownMenu
        align="start"
        trigger={<button className="block w-full rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted">{u ? <span className="inline-flex items-center gap-1.5"><Avatar name={u.name} src={u.avatar} size={16} /> {u.name}</span> : empty} <ChevronDown size={11} className="inline text-faint" /></button>}
      >
        <MenuItem checked={!u} onSelect={() => onSave(null)}>{t('crm.noOwner')}</MenuItem>
        {users.map((x) => (
          <MenuItem key={x.id} checked={x.id === v} onSelect={() => x.id !== v && onSave(x.id)}>
            <span className="flex items-center gap-2"><Avatar name={x.name} src={x.avatar} size={18} /> {x.name}</span>
          </MenuItem>
        ))}
      </DropdownMenu>
    );
  }

  // ── text / number / url: click-to-edit ──
  const display = v == null || v === '' ? null
    : f.type === 'url'
      ? <a href={String(v)} target="_blank" rel="noreferrer" className="break-words text-primary hover:underline" onClick={(e) => e.stopPropagation()}>{String(v)}</a>
      : <span className={cn(f.type === 'number' && 'tabular-nums')}>{String(v)}</span>;
  if (!editable) return display ?? empty;
  if (editing) {
    const commit = () => {
      setEditing(false);
      const next = draft.trim();
      if (f.type === 'number') {
        const n = Number(next);
        if (next === '') onSave(null);
        else if (Number.isFinite(n) && n !== v) onSave(n);
        return;
      }
      if (next !== (v ?? '')) onSave(next || null);
    };
    return (
      <input
        autoFocus
        type={f.type === 'number' ? 'number' : 'text'}
        value={draft}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
        className="min-h-7 w-full rounded-md border border-primary/40 bg-transparent px-1.5 py-1 text-[13px] outline-none focus:ring-2 focus:ring-ring/25"
      />
    );
  }
  return (
    <button
      onClick={() => { setDraft(v != null ? String(v) : ''); setEditing(true); }}
      className="block w-full max-w-full break-words rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted"
    >
      {display ?? empty}
    </button>
  );
}

/* ─────────────── Activity trail ─────────────── */

function ActivitySection({ dealId }: { dealId: string }) {
  const t = useT();
  const me = useMe();
  const usersQ = useUsersLookup();
  const { data, isLoading } = useQuery<ActivityRow[]>({
    queryKey: ['activity', 'deal', dealId],
    queryFn: () => api.get<{ data: ActivityRow[] }>(`/audit/entity/deal/${dealId}`).then((r) => r.data),
  });
  const userMap = useMemo(() => new Map((usersQ.data ?? []).map((u) => [u.id, u])), [usersQ.data]);
  const rows = data ?? [];

  const verb = (a: ActivityRow) => {
    const action = a.action || 'updated';
    const base = t(`activity.verb.${action}`, action.replace(/_/g, ' '));
    return base.charAt(0).toUpperCase() + base.slice(1);
  };

  return (
    <section>
      <SectionHeader icon={<ActivityIcon size={15} />} title={t('crm.activity')} count={rows.length} />
      {isLoading ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-8 rounded-md" />)}</div>
      ) : rows.length === 0 ? (
        <EmptySection icon={<ActivityIcon size={14} />} title={t('crm.noActivity')} />
      ) : (
        <ul className="space-y-0.5">
          {rows.map((a) => {
            const actor = a.actorId ? userMap.get(a.actorId) : undefined;
            const isMe = a.actorId === me.user.id;
            return (
              <li key={a.id} className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-[13px]">
                {actor
                  ? <Avatar name={actor.name} src={actor.avatar} size={20} />
                  : <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground')}><ActivityIcon size={11} /></span>}
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium">{isMe ? t('dashboard.you') : actor?.name ?? '—'}</span>
                  <span className="text-muted-foreground"> · {verb(a)}</span>
                </span>
                <span className="shrink-0 text-xs text-faint">{fmtRelative(a.createdAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
