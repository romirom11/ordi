import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api';
import { useT } from './i18n';
import { toast } from '../components/overlays';

export interface ActiveTimer {
  taskId: string | null;
  startedAt: string;
  elapsedSeconds: number;
  note?: string | null;
  ref?: string | null;
  title?: string | null;
}

/** Advance only from the latest server sample, never from component mount. */
export function timerElapsedAt(timer: ActiveTimer | null | undefined, receivedAt: number, now: number): number {
  if (!timer) return 0;
  return Math.max(0, Math.floor(Number(timer.elapsedSeconds) || 0))
    + Math.max(0, Math.floor((now - receivedAt) / 1000));
}

export function useActiveTimer(enabled = true) {
  return useQuery({
    queryKey: ['timer'],
    queryFn: () => api.get<ActiveTimer | null>('/time/timer'),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useTimerElapsed(timer: ActiveTimer | null | undefined, receivedAt: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!timer) return;
    const update = () => setNow(Date.now());
    update();
    const interval = setInterval(update, 1000);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', update);
    };
  }, [timer?.startedAt]);
  return timerElapsedAt(timer, receivedAt, now);
}

/** All Stop surfaces share feedback and invalidate the same time views. */
export function useStopTimer() {
  const t = useT();
  const qc = useQueryClient();
  const refresh = () => {
    for (const key of ['timer', 'time', 'myWeek', 'timeReport']) {
      void qc.invalidateQueries({ queryKey: [key] });
    }
  };
  return useMutation({
    mutationKey: ['stop-timer'],
    mutationFn: (_timer: ActiveTimer) => api.post('/time/timer/stop'),
    onSuccess: (_result, stopped) => {
      refresh();
      toast.action(t('time.timerStopped', 'Timer stopped'), {
        label: t('time.resumeTimer', 'Resume timer'),
        onSelect: () => {
          void (async () => {
            try {
              // Resuming must never replace a timer started since this toast.
              const current = await api.get<ActiveTimer | null>('/time/timer');
              if (current) { toast.info(t('time.alreadyRunning', 'A timer is already running')); return; }
              await api.post('/time/timer/start', { taskId: stopped.taskId, note: stopped.note ?? undefined });
              refresh();
              toast(t('time.timerResumed', 'Timer resumed'));
            } catch (error) {
              toast.error(error instanceof ApiError ? error.message : t('time.timerStartFailed', 'Could not start the timer'));
            }
          })();
        },
      });
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t('time.timerStopFailed', 'Could not stop the timer')),
  });
}
