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
import { DropdownMenu } from '../overlays';

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

function empFull(e: EmpRow): string {
  return [(e.firstName ?? '').trim(), (e.lastName ?? '').trim()].filter(Boolean).join(' ');
}

/**
 * Everything one day holds, in full – the grid cell truncates on narrow
 * screens and a native title tooltip never fires on touch, so the cell opens
 * this popover instead of leaving the reader to guess the cut-off names.
 */
function DayDetails({ day, holidays, birthdays, leaves, userMap }: {
  day: Date;
  holidays: Holiday[];
  birthdays: EmpRow[];
  leaves: LeaveRow[];
  userMap: Map<string, { avatar?: string | null }>;
}) {
  const t = useT();
  return (
    <div className="max-h-72 overflow-y-auto">
      <div className="px-2 pb-1 pt-1.5 text-xs font-semibold capitalize text-muted-foreground">
        {day.toLocaleDateString(appLocale(), { weekday: 'long', day: 'numeric', month: 'long' })}
      </div>
      {holidays.map((h) => (
        <div key={h.id} className="flex items-start gap-2 rounded-md px-2 py-1 text-[13px]">
          <Sun size={13} className="mt-0.5 shrink-0 text-warning" />
          <span className="min-w-0 break-words text-warning">{h.name}</span>
        </div>
      ))}
      {birthdays.map((e) => {
        const avatar = e.userId ? userMap.get(e.userId)?.avatar : undefined;
        return (
          <div key={`bd-${e.id}`} className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px]">
            <Cake size={13} className="shrink-0 text-pink-500" />
            {avatar && <Avatar name={empFull(e)} src={avatar} size={16} />}
            <span className="min-w-0 flex-1 break-words">{empFull(e)}</span>
            <span className="shrink-0 text-xs text-faint">{t('people.calBirthday')}</span>
          </div>
        );
      })}
      {leaves.map((lr) => {
        const pending = lr.status === 'pending';
        const color = typeColor(lr.leaveTypeName ?? '');
        return (
          <div key={lr.id} className={cn('flex items-center gap-2 rounded-md px-2 py-1 text-[13px]', pending && 'opacity-60')}>
            <span
              className={cn('h-2 w-2 shrink-0 rounded-full', pending && 'border bg-transparent')}
              style={pending ? { borderColor: color } : { backgroundColor: color }}
            />
            {lr.employeeAvatar && <Avatar name={lr.employeeName ?? ''} src={lr.employeeAvatar} size={16} />}
            <span className="min-w-0 flex-1 break-words">{lr.employeeName ?? '–'}</span>
            <span className="shrink-0 text-xs text-faint">
              {lr.leaveTypeName ?? ''}{pending ? ` (${t('people.calPending')})` : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
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
              const hasEvents = holidays.length + birthdays.length + leaves.length > 0;
              const cellBody = (
                <div className={cn(
                  'min-h-24 w-full p-1 text-left',
                  hasEvents && 'cursor-pointer transition-colors duration-150 hover:bg-muted/40',
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
                        className="flex items-start gap-1 rounded bg-warning/10 px-1 py-0.5 text-xs text-warning">
                        <Sun size={10} className="mt-0.5 shrink-0" />
                        <span className="line-clamp-2 min-w-0 break-words">{h.name}</span>
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
              return (
                <div key={key}
                  className={cn(
                    'border-border',
                    i % 7 !== 0 && 'border-l',
                    i >= 7 && 'border-t',
                    !inMonth && 'bg-muted/30',
                    inMonth && (weekend || holidays.length > 0) && 'bg-muted/15',
                  )}>
                  {/* A cell with events opens the day in full – truncated chips
                      and hover-only tooltips leave touch screens guessing. */}
                  <DropdownMenu disabled={!hasEvents} width={280} className="h-full w-full" trigger={cellBody}>
                    <DayDetails day={day} holidays={holidays} birthdays={birthdays} leaves={leaves} userMap={userMap} />
                  </DropdownMenu>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
