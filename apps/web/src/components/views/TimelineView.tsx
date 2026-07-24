import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button, PriorityIcon, cn } from '../ui';

interface GanttStatus { id: string; category?: string }
interface GanttTask {
  id: string;
  number?: number;
  ref?: string;
  title: string;
  statusId: string;
  priority?: string;
  startDate?: string | null;
  dueDate?: string | null;
}

const DAY_MS = 86_400_000;
const PX_PER_DAY = 12;
const WEEKS = 13; // ~3 months
const TOTAL_DAYS = WEEKS * 7;
const NAME_W = 224; // px, matches w-56

function parseDay(s: string): Date {
  const parts = s.slice(0, 10).split('-').map(Number);
  return new Date(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1);
}

function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday-first
  return x;
}

function dayIndex(windowStart: Date, d: Date): number {
  return Math.round((d.getTime() - windowStart.getTime()) / DAY_MS);
}

export function TimelineView({ tasks, statuses, onOpenTask }: {
  tasks: GanttTask[]; statuses: GanttStatus[]; onOpenTask: (taskId: string) => void;
}) {
  const today = new Date();
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const [windowStart, setWindowStart] = useState(() => {
    const s = startOfWeek(todayStart);
    s.setDate(s.getDate() - 28); // start ~4 weeks back
    return s;
  });

  const shift = (days: number) => setWindowStart((w) => {
    const n = new Date(w.getFullYear(), w.getMonth(), w.getDate());
    n.setDate(n.getDate() + days);
    return n;
  });

  const catOf = (sid: string) => statuses.find((s) => s.id === sid)?.category;
  const scheduled = tasks.filter((t) => t.startDate || t.dueDate);
  const undated = tasks.filter((t) => !t.startDate && !t.dueDate);

  const weeks: Date[] = Array.from({ length: WEEKS }, (_, i) => {
    const d = new Date(windowStart.getFullYear(), windowStart.getMonth(), windowStart.getDate());
    d.setDate(d.getDate() + i * 7);
    return d;
  });
  const timelineW = TOTAL_DAYS * PX_PER_DAY;
  const todayIdx = dayIndex(windowStart, todayStart);
  const todayInWindow = todayIdx >= 0 && todayIdx < TOTAL_DAYS;

  const windowEnd = new Date(windowStart.getFullYear(), windowStart.getMonth(), windowStart.getDate() + TOTAL_DAYS - 1);
  const rangeLabel = `${windowStart.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${windowEnd.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" aria-label="Earlier" onClick={() => shift(-28)}><ChevronLeft size={14} /></Button>
        <Button size="sm" variant="outline" aria-label="Later" onClick={() => shift(28)}><ChevronRight size={14} /></Button>
        <span className="ml-1 text-sm font-semibold">{rangeLabel}</span>
        <Button size="sm" variant="ghost" className="text-muted-foreground"
          onClick={() => { const s = startOfWeek(todayStart); s.setDate(s.getDate() - 28); setWindowStart(s); }}>
          Today
        </Button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <div className="relative" style={{ width: NAME_W + timelineW, minWidth: '100%' }}>
          {/* Week grid lines */}
          {weeks.map((w, i) => i > 0 && (
            <div key={w.toISOString()} className="absolute inset-y-0 z-0 w-px bg-border/60"
              style={{ left: NAME_W + i * 7 * PX_PER_DAY }} />
          ))}
          {/* Today line */}
          {todayInWindow && (
            <div className="absolute inset-y-0 z-0 w-px bg-destructive"
              style={{ left: NAME_W + todayIdx * PX_PER_DAY + PX_PER_DAY / 2 }} />
          )}

          {/* Header */}
          <div className="relative z-10 flex border-b border-border">
            <div className="sticky left-0 z-10 w-56 shrink-0 border-r border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground">
              Task
            </div>
            {weeks.map((w) => (
              <div key={w.toISOString()} className="shrink-0 px-1.5 py-1.5 text-xs text-muted-foreground"
                style={{ width: 7 * PX_PER_DAY }}>
                {w.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
              </div>
            ))}
          </div>

          {/* Rows */}
          {scheduled.map((t) => {
            const start = parseDay((t.startDate ?? t.dueDate) as string);
            const end = parseDay((t.dueDate ?? t.startDate) as string);
            const s0 = dayIndex(windowStart, start);
            const e0 = Math.max(dayIndex(windowStart, end), s0);
            const visible = e0 >= 0 && s0 < TOTAL_DAYS;
            const s = Math.max(s0, 0);
            const e = Math.min(e0, TOTAL_DAYS - 1);
            const singleDay = !t.startDate;
            const overdue = !!t.dueDate && parseDay(t.dueDate).getTime() < todayStart.getTime()
              && catOf(t.statusId) !== 'done' && catOf(t.statusId) !== 'canceled';
            return (
              <div key={t.id} className="relative z-10 flex h-9 items-center border-b border-border/60 last:border-b-0">
                <button onClick={() => onOpenTask(t.id)} title={t.title}
                  className="sticky left-0 z-10 flex h-full w-56 shrink-0 items-center gap-2 border-r border-border bg-card px-3 text-left text-sm transition-colors duration-150 hover:bg-muted">
                  <PriorityIcon priority={t.priority} size={14} />
                  <span className="truncate">{t.title}</span>
                </button>
                {visible && (
                  <button
                    onClick={() => onOpenTask(t.id)}
                    title={`${t.title} · ${t.startDate ?? '?'} → ${t.dueDate ?? '?'}`}
                    className={cn(
                      'absolute top-1/2 h-4 -translate-y-1/2 rounded-full',
                      overdue ? 'bg-destructive/80 hover:bg-destructive' : 'bg-primary/70 hover:bg-primary',
                      singleDay && 'h-3 min-w-3',
                    )}
                    style={{
                      left: NAME_W + s * PX_PER_DAY + 1,
                      width: Math.max((e - s + 1) * PX_PER_DAY - 2, singleDay ? PX_PER_DAY : 4),
                    }}
                  />
                )}
                {!visible && (
                  <span className="pl-3 text-xs text-muted-foreground">
                    {e0 < 0 ? '← outside window' : 'outside window →'}
                  </span>
                )}
              </div>
            );
          })}

          {scheduled.length === 0 && (
            <p className="relative z-10 bg-card px-3 py-6 text-sm text-muted-foreground">
              No tasks with a start or due date yet. Set dates on tasks to see them on the timeline.
            </p>
          )}
        </div>
      </div>

      {undated.length > 0 && (
        <div className="rounded-lg border border-border bg-card">
          <h3 className="border-b border-border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            No dates <span className="ml-1 rounded bg-muted px-1.5 py-0.5 tabular-nums">{undated.length}</span>
          </h3>
          {undated.map((t, i) => (
            <button key={t.id} onClick={() => onOpenTask(t.id)}
              className={cn('flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors duration-150 hover:bg-muted', i > 0 && 'border-t border-border/60')}>
              <PriorityIcon priority={t.priority} size={14} />
              {(t.ref || t.number != null) && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{t.ref ?? `#${t.number}`}</span>}
              <span className="flex-1 truncate">{t.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
