/**
 * Start or stop the timer for this task without leaving the task page. Only one
 * timer runs at a time, so starting here stops whatever was running before –
 * the API handles that, and the header indicator follows the same query.
 */
import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Play, Square } from 'lucide-react';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { Button, Spinner, cn } from '../ui';
import { toast } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'task.startTimer': 'Start timer',
    'task.stopTimer': 'Stop',
    'task.timerRunningElsewhere': 'Timer running on another task',
    'task.timerStarted': 'Timer started',
    'task.timerStopped': 'Timer stopped',
    'task.timerFailed': 'Could not change the timer',
  },
  uk: {
    'task.startTimer': 'Запустити таймер',
    'task.stopTimer': 'Зупинити',
    'task.timerRunningElsewhere': 'Таймер працює над іншою задачею',
    'task.timerStarted': 'Таймер запущено',
    'task.timerStopped': 'Таймер зупинено',
    'task.timerFailed': 'Не вдалося змінити таймер',
  },
});

interface ActiveTimer { taskId?: string | null; ref?: string | null; elapsedSeconds?: number }

function hms(total: number): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function TaskTimer({ taskId }: { taskId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const [tick, setTick] = useState(0);

  const { data } = useQuery({
    // The endpoint returns the timer itself (or null), not a wrapper.
    queryKey: ['timer'],
    queryFn: () => api.get<ActiveTimer | null>('/time/timer').catch(() => null),
    enabled: can('time.track'),
  });
  const timer = data ?? null;
  const onThisTask = timer?.taskId === taskId;

  // Local ticking so the elapsed time moves without polling the server.
  useEffect(() => {
    if (!onThisTask) return;
    setTick(0);
    const id = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [onThisTask, timer?.elapsedSeconds]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['timer'] });
    qc.invalidateQueries({ queryKey: ['time'] });
    qc.invalidateQueries({ queryKey: ['task', taskId] });
  };

  const start = useMutation({
    mutationFn: () => api.post('/time/timer/start', { taskId }),
    onSuccess: () => { refresh(); toast(t('task.timerStarted')); },
    onError: () => toast.error(t('task.timerFailed')),
  });
  const stop = useMutation({
    mutationFn: () => api.post('/time/timer/stop', {}),
    onSuccess: () => { refresh(); toast(t('task.timerStopped')); },
    onError: () => toast.error(t('task.timerFailed')),
  });

  if (!can('time.track')) return null;
  const busy = start.isPending || stop.isPending;

  if (onThisTask) {
    const elapsed = (timer?.elapsedSeconds ?? 0) + tick;
    return (
      <div className="px-3 py-1.5">
        <Button
          size="sm"
          variant="outline"
          className={cn('w-full justify-center border-success/40 text-success hover:bg-success/10')}
          disabled={busy}
          onClick={() => stop.mutate()}
        >
          {busy ? <Spinner /> : <Square size={13} />}
          <span className="tabular-nums">{hms(elapsed)}</span>
          <span className="text-muted-foreground">{t('task.stopTimer')}</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="px-3 py-1.5">
      <Button size="sm" variant="outline" className="w-full justify-center" disabled={busy} onClick={() => start.mutate()}>
        {busy ? <Spinner /> : <Play size={13} />}
        {t('task.startTimer')}
      </Button>
      {timer && (
        <p className="mt-1 text-center text-[11px] text-faint">
          {t('task.timerRunningElsewhere')}{timer.ref ? ` (${timer.ref})` : ''}
        </p>
      )}
    </div>
  );
}
