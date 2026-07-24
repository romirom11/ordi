/**
 * My Tasks – Linear-style full-width triage list grouped by due bucket:
 * Overdue / Today / This week / Later / Created by me (unassigned).
 * Items come from GET /me/tasks in snake_case.
 */
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, CalendarClock, CalendarRange, CheckSquare, Inbox, UserRoundPlus,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { useNavigate } from '../lib/router';
import {
  Badge, EmptyState, PageHeader, PriorityIcon, Skeleton, StatusIcon, cn, fmtDate,
} from '../components/ui';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'tasks.later': 'Later',
    'tasks.createdByMe': 'Created by me · unassigned',
    'tasks.countOne': 'task',
    'tasks.countMany': 'tasks',
  },
  uk: {
    'tasks.later': 'Пізніше',
    'tasks.createdByMe': 'Створені мною · без виконавця',
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
}

interface MeTasksResponse {
  overdue: MeTask[];
  today: MeTask[];
  week: MeTask[];
  later: MeTask[];
  createdUnassigned: MeTask[];
}

type SectionKey = keyof MeTasksResponse;

const SECTIONS: { key: SectionKey; labelKey: string; icon: ReactNode; accent?: boolean }[] = [
  { key: 'overdue', labelKey: 'common.overdue', icon: <AlertTriangle size={13} />, accent: true },
  { key: 'today', labelKey: 'common.today', icon: <CalendarClock size={13} /> },
  { key: 'week', labelKey: 'tasks.thisWeek', icon: <CalendarRange size={13} /> },
  { key: 'later', labelKey: 'tasks.later', icon: <Inbox size={13} /> },
  { key: 'createdUnassigned', labelKey: 'tasks.createdByMe', icon: <UserRoundPlus size={13} /> },
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

  const { data, isLoading } = useQuery<MeTasksResponse>({
    queryKey: ['me-tasks'],
    queryFn: () => api.get('/me/tasks'),
  });

  const sections = SECTIONS
    .map((s) => ({ ...s, tasks: data?.[s.key] ?? [] }))
    .filter((s) => s.tasks.length > 0);
  const total = sections.reduce((n, s) => n + s.tasks.length, 0);

  let rowIndex = 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={t('nav.myTasks')}
        subtitle={isLoading ? t('common.loading') : `${total} ${t(total === 1 ? 'tasks.countOne' : 'tasks.countMany')} · ${t('tasks.myTasksSubtitle')}`}
      />

      {isLoading ? (
        <LoadingRows />
      ) : total === 0 ? (
        <EmptyState
          icon={<CheckSquare size={20} />}
          title={t('tasks.noneAssigned')}
          hint={t('tasks.noneAssignedHint')}
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
                    onClick={() => navigate(`/projects/${task.project_id}/tasks/${task.id}`)}
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
