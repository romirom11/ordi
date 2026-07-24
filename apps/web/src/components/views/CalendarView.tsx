import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, PriorityIcon, appLocale, cn } from '../ui';

interface CalTask {
  id: string;
  number?: number;
  ref?: string;
  title: string;
  priority?: string;
  dueDate?: string | null;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function refLabel(t: CalTask, projectKey?: string): string {
  if (t.ref) return t.ref;
  if (t.number == null) return '';
  return projectKey ? `${projectKey}-${t.number}` : `#${t.number}`;
}

export function CalendarView({ tasks, projectKey, onOpenTask }: {
  tasks: CalTask[]; projectKey?: string; onOpenTask: (taskId: string) => void;
}) {
  const now = new Date();
  const [cursor, setCursor] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));

  // Monday-first 6x7 grid.
  const offset = (cursor.getDay() + 6) % 7;
  const gridStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1 - offset);
  const cells: Date[] = Array.from({ length: 42 }, (_, i) =>
    new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));

  const byDay = new Map<string, CalTask[]>();
  for (const t of tasks) {
    if (!t.dueDate) continue;
    const key = t.dueDate.slice(0, 10);
    const list = byDay.get(key);
    if (list) list.push(t); else byDay.set(key, [t]);
  }
  const unscheduled = tasks.filter((t) => !t.dueDate);
  const todayKey = ymd(now);
  const monthLabel = cursor.toLocaleDateString(appLocale(), { month: 'long', year: 'numeric' });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" aria-label="Previous month"
          onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}>
          <ChevronLeft size={14} />
        </Button>
        <Button size="sm" variant="outline" aria-label="Next month"
          onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}>
          <ChevronRight size={14} />
        </Button>
        <span className="ml-1 text-sm font-semibold">{monthLabel}</span>
        <Button size="sm" variant="ghost" className="text-muted-foreground"
          onClick={() => setCursor(new Date(now.getFullYear(), now.getMonth(), 1))}>
          Today
        </Button>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="grid grid-cols-7 border-b border-border">
          {WEEKDAYS.map((d) => (
            <div key={d} className="px-2 py-1.5 text-center text-xs font-medium text-muted-foreground">{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {cells.map((day, i) => {
            const key = ymd(day);
            const inMonth = day.getMonth() === cursor.getMonth();
            const dayTasks = byDay.get(key) ?? [];
            return (
              <div key={key}
                className={cn(
                  'min-h-24 border-border p-1',
                  i % 7 !== 0 && 'border-l',
                  i >= 7 && 'border-t',
                  !inMonth && 'bg-muted/30',
                )}>
                <div className={cn(
                  'mb-1 px-1 text-right text-xs tabular-nums',
                  key === todayKey
                    ? 'font-semibold text-primary'
                    : inMonth ? 'text-foreground' : 'text-muted-foreground',
                )}>
                  {day.getDate()}
                </div>
                <div className="space-y-0.5">
                  {dayTasks.map((t) => (
                    <button key={t.id} onClick={() => onOpenTask(t.id)} title={t.title}
                      className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs transition-colors duration-150 hover:bg-muted">
                      <PriorityIcon priority={t.priority} size={11} />
                      {refLabel(t, projectKey) && (
                        <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{refLabel(t, projectKey)}</span>
                      )}
                      <span className="truncate">{t.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {unscheduled.length > 0 && (
        <div className="rounded-lg border border-border bg-card">
          <h3 className="border-b border-border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Unscheduled <span className="ml-1 rounded bg-muted px-1.5 py-0.5 tabular-nums">{unscheduled.length}</span>
          </h3>
          <div className="flex flex-wrap gap-1.5 p-2">
            {unscheduled.map((t) => (
              <button key={t.id} onClick={() => onOpenTask(t.id)} title={t.title}
                className="inline-flex max-w-64 items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors duration-150 hover:bg-muted">
                <PriorityIcon priority={t.priority} size={12} />
                {refLabel(t, projectKey) && (
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{refLabel(t, projectKey)}</span>
                )}
                <span className="truncate">{t.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
