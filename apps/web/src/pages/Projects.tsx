import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, FolderKanban, Lock, Target, ChevronDown } from 'lucide-react';
import { api, qs, ApiError } from '../lib/api';
import { Link, useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import {
  Button, Input, Select, Badge, PageHeader, Breadcrumbs, Skeleton, EmptyState, Spinner,
  Avatar, ProgressRing, Tooltip, fmtDate, cn,
} from '../components/ui';
import { Dialog, DropdownMenu, MenuItem } from '../components/overlays';
import { toast } from '../components/overlays';
import { ProjectIcon } from '../components/project/ProjectIcon';
import { ProjectContextMenu } from '../components/project/contextMenus';
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
interface TaskLite { id: string; statusId: string }
interface StatusLite { id: string; category?: string }

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

/** Small completion ring computed from the project's tasks + statuses (cache shared with detail page). */
function ProjectProgress({ id }: { id: string }) {
  const tasksQ = useQuery<TaskLite[]>({
    queryKey: ['tasks', id],
    queryFn: () => api.get<{ data: TaskLite[] }>(`/tasks${qs({ projectId: id })}`).then((r) => r.data),
    staleTime: 30_000,
  });
  const statusesQ = useQuery<StatusLite[]>({
    queryKey: ['task-statuses', id],
    queryFn: () => api.get<{ data: StatusLite[] }>(`/projects/${id}/task-statuses`).then((r) => r.data),
    staleTime: 60_000,
  });
  if (tasksQ.isLoading || statusesQ.isLoading) return <div className="h-4 w-4 rounded-full bg-muted" />;
  const tasks = tasksQ.data ?? [];
  const statuses = statusesQ.data ?? [];
  if (tasks.length === 0) return <span className="text-xs tabular-nums text-faint">–</span>;
  const catOf = (sid: string) => statuses.find((s) => s.id === sid)?.category;
  const done = tasks.filter((t) => catOf(t.statusId) === 'done').length;
  const pct = Math.round((done / tasks.length) * 100);
  return (
    <Tooltip label={`${done}/${tasks.length}`} side="top">
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
                  onClick={() => navigate(`/projects/${p.id}`)}
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
                  <div className="hidden w-20 shrink-0 justify-end sm:flex"><ProjectProgress id={p.id} /></div>
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

export function NewProjectModal({ open, onClose, onCreated, defaultCompanyId }: {
  open: boolean; onClose: () => void; onCreated: (id: string) => void; defaultCompanyId?: string;
}) {
  const t = useT();
  const canCrm = useCan()('crm.read');
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyTouched, setKeyTouched] = useState(false);
  const [typeId, setTypeId] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Fresh form every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName(''); setKey(''); setKeyTouched(false); setTypeId(''); setCompanyId(defaultCompanyId ?? ''); setError(null);
  }, [open, defaultCompanyId]);

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

  const mut = useMutation({
    mutationFn: () => api.post<Project>('/projects', {
      name, key, projectTypeId: typeId, companyId: companyId || undefined,
    }),
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
    <Dialog open={open} onClose={onClose} title={t('projects.newProject')} width={460}>
      <form onSubmit={submit} className="space-y-3 px-4 pb-4 pt-1">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('common.name')}</label>
          <Input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!keyTouched) setKey(deriveProjectKey(e.target.value));
            }}
            placeholder="Marketing site"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('projects.key')}</label>
            <Input
              value={key}
              onChange={(e) => {
                const v = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
                setKey(v);
                // Manual edits stop auto-derivation; clearing the field resumes it.
                setKeyTouched(v !== '');
              }}
              placeholder="MKT"
              className="font-mono uppercase"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('projects.type')}</label>
            <DropdownMenu
              align="start"
              width={220}
              className="block w-full"
              trigger={
                <button
                  type="button"
                  className="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-transparent px-2.5 text-[13px] outline-none transition-colors duration-150 hover:border-border-strong focus-visible:border-primary/60"
                >
                  {selectedType ? (
                    <>
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: selectedType.color ?? '#8a8f98' }} />
                      <span className="truncate">{selectedType.name}</span>
                    </>
                  ) : (
                    <span className="truncate text-faint">{typesQ.isLoading ? t('common.loading') : t('projects.selectType')}</span>
                  )}
                  <ChevronDown size={13} className="ml-auto shrink-0 text-faint" />
                </button>
              }
            >
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
          </div>
        </div>
        {(needsClient || !!defaultCompanyId) && (
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('crm.client')}</label>
            {canCrm && noClientsYet ? (
              <p className="text-xs text-muted-foreground">
                {t('projects.noClientsYet')}{' '}
                <Link to="/crm" className="text-primary hover:underline">{t('projects.addClientFirst')}</Link>
              </p>
            ) : canCrm ? (
              <Select value={companyId} onChange={(e) => setCompanyId(e.target.value)} className="w-full">
                <option value="">{companiesQ.isLoading ? t('common.loading') : t('projects.selectClient')}</option>
                {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            ) : (
              <Input value={companyId} onChange={(e) => setCompanyId(e.target.value)} placeholder="Company ID" />
            )}
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={mut.isPending}>{mut.isPending ? <Spinner /> : t('common.create')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
