import { Square } from 'lucide-react';
import { useCan } from '../lib/auth';
import { useT } from '../lib/i18n';
import { useActiveTimer, useStopTimer, useTimerElapsed } from '../lib/timer';
import { IconButton, Spinner } from './ui';

function fmt(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function TimerIndicator() {
  const t = useT();
  const can = useCan();
  const timerQ = useActiveTimer(can('time.track'));
  const timer = timerQ.data ?? null;
  const elapsed = useTimerElapsed(timer, timerQ.dataUpdatedAt);
  const stop = useStopTimer();
  if (!can('time.track')) return null;
  if (!timer) return timerQ.isError ? (
    <button type="button" onClick={() => void timerQ.refetch()} className="text-xs text-destructive">
      {t('time.timerUnavailable', 'Could not check the timer. Retry')}
    </button>
  ) : null;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md bg-primary/10 px-2 py-1 text-xs">
      <span className="font-mono">{fmt(elapsed)}</span>
      <span className="truncate text-muted-foreground" title={timer.title ?? undefined}>{timer.ref ?? 'timer'}</span>
      <IconButton type="button" onClick={() => stop.mutate(timer)} disabled={stop.isPending} className="ml-auto text-destructive" aria-label={t('time.stopTimer', 'Stop timer')} title={t('time.stopTimer', 'Stop timer')}>
        {stop.isPending ? <Spinner /> : <Square size={12} />}
      </IconButton>
      {timerQ.isError && <span role="status" className="w-full text-destructive">{t('time.timerStale', 'Timer status could not be refreshed')}</span>}
    </div>
  );
}
