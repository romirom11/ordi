/**
 * Per-project task view preferences (Linear-style Display options) + client-side
 * task filters. Prefs persist in localStorage under `ordi:tasksview:<projectId>`.
 * Shared i18n keys for the Tasks toolbar / popovers live here so every consumer
 * gets them regardless of import order.
 */
import { extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'tasksview.filter': 'Filter',
    'tasksview.display': 'Display',
    'tasksview.addFilter': 'Add filter…',
    'tasksview.assignee': 'Assignee',
    'tasksview.labels': 'Labels',
    'tasksview.noAssignee': 'No assignee',
    'tasksview.noLabel': 'No label',
    'tasksview.milestone': 'Milestone',
    'tasksview.noMilestone': 'No milestone',
    'tasksview.dueOverdue': 'Overdue',
    'tasksview.dueToday': 'Due today',
    'tasksview.dueWeek': 'Due this week',
    'tasksview.dueNone': 'No due date',
    'tasksview.pUrgent': 'Urgent',
    'tasksview.pHigh': 'High',
    'tasksview.pMedium': 'Medium',
    'tasksview.pLow': 'Low',
    'tasksview.pNone': 'No priority',
    'tasksview.grouping': 'Grouping',
    'tasksview.ordering': 'Ordering',
    'tasksview.none': 'None',
    'tasksview.orderCreated': 'Created',
    'tasksview.orderAsc': 'Ascending',
    'tasksview.orderDesc': 'Descending',
    'tasksview.showSubtasks': 'Show sub-tasks',
    'tasksview.showEmptyGroups': 'Show empty groups',
    'tasksview.displayProps': 'Display properties',
    'tasksview.propId': 'ID',
    'tasksview.propProgress': 'Sub-tasks',
    'tasksview.reset': 'Reset',
    'tasksview.views': 'Views',
    'tasksview.saveView': 'Save current view…',
    'tasksview.viewName': 'View name',
    'tasksview.viewSaved': 'View saved',
    'tasksview.deleteView': 'Delete saved view',
    'tasksview.noUndo': 'This can’t be undone.',
    'tasksview.noViews': 'No saved views yet',
    'tasksview.shared': 'Shared',
    'tasksview.clearFilters': 'Clear filters',
    'tasksview.noMatches': 'No tasks match these filters',
    'tasksview.noMatchesHint': 'Adjust or clear the filters to see tasks.',
    'tasksview.saveViewFailed': 'Could not save the view.',
    'tasksview.deleteViewFailed': 'Could not delete the view.',
    'tasksview.collapse': 'Collapse group',
    'tasksview.addTask': 'Add task',
  },
  uk: {
    'tasksview.filter': 'Фільтр',
    'tasksview.display': 'Вигляд',
    'tasksview.addFilter': 'Додати фільтр…',
    'tasksview.assignee': 'Виконавець',
    'tasksview.labels': 'Мітки',
    'tasksview.noAssignee': 'Без виконавця',
    'tasksview.noLabel': 'Без мітки',
    'tasksview.milestone': 'Майлстоун',
    'tasksview.noMilestone': 'Без майлстоуна',
    'tasksview.dueOverdue': 'Протерміновані',
    'tasksview.dueToday': 'На сьогодні',
    'tasksview.dueWeek': 'На цьому тижні',
    'tasksview.dueNone': 'Без терміну',
    'tasksview.pUrgent': 'Терміново',
    'tasksview.pHigh': 'Високий',
    'tasksview.pMedium': 'Середній',
    'tasksview.pLow': 'Низький',
    'tasksview.pNone': 'Без пріоритету',
    'tasksview.grouping': 'Групування',
    'tasksview.ordering': 'Сортування',
    'tasksview.none': 'Немає',
    'tasksview.orderCreated': 'Дата створення',
    'tasksview.orderAsc': 'За зростанням',
    'tasksview.orderDesc': 'За спаданням',
    'tasksview.showSubtasks': 'Показувати підзадачі',
    'tasksview.showEmptyGroups': 'Показувати порожні групи',
    'tasksview.displayProps': 'Властивості рядка',
    'tasksview.propId': 'ID',
    'tasksview.propProgress': 'Підзадачі',
    'tasksview.reset': 'Скинути',
    'tasksview.views': 'Подання',
    'tasksview.saveView': 'Зберегти поточне подання…',
    'tasksview.viewName': 'Назва подання',
    'tasksview.viewSaved': 'Подання збережено',
    'tasksview.deleteView': 'Видалити подання',
    'tasksview.noUndo': 'Цю дію не можна скасувати.',
    'tasksview.noViews': 'Ще немає збережених подань',
    'tasksview.shared': 'Спільне',
    'tasksview.clearFilters': 'Очистити фільтри',
    'tasksview.noMatches': 'Немає задач за цими фільтрами',
    'tasksview.noMatchesHint': 'Змініть або очистіть фільтри, щоб побачити задачі.',
    'tasksview.saveViewFailed': 'Не вдалося зберегти подання.',
    'tasksview.deleteViewFailed': 'Не вдалося видалити подання.',
    'tasksview.collapse': 'Згорнути групу',
    'tasksview.addTask': 'Додати задачу',
  },
});

export const TASK_VIEWS = ['list', 'board', 'calendar', 'timeline', 'spreadsheet'] as const;
export type TaskView = typeof TASK_VIEWS[number];

export const GROUPINGS = ['status', 'assignee', 'priority', 'label', 'milestone', 'none'] as const;
export type Grouping = typeof GROUPINGS[number];

export const ORDERINGS = ['priority', 'dueDate', 'created', 'title'] as const;
export type Ordering = typeof ORDERINGS[number];

export const ORDER_DIRS = ['asc', 'desc'] as const;
export type OrderDir = typeof ORDER_DIRS[number];

export const DISPLAY_PROPS = ['id', 'priority', 'status', 'assignee', 'labels', 'dueDate', 'progress'] as const;
export type DisplayProp = typeof DISPLAY_PROPS[number];

export interface TaskViewPrefs {
  view: TaskView;
  grouping: Grouping;
  ordering: Ordering;
  orderingDir: OrderDir;
  showSubtasks: boolean;
  showEmptyGroups: boolean;
  props: Record<DisplayProp, boolean>;
  /** Collapsed group keys, namespaced by grouping (e.g. `status:<id>`). */
  collapsed: string[];
}

export const DEFAULT_PREFS: TaskViewPrefs = {
  view: 'list',
  grouping: 'status',
  ordering: 'priority',
  orderingDir: 'asc',
  showSubtasks: true,
  showEmptyGroups: true,
  props: { id: true, priority: true, status: true, assignee: true, labels: true, dueDate: true, progress: true },
  collapsed: [],
};

export function isTaskView(v: unknown): v is TaskView {
  return typeof v === 'string' && (TASK_VIEWS as readonly string[]).includes(v);
}

function prefsKey(projectId: string): string {
  return `ordi:tasksview:${projectId}`;
}

export function loadPrefs(projectId: string): TaskViewPrefs {
  let stored: Partial<TaskViewPrefs> = {};
  try {
    const raw = localStorage.getItem(prefsKey(projectId));
    if (raw) stored = JSON.parse(raw) as Partial<TaskViewPrefs>;
    else {
      // Migrate the legacy per-project view key.
      const legacy = localStorage.getItem(`ordi:view:${projectId}`);
      if (isTaskView(legacy)) stored = { view: legacy };
    }
  } catch { /* private mode / bad JSON */ }
  return {
    ...DEFAULT_PREFS,
    ...stored,
    view: isTaskView(stored.view) ? stored.view : DEFAULT_PREFS.view,
    grouping: (GROUPINGS as readonly string[]).includes(stored.grouping as string) ? stored.grouping as Grouping : DEFAULT_PREFS.grouping,
    ordering: (ORDERINGS as readonly string[]).includes(stored.ordering as string) ? stored.ordering as Ordering : DEFAULT_PREFS.ordering,
    orderingDir: (ORDER_DIRS as readonly string[]).includes(stored.orderingDir as string) ? stored.orderingDir as OrderDir : DEFAULT_PREFS.orderingDir,
    props: { ...DEFAULT_PREFS.props, ...(stored.props ?? {}) },
    collapsed: Array.isArray(stored.collapsed) ? stored.collapsed.filter((k): k is string => typeof k === 'string') : [],
  };
}

export function savePrefs(projectId: string, prefs: TaskViewPrefs): void {
  try { localStorage.setItem(prefsKey(projectId), JSON.stringify(prefs)); } catch { /* private mode */ }
}

/* ───────────────────────── Filters ───────────────────────── */

export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
export const PRIORITY_LABEL_KEY: Record<string, string> = {
  urgent: 'tasksview.pUrgent', high: 'tasksview.pHigh', medium: 'tasksview.pMedium',
  low: 'tasksview.pLow', none: 'tasksview.pNone',
};

export type DuePreset = 'overdue' | 'today' | 'week' | 'none';
export const DUE_PRESETS: readonly DuePreset[] = ['overdue', 'today', 'week', 'none'];
export const DUE_LABEL_KEY: Record<DuePreset, string> = {
  overdue: 'tasksview.dueOverdue', today: 'tasksview.dueToday', week: 'tasksview.dueWeek', none: 'tasksview.dueNone',
};

export interface TaskFilters {
  statusIds: string[];
  priorities: string[];
  assigneeIds: string[];
  labelIds: string[];
  milestoneIds: string[];
  due: DuePreset | null;
}

export const EMPTY_FILTERS: TaskFilters = { statusIds: [], priorities: [], assigneeIds: [], labelIds: [], milestoneIds: [], due: null };

export function countFilters(f: TaskFilters): number {
  return f.statusIds.length + f.priorities.length + f.assigneeIds.length + f.labelIds.length
    + f.milestoneIds.length + (f.due ? 1 : 0);
}

export function sanitizeFilters(raw: unknown): TaskFilters {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const due = o.due;
  return {
    statusIds: arr(o.statusIds),
    priorities: arr(o.priorities),
    assigneeIds: arr(o.assigneeIds),
    labelIds: arr(o.labelIds),
    milestoneIds: arr(o.milestoneIds),
    due: due === 'overdue' || due === 'today' || due === 'week' || due === 'none' ? due : null,
  };
}

interface FilterableTask {
  statusId: string;
  priority?: string;
  dueDate?: string | null;
  assigneeIds?: string[];
  labelIds?: string[];
  milestoneId?: string | null;
}

function startOfDay(d: Date): number {
  const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime();
}

export function dueMatches(preset: DuePreset, dueDate: string | null | undefined, statusCategory?: string): boolean {
  if (preset === 'none') return !dueDate;
  if (!dueDate) return false;
  const due = startOfDay(new Date(dueDate));
  const today = startOfDay(new Date());
  switch (preset) {
    case 'overdue':
      return due < today && statusCategory !== 'done' && statusCategory !== 'canceled';
    case 'today':
      return due === today;
    case 'week':
      return due >= today && due < today + 7 * 86_400_000;
  }
}

export function applyFilters<T extends FilterableTask>(
  tasks: T[], f: TaskFilters, categoryOf: (statusId: string) => string | undefined,
): T[] {
  if (countFilters(f) === 0) return tasks;
  return tasks.filter((t) => {
    if (f.statusIds.length && !f.statusIds.includes(t.statusId)) return false;
    if (f.priorities.length && !f.priorities.includes(t.priority ?? 'none')) return false;
    if (f.assigneeIds.length && !f.assigneeIds.some((id) => (t.assigneeIds ?? []).includes(id))) return false;
    if (f.labelIds.length && !f.labelIds.some((id) => (t.labelIds ?? []).includes(id))) return false;
    if (f.milestoneIds.length && !f.milestoneIds.includes(t.milestoneId ?? 'none')) return false;
    if (f.due && !dueMatches(f.due, t.dueDate, categoryOf(t.statusId))) return false;
    return true;
  });
}

/* ───────────────────────── Ordering ───────────────────────── */

const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

interface OrderableTask {
  title: string;
  priority?: string;
  dueDate?: string | null;
  createdAt?: string;
  /** Per-project manual order; a numeric column, so it arrives as a string. */
  position?: string | number | null;
  /** Per-project counter behind the task ref (ZAJ-7 → 7). */
  number?: number;
}

/**
 * Ties used to fall through to `Array#sort` stability, i.e. to whatever order
 * the API sent — `/tasks` pages newest-first — so ten tasks written out in
 * order came back 10…1 inside every priority band. Every ordering therefore
 * ends on one explicit sequence: manual position, then the per-project number,
 * then creation time. Only tasks of one project are ever ordered together, so
 * comparing project-scoped position/number is sound.
 */
export function orderTasks<T extends OrderableTask>(
  tasks: T[], ordering: Ordering, dir: OrderDir = DEFAULT_PREFS.orderingDir,
): T[] {
  const sign = dir === 'desc' ? -1 : 1;
  const sorted = tasks.slice();
  sorted.sort((a, b) => {
    switch (ordering) {
      case 'priority': {
        const byPriority = (PRIORITY_RANK[a.priority ?? 'none'] ?? 4) - (PRIORITY_RANK[b.priority ?? 'none'] ?? 4);
        if (byPriority) return sign * byPriority;
        const byDue = cmpDue(a.dueDate, b.dueDate, sign);
        if (byDue) return byDue;
        break;
      }
      case 'dueDate': {
        const byDue = cmpDue(a.dueDate, b.dueDate, sign);
        if (byDue) return byDue;
        break;
      }
      case 'created': {
        const byCreated = (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
        if (byCreated) return sign * byCreated;
        break;
      }
      case 'title': {
        // Numeric collation, or "WP-плагін 10" lands ahead of "WP-плагін 2".
        const byTitle = a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
        if (byTitle) return sign * byTitle;
        break;
      }
    }
    return sign * cmpSeq(a, b);
  });
  return sorted;
}

/** A missing due date is an absence, not a date: it sinks either way. */
function cmpDue(a: string | null | undefined, b: string | null | undefined, sign = 1): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return sign * a.localeCompare(b);
}

function numOr(v: string | number | null | undefined): number {
  return v == null || v === '' ? NaN : Number(v);
}

/** The order a plan was written in: manual position, then number, then time. */
function cmpSeq(a: OrderableTask, b: OrderableTask): number {
  const pa = numOr(a.position);
  const pb = numOr(b.position);
  if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb;
  if (a.number != null && b.number != null && a.number !== b.number) return a.number - b.number;
  return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
}
