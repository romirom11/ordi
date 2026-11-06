/**
 * "Time spent" on the task page: how much was logged on this task (a running
 * timer counts live), by whom, the entries themselves and a way to log more.
 */
import { useState, type ReactElement, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Clock, Plus } from 'lucide-react';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { useT, extendDict } from '../../lib/i18n';
import { useActiveTimer, useTimerElapsed } from '../../lib/timer';
import { Avatar, cn } from '../ui';
import { DropdownMenu, MenuLabel, MenuSeparator, useMenuClose } from '../overlays';
import { LogTimeDialog, TimeEntryPanel, TimeEntryRow, fmtDur, type TimeEntry } from '../time/TimeEntries';

extendDict({
  en: {
    'task.timeSpent': 'Spent',
    'task.noTimeYet': 'No time logged',
    'task.timeTotal': 'Total on this task',
    'task.timeMine': 'Yours',
    'task.timeRunning': 'incl. running timer',
    'task.timeOfEstimate': 'of {estimate}',
    'task.timeOverEstimate': 'Over the estimate',
    'task.timeEntries': 'Entries',
    'task.timeOwnEntries': 'Your entries',
  },
  uk: {
    'task.timeSpent': 'Витрачено',
    'task.noTimeYet': 'Час ще не записано',
    'task.timeTotal': 'Усього на задачі',
    'task.timeMine': 'Ваш час',
    'task.timeRunning': 'разом із запущеним таймером',
    'task.timeOfEstimate': 'з {estimate}',
    'task.timeOverEstimate': 'Більше за оцінку',
    'task.timeEntries': 'Записи',
    'task.timeOwnEntries': 'Ваші записи',
  },
});

interface TaskTimeSummary {
  totalSeconds: number;
  mySeconds: number;
  people: { userId: string; name: string; seconds: number }[] | null;
  entries: TimeEntry[];
}

export function useTaskTime(taskId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['taskTime', taskId],
    queryFn: () => api.get<TaskTimeSummary>(`/time/tasks/${taskId}`),
    enabled,
    staleTime: 15_000,
  });
}

/** Menu body; a separate component so it can close the menu it lives in. */
function TaskTimeMenu({ data, running, onOpenEntry, onLog, canTrack }: {
  data: TaskTimeSummary | undefined; running: number; onOpenEntry: (e: TimeEntry) => void; onLog: () => void; canTrack: boolean;
}) {
  const t = useT();
  const close = useMenuClose();
  const total = (data?.totalSeconds ?? 0) + running;
  const mine = (data?.mySeconds ?? 0) + running;
  const people = data?.people ?? [];
  const entries = data?.entries ?? [];
  return (
    <div className="max-h-[420px] overflow-y-auto">
      <div className={cn('grid gap-2 px-2 pb-2 pt-1', mine !== total && 'grid-cols-2')}>
        <div className="rounded-md bg-muted/50 px-2.5 py-1.5">
          <div className="text-[11px] text-muted-foreground">{t('task.timeTotal')}</div>
          <div className="font-mono text-sm font-semibold tabular-nums">{fmtDur(total)}</div>
        </div>
        {/* Your share only says something when others logged time too. */}
        {mine !== total && (
          <div className="rounded-md bg-muted/50 px-2.5 py-1.5">
            <div className="text-[11px] text-muted-foreground">{t('task.timeMine')}</div>
            <div className="font-mono text-sm font-semibold tabular-nums">{fmtDur(mine)}</div>
          </div>
        )}
      </div>
      {running > 0 && <p className="px-2.5 pb-1.5 text-[11px] text-faint">{t('task.timeRunning')}</p>}

      {people.length > 1 && (
        <>
          <MenuSeparator />
          <MenuLabel>{t('time.byPerson')}</MenuLabel>
          {people.map((p) => (
            <div key={p.userId} className="flex items-center gap-2 px-2.5 py-1 text-[13px]">
              <Avatar name={p.name} size={16} />
              <span className="flex-1 truncate">{p.name}</span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">{fmtDur(p.seconds)}</span>
            </div>
          ))}
        </>
      )}

      {entries.length > 0 && (
        <>
          <MenuSeparator />
          <MenuLabel>{data?.people ? t('task.timeEntries') : t('task.timeOwnEntries')}</MenuLabel>
          <div className="-mx-1">
            {entries.map((e) => (
              <TimeEntryRow
                key={e.id}
                entry={{ ...e, taskTitle: null, projectName: null, taskRef: null }}
                showDay
                showUser={people.length > 1}
                onOpen={() => { close(); onOpenEntry(e); }}
                className="rounded-md px-2.5 py-1.5"
              />
            ))}
          </div>
        </>
      )}

      {canTrack && (
        <>
          <MenuSeparator />
          <button
            type="button"
            onClick={() => { close(); onLog(); }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-muted"
          >
            <Plus size={14} /> {t('time.logTime')}
          </button>
        </>
      )}
    </div>
  );
}

export function TaskTimeRow({ task, estimateSeconds, Row, Chip }: {
  task: { id: string; title: string; ref?: string | null };
  /** The estimate in seconds, when the project estimates in hours. */
  estimateSeconds: number | null;
  Row: (p: { label: string; children: ReactNode }) => ReactElement;
  Chip: (p: { children: ReactNode; empty?: boolean }) => ReactElement;
}) {
  const t = useT();
  const can = useCan();
  const canTrack = can('time.track');
  const q = useTaskTime(task.id, canTrack || can('time.read_all'));
  const timerQ = useActiveTimer(canTrack);
  const timer = timerQ.data?.taskId === task.id ? timerQ.data : null;
  const elapsed = useTimerElapsed(timer, timerQ.dataUpdatedAt);
  const running = timer ? elapsed : 0;
  const [openEntry, setOpenEntry] = useState<TimeEntry | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  if (!canTrack && !can('time.read_all')) return null;
  const total = (q.data?.totalSeconds ?? 0) + running;
  const over = estimateSeconds != null && estimateSeconds > 0 && total > estimateSeconds;

  return (
    <>
      <Row label={t('task.timeSpent')}>
        <DropdownMenu
          className="w-full"
          width={320}
          trigger={
            <Chip empty={total === 0}>
              <Clock size={14} className={cn(timer && 'text-success', over && 'text-warning')} />
              <span className={cn('truncate tabular-nums', over && 'text-warning')} title={over ? t('task.timeOverEstimate') : undefined}>
                {q.isLoading ? '…' : total === 0 ? t('task.noTimeYet') : fmtDur(total)}
                {total > 0 && estimateSeconds != null && estimateSeconds > 0 && (
                  <span className="text-faint"> {t('task.timeOfEstimate').replace('{estimate}', fmtDur(estimateSeconds))}</span>
                )}
              </span>
            </Chip>
          }
        >
          <TaskTimeMenu data={q.data} running={running} onOpenEntry={setOpenEntry} onLog={() => setLogOpen(true)} canTrack={canTrack} />
        </DropdownMenu>
        {estimateSeconds != null && estimateSeconds > 0 && total > 0 && (
          <div className="mx-1.5 mb-1 mt-0.5 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
            <div className={cn('h-full rounded-full', over ? 'bg-warning' : 'bg-primary/70')} style={{ width: `${Math.min(100, (total / estimateSeconds) * 100)}%` }} />
          </div>
        )}
      </Row>
      <LogTimeDialog
        open={logOpen}
        onClose={() => setLogOpen(false)}
        task={{ id: task.id, label: task.ref ?? task.title }}
      />
      <TimeEntryPanel entry={openEntry} onClose={() => setOpenEntry(null)} />
    </>
  );
}
