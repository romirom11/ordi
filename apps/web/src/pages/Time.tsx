import { useState, type MouseEvent, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useCan } from '../lib/auth';
import { useOpen } from '../lib/router';
import {
  Avatar, Button, IconButton, Textarea, Card, PageHeader, PageBody, Breadcrumbs, EmptyState, Skeleton,
  SegmentedControl, Select, Reveal, AvatarGroup, StatusIcon, fmtMoney, fmtRelative, formatDateTime, appLocale, cn,
} from '../components/ui';
import { Dialog, SidePanel, toast } from '../components/overlays';
import { SortHeader, sortRows, useTableSort, type SortState } from '../components/tableSort';
import { ChevronLeft, ChevronRight, Plus, Play, Square, Clock, Timer, BarChart3 } from 'lucide-react';
import { useT, extendDict } from '../lib/i18n';
import { usePersistedState, oneOfPref } from '../lib/prefs';
import { useActiveTimer, useStopTimer, useTimerElapsed } from '../lib/timer';
import {
  EntryListSkeleton, LogTimeDialog, TaskSelect, TimeEntryPanel, TimeEntryRow, entryDay, fmtDur, invalidateTime, isoDay,
  type TimeEntry,
} from '../components/time/TimeEntries';

extendDict({
  en: {
    'time.timerIdle': 'No timer running',
    'time.timerIdleHint': 'Start a timer against a task to track time as you work.',
    'time.timerStarted': 'Timer started',
    'time.timerStartFailed': 'Could not start the timer',
    'time.timerStopped': 'Timer stopped',
    'time.timerStopFailed': 'Could not stop the timer',
    'time.weekTotal': 'Week total',
    'time.noEntriesWeek': 'No time logged this week',
    'time.noEntriesWeekHint': 'Start a timer or add a manual entry to see it here.',
    'time.startTimerTitle': 'Start a timer',
    'time.taskIdRequired': 'Task ID is required',
    'time.optionalNote': 'Note (optional)',
    'time.today': 'Today',
    'time.task': 'Task',
    'time.taskRequired': 'Pick a task first.',
    'time.pickTask': 'Pick a task…',
    'time.noMyTasks': 'No tasks assigned to you yet – create or pick up a task first.',
    'time.durationRequired': 'Enter a duration in minutes.',
    'time.groupTask': 'Task',
    'time.billableHours': 'Billable h',
    'time.amount': 'Billable amount',
    'time.period.week': 'This week',
    'time.period.lastWeek': 'Last week',
    'time.period.month': 'This month',
    'time.period.lastMonth': 'Last month',
    'time.period.year': 'This year',
    'time.period.all': 'All time',
    'time.byTask': 'By task',
    'time.byPerson': 'By person',
    'time.byProject': 'By project',
    'time.entries': 'Entries',
    'time.latestEntries': 'Latest {n} entries',
    'time.reportTotal': 'Total',
    'time.openDetails': 'Open details',
    'time.status': 'Status',
    'time.lastLogged': 'Last logged',
    'time.ofEstimate': 'of {h}',
    'time.overEstimate': 'Over the {h} estimate',
  },
  uk: {
    'time.timerIdle': 'Таймер не запущено',
    'time.timerIdleHint': 'Запустіть таймер для задачі, щоб рахувати час під час роботи.',
    'time.timerStarted': 'Таймер запущено',
    'time.timerStartFailed': 'Не вдалося запустити таймер',
    'time.timerStopped': 'Таймер зупинено',
    'time.timerStopFailed': 'Не вдалося зупинити таймер',
    'time.weekTotal': 'Разом за тиждень',
    'time.noEntriesWeek': 'Цього тижня немає записів часу',
    'time.noEntriesWeekHint': 'Запустіть таймер або додайте запис вручну, щоб побачити його тут.',
    'time.startTimerTitle': 'Запустити таймер',
    'time.taskIdRequired': 'Потрібен ID задачі',
    'time.optionalNote': 'Нотатка (необов’язково)',
    'time.today': 'Сьогодні',
    'time.task': 'Задача',
    'time.taskRequired': 'Спершу оберіть задачу.',
    'time.pickTask': 'Оберіть задачу…',
    'time.noMyTasks': 'На вас ще немає задач – спершу створіть або візьміть задачу.',
    'time.durationRequired': 'Вкажіть тривалість у хвилинах.',
    'time.groupTask': 'Задача',
    'time.billableHours': 'Оплачувані год',
    'time.amount': 'Сума до оплати',
    'time.period.week': 'Цей тиждень',
    'time.period.lastWeek': 'Минулий тиждень',
    'time.period.month': 'Цей місяць',
    'time.period.lastMonth': 'Минулий місяць',
    'time.period.year': 'Цей рік',
    'time.period.all': 'Весь час',
    'time.byTask': 'За задачами',
    'time.byPerson': 'За людьми',
    'time.byProject': 'За проєктами',
    'time.entries': 'Записи',
    'time.latestEntries': 'Останні {n} записів',
    'time.reportTotal': 'Разом',
    'time.openDetails': 'Відкрити деталі',
    'time.status': 'Статус',
    'time.lastLogged': 'Останній запис',
    'time.ofEstimate': 'з {h}',
    'time.overEstimate': 'Більше за оцінку {h}',
  },
});

interface DayGroup { date: string; entries: TimeEntry[] }
interface MyWeek { weekStart?: string; days?: DayGroup[] }
interface ReportRow {
  key: string; label?: string | null; ref?: string; projectId?: string;
  hours?: number; billableHours?: number; amount?: number; billableAmount?: number; currency?: string;
  /** When time was last logged in the row, in every grouping. */
  lastAt?: string | null;
  /** Task grouping only: enough to read the list without opening each task. */
  projectName?: string;
  status?: { name: string; category: string; color?: string | null };
  /** Set only when the project estimates in hours. */
  estimateHours?: number | null;
  people?: { id: string; name: string; avatar?: string | null; actorType?: string | null }[];
}

function mondayOf(d: Date): Date {
  const date = new Date(d);
  const dow = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - dow);
  date.setHours(0, 0, 0, 0);
  return date;
}
function fmtClock(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function weekDates(weekStart: string): string[] {
  const base = new Date(weekStart + 'T00:00:00');
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    return isoDay(d);
  });
}
function dayLabel(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString(appLocale(), { weekday: 'long', month: 'short', day: 'numeric' });
}
/** Human, locale-aware week range, e.g. "20 Jul – 26 Jul" / "20 лип – 26 лип". */
function weekRangeLabel(weekStart: string): string {
  const start = new Date(weekStart + 'T00:00:00');
  const end = new Date(weekStart + 'T00:00:00');
  end.setDate(end.getDate() + 6);
  const sameMonth = start.getMonth() === end.getMonth();
  const startStr = start.toLocaleDateString(appLocale(), { month: 'short', day: 'numeric' });
  const endStr = end.toLocaleDateString(appLocale(), sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
  return `${startStr} – ${endStr}`;
}

export function TimePage() {
  const t = useT();
  const can = useCan();
  const [tab, setTab] = usePersistedState<'week' | 'reports'>('ordi:view:time.tab', 'week', oneOfPref(['week', 'reports'], 'week'));
  const canReports = can('time.read_all');

  const tabs = [
    { key: 'week' as const, label: t('time.myWeek') },
    ...(canReports ? [{ key: 'reports' as const, label: t('time.reports') }] : []),
  ];
  // A remembered tab the user can no longer open falls back to their week.
  const activeTab = tab === 'reports' && !canReports ? 'week' : tab;

  return (
    <div>
      <PageHeader
        title={t('nav.time')}
        breadcrumbs={<Breadcrumbs items={[{ label: t('nav.time') }]} />}
        actions={<SegmentedControl options={tabs} value={activeTab} onChange={setTab} />}
      />
      <Reveal key={activeTab}>{activeTab === 'week' ? <MyWeekView /> : <ReportsView />}</Reveal>
    </div>
  );
}

/* ───────────────────────── Timer hero ───────────────────────── */

function TimerHero() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const open = useOpen();
  const [showStart, setShowStart] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const timerQ = useActiveTimer(can('time.track'));
  const timer = timerQ.data ?? null;
  const elapsed = useTimerElapsed(timer, timerQ.dataUpdatedAt);

  // The timer names its task, not its project: one lookup finds where it lives.
  const taskQ = useQuery({
    queryKey: ['task', 'ref', timer?.taskId],
    queryFn: () => api.get<{ id: string; projectId: string }>(`/tasks/${timer!.taskId}`),
    enabled: !!timer?.taskId,
    staleTime: 60_000,
  });

  const start = useMutation({
    mutationFn: () => api.post('/time/timer/start', { taskId: taskId.trim(), note: note.trim() || undefined }),
    onSuccess: () => {
      setShowStart(false);
      setTaskId('');
      setNote('');
      toast(t('time.timerStarted'));
      invalidateTime(qc);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('time.timerStartFailed')),
  });
  const stop = useStopTimer();

  const canTrack = can('time.track');
  const taskHref = taskQ.data ? `/projects/${taskQ.data.projectId}/tasks/${taskQ.data.id}` : null;

  return (
    <>
      <Card className={cn('mb-5 flex flex-wrap items-center gap-4 p-4 sm:p-5', timer && 'border-primary/30 bg-primary/[0.04]')}>
        <div className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', timer ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
          <Timer size={20} className={timer ? 'anim-pop-in' : undefined} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[28px] font-semibold leading-none tabular-nums sm:text-[32px]">
            {timerQ.isLoading || (!timer && timerQ.isError) ? '—' : timer ? fmtClock(elapsed) : '00:00:00'}
          </div>
          <div className="mt-1.5 truncate text-[13px] text-muted-foreground">
            {timer ? (
              <>
                <button
                  type="button"
                  disabled={!taskHref}
                  onClick={(e) => taskHref && open(taskHref, e)}
                  onAuxClick={(e) => taskHref && open(taskHref, e)}
                  className="font-medium text-foreground underline-offset-2 hover:underline disabled:no-underline"
                >
                  {timer.ref && <span className="font-mono text-muted-foreground">{timer.ref} </span>}
                  {timer.title ?? timer.taskId}
                </button>
                {timer.note && <span> · {timer.note}</span>}
              </>
            ) : timerQ.isLoading ? t('common.loading') : timerQ.isError ? t('time.timerUnavailable', 'Could not check the timer. Retry') : t('time.timerIdle')}
          </div>
        </div>
        {canTrack && (
          timer ? (
            <Button variant="destructive" size="sm" onClick={() => stop.mutate(timer)} disabled={stop.isPending}>
              <Square size={13} /> {t('time.stopTimer')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => setShowStart(true)} disabled={timerQ.isLoading || timerQ.isError}>
              <Play size={13} /> {t('time.startTimer')}
            </Button>
          )
        )}
        {timerQ.isError && <button type="button" onClick={() => void timerQ.refetch()} className="w-full text-left text-xs text-destructive" role="status">{t('time.timerUnavailable', 'Could not check the timer. Retry')}</button>}
      </Card>

      <Dialog open={showStart} onClose={() => setShowStart(false)} title={t('time.startTimerTitle')} width={380}>
        <form
          className="space-y-3 px-4 pb-4 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            if (!taskId.trim()) { setFormError(t('time.taskRequired')); return; }
            start.mutate();
          }}
        >
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('time.task')}</label>
            <TaskSelect value={taskId} onChange={setTaskId} open={showStart} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('time.optionalNote')}</label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
          </div>
          {formError && <p className="text-xs text-destructive">{formError}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowStart(false)}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={start.isPending}><Play size={13} /> {t('time.startTimer')}</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

/* ───────────────────────── My week ───────────────────────── */

function MyWeekView() {
  const t = useT();
  const [weekStart, setWeekStart] = useState(() => isoDay(mondayOf(new Date())));
  const week = useQuery({
    queryKey: ['myWeek', weekStart],
    queryFn: () => {
      // The week runs Monday to Monday in the viewer's own time zone.
      const from = new Date(weekStart + 'T00:00:00');
      const to = new Date(from);
      to.setDate(to.getDate() + 7);
      return api.get<MyWeek>('/time/my-week' + qs({ weekStart, from: from.toISOString(), to: to.toISOString() }));
    },
  });

  const [showAdd, setShowAdd] = useState(false);
  const [openEntry, setOpenEntry] = useState<TimeEntry | null>(null);

  const dates = weekDates(weekStart);
  const today = isoDay(new Date());
  const rawEntries = (week.data?.days ?? []).flatMap((d) => d.entries);
  const byDate = new Map<string, TimeEntry[]>();
  for (const d of dates) byDate.set(d, []);
  for (const e of rawEntries) byDate.get(entryDay(e))?.push(e);
  const dayTotal = (d: string) => (byDate.get(d) ?? []).reduce((a, e) => a + Number(e.durationSeconds), 0);
  const weekTotal = dates.reduce((acc, d) => acc + dayTotal(d), 0);
  // Newest day first: today's work is what people come here for.
  const activeDays = dates.filter((d) => (byDate.get(d) ?? []).length > 0).reverse();
  const maxDay = Math.max(...dates.map(dayTotal), 1);
  const defaultDay = dates.includes(today) ? today : weekStart;

  const shift = (deltaDays: number) => {
    const d = new Date(weekStart + 'T00:00:00');
    d.setDate(d.getDate() + deltaDays);
    setWeekStart(isoDay(mondayOf(d)));
  };
  const scrollToDay = (d: string) => document.getElementById(`time-day-${d}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <PageBody>
      <TimerHero />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <IconButton size="sm" onClick={() => shift(-7)} aria-label="Previous week"><ChevronLeft size={15} /></IconButton>
          <span className="min-w-[8.5rem] text-center text-[13px] font-medium tabular-nums">{weekRangeLabel(weekStart)}</span>
          <IconButton size="sm" onClick={() => shift(7)} aria-label="Next week"><ChevronRight size={15} /></IconButton>
        </div>
        <button className="text-xs text-muted-foreground transition-colors hover:text-foreground" onClick={() => setWeekStart(isoDay(mondayOf(new Date())))}>{t('tasks.thisWeek')}</button>

        <Card className="ml-auto flex items-center gap-2.5 px-3 py-1.5">
          <span className="text-xs text-muted-foreground">{t('time.weekTotal')}</span>
          <span className="font-mono text-sm font-semibold tabular-nums">{fmtDur(weekTotal)}</span>
        </Card>
        <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
          <Plus size={13} /> {t('time.addEntry')}
        </Button>
      </div>

      {/* The week at a glance: one bar per day, a click jumps to that day. */}
      <div className="mb-5 grid grid-cols-7 gap-1.5">
        {dates.map((d) => {
          const secs = dayTotal(d);
          const date = new Date(d + 'T00:00:00');
          return (
            <button
              key={d}
              type="button"
              disabled={secs === 0}
              onClick={() => scrollToDay(d)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-lg border border-border px-1 py-2 transition-colors duration-150',
                secs > 0 ? 'hover:bg-muted/60' : 'cursor-default opacity-60',
                d === today && 'border-primary/40',
              )}
            >
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">{date.toLocaleDateString(appLocale(), { weekday: 'short' })}</span>
              <span className="flex h-8 w-2 items-end overflow-hidden rounded-full bg-muted">
                <span className="w-full rounded-full bg-primary/70" style={{ height: `${Math.round((secs / maxDay) * 100)}%` }} />
              </span>
              <span className={cn('font-mono text-[11px] tabular-nums', secs > 0 ? 'text-foreground' : 'text-faint')}>{secs > 0 ? fmtDur(secs) : '–'}</span>
            </button>
          );
        })}
      </div>

      {week.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-border">
              <Skeleton className="h-8 w-full rounded-none" />
              <EntryListSkeleton rows={2} />
            </div>
          ))}
        </div>
      ) : activeDays.length === 0 ? (
        <EmptyState
          icon={<Clock size={20} />}
          title={t('time.noEntriesWeek')}
          hint={t('time.noEntriesWeekHint')}
          action={<Button size="sm" variant="outline" onClick={() => setShowAdd(true)}><Plus size={13} /> {t('time.addEntry')}</Button>}
        />
      ) : (
        <div className="space-y-4">
          {activeDays.map((d, gi) => {
            const entries = [...(byDate.get(d) ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
            const label = d === today ? t('time.today') : dayLabel(d);
            return (
              <div id={`time-day-${d}`} key={d} className="row-enter scroll-mt-4 overflow-hidden rounded-xl border border-border bg-card" style={{ ['--i' as string]: Math.min(gi, 10) }}>
                <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-2">
                  <span className="text-[13px] font-medium">{label}</span>
                  <span className="font-mono text-xs font-medium tabular-nums text-muted-foreground">{fmtDur(dayTotal(d))}</span>
                </div>
                <div className="divide-y divide-border">
                  {entries.map((e) => <TimeEntryRow key={e.id} entry={e} onOpen={setOpenEntry} />)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <LogTimeDialog open={showAdd} onClose={() => setShowAdd(false)} defaultDay={defaultDay} />
      <TimeEntryPanel entry={openEntry} onClose={() => setOpenEntry(null)} />
    </PageBody>
  );
}

/* ───────────────────────── Reports ───────────────────────── */

type GroupBy = 'project' | 'user' | 'company' | 'task';
type Period = 'week' | 'lastWeek' | 'month' | 'lastMonth' | 'year' | 'all';
const PERIODS: Period[] = ['week', 'lastWeek', 'month', 'lastMonth', 'year', 'all'];
type ReportSortKey = 'name' | 'status' | 'last' | 'hours' | 'billable' | 'amount';
const REPORT_SORT_KEYS: ReportSortKey[] = ['name', 'status', 'last', 'hours', 'billable', 'amount'];
/** Statuses sort in lifecycle order, not alphabetically. */
const STATUS_RANK: Record<string, number> = { backlog: 0, todo: 1, in_progress: 2, done: 3, canceled: 4 };

function periodRange(p: Period): { from?: string; to?: string } {
  const now = new Date();
  switch (p) {
    case 'week': {
      const from = mondayOf(now);
      const to = new Date(from); to.setDate(to.getDate() + 6);
      return { from: isoDay(from), to: isoDay(to) };
    }
    case 'lastWeek': {
      const from = mondayOf(now); from.setDate(from.getDate() - 7);
      const to = new Date(from); to.setDate(to.getDate() + 6);
      return { from: isoDay(from), to: isoDay(to) };
    }
    case 'month':
      return { from: isoDay(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDay(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
    case 'lastMonth':
      return { from: isoDay(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: isoDay(new Date(now.getFullYear(), now.getMonth(), 0)) };
    case 'year':
      return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` };
    default:
      return {};
  }
}

/** The query parameter that narrows reports and entries to one row of a grouping. */
const FILTER_PARAM: Record<GroupBy, string> = { project: 'projectId', user: 'userId', company: 'companyId', task: 'taskId' };

function rowName(r: ReportRow, groupBy: GroupBy): string {
  if (groupBy === 'company' && r.key === 'internal') return r.label ?? '(internal)';
  return r.label ?? r.key ?? '–';
}

function ReportsView() {
  const t = useT();
  const [groupBy, setGroupBy] = usePersistedState<GroupBy>(
    'ordi:view:time.reports.groupBy', 'project', oneOfPref(['project', 'user', 'company', 'task'], 'project'),
  );
  const [period, setPeriod] = usePersistedState<Period>('ordi:view:time.reports.period', 'month', oneOfPref(PERIODS, 'month'));
  const range = periodRange(period);
  const report = useQuery({
    queryKey: ['timeReport', groupBy, range.from, range.to],
    queryFn: () => api.get<{ data: ReportRow[] }>('/time/reports' + qs({ groupBy, ...range })),
  });
  const [selected, setSelected] = useState<ReportRow | null>(null);
  const rows = report.data?.data ?? [];
  const { sort: storedSort, toggle: toggleSort } = useTableSort<ReportSortKey>({
    key: 'ordi:view:time.reports.sort',
    keys: REPORT_SORT_KEYS,
  });
  const isTask = groupBy === 'task';
  // Unsorted means most time first, and the Hours header says so. Status
  // exists only for tasks, so another grouping falls back to the same.
  const sort: SortState<ReportSortKey> = storedSort && (isTask || storedSort.key !== 'status')
    ? storedSort : { key: 'hours', dir: 'desc' };
  const sorted = sortRows(rows, sort, (r, key) => {
    switch (key) {
      case 'name': return rowName(r, groupBy).toLowerCase() || null;
      case 'status': return r.status ? `${STATUS_RANK[r.status.category] ?? 9}:${r.status.name.toLowerCase()}` : null;
      case 'last': return r.lastAt ?? null;
      case 'hours': return r.hours ?? 0;
      case 'billable': return r.billableHours ?? 0;
      case 'amount': return r.billableAmount ?? 0;
    }
  });
  const totalHours = rows.reduce((a, r) => a + (r.hours ?? 0), 0);
  const totalBillable = rows.reduce((a, r) => a + (r.billableHours ?? 0), 0);
  // Amounts add up only within one currency.
  const currencies = new Set(rows.map((r) => r.currency ?? 'USD'));
  const totalAmount = currencies.size === 1 ? rows.reduce((a, r) => a + (r.billableAmount ?? 0), 0) : null;
  // Spans every column the widest layout shows; extra span is harmless when some hide.
  const columns = isTask ? 6 : 5;
  const groupLabel = t(groupBy === 'project' ? 'time.groupProject' : groupBy === 'user' ? 'time.groupUser' : groupBy === 'company' ? 'time.groupCompany' : 'time.groupTask');

  return (
    <PageBody width="wide">
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('time.groupBy')}</span>
          <SegmentedControl
            options={[
              { key: 'project' as const, label: t('time.groupProject') },
              { key: 'task' as const, label: t('time.groupTask') },
              { key: 'user' as const, label: t('time.groupUser') },
              { key: 'company' as const, label: t('time.groupCompany') },
            ]}
            value={groupBy}
            onChange={setGroupBy}
          />
        </div>
        <Select value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="ml-auto w-44" aria-label="Period">
          {PERIODS.map((p) => <option key={p} value={p}>{t(`time.period.${p}`)}</option>)}
        </Select>
      </div>
      <Card className="overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-[11px]">
              <th className="w-full px-4 py-2"><SortHeader label={groupLabel} sortKey="name" sort={sort} onToggle={toggleSort} /></th>
              {isTask && (
                <th className="hidden px-3 py-2 md:table-cell"><SortHeader label={t('time.status')} sortKey="status" sort={sort} onToggle={toggleSort} /></th>
              )}
              <th className="hidden px-3 py-2 sm:table-cell"><SortHeader label={t('time.lastLogged')} sortKey="last" sort={sort} onToggle={toggleSort} className="whitespace-nowrap" /></th>
              <th className="px-3 py-2"><SortHeader label={t('time.hours')} sortKey="hours" sort={sort} onToggle={toggleSort} className="w-full justify-end" /></th>
              <th className="hidden px-3 py-2 lg:table-cell"><SortHeader label={t('time.billableHours')} sortKey="billable" sort={sort} onToggle={toggleSort} className="w-full justify-end whitespace-nowrap" /></th>
              <th className="hidden py-2 pl-3 pr-4 md:table-cell"><SortHeader label={t('time.amount')} sortKey="amount" sort={sort} onToggle={toggleSort} className="w-full justify-end whitespace-nowrap" /></th>
            </tr>
          </thead>
          <tbody>
            {report.isLoading && (
              <tr><td colSpan={columns} className="px-4 py-3"><Skeleton className="h-5 w-full" /></td></tr>
            )}
            {!report.isLoading && rows.length === 0 && (
              <tr><td colSpan={columns} className="px-4 py-10 text-center text-muted-foreground">{t('time.noReportData')}</td></tr>
            )}
            {sorted.map((r, i) => (
              <tr
                key={r.key ?? String(i)}
                tabIndex={0}
                role="button"
                aria-label={`${t('time.openDetails')}: ${rowName(r, groupBy)}`}
                onClick={() => setSelected(r)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(r); } }}
                className="row-enter group cursor-pointer border-b border-border transition-colors duration-150 last:border-0 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none"
                style={{ ['--i' as string]: Math.min(i, 10) }}
              >
                {/* max-w-0 lets a long name truncate instead of pushing the numbers out of the card. */}
                <td className="max-w-0 px-4 py-2.5">
                  <div className="flex min-w-0 items-center gap-2 font-medium">
                    {groupBy === 'user' && <Avatar name={rowName(r, groupBy)} size={18} />}
                    {r.ref && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{r.ref}</span>}
                    <span className="truncate" title={rowName(r, groupBy)}>{rowName(r, groupBy)}</span>
                    <ChevronRight size={13} className="shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                  {isTask && <TaskFacts row={r} />}
                </td>
                {isTask && (
                  <td className="hidden whitespace-nowrap px-3 py-2.5 md:table-cell">
                    {r.status && (
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <StatusIcon category={r.status.category} color={r.status.color ?? undefined} size={13} />
                        {r.status.name}
                      </span>
                    )}
                  </td>
                )}
                <td className="hidden whitespace-nowrap px-3 py-2.5 text-muted-foreground sm:table-cell" title={r.lastAt ? formatDateTime(r.lastAt) : undefined}>
                  {r.lastAt ? fmtRelative(r.lastAt) : '–'}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right tabular-nums">
                  <div className="font-medium">{fmtHours(r.hours)}</div>
                  {r.estimateHours ? <EstimateLine hours={r.hours ?? 0} estimate={r.estimateHours} /> : null}
                </td>
                <td className="hidden whitespace-nowrap px-3 py-2.5 text-right tabular-nums text-muted-foreground lg:table-cell">{fmtHours(r.billableHours)}</td>
                <td className="hidden whitespace-nowrap py-2.5 pl-3 pr-4 text-right tabular-nums md:table-cell">{r.billableAmount ? fmtMoney(r.billableAmount, r.currency ?? 'USD') : '–'}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 1 && (
            <tfoot>
              <tr className="border-t border-border bg-muted/30 font-medium">
                <td className="px-4 py-2">{t('time.reportTotal')}</td>
                {isTask && <td className="hidden md:table-cell" />}
                <td className="hidden sm:table-cell" />
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{fmtHours(totalHours)}</td>
                <td className="hidden whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted-foreground lg:table-cell">{fmtHours(totalBillable)}</td>
                <td className="hidden whitespace-nowrap py-2 pl-3 pr-4 text-right tabular-nums md:table-cell">{totalAmount ? fmtMoney(totalAmount, [...currencies][0]!) : '–'}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </Card>

      <ReportDetailPanel
        groupBy={groupBy}
        row={selected}
        range={range}
        periodLabel={t(`time.period.${period}`)}
        onClose={() => setSelected(null)}
      />
    </PageBody>
  );
}

function fmtHours(h?: number): string {
  return h ? fmtDur(Math.round(h * 3600)) : '–';
}

/** Under a task's name: its project, its status on narrow screens, and who logged the time. */
function TaskFacts({ row }: { row: ReportRow }) {
  return (
    <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground">
      {row.status && (
        <span className="inline-flex shrink-0 items-center gap-1 md:hidden" title={row.status.name}>
          <StatusIcon category={row.status.category} color={row.status.color ?? undefined} size={12} />
          <span className="max-w-[8rem] truncate">{row.status.name}</span>
        </span>
      )}
      {row.projectName && <span className="truncate">{row.projectName}</span>}
      {row.people && row.people.length > 0 && (
        <span className="ml-auto shrink-0" title={row.people.map((p) => p.name).join(', ')}>
          <AvatarGroup users={row.people} size={16} max={4} />
        </span>
      )}
    </div>
  );
}

/** Time against a task's estimate: "of 8h", amber once it runs over. */
function EstimateLine({ hours, estimate }: { hours: number; estimate: number }) {
  const t = useT();
  const est = fmtHours(estimate);
  const over = hours > estimate;
  return (
    <div
      className={cn('text-[11px]', over ? 'text-warning' : 'text-faint')}
      title={over ? t('time.overEstimate').replace('{h}', est) : undefined}
    >
      {t('time.ofEstimate').replace('{h}', est)}
    </div>
  );
}

/** Share of the largest row, as a thin bar behind a breakdown line. */
function Breakdown({ title, rows, render, onOpen }: {
  title: string; rows: ReportRow[]; render: (r: ReportRow) => ReactNode; onOpen?: (r: ReportRow, e: MouseEvent) => void;
}) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.hours ?? 0), 0.01);
  return (
    <section>
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{title}</h3>
      <div className="overflow-hidden rounded-lg border border-border">
        {rows.map((r) => {
          const Tag = onOpen ? 'button' : 'div';
          return (
            <Tag
              key={r.key}
              {...(onOpen ? { type: 'button' as const, onClick: (e: MouseEvent) => onOpen(r, e), onAuxClick: (e: MouseEvent) => onOpen(r, e) } : {})}
              className={cn('relative flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-[13px] last:border-0', onOpen && 'transition-colors duration-150 hover:bg-muted/40')}
            >
              <span aria-hidden className="absolute inset-y-0 left-0 bg-primary/[0.07]" style={{ width: `${((r.hours ?? 0) / max) * 100}%` }} />
              <span className="relative flex min-w-0 flex-1 items-center gap-2">{render(r)}</span>
              <span className="relative shrink-0 font-mono text-xs tabular-nums text-muted-foreground">{fmtHours(r.hours)}</span>
            </Tag>
          );
        })}
      </div>
    </section>
  );
}

const DETAIL_ENTRIES = 100;

/**
 * What one report row is made of: its tasks, its people and its entries, for
 * the same period. Every line leads further: a task opens, an entry opens in
 * its own panel.
 */
function ReportDetailPanel({ groupBy, row, range, periodLabel, onClose }: {
  groupBy: GroupBy; row: ReportRow | null; range: { from?: string; to?: string }; periodLabel: string; onClose: () => void;
}) {
  const t = useT();
  const open = useOpen();
  const [shown, setShown] = useState<ReportRow | null>(row);
  if (row && row !== shown) setShown(row);
  const [openEntry, setOpenEntry] = useState<TimeEntry | null>(null);
  const filter = shown ? { [FILTER_PARAM[groupBy]]: shown.key } : {};
  const enabled = !!row;

  const byTask = useQuery({
    queryKey: ['timeReport', 'detail', 'task', groupBy, shown?.key, range.from, range.to],
    queryFn: () => api.get<{ data: ReportRow[] }>('/time/reports' + qs({ groupBy: 'task', ...range, ...filter })),
    enabled: enabled && groupBy !== 'task',
  });
  const byUser = useQuery({
    queryKey: ['timeReport', 'detail', 'user', groupBy, shown?.key, range.from, range.to],
    queryFn: () => api.get<{ data: ReportRow[] }>('/time/reports' + qs({ groupBy: 'user', ...range, ...filter })),
    enabled: enabled && groupBy !== 'user',
  });
  const byProject = useQuery({
    queryKey: ['timeReport', 'detail', 'project', groupBy, shown?.key, range.from, range.to],
    queryFn: () => api.get<{ data: ReportRow[] }>('/time/reports' + qs({ groupBy: 'project', ...range, ...filter })),
    enabled: enabled && (groupBy === 'user' || groupBy === 'company'),
  });
  const entries = useQuery({
    queryKey: ['timeEntries', groupBy, shown?.key, range.from, range.to],
    queryFn: () => api.get<{ data: TimeEntry[]; nextCursor: string | null }>('/time/entries' + qs({ ...range, ...filter, limit: DETAIL_ENTRIES })),
    enabled,
  });

  if (!shown) return null;
  const name = rowName(shown, groupBy);
  const stats: [string, string][] = [
    [t('time.hours'), fmtHours(shown.hours)],
    [t('time.billableHours'), fmtHours(shown.billableHours)],
    [t('time.amount'), shown.billableAmount ? fmtMoney(shown.billableAmount, shown.currency ?? 'USD') : '–'],
  ];
  const openTask = (r: ReportRow, e: MouseEvent) => {
    if (!r.projectId) return;
    if (e.button === 0 && !e.metaKey && !e.ctrlKey) onClose();
    open(`/projects/${r.projectId}/tasks/${r.key}`, e);
  };
  const entryRows = entries.data?.data ?? [];

  return (
    <>
      <SidePanel
        open={!!row}
        onClose={onClose}
        width={560}
        icon={groupBy === 'user' ? <Avatar name={name} size={22} /> : <BarChart3 size={16} />}
        title={shown.ref ? `${shown.ref} · ${name}` : name}
        subtitle={periodLabel}
      >
        <div className="space-y-5">
          <div className="grid grid-cols-3 gap-2">
            {stats.map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border px-3 py-2">
                <div className="text-[11px] text-muted-foreground">{label}</div>
                <div className="mt-0.5 font-mono text-[15px] font-semibold tabular-nums">{value}</div>
              </div>
            ))}
          </div>

          {groupBy === 'task' && shown.projectId && (
            <Button size="sm" variant="outline" onClick={(e) => openTask(shown, e)} onAuxClick={(e) => openTask(shown, e)}>
              {t('time.openTask')} <ChevronRight size={13} />
            </Button>
          )}

          {(groupBy === 'user' || groupBy === 'company') && (
            byProject.isLoading ? <EntryListSkeleton rows={2} /> : (
              <Breakdown title={t('time.byProject')} rows={byProject.data?.data ?? []} render={(r) => <span className="truncate">{r.label}</span>} />
            )
          )}
          {groupBy !== 'task' && (
            byTask.isLoading ? <EntryListSkeleton rows={3} /> : (
              <Breakdown
                title={t('time.byTask')}
                rows={byTask.data?.data ?? []}
                onOpen={openTask}
                render={(r) => (
                  <>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{r.ref}</span>
                    <span className="truncate">{r.label}</span>
                  </>
                )}
              />
            )
          )}
          {groupBy !== 'user' && (
            byUser.isLoading ? <EntryListSkeleton rows={2} /> : (
              <Breakdown
                title={t('time.byPerson')}
                rows={byUser.data?.data ?? []}
                render={(r) => <><Avatar name={r.label ?? '?'} size={18} /><span className="truncate">{r.label}</span></>}
              />
            )
          )}

          <section>
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
              {entries.data?.nextCursor ? t('time.latestEntries').replace('{n}', String(DETAIL_ENTRIES)) : t('time.entries')}
            </h3>
            <div className="overflow-hidden rounded-lg border border-border">
              {entries.isLoading ? <EntryListSkeleton rows={4} /> : (
                <div className="divide-y divide-border">
                  {entryRows.map((e) => (
                    <TimeEntryRow key={e.id} entry={e} onOpen={setOpenEntry} showUser={groupBy !== 'user'} showDay showProject={groupBy === 'user' || groupBy === 'company'} className="px-3" />
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </SidePanel>
      <TimeEntryPanel entry={openEntry} onClose={() => setOpenEntry(null)} />
    </>
  );
}
