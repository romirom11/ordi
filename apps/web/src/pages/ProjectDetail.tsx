import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays, Plus,
  LayoutDashboard, ListChecks, Repeat, CalendarClock, Settings, ChevronRight,
} from 'lucide-react';
import { api, qs, ApiError } from '../lib/api';
import { Link, useNavigate, useSearchParams } from '../lib/router';
import { useCan } from '../lib/auth';
import { usePageTitle } from '../lib/tabs';
import {
  Button, IconButton, Input, Card, Badge, Skeleton, EmptyState, Spinner, Avatar, AvatarGroup,
  StatusIcon, PriorityIcon, ProgressBar, ProgressRing, PageBody,
  fmtDate, cn,
} from '../components/ui';
import { Dialog, toast } from '../components/overlays';
import { CalendarView } from '../components/views/CalendarView';
import { TimelineView } from '../components/views/TimelineView';
import { SpreadsheetView } from '../components/views/SpreadsheetView';
import { RichEditor, EMPTY_DOC } from '../components/richtext/RichEditor';
import { ProjectAccessPanel } from '../components/ProjectAccessPanel';
import { ProjectIcon } from '../components/project/ProjectIcon';
import { PropertiesRail } from '../components/project/PropertiesRail';
import { ProjectResources, type ProjectLink } from '../components/project/ProjectResources';
import { ProjectUpdates } from '../components/project/ProjectUpdates';
import { ProjectMilestones } from '../components/project/ProjectMilestones';
import { ProjectActivity } from '../components/project/ProjectActivity';
import { ProjectIntegrations } from '../components/project/ProjectIntegrations';
import { ProjectContextMenu, TaskContextMenu } from '../components/project/contextMenus';
import { PROJECT_STATUSES, STATUS_META, type UserLite } from '../components/project/pickers';
import { TasksToolbar } from '../components/project/TasksToolbar';
import type { LabelLite } from '../components/project/FilterPopover';
import {
  EMPTY_FILTERS, PRIORITIES, PRIORITY_LABEL_KEY, applyFilters, loadPrefs, orderTasks, savePrefs,
  type Grouping, type TaskFilters, type TaskViewPrefs,
} from '../components/project/taskViewPrefs';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'projects.noLead': 'No lead',
    'projects.lead': 'Lead',
    'projects.clearDate': 'Clear date',
    'projects.startDate': 'Start',
    'projects.targetDate': 'Target',
    'projects.setStart': 'Set start',
    'projects.setTarget': 'Set target',
    'projects.private': 'Private',
    'projects.visibility': 'Visibility',
    'projects.visWorkspace': 'Workspace',
    'projects.visPrivate': 'Private',
    'projects.visWorkspaceHint': 'Everyone in the workspace can see this project.',
    'projects.visPrivateHint': 'Only members with access can see this project.',
    'projects.completion': 'Completion',
    'projects.byStatus': 'By status',
    'projects.general': 'General',
    'projects.access': 'Access',
    'projects.conflict': 'This project changed elsewhere – reloaded the latest version.',
    'projects.statusActive': 'Active',
    'projects.statusPaused': 'Paused',
    'projects.statusCompleted': 'Completed',
    'projects.statusArchived': 'Archived',
    'projects.newTaskInline': 'Add task…',
    'projects.noTasks': 'No tasks in this project yet',
    'projects.noTasksHint': 'Create your first task – click + in a status group or press C.',
    'projects.cycleDatesRequired': 'Pick start and end dates for the cycle.',
    'projects.cycleDatesOrder': 'The end date must be after the start date.',
    'projects.aboutPlaceholder': 'Describe this project – goals, scope, context…',
    'projects.overviewEmpty': 'No tasks yet',
    'projects.loadFailed': 'Could not load this project.',
    'projects.properties': 'Properties',
    'projects.overviewHint': 'This is the project page – describe the goals here, and add tasks in the Tasks tab.',
    'projects.summaryPh': 'Add a short summary…',
    'projects.description': 'Description',
  },
  uk: {
    'projects.noLead': 'Без керівника',
    'projects.lead': 'Керівник',
    'projects.clearDate': 'Очистити дату',
    'projects.startDate': 'Початок',
    'projects.targetDate': 'Ціль',
    'projects.setStart': 'Задати початок',
    'projects.setTarget': 'Задати ціль',
    'projects.private': 'Приватний',
    'projects.visibility': 'Видимість',
    'projects.visWorkspace': 'Робочий простір',
    'projects.visPrivate': 'Приватний',
    'projects.visWorkspaceHint': 'Усі в робочому просторі бачать цей проєкт.',
    'projects.visPrivateHint': 'Проєкт бачать лише учасники з доступом.',
    'projects.completion': 'Завершеність',
    'projects.byStatus': 'За статусом',
    'projects.general': 'Загальні',
    'projects.access': 'Доступ',
    'projects.conflict': 'Проєкт змінено деінде – завантажено найновішу версію.',
    'projects.statusActive': 'Активний',
    'projects.statusPaused': 'Призупинено',
    'projects.statusCompleted': 'Завершено',
    'projects.statusArchived': 'Архів',
    'projects.newTaskInline': 'Додати задачу…',
    'projects.noTasks': 'У цьому проєкті ще немає задач',
    'projects.noTasksHint': 'Створіть першу задачу – натисніть + у групі статусу або C на клавіатурі.',
    'projects.cycleDatesRequired': 'Оберіть дати початку та завершення циклу.',
    'projects.cycleDatesOrder': 'Дата завершення має бути після дати початку.',
    'projects.aboutPlaceholder': 'Опишіть проєкт – цілі, обсяг, контекст…',
    'projects.overviewEmpty': 'Задач поки немає',
    'projects.loadFailed': 'Не вдалося завантажити проєкт.',
    'projects.properties': 'Властивості',
    'projects.overviewHint': 'Це сторінка проєкту: опишіть тут цілі, а задачі додавайте у вкладці Tasks.',
    'projects.summaryPh': 'Короткий підсумок…',
    'projects.description': 'Опис',
  },
});

interface Project {
  id: string; name: string; key: string; status: string; projectTypeId?: string | null;
  companyId?: string | null; companyName?: string | null; description?: unknown;
  leadId?: string | null; startDate?: string | null; targetDate?: string | null;
  visibility?: string; version?: number; settings?: Record<string, unknown>;
  summary?: string; priority?: string; links?: ProjectLink[]; labelIds?: string[];
}
interface TaskStatus {
  id: string; name: string; category?: string; color?: string; position?: number; isDefault?: boolean;
}
interface Task {
  id: string; number?: number; ref?: string; title: string; statusId: string; priority?: string;
  dueDate?: string | null; startDate?: string | null; estimate?: number | string | null; version?: number;
  parentId?: string | null; assigneeIds?: string[]; labelIds?: string[]; createdAt?: string;
}
interface Cycle {
  id: string; name: string; startDate?: string; endDate?: string; status?: string; goal?: string;
  progress?: number; completedCount?: number; totalCount?: number; openCount?: number;
}

function isOverdue(due: string | null | undefined, cat?: string): boolean {
  if (!due) return false;
  if (cat === 'done' || cat === 'canceled') return false;
  const d = new Date(due); d.setHours(0, 0, 0, 0);
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return d.getTime() < now.getTime();
}

/* ───────────────────────── Page ───────────────────────── */

const TABS = ['overview', 'tasks', 'cycles', 'settings'] as const;
type Tab = typeof TABS[number];

export function ProjectDetailPage({ id }: { id: string; taskId?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const params = useSearchParams();
  const qc = useQueryClient();
  const can = useCan();
  const canWrite = can('projects.write') || can('projects.create');
  const canDelete = can('projects.delete');
  const isAdmin = can('projects.write');

  const rawSection = params.get('section') ?? '';
  const tab: Tab = (TABS as readonly string[]).includes(rawSection) ? (rawSection as Tab) : 'overview';
  const setTab = (next: Tab) => navigate(next === 'overview' ? `/projects/${id}` : `/projects/${id}?section=${next}`);

  const projectQ = useQuery<Project>({ queryKey: ['project', id], queryFn: () => api.get<Project>(`/projects/${id}`) });
  const statusesQ = useQuery<TaskStatus[]>({
    queryKey: ['task-statuses', id],
    queryFn: () => api.get<{ data: TaskStatus[] }>(`/projects/${id}/task-statuses`).then((r) => r.data),
  });
  const usersQ = useQuery<UserLite[]>({
    queryKey: ['users', 'lookup'],
    queryFn: () => api.get<{ data: UserLite[] }>('/users/lookup').then((r) => r.data),
    staleTime: 5 * 60_000,
  });

  const statuses = (statusesQ.data ?? []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const project = projectQ.data;
  const users = usersQ.data ?? [];

  usePageTitle(project ? `${project.key} · ${project.name}` : null);

  const openTask = (tid: string) => navigate(`/projects/${id}/tasks/${tid}`);

  const patchProject = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/projects/${id}`, { ...body, version: project?.version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['project-audit', id] });
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.status === 409 || e.code === 'conflict')) {
        qc.invalidateQueries({ queryKey: ['project', id] });
        toast.error(t('projects.conflict'));
      } else {
        toast.error(e instanceof ApiError ? e.message : t('common.saveFailed'));
      }
    },
  });

  return (
    <div className="page-enter flex h-full flex-col">
      <ProjectHeader
        project={project}
        loading={projectQ.isLoading}
        canWrite={canWrite}
        canDelete={canDelete}
        tab={tab}
        onTab={setTab}
        onDeleted={() => navigate('/projects')}
        onPatch={(b) => patchProject.mutate(b)}
      />

      <div className="flex-1 overflow-auto">
        {tab === 'overview' && (
          <OverviewTab
            id={id}
            project={project}
            users={users}
            canWrite={canWrite}
            isAdmin={isAdmin}
            onPatch={(b) => patchProject.mutate(b)}
            onManageMembers={() => setTab('settings')}
          />
        )}
        {tab === 'tasks' && <TasksTab id={id} statuses={statuses} statusesLoading={statusesQ.isLoading} projectKey={project?.key} users={users} onOpen={openTask} />}
        {tab === 'cycles' && <CyclesTab id={id} />}
        {tab === 'settings' && <SettingsTab project={project} isAdmin={isAdmin} onPatch={(b) => patchProject.mutate(b)} pending={patchProject.isPending} />}
      </div>
    </div>
  );
}

/* ───────────────────────── Header ───────────────────────── */

function ProjectHeader({ project, loading, canWrite, canDelete, tab, onTab, onDeleted, onPatch }: {
  project?: Project; loading: boolean; canWrite: boolean; canDelete: boolean;
  tab: Tab; onTab: (t: Tab) => void; onDeleted: () => void;
  onPatch: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  if (loading || !project) {
    return (
      <div className="border-b border-border px-6 pb-2.5 pt-3">
        <Skeleton className="mb-2 h-3 w-40" />
        <div className="flex items-center gap-2.5">
          <Skeleton className="h-[26px] w-[26px] rounded-md" />
          <Skeleton className="h-6 w-56" />
        </div>
        <div className="mt-2.5 flex gap-4">
          <Skeleton className="h-4 w-16" /><Skeleton className="h-4 w-12" /><Skeleton className="h-4 w-14" />
        </div>
      </div>
    );
  }

  const commitName = () => {
    setEditingName(false);
    const v = nameDraft.trim();
    if (v && v !== project.name) onPatch({ name: v });
  };

  const sections: { key: Tab; label: string; icon: ReactNode }[] = [
    { key: 'overview', label: t('projects.overview'), icon: <LayoutDashboard size={14} /> },
    { key: 'tasks', label: t('common.tasks'), icon: <ListChecks size={14} /> },
    { key: 'cycles', label: t('projects.cycles'), icon: <Repeat size={14} /> },
  ];

  return (
    <ProjectContextMenu
      project={{ id: project.id, name: project.name, key: project.key, status: project.status, version: project.version }}
      canWrite={canWrite}
      canDelete={canDelete}
      onDeleted={onDeleted}
      className="block border-b border-border"
    >
      {/* One slim bar: parent trail + identity on the left, section switcher on
          the right. The name lives here only – no title echo below. */}
      <div className="flex h-11 min-w-0 items-center gap-2 px-4">
        <Link
          to="/projects"
          className="hidden shrink-0 text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground sm:block"
        >
          {t('nav.projects')}
        </Link>
        <ChevronRight size={12} className="hidden shrink-0 text-faint sm:block" aria-hidden />

        <ProjectIcon seed={project.key || project.id} size={20} radius={6} />
        {editingName ? (
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => { if (e.key === 'Enter') commitName(); if (e.key === 'Escape') setEditingName(false); }}
            className="min-w-0 flex-1 rounded-md border border-primary/60 bg-transparent px-1.5 py-0.5 text-[15px] font-semibold outline-none focus:ring-2 focus:ring-ring/25"
          />
        ) : (
          <h1
            onClick={() => { if (canWrite) { setNameDraft(project.name); setEditingName(true); } }}
            className={cn('-ml-1 min-w-0 truncate rounded-md px-1 py-0.5 text-[15px] font-semibold leading-tight',
              canWrite && 'cursor-text hover:bg-muted')}
          >
            {project.name}
          </h1>
        )}
        <span className="shrink-0 font-mono text-[11px] text-faint">{project.key}</span>

        <nav className="ml-auto flex shrink-0 items-center gap-0.5">
          {sections.map((s) => (
            <button
              key={s.key}
              onClick={() => onTab(s.key)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] transition-colors duration-150',
                tab === s.key
                  ? 'bg-muted font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <span className={cn('[&>svg]:block', tab === s.key ? 'text-foreground' : 'text-faint')}>{s.icon}</span>
              <span className="hidden md:block">{s.label}</span>
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <IconButton
            size="sm"
            aria-label={t('nav.settings')}
            onClick={() => onTab('settings')}
            className={cn(tab === 'settings' && 'bg-muted text-foreground')}
          >
            <Settings size={16} />
          </IconButton>
        </nav>
      </div>
    </ProjectContextMenu>
  );
}

/* ───────────────────────── Tasks tab ───────────────────────── */

function refLabel(t: Task, projectKey?: string): string {
  if (t.ref) return t.ref;
  if (t.number == null) return '';
  return projectKey ? `${projectKey}-${t.number}` : `#${t.number}`;
}

interface ChildStats { total: number; done: number }

/** A rendered list/board group: header identity + its (ordered) tasks + quick-add payload. */
interface TaskGroup {
  key: string;
  label: string;
  icon: ReactNode;
  items: Task[];
  /** Extra POST /tasks fields so quick-add lands in this group. */
  seed: Record<string, unknown>;
}

function buildGroups(
  grouping: Grouping, tasks: Task[], statuses: TaskStatus[], users: UserLite[], labels: LabelLite[],
  t: (k: string) => string,
): TaskGroup[] {
  switch (grouping) {
    case 'status':
      return statuses.map((s) => ({
        key: `status:${s.id}`, label: s.name,
        icon: <StatusIcon category={s.category} color={s.color} size={14} />,
        items: tasks.filter((x) => x.statusId === s.id),
        seed: { statusId: s.id },
      }));
    case 'priority':
      return PRIORITIES.map((p) => ({
        key: `priority:${p}`, label: t(PRIORITY_LABEL_KEY[p]!),
        icon: <PriorityIcon priority={p} size={14} />,
        items: tasks.filter((x) => (x.priority ?? 'none') === p),
        seed: { priority: p },
      }));
    case 'assignee': {
      const groups: TaskGroup[] = users.map((u) => ({
        key: `assignee:${u.id}`, label: u.name,
        icon: <Avatar name={u.name} src={u.avatar} size={16} />,
        items: tasks.filter((x) => (x.assigneeIds ?? []).includes(u.id)),
        seed: { assigneeIds: [u.id] },
      }));
      groups.push({
        key: 'assignee:none', label: t('tasksview.noAssignee'),
        icon: <StatusIcon category="backlog" size={14} />,
        items: tasks.filter((x) => !(x.assigneeIds ?? []).length),
        seed: {},
      });
      return groups;
    }
    case 'label': {
      const groups: TaskGroup[] = labels.map((l) => ({
        key: `label:${l.id}`, label: l.name,
        icon: <span className="block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: l.color ?? '#8a8f98' }} />,
        items: tasks.filter((x) => (x.labelIds ?? []).includes(l.id)),
        seed: { labelIds: [l.id] },
      }));
      groups.push({
        key: 'label:none', label: t('tasksview.noLabel'),
        icon: <StatusIcon category="backlog" size={14} />,
        items: tasks.filter((x) => !(x.labelIds ?? []).length),
        seed: {},
      });
      return groups;
    }
    default:
      return [{ key: 'all', label: t('common.tasks'), icon: null, items: tasks, seed: {} }];
  }
}

function TasksTab({ id, statuses, statusesLoading, projectKey, users, onOpen }: {
  id: string; statuses: TaskStatus[]; statusesLoading: boolean; projectKey?: string; users: UserLite[]; onOpen: (tid: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const canWrite = can('projects.write') || can('projects.create');

  const [prefs, setPrefsState] = useState<TaskViewPrefs>(() => loadPrefs(id));
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS);
  useEffect(() => { setPrefsState(loadPrefs(id)); setFilters(EMPTY_FILTERS); }, [id]);
  const updatePrefs = (patch: Partial<TaskViewPrefs>) =>
    setPrefsState((p) => { const next = { ...p, ...patch }; savePrefs(id, next); return next; });

  const tasksQ = useQuery<Task[]>({ queryKey: ['tasks', id], queryFn: () => api.get<{ data: Task[] }>(`/tasks${qs({ projectId: id })}`).then((r) => r.data) });
  const allTasks = useMemo(() => tasksQ.data ?? [], [tasksQ.data]);
  // Same key + shape as the task page, so the cache is shared.
  const labelsQ = useQuery<LabelLite[]>({
    queryKey: ['labels'],
    queryFn: () => api.get<{ data: LabelLite[] }>('/labels').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
  const labels = useMemo(() => labelsQ.data ?? [], [labelsQ.data]);

  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);
  const labelById = useMemo(() => new Map(labels.map((l) => [l.id, l])), [labels]);
  const taskById = useMemo(() => new Map(allTasks.map((x) => [x.id, x])), [allTasks]);
  const userById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const resolveUsers = (ids?: string[]) => (ids ?? []).map((uid) => userById.get(uid) ?? { id: uid, name: '?' });

  /** Sub-task counters per parent, from the unfiltered list. */
  const childStats = useMemo(() => {
    const m = new Map<string, ChildStats>();
    for (const x of allTasks) {
      if (!x.parentId) continue;
      const st = m.get(x.parentId) ?? { total: 0, done: 0 };
      st.total += 1;
      if (statusById.get(x.statusId)?.category === 'done') st.done += 1;
      m.set(x.parentId, st);
    }
    return m;
  }, [allTasks, statusById]);

  const visibleTasks = useMemo(() => {
    let list = applyFilters(allTasks, filters, (sid) => statusById.get(sid)?.category);
    if (!prefs.showSubtasks) list = list.filter((x) => !x.parentId);
    return list;
  }, [allTasks, filters, prefs.showSubtasks, statusById]);

  const addTask = useMutation({
    mutationFn: (vars: { title: string; seed?: Record<string, unknown> }) =>
      api.post('/tasks', { projectId: id, title: vars.title, ...(vars.seed ?? {}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', id] }),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('tasks.createFailed')),
  });

  const move = useMutation({
    mutationFn: (vars: { taskId: string; statusId: string; version?: number }) =>
      api.patch(`/tasks/${vars.taskId}`, { statusId: vars.statusId, version: vars.version }),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ['tasks', id] });
      const prev = qc.getQueryData<Task[]>(['tasks', id]);
      qc.setQueryData<Task[]>(['tasks', id], (old) => (old ?? []).map((x) => x.id === vars.taskId ? { ...x, statusId: vars.statusId } : x));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['tasks', id], ctx.prev);
      toast.error(e instanceof ApiError ? e.message : t('common.saveFailed'));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['tasks', id] }),
  });

  const groups = useMemo(() => {
    const grouping = prefs.view === 'board' ? 'status' : prefs.grouping;
    return buildGroups(grouping, visibleTasks, statuses, users, labels, t)
      .map((g) => ({ ...g, items: orderTasks(g.items, prefs.ordering) }))
      .filter((g) => g.items.length > 0 || (prefs.showEmptyGroups && canWrite) || g.key === 'all');
  }, [prefs.view, prefs.grouping, prefs.ordering, prefs.showEmptyGroups, visibleTasks, statuses, users, labels, canWrite, t]);

  const loading = statusesLoading || tasksQ.isLoading;
  const { view } = prefs;
  const filtered = allTasks.length > 0 && visibleTasks.length === 0;

  return (
    <div className="flex min-h-full flex-col">
      <TasksToolbar
        projectId={id}
        prefs={prefs}
        onPrefs={updatePrefs}
        filters={filters}
        onFilters={setFilters}
        statuses={statuses}
        labels={labels}
        users={users}
      />

      {loading ? (
        <div className="space-y-px pt-2">
          {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="mx-4 h-8" />)}
        </div>
      ) : statuses.length === 0 ? (
        <EmptyState icon={<ListChecks size={20} />} title={t('projects.noWorkflow')} hint={t('projects.noWorkflowHint')} />
      ) : filtered ? (
        <EmptyState
          icon={<ListChecks size={20} />}
          title={t('tasksview.noMatches')}
          hint={t('tasksview.noMatchesHint')}
          action={<Button size="sm" variant="outline" onClick={() => setFilters(EMPTY_FILTERS)}>{t('tasksview.clearFilters')}</Button>}
        />
      ) : allTasks.length === 0 && (!canWrite || view === 'calendar' || view === 'timeline') ? (
        // Writers see the list/board with inline "+ add" rows instead of a dead end.
        <EmptyState
          icon={<ListChecks size={20} />}
          title={t('projects.noTasks')}
          hint={canWrite ? t('projects.noTasksHint') : undefined}
        />
      ) : view === 'list' ? (
        <ListView
          projectId={id} projectKey={projectKey} statuses={statuses} groups={groups} prefs={prefs}
          canWrite={canWrite} resolveUsers={resolveUsers} labelById={labelById} childStats={childStats} taskById={taskById}
          onOpen={onOpen}
          onToggleCollapse={(key) => updatePrefs({
            collapsed: prefs.collapsed.includes(key) ? prefs.collapsed.filter((k) => k !== key) : [...prefs.collapsed, key],
          })}
          onAdd={(title, seed) => addTask.mutate({ title, seed })}
        />
      ) : view === 'board' ? (
        <div className="min-w-0 flex-1 px-4 py-3">
          <BoardView
            projectId={id} projectKey={projectKey} statuses={statuses} groups={groups} prefs={prefs}
            canWrite={canWrite} resolveUsers={resolveUsers} labelById={labelById} childStats={childStats}
            onOpen={onOpen}
            onAdd={(title, seed) => addTask.mutate({ title, seed })}
            onMove={(taskId, statusId, version) => move.mutate({ taskId, statusId, version })}
          />
        </div>
      ) : (
        <PageBody width="full">
          {view === 'calendar' ? (
            <CalendarView tasks={visibleTasks} projectKey={projectKey} onOpenTask={onOpen} />
          ) : view === 'timeline' ? (
            <TimelineView tasks={visibleTasks} statuses={statuses} onOpenTask={onOpen} />
          ) : (
            <SpreadsheetView tasks={visibleTasks} statuses={statuses} projectId={id} onOpenTask={onOpen} />
          )}
        </PageBody>
      )}
    </div>
  );
}

function QuickAdd({ seed, onAdd, placeholder, variant = 'row', inputRef, onDismiss }: {
  seed?: Record<string, unknown>; onAdd: (title: string, seed?: Record<string, unknown>) => void;
  placeholder: string; variant?: 'row' | 'card'; inputRef?: (el: HTMLInputElement | null) => void;
  /** Called on Escape or on blur with an empty draft – lets the list hide the row again. */
  onDismiss?: () => void;
}) {
  const [title, setTitle] = useState('');
  return (
    <form
      onSubmit={(e: FormEvent) => { e.preventDefault(); const v = title.trim(); if (!v) return; onAdd(v, seed); setTitle(''); }}
      className={cn('flex items-center gap-2.5', variant === 'row' ? 'h-9 px-4' : 'px-2 py-1.5')}
    >
      <Plus size={13} className="shrink-0 text-faint" />
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape' && onDismiss) { e.stopPropagation(); setTitle(''); onDismiss(); } }}
        onBlur={() => { if (!title.trim()) onDismiss?.(); }}
        placeholder={placeholder}
        className="h-6 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
      />
    </form>
  );
}

/* ---- Shared row fragments (List + Board) ---- */

function labelChips(task: Task, labelById: Map<string, LabelLite>, max = 2): ReactNode {
  const ls = (task.labelIds ?? []).map((lid) => labelById.get(lid)).filter((l): l is LabelLite => !!l);
  if (ls.length === 0) return null;
  const shown = ls.slice(0, max);
  return (
    <span className="hidden items-center gap-1 md:flex">
      {shown.map((l) => (
        <span key={l.id} className="inline-flex h-[18px] items-center gap-1 rounded-full border border-border px-1.5 text-[11px] text-muted-foreground">
          <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color ?? '#8a8f98' }} />
          {l.name}
        </span>
      ))}
      {ls.length > max && <span className="text-[11px] tabular-nums text-faint">+{ls.length - max}</span>}
    </span>
  );
}

function ProgressPill({ stats }: { stats: ChildStats }) {
  return (
    <span className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border border-border px-1.5 text-[11px] tabular-nums text-muted-foreground">
      <ProgressRing value={stats.total ? (stats.done / stats.total) * 100 : 0} size={11} stroke={2} />
      {stats.done}/{stats.total}
    </span>
  );
}

/* ---- List view (grouped, Linear-density rows) ---- */

function ListView({ projectId, projectKey, statuses, groups, prefs, canWrite, resolveUsers, labelById, childStats, taskById, onOpen, onToggleCollapse, onAdd }: {
  projectId: string; projectKey?: string; statuses: TaskStatus[]; groups: TaskGroup[]; prefs: TaskViewPrefs;
  canWrite: boolean; resolveUsers: (ids?: string[]) => UserLite[];
  labelById: Map<string, LabelLite>; childStats: Map<string, ChildStats>; taskById: Map<string, Task>;
  onOpen: (tid: string) => void; onToggleCollapse: (key: string) => void;
  onAdd: (title: string, seed?: Record<string, unknown>) => void;
}) {
  const t = useT();
  const inputs = useRef(new Map<string, HTMLInputElement | null>());
  // Linear keeps rows quiet: non-empty groups show the add-row only after "+".
  const [adding, setAdding] = useState<string[]>([]);
  const { props } = prefs;

  const openQuickAdd = (key: string) => {
    setAdding((a) => (a.includes(key) ? a : [...a, key]));
    setTimeout(() => inputs.current.get(key)?.focus(), 30);
  };

  return (
    <div className="flex-1 pb-10">
      {groups.map((g) => {
        const collapsed = prefs.collapsed.includes(g.key);
        const flat = g.key === 'all';
        const quickAddVisible = canWrite && (g.items.length === 0 || flat || adding.includes(g.key));
        return (
          <section key={g.key}>
            {!flat && (
              <div className="group/hd flex h-8 items-center gap-2 bg-muted/40 pl-4 pr-2.5">
                <button
                  type="button"
                  onClick={() => onToggleCollapse(g.key)}
                  aria-expanded={!collapsed}
                  aria-label={t('tasksview.collapse')}
                  className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className="shrink-0 [&>svg]:block">{g.icon}</span>
                  <span className="truncate text-[13px] font-medium">{g.label}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{g.items.length}</span>
                  <ChevronRight
                    size={12}
                    className={cn(
                      'shrink-0 text-faint transition-all duration-150',
                      collapsed ? 'opacity-100' : 'rotate-90 opacity-0 group-hover/hd:opacity-100',
                    )}
                  />
                </button>
                {canWrite && (
                  <IconButton
                    size="sm"
                    aria-label={t('tasksview.addTask')}
                    className="opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/hd:opacity-100"
                    onClick={() => {
                      if (collapsed) onToggleCollapse(g.key);
                      openQuickAdd(g.key);
                    }}
                  >
                    <Plus size={14} />
                  </IconButton>
                )}
              </div>
            )}
            {(!collapsed || flat) && (
              <div>
                {g.items.map((task, i) => {
                  const st = statuses.find((s) => s.id === task.statusId);
                  const assignees = resolveUsers(task.assigneeIds);
                  const overdue = isOverdue(task.dueDate, st?.category);
                  const parent = task.parentId ? taskById.get(task.parentId) : undefined;
                  const stats = childStats.get(task.id);
                  const ref = refLabel(task, projectKey);
                  return (
                    <TaskContextMenu
                      key={task.id}
                      task={task}
                      projectId={projectId}
                      projectKey={projectKey}
                      statuses={statuses}
                      canWrite={canWrite}
                    >
                      <button
                        onClick={() => onOpen(task.id)}
                        className={cn(
                          'row-enter flex h-9 w-full items-center gap-2.5 px-4 text-left transition-colors duration-150 hover:bg-muted/50',
                          (i > 0 || flat) && 'border-t border-border/60',
                        )}
                        style={{ ['--i' as string]: Math.min(i, 10) }}
                      >
                        {props.priority && <PriorityIcon priority={task.priority} size={15} />}
                        {props.id && ref && (
                          <span className="hidden w-16 shrink-0 truncate font-mono text-[11px] text-faint sm:block">{ref}</span>
                        )}
                        {props.status && <StatusIcon category={st?.category} color={st?.color} size={14} />}
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium">{task.title}</span>
                          {parent && (
                            <span className="hidden min-w-0 max-w-44 truncate text-xs text-faint lg:block">› {parent.title}</span>
                          )}
                          {props.progress && stats && <ProgressPill stats={stats} />}
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-2">
                          {props.labels && labelChips(task, labelById)}
                          {props.dueDate && task.dueDate && (
                            <span className={cn('text-xs tabular-nums', overdue ? 'text-destructive' : 'text-muted-foreground')}>
                              {fmtDate(task.dueDate)}
                            </span>
                          )}
                          {props.assignee && assignees.length > 0 && <AvatarGroup users={assignees} size={20} max={3} />}
                        </span>
                      </button>
                    </TaskContextMenu>
                  );
                })}
                {quickAddVisible && (
                  <div className={cn((g.items.length > 0 || flat) && 'border-t border-border/60')}>
                    <QuickAdd
                      seed={g.seed}
                      onAdd={onAdd}
                      placeholder={t('projects.newTaskInline')}
                      inputRef={(el) => inputs.current.set(g.key, el)}
                      onDismiss={g.items.length > 0 && !flat ? () => setAdding((a) => a.filter((k) => k !== g.key)) : undefined}
                    />
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/* ---- Board view (drag & drop, status columns) ---- */

function BoardView({ projectId, projectKey, statuses, groups, prefs, canWrite, resolveUsers, labelById, childStats, onOpen, onAdd, onMove }: {
  projectId: string; projectKey?: string; statuses: TaskStatus[]; groups: TaskGroup[]; prefs: TaskViewPrefs;
  canWrite: boolean; resolveUsers: (ids?: string[]) => UserLite[];
  labelById: Map<string, LabelLite>; childStats: Map<string, ChildStats>;
  onOpen: (tid: string) => void;
  onAdd: (title: string, seed?: Record<string, unknown>) => void;
  onMove: (taskId: string, statusId: string, version?: number) => void;
}) {
  const t = useT();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);
  const { props } = prefs;
  const allItems = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {groups.map((g) => {
        const s = statuses.find((x) => `status:${x.id}` === g.key);
        if (!s) return null;
        const items = g.items;
        const isOver = overCol === s.id;
        return (
          <div
            key={s.id}
            onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverCol(s.id); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverCol((c) => (c === s.id ? null : c)); }}
            onDrop={(e) => {
              e.preventDefault();
              const taskId = e.dataTransfer.getData('text/task-id') || dragId;
              setOverCol(null); setDragId(null);
              if (!taskId) return;
              const src = allItems.find((x) => x.id === taskId);
              if (src && src.statusId !== s.id) onMove(taskId, s.id, src.version);
            }}
            className={cn(
              'flex w-72 shrink-0 flex-col rounded-xl border transition-colors duration-150',
              isOver ? 'border-primary/50 bg-primary/5' : 'border-border bg-muted/25',
            )}
          >
            <div className="flex items-center justify-between px-3 py-2.5">
              <span className="flex items-center gap-2 text-[13px] font-semibold">
                <StatusIcon category={s.category} color={s.color} size={14} />
                {s.name}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">{items.length}</span>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto px-2 pb-2">
              {items.map((task) => {
                const assignees = resolveUsers(task.assigneeIds);
                const overdue = isOverdue(task.dueDate, s.category);
                const stats = childStats.get(task.id);
                const ref = refLabel(task, projectKey);
                return (
                  <TaskContextMenu
                    key={task.id}
                    task={task}
                    projectId={projectId}
                    projectKey={projectKey}
                    statuses={statuses}
                    canWrite={canWrite}
                    className="block"
                  >
                    <div
                      draggable={canWrite}
                      onDragStart={(e) => { setDragId(task.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/task-id', task.id); }}
                      onDragEnd={() => { setDragId(null); setOverCol(null); }}
                      onClick={() => onOpen(task.id)}
                      className={cn(
                        'cursor-pointer rounded-lg border border-border bg-card p-2.5 text-left shadow-sm transition-all duration-150 hover:border-border-strong',
                        canWrite && 'active:cursor-grabbing',
                        dragId === task.id && 'opacity-40',
                      )}
                    >
                      <div className="flex items-start gap-1.5">
                        {props.priority && <span className="mt-0.5"><PriorityIcon priority={task.priority} size={14} /></span>}
                        <span className="flex-1 text-[13px] font-medium leading-snug">{task.title}</span>
                        {props.progress && stats && <ProgressPill stats={stats} />}
                      </div>
                      {props.labels && (task.labelIds ?? []).length > 0 && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1">{labelChips(task, labelById, 3)}</div>
                      )}
                      <div className="mt-2 flex items-center gap-2">
                        {props.id && ref && (
                          <span className="font-mono text-[11px] text-muted-foreground">{ref}</span>
                        )}
                        {props.dueDate && task.dueDate && (
                          <span className={cn('text-[11px] tabular-nums', overdue ? 'text-destructive' : 'text-muted-foreground')}>{fmtDate(task.dueDate)}</span>
                        )}
                        {props.assignee && assignees.length > 0 && <span className="ml-auto"><AvatarGroup users={assignees} size={18} max={3} /></span>}
                      </div>
                    </div>
                  </TaskContextMenu>
                );
              })}
              {canWrite && (
                <div className="rounded-lg border border-dashed border-border">
                  <QuickAdd seed={g.seed} onAdd={onAdd} placeholder={t('projects.newTaskInline')} variant="card" />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ───────────────────────── Overview tab ───────────────────────── */

/** description column is text: parse stored tiptap JSON, wrap legacy plain text. */
function parseProjectDoc(raw: unknown): unknown {
  if (!raw) return EMPTY_DOC;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* legacy plain text */ }
    return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: raw }] }] };
  }
  return EMPTY_DOC;
}

/** Borderless one-line summary under the header, Linear-style. */
function SummaryInput({ project, canWrite, onPatch }: {
  project: Project; canWrite: boolean; onPatch: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(project.summary ?? '');
  useEffect(() => { setDraft(project.summary ?? ''); }, [project.id, project.summary]);
  const commit = () => {
    const v = draft.trim();
    if (v !== (project.summary ?? '')) onPatch({ summary: v });
  };
  if (!canWrite) {
    return project.summary
      ? <p className="text-[15px] text-muted-foreground">{project.summary}</p>
      : null;
  }
  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { setDraft(project.summary ?? ''); (e.target as HTMLInputElement).blur(); } }}
      placeholder={t('projects.summaryPh')}
      className="w-full bg-transparent text-[15px] text-foreground outline-none placeholder:text-faint"
    />
  );
}

function OverviewTab({ id, project, users, canWrite, isAdmin, onPatch, onManageMembers }: {
  id: string; project?: Project; users: UserLite[]; canWrite: boolean; isAdmin: boolean;
  onPatch: (body: Record<string, unknown>) => void;
  onManageMembers: () => void;
}) {
  const t = useT();

  // Debounced description editor. The API stores the description as a string
  // column, so the tiptap doc travels JSON-serialized (legacy plain text is
  // wrapped into a paragraph).
  const [doc, setDoc] = useState<unknown>(EMPTY_DOC);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    setDoc(parseProjectDoc(project?.description));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onDescChange = (next: unknown) => {
    setDoc(next);
    if (!canWrite) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { onPatch({ description: JSON.stringify(next) }); }, 900);
  };

  return (
    <PageBody width="wide" className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_280px]">
      {/* Left: summary, resources, updates, description, milestones, activity */}
      <div className="order-2 min-w-0 space-y-7 lg:order-1">
        {project ? (
          <>
            <div className="space-y-3">
              <SummaryInput project={project} canWrite={canWrite} onPatch={onPatch} />
              <ProjectResources
                links={(project.links ?? []) as ProjectLink[]}
                canWrite={canWrite}
                onChange={(next) => onPatch({ links: next })}
              />
            </div>

            <ProjectUpdates projectId={id} canWrite={canWrite} isAdmin={isAdmin} />

            <section>
              <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('projects.description')}</h2>
              <RichEditor key={project.id} value={doc} onChange={onDescChange} editable={canWrite} placeholder={t('projects.aboutPlaceholder')} />
            </section>

            <ProjectMilestones projectId={id} canWrite={canWrite} />

            <ProjectActivity projectId={id} users={users} />
          </>
        ) : (
          <div className="space-y-4">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-16" />
            <Skeleton className="h-40" />
          </div>
        )}
      </div>

      {/* Right: properties rail (single source for project metadata) */}
      <div className="order-1 lg:order-2">
        {project ? (
          <PropertiesRail
            project={project}
            users={users}
            canWrite={canWrite}
            onPatch={onPatch}
            onManageMembers={onManageMembers}
          />
        ) : (
          <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>
        )}
      </div>
    </PageBody>
  );
}

/* ───────────────────────── Cycles tab ───────────────────────── */

function cyclePercent(c: Cycle): number | null {
  if (typeof c.progress === 'number') return Math.max(0, Math.min(100, c.progress));
  if (typeof c.completedCount === 'number' && typeof c.totalCount === 'number' && c.totalCount > 0) {
    return Math.round((c.completedCount / c.totalCount) * 100);
  }
  return null;
}

function CyclesTab({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const canWrite = can('projects.write') || can('projects.create');
  const { data, isLoading } = useQuery<Cycle[]>({ queryKey: ['cycles', id], queryFn: () => api.get<{ data: Cycle[] }>(`/projects/${id}/cycles`).then((r) => r.data) });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [goal, setGoal] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => { setName(''); setStart(''); setEnd(''); setGoal(''); setError(null); };
  // Prefill a sensible two-week window when the dialog opens.
  useEffect(() => {
    if (!adding) return;
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    setStart((s) => s || iso(new Date()));
    setEnd((s) => s || iso(new Date(Date.now() + 13 * 86_400_000)));
  }, [adding]);
  const mut = useMutation({
    mutationFn: () => api.post('/cycles', { projectId: id, name, startDate: start || undefined, endDate: end || undefined, goal: goal || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cycles', id] }); setAdding(false); reset(); },
    onError: (e) => { setError(e instanceof ApiError ? e.message : t('projects.createCycleFailed')); },
  });

  const cycles = data ?? [];

  return (
    <PageBody width="wide">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">{t('projects.cycles')}</h2>
        {canWrite && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus size={14} /> {t('projects.newCycle')}</Button>}
      </div>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : cycles.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-16">
          <EmptyState icon={<CalendarClock size={20} />} title={t('projects.noCycles')} hint={t('projects.noCyclesHint')}
            action={canWrite ? <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus size={14} /> {t('projects.newCycle')}</Button> : undefined} />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cycles.map((c) => {
            const pct = cyclePercent(c);
            return (
              <Card key={c.id} className="p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-medium">{c.name}</span>
                  {c.status && <Badge className="bg-muted capitalize text-muted-foreground">{c.status}</Badge>}
                </div>
                <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CalendarDays size={12} className="text-faint" />
                  {fmtDate(c.startDate)} – {fmtDate(c.endDate)}
                </p>
                {c.goal && <p className="mt-1.5 line-clamp-2 text-[13px] text-muted-foreground">{c.goal}</p>}
                {pct != null && (
                  <div className="mt-3">
                    <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                      <span>{t('projects.progress')}</span>
                      <span className="tabular-nums">
                        {c.completedCount != null && c.totalCount != null ? `${c.completedCount}/${c.totalCount} · ` : ''}{pct}%
                      </span>
                    </div>
                    <ProgressBar value={pct} />
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={adding} onClose={() => { setAdding(false); reset(); }} title={t('projects.newCycle')} width={440}>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setError(null);
            if (!name.trim()) { setError(t('common.nameRequired')); return; }
            if (!start || !end) { setError(t('projects.cycleDatesRequired')); return; }
            if (end < start) { setError(t('projects.cycleDatesOrder')); return; }
            mut.mutate();
          }}
          className="space-y-3 px-4 pb-4 pt-1"
        >
          <Input autoFocus placeholder={t('projects.cycleNamePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1"><label className="text-xs text-muted-foreground">{t('projects.start')}</label><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
            <div className="space-y-1"><label className="text-xs text-muted-foreground">{t('projects.end')}</label><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
          </div>
          <Input placeholder={t('projects.goalPlaceholder')} value={goal} onChange={(e) => setGoal(e.target.value)} />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" size="sm" variant="ghost" onClick={() => { setAdding(false); reset(); }}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={mut.isPending}>{mut.isPending ? <Spinner /> : t('common.create')}</Button>
          </div>
        </form>
      </Dialog>
    </PageBody>
  );
}

/* ───────────────────────── Settings tab ───────────────────────── */

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{label}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </div>
      <div className="w-64 shrink-0">{children}</div>
    </div>
  );
}

function SettingsTab({ project, isAdmin, onPatch, pending }: {
  project?: Project; isAdmin: boolean; onPatch: (body: Record<string, unknown>) => void; pending: boolean;
}) {
  const t = useT();
  const can = useCan();
  const canManageIntegrations = can('integrations.manage');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (project) setName(project.name ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  if (!project) return <PageBody><Skeleton className="h-40" /></PageBody>;

  const saveName = () => {
    setError(null);
    if (!name.trim()) { setError(t('common.nameRequired')); return; }
    if (name.trim() !== project.name) onPatch({ name: name.trim() });
  };

  return (
    <PageBody className="space-y-8">
      {/* General */}
      <section>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('projects.general')}</h2>
        <div className="divide-y divide-border rounded-lg border border-border bg-card px-4">
          <SettingRow label={t('common.name')}>
            <div className="flex gap-2">
              <Input value={name} disabled={!isAdmin} onChange={(e) => setName(e.target.value)} onBlur={saveName}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
            </div>
          </SettingRow>
          <SettingRow label={t('projects.key')} hint={t('projects.keyImmutable')}>
            <Input value={project.key} disabled className="font-mono" />
          </SettingRow>
          <SettingRow label={t('common.status')}>
            <div className="flex flex-wrap gap-1.5">
              {PROJECT_STATUSES.map((s) => (
                <button key={s} disabled={!isAdmin} onClick={() => { if (s !== project.status) onPatch({ status: s }); }}
                  className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                    project.status === s ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border bg-card text-muted-foreground hover:bg-muted',
                    !isAdmin && 'pointer-events-none opacity-60')}>
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: STATUS_META[s]!.color }} />
                  {t(STATUS_META[s]!.key)}
                </button>
              ))}
            </div>
          </SettingRow>
        </div>
        {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
        {!isAdmin && <p className="mt-2 text-xs text-muted-foreground">{t('projects.adminRightsHint')}</p>}
        {pending && <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Spinner className="h-3 w-3" /> {t('common.loading')}</p>}
      </section>

      {/* Access */}
      <section>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('projects.access')}</h2>
        <ProjectAccessPanel projectId={project.id} canManage={isAdmin} />
      </section>

      {/* Integrations */}
      <ProjectIntegrations
        projectId={project.id}
        settings={project.settings}
        version={project.version}
        canManage={canManageIntegrations}
      />
    </PageBody>
  );
}
