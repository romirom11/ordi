/**
 * Milestones block in the Plan tab: quick-add, done checkbox with
 * strikethrough, target date picker and up/down reordering. A milestone's name
 * opens its side panel (MilestoneDetails) with its tasks.
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowDownToLine, ArrowUp, CalendarDays, Diamond, Plus, Trash2, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Checkbox, IconButton, ProgressRing, Skeleton, Tooltip, fmtDate, cn } from '../ui';
import { DropdownMenu, MenuItem, MenuSeparator, toast, useMenuClose } from '../overlays';
import { Calendar } from '../DatePicker';
import { useT, extendDict } from '../../lib/i18n';
import type { OpenIntent } from '../../lib/router';
import { MilestoneDetailsPanel } from './MilestoneDetails';

/** Picking a target date applies it and closes the menu. */
function MilestoneCalendar({ value, onSelect }: { value?: string | null; onSelect: (day: string) => void }) {
  const close = useMenuClose();
  return <Calendar value={value} onSelect={(day) => { onSelect(day); close(); }} />;
}

extendDict({
  en: {
    'projects.milestones': 'Milestones',
    'projects.addMilestone': 'Add milestone…',
    'projects.milestoneTarget': 'Target date',
    'projects.milestoneDelete': 'Delete milestone',
    'projects.milestoneUp': 'Move up',
    'projects.milestoneDown': 'Move down',
    'projects.milestoneSaveFailed': 'Could not save the milestone.',
    'projects.milestoneTasks': 'Show its tasks',
    'projects.milestoneOpen': 'Open milestone',
    'projects.milestoneNoTasks': 'No tasks assigned yet',
    'projects.milestoneInCycle': '{n} in {cycle}',
    'projects.milestonePull': 'Pull {n} open tasks into {cycle}',
  },
  uk: {
    'projects.milestones': 'Етапи',
    'projects.addMilestone': 'Додати етап…',
    'projects.milestoneTarget': 'Цільова дата',
    'projects.milestoneDelete': 'Видалити етап',
    'projects.milestoneUp': 'Перемістити вгору',
    'projects.milestoneDown': 'Перемістити вниз',
    'projects.milestoneSaveFailed': 'Не вдалося зберегти етап.',
    'projects.milestoneTasks': 'Показати задачі',
    'projects.milestoneOpen': 'Відкрити етап',
    'projects.milestoneNoTasks': 'Задач ще не призначено',
    'projects.milestoneInCycle': '{n} у {cycle}',
    'projects.milestonePull': 'Взяти відкриті задачі ({n}) у {cycle}',
  },
});

export interface Milestone {
  id: string; projectId: string; name: string; targetDate?: string | null;
  done: boolean; position: number; createdAt?: string;
  /** Rolled up from the milestone's tasks by the API. */
  taskCount?: number; doneCount?: number;
}

export function ProjectMilestones({ projectId, projectKey, canWrite, onOpenTasks, onOpenTask, cycle }: {
  projectId: string; projectKey?: string; canWrite: boolean;
  /** Open one task (from the milestone panel's list). */
  onOpenTask?: (taskId: string, e?: OpenIntent) => void;
  /** Jump to the Tasks tab grouped by milestone, scrolled to this one. */
  onOpenTasks?: (milestoneId: string) => void;
  /** The running cycle, when the project uses cycles: how much of each milestone it carries, and pulling more in. */
  cycle?: { name: string; inCycle: (milestoneId: string) => number; pullable?: (milestoneId: string) => number; onPull?: (milestoneId: string) => void };
}) {
  const t = useT();
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading } = useQuery<Milestone[]>({
    queryKey: ['milestones', projectId],
    queryFn: () => api.get<{ data: Milestone[] }>(`/projects/${projectId}/milestones`).then((r) => r.data),
  });
  const milestones = data ?? [];
  const doneCount = milestones.filter((m) => m.done).length;

  const invalidate = () => qc.invalidateQueries({ queryKey: ['milestones', projectId] });
  const onErr = (e: unknown) => toast.error(e instanceof ApiError ? e.message : t('projects.milestoneSaveFailed'));

  const add = useMutation({
    mutationFn: (name: string) => api.post(`/projects/${projectId}/milestones`, { name }),
    onSuccess: () => { setDraft(''); invalidate(); },
    onError: onErr,
  });
  const patch = useMutation({
    mutationFn: (vars: { id: string; body: Record<string, unknown> }) => api.patch(`/milestones/${vars.id}`, vars.body),
    onMutate: async (vars) => {
      await qc.cancelQueries({ queryKey: ['milestones', projectId] });
      const prev = qc.getQueryData<Milestone[]>(['milestones', projectId]);
      qc.setQueryData<Milestone[]>(['milestones', projectId], (old) =>
        (old ?? []).map((m) => (m.id === vars.id ? { ...m, ...vars.body } as Milestone : m)));
      return { prev };
    },
    onError: (e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(['milestones', projectId], ctx.prev); onErr(e); },
    onSettled: invalidate,
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/milestones/${id}`),
    onSuccess: invalidate,
    onError: onErr,
  });

  /** Swap positions with the neighbour (server stores explicit positions). */
  const move = (index: number, dir: -1 | 1) => {
    const a = milestones[index];
    const b = milestones[index + dir];
    if (!a || !b) return;
    patch.mutate({ id: a.id, body: { position: b.position } });
    patch.mutate({ id: b.id, body: { position: a.position } });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = draft.trim();
    if (v) add.mutate(v);
  };

  if (!canWrite && !isLoading && milestones.length === 0) return null;

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-faint">{t('projects.milestones')}</h2>
        {milestones.length > 0 && (
          <span className="text-[11px] tabular-nums text-faint">{doneCount}/{milestones.length}</span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-1">{[0, 1].map((i) => <Skeleton key={i} className="h-8" />)}</div>
      ) : (
        <div className="rounded-lg border border-border bg-card">
          {milestones.map((m, i) => (
            <div
              key={m.id}
              className={cn(
                'group/ms row-enter flex h-9 items-center gap-2.5 px-3',
                i > 0 && 'border-t border-border/60',
              )}
              style={{ ['--i' as string]: Math.min(i, 10) }}
            >
              <Diamond size={13} className={cn('shrink-0', m.done ? 'text-success' : 'text-faint')} fill={m.done ? 'currentColor' : 'none'} />
              <Checkbox checked={m.done} disabled={!canWrite} onChange={(v) => patch.mutate({ id: m.id, body: { done: v } })} />
              <button
                type="button"
                onClick={() => setOpenId(m.id)}
                title={t('projects.milestoneOpen')}
                className={cn(
                  'min-w-0 flex-1 truncate text-left text-[13px] hover:underline',
                  m.done && 'text-muted-foreground line-through',
                )}
              >
                {m.name}
              </button>

              {/* What the milestone actually holds: its tasks, and how far they are. */}
              <Tooltip label={m.taskCount ? t('projects.milestoneTasks') : t('projects.milestoneNoTasks')}>
                <button
                  type="button"
                  disabled={!m.taskCount}
                  onClick={() => onOpenTasks?.(m.id)}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-xs tabular-nums transition-colors duration-150',
                    m.taskCount ? 'text-muted-foreground hover:bg-muted' : 'text-faint',
                  )}
                >
                  <ProgressRing value={m.taskCount ? ((m.doneCount ?? 0) / m.taskCount) * 100 : 0} size={13} />
                  {m.doneCount ?? 0}/{m.taskCount ?? 0}
                </button>
              </Tooltip>

              {cycle && cycle.inCycle(m.id) > 0 && (
                <span className="shrink-0 rounded-full border border-border px-1.5 py-px text-[11px] tabular-nums text-muted-foreground">
                  {t('projects.milestoneInCycle').replace('{n}', String(cycle.inCycle(m.id))).replace('{cycle}', cycle.name)}
                </span>
              )}
              {cycle?.onPull && !m.done && (cycle.pullable?.(m.id) ?? 0) > 0 && (
                <Tooltip label={t('projects.milestonePull').replace('{n}', String(cycle.pullable!(m.id))).replace('{cycle}', cycle.name)}>
                  <IconButton
                    size="sm"
                    aria-label={t('projects.milestonePull').replace('{n}', String(cycle.pullable!(m.id))).replace('{cycle}', cycle.name)}
                    onClick={() => cycle.onPull!(m.id)}
                    className="opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover/ms:opacity-100"
                  >
                    <ArrowDownToLine size={13} />
                  </IconButton>
                </Tooltip>
              )}

              {/* target date */}
              {canWrite ? (
                <DropdownMenu
                  align="end"
                  width={264}
                  trigger={
                    <button
                      type="button"
                      className={cn(
                        'flex h-6 items-center gap-1 rounded px-1.5 text-xs tabular-nums transition-colors duration-150 hover:bg-muted',
                        m.targetDate
                          ? (!m.done && m.targetDate < new Date().toISOString().slice(0, 10) ? 'text-destructive' : 'text-muted-foreground')
                          : 'text-faint opacity-0 focus-visible:opacity-100 group-hover/ms:opacity-100',
                      )}
                    >
                      <CalendarDays size={12} />
                      {m.targetDate ? fmtDate(m.targetDate) : t('projects.milestoneTarget')}
                    </button>
                  }
                >
                  <MilestoneCalendar
                    value={m.targetDate}
                    onSelect={(day) => patch.mutate({ id: m.id, body: { targetDate: day } })}
                  />
                  {m.targetDate && (
                    <>
                      <MenuSeparator />
                      <MenuItem icon={<X size={14} />} danger onSelect={() => patch.mutate({ id: m.id, body: { targetDate: null } })}>
                        {t('projects.clearDate')}
                      </MenuItem>
                    </>
                  )}
                </DropdownMenu>
              ) : (
                m.targetDate && (
                  <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                    <CalendarDays size={12} className="text-faint" />
                    {fmtDate(m.targetDate)}
                  </span>
                )
              )}

              {canWrite && (
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/ms:opacity-100">
                  <IconButton size="sm" aria-label={t('projects.milestoneUp')} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp size={13} />
                  </IconButton>
                  <IconButton size="sm" aria-label={t('projects.milestoneDown')} disabled={i === milestones.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown size={13} />
                  </IconButton>
                  <IconButton size="sm" aria-label={t('projects.milestoneDelete')} onClick={() => del.mutate(m.id)}>
                    <Trash2 size={13} className="text-destructive/80" />
                  </IconButton>
                </span>
              )}
            </div>
          ))}

          {canWrite && (
            <form
              onSubmit={submit}
              className={cn('flex h-9 items-center gap-2.5 px-3', milestones.length > 0 && 'border-t border-border/60')}
            >
              <Plus size={13} className="shrink-0 text-faint" />
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={t('projects.addMilestone')}
                className="h-6 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
              />
            </form>
          )}
        </div>
      )}

      <MilestoneDetailsPanel
        milestone={milestones.find((m) => m.id === openId) ?? null}
        projectId={projectId}
        projectKey={projectKey}
        canWrite={canWrite}
        onClose={() => setOpenId(null)}
        onPatch={(id, body) => patch.mutate({ id, body })}
        onOpenTask={onOpenTask}
        onOpenInTasks={onOpenTasks}
      />
    </section>
  );
}
