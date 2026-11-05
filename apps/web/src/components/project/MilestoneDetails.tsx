/**
 * Milestone side panel: what a milestone holds and how far it is. Opens from
 * a milestone's name in the Plan tab – the name, target date and done flag are
 * editable here, the tasks are listed with their status, and a task can be
 * added straight into the milestone.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Diamond, ListFilter, Plus } from 'lucide-react';
import { api, getAllPages, ApiError } from '../../lib/api';
import { useTaskStatuses } from '../../lib/queries';
import { useT, extendDict } from '../../lib/i18n';
import type { OpenIntent } from '../../lib/router';
import { Button, Checkbox, EmptySection, ProgressBar, Skeleton, Spinner, StatusIcon, cn } from '../ui';
import { SidePanel, toast } from '../overlays';
import { DateField } from '../DatePicker';
import type { Milestone } from './ProjectMilestones';

extendDict({
  en: {
    'milestone.panel': 'Milestone',
    'milestone.name': 'Milestone name',
    'milestone.done': 'Done',
    'milestone.target': 'Target date',
    'milestone.progress': 'Progress',
    'milestone.tasksDone': '{done} of {total} tasks done',
    'milestone.tasks': 'Tasks',
    'milestone.noTasks': 'No tasks in this milestone yet',
    'milestone.addTask': 'Add a task to this milestone…',
    'milestone.taskAdded': 'Task added',
    'milestone.openInTasks': 'Open in Tasks',
  },
  uk: {
    'milestone.panel': 'Етап',
    'milestone.name': 'Назва етапу',
    'milestone.done': 'Завершено',
    'milestone.target': 'Цільова дата',
    'milestone.progress': 'Прогрес',
    'milestone.tasksDone': 'Виконано {done} з {total} задач',
    'milestone.tasks': 'Задачі',
    'milestone.noTasks': 'У цьому етапі ще немає задач',
    'milestone.addTask': 'Додати задачу в цей етап…',
    'milestone.taskAdded': 'Задачу додано',
    'milestone.openInTasks': 'Відкрити у задачах',
  },
});

interface MilestoneTask { id: string; number: number; title: string; statusId: string; parentId?: string | null }

/** Open first (in workflow order), then done and canceled. */
const CATEGORY_ORDER: Record<string, number> = { in_progress: 0, todo: 1, backlog: 2, done: 3, canceled: 4 };

export function MilestoneDetailsPanel({ milestone, projectId, projectKey, canWrite, onClose, onPatch, onOpenTask, onOpenInTasks }: {
  /** null keeps the panel closed; the last milestone stays rendered while it slides out. */
  milestone: Milestone | null;
  projectId: string;
  projectKey?: string;
  canWrite: boolean;
  onClose: () => void;
  onPatch: (id: string, body: Record<string, unknown>) => void;
  onOpenTask?: (taskId: string, e?: OpenIntent) => void;
  onOpenInTasks?: (milestoneId: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  // Hold on to the milestone through the exit animation.
  const [shown, setShown] = useState<Milestone | null>(milestone);
  useEffect(() => { if (milestone) setShown(milestone); }, [milestone]);
  const m = milestone ?? shown;

  const [name, setName] = useState(m?.name ?? '');
  useEffect(() => { setName(m?.name ?? ''); }, [m?.id, m?.name]);
  const [draft, setDraft] = useState('');

  const statuses = useTaskStatuses(projectId).data ?? [];
  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses]);

  const tasksKey = ['tasks', projectId, 'milestone', m?.id];
  const tasksQ = useQuery<MilestoneTask[]>({
    queryKey: tasksKey,
    queryFn: () => getAllPages<MilestoneTask>('/tasks', { projectId, milestoneId: m!.id }),
    enabled: !!milestone,
  });
  const tasks = useMemo(() => {
    const rank = (tk: MilestoneTask) => CATEGORY_ORDER[statusById.get(tk.statusId)?.category ?? ''] ?? 1;
    return [...(tasksQ.data ?? [])].sort((a, b) => rank(a) - rank(b) || a.number - b.number);
  }, [tasksQ.data, statusById]);

  const addTask = useMutation({
    mutationFn: (title: string) => api.post('/tasks', { projectId, title, milestoneId: m!.id }),
    onSuccess: () => {
      setDraft('');
      qc.invalidateQueries({ queryKey: ['tasks', projectId] });
      qc.invalidateQueries({ queryKey: ['milestones', projectId] });
      toast(t('milestone.taskAdded'));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const saveName = () => {
    const next = name.trim();
    if (!m) return;
    if (!next) { setName(m.name); return; }
    if (next !== m.name) onPatch(m.id, { name: next });
  };

  const submitTask = (e: FormEvent) => {
    e.preventDefault();
    const title = draft.trim();
    if (title && !addTask.isPending) addTask.mutate(title);
  };

  const total = m?.taskCount ?? 0;
  const done = m?.doneCount ?? 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <SidePanel
      open={!!milestone}
      onClose={onClose}
      title={t('milestone.panel')}
      icon={<Diamond size={16} />}
      width={560}
    >
      {m && (
        <div className="space-y-6 px-5 pb-6 pt-1">
          <div className="space-y-3">
            {canWrite ? (
              <input
                value={name}
                aria-label={t('milestone.name')}
                onChange={(e) => setName(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') { e.stopPropagation(); setName(m.name); }
                }}
                className="-mx-1.5 w-[calc(100%+0.75rem)] rounded-md bg-transparent px-1.5 py-0.5 text-lg font-semibold text-foreground outline-none transition-colors duration-150 placeholder:text-faint hover:bg-muted/50 focus:bg-muted/60 focus-visible:outline-none"
              />
            ) : (
              <h3 className="text-lg font-semibold">{m.name}</h3>
            )}

            <div className="grid grid-cols-[110px_1fr] items-center gap-x-3 gap-y-2 text-[13px]">
              <span className="text-muted-foreground">{t('milestone.done')}</span>
              <span><Checkbox checked={m.done} disabled={!canWrite} onChange={(v) => onPatch(m.id, { done: v })} /></span>

              <span className="text-muted-foreground">{t('milestone.target')}</span>
              <DateField
                size="sm"
                value={m.targetDate ?? null}
                disabled={!canWrite}
                aria-label={t('milestone.target')}
                onChange={(day) => onPatch(m.id, { targetDate: day })}
                className="max-w-48"
              />
            </div>
          </div>

          <div>
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>{t('milestone.progress')}</span>
              <span className="tabular-nums">
                {t('milestone.tasksDone').replace('{done}', String(done)).replace('{total}', String(total))} · {pct}%
              </span>
            </div>
            <ProgressBar value={pct} />
          </div>

          <section>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h4 className="text-[11px] font-semibold uppercase tracking-wider text-faint">
                {t('milestone.tasks')} <span className="tabular-nums">{tasks.length || ''}</span>
              </h4>
              {onOpenInTasks && tasks.length > 0 && (
                <Button variant="ghost" size="xs" onClick={() => { onOpenInTasks(m.id); onClose(); }}>
                  <ListFilter size={13} /> {t('milestone.openInTasks')}
                </Button>
              )}
            </div>

            {tasksQ.isLoading ? (
              <div className="space-y-1">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>
            ) : (
              <div className={cn(tasks.length > 0 || canWrite ? 'rounded-lg border border-border bg-card' : '')}>
                {tasks.length === 0 && !canWrite && <EmptySection icon={<Diamond size={14} />} title={t('milestone.noTasks')} />}
                {tasks.map((tk, i) => {
                  const st = statusById.get(tk.statusId);
                  const closed = st?.category === 'done' || st?.category === 'canceled';
                  return (
                    <button
                      key={tk.id}
                      type="button"
                      onClick={(e) => onOpenTask?.(tk.id, e)}
                      className={cn(
                        'flex h-9 w-full items-center gap-2.5 px-3 text-left transition-colors duration-150 hover:bg-muted/60',
                        i > 0 && 'border-t border-border/60',
                      )}
                    >
                      <StatusIcon category={st?.category} color={st?.color} size={14} className="shrink-0" />
                      <span className="shrink-0 text-xs tabular-nums text-faint">
                        {projectKey ? `${projectKey}-${tk.number}` : `#${tk.number}`}
                      </span>
                      <span className={cn('min-w-0 flex-1 truncate text-[13px]', closed && 'text-muted-foreground line-through')}>
                        {tk.title}
                      </span>
                      {st && <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{st.name}</span>}
                    </button>
                  );
                })}
                {canWrite && (
                  <form
                    onSubmit={submitTask}
                    className={cn('flex h-9 items-center gap-2.5 px-3', tasks.length > 0 && 'border-t border-border/60')}
                  >
                    {addTask.isPending ? <Spinner /> : <Plus size={13} className="shrink-0 text-faint" />}
                    <input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={t('milestone.addTask')}
                      aria-label={t('milestone.addTask')}
                      className="h-6 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
                    />
                  </form>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </SidePanel>
  );
}
