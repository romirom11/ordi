/**
 * My Tasks – Linear-style triage, split the way the reference splits it:
 * Assigned (what I hold, bucketed Overdue / Today / This week / Later) and
 * Created (what I filed, whoever holds it now).
 *
 * One list conflated the two: a task filed for someone else, or filed with no
 * assignee at all, sat among the ones actually to do.
 * Items come from GET /me/tasks in snake_case.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, CalendarClock, CalendarRange, CheckSquare, Inbox, UserRoundPlus, UserRound,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { useNavigate, useOpen } from '../lib/router';
import {
  Badge, EmptyState, PageHeader, PriorityIcon, SegmentedControl, Skeleton, StatusIcon, cn, fmtDate,
} from '../components/ui';
import { useT, extendDict } from '../lib/i18n';
import { usePersistedState, oneOfPref } from '../lib/prefs';

extendDict({
  en: {
    'tasks.later': 'Later',
    'tasks.assigned': 'Assigned',
    'tasks.created': 'Created',
    'tasks.unassignedGroup': 'Nobody assigned',
    'tasks.assignedGroup': 'With an assignee',
    'tasks.noneCreated': 'Nothing you filed is open',
    'tasks.noneCreatedHint': 'Tasks you create show up here until they are done.',
    'tasks.countOne': 'task',
    'tasks.countMany': 'tasks',
  },
  uk: {
    'tasks.later': 'Пізніше',
    'tasks.assigned': 'Призначені мені',
    'tasks.created': 'Створені мною',
    'tasks.unassignedGroup': 'Без виконавця',
    'tasks.assignedGroup': 'З виконавцем',
    'tasks.noneCreated': 'Немає відкритих задач, які ви створили',
    'tasks.noneCreatedHint': 'Задачі, які ви створюєте, показуються тут, поки не завершені.',
    'tasks.countOne': 'задача',
    'tasks.countMany': 'задач',
  },
});

interface MeTask {
  id: string;
  title: string;
  due_date: string | null;
  priority: string;
  number: number;
  project_id: string;
  key: string;
  category: string;
  status_name: string;
  status_color: string;
  ref: string;
  /** created tab only */
  has_assignee?: boolean;
}

interface MeTasksResponse {
  overdue: MeTask[];
  today: MeTask[];
  week: MeTask[];
  later: MeTask[];
  created: MeTask[];
}

type Tab = 'assigned' | 'created';
interface Section { key: string; labelKey: string; icon: ReactNode; accent?: boolean; tasks: MeTask[] }

const ASSIGNED_SECTIONS: { key: keyof MeTasksResponse; labelKey: string; icon: ReactNode; accent?: boolean }[] = [
  { key: 'overdue', labelKey: 'common.overdue', icon: <AlertTriangle size={13} />, accent: true },
  { key: 'today', labelKey: 'common.today', icon: <CalendarClock size={13} /> },
  { key: 'week', labelKey: 'tasks.thisWeek', icon: <CalendarRange size={13} /> },
  { key: 'later', labelKey: 'tasks.later', icon: <Inbox size={13} /> },
];

function isOverdue(due: string | null): boolean {
  if (!due) return false;
  return new Date(due).setHours(0, 0, 0, 0) < new Date().setHours(0, 0, 0, 0);
}

function LoadingRows() {
  return (
    <div className="px-6 py-4">
      <Skeleton className="mb-3 h-4 w-28" />
      <div className="space-y-1.5">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
      </div>
      <Skeleton className="mb-3 mt-6 h-4 w-24" />
      <div className="space-y-1.5">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
      </div>
    </div>
  );
}

export function MyTasksPage() {
  const t = useT();
  const navigate = useNavigate();
  const open = useOpen();
  const [tab, setTab] = usePersistedState<Tab>('ordi:view:myTasks.tab', 'assigned', oneOfPref(['assigned', 'created'], 'assigned'));

  const { data, isLoading } = useQuery<MeTasksResponse>({
    queryKey: ['me-tasks'],
    queryFn: () => api.get('/me/tasks'),
  });

  const assignedCount = ASSIGNED_SECTIONS.reduce((n, s) => n + (data?.[s.key]?.length ?? 0), 0);
  const createdCount = data?.created.length ?? 0;

  const sections: Section[] = useMemo(() => {
    if (tab === 'assigned') {
      return ASSIGNED_SECTIONS
        .map((s) => ({ ...s, tasks: data?.[s.key] ?? [] }))
        .filter((s) => s.tasks.length > 0);
    }
    // What I filed, unassigned first: those are the ones still waiting on a
    // decision from me, and they are exactly what used to pollute the assigned list.
    const created = data?.created ?? [];
    return [
      { key: 'unassigned', labelKey: 'tasks.unassignedGroup', icon: <UserRoundPlus size={13} />, tasks: created.filter((x) => !x.has_assignee) },
      { key: 'assignedOut', labelKey: 'tasks.assignedGroup', icon: <UserRound size={13} />, tasks: created.filter((x) => x.has_assignee) },
    ].filter((s) => s.tasks.length > 0);
  }, [tab, data]);

  const total = tab === 'assigned' ? assignedCount : createdCount;
  let rowIndex = 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={t('nav.myTasks')}
        subtitle={isLoading ? t('common.loading') : `${total} ${t(total === 1 ? 'tasks.countOne' : 'tasks.countMany')} · ${t('tasks.myTasksSubtitle')}`}
        actions={(
          <SegmentedControl
            value={tab}
            onChange={(v) => setTab(v as Tab)}
            options={[
              { key: 'assigned', label: `${t('tasks.assigned')} ${assignedCount}`, icon: <UserRound size={13} /> },
              { key: 'created', label: `${t('tasks.created')} ${createdCount}`, icon: <UserRoundPlus size={13} /> },
            ]}
          />
        )}
      />

      {isLoading ? (
        <LoadingRows />
      ) : total === 0 ? (
        <EmptyState
          icon={<CheckSquare size={20} />}
          title={t(tab === 'assigned' ? 'tasks.noneAssigned' : 'tasks.noneCreated')}
          hint={t(tab === 'assigned' ? 'tasks.noneAssignedHint' : 'tasks.noneCreatedHint')}
        />
      ) : (
        <div className="pb-8">
          {sections.map((s) => (
            <section key={s.key}>
              <header
                className={cn(
                  'sticky top-0 z-10 flex h-8 items-center gap-1.5 border-b border-border bg-surface/95 px-6 backdrop-blur',
                  'text-xs font-semibold uppercase tracking-wide',
                  s.accent ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {s.icon}
                <span>{t(s.labelKey)}</span>
                <span className="font-normal tabular-nums text-faint">{s.tasks.length}</span>
              </header>

              {s.tasks.map((task) => {
                const i = rowIndex++;
                const overdue = s.key === 'overdue' || isOverdue(task.due_date);
                return (
                  <button
                    key={task.id}
                    onClick={(e) => open(`/projects/${task.project_id}/tasks/${task.id}`, e)}
                    onAuxClick={(e) => open(`/projects/${task.project_id}/tasks/${task.id}`, e)}
                    className="row-enter flex h-9 w-full cursor-pointer items-center gap-3 border-b border-border px-6 text-left transition-colors duration-150 hover:bg-muted"
                    style={{ ['--i' as string]: Math.min(i, 10) }}
                  >
                    <PriorityIcon priority={task.priority} />
                    <span className="w-14 shrink-0 font-mono text-[11px] text-faint">{task.ref}</span>
                    <StatusIcon category={task.category} color={task.status_color} />
                    <span className="min-w-0 flex-1 truncate text-[13px]">{task.title}</span>
                    <Badge>{task.key}</Badge>
                    <span
                      className={cn(
                        'w-16 shrink-0 text-right text-xs tabular-nums',
                        overdue ? 'font-medium text-destructive' : 'text-muted-foreground',
                      )}
                    >
                      {task.due_date ? fmtDate(task.due_date) : ''}
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
