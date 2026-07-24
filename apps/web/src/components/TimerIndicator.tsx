import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Square } from 'lucide-react';
import { api } from '../lib/api';

interface ActiveTimer { taskId: string; startedAt: string; elapsedSeconds: number; ref?: string }

function fmt(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function TimerIndicator() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['timer'],
    queryFn: () => api.get<{ timer: ActiveTimer | null }>('/time/timer').catch(() => ({ timer: null })),
    refetchInterval: 30_000,
  });
  const [tick, setTick] = useState(0);
  useEffect(() => { const i = setInterval(() => setTick((t) => t + 1), 1000); return () => clearInterval(i); }, []);
  const stop = useMutation({
    mutationFn: () => api.post('/time/timer/stop'),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['timer'] }); qc.invalidateQueries({ queryKey: ['time'] }); },
  });

  const timer = data?.timer;
  if (!timer) return null;
  const elapsed = (timer.elapsedSeconds ?? 0) + tick;

  return (
    <div className="flex items-center gap-2 rounded-md bg-primary/10 px-2 py-1 text-xs">
      <span className="font-mono">{fmt(elapsed)}</span>
      <span className="truncate text-muted-foreground">{timer.ref ?? 'timer'}</span>
      <button onClick={() => stop.mutate()} className="ml-auto text-destructive"><Square size={12} /></button>
    </div>
  );
}
