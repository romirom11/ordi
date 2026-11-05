import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Ban, CalendarDays, Diamond, Inbox, Plus,
  LayoutDashboard, ListChecks, Milestone as MilestoneIcon, Repeat, Settings, ChevronRight,
} from 'lucide-react';
import { api, qs, getAllPages, ApiError } from '../lib/api';
import { Link, useNavigate, useOpen, useSearchParams, type OpenIntent } from '../lib/router';
import { useCan, useProjectRole } from '../lib/auth';
import { usePageTitle } from '../lib/tabs';
import {
  Button, IconButton, Input, Card, Badge, Skeleton, EmptyState, Spinner, Avatar, AvatarGroup,
  StatusIcon, PriorityIcon, ProgressBar, ProgressRing, PageBody, Reveal,
  fmtDate, cn,
} from '../components/ui';
import { Dialog, ConfirmDialog, DropdownMenu, MenuItem, MenuLabel, toast } from '../components/overlays';
import { BulkBar, RowCheckbox, bulkMessage, runBulk, useSelection } from '../components/bulk';
import { CalendarView } from '../components/views/CalendarView';
import { TimelineView } from '../components/views/TimelineView';
import { SpreadsheetView } from '../components/views/SpreadsheetView';
import { RichEditor, EMPTY_DOC } from '../components/richtext/RichEditor';
import { CustomFieldsSection } from '../components/crm/CustomFieldsSection';
import { ProjectIcon } from '../components/project/ProjectIcon';
import { PropertiesRail } from '../components/project/PropertiesRail';
import { ProjectResources } from '../components/project/ProjectResources';
import { ProjectUpdates } from '../components/project/ProjectUpdates';
import { type Milestone } from '../components/project/ProjectMilestones';
import { ProjectActivity } from '../components/project/ProjectActivity';
import { ProjectDeals } from '../components/project/ProjectDeals';
import { ProjectSettingsPanel, useProjectPatch } from '../components/project/ProjectSettingsPanel';
import { ProjectContextMenu, TaskContextMenu } from '../components/project/contextMenus';
import { ProjectIntakeTab, useIntakeItems } from '../components/project/ProjectIntake';
import { PlanTab, currentCycle, cyclePhase, useCycles } from '../components/project/PlanTab';
import { type UserLite } from '../components/project/pickers';
import { TasksToolbar } from '../components/project/TasksToolbar';
import type { CycleLite, LabelLite } from '../components/project/FilterPopover';
import { useLabels, useTaskStatuses } from '../lib/queries';
import { TaskStatusPicker } from '../components/task/StatusPicker';
import {
  EMPTY_FILTERS, PRIORITIES, PRIORITY_LABEL_KEY, applyFilters, loadPrefs, orderTasks, sanitizeFilters, savePrefs,
  type Grouping, type TaskFilters, type TaskViewPrefs,
} from '../components/project/taskViewPrefs';
import { usePersistedState } from '../lib/prefs';
import { RailResizeHandle, useRailWidth } from '../components/RailResize';
import { useT, extendDict } from '../lib/i18n';
import { DateField } from '../components/DatePicker';

extendDict({
  en: {
    'bulkTasks.status': 'Status',
    'bulkTasks.priority': 'Priority',
    'bulkTasks.deleteTitle': 'Delete tasks',
    'bulkTasks.deleteBody': 'Permanently delete {n} tasks? This cannot be undone.',
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
    'projects.blocked': 'Blocked by another task',
  },
  uk: {
    'bulkTasks.status': 'Статус',
    'bulkTasks.priority': 'Пріоритет',
    'bulkTasks.deleteTitle': 'Видалити задачі',
    'bulkTasks.deleteBody': 'Видалити задачі ({n}) назавжди? Дію не можна скасувати.',
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
    'projects.blocked': 'Заблоковано іншою задачею',
  },
});

interface Project {
  id: string; name: string; key: string; status: string; projectTypeId?: string | null;
  companyId?: string | null; companyName?: string | null; description?: unknown;
  leadId?: string | null; startDate?: string | null; targetDate?: string | null;
  visibility?: 'workspace' | 'private'; version?: number; settings?: Record<string, unknown>;
  summary?: string; priority?: string; labelIds?: string[];
  customFields?: Record<string, unknown>;
  /** Derived by the API: cycles are opt-in per project; intake shows once a channel is on. */
  cyclesEnabled?: boolean; intakeEnabled?: boolean;
}
interface TaskStatus {
  id: string; name: string; category?: string; color?: string; position?: number; isDefault?: boolean;
}
interface Task {
  id: string; number?: number; ref?: string; title: string; statusId: string; priority?: string;
  dueDate?: string | null; startDate?: string | null; estimate?: number | string | null; version?: number;
  parentId?: string | null; milestoneId?: string | null; cycleId?: string | null; assigneeIds?: string[]; labelIds?: string[];
  createdAt?: string; position?: string | number | null; blocked?: boolean;
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

const TABS = ['overview', 'tasks', 'plan', 'intake'] as const;
type Tab = typeof TABS[number];

export function ProjectDetailPage({ id }: { id: string; taskId?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const open = useOpen();
  const params = useSearchParams();
  const qc = useQueryClient();
  const can = useCan();

  // `cycles` was the plan tab's old name; `settings` opens the settings panel
  // over the overview (it used to be a tab of its own).
  const rawSection = params.get('section') ?? '';
  const section = rawSection === 'cycles' ? 'plan' : rawSection;
  const tab: Tab = (TABS as readonly string[]).includes(section) ? (section as Tab) : 'overview';
  const setTab = (next: Tab) => navigate(next === 'overview' ? `/projects/${id}` : `/projects/${id}?section=${next}`);
  const [settingsOpen, setSettingsOpen] = useState(rawSection === 'settings');
  useEffect(() => { if (rawSection === 'settings') setSettingsOpen(true); }, [rawSection]);
  const closeSettings = () => {
    setSettingsOpen(false);
    if (rawSection === 'settings') navigate(`/projects/${id}`);
  };

  const projectQ = useQuery<Project>({ queryKey: ['project', id], queryFn: () => api.get<Project>(`/projects/${id}`) });
  const statusesQ = useTaskStatuses(id);
  const usersQ = useQuery<UserLite[]>({
    queryKey: ['users', 'lookup'],
    queryFn: () => api.get<{ data: UserLite[] }>('/users/lookup').then((r) => r.data),
    staleTime: 5 * 60_000,
  });

  const statuses = (statusesQ.data ?? []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const project = projectQ.data;
  const users = usersQ.data ?? [];

  // What this user may do *here*: a membership row, or what a workspace project
  // grants their role. A plain permission check offered edits the server then
  // refused (and hid them from project admins who hold no global write).
  const role = useProjectRole(id, project?.visibility);
  const canWrite = role === 'admin' || role === 'member';
  const isAdmin = role === 'admin';
  const canDelete = isAdmin && can('projects.delete');

  // Pending intake requests: members triage them, the tab badge says how many wait.
  const intakeQ = useIntakeItems(id, canWrite);
  const intakeCount = intakeQ.data?.length ?? 0;

  usePageTitle(project ? `${project.key} · ${project.name}` : null);

  const openTask = (tid: string, e?: OpenIntent) => open(`/projects/${id}/tasks/${tid}`, e);

  const patchProject = useProjectPatch(id, project?.version);

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
        // Intake earns a tab once it is switched on or something is waiting in it.
        intakeCount={canWrite && (project?.intakeEnabled || intakeCount > 0 || tab === 'intake') ? intakeCount : undefined}
        settingsOpen={settingsOpen}
        onSettings={() => setSettingsOpen(true)}
      />

      <Reveal key={tab} className="flex-1 overflow-auto">
        {tab === 'overview' && (
          <OverviewTab
            id={id}
            project={project}
            users={users}
            canWrite={canWrite}
            isAdmin={isAdmin}
            onPatch={(b) => patchProject.mutate(b)}
            onManageMembers={() => setSettingsOpen(true)}
          />
        )}
        {tab === 'tasks' && <TasksTab id={id} statuses={statuses} statusesLoading={statusesQ.isLoading} projectKey={project?.key} users={users} canWrite={canWrite} onOpen={openTask} />}
        {tab === 'plan' && (
          <PlanTab
            projectId={id}
            projectKey={project?.key}
            cyclesEnabled={!!project?.cyclesEnabled}
            canWrite={canWrite}
            isAdmin={isAdmin}
            onOpenMilestoneTasks={(mid) => navigate(`/projects/${id}?section=tasks&milestone=${mid}`)}
            onOpenTask={openTask}
          />
        )}
        {tab === 'intake' && (canWrite
          ? <ProjectIntakeTab projectId={id} statuses={statuses} users={users} />
          : <EmptyState icon={<Inbox size={20} />} title={t('common.noAccess')} />)}
      </Reveal>

      <ProjectSettingsPanel projectId={id} open={settingsOpen} onClose={closeSettings} onDeleted={() => navigate('/projects')} />
    </div>
  );
}

/* ───────────────────────── Header ───────────────────────── */

function ProjectHeader({ project, loading, canWrite, canDelete, tab, onTab, onDeleted, onPatch, intakeCount, settingsOpen, onSettings }: {
  project?: Project; loading: boolean; canWrite: boolean; canDelete: boolean;
  tab: Tab; onTab: (t: Tab) => void; onDeleted: () => void;
  onPatch: (body: Record<string, unknown>) => void;
  /** undefined hides the tab (viewer role); a number shows it with a badge. */
  intakeCount?: number;
  settingsOpen: boolean; onSettings: () => void;
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

  const sections: { key: Tab; label: string; icon: ReactNode; badge?: number }[] = [
    { key: 'overview', label: t('projects.overview'), icon: <LayoutDashboard size={14} /> },
    { key: 'tasks', label: t('common.tasks'), icon: <ListChecks size={14} /> },
    { key: 'plan', label: t('plan.title'), icon: <MilestoneIcon size={14} /> },
    ...(intakeCount !== undefined
      ? [{ key: 'intake' as Tab, label: t('intake.title'), icon: <Inbox size={14} />, badge: intakeCount }]
      : []),
  ];

  return (
    <ProjectContextMenu
      project={{ id: project.id, name: project.name, key: project.key, status: project.status, version: project.version }}
      canWrite={canWrite}
      canDelete={canDelete}
      onDeleted={onDeleted}
      onOpenSettings={onSettings}
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
              {!!s.badge && (
                <span className="rounded-full bg-primary/15 px-1.5 text-[11px] font-medium tabular-nums text-primary">{s.badge}</span>
              )}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-border" aria-hidden />
          <IconButton
            size="sm"
            aria-label={t('nav.settings')}
            onClick={onSettings}
            className={cn(settingsOpen && 'bg-muted text-foreground')}
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
  milestones: Milestone[], cycles: CycleLite[] | undefined, t: (k: string) => string,
): TaskGroup[] {
  // Grouping by cycle remembered from a project that has since turned cycles off.
  if (grouping === 'cycle' && !cycles) grouping = 'status';
  switch (grouping) {
    case 'cycle': {
      // The running cycle first, then the next ones; finished cycles only while they still hold tasks.
      const groups: TaskGroup[] = (cycles ?? [])
        .map((c) => ({
          key: `cycle:${c.id}`, label: c.current ? `${c.name} · ${t('tasksview.currentCycle')}` : c.name,
          icon: <Repeat size={13} className={c.current ? 'text-foreground' : 'text-faint'} />,
          items: tasks.filter((x) => x.cycleId === c.id),
          seed: { cycleId: c.id },
        }));
      groups.push({
        key: 'cycle:none', label: t('tasksview.noCycle'),
        icon: <Repeat size={13} className="text-faint" />,
        items: tasks.filter((x) => !x.cycleId),
        seed: {},
      });
      return groups;
    }
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
    case 'milestone': {
      const groups: TaskGroup[] = milestones.map((m) => ({
        key: `milestone:${m.id}`, label: m.name,
        icon: <Diamond size={13} className={m.done ? 'text-success' : 'text-faint'} fill={m.done ? 'currentColor' : 'none'} />,
        items: tasks.filter((x) => x.milestoneId === m.id),
        seed: { milestoneId: m.id },
      }));
      groups.push({
        key: 'milestone:none', label: t('tasksview.noMilestone'),
        icon: <Diamond size={13} className="text-faint" />,
        items: tasks.filter((x) => !x.milestoneId),
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

function TasksTab({ id, statuses, statusesLoading, projectKey, users, canWrite, onOpen }: {
  id: string; statuses: TaskStatus[]; statusesLoading: boolean; projectKey?: string; users: UserLite[];
  canWrite: boolean; onOpen: (tid: string, e?: OpenIntent) => void;
}) {
  const t = useT();
  const qc = useQueryClient();

  const [prefs, setPrefsState] = useState<TaskViewPrefs>(() => loadPrefs(id));
  // Filters persist per project, like the display prefs above them – leaving
  // and coming back should not silently unfilter the list.
  const [filters, setFilters] = usePersistedState<TaskFilters>(`ordi:tasksfilters:${id}`, EMPTY_FILTERS, sanitizeFilters);
  useEffect(() => { setPrefsState(loadPrefs(id)); }, [id]);
  const updatePrefs = (patch: Partial<TaskViewPrefs>) =>
    setPrefsState((p) => { const next = { ...p, ...patch }; savePrefs(id, next); return next; });

  // `?milestone=` arrives from the overview: show that milestone's work, and
  // group by milestone so the answer to "what is in it" is on screen.
  const params = useSearchParams();
  const milestoneParam = params.get('milestone');
  useEffect(() => {
    if (!milestoneParam) return;
    setFilters((f) => ({ ...f, milestoneIds: [milestoneParam] }));
    setPrefsState((p) => { const next = { ...p, grouping: 'milestone' as Grouping }; savePrefs(id, next); return next; });
  }, [milestoneParam, id]);

  // The whole project, not the newest page: grouping and ordering happen here.
  const tasksQ = useQuery<Task[]>({ queryKey: ['tasks', id], queryFn: () => getAllPages<Task>('/tasks', { projectId: id }) });
  const milestonesQ = useQuery<Milestone[]>({
    queryKey: ['milestones', id],
    queryFn: () => api.get<{ data: Milestone[] }>(`/projects/${id}/milestones`).then((r) => r.data),
  });
  const milestones = useMemo(() => milestonesQ.data ?? [], [milestonesQ.data]);
  const allTasks = useMemo(() => tasksQ.data ?? [], [tasksQ.data]);
  // Cycles exist for this list only where the project uses them.
  const projectRow = useQuery<{ cyclesEnabled?: boolean }>({ queryKey: ['project', id], queryFn: () => api.get(`/projects/${id}`) }).data;
  const cyclesQ = useCycles(id, !!projectRow?.cyclesEnabled);
  const cycles = useMemo<CycleLite[] | undefined>(() => {
    if (!projectRow?.cyclesEnabled) return undefined;
    const all = cyclesQ.data ?? [];
    const running = currentCycle(all);
    const used = new Set(allTasks.map((x) => x.cycleId).filter(Boolean));
    return all
      .filter((c) => cyclePhase(c) !== 'completed' || used.has(c.id))
      .sort((a, b) => (a.id === running?.id ? -1 : b.id === running?.id ? 1 : (a.startDate ?? '').localeCompare(b.startDate ?? '')))
      .map((c) => ({ id: c.id, name: c.name, current: c.id === running?.id }));
  }, [projectRow?.cyclesEnabled, cyclesQ.data, allTasks]);
  // Task labels only: the project vocabulary never applies to a task list.
  const labelsQ = useLabels('task');
  const labels = useMemo(() => (labelsQ.data ?? []) as LabelLite[], [labelsQ.data]);

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
    return buildGroups(grouping, visibleTasks, statuses, users, labels, milestones, cycles, t)
      .map((g) => ({ ...g, items: orderTasks(g.items, prefs.ordering, prefs.orderingDir) }))
      .filter((g) => g.items.length > 0 || (prefs.showEmptyGroups && canWrite) || g.key === 'all');
  }, [prefs.view, prefs.grouping, prefs.ordering, prefs.orderingDir, prefs.showEmptyGroups, visibleTasks, statuses, users, labels, milestones, cycles, canWrite, t]);

  const loading = statusesLoading || tasksQ.isLoading;
  const { view } = prefs;
  const filtered = allTasks.length > 0 && visibleTasks.length === 0;

  return (
    // pb-16: room under the last row for the floating view controls.
    <div className="flex min-h-full flex-col pb-16">
      <TasksToolbar
        projectId={id}
        prefs={prefs}
        onPrefs={updatePrefs}
        filters={filters}
        onFilters={setFilters}
        statuses={statuses}
        labels={labels}
        users={users}
        milestones={milestones}
        cycles={cycles}
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
          milestones={milestones} cycles={cycles}
          onOpen={onOpen}
          onToggleCollapse={(key) => updatePrefs({
            collapsed: prefs.collapsed.includes(key) ? prefs.collapsed.filter((k) => k !== key) : [...prefs.collapsed, key],
          })}
          onAdd={(title, seed) => addTask.mutateAsync({ title, seed })}
          onMove={(taskId, statusId, version) => move.mutate({ taskId, statusId, version })}
        />
      ) : view === 'board' ? (
        <div className="min-w-0 flex-1 px-4 py-3">
          <BoardView
            projectId={id} projectKey={projectKey} statuses={statuses} groups={groups} prefs={prefs}
            canWrite={canWrite} resolveUsers={resolveUsers} labelById={labelById} childStats={childStats}
            onOpen={onOpen}
            onAdd={(title, seed) => addTask.mutateAsync({ title, seed })}
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
  seed?: Record<string, unknown>; onAdd: (title: string, seed?: Record<string, unknown>) => Promise<unknown>;
  placeholder: string; variant?: 'row' | 'card'; inputRef?: (el: HTMLInputElement | null) => void;
  /** Called on Escape or on blur with an empty draft – lets the list hide the row again. */
  onDismiss?: () => void;
}) {
  const [title, setTitle] = useState('');
  const [pending, setPending] = useState(false);
  return (
    <form
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        const value = title.trim();
        if (!value || pending) return;
        setPending(true);
        try { await onAdd(value, seed); setTitle((current) => current.trim() === value ? '' : current); }
        catch { /* The mutation reports the error; keep the title for retry. */ }
        finally { setPending(false); }
      }}
      aria-busy={pending}
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

function ListView({ projectId, projectKey, statuses, groups, prefs, canWrite, resolveUsers, labelById, childStats, taskById, milestones, cycles, onOpen, onToggleCollapse, onAdd, onMove }: {
  projectId: string; projectKey?: string; statuses: TaskStatus[]; groups: TaskGroup[]; prefs: TaskViewPrefs;
  canWrite: boolean; resolveUsers: (ids?: string[]) => UserLite[];
  labelById: Map<string, LabelLite>; childStats: Map<string, ChildStats>; taskById: Map<string, Task>;
  milestones: Milestone[]; cycles?: CycleLite[];
  onOpen: (tid: string, e?: OpenIntent) => void; onToggleCollapse: (key: string) => void;
  onAdd: (title: string, seed?: Record<string, unknown>) => Promise<unknown>;
  onMove: (taskId: string, statusId: string, version?: number) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const inputs = useRef(new Map<string, HTMLInputElement | null>());
  // Linear keeps rows quiet: non-empty groups show the add-row only after "+".
  const [adding, setAdding] = useState<string[]>([]);
  const { props } = prefs;

  const openQuickAdd = (key: string) => {
    setAdding((a) => (a.includes(key) ? a : [...a, key]));
    setTimeout(() => inputs.current.get(key)?.focus(), 30);
  };

  // Selection spans groups: the rows the user currently sees, in render order.
  const visible = useMemo(
    () => groups.flatMap((g) => (prefs.collapsed.includes(g.key) && g.key !== 'all' ? [] : g.items)),
    [groups, prefs.collapsed],
  );
  const sel = useSelection(visible);
  const [bulkDelete, setBulkDelete] = useState(false);
  const [bulkPending, setBulkPending] = useState(false);

  const finishBulk = (r: { ok: number; failed: number }) => {
    const m = bulkMessage(t, r);
    (m.error ? toast.error : toast)(m.text);
    qc.invalidateQueries({ queryKey: ['tasks', projectId] });
    sel.clear();
    setBulkPending(false);
  };

  const bulkPatch = async (body: Record<string, unknown>, skip?: (task: Task) => boolean) => {
    setBulkPending(true);
    const targets = skip ? sel.items.filter((x) => !skip(x)) : sel.items;
    finishBulk(await runBulk(targets, (x) => api.patch(`/tasks/${x.id}`, { ...body, version: x.version })));
  };

  const bulkRemove = async () => {
    setBulkPending(true);
    setBulkDelete(false);
    finishBulk(await runBulk(sel.items, (x) => api.del(`/tasks/${x.id}`)));
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
                      <div
                        onClick={(e) => onOpen(task.id, e)}
                        onAuxClick={(e) => onOpen(task.id, e)}
                        className={cn(
                          'row-enter group/row flex h-9 w-full items-center gap-2.5 px-4 text-left transition-colors duration-150 hover:bg-muted/50',
                          (i > 0 || flat) && 'border-t border-border/60',
                          sel.has(task.id) && 'bg-primary/[0.06] hover:bg-primary/10',
                        )}
                        style={{ ['--i' as string]: Math.min(i, 10) }}
                      >
                        {canWrite && (
                          <RowCheckbox
                            label={`${t('common.select')} ${ref} ${task.title}`}
                            checked={sel.has(task.id)}
                            onToggle={(shift) => sel.toggle(task.id, shift)}
                            className={cn('transition-opacity duration-150 focus-visible:opacity-100', !sel.has(task.id) && sel.size === 0 && 'opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100')}
                          />
                        )}
                        {props.priority && <PriorityIcon priority={task.priority} size={15} />}
                        {props.id && ref && (
                          <span className="hidden w-16 shrink-0 truncate font-mono text-[11px] text-faint sm:block">{ref}</span>
                        )}
                        {props.status && (
                          <TaskStatusPicker
                            projectId={projectId}
                            statusId={task.statusId}
                            category={st?.category}
                            color={st?.color}
                            statusName={st?.name}
                            canWrite={canWrite}
                            onPick={(s) => onMove(task.id, s.id, task.version)}
                          />
                        )}
                        <span className="flex min-w-0 items-center gap-1.5">
                          {task.blocked && (
                            <span title={t('projects.blocked')} className="shrink-0 text-warning"><Ban size={13} /></span>
                          )}
                          <a href={`/projects/${projectId}/tasks/${task.id}`} onClick={(e) => { e.stopPropagation(); onOpen(task.id, e); }} onAuxClick={(e) => { e.stopPropagation(); onOpen(task.id, e); }} className="truncate text-[13px] font-medium">{task.title}</a>
                          {parent && (
                            <span className="hidden min-w-0 max-w-44 truncate text-xs text-faint lg:block">› {parent.title}</span>
                          )}
                          {props.progress && stats && <ProgressPill stats={stats} />}
                        </span>
                        <span className="ml-auto flex shrink-0 items-center gap-2.5 pl-2">
                          {props.labels && labelChips(task, labelById)}
                          {props.dueDate && task.dueDate && (
                            <span className={cn('inline-flex items-center gap-1 text-xs tabular-nums', overdue ? 'text-destructive' : 'text-muted-foreground')}>
                              {overdue && <><AlertTriangle size={12} aria-hidden /><span className="sr-only">{t('date.overdue')} </span></>}
                              {fmtDate(task.dueDate)}
                            </span>
                          )}
                          {props.assignee && assignees.length > 0 && <AvatarGroup users={assignees} size={20} max={3} />}
                        </span>
                      </div>
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

      <BulkBar count={sel.size} onClear={sel.clear}>
        <DropdownMenu
          align="start"
          trigger={<Button size="xs" variant="outline" disabled={bulkPending}>{t('bulkTasks.status')}</Button>}
        >
          <MenuLabel>{t('bulkTasks.status')}</MenuLabel>
          {statuses.map((s) => (
            <MenuItem key={s.id} onSelect={() => bulkPatch({ statusId: s.id }, (x) => x.statusId === s.id)}>
              <span className="flex items-center gap-2">
                <StatusIcon category={s.category} color={s.color} size={14} /> {s.name}
              </span>
            </MenuItem>
          ))}
        </DropdownMenu>
        <DropdownMenu
          align="start"
          trigger={<Button size="xs" variant="outline" disabled={bulkPending}>{t('bulkTasks.priority')}</Button>}
        >
          <MenuLabel>{t('bulkTasks.priority')}</MenuLabel>
          {PRIORITIES.map((p) => (
            <MenuItem key={p} onSelect={() => bulkPatch({ priority: p }, (x) => x.priority === p)}>
              <span className="flex items-center gap-2">
                <PriorityIcon priority={p} size={14} /> {t(PRIORITY_LABEL_KEY[p]!)}
              </span>
            </MenuItem>
          ))}
        </DropdownMenu>
        {milestones.length > 0 && (
          <DropdownMenu
            side="top"
            trigger={<Button size="xs" variant="outline" disabled={bulkPending}>{t('tasksview.milestone')}</Button>}
          >
            <MenuLabel>{t('tasksview.milestone')}</MenuLabel>
            {milestones.map((m) => (
              <MenuItem key={m.id} icon={<Diamond size={14} />} onSelect={() => bulkPatch({ milestoneId: m.id }, (x) => x.milestoneId === m.id)}>{m.name}</MenuItem>
            ))}
            <MenuItem icon={<Diamond size={14} className="text-faint" />} onSelect={() => bulkPatch({ milestoneId: null }, (x) => !x.milestoneId)}>{t('tasksview.noMilestone')}</MenuItem>
          </DropdownMenu>
        )}
        {cycles && cycles.length > 0 && (
          <DropdownMenu
            side="top"
            trigger={<Button size="xs" variant="outline" disabled={bulkPending}>{t('tasksview.cycle')}</Button>}
          >
            <MenuLabel>{t('tasksview.cycle')}</MenuLabel>
            {cycles.map((c) => (
              <MenuItem key={c.id} icon={<Repeat size={14} />} onSelect={() => bulkPatch({ cycleId: c.id }, (x) => x.cycleId === c.id)}>
                {c.current ? `${c.name} · ${t('tasksview.currentCycle')}` : c.name}
              </MenuItem>
            ))}
            <MenuItem icon={<Repeat size={14} className="text-faint" />} onSelect={() => bulkPatch({ cycleId: null }, (x) => !x.cycleId)}>{t('tasksview.noCycle')}</MenuItem>
          </DropdownMenu>
        )}
        <Button size="xs" variant="outline" disabled={bulkPending} onClick={() => setBulkDelete(true)}>
          {t('common.delete')}
        </Button>
      </BulkBar>

      <ConfirmDialog
        open={bulkDelete}
        onClose={() => setBulkDelete(false)}
        onConfirm={bulkRemove}
        title={t('bulkTasks.deleteTitle')}
        body={t('bulkTasks.deleteBody').replace('{n}', String(sel.size))}
        confirmLabel={t('common.delete')}
        danger
        pending={bulkPending}
      />
    </div>
  );
}

/* ---- Board view (drag & drop, status columns) ---- */

function BoardView({ projectId, projectKey, statuses, groups, prefs, canWrite, resolveUsers, labelById, childStats, onOpen, onAdd, onMove }: {
  projectId: string; projectKey?: string; statuses: TaskStatus[]; groups: TaskGroup[]; prefs: TaskViewPrefs;
  canWrite: boolean; resolveUsers: (ids?: string[]) => UserLite[];
  labelById: Map<string, LabelLite>; childStats: Map<string, ChildStats>;
  onOpen: (tid: string, e?: OpenIntent) => void;
  onAdd: (title: string, seed?: Record<string, unknown>) => Promise<unknown>;
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
                    <a href={`/projects/${projectId}/tasks/${task.id}`}
                      draggable={canWrite}
                      onDragStart={(e) => { setDragId(task.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/task-id', task.id); }}
                      onDragEnd={() => { setDragId(null); setOverCol(null); }}
                      onClick={(e) => onOpen(task.id, e)}
                      onAuxClick={(e) => onOpen(task.id, e)}
                      className={cn(
                        'block cursor-pointer rounded-lg border border-border bg-card p-2.5 text-left shadow-sm transition-all duration-150 hover:border-border-strong',
                        canWrite && 'active:cursor-grabbing',
                        dragId === task.id && 'opacity-40',
                      )}
                    >
                      <div className="flex items-start gap-1.5">
                        {props.priority && <span className="mt-0.5"><PriorityIcon priority={task.priority} size={14} /></span>}
                        {task.blocked && (
                          <span title={t('projects.blocked')} className="mt-0.5 shrink-0 text-warning"><Ban size={13} /></span>
                        )}
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
                          <span className={cn('inline-flex items-center gap-1 text-[11px] tabular-nums', overdue ? 'text-destructive' : 'text-muted-foreground')}>
                            {overdue && <><AlertTriangle size={12} aria-hidden /><span className="sr-only">{t('date.overdue')} </span></>}
                            {fmtDate(task.dueDate)}
                          </span>
                        )}
                        {props.assignee && assignees.length > 0 && <span className="ml-auto"><AvatarGroup users={assignees} size={18} max={3} /></span>}
                      </div>
                    </a>
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
  const rail = useRailWidth('project', 280);

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
    <PageBody width="full" style={rail.railStyle} className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_var(--rail-w,280px)]">
      {/* Left: what the project is (description, resources), then what is
          happening (updates), then its trail. Milestones live in the
          Plan tab; empty blocks stay out of the way. */}
      <div className="order-2 min-w-0 space-y-7 lg:order-1">
        {project ? (
          <>
            <div className="space-y-3">
              {/* The one-line summary predates the description; it stays
                  editable where one was written, new projects just describe. */}
              {project.summary?.trim() && <SummaryInput project={project} canWrite={canWrite} onPatch={onPatch} />}
              <div className="project-description">
                <RichEditor key={project.id} value={doc} onChange={onDescChange} editable={canWrite} placeholder={t('projects.aboutPlaceholder')} compact />
              </div>
            </div>

            <ProjectResources projectId={id} canWrite={canWrite} />

            <ProjectUpdates projectId={id} canWrite={canWrite} isAdmin={isAdmin} />

            <CustomFieldsSection
              entityType="projects"
              values={project.customFields}
              editable={canWrite}
              onSave={(customFields) => onPatch({ customFields })}
            />

            <ProjectDeals projectId={id} />

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
      <div className="relative order-1 lg:order-2">
        <RailResizeHandle width={rail.width} base={rail.base} onWidth={rail.onWidth} className="lg:block" />
        {project ? (
          <PropertiesRail
            project={project}
            users={users}
            canWrite={canWrite}
            canManageMembers={isAdmin}
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

