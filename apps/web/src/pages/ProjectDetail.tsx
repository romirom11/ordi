import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  List, Columns3, CalendarDays, GanttChart, Table2, Plus,
  LayoutDashboard, ListChecks, Repeat, CalendarClock, Settings, ChevronRight,
} from 'lucide-react';
import { api, qs, ApiError } from '../lib/api';
import { Link, useNavigate, useSearchParams } from '../lib/router';
import { useCan } from '../lib/auth';
import { usePageTitle } from '../lib/tabs';
import {
  Button, IconButton, Input, Card, Badge, Skeleton, EmptyState, Spinner, AvatarGroup,
  StatusIcon, PriorityIcon, ProgressBar, SegmentedControl, PageBody,
  fmtDate, cn,
} from '../components/ui';
import { Dialog, toast } from '../components/overlays';
import { CalendarView } from '../components/views/CalendarView';
import { TimelineView } from '../components/views/TimelineView';
import { SpreadsheetView } from '../components/views/SpreadsheetView';
import { SavedViewsBar, type SavedView } from '../components/views/SavedViewsBar';
import { RichEditor, EMPTY_DOC } from '../components/richtext/RichEditor';
import { ProjectAccessPanel } from '../components/ProjectAccessPanel';
import { ProjectIcon } from '../components/project/ProjectIcon';
import { PropertiesRail } from '../components/project/PropertiesRail';
import { InlineHint } from '../components/project/InlineHint';
import { ProjectIntegrations } from '../components/project/ProjectIntegrations';
import { ProjectContextMenu, TaskContextMenu } from '../components/project/contextMenus';
import { PROJECT_STATUSES, STATUS_META, type UserLite } from '../components/project/pickers';
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
    'projects.conflict': 'This project changed elsewhere — reloaded the latest version.',
    'projects.statusActive': 'Active',
    'projects.statusPaused': 'Paused',
    'projects.statusCompleted': 'Completed',
    'projects.statusArchived': 'Archived',
    'projects.newTaskInline': 'Add task…',
    'projects.noTasks': 'No tasks in this project yet',
    'projects.noTasksHint': 'Create your first task — click + in a status group or press C.',
    'projects.cycleDatesRequired': 'Pick start and end dates for the cycle.',
    'projects.cycleDatesOrder': 'The end date must be after the start date.',
    'projects.aboutPlaceholder': 'Describe this project — goals, scope, context…',
    'projects.overviewEmpty': 'No tasks yet',
    'projects.loadFailed': 'Could not load this project.',
    'projects.properties': 'Properties',
    'projects.overviewHint': 'This is the project page — describe the goals here, and add tasks in the Tasks tab.',
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
    'projects.conflict': 'Проєкт змінено деінде — завантажено найновішу версію.',
    'projects.statusActive': 'Активний',
    'projects.statusPaused': 'Призупинено',
    'projects.statusCompleted': 'Завершено',
    'projects.statusArchived': 'Архів',
    'projects.newTaskInline': 'Додати задачу…',
    'projects.noTasks': 'У цьому проєкті ще немає задач',
    'projects.noTasksHint': 'Створіть першу задачу — натисніть + у групі статусу або C на клавіатурі.',
    'projects.cycleDatesRequired': 'Оберіть дати початку та завершення циклу.',
    'projects.cycleDatesOrder': 'Дата завершення має бути після дати початку.',
    'projects.aboutPlaceholder': 'Опишіть проєкт — цілі, обсяг, контекст…',
    'projects.overviewEmpty': 'Задач поки немає',
    'projects.loadFailed': 'Не вдалося завантажити проєкт.',
    'projects.properties': 'Властивості',
    'projects.overviewHint': 'Це сторінка проєкту: опишіть тут цілі, а задачі додавайте у вкладці Tasks.',
  },
});

interface Project {
  id: string; name: string; key: string; status: string; kind?: string;
  companyId?: string | null; companyName?: string | null; description?: unknown;
  leadId?: string | null; startDate?: string | null; targetDate?: string | null;
  visibility?: string; version?: number; settings?: Record<string, unknown>;
}
interface TaskStatus {
  id: string; name: string; category?: string; color?: string; position?: number; isDefault?: boolean;
}
interface Task {
  id: string; number?: number; ref?: string; title: string; statusId: string; priority?: string;
  dueDate?: string | null; startDate?: string | null; estimate?: number | string | null; version?: number;
  parentId?: string | null; assigneeIds?: string[];
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['project', id] }); qc.invalidateQueries({ queryKey: ['projects'] }); },
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
        {tab === 'overview' && <OverviewTab id={id} statuses={statuses} project={project} users={users} canWrite={canWrite} onPatch={(b) => patchProject.mutate(b)} />}
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
          the right. The name lives here only — no title echo below. */}
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

const TASK_VIEWS = [
  { key: 'list', labelKey: 'tasks.list', icon: List },
  { key: 'board', labelKey: 'tasks.board', icon: Columns3 },
  { key: 'calendar', labelKey: 'tasks.calendar', icon: CalendarDays },
  { key: 'timeline', labelKey: 'tasks.timeline', icon: GanttChart },
  { key: 'spreadsheet', labelKey: 'tasks.spreadsheet', icon: Table2 },
] as const;
type TaskView = typeof TASK_VIEWS[number]['key'];

function isTaskView(v: unknown): v is TaskView {
  return typeof v === 'string' && TASK_VIEWS.some((tv) => tv.key === v);
}

function refLabel(t: Task, projectKey?: string): string {
  if (t.ref) return t.ref;
  if (t.number == null) return '';
  return projectKey ? `${projectKey}-${t.number}` : `#${t.number}`;
}

function TasksTab({ id, statuses, statusesLoading, projectKey, users, onOpen }: {
  id: string; statuses: TaskStatus[]; statusesLoading: boolean; projectKey?: string; users: UserLite[]; onOpen: (tid: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const canWrite = can('projects.write') || can('projects.create');
  const [view, setViewState] = useState<TaskView>(() => {
    try {
      const stored = localStorage.getItem(`ordi:view:${id}`);
      return isTaskView(stored) ? stored : 'list';
    } catch { return 'list'; }
  });
  const setView = (v: TaskView) => {
    setViewState(v);
    try { localStorage.setItem(`ordi:view:${id}`, v); } catch { /* private mode */ }
  };

  const tasksQ = useQuery<Task[]>({ queryKey: ['tasks', id], queryFn: () => api.get<{ data: Task[] }>(`/tasks${qs({ projectId: id })}`).then((r) => r.data) });
  const tasks = tasksQ.data ?? [];

  const userById = useMemo(() => {
    const m = new Map<string, UserLite>();
    for (const u of users) m.set(u.id, u);
    return m;
  }, [users]);
  const resolveUsers = (ids?: string[]) => (ids ?? []).map((uid) => userById.get(uid) ?? { id: uid, name: '?' });

  const addTask = useMutation({
    mutationFn: (vars: { title: string; statusId?: string }) => api.post('/tasks', { projectId: id, title: vars.title, statusId: vars.statusId }),
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

  const byStatus = (sid: string) => tasks.filter((x) => x.statusId === sid);
  const loading = statusesLoading || tasksQ.isLoading;

  return (
    <PageBody width="full">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl
          options={TASK_VIEWS.map((tv) => ({ key: tv.key, label: t(tv.labelKey), icon: <tv.icon size={14} />, title: t(tv.labelKey) }))}
          value={view}
          onChange={(v) => setView(v as TaskView)}
        />
        <SavedViewsBar projectId={id} currentView={view}
          onApply={(v: SavedView) => { if (isTaskView(v.layout)) setView(v.layout); }} />
      </div>

      {loading ? (
        <div className="space-y-2">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-9" />)}</div>
      ) : statuses.length === 0 ? (
        <EmptyState icon={<ListChecks size={20} />} title={t('projects.noWorkflow')} hint={t('projects.noWorkflowHint')} />
      ) : tasks.length === 0 && (!canWrite || view === 'calendar' || view === 'timeline') ? (
        // Writers see the list/board with inline "+ add" rows instead of a dead end.
        <EmptyState
          icon={<ListChecks size={20} />}
          title={t('projects.noTasks')}
          hint={canWrite ? t('projects.noTasksHint') : undefined}
        />
      ) : view === 'list' ? (
        <ListView projectId={id} statuses={statuses} byStatus={byStatus} onOpen={onOpen} canWrite={canWrite} projectKey={projectKey}
          resolveUsers={resolveUsers} onAdd={(title, statusId) => addTask.mutate({ title, statusId })} />
      ) : view === 'board' ? (
        <BoardView projectId={id} statuses={statuses} byStatus={byStatus} onOpen={onOpen} canWrite={canWrite} projectKey={projectKey}
          resolveUsers={resolveUsers} onAdd={(title, statusId) => addTask.mutate({ title, statusId })}
          onMove={(taskId, statusId, version) => move.mutate({ taskId, statusId, version })} />
      ) : view === 'calendar' ? (
        <CalendarView tasks={tasks} projectKey={projectKey} onOpenTask={onOpen} />
      ) : view === 'timeline' ? (
        <TimelineView tasks={tasks} statuses={statuses} onOpenTask={onOpen} />
      ) : (
        <SpreadsheetView tasks={tasks} statuses={statuses} projectId={id} onOpenTask={onOpen} />
      )}
    </PageBody>
  );
}

function QuickAdd({ statusId, onAdd, placeholder, variant = 'row' }: {
  statusId?: string; onAdd: (title: string, statusId?: string) => void; placeholder: string; variant?: 'row' | 'card';
}) {
  const [title, setTitle] = useState('');
  return (
    <form
      onSubmit={(e: FormEvent) => { e.preventDefault(); const v = title.trim(); if (!v) return; onAdd(v, statusId); setTitle(''); }}
      className={cn('flex items-center gap-2', variant === 'row' ? 'px-3 py-1.5' : 'px-2 py-1.5')}
    >
      <Plus size={13} className="shrink-0 text-faint" />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={placeholder}
        className="h-6 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
      />
    </form>
  );
}

/* ---- List view (grouped by status) ---- */

function ListView({ projectId, statuses, byStatus, onOpen, canWrite, projectKey, resolveUsers, onAdd }: {
  projectId: string; statuses: TaskStatus[]; byStatus: (sid: string) => Task[]; onOpen: (tid: string) => void;
  canWrite: boolean; projectKey?: string; resolveUsers: (ids?: string[]) => UserLite[];
  onAdd: (title: string, statusId?: string) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-6">
      {statuses.map((s) => {
        const items = byStatus(s.id);
        if (items.length === 0 && !canWrite) return null;
        return (
          <section key={s.id}>
            <h3 className="mb-1.5 flex items-center gap-2 px-1 text-[13px] font-semibold">
              <StatusIcon category={s.category} color={s.color} size={14} />
              <span>{s.name}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">{items.length}</span>
            </h3>
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              {items.map((task, i) => {
                const assignees = resolveUsers(task.assigneeIds);
                const overdue = isOverdue(task.dueDate, s.category);
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
                      className={cn('row-enter flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-150 hover:bg-muted/60',
                        i > 0 && 'border-t border-border')}
                      style={{ ['--i' as string]: Math.min(i, 10) }}
                    >
                      <PriorityIcon priority={task.priority} size={15} />
                      {refLabel(task, projectKey) && (
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{refLabel(task, projectKey)}</span>
                      )}
                      <span className="flex-1 truncate text-[13px]">{task.title}</span>
                      {task.dueDate && (
                        <span className={cn('shrink-0 text-xs tabular-nums', overdue ? 'text-destructive' : 'text-muted-foreground')}>{fmtDate(task.dueDate)}</span>
                      )}
                      {assignees.length > 0 && <AvatarGroup users={assignees} size={20} max={3} />}
                    </button>
                  </TaskContextMenu>
                );
              })}
              {canWrite && (
                <div className={cn(items.length > 0 && 'border-t border-border')}>
                  <QuickAdd statusId={s.id} onAdd={onAdd} placeholder={t('projects.newTaskInline')} />
                </div>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/* ---- Board view (drag & drop) ---- */

function BoardView({ projectId, statuses, byStatus, onOpen, canWrite, projectKey, resolveUsers, onAdd, onMove }: {
  projectId: string; statuses: TaskStatus[]; byStatus: (sid: string) => Task[]; onOpen: (tid: string) => void;
  canWrite: boolean; projectKey?: string; resolveUsers: (ids?: string[]) => UserLite[];
  onAdd: (title: string, statusId?: string) => void;
  onMove: (taskId: string, statusId: string, version?: number) => void;
}) {
  const t = useT();
  const [dragId, setDragId] = useState<string | null>(null);
  const [overCol, setOverCol] = useState<string | null>(null);

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {statuses.map((s) => {
        const items = byStatus(s.id);
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
              const src = statuses.flatMap((st) => byStatus(st.id)).find((x) => x.id === taskId);
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
                        <span className="mt-0.5"><PriorityIcon priority={task.priority} size={14} /></span>
                        <span className="flex-1 text-[13px] leading-snug">{task.title}</span>
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        {refLabel(task, projectKey) && (
                          <span className="font-mono text-[11px] text-muted-foreground">{refLabel(task, projectKey)}</span>
                        )}
                        {task.dueDate && (
                          <span className={cn('text-[11px] tabular-nums', overdue ? 'text-destructive' : 'text-muted-foreground')}>{fmtDate(task.dueDate)}</span>
                        )}
                        {assignees.length > 0 && <span className="ml-auto"><AvatarGroup users={assignees} size={18} max={3} /></span>}
                      </div>
                    </div>
                  </TaskContextMenu>
                );
              })}
              {canWrite && (
                <div className="rounded-lg border border-dashed border-border">
                  <QuickAdd statusId={s.id} onAdd={onAdd} placeholder={t('projects.newTaskInline')} variant="card" />
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

function OverviewTab({ id, statuses, project, users, canWrite, onPatch }: {
  id: string; statuses: TaskStatus[]; project?: Project; users: UserLite[]; canWrite: boolean;
  onPatch: (body: Record<string, unknown>) => void;
}) {
  const t = useT();
  const { data, isLoading } = useQuery<Task[]>({ queryKey: ['tasks', id], queryFn: () => api.get<{ data: Task[] }>(`/tasks${qs({ projectId: id })}`).then((r) => r.data) });
  const tasks = data ?? [];

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
    <PageBody width="wide" className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_260px]">
      {/* Left: pure document */}
      <div className="order-2 min-w-0 space-y-4 lg:order-1">
        <InlineHint id="project-overview">{t('projects.overviewHint')}</InlineHint>
        {project ? (
          <RichEditor key={project.id} value={doc} onChange={onDescChange} editable={canWrite} placeholder={t('projects.aboutPlaceholder')} />
        ) : (
          <Skeleton className="h-40" />
        )}
      </div>

      {/* Right: properties rail */}
      <div className="order-1 lg:order-2">
        {project ? (
          <PropertiesRail
            project={project}
            statuses={statuses}
            tasks={tasks}
            tasksLoading={isLoading}
            users={users}
            canWrite={canWrite}
            onPatch={onPatch}
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
