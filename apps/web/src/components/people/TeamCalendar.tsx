/**
 * HR team calendar (PRD §12.2): one month grid answering "who is away and
 * when". Absences (approved solid, pending faded), public holidays from the
 * holiday calendars, and birthdays – recurring yearly off the employee card,
 * so an updated birthday moves here by itself. Everyone with people.read sees
 * it; absence types are deliberately visible (who is sick vs on vacation).
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Cake, ChevronLeft, ChevronRight, Sun } from 'lucide-react';
import { api } from '../../lib/api';
import { useUserMap } from '../../lib/queries';
import { useT, extendDict } from '../../lib/i18n';
import { Avatar, Button, Skeleton, appLocale, cn } from '../ui';

extendDict({
  en: {
    'people.calToday': 'Today',
    'people.calPending': 'pending approval',
    'people.calHoliday': 'Holiday',
    'people.calBirthday': 'Birthday',
    'people.calLegendApproved': 'Approved absence',
    'people.calLegendPending': 'Pending absence',
  },
  uk: {
    'people.calToday': 'Сьогодні',
    'people.calPending': 'очікує погодження',
    'people.calHoliday': 'Вихідний',
    'people.calBirthday': 'День народження',
    'people.calLegendApproved': 'Погоджена відсутність',
    'people.calLegendPending': 'Відсутність на погодженні',
  },
});

interface LeaveRow {
  id: string; employeeId?: string | null; employeeName?: string | null; leaveTypeName?: string | null;
  fromDate?: string | null; toDate?: string | null; status?: string | null; halfDay?: boolean;
  employeeAvatar?: string | null;
}
interface Holiday { id: string; date: string; name: string; calendarId?: string }
interface EmpRow { id: string; userId?: string | null; firstName?: string | null; lastName?: string | null; birthday?: string | null; status?: string | null }

const TYPE_COLORS = ['#6366f1', '#f59e0b', '#06b6d4', '#ec4899', '#a855f7', '#84cc16', '#f43f5e', '#22c55e'];
function typeColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return TYPE_COLORS[Math.abs(h) % TYPE_COLORS.length]!;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function empShort(e: EmpRow): string {
  const first = (e.firstName ?? '').trim();
  const last = (e.lastName ?? '').trim();
  return [first, last ? `${last[0]}.` : ''].filter(Boolean).join(' ');
}

export function TeamCalendar() {
  const t = useT();
  const now = new Date();
  const [cursor, setCursor] = useState(() => new Date(now.getFullYear(), now.getMonth(), 1));

  const userMap = useUserMap();
  const leavesQ = useQuery({ queryKey: ['leaveRequests'], queryFn: () => api.get<{ data: LeaveRow[] }>('/leave-requests') });
  const holidaysQ = useQuery({ queryKey: ['holidays'], queryFn: () => api.get<{ data: Holiday[] }>('/holidays') });
  const employeesQ = useQuery({ queryKey: ['employees'], queryFn: () => api.get<{ data: EmpRow[] }>('/employees') });

  // Monday-first 6x7 grid, same as the tasks calendar.
  const offset = (cursor.getDay() + 6) % 7;
  const gridStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1 - offset);
  const cells: Date[] = Array.from({ length: 42 }, (_, i) =>
    new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
  const gridFrom = ymd(cells[0]!);
  const gridTo = ymd(cells[41]!);

  /** Absence entries per day: a range paints every day it covers. */
  const leavesByDay = useMemo(() => {
    const map = new Map<string, LeaveRow[]>();
    for (const lr of leavesQ.data?.data ?? []) {
      if (lr.status !== 'approved' && lr.status !== 'pending') continue;
      const from = (lr.fromDate ?? '').slice(0, 10);
      const to = (lr.toDate ?? from).slice(0, 10);
      if (!from || to < gridFrom || from > gridTo) continue;
      const start = new Date(Math.max(new Date(from).getTime(), new Date(gridFrom).getTime()));
      const end = new Date(Math.min(new Date(to).getTime(), new Date(gridTo).getTime()));
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const key = ymd(d);
        const list = map.get(key);
        if (list) list.push(lr); else map.set(key, [lr]);
      }
    }
    return map;
  }, [leavesQ.data, gridFrom, gridTo]);

  const holidaysByDay = useMemo(() => {
    const map = new Map<string, Holiday[]>();
    for (const h of holidaysQ.data?.data ?? []) {
      const key = (h.date ?? '').slice(0, 10);
      if (!key) continue;
      // Two calendars can name the same day – show it once per name.
      const list = map.get(key) ?? [];
      if (!list.some((x) => x.name === h.name)) list.push(h);
      map.set(key, list);
    }
    return map;
  }, [holidaysQ.data]);

  /** Birthdays recur yearly: match by month-day against the grid's days. */
  const birthdaysByDay = useMemo(() => {
    const map = new Map<string, EmpRow[]>();
    const active = (employeesQ.data?.data ?? []).filter((e) => e.status !== 'terminated' && e.birthday);
    for (const cell of cells) {
      const md = ymd(cell).slice(5); // MM-DD
      const matches = active.filter((e) => (e.birthday ?? '').slice(5, 10) === md);
      if (matches.length) map.set(ymd(cell), matches);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeesQ.data, gridFrom, gridTo]);

  const todayKey = ymd(now);
  const monthLabel = cursor.toLocaleDateString(appLocale(), { month: 'long', year: 'numeric' });
  const weekdayLabels = useMemo(() => {
    // Monday-first localized weekday initials (2026-01-05 is a Monday).
    return Array.from({ length: 7 }, (_, i) =>
      new Date(2026, 0, 5 + i).toLocaleDateString(appLocale(), { weekday: 'short' }));
  }, []);
  const loading = leavesQ.isLoading || holidaysQ.isLoading || employeesQ.isLoading;

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" aria-label="Previous month"
          onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1))}>
          <ChevronLeft size={14} />
        </Button>
        <Button size="sm" variant="outline" aria-label="Next month"
          onClick={() => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1))}>
          <ChevronRight size={14} />
        </Button>
        <span className="ml-1 text-sm font-semibold capitalize">{monthLabel}</span>
        <Button size="sm" variant="ghost" className="text-muted-foreground"
          onClick={() => setCursor(new Date(now.getFullYear(), now.getMonth(), 1))}>
          {t('people.calToday')}
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-primary" /> {t('people.calLegendApproved')}</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full border border-primary bg-transparent" /> {t('people.calLegendPending')}</span>
          <span className="inline-flex items-center gap-1.5"><Sun size={12} /> {t('people.calHoliday')}</span>
          <span className="inline-flex items-center gap-1.5"><Cake size={12} /> {t('people.calBirthday')}</span>
        </div>
      </div>

      {loading ? (
        <Skeleton className="h-[480px] w-full rounded-lg" />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="grid grid-cols-7 border-b border-border">
            {weekdayLabels.map((d, i) => (
              <div key={d} className={cn('px-2 py-1.5 text-center text-xs font-medium capitalize', i >= 5 ? 'text-faint' : 'text-muted-foreground')}>{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((day, i) => {
              const key = ymd(day);
              const inMonth = day.getMonth() === cursor.getMonth();
              const weekend = i % 7 >= 5;
              const holidays = holidaysByDay.get(key) ?? [];
              const birthdays = birthdaysByDay.get(key) ?? [];
              const leaves = leavesByDay.get(key) ?? [];
              return (
                <div key={key}
                  className={cn(
                    'min-h-24 border-border p-1',
                    i % 7 !== 0 && 'border-l',
                    i >= 7 && 'border-t',
                    !inMonth && 'bg-muted/30',
                    inMonth && (weekend || holidays.length > 0) && 'bg-muted/15',
                  )}>
                  <div className={cn(
                    'mb-1 px-1 text-right text-xs tabular-nums',
                    key === todayKey
                      ? 'font-semibold text-primary'
                      : inMonth ? (weekend ? 'text-muted-foreground' : 'text-foreground') : 'text-muted-foreground',
                  )}>
                    {day.getDate()}
                  </div>
                  <div className="space-y-0.5">
                    {holidays.map((h) => (
                      <div key={h.id} title={h.name}
                        className="flex items-center gap-1 rounded bg-warning/10 px-1 py-0.5 text-xs text-warning">
                        <Sun size={10} className="shrink-0" />
                        <span className="truncate">{h.name}</span>
                      </div>
                    ))}
                    {birthdays.map((e) => {
                      const avatar = e.userId ? userMap.get(e.userId)?.avatar : undefined;
                      return (
                        <div key={`bd-${e.id}`} title={`${t('people.calBirthday')} – ${empShort(e)}`}
                          className="flex items-center gap-1 rounded bg-pink-500/10 px-1 py-0.5 text-xs text-pink-500">
                          <Cake size={10} className="shrink-0" />
                          {avatar && <Avatar name={empShort(e)} src={avatar} size={14} />}
                          <span className="truncate">{empShort(e)}</span>
                        </div>
                      );
                    })}
                    {leaves.map((lr) => {
                      const pending = lr.status === 'pending';
                      const color = typeColor(lr.leaveTypeName ?? '');
                      const label = `${lr.employeeName ?? '–'} · ${lr.leaveTypeName ?? ''}${pending ? ` (${t('people.calPending')})` : ''}`;
                      return (
                        <div key={`${lr.id}-${key}`} title={label}
                          className={cn('flex items-center gap-1 rounded px-1 py-0.5 text-xs', pending && 'opacity-60')}>
                          <span
                            className={cn('h-2 w-2 shrink-0 rounded-full', pending && 'border bg-transparent')}
                            style={pending ? { borderColor: color } : { backgroundColor: color }}
                          />
                          {lr.employeeAvatar && <Avatar name={lr.employeeName ?? ''} src={lr.employeeAvatar} size={14} />}
                          <span className="truncate text-foreground/90">{lr.employeeName ?? '–'}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
