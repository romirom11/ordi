import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, FolderKanban, Lock, Globe, Target, ChevronRight, UserCircle2, Users, CalendarDays,
  Building2, Tag as TagIcon,
} from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Link, useNavigate, useOpen } from '../lib/router';
import { useCan, useMe } from '../lib/auth';
import {
  Button, Input, Badge, PageHeader, Breadcrumbs, Skeleton, EmptyState, Spinner,
  Avatar, AvatarGroup, PriorityIcon, ProgressRing, Tooltip, fmtDate, cn,
} from '../components/ui';
import { Calendar } from '../components/DatePicker';
import { useLabels, useUsersLookup } from '../lib/queries';
import { Dialog, DropdownMenu, MenuItem, MenuLabel, MenuSeparator, useMenuClose } from '../components/overlays';
import { toast } from '../components/overlays';
import { ProjectIcon } from '../components/project/ProjectIcon';
import { ProjectContextMenu } from '../components/project/contextMenus';
import { PRIORITIES, PRIORITY_LABEL_KEY } from '../components/project/taskViewPrefs';
import { textToDoc } from '@ordi/shared';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'projects.noClientsYet': 'No clients yet.',
    'projects.addClientFirst': 'Add one in CRM',
    'projects.filterAll': 'All',
    'projects.statusActive': 'Active',
    'projects.statusPaused': 'Paused',
    'projects.statusCompleted': 'Completed',
    'projects.statusArchived': 'Archived',
    'projects.lead': 'Lead',
    'projects.targetDate': 'Target',
    'projects.noLead': 'No lead',
    'projects.private': 'Private',
    'projects.count': 'projects',
    'projects.type': 'Type',
    'projects.selectType': 'Select type…',
    'projects.namePlaceholder': 'Project name',
    'projects.summaryPlaceholder': 'Add a short summary…',
    'projects.descriptionPlaceholder': 'Write a description, a project brief, or collect ideas…',
    'projects.createProject': 'Create project',
    'projects.keyHint': '2-5 letters, used in task refs like MKT-12.',
    'projects.noClient': 'No client',
    'projects.priority': 'Priority',
    'projects.labels': 'Labels',
  },
  uk: {
    'projects.noClientsYet': 'Клієнтів ще немає.',
    'projects.addClientFirst': 'Додати в CRM',
    'projects.filterAll': 'Всі',
    'projects.statusActive': 'Активний',
    'projects.statusPaused': 'Призупинено',
    'projects.statusCompleted': 'Завершено',
    'projects.statusArchived': 'Архів',
    'projects.lead': 'Керівник',
    'projects.targetDate': 'Ціль',
    'projects.noLead': 'Без керівника',
    'projects.private': 'Приватний',
    'projects.count': 'проєктів',
    'projects.type': 'Тип',
    'projects.selectType': 'Оберіть тип…',
    'projects.namePlaceholder': 'Назва проєкту',
    'projects.summaryPlaceholder': 'Додайте короткий опис…',
    'projects.descriptionPlaceholder': 'Опишіть проєкт, бриф або зберіть ідеї…',
    'projects.createProject': 'Створити проєкт',
    'projects.keyHint': '2-5 літер, використовується в номерах задач: MKT-12.',
    'projects.noClient': 'Без клієнта',
    'projects.priority': 'Пріоритет',
    'projects.labels': 'Мітки',
  },
});

interface Project {
  id: string; name: string; key: string; projectTypeId?: string | null;
  status: string; companyId?: string | null; companyName?: string | null;
  leadId?: string | null; startDate?: string | null; targetDate?: string | null;
  visibility?: string; version?: number;
}
interface ProjectTypeLite {
  id: string; name: string; icon?: string; color?: string;
  requiresClient?: boolean; revenueSource?: string; isDefault?: boolean; position?: number;
}
interface CompanyLite { id: string; name: string }
interface UserLite { id: string; name: string; avatar?: string | null }
interface TaskCounts { projectId: string; total: number; done: number }

const STATUS_META: Record<string, { color: string; key: string }> = {
  active: { color: '#22c55e', key: 'projects.statusActive' },
  paused: { color: '#eab308', key: 'projects.statusPaused' },
  completed: { color: '#5e6ad2', key: 'projects.statusCompleted' },
  archived: { color: '#8a8f98', key: 'projects.statusArchived' },
};
const FILTERS = ['all', 'active', 'paused', 'completed', 'archived'] as const;
type Filter = typeof FILTERS[number];

function StatusPill({ status }: { status: string }) {
  const t = useT();
  const meta = STATUS_META[status] ?? { color: '#8a8f98', key: '' };
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium">
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.color }} />
      <span className="text-muted-foreground">{meta.key ? t(meta.key) : status}</span>
    </span>
  );
}

/**
 * Small completion ring. The counts come from one grouped query for the whole
 * list – each row used to pull its project's entire task list to draw this.
 */
function ProjectProgress({ counts }: { counts?: TaskCounts }) {
  if (!counts || counts.total === 0) return <span className="text-xs tabular-nums text-faint">–</span>;
  const pct = Math.round((counts.done / counts.total) * 100);
  return (
    <Tooltip label={`${counts.done}/${counts.total}`} side="top">
      <span className="inline-flex items-center gap-1.5">
        <ProgressRing value={pct} size={16} stroke={2.5} color={pct === 100 ? '#22c55e' : undefined} />
        <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">{pct}%</span>
      </span>
    </Tooltip>
  );
}

export function ProjectsPage() {
  const t = useT();
  const navigate = useNavigate();
  const open = useOpen();
  const qc = useQueryClient();
  const can = useCan();
  const canCreate = can('projects.create');
  const canWrite = can('projects.write') || can('projects.create');
  const canDelete = can('projects.delete');
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');


  const { data, isLoading } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => api.get<{ data: Project[] }>('/projects').then((r) => r.data),
  });
  const countsQ = useQuery<TaskCounts[]>({
    queryKey: ['project-task-counts'],
    queryFn: () => api.get<{ data: TaskCounts[] }>('/projects/task-counts').then((r) => r.data),
    staleTime: 30_000,
  });
  const countsById = useMemo(
    () => new Map((countsQ.data ?? []).map((row) => [row.projectId, row])),
    [countsQ.data],
  );
  const usersQ = useQuery<UserLite[]>({
    queryKey: ['users', 'lookup'],
    queryFn: () => api.get<{ data: UserLite[] }>('/users/lookup').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const userById = useMemo(() => {
    const m = new Map<string, UserLite>();
    for (const u of usersQ.data ?? []) m.set(u.id, u);
    return m;
  }, [usersQ.data]);
  const typesQ = useQuery<ProjectTypeLite[]>({
    queryKey: ['project-types'],
    queryFn: () => api.get<{ data: ProjectTypeLite[] }>('/project-types').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const typeById = useMemo(() => {
    const m = new Map<string, ProjectTypeLite>();
    for (const pt of typesQ.data ?? []) m.set(pt.id, pt);
    return m;
  }, [typesQ.data]);

  const projects = data ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: projects.length };
    for (const p of projects) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [projects]);
  const shown = filter === 'all' ? projects : projects.filter((p) => p.status === filter);

  return (
    <div className="page-enter">
      <PageHeader
        title={t('nav.projects')}
        subtitle={t('projects.subtitle')}
        breadcrumbs={<Breadcrumbs items={[{ label: t('nav.projects') }]} />}
        actions={canCreate && (
          <Button size="sm" onClick={() => setCreating(true)}><Plus size={14} /> {t('projects.newProject')}</Button>
        )}
      />

      <div className="p-6">
        {!isLoading && projects.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            {FILTERS.map((f) => {
              const n = counts[f] ?? 0;
              if (f !== 'all' && n === 0) return null;
              const active = filter === f;
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors duration-150',
                    active
                      ? 'border-primary/40 bg-primary/10 text-foreground'
                      : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {f !== 'all' && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: STATUS_META[f]?.color }} />}
                  {f === 'all' ? t('projects.filterAll') : t(STATUS_META[f]!.key)}
                  <span className="tabular-nums text-faint">{n}</span>
                </button>
              );
            })}
          </div>
        )}

        {isLoading ? (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className={cn('flex items-center gap-3 px-4 py-3', i > 0 && 'border-t border-border')}>
                <Skeleton className="h-6 w-6 rounded-md" />
                <Skeleton className="h-4 w-48" />
                <Skeleton className="ml-auto h-4 w-16" />
                <Skeleton className="h-5 w-5 rounded-full" />
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <EmptyState
            icon={<FolderKanban size={20} />}
            title={t('projects.empty')}
            hint={t('projects.emptyHint')}
            action={canCreate ? <Button size="sm" onClick={() => setCreating(true)}><Plus size={14} /> {t('projects.newProject')}</Button> : undefined}
          />
        ) : shown.length === 0 ? (
          <EmptyState icon={<FolderKanban size={20} />} title={t('crm.noMatch')} hint={t('crm.noMatchHint')} />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {shown.map((p, i) => {
              const lead = p.leadId ? userById.get(p.leadId) : undefined;
              const ptype = p.projectTypeId ? typeById.get(p.projectTypeId) : undefined;
              return (
                <ProjectContextMenu
                  key={p.id}
                  project={{ id: p.id, name: p.name, key: p.key, status: p.status, version: p.version }}
                  canWrite={canWrite}
                  canDelete={canDelete}
                >
                <button
                  onClick={(e) => open(`/projects/${p.id}`, e)}
                  onAuxClick={(e) => open(`/projects/${p.id}`, e)}
                  style={{ ['--i' as string]: Math.min(i, 10) }}
                  className={cn(
                    'row-enter group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-muted/60',
                    i > 0 && 'border-t border-border',
                  )}
                >
                  <ProjectIcon seed={p.key || p.id} size={26} />
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-foreground">{p.name}</span>
                    {p.visibility === 'private' && <Lock size={12} className="shrink-0 text-faint" />}
                    {p.companyName && <span className="hidden truncate text-xs text-muted-foreground sm:inline">· {p.companyName}</span>}
                  </div>

                  {ptype && (
                    <span className="hidden shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-xs text-muted-foreground md:inline-flex">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: ptype.color ?? '#8a8f98' }} />
                      {ptype.name}
                    </span>
                  )}
                  <Badge className="hidden shrink-0 bg-muted font-mono text-[11px] text-muted-foreground sm:inline-flex">{p.key}</Badge>
                  <div className="hidden shrink-0 md:block"><StatusPill status={p.status} /></div>
                  <div className="hidden w-20 shrink-0 justify-end sm:flex"><ProjectProgress counts={countsById.get(p.id)} /></div>
                  <div className="hidden w-20 shrink-0 items-center justify-end gap-1 text-xs text-muted-foreground lg:flex">
                    {p.targetDate ? (<><Target size={12} className="text-faint" /><span className="tabular-nums">{fmtDate(p.targetDate)}</span></>) : null}
                  </div>
                  <div className="flex w-6 shrink-0 justify-end">
                    {lead
                      ? <Tooltip label={lead.name} side="top"><span><Avatar name={lead.name} src={lead.avatar} size={22} /></span></Tooltip>
                      : <span className="h-[22px] w-[22px] rounded-full border border-dashed border-border" title={t('projects.noLead')} />}
                  </div>
                </button>
                </ProjectContextMenu>
              );
            })}
          </div>
        )}
      </div>

      <NewProjectModal
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => { setCreating(false); qc.invalidateQueries({ queryKey: ['projects'] }); navigate(`/projects/${id}`); }}
      />
    </div>
  );
}

/** Cyrillic romanized so non-Latin names still suggest a key (keys are A-Z only). */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ye', ж: 'zh', з: 'z',
  и: 'y', і: 'i', ї: 'yi', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
  р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ю: 'yu', я: 'ya', ы: 'y', э: 'e', ё: 'e', ь: '', ъ: '',
};

function romanize(value: string): string {
  return value.replace(/[Ѐ-ӿ]/g, (ch) => {
    const lower = ch.toLowerCase();
    const mapped = TRANSLIT[lower] ?? '';
    return ch === lower ? mapped : mapped.toUpperCase();
  });
}

/** Suggest a project key from the name: initials for multi-word, first 3 letters otherwise. */
function deriveProjectKey(name: string): string {
  const words = romanize(name).toUpperCase().replace(/[^A-Z0-9\s]/gi, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const k = (words.length === 1 ? words[0]!.slice(0, 3) : words.map((w) => w[0]!).join('').slice(0, 5))
    .replace(/[^A-Z]/g, '');
  return k.length >= 2 ? k : '';
}

/**
 * New project – a composed sheet rather than a stack of labelled boxes: the
 * icon and the name lead, a summary sits under them, and every choice that
 * decides who sees the project and when it runs is a chip on one row. The
 * description writes itself in the same sheet.
 *
 * Ordi's own fields (type, client, key) are chips too, so the row reads as one
 * set of decisions instead of a form above and a toolbar below.
 */
export function NewProjectModal({ open, onClose, onCreated, defaultCompanyId }: {
  open: boolean; onClose: () => void; onCreated: (id: string) => void; defaultCompanyId?: string;
}) {
  const t = useT();
  const canCrm = useCan()('crm.read');
  const meId = useMe().user.id;
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'workspace' | 'private'>('private');
  const [priority, setPriority] = useState<string>('none');
  const [leadId, setLeadId] = useState<string | null>(null);
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [startDate, setStartDate] = useState<string | null>(null);
  const [targetDate, setTargetDate] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [typeId, setTypeId] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Fresh form every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName(''); setSummary(''); setDescription(''); setKey(''); setKeyTouched(false);
    setTypeId(''); setCompanyId(defaultCompanyId ?? ''); setVisibility('private'); setPriority('none');
    setLeadId(null); setMemberIds([]); setLabelIds([]); setStartDate(null); setTargetDate(null); setError(null);
  }, [open, defaultCompanyId]);

  const wsQ = useQuery<{ name?: string }>({
    queryKey: ['workspace-settings'],
    queryFn: () => api.get<{ name?: string }>('/settings/workspace').catch(() => ({})),
    staleTime: 5 * 60_000,
  });
  const typesQ = useQuery<ProjectTypeLite[]>({
    queryKey: ['project-types'],
    queryFn: () => api.get<{ data: ProjectTypeLite[] }>('/project-types').then((r) => r.data),
    enabled: open,
  });
  const types = typesQ.data ?? [];
  const companiesQ = useQuery<CompanyLite[]>({
    queryKey: ['companies', 'lite'],
    queryFn: () => api.get<{ data: CompanyLite[] }>('/companies').then((r) => r.data),
    enabled: open && canCrm,
  });
  const companies = companiesQ.data ?? [];
  const noClientsYet = canCrm && companiesQ.isSuccess && companies.length === 0;
  const usersQ = useUsersLookup();
  const users = usersQ.data ?? [];
  const labelsQ = useLabels('project');
  const labels = labelsQ.data ?? [];

  // Preselect a sensible type: with no clients in the workspace a client-requiring
  // default would dead-end the very first project, so fall back to the first type
  // that works without a client.
  useEffect(() => {
    if (!open || typeId || !types.length || (canCrm && !companiesQ.isSuccess)) return;
    const preferred = noClientsYet
      ? (types.find((x) => !x.requiresClient) ?? types[0])
      : (types.find((x) => x.isDefault) ?? types[0]);
    if (preferred) setTypeId(preferred.id);
  }, [open, typeId, types, noClientsYet, canCrm, companiesQ.isSuccess]);

  const selectedType = types.find((x) => x.id === typeId);
  const needsClient = !!selectedType?.requiresClient;
  const lead = leadId ? users.find((u) => u.id === leadId) : undefined;
  const client = companyId ? companies.find((c) => c.id === companyId) : undefined;

  const mut = useMutation({
    /**
     * Create, then finish. `POST /projects` takes the fields a project cannot
     * exist without; summary, priority and labels are project *edits*, and
     * members need a project to belong to – so they follow in one patch and
     * one call each, and none of them can lose the project if they fail.
     */
    mutationFn: async () => {
      const project = await api.post<Project>('/projects', {
        name: name.trim(),
        key,
        projectTypeId: typeId,
        companyId: companyId || undefined,
        visibility,
        leadId,
        startDate,
        targetDate,
        // The overview reads the description as stored tiptap JSON.
        description: description.trim() ? JSON.stringify(textToDoc(description.trim())) : undefined,
      });
      const patch: Record<string, unknown> = {};
      if (summary.trim()) patch.summary = summary.trim();
      if (priority !== 'none') patch.priority = priority;
      if (labelIds.length) patch.labelIds = labelIds;
      if (Object.keys(patch).length) {
        await api.patch(`/projects/${project.id}`, patch).catch(() => { /* the project exists; a lost chip is not worth losing it */ });
      }
      // Never re-add yourself: createProject already made the creator a project
      // admin, and upserting them as a plain member would take that away.
      const invite = [...new Set([...memberIds, ...(leadId ? [leadId] : [])])].filter((id) => id !== meId);
      for (const userId of invite) {
        await api.post(`/projects/${project.id}/members`, { userId, role: 'member', canWriteTasks: true }).catch(() => {});
      }
      return project;
    },
    onSuccess: (p) => onCreated(p.id),
    onError: (e) => { const m = e instanceof ApiError ? e.message : t('projects.createFailed'); setError(m); toast.error(m); },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) { setError(t('common.nameRequired')); return; }
    if (!/^[A-Z]{2,5}$/.test(key)) { setError(t('projects.keyInvalid')); return; }
    if (!typeId) { setError(t('projects.selectType')); return; }
    if (needsClient && !companyId) { setError(t('projects.clientRequired')); return; }
    mut.mutate();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      width={720}
      title={(
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <span className="truncate">{wsQ.data?.name || 'ordi'}</span>
          <ChevronRight size={12} className="text-faint" />
          <span className="text-foreground">{t('projects.newProject')}</span>
        </span>
      )}
    >
      <form onSubmit={submit} className="px-5 pb-4 pt-3">
        <div className="flex items-start gap-3">
          <ProjectIcon seed={key || name || 'new'} size={36} radius={9} className="mt-1.5" />
          <div className="min-w-0 flex-1">
            <input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!keyTouched) setKey(deriveProjectKey(e.target.value));
              }}
              placeholder={t('projects.namePlaceholder')}
              className="w-full bg-transparent text-[22px] font-semibold leading-tight outline-none placeholder:text-faint focus-visible:outline-none"
            />
            <input
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder={t('projects.summaryPlaceholder')}
              maxLength={500}
              className="mt-1 w-full bg-transparent text-[13px] outline-none placeholder:text-faint focus-visible:outline-none"
            />
          </div>
        </div>

        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          {/* Key: ordi needs one and derives it from the name, so it stays a chip
              until someone wants to change it. */}
          <DropdownMenu
            align="start"
            width={200}
            trigger={<FormChip active={!!key} label={t('projects.key')}><span className="font-mono">{key || t('projects.key')}</span></FormChip>}
          >
            <MenuLabel>{t('projects.key')}</MenuLabel>
            <div className="p-1">
              <Input
                value={key}
                onChange={(e) => {
                  const v = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
                  setKey(v);
                  setKeyTouched(v !== '');
                }}
                placeholder="MKT"
                className="font-mono uppercase"
              />
              <p className="mt-1 px-0.5 text-[11px] text-faint">{t('projects.keyHint')}</p>
            </div>
          </DropdownMenu>

          <DropdownMenu
            align="start"
            width={220}
            trigger={(
              <FormChip active={!!selectedType} label={t('projects.type')}>
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: selectedType?.color ?? '#8a8f98' }} />
                {selectedType?.name ?? t('projects.selectType')}
              </FormChip>
            )}
          >
            <MenuLabel>{t('projects.type')}</MenuLabel>
            {types.map((pt) => (
              <MenuItem
                key={pt.id}
                checked={pt.id === typeId}
                icon={<span className="h-2 w-2 rounded-full" style={{ backgroundColor: pt.color ?? '#8a8f98' }} />}
                onSelect={() => setTypeId(pt.id)}
              >
                {pt.name}
              </MenuItem>
            ))}
          </DropdownMenu>

          {canCrm && (companies.length > 0 || needsClient) && (
            <DropdownMenu
              align="start"
              width={240}
              trigger={(
                <FormChip active={!!client} label={t('crm.client')}>
                  <Building2 size={13} />
                  {client?.name ?? t('crm.client')}
                  {needsClient && !client && <span className="text-destructive">*</span>}
                </FormChip>
              )}
            >
              <MenuLabel>{t('crm.client')}</MenuLabel>
              {!needsClient && <MenuItem checked={!companyId} onSelect={() => setCompanyId('')}>{t('projects.noClient')}</MenuItem>}
              {companies.map((c) => (
                <MenuItem key={c.id} checked={c.id === companyId} onSelect={() => setCompanyId(c.id)}>{c.name}</MenuItem>
              ))}
            </DropdownMenu>
          )}

          <DropdownMenu
            align="start"
            width={260}
            trigger={(
              <FormChip active={visibility === 'private'} label={t('projects.visibility')}>
                {visibility === 'private' ? <Lock size={13} /> : <Globe size={13} />}
                {visibility === 'private' ? t('projects.visPrivate') : t('projects.visWorkspace')}
              </FormChip>
            )}
          >
            <MenuLabel>{t('projects.visibility')}</MenuLabel>
            <MenuItem icon={<Lock size={15} />} checked={visibility === 'private'} onSelect={() => setVisibility('private')}>
              <span className="flex flex-col">
                <span>{t('projects.visPrivate')}</span>
                <span className="text-xs text-faint">{t('projects.visPrivateHint')}</span>
              </span>
            </MenuItem>
            <MenuItem icon={<Globe size={15} />} checked={visibility === 'workspace'} onSelect={() => setVisibility('workspace')}>
              <span className="flex flex-col">
                <span>{t('projects.visWorkspace')}</span>
                <span className="text-xs text-faint">{t('projects.visWorkspaceHint')}</span>
              </span>
            </MenuItem>
          </DropdownMenu>

          <DropdownMenu
            align="start"
            width={200}
            trigger={(
              <FormChip active={priority !== 'none'} label={t('projects.priority')}>
                <PriorityIcon priority={priority} size={13} />
                {priority === 'none' ? t('projects.priority') : t(PRIORITY_LABEL_KEY[priority] ?? 'projects.priority')}
              </FormChip>
            )}
          >
            <MenuLabel>{t('projects.priority')}</MenuLabel>
            {PRIORITIES.map((p) => (
              <MenuItem key={p} icon={<PriorityIcon priority={p} size={14} />} checked={priority === p} onSelect={() => setPriority(p)}>
                {t(PRIORITY_LABEL_KEY[p] ?? p)}
              </MenuItem>
            ))}
          </DropdownMenu>

          <DropdownMenu
            align="start"
            width={230}
            trigger={(
              <FormChip active={!!lead} label={t('projects.lead')}>
                {lead ? <Avatar name={lead.name} src={lead.avatar} size={16} /> : <UserCircle2 size={13} />}
                {lead ? lead.name : t('projects.lead')}
              </FormChip>
            )}
          >
            <MenuLabel>{t('projects.lead')}</MenuLabel>
            <MenuItem icon={<UserCircle2 size={16} />} checked={!leadId} onSelect={() => setLeadId(null)}>{t('projects.noLead')}</MenuItem>
            <MenuSeparator />
            {users.map((u) => (
              <MenuItem key={u.id} icon={<Avatar name={u.name} src={u.avatar} size={18} />} checked={leadId === u.id} onSelect={() => setLeadId(u.id)}>
                {u.name}
              </MenuItem>
            ))}
          </DropdownMenu>

          <DropdownMenu
            align="start"
            width={230}
            trigger={(
              <FormChip active={memberIds.length > 0} label={t('access.members')}>
                {memberIds.length > 0
                  ? <AvatarGroup users={users.filter((u) => memberIds.includes(u.id))} size={16} max={3} />
                  : <Users size={13} />}
                {memberIds.length > 0 ? String(memberIds.length) : t('access.members')}
              </FormChip>
            )}
          >
            <MenuLabel>{t('access.members')}</MenuLabel>
            {users.map((u) => (
              <MenuItem
                key={u.id}
                icon={<Avatar name={u.name} src={u.avatar} size={18} />}
                checked={memberIds.includes(u.id)}
                onSelect={() => setMemberIds((ids) => (ids.includes(u.id) ? ids.filter((x) => x !== u.id) : [...ids, u.id]))}
              >
                {u.name}
              </MenuItem>
            ))}
          </DropdownMenu>

          <DateChip value={startDate} onChange={setStartDate} label={t('projects.startDate')} />
          <DateChip value={targetDate} onChange={setTargetDate} label={t('projects.targetDate')} min={startDate} />

          {labels.length > 0 && (
            <DropdownMenu
              align="start"
              width={230}
              trigger={(
                <FormChip active={labelIds.length > 0} label={t('projects.labels')}>
                  <TagIcon size={13} />
                  {labelIds.length > 0 ? String(labelIds.length) : t('projects.labels')}
                </FormChip>
              )}
            >
              <MenuLabel>{t('projects.labels')}</MenuLabel>
              {labels.map((l) => (
                <MenuItem
                  key={l.id}
                  icon={<span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color ?? '#8a8f98' }} />}
                  checked={labelIds.includes(l.id)}
                  onSelect={() => setLabelIds((ids) => (ids.includes(l.id) ? ids.filter((x) => x !== l.id) : [...ids, l.id]))}
                >
                  {l.name}
                </MenuItem>
              ))}
            </DropdownMenu>
          )}
        </div>

        <div className="mt-4 border-t border-border pt-3">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('projects.descriptionPlaceholder')}
            rows={5}
            className="w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-faint focus-visible:outline-none"
          />
        </div>

        {noClientsYet && needsClient && (
          <p className="text-xs text-muted-foreground">
            {t('projects.noClientsYet')}{' '}
            <Link to="/crm" className="text-primary hover:underline">{t('projects.addClientFirst')}</Link>
          </p>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </form>

      <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
        <span className="truncate text-xs text-muted-foreground">
          {visibility === 'private' ? t('projects.visPrivateHint') : t('projects.visWorkspaceHint')}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button size="sm" onClick={submit} disabled={mut.isPending}>
            {mut.isPending ? <Spinner /> : t('projects.createProject')}
          </Button>
        </span>
      </div>
    </Dialog>
  );
}

/** A date as a chip: the calendar lives in the menu, like every other choice on the row. */
function DateChip({ value, onChange, label, min }: {
  value: string | null; onChange: (v: string | null) => void; label: string; min?: string | null;
}) {
  const t = useT();
  return (
    <DropdownMenu
      align="start"
      width={264}
      trigger={(
        <FormChip active={!!value} label={label}>
          <CalendarDays size={13} />
          {value ? fmtDate(value) : label}
        </FormChip>
      )}
    >
      <MenuLabel>{label}</MenuLabel>
      <CalendarChoice value={value} min={min} onSelect={onChange} />
      {value && (
        <>
          <MenuSeparator />
          <MenuItem danger onSelect={() => onChange(null)}>{t('projects.clearDate')}</MenuItem>
        </>
      )}
    </DropdownMenu>
  );
}

/** Picking a day applies it and closes the menu. */
function CalendarChoice({ value, min, onSelect }: { value: string | null; min?: string | null; onSelect: (v: string) => void }) {
  const close = useMenuClose();
  return <Calendar value={value} min={min ?? undefined} onSelect={(day) => { onSelect(day); close(); }} />;
}

/** A Linear-style pill for a dialog's inline choices: icon, value, no border noise until it carries one. */
function FormChip({ children, active, label }: { children: ReactNode; active?: boolean; label?: string }) {
  return (
    <span
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors duration-150',
        active
          ? 'border-primary/40 bg-primary/10 text-foreground'
          : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </span>
  );
}
