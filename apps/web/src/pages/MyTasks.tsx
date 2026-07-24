import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CalendarRange, Inbox } from 'lucide-react';
import type { ReactNode } from 'react';
import { api } from '../lib/api';
import { useNavigate } from '../lib/router';
import { PageHeader, Skeleton, EmptyState, fmtDate, cn } from '../components/ui';
import { useT } from '../lib/i18n';

interface MyTask {
  id: string;
  taskId?: string;
  projectId?: string;
  projectKey?: string;
  key?: string;
  number?: number;
  title: string;
  priority?: string;
  dueDate?: string | null;
  statusName?: string;
}

const PRIORITY_COLOR: Record<string, string> = {
  urgent: '#ef4444', high: '#f97316', medium: '#eab308', low: '#3b82f6', none: '#9ca3af',
};

function taskKey(t: MyTask): string {
  if (t.key) return t.key;
  if (t.projectKey && t.number != null) return `${t.projectKey}-${t.number}`;
  return '';
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

type Bucket = 'overdue' | 'today' | 'week' | 'later';

function bucketFor(t: MyTask): Bucket {
  if (!t.dueDate) return 'later';
  const due = startOfDay(new Date(t.dueDate));
  const today = startOfDay(new Date());
  const day = 86_400_000;
  if (due < today) return 'overdue';
  if (due === today) return 'today';
  if (due <= today + 6 * day) return 'week';
  return 'later';
}

function groupTasks(data: unknown): Record<Bucket, MyTask[]> {
  const out: Record<Bucket, MyTask[]> = { overdue: [], today: [], week: [], later: [] };
  // API may return a flat array, or a pre-grouped object.
  if (Array.isArray(data)) {
    for (const t of data as MyTask[]) out[bucketFor(t)].push(t);
    return out;
  }
  const o = (data ?? {}) as Record<string, unknown>;
  const map: Record<string, Bucket> = {
    overdue: 'overdue', today: 'today', week: 'week', thisWeek: 'week', upcoming: 'week', later: 'later',
  };
  let matched = false;
  for (const [k, v] of Object.entries(o)) {
    const b = map[k];
    if (b && Array.isArray(v)) { out[b].push(...(v as MyTask[])); matched = true; }
  }
  if (!matched) {
    const arr = (o.tasks ?? o.items ?? []) as MyTask[];
    if (Array.isArray(arr)) for (const t of arr) out[bucketFor(t)].push(t);
  }
  return out;
}

const SECTIONS: { key: Bucket; label: string; icon: ReactNode; accent?: boolean }[] = [
  { key: 'overdue', label: 'common.overdue', icon: <AlertTriangle size={14} className="text-destructive" />, accent: true },
  { key: 'today', label: 'common.today', icon: <CalendarClock size={14} /> },
  { key: 'week', label: 'tasks.thisWeek', icon: <CalendarRange size={14} /> },
  { key: 'later', label: 'tasks.later', icon: <Inbox size={14} /> },
];

export function MyTasksPage() {
  const t = useT();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery<unknown>({
    queryKey: ['me', 'tasks'],
    queryFn: () => api.get('/me/tasks'),
  });

  const grouped = groupTasks(data);
  const total = SECTIONS.reduce((n, s) => n + grouped[s.key].length, 0);

  const open = (t: MyTask) => {
    const pid = t.projectId;
    const tid = t.taskId ?? t.id;
    if (pid && tid) navigate(`/projects/${pid}/tasks/${tid}`);
  };

  return (
    <div>
      <PageHeader title={t('nav.myTasks')} subtitle={t('tasks.myTasksSubtitle')} />
      <div className="mx-auto max-w-3xl p-6">
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10" />)}
          </div>
        ) : total === 0 ? (
          <EmptyState
            title={t('tasks.noneAssigned')}
            hint={t('tasks.noneAssignedHint')}
          />
        ) : (
          <div className="space-y-6">
            {SECTIONS.map((s) => {
              const tasks = grouped[s.key];
              if (tasks.length === 0) return null;
              return (
                <section key={s.key}>
                  <h2 className={cn('mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide',
                    s.accent ? 'text-destructive' : 'text-muted-foreground')}>
                    {s.icon} {t(s.label)}
                    <span className="ml-1 rounded bg-muted px-1.5 py-0.5 tabular-nums text-muted-foreground">{tasks.length}</span>
                  </h2>
                  <div className="overflow-hidden rounded-lg border border-border bg-card">
                    {tasks.map((t, i) => (
                      <button
                        key={t.id}
                        onClick={() => open(t)}
                        className={cn('flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted',
                          i > 0 && 'border-t border-border')}
                      >
                        <span className="inline-block h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: PRIORITY_COLOR[t.priority ?? 'none'] ?? PRIORITY_COLOR.none }} />
                        {taskKey(t) && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{taskKey(t)}</span>}
                        <span className="flex-1 truncate">{t.title}</span>
                        {t.statusName && <span className="shrink-0 text-xs text-muted-foreground">{t.statusName}</span>}
                        <span className={cn('shrink-0 text-xs', s.accent ? 'text-destructive' : 'text-muted-foreground')}>
                          {fmtDate(t.dueDate)}
                        </span>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
