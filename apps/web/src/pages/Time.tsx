import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useCan } from '../lib/auth';
import {
  Button, IconButton, Input, Textarea, Card, PageHeader, PageBody, Breadcrumbs, EmptyState, Skeleton,
  SegmentedControl, Select, fmtMoney, appLocale, cn,
} from '../components/ui';
import { Dialog, toast } from '../components/overlays';
import { ChevronLeft, ChevronRight, Plus, Play, Square, Clock, Timer } from 'lucide-react';
import { useT, extendDict } from '../lib/i18n';

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
  },
});

interface TimeEntry {
  id: string;
  taskId?: string | null;
  taskRef?: string | null;
  projectName?: string | null;
  durationSeconds: number | string;
  note?: string | null;
  startedAt?: string | null;
  date?: string | null;
}
interface DayGroup { date: string; entries: TimeEntry[] }
interface MyWeek { weekStart?: string; days?: DayGroup[]; entries?: TimeEntry[]; totalSeconds?: number | string }
interface ReportRow { key?: string; label?: string; name?: string; hours?: number | string; seconds?: number | string; billableAmount?: number | string; currency?: string }
interface ActiveTimer { userId?: string; taskId: string; startedAt: string; note?: string | null; elapsedSeconds: number }
interface TaskLite { id: string; ref?: string | null; title?: string | null }

interface MyTaskLite { id: string; title: string; ref?: string | null; key?: string | null; number?: number | null }
interface MeTasksBuckets { overdue?: MyTaskLite[]; today?: MyTaskLite[]; week?: MyTaskLite[]; later?: MyTaskLite[] }

/** The user's open tasks, flattened for the timer/entry task pickers. */
function useMyTaskOptions(enabled: boolean): { id: string; label: string }[] {
  const q = useQuery({
    queryKey: ['me', 'tasks'],
    queryFn: () => api.get<MeTasksBuckets>('/me/tasks'),
    enabled,
    staleTime: 30_000,
  });
  const seen = new Set<string>();
  const out: { id: string; label: string }[] = [];
  for (const bucket of [q.data?.overdue, q.data?.today, q.data?.week, q.data?.later]) {
    for (const task of bucket ?? []) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      const ref = task.ref ?? (task.key && task.number != null ? `${task.key}-${task.number}` : '');
      out.push({ id: task.id, label: ref ? `${ref} · ${task.title}` : task.title });
    }
  }
  return out;
}

/** Task dropdown for time tracking – replaces the old raw "task id" input. */
function TaskSelect({ value, onChange, open }: { value: string; onChange: (id: string) => void; open: boolean }) {
  const t = useT();
  const options = useMyTaskOptions(open);
  if (open && options.length === 0) {
    return <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">{t('time.noMyTasks')}</p>;
  }
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-full">
      <option value="">{t('time.pickTask')}</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </Select>
  );
}

function mondayOf(d: Date): Date {
  const date = new Date(d);
  const dow = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - dow);
  date.setHours(0, 0, 0, 0);
  return date;
}
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m > 0 ? m + 'm' : ''}`.trim() : `${m}m`;
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
    return isoDate(d);
  });
}
function entryDate(e: TimeEntry): string {
  return (e.date ?? e.startedAt ?? '').slice(0, 10);
}
function dayLabel(iso: string): string {
  const today = isoDate(new Date());
  if (iso === today) return '';
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
  const [tab, setTab] = useState<'week' | 'reports'>('week');
  const canReports = can('time.read_all');

  const tabs = [
    { key: 'week' as const, label: t('time.myWeek') },
    ...(canReports ? [{ key: 'reports' as const, label: t('time.reports') }] : []),
  ];

  return (
    <div>
      <PageHeader
        title={t('nav.time')}
        breadcrumbs={<Breadcrumbs items={[{ label: t('nav.time') }]} />}
        actions={<SegmentedControl options={tabs} value={tab} onChange={setTab} />}
      />
      {tab === 'week' ? <MyWeekView /> : <ReportsView />}
    </div>
  );
}

/* ───────────────────────── Timer hero ───────────────────────── */

function TimerHero({ onChange }: { onChange: () => void }) {
  const t = useT();
  const can = useCan();
  const [tick, setTick] = useState(0);
  const [showStart, setShowStart] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [note, setNote] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  const timerQ = useQuery({
    queryKey: ['timer'],
    queryFn: () => api.get<ActiveTimer | null>('/time/timer').catch(() => null),
    refetchInterval: 30_000,
  });
  const timer = timerQ.data ?? null;

  useEffect(() => {
    if (!timer) return;
    const i = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(i);
  }, [timer]);
  useEffect(() => { setTick(0); }, [timer?.startedAt]);

  const taskQ = useQuery({
    queryKey: ['task', 'ref', timer?.taskId],
    queryFn: () => api.get<TaskLite>(`/tasks/${timer!.taskId}`),
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
      onChange();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('time.timerStartFailed')),
  });
  const stop = useMutation({
    mutationFn: () => api.post('/time/timer/stop'),
    onSuccess: () => { toast(t('time.timerStopped')); onChange(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('time.timerStopFailed')),
  });

  const canTrack = can('time.track');
  const elapsed = timer ? Number(timer.elapsedSeconds ?? 0) + tick : 0;
  const ref = taskQ.data?.ref ?? taskQ.data?.title ?? timer?.taskId;

  return (
    <>
      <Card className={cn('mb-5 flex flex-wrap items-center gap-4 p-4 sm:p-5', timer && 'border-primary/30 bg-primary/[0.04]')}>
        <div className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', timer ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground')}>
          <Timer size={20} className={timer ? 'anim-pop-in' : undefined} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[28px] font-semibold leading-none tabular-nums sm:text-[32px]">
            {timer ? fmtClock(elapsed) : '00:00:00'}
          </div>
          <div className="mt-1.5 truncate text-[13px] text-muted-foreground">
            {timer ? (
              <>
                <span className="font-medium text-foreground">{ref}</span>
                {timer.note && <span> · {timer.note}</span>}
              </>
            ) : t('time.timerIdle')}
          </div>
        </div>
        {canTrack && (
          timer ? (
            <Button variant="destructive" size="sm" onClick={() => stop.mutate()} disabled={stop.isPending}>
              <Square size={13} /> {t('time.stopTimer')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => setShowStart(true)}>
              <Play size={13} /> {t('time.startTimer')}
            </Button>
          )
        )}
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
  const qc = useQueryClient();
  const [weekStart, setWeekStart] = useState(() => isoDate(mondayOf(new Date())));
  const week = useQuery({
    queryKey: ['myWeek', weekStart],
    queryFn: () => api.get<MyWeek>('/time/my-week' + qs({ weekStart })),
  });

  const invalidateTime = () => {
    qc.invalidateQueries({ queryKey: ['myWeek'] });
    qc.invalidateQueries({ queryKey: ['timer'] });
  };

  const [showAdd, setShowAdd] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [form, setForm] = useState({ taskId: '', date: weekStart, minutes: '', note: '' });
  const addEntry = useMutation({
    mutationFn: () =>
      api.post('/time/entries', {
        taskId: form.taskId,
        date: form.date,
        startedAt: form.date,
        durationSeconds: Math.round(Number(form.minutes) * 60),
        note: form.note,
      }),
    onSuccess: () => {
      setShowAdd(false);
      setForm({ taskId: '', date: weekStart, minutes: '', note: '' });
      toast(t('common.saved'));
      invalidateTime();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('time.addEntryFailed')),
  });

  const dates = weekDates(weekStart);
  const rawEntries = week.data?.days ? week.data.days.flatMap((d) => d.entries.map((e) => ({ ...e, date: e.date ?? d.date }))) : week.data?.entries ?? [];
  const byDate = new Map<string, TimeEntry[]>();
  for (const d of dates) byDate.set(d, []);
  for (const e of rawEntries) {
    const key = entryDate(e);
    const bucket = byDate.get(key);
    if (bucket) bucket.push(e);
  }
  const weekTotal = rawEntries.reduce((acc, e) => acc + Number(e.durationSeconds), 0);
  const activeDays = dates.filter((d) => (byDate.get(d) ?? []).length > 0);

  const shift = (deltaDays: number) => {
    const d = new Date(weekStart + 'T00:00:00');
    d.setDate(d.getDate() + deltaDays);
    setWeekStart(isoDate(mondayOf(d)));
  };

  return (
    <PageBody>
      <TimerHero onChange={invalidateTime} />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <IconButton size="sm" onClick={() => shift(-7)} aria-label="Previous week"><ChevronLeft size={15} /></IconButton>
          <span className="min-w-[8.5rem] text-center text-[13px] font-medium tabular-nums">{weekRangeLabel(weekStart)}</span>
          <IconButton size="sm" onClick={() => shift(7)} aria-label="Next week"><ChevronRight size={15} /></IconButton>
        </div>
        <button className="text-xs text-muted-foreground transition-colors hover:text-foreground" onClick={() => setWeekStart(isoDate(mondayOf(new Date())))}>{t('tasks.thisWeek')}</button>

        <Card className="ml-auto flex items-center gap-2.5 px-3 py-1.5">
          <span className="text-xs text-muted-foreground">{t('time.weekTotal')}</span>
          <span className="font-mono text-sm font-semibold tabular-nums">{fmtDur(weekTotal)}</span>
        </Card>
        <Button size="sm" variant="outline" onClick={() => { setForm((f) => ({ ...f, date: weekStart })); setShowAdd(true); }}>
          <Plus size={13} /> {t('time.addEntry')}
        </Button>
      </div>

      {week.isLoading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="overflow-hidden rounded-xl border border-border">
              <Skeleton className="h-8 w-full rounded-none" />
              <div className="space-y-2 p-3">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
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
            const entries = byDate.get(d) ?? [];
            const dayTotal = entries.reduce((a, e) => a + Number(e.durationSeconds), 0);
            const label = dayLabel(d) || t('time.today');
            return (
              <div key={d} className="row-enter overflow-hidden rounded-xl border border-border bg-card" style={{ ['--i' as string]: Math.min(gi, 10) }}>
                <div className="flex items-center justify-between border-b border-border bg-muted/40 px-4 py-2">
                  <span className="text-[13px] font-medium">{label}</span>
                  <span className="font-mono text-xs font-medium tabular-nums text-muted-foreground">{fmtDur(dayTotal)}</span>
                </div>
                <div className="divide-y divide-border">
                  {entries.map((e) => (
                    <div key={e.id} className="flex items-center gap-3 px-4 py-2.5 transition-colors duration-150 hover:bg-muted/40">
                      <div className="min-w-0 flex-1">
                        {/* Fall back to the note as the primary line instead of a literal "Entry". */}
                        <div className="truncate text-[13px] font-medium">{e.taskRef ?? e.projectName ?? e.note ?? t('time.entry')}</div>
                        {e.note && (e.taskRef || e.projectName) && <div className="truncate text-xs text-muted-foreground">{e.note}</div>}
                      </div>
                      <span className="shrink-0 font-mono text-[13px] tabular-nums text-muted-foreground">{fmtDur(Number(e.durationSeconds))}</span>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={showAdd} onClose={() => setShowAdd(false)} title={t('time.addManualEntry')} width={420}>
        <form
          className="space-y-3 px-4 pb-4 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            setAddError(null);
            if (!form.taskId) { setAddError(t('time.taskRequired')); return; }
            if (!(Number(form.minutes) > 0)) { setAddError(t('time.durationRequired')); return; }
            addEntry.mutate();
          }}
        >
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('time.task')}</label>
            <TaskSelect value={form.taskId} onChange={(id) => setForm((f) => ({ ...f, taskId: id }))} open={showAdd} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('common.date')}</label>
              <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('time.durationMinutes')}</label>
              <Input type="number" min={1} value={form.minutes} onChange={(e) => setForm((f) => ({ ...f, minutes: e.target.value }))} placeholder="60" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('time.note')}</label>
              <Input value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
            </div>
          </div>
          {(addError || addEntry.isError) && (
            <p className="text-xs text-destructive">{addError ?? t('time.addEntryFailed')}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowAdd(false)}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={addEntry.isPending}><Plus size={13} /> {t('time.addEntry')}</Button>
          </div>
        </form>
      </Dialog>
    </PageBody>
  );
}

/* ───────────────────────── Reports ───────────────────────── */

function ReportsView() {
  const t = useT();
  const [groupBy, setGroupBy] = useState<'project' | 'user' | 'company'>('project');
  const report = useQuery({
    queryKey: ['timeReport', groupBy],
    queryFn: () => api.get<{ data: ReportRow[] }>('/time/reports' + qs({ groupBy })),
  });
  const rows = report.data?.data ?? [];
  const hoursOf = (r: ReportRow): number => (r.hours != null ? Number(r.hours) : r.seconds != null ? Number(r.seconds) / 3600 : 0);

  return (
    <PageBody>
      <div className="mb-4 flex items-center gap-2">
        <span className="text-xs text-muted-foreground">{t('time.groupBy')}</span>
        <SegmentedControl
          options={[
            { key: 'project' as const, label: t('time.groupProject') },
            { key: 'user' as const, label: t('time.groupUser') },
            { key: 'company' as const, label: t('time.groupCompany') },
          ]}
          value={groupBy}
          onChange={setGroupBy}
        />
      </div>
      <Card className="overflow-hidden">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">{t(groupBy === 'project' ? 'time.groupProject' : groupBy === 'user' ? 'time.groupUser' : 'time.groupCompany')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('time.hours')}</th>
              <th className="px-4 py-2 text-right font-medium">{t('time.billable')}</th>
            </tr>
          </thead>
          <tbody>
            {report.isLoading && (
              <tr><td colSpan={3} className="px-4 py-3"><Skeleton className="h-5 w-full" /></td></tr>
            )}
            {!report.isLoading && rows.length === 0 && (
              <tr><td colSpan={3} className="px-4 py-10 text-center text-muted-foreground">{t('time.noReportData')}</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.key ?? r.name ?? r.label ?? String(i)} className="row-enter border-b border-border transition-colors duration-150 last:border-0 hover:bg-muted/40" style={{ ['--i' as string]: Math.min(i, 10) }}>
                <td className="px-4 py-2 font-medium">{r.label ?? r.name ?? r.key ?? '–'}</td>
                <td className="px-4 py-2 text-right tabular-nums">{hoursOf(r).toFixed(1)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{r.billableAmount != null ? fmtMoney(r.billableAmount, r.currency ?? 'USD') : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </PageBody>
  );
}
