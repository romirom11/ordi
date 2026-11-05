/**
 * The project's plan: milestones (what, and by when) and – when the project
 * works in them – cycles (what this week or two holds). The two never nest:
 * a task may sit in a milestone, a cycle, both or neither. They meet here
 * only: each milestone says how much of it the current cycle carries, the
 * current cycle says which milestones it moves, and one action pulls a
 * milestone's open tasks into the current cycle – sprint planning in a click.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, CalendarDays, ChevronRight, Diamond, Plus } from 'lucide-react';
import { api, getAllPages, ApiError } from '../../lib/api';
import { useT, extendDict } from '../../lib/i18n';
import type { OpenIntent } from '../../lib/router';
import { Button, EmptyState, Input, PageBody, ProgressBar, Skeleton, Spinner, fmtDate, cn } from '../ui';
import { Dialog, toast } from '../overlays';
import { DateField } from '../DatePicker';
import { useTaskStatuses } from '../../lib/queries';
import { CycleDetailsDialog } from './CycleDetails';
import { ProjectMilestones, type Milestone } from './ProjectMilestones';

extendDict({
  en: {
    'plan.title': 'Plan',
    'plan.milestonesHint': 'Stages of the project – what is delivered, and by when.',
    'plan.cycles': 'Cycles',
    'plan.cyclesHint': 'Time boxes – what the team takes on this week or two.',
    'plan.current': 'Current cycle',
    'plan.daysLeft': '{n} days left',
    'plan.lastDay': 'Last day',
    'plan.ended': 'Ended {date} – complete it to roll open tasks over',
    'plan.startsIn': 'Starts {date}',
    'plan.byMilestone': 'By milestone',
    'plan.noMilestone': 'No milestone',
    'plan.empty': 'No tasks in this cycle yet. Pull a milestone\'s open tasks in from the list above, or set the cycle on a task.',
    'plan.upcoming': 'Upcoming',
    'plan.completed': 'Completed ({n})',
    'plan.open': 'Open',
    'plan.pulled': '{n} tasks moved into {cycle}',
    'plan.cyclesOff': 'Cycles are off for this project. Turn them on in the project settings if the team works in sprints.',
  },
  uk: {
    'plan.title': 'План',
    'plan.milestonesHint': 'Етапи проєкту – що здається і до коли.',
    'plan.cycles': 'Цикли',
    'plan.cyclesHint': 'Відрізки часу – що команда бере на цей тиждень чи два.',
    'plan.current': 'Поточний цикл',
    'plan.daysLeft': 'Залишилось днів: {n}',
    'plan.lastDay': 'Останній день',
    'plan.ended': 'Закінчився {date} – завершіть його, щоб перенести відкриті задачі',
    'plan.startsIn': 'Починається {date}',
    'plan.byMilestone': 'За етапами',
    'plan.noMilestone': 'Без етапу',
    'plan.empty': 'У циклі ще немає задач. Візьміть відкриті задачі етапу зі списку вище або вкажіть цикл у задачі.',
    'plan.upcoming': 'Наступні',
    'plan.completed': 'Завершені ({n})',
    'plan.open': 'Відкрити',
    'plan.pulled': 'Перенесено задач у {cycle}: {n}',
    'plan.cyclesOff': 'Цикли для цього проєкту вимкнені. Увімкніть їх у налаштуваннях проєкту, якщо команда працює спринтами.',
  },
});

export interface PlanCycle {
  id: string; name: string; startDate?: string; endDate?: string; status?: string; goal?: string | null;
}
interface PlanTask { id: string; statusId: string; milestoneId?: string | null; cycleId?: string | null; parentId?: string | null }

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Where a cycle stands today. A cycle past its end and not completed still counts as current: it needs closing. */
export function cyclePhase(c: PlanCycle, today = todayIso()): 'completed' | 'current' | 'upcoming' {
  if (c.status === 'completed') return 'completed';
  if (c.startDate && c.startDate > today) return 'upcoming';
  return 'current';
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

export function useCycles(projectId: string, enabled = true) {
  return useQuery<PlanCycle[]>({
    queryKey: ['cycles', projectId],
    queryFn: () => api.get<{ data: PlanCycle[] }>(`/projects/${projectId}/cycles`).then((r) => r.data),
    enabled,
  });
}

/** The cycle that is running now: the earliest-started one not completed and already begun. */
export function currentCycle(cycles: PlanCycle[]): PlanCycle | null {
  return cycles
    .filter((c) => cyclePhase(c) === 'current')
    .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''))[0] ?? null;
}

export function PlanTab({ projectId, projectKey, cyclesEnabled, canWrite, isAdmin, onOpenMilestoneTasks, onOpenTask }: {
  projectId: string; projectKey?: string; cyclesEnabled: boolean; canWrite: boolean; isAdmin: boolean;
  onOpenMilestoneTasks: (milestoneId: string) => void;
  onOpenTask?: (taskId: string, e?: OpenIntent) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const cyclesQ = useCycles(projectId, cyclesEnabled);
  const tasksQ = useQuery<PlanTask[]>({ queryKey: ['tasks', projectId], queryFn: () => getAllPages<PlanTask>('/tasks', { projectId }) });
  const milestonesQ = useQuery<Milestone[]>({
    queryKey: ['milestones', projectId],
    queryFn: () => api.get<{ data: Milestone[] }>(`/projects/${projectId}/milestones`).then((r) => r.data),
  });
  const statuses = useTaskStatuses(projectId).data ?? [];
  const [details, setDetails] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const cycles = cyclesQ.data ?? [];
  const tasks = tasksQ.data ?? [];
  const milestones = milestonesQ.data ?? [];
  const current = cyclesEnabled ? currentCycle(cycles) : null;
  const category = useMemo(() => new Map(statuses.map((s) => [s.id, s.category])), [statuses]);
  const isOpen = (tk: PlanTask) => !['done', 'canceled'].includes(category.get(tk.statusId) ?? '');

  // Milestone × current cycle: how many of each milestone's tasks the cycle carries.
  const inCurrent = useMemo(() => {
    const m = new Map<string, number>();
    if (!current) return m;
    for (const tk of tasks) if (tk.cycleId === current.id && tk.milestoneId) m.set(tk.milestoneId, (m.get(tk.milestoneId) ?? 0) + 1);
    return m;
  }, [tasks, current]);
  // Open tasks of a milestone that are not in the current cycle yet – what "pull in" would move.
  const pullable = useMemo(() => {
    const m = new Map<string, string[]>();
    if (!current) return m;
    for (const tk of tasks) {
      if (!tk.milestoneId || tk.cycleId === current.id || !isOpen(tk)) continue;
      m.set(tk.milestoneId, [...(m.get(tk.milestoneId) ?? []), tk.id]);
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, current, category]);

  const pull = useMutation({
    mutationFn: (taskIds: string[]) => api.post('/tasks/bulk', { taskIds, cycleId: current!.id }),
    onSuccess: (_r, taskIds) => {
      toast(t('plan.pulled').replace('{n}', String(taskIds.length)).replace('{cycle}', current!.name));
      qc.invalidateQueries({ queryKey: ['tasks', projectId] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const upcoming = cycles.filter((c) => cyclePhase(c) === 'upcoming').sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''));
  const done = cycles.filter((c) => cyclePhase(c) === 'completed');

  return (
    <PageBody width="wide" className="space-y-9">
      <div>
        <p className="mb-2 text-xs text-muted-foreground">{t('plan.milestonesHint')}</p>
        <ProjectMilestones
          projectId={projectId}
          projectKey={projectKey}
          canWrite={canWrite}
          onOpenTasks={onOpenMilestoneTasks}
          onOpenTask={onOpenTask}
          cycle={current && canWrite ? {
            name: current.name,
            inCycle: (id) => inCurrent.get(id) ?? 0,
            pullable: (id) => pullable.get(id)?.length ?? 0,
            onPull: (id) => { const ids = pullable.get(id); if (ids?.length) pull.mutate(ids); },
          } : current ? { name: current.name, inCycle: (id) => inCurrent.get(id) ?? 0 } : undefined}
        />
      </div>

      {cyclesEnabled ? (
        <section>
          <div className="mb-2 flex items-end justify-between gap-3">
            <div>
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-faint">{t('plan.cycles')}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('plan.cyclesHint')}</p>
            </div>
            {isAdmin && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus size={14} /> {t('projects.newCycle')}</Button>}
          </div>

          {cyclesQ.isLoading || tasksQ.isLoading ? (
            <Skeleton className="h-40" />
          ) : cycles.length === 0 ? (
            <div className="rounded-lg border border-border bg-card">
              <EmptyState icon={<CalendarClock size={20} />} title={t('projects.noCycles')} hint={t('projects.noCyclesHint')}
                action={isAdmin ? <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus size={14} /> {t('projects.newCycle')}</Button> : undefined} />
            </div>
          ) : (
            <div className="space-y-4">
              {current && (
                <CurrentCycle
                  cycle={current}
                  tasks={tasks.filter((tk) => tk.cycleId === current.id && !tk.parentId)}
                  milestones={milestones}
                  isOpen={isOpen}
                  onOpen={() => setDetails(current.id)}
                />
              )}
              {upcoming.length > 0 && (
                <div>
                  <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t('plan.upcoming')}</div>
                  <div className="rounded-lg border border-border bg-card">
                    {upcoming.map((c) => (
                      <CycleRow key={c.id} cycle={c} count={tasks.filter((tk) => tk.cycleId === c.id).length} onOpen={() => setDetails(c.id)} />
                    ))}
                  </div>
                </div>
              )}
              {done.length > 0 && (
                <div>
                  <button type="button" onClick={() => setShowDone((v) => !v)}
                    className="mb-1.5 flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                    <ChevronRight size={13} className={cn('transition-transform duration-200', showDone && 'rotate-90')} />
                    {t('plan.completed').replace('{n}', String(done.length))}
                  </button>
                  {showDone && (
                    <div className="rounded-lg border border-border bg-card">
                      {done.map((c) => <CycleRow key={c.id} cycle={c} count={tasks.filter((tk) => tk.cycleId === c.id).length} onOpen={() => setDetails(c.id)} />)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      ) : isAdmin ? (
        <p className="text-xs text-faint">{t('plan.cyclesOff')}</p>
      ) : null}

      {details && (
        <CycleDetailsDialog
          cycleId={details}
          cycles={cycles.map((c) => ({ ...c, goal: c.goal ?? undefined }))}
          isAdmin={isAdmin}
          onClose={() => setDetails(null)}
          onCompleted={() => { setDetails(null); qc.invalidateQueries({ queryKey: ['tasks', projectId] }); }}
        />
      )}
      <NewCycleDialog projectId={projectId} open={adding} onClose={() => setAdding(false)} />
    </PageBody>
  );
}

function CurrentCycle({ cycle, tasks, milestones, isOpen, onOpen }: {
  cycle: PlanCycle; tasks: PlanTask[]; milestones: Milestone[]; isOpen: (tk: PlanTask) => boolean; onOpen: () => void;
}) {
  const t = useT();
  const today = todayIso();
  const total = tasks.length;
  const closed = tasks.filter((tk) => !isOpen(tk)).length;
  const pct = total ? Math.round((closed / total) * 100) : 0;
  const left = cycle.endDate ? daysBetween(today, cycle.endDate) : null;
  const when = left == null ? null
    : left < 0 ? t('plan.ended').replace('{date}', fmtDate(cycle.endDate!))
      : left === 0 ? t('plan.lastDay') : t('plan.daysLeft').replace('{n}', String(left));

  // Which milestones this cycle moves, and how far.
  const groups = new Map<string | null, { total: number; closed: number }>();
  for (const tk of tasks) {
    const key = tk.milestoneId ?? null;
    const g = groups.get(key) ?? { total: 0, closed: 0 };
    g.total++; if (!isOpen(tk)) g.closed++;
    groups.set(key, g);
  }
  const rows = [...groups.entries()].sort(([a], [b]) => {
    const pa = milestones.find((m) => m.id === a)?.position ?? Infinity;
    const pb = milestones.find((m) => m.id === b)?.position ?? Infinity;
    return pa - pb;
  });

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">{t('plan.current')}</div>
          <div className="mt-0.5 text-[15px] font-semibold">{cycle.name}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1"><CalendarDays size={12} className="text-faint" />{fmtDate(cycle.startDate)} – {fmtDate(cycle.endDate)}</span>
            {when && <span className={cn(left != null && left < 0 && 'text-warning')}>· {when}</span>}
          </div>
          {cycle.goal && <p className="mt-1.5 text-[13px] text-muted-foreground">{cycle.goal}</p>}
        </div>
        <Button size="sm" variant="outline" onClick={onOpen}>{t('plan.open')}</Button>
      </div>

      <div className="mt-3">
        <div className="mb-1 flex justify-between text-xs text-muted-foreground">
          <span>{t('projects.progress')}</span>
          <span className="tabular-nums">{closed}/{total} · {pct}%</span>
        </div>
        <ProgressBar value={pct} />
      </div>

      {total === 0 ? (
        <p className="mt-3 text-xs text-faint">{t('plan.empty')}</p>
      ) : (
        <div className="mt-4">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('plan.byMilestone')}</div>
          <div className="space-y-1.5">
            {rows.map(([mid, g]) => {
              const m = milestones.find((x) => x.id === mid);
              return (
                <div key={mid ?? 'none'} className="flex items-center gap-2.5 text-[13px]">
                  <Diamond size={12} className={cn('shrink-0', m ? 'text-muted-foreground' : 'text-faint')} />
                  <span className={cn('w-44 min-w-0 shrink-0 truncate', !m && 'text-muted-foreground')}>{m?.name ?? t('plan.noMilestone')}</span>
                  <div className="min-w-0 flex-1"><ProgressBar value={g.total ? (g.closed / g.total) * 100 : 0} /></div>
                  <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{g.closed}/{g.total}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function CycleRow({ cycle, count, onOpen }: { cycle: PlanCycle; count: number; onOpen: () => void }) {
  const t = useT();
  const upcoming = cyclePhase(cycle) === 'upcoming';
  return (
    <button type="button" onClick={onOpen}
      className="flex w-full items-center gap-3 border-b border-border px-4 py-2.5 text-left transition-colors last:border-0 hover:bg-muted">
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{cycle.name}</span>
      <span className="text-xs text-muted-foreground">
        {upcoming ? t('plan.startsIn').replace('{date}', fmtDate(cycle.startDate)) : `${fmtDate(cycle.startDate)} – ${fmtDate(cycle.endDate)}`}
      </span>
      <span className="w-10 text-right text-xs tabular-nums text-faint">{count}</span>
      <ChevronRight size={14} className="text-faint" />
    </button>
  );
}

function NewCycleDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [goal, setGoal] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reset = () => { setName(''); setStart(''); setEnd(''); setGoal(''); setError(null); };
  // Prefill a two-week window when the dialog opens.
  useEffect(() => {
    if (!open) return;
    const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    setStart((s) => s || iso(new Date()));
    setEnd((s) => s || iso(new Date(Date.now() + 13 * 86_400_000)));
  }, [open]);
  const mut = useMutation({
    mutationFn: () => api.post('/cycles', { projectId, name, startDate: start, endDate: end, goal: goal || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cycles', projectId] }); qc.invalidateQueries({ queryKey: ['project', projectId] }); onClose(); reset(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('projects.createCycleFailed')),
  });
  return (
    <Dialog open={open} onClose={() => { onClose(); reset(); }} title={t('projects.newCycle')} width={440}>
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
          <div className="space-y-1"><label className="text-xs text-muted-foreground">{t('projects.start')}</label><DateField value={start} onChange={(v) => setStart(v ?? '')} clearable={false} /></div>
          <div className="space-y-1"><label className="text-xs text-muted-foreground">{t('projects.end')}</label><DateField value={end} onChange={(v) => setEnd(v ?? '')} clearable={false} min={start || undefined} /></div>
        </div>
        <Input placeholder={t('projects.goalPlaceholder')} value={goal} onChange={(e) => setGoal(e.target.value)} />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => { onClose(); reset(); }}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={mut.isPending}>{mut.isPending ? <Spinner /> : t('common.create')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
