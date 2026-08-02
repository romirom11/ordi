/**
 * Cycle details: live progress, the burndown drawn from the daily snapshots the
 * worker has been collecting all along, and the way to actually finish a cycle
 * – open tasks roll to the backlog or into the next cycle.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Button, ProgressBar, Select, Skeleton, Spinner, fmtDate } from '../ui';
import { Dialog, toast } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'cycle.progress': 'Progress',
    'cycle.done': 'done',
    'cycle.burndown': 'Burndown',
    'cycle.burndownEmpty': 'No snapshots yet – the chart fills in daily while the cycle is active.',
    'cycle.complete': 'Complete cycle',
    'cycle.completeHint': 'Open tasks move out of the cycle:',
    'cycle.moveBacklog': 'To the backlog (no cycle)',
    'cycle.moveNext': 'To the next cycle',
    'cycle.completed': 'Cycle completed',
    'cycle.open': 'open',
    'cycle.goal': 'Goal',
  },
  uk: {
    'cycle.progress': 'Прогрес',
    'cycle.done': 'виконано',
    'cycle.burndown': 'Burndown',
    'cycle.burndownEmpty': 'Знімків поки немає – графік наповнюється щодня, поки цикл активний.',
    'cycle.complete': 'Завершити цикл',
    'cycle.completeHint': 'Відкриті задачі переходять:',
    'cycle.moveBacklog': 'У беклог (без циклу)',
    'cycle.moveNext': 'У наступний цикл',
    'cycle.completed': 'Цикл завершено',
    'cycle.open': 'відкрито',
    'cycle.goal': 'Ціль',
  },
});

export interface CycleLite {
  id: string; name: string; startDate?: string; endDate?: string; status?: string; goal?: string;
}

interface CycleProgress {
  cycle: CycleLite;
  total: number;
  done: number;
  totalEstimate: number;
  doneEstimate: number;
}

interface Snapshot { date: string; openCount: number; openEstimate?: string | number }

function dayNumber(date: string): number {
  return new Date(`${date.slice(0, 10)}T00:00:00Z`).getTime() / 86_400_000;
}

/** Open-count burndown with an ideal straight line to the end date. */
function BurndownChart({ snapshots, cycle }: { snapshots: Snapshot[]; cycle: CycleLite }) {
  const t = useT();
  const geometry = useMemo(() => {
    if (!snapshots.length) return null;
    const first = snapshots[0]!;
    const start = dayNumber(cycle.startDate ?? first.date);
    const end = Math.max(dayNumber(cycle.endDate ?? snapshots[snapshots.length - 1]!.date), start + 1);
    const maxOpen = Math.max(...snapshots.map((s) => s.openCount), 1);
    const W = 560;
    const H = 140;
    const PAD = 8;
    const x = (date: string) => PAD + ((Math.min(Math.max(dayNumber(date), start), end) - start) / (end - start)) * (W - 2 * PAD);
    const y = (count: number) => H - PAD - (count / maxOpen) * (H - 2 * PAD);
    const points = snapshots.map((s) => `${x(s.date).toFixed(1)},${y(s.openCount).toFixed(1)}`).join(' ');
    const ideal = `${x(first.date).toFixed(1)},${y(first.openCount).toFixed(1)} ${(W - PAD).toFixed(1)},${y(0).toFixed(1)}`;
    return { W, H, points, ideal, maxOpen, lastOpen: snapshots[snapshots.length - 1]!.openCount };
  }, [snapshots, cycle.startDate, cycle.endDate]);

  if (!geometry) {
    return <p className="text-[13px] text-muted-foreground">{t('cycle.burndownEmpty')}</p>;
  }
  return (
    <div>
      <svg viewBox={`0 0 ${geometry.W} ${geometry.H}`} className="w-full" role="img" aria-label={t('cycle.burndown')}>
        <polyline points={geometry.ideal} fill="none" stroke="currentColor" strokeDasharray="4 4" strokeWidth="1" className="text-faint" />
        <polyline points={geometry.points} fill="none" stroke="currentColor" strokeWidth="2" className="text-primary" strokeLinejoin="round" />
      </svg>
      <p className="mt-1 text-right text-[11px] tabular-nums text-muted-foreground">
        {geometry.lastOpen} {t('cycle.open')} · max {geometry.maxOpen}
      </p>
    </div>
  );
}

export function CycleDetailsDialog({ cycleId, cycles, isAdmin, onClose, onCompleted }: {
  cycleId: string;
  /** All the project's cycles, for the "move to next" picker. */
  cycles: CycleLite[];
  isAdmin: boolean;
  onClose: () => void;
  onCompleted: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const progressQ = useQuery<CycleProgress>({
    queryKey: ['cycle', cycleId],
    queryFn: () => api.get<CycleProgress>(`/cycles/${cycleId}`),
  });
  const snapshotsQ = useQuery<Snapshot[]>({
    queryKey: ['cycle-snapshots', cycleId],
    queryFn: () => api.get<{ data: Snapshot[] }>(`/cycles/${cycleId}/snapshots`).then((r) => r.data),
  });

  const nextCycles = cycles.filter((c) => c.id !== cycleId && c.status !== 'completed');
  const [moveTo, setMoveTo] = useState<'backlog' | 'next_cycle'>('backlog');
  const [nextCycleId, setNextCycleId] = useState(nextCycles[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);

  const complete = useMutation({
    mutationFn: () => api.post(`/cycles/${cycleId}/complete`, {
      moveTo,
      nextCycleId: moveTo === 'next_cycle' ? nextCycleId || null : null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cycles'] });
      qc.invalidateQueries({ queryKey: ['cycle', cycleId] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      toast(t('cycle.completed'));
      onCompleted();
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : t('common.error')),
  });

  const data = progressQ.data;
  const cycle = data?.cycle ?? cycles.find((c) => c.id === cycleId);
  const pct = data && data.total > 0 ? Math.round((data.done / data.total) * 100) : 0;
  const completable = isAdmin && cycle?.status !== 'completed';

  return (
    <Dialog open onClose={onClose} title={cycle?.name ?? '…'} width={620}>
      <div className="space-y-5 px-4 pb-4 pt-1">
        {cycle && (
          <p className="text-xs text-muted-foreground">
            {fmtDate(cycle.startDate)} – {fmtDate(cycle.endDate)}
            {cycle.status && <span className="ml-2 rounded bg-muted px-1.5 py-0.5 capitalize">{cycle.status}</span>}
          </p>
        )}
        {cycle?.goal && <p className="text-[13px] text-muted-foreground">{t('cycle.goal')}: {cycle.goal}</p>}

        {progressQ.isLoading || !data ? (
          <Skeleton className="h-10" />
        ) : (
          <div>
            <div className="mb-1 flex justify-between text-xs text-muted-foreground">
              <span>{t('cycle.progress')}</span>
              <span className="tabular-nums">{data.done}/{data.total} {t('cycle.done')} · {pct}%</span>
            </div>
            <ProgressBar value={pct} />
          </div>
        )}

        <section>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('cycle.burndown')}</h3>
          {snapshotsQ.isLoading
            ? <Skeleton className="h-28" />
            : cycle && <BurndownChart snapshots={snapshotsQ.data ?? []} cycle={cycle} />}
        </section>

        {completable && (
          <section className="rounded-lg border border-border p-3">
            <p className="mb-2 text-[13px] font-medium">{t('cycle.complete')}</p>
            <p className="mb-2 text-xs text-muted-foreground">{t('cycle.completeHint')}</p>
            <div className="space-y-1.5 text-[13px]">
              <label className="flex items-center gap-2">
                <input type="radio" name="moveTo" checked={moveTo === 'backlog'} onChange={() => setMoveTo('backlog')} />
                {t('cycle.moveBacklog')}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="moveTo"
                  disabled={!nextCycles.length}
                  checked={moveTo === 'next_cycle'}
                  onChange={() => setMoveTo('next_cycle')}
                />
                {t('cycle.moveNext')}
                {moveTo === 'next_cycle' && nextCycles.length > 0 && (
                  <Select value={nextCycleId} onChange={(event) => setNextCycleId(event.target.value)}>
                    {nextCycles.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                )}
              </label>
            </div>
            {error && <p className="mt-2 text-[13px] text-destructive">{error}</p>}
            <div className="mt-3 flex justify-end">
              <Button size="sm" disabled={complete.isPending} onClick={() => complete.mutate()}>
                {complete.isPending ? <Spinner /> : <><CheckCircle2 size={14} /> {t('cycle.complete')}</>}
              </Button>
            </div>
          </section>
        )}
      </div>
    </Dialog>
  );
}
