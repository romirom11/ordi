import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { useCan } from '../lib/auth';
import { Button, Input, Textarea, Select, Card, PageHeader, Skeleton, fmtMoney, cn } from '../components/ui';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';

interface TimeEntry {
  id: string;
  taskId?: string | null;
  taskRef?: string | null;
  projectName?: string | null;
  durationSeconds: number | string;
  note?: string | null;
  startedAt?: string | null;
  date?: string | null;
}
interface DayGroup { date: string; entries: TimeEntry[] }
interface MyWeek { weekStart?: string; days?: DayGroup[]; entries?: TimeEntry[]; totalSeconds?: number | string }
interface ReportRow { key?: string; label?: string; name?: string; hours?: number | string; seconds?: number | string; billableAmount?: number | string; currency?: string }

function mondayOf(d: Date): Date {
  const date = new Date(d);
  const dow = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - dow);
  date.setHours(0, 0, 0, 0);
  return date;
}
function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m > 0 ? m + 'm' : ''}`.trim() : `${m}m`;
}
function weekDates(weekStart: string): string[] {
  const base = new Date(weekStart + 'T00:00:00');
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    return isoDate(d);
  });
}
function entryDate(e: TimeEntry): string {
  return (e.date ?? e.startedAt ?? '').slice(0, 10);
}

export function TimePage() {
  const can = useCan();
  const [tab, setTab] = useState<'week' | 'reports'>('week');
  const canReports = can('time.read_all');

  return (
    <div>
      <PageHeader
        title="Time"
        actions={
          <div className="flex rounded-md border border-border p-0.5 text-sm">
            <button className={cn('rounded px-3 py-1', tab === 'week' && 'bg-muted font-medium')} onClick={() => setTab('week')}>My week</button>
            {canReports && (
              <button className={cn('rounded px-3 py-1', tab === 'reports' && 'bg-muted font-medium')} onClick={() => setTab('reports')}>Reports</button>
            )}
          </div>
        }
      />
      {tab === 'week' ? <MyWeekView /> : <ReportsView />}
    </div>
  );
}

function MyWeekView() {
  const qc = useQueryClient();
  const [weekStart, setWeekStart] = useState(() => isoDate(mondayOf(new Date())));
  const week = useQuery({
    queryKey: ['myWeek', weekStart],
    queryFn: () => api.get<MyWeek>('/time/my-week' + qs({ weekStart })),
  });

  const [form, setForm] = useState({ taskId: '', date: weekStart, minutes: '', note: '' });
  const addEntry = useMutation({
    mutationFn: () =>
      api.post('/time/entries', {
        taskId: form.taskId,
        date: form.date,
        startedAt: form.date,
        durationSeconds: Math.round(Number(form.minutes) * 60),
        note: form.note,
      }),
    onSuccess: () => {
      setForm({ taskId: '', date: weekStart, minutes: '', note: '' });
      qc.invalidateQueries({ queryKey: ['myWeek'] });
    },
  });

  const dates = weekDates(weekStart);
  const rawEntries = week.data?.days ? week.data.days.flatMap((d) => d.entries.map((e) => ({ ...e, date: e.date ?? d.date }))) : week.data?.entries ?? [];
  const byDate = new Map<string, TimeEntry[]>();
  for (const d of dates) byDate.set(d, []);
  for (const e of rawEntries) {
    const key = entryDate(e);
    const bucket = byDate.get(key);
    if (bucket) bucket.push(e);
  }
  const weekTotal = rawEntries.reduce((acc, e) => acc + Number(e.durationSeconds), 0);

  const shift = (deltaDays: number) => {
    const d = new Date(weekStart + 'T00:00:00');
    d.setDate(d.getDate() + deltaDays);
    setWeekStart(isoDate(mondayOf(d)));
  };

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <button className="rounded border border-border p-1.5 hover:bg-muted" onClick={() => shift(-7)}><ChevronLeft size={15} /></button>
        <span className="text-sm font-medium">Week of {weekStart}</span>
        <button className="rounded border border-border p-1.5 hover:bg-muted" onClick={() => shift(7)}><ChevronRight size={15} /></button>
        <button className="text-xs text-muted-foreground hover:underline" onClick={() => setWeekStart(isoDate(mondayOf(new Date())))}>This week</button>
        <span className="ml-auto text-sm text-muted-foreground">Total: <span className="font-medium text-foreground">{fmtDur(weekTotal)}</span></span>
      </div>

      {week.isLoading ? (
        <Skeleton className="h-56 w-full" />
      ) : (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-7">
          {dates.map((d) => {
            const entries = byDate.get(d) ?? [];
            const dayTotal = entries.reduce((a, e) => a + Number(e.durationSeconds), 0);
            const label = new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
            return (
              <Card key={d} className="flex min-h-40 flex-col p-2">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-medium">{label}</span>
                  {dayTotal > 0 && <span className="text-[10px] text-muted-foreground">{fmtDur(dayTotal)}</span>}
                </div>
                <div className="space-y-1">
                  {entries.map((e) => (
                    <div key={e.id} className="rounded bg-muted/60 p-1.5 text-xs">
                      <div className="font-medium">{e.taskRef ?? e.projectName ?? 'Entry'}</div>
                      <div className="text-muted-foreground">{fmtDur(Number(e.durationSeconds))}</div>
                      {e.note && <div className="truncate text-muted-foreground">{e.note}</div>}
                    </div>
                  ))}
                  {entries.length === 0 && <div className="text-[11px] text-muted-foreground">—</div>}
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Card className="mt-6 max-w-2xl p-4">
        <div className="mb-3 text-sm font-medium">Add manual entry</div>
        <form
          className="grid grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.taskId && Number(form.minutes) > 0) addEntry.mutate();
          }}
        >
          <label className="text-xs text-muted-foreground">
            Task ID
            <Input value={form.taskId} onChange={(e) => setForm((f) => ({ ...f, taskId: e.target.value }))} placeholder="task id" className="mt-1" />
          </label>
          <label className="text-xs text-muted-foreground">
            Date
            <Input type="date" value={form.date} onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} className="mt-1" />
          </label>
          <label className="text-xs text-muted-foreground">
            Duration (minutes)
            <Input type="number" min={1} value={form.minutes} onChange={(e) => setForm((f) => ({ ...f, minutes: e.target.value }))} placeholder="60" className="mt-1" />
          </label>
          <label className="text-xs text-muted-foreground">
            Note
            <Textarea value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} rows={1} className="mt-1" />
          </label>
          <div className="col-span-2 flex items-center gap-3">
            <Button type="submit" size="sm" disabled={addEntry.isPending}><Plus size={14} /> Add entry</Button>
            {addEntry.isError && <span className="text-xs text-destructive">Failed to add entry.</span>}
          </div>
        </form>
      </Card>
    </div>
  );
}

function ReportsView() {
  const [groupBy, setGroupBy] = useState<'project' | 'user' | 'company'>('project');
  const report = useQuery({
    queryKey: ['timeReport', groupBy],
    queryFn: () => api.get<{ data: ReportRow[] }>('/time/reports' + qs({ groupBy })),
  });
  const rows = report.data?.data ?? [];
  const hoursOf = (r: ReportRow): number => (r.hours != null ? Number(r.hours) : r.seconds != null ? Number(r.seconds) / 3600 : 0);

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Group by</span>
        <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as typeof groupBy)}>
          <option value="project">Project</option>
          <option value="user">User</option>
          <option value="company">Company</option>
        </Select>
      </div>
      <Card>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">{groupBy[0]!.toUpperCase() + groupBy.slice(1)}</th>
              <th className="px-4 py-2 text-right font-medium">Hours</th>
              <th className="px-4 py-2 text-right font-medium">Billable</th>
            </tr>
          </thead>
          <tbody>
            {report.isLoading && (
              <tr><td colSpan={3} className="px-4 py-3"><Skeleton className="h-5 w-full" /></td></tr>
            )}
            {!report.isLoading && rows.length === 0 && (
              <tr><td colSpan={3} className="px-4 py-8 text-center text-muted-foreground">No time recorded for this grouping yet.</td></tr>
            )}
            {rows.map((r, i) => (
              <tr key={r.key ?? r.name ?? r.label ?? String(i)} className="border-b border-border last:border-0">
                <td className="px-4 py-2">{r.label ?? r.name ?? r.key ?? '—'}</td>
                <td className="px-4 py-2 text-right tabular-nums">{hoursOf(r).toFixed(1)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{r.billableAmount != null ? fmtMoney(r.billableAmount, r.currency ?? 'USD') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
