/**
 * Deal detail – the deal finally has a card of its own (previously it existed
 * only as a kanban tile that linked to the company). Header: editable title,
 * stage dropdown (lost stage prompts for a reason), company link, owner picker.
 * Main column: notes (deal-scoped) + activity trail. Side: properties incl.
 * custom fields.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Activity as ActivityIcon, CalendarClock, ChevronDown, ExternalLink as ExternalLinkIcon, FolderKanban, Handshake } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Link } from '../lib/router';
import { useCan, useMe } from '../lib/auth';
import { useT } from '../lib/i18n';
import {
  Avatar, Badge, Breadcrumbs, Card, EmptyState, Input, Skeleton,
  cn, fmtMoney, fmtDate, fmtRelative,
} from '../components/ui';
import { DropdownMenu, MenuItem, MenuLabel, toast } from '../components/overlays';
import { useDealStages, useProjectsLookup, useUsersLookup, CURRENCIES, type Company, type Deal, type ProjectLite, type Stage } from '../components/crm/shared';
import { EditableName, NotesSection, OwnerPicker, PropRow, SectionHeader } from '../components/crm/detail';
import { LostReasonDialog } from '../components/crm/dialogs';

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
      {/* Breadcrumb + header */}
      <div className="border-b border-border px-6 pb-4 pt-3">
        <Breadcrumbs
          className="mb-3"
          items={[
            { label: t('crm.title'), to: '/crm' },
            { label: t('crm.tabPipeline'), to: '/crm/deals' },
          ]}
        />
        <div className="flex items-start gap-4">
          <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
            <Handshake size={22} />
          </div>
          <div className="min-w-0 flex-1">
            {dealQ.isLoading ? (
              <Skeleton className="h-6 w-52" />
            ) : d ? (
              <EditableName value={d.title} editable={canWrite} onSave={(title) => patch.mutate({ title })} />
            ) : (
              <div className="flex items-center gap-2 text-muted-foreground"><Handshake size={18} /> {t('common.error')}</div>
            )}
            {d && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <StageDropdown stage={stage} stages={stages} editable={canWrite} onPick={pickStage} />
                {companyQ.data && (
                  <Link
                    to={`/companies/${companyQ.data.id}`}
                    className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Avatar name={companyQ.data.name} size={16} />
                    <span className="truncate">{companyQ.data.name}</span>
                  </Link>
                )}
                <ProjectPicker
                  project={project}
                  projects={projectsQ.data ?? []}
                  editable={canWrite}
                  onPick={(pid) => patch.mutate({ projectId: pid })}
                />
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
            {can('crm.read') && <NotesSection dealId={id} canWrite={can('crm.write')} />}
            <ActivitySection dealId={id} />
          </div>
          <aside className="space-y-4">
            <DealPropertiesCard deal={d} stage={stage} loading={dealQ.isLoading} editable={canWrite} onPatch={(body) => patch.mutate(body)} />
            <CustomFieldsCard deal={d} />
          </aside>
        </div>
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

/* ─────────────── Project picker ─────────────── */

function ProjectPicker({ project, projects, editable, onPick }: {
  project?: ProjectLite; projects: ProjectLite[]; editable: boolean; onPick: (id: string | null) => void;
}) {
  const t = useT();
  const content = (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <FolderKanban size={13} className={project ? undefined : 'text-faint'} />
      {project ? (
        <>
          <span className="truncate">{project.name}</span>
          {project.key && <span className="shrink-0 font-mono text-[10px] text-faint">{project.key}</span>}
        </>
      ) : (
        <span className="text-faint">{t('crm.noProject')}</span>
      )}
    </span>
  );
  // Read-only: a linked project is a link; an empty slot is just text.
  if (!editable) {
    return project
      ? <Link to={`/projects/${project.id}`} className="rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted">{content}</Link>
      : content;
  }
  return (
    <span className="inline-flex items-center">
      {project && (
        <Link to={`/projects/${project.id}`} aria-label={t('crm.viewProject')} className="rounded-md p-0.5 text-faint transition-colors hover:bg-muted hover:text-foreground">
          <ExternalLinkIcon size={12} />
        </Link>
      )}
      <DropdownMenu
        align="start"
        trigger={<button className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted">{content}<ChevronDown size={12} className="text-faint" /></button>}
      >
        <MenuLabel>{t('crm.linkProjectHint')}</MenuLabel>
        <MenuItem checked={!project} onSelect={() => project && onPick(null)}>{t('crm.noProject')}</MenuItem>
        {projects.map((p) => (
          <MenuItem key={p.id} checked={p.id === project?.id} onSelect={() => p.id !== project?.id && onPick(p.id)}>
            <span className="flex items-center gap-2">
              <FolderKanban size={13} className="text-muted-foreground" />
              <span className="flex-1 truncate">{p.name}</span>
              {p.key && <span className="font-mono text-[10px] text-faint">{p.key}</span>}
            </span>
          </MenuItem>
        ))}
      </DropdownMenu>
    </span>
  );
}

/* ─────────────── Stage dropdown ─────────────── */

function stageColor(stage?: Stage): string | undefined {
  if (stage?.isWon) return '#22c55e';
  if (stage?.isLost) return '#ef4444';
  return undefined;
}

function StageDropdown({ stage, stages, editable, onPick }: {
  stage?: Stage; stages: Stage[]; editable: boolean; onPick: (s: Stage) => void;
}) {
  const t = useT();
  const pill = <Badge color={stageColor(stage)}>{stage?.name ?? t('deals.stage')}</Badge>;
  if (!editable) return pill;
  return (
    <DropdownMenu
      align="start"
      trigger={
        <button className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted">
          {pill}
          <ChevronDown size={12} className="text-faint" />
        </button>
      }
    >
      <MenuLabel>{t('crm.moveToStage')}</MenuLabel>
      {stages.map((s) => (
        <MenuItem key={s.id} checked={s.id === stage?.id} onSelect={() => onPick(s)}>
          <Badge color={stageColor(s)}>{s.name}</Badge>
        </MenuItem>
      ))}
    </DropdownMenu>
  );
}

/* ─────────────── Properties ─────────────── */

function DealPropertiesCard({ deal, stage, loading, editable, onPatch }: {
  deal?: DealFull; stage?: Stage; loading: boolean; editable: boolean; onPatch: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  return (
    <Card className="p-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">{t('crm.properties')}</h3>
      {loading || !deal ? (
        <div className="space-y-2 pt-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-4" />)}</div>
      ) : (
        <div className="divide-y divide-border/60">
          <PropRow label={t('public.amount')}>
            <EditableAmount amount={deal.amount} currency={deal.currency ?? 'USD'} editable={editable} onSave={(v) => onPatch({ amount: v })} />
          </PropRow>
          <PropRow label={t('common.currency')}>
            {editable ? (
              <DropdownMenu
                align="end"
                trigger={<button className="inline-flex items-center gap-1 rounded-md px-1 tabular-nums transition-colors hover:bg-muted">{deal.currency ?? 'USD'}<ChevronDown size={11} className="text-faint" /></button>}
              >
                {CURRENCIES.map((cur) => (
                  <MenuItem key={cur} checked={cur === (deal.currency ?? 'USD')} onSelect={() => cur !== deal.currency && onPatch({ currency: cur })}>{cur}</MenuItem>
                ))}
              </DropdownMenu>
            ) : (
              <span className="tabular-nums">{deal.currency ?? 'USD'}</span>
            )}
          </PropRow>
          <PropRow label={t('crm.expectedClose')}>
            {editable ? (
              <input
                type="date"
                value={deal.expectedCloseDate ?? ''}
                onChange={(e) => onPatch({ expectedCloseDate: e.target.value || null })}
                className="rounded-md bg-transparent text-right text-[13px] tabular-nums outline-none transition-colors hover:bg-muted focus:ring-2 focus:ring-ring/25"
              />
            ) : deal.expectedCloseDate ? (
              <span className="inline-flex items-center gap-1 tabular-nums"><CalendarClock size={12} /> {fmtDate(deal.expectedCloseDate)}</span>
            ) : (
              <span className="text-faint">–</span>
            )}
          </PropRow>
          {stage?.isLost && deal.lostReason && (
            <PropRow label={t('crm.lostReasonLabel')}><span className="text-destructive">{deal.lostReason}</span></PropRow>
          )}
          <PropRow label={t('crm.created')}>{fmtDate(deal.createdAt)}</PropRow>
        </div>
      )}
    </Card>
  );
}

function EditableAmount({ amount, currency, editable, onSave }: {
  amount?: string | number | null; currency: string; editable: boolean; onSave: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const display = amount != null ? fmtMoney(amount, currency) : '–';

  if (!editable) return <span className="font-semibold tabular-nums">{display}</span>;
  if (editing) {
    const commit = () => {
      setEditing(false);
      const v = Number(draft);
      if (draft !== '' && Number.isFinite(v) && v >= 0 && v !== Number(amount ?? 0)) onSave(v);
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

function CustomFieldsCard({ deal }: { deal?: DealFull }) {
  const t = useT();
  const defsQ = useQuery<FieldDef[]>({
    queryKey: ['custom-fields', 'deals'],
    queryFn: () => api.get<{ data: FieldDef[] }>('/custom-fields?entityType=deals').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const defs = (defsQ.data ?? []).filter((f) => !f.deprecated);
  if (!deal || defs.length === 0) return null;
  const values = deal.customFields ?? {};

  const render = (f: FieldDef) => {
    const v = values[f.key];
    if (v == null || v === '') return <span className="text-faint">–</span>;
    if (f.type === 'checkbox') return <span>{v ? '✓' : '–'}</span>;
    if (f.type === 'select') return <span>{f.options?.find((o) => o.value === v)?.label ?? String(v)}</span>;
    if (f.type === 'multiselect' && Array.isArray(v)) {
      return <span>{v.map((x) => f.options?.find((o) => o.value === x)?.label ?? String(x)).join(', ')}</span>;
    }
    if (f.type === 'url') return <a href={String(v)} target="_blank" rel="noreferrer" className="text-primary hover:underline">{String(v)}</a>;
    if (f.type === 'date') return <span className="tabular-nums">{fmtDate(String(v))}</span>;
    return <span>{String(v)}</span>;
  };

  return (
    <Card className="p-4">
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">{t('crm.customFields')}</h3>
      <div className="divide-y divide-border/60">
        {defs.map((f) => <PropRow key={f.id} label={f.label}>{render(f)}</PropRow>)}
      </div>
    </Card>
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
        <EmptyState icon={<ActivityIcon size={18} />} title={t('crm.noActivity')} />
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
