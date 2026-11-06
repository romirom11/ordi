/**
 * Pieces of time tracking shared by the Time page and the task page: an entry
 * row, the panel an entry opens in (details, edit, delete), the "Log time"
 * dialog and the duration helpers.
 */
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ArrowUpRight, CalendarDays, Clock, FileText, Plus, Receipt, Trash2, User } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useCan, useMe } from '../../lib/auth';
import { useOpen } from '../../lib/router';
import { useT, extendDict } from '../../lib/i18n';
import { Avatar, Badge, Button, Input, Select, Skeleton, Switch, Textarea, appLocale, cn } from '../ui';
import { ConfirmDialog, Dialog, SidePanel, toast } from '../overlays';
import { DateField } from '../DatePicker';

extendDict({
  en: {
    'time.duration': 'Duration',
    'time.durationHint': 'e.g. 1h 30m, 1:30 or 90',
    'time.durationInvalid': 'Enter a duration, e.g. 1h 30m.',
    'time.logTime': 'Log time',
    'time.logTimeOn': 'Log time on {task}',
    'time.openTask': 'Open task',
    'time.date': 'Date',
    'time.timeOfDay': 'Time',
    'time.person': 'Person',
    'time.invoiced': 'Invoiced',
    'time.invoicedHint': 'This time is on an invoice: its duration can change only after it comes off the invoice.',
    'time.deleteEntry': 'Delete entry',
    'time.deleteEntryConfirm': 'Delete this time entry? This cannot be undone.',
    'time.entryDeleted': 'Entry deleted',
    'time.entryNotFound': 'This entry no longer exists.',
    'time.saveFailed': 'Could not save the entry',
    'time.noNote': 'No note',
    'time.nonBillable': 'Non-billable',
  },
  uk: {
    'time.duration': 'Тривалість',
    'time.durationHint': 'напр. 1h 30m, 1:30 або 90',
    'time.durationInvalid': 'Вкажіть тривалість, напр. 1h 30m.',
    'time.logTime': 'Додати час',
    'time.logTimeOn': 'Додати час до {task}',
    'time.openTask': 'Відкрити задачу',
    'time.date': 'Дата',
    'time.timeOfDay': 'Час',
    'time.person': 'Людина',
    'time.invoiced': 'Виставлено в рахунку',
    'time.invoicedHint': 'Цей час уже в рахунку: тривалість можна змінити лише після того, як його приберуть з рахунку.',
    'time.deleteEntry': 'Видалити запис',
    'time.deleteEntryConfirm': 'Видалити цей запис часу? Це не можна скасувати.',
    'time.entryDeleted': 'Запис видалено',
    'time.entryNotFound': 'Цього запису вже немає.',
    'time.saveFailed': 'Не вдалося зберегти запис',
    'time.noNote': 'Без нотатки',
    'time.nonBillable': 'Неоплачуваний',
  },
});

export interface TimeEntry {
  id: string;
  taskId: string;
  userId: string;
  projectId: string;
  startedAt: string;
  durationSeconds: number | string;
  note?: string | null;
  billable?: boolean;
  invoiceItemId?: string | null;
  version?: number;
  taskRef?: string | null;
  taskTitle?: string | null;
  projectName?: string | null;
  projectKey?: string | null;
  userName?: string | null;
}

/* ───────────────────────── Helpers ───────────────────────── */

export function fmtDur(sec: number): string {
  const total = Math.max(0, Math.round(sec / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Read a typed duration into seconds: "1h 30m", "1.5h", "45m", "1:30" or a bare
 * number of minutes. Null when it is not a positive duration.
 */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(',', '.');
  if (!s) return null;
  let minutes: number | null = null;
  const clock = /^(\d+):([0-5]?\d)$/.exec(s);
  if (clock) minutes = Number(clock[1]) * 60 + Number(clock[2]);
  else if (/^\d+(\.\d+)?$/.test(s)) minutes = Number(s);
  else {
    const m = /^(?:(\d+(?:\.\d+)?)\s*(?:h|г|год))?\s*(?:(\d+(?:\.\d+)?)\s*(?:m|min|хв))?$/.exec(s);
    if (m && (m[1] || m[2])) minutes = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  }
  if (minutes == null || !Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.round(minutes * 60);
}

/** The value a duration field starts with when editing. */
export function durationInput(sec: number): string {
  return fmtDur(sec);
}

export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A manual entry is stored at midnight UTC of its day; only a timer gives an
 * entry a real time of day. Showing 02:00–03:00 for a manual hour would invent
 * one, so such entries show their date alone.
 */
export function hasTimeOfDay(startedAt: string): boolean {
  return !startedAt.endsWith('T00:00:00.000Z') && !/T00:00:00(\.0+)?(Z|\+00:00)$/.test(startedAt);
}

/** The calendar day an entry counts on, as the user sees it. */
export function entryDay(e: Pick<TimeEntry, 'startedAt'>): string {
  return hasTimeOfDay(e.startedAt) ? isoDay(new Date(e.startedAt)) : e.startedAt.slice(0, 10);
}

function fmtClockTime(d: Date): string {
  return d.toLocaleTimeString(appLocale(), { hour: '2-digit', minute: '2-digit' });
}

export function timeRange(e: Pick<TimeEntry, 'startedAt' | 'durationSeconds'>): string | null {
  if (!hasTimeOfDay(e.startedAt)) return null;
  const start = new Date(e.startedAt);
  const end = new Date(start.getTime() + Number(e.durationSeconds) * 1000);
  return `${fmtClockTime(start)} – ${fmtClockTime(end)}`;
}

function fmtLongDay(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString(appLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** Every view that shows logged time, refreshed after a change to an entry. */
export function invalidateTime(qc: QueryClient): void {
  for (const key of ['timer', 'time', 'myWeek', 'timeReport', 'timeEntries', 'taskTime', 'timeEntry']) {
    void qc.invalidateQueries({ queryKey: [key] });
  }
}

/* ───────────────────────── Entry row ───────────────────────── */

/** One entry in a list: task first, the note under it, the duration on the right. */
export function TimeEntryRow({ entry, onOpen, showUser, showDay, showProject = true, className }: {
  entry: TimeEntry; onOpen: (e: TimeEntry) => void; showUser?: boolean; showDay?: boolean; showProject?: boolean; className?: string;
}) {
  const t = useT();
  const meta = [
    showUser ? entry.userName : null,
    showDay ? new Date(entryDay(entry) + 'T00:00:00').toLocaleDateString(appLocale(), { day: 'numeric', month: 'short' }) : null,
    timeRange(entry),
    showProject ? entry.projectName : null,
  ].filter(Boolean).join(' · ');
  const note = entry.taskTitle ? entry.note : null;
  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      className={cn('group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none', className)}
    >
      {showUser && <Avatar name={entry.userName ?? '?'} size={20} />}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          {entry.taskRef && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{entry.taskRef}</span>}
          <span className="truncate text-[13px] font-medium">{entry.taskTitle ?? entry.note ?? t('time.entry')}</span>
        </div>
        {(note || meta) && (
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs">
            {note && <span className="min-w-[3rem] truncate text-muted-foreground">{note}</span>}
            {note && meta && <span className="shrink-0 text-faint">·</span>}
            {meta && <span className="min-w-0 shrink truncate text-faint">{meta}</span>}
          </div>
        )}
      </div>
      {entry.billable === false && <Badge className="shrink-0">{t('time.nonBillable')}</Badge>}
      {entry.invoiceItemId && <Receipt size={13} className="shrink-0 text-muted-foreground" aria-label={t('time.invoiced')} />}
      <span className="shrink-0 font-mono text-[13px] tabular-nums text-muted-foreground group-hover:text-foreground">{fmtDur(Number(entry.durationSeconds))}</span>
    </button>
  );
}

/* ───────────────────────── Entry panel ───────────────────────── */

function Fact({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className="mt-0.5 text-muted-foreground [&>svg]:block">{icon}</span>
      <span className="w-20 shrink-0 text-xs leading-5 text-muted-foreground">{label}</span>
      <div className="min-w-0 flex-1 text-[13px] leading-5">{children}</div>
    </div>
  );
}

/**
 * Everything about one entry, opened from any list of them. The owner (or
 * someone with time.manage) edits it in place; the task is one click away.
 */
export function TimeEntryPanel({ entry: initial, onClose }: { entry: TimeEntry | null; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const me = useMe();
  const open = useOpen();
  // Keep the last entry while the panel slides out.
  const [shown, setShown] = useState<TimeEntry | null>(initial);
  useEffect(() => { if (initial) setShown(initial); }, [initial]);

  const q = useQuery({
    queryKey: ['timeEntry', shown?.id],
    queryFn: () => api.get<TimeEntry>(`/time/entries/${shown!.id}`),
    enabled: !!initial,
    initialData: initial ?? undefined,
    staleTime: 0,
  });
  const entry = q.data ?? shown;

  const [duration, setDuration] = useState('');
  const [day, setDay] = useState('');
  const [note, setNote] = useState('');
  const [billable, setBillable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reset the form whenever another entry (or a newer version of it) arrives.
  useEffect(() => {
    if (!entry) return;
    setDuration(durationInput(Number(entry.durationSeconds)));
    setDay(entryDay(entry));
    setNote(entry.note ?? '');
    setBillable(entry.billable !== false);
    setError(null);
  }, [entry?.id, entry?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch<TimeEntry>(`/time/entries/${entry!.id}`, { ...patch, version: entry!.version }),
    onSuccess: () => { toast(t('common.saved')); invalidateTime(qc); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('time.saveFailed')),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/time/entries/${entry!.id}`),
    onSuccess: () => { setConfirmDelete(false); toast(t('time.entryDeleted')); invalidateTime(qc); onClose(); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('time.saveFailed')),
  });

  if (!entry) return null;
  const mine = entry.userId === me.user.id;
  const editable = mine || can('time.manage');
  const invoiced = !!entry.invoiceItemId;
  const seconds = Number(entry.durationSeconds);
  const range = timeRange(entry);

  const submit = () => {
    setError(null);
    const secs = parseDuration(duration);
    if (secs == null) { setError(t('time.durationInvalid')); return; }
    const patch: Record<string, unknown> = {};
    if (secs !== seconds) patch.durationSeconds = secs;
    if (note !== (entry.note ?? '')) patch.note = note;
    if (billable !== (entry.billable !== false)) patch.billable = billable;
    if (day && day !== entryDay(entry)) {
      if (hasTimeOfDay(entry.startedAt)) {
        // Move to the new day, keeping the time of day the timer started at.
        const moved = new Date(entry.startedAt);
        const [y, m, d] = day.split('-').map(Number);
        moved.setFullYear(y!, m! - 1, d!);
        patch.startedAt = moved.toISOString();
      } else {
        patch.startedAt = day;
      }
    }
    if (Object.keys(patch).length === 0) return;
    save.mutate(patch);
  };
  const dirty = parseDuration(duration) !== seconds || note !== (entry.note ?? '')
    || billable !== (entry.billable !== false) || (!!day && day !== entryDay(entry));

  return (
    <>
      <SidePanel
        open={!!initial}
        onClose={onClose}
        width={480}
        icon={<Clock size={16} />}
        title={entry.taskTitle ?? t('time.entry')}
        subtitle={[entry.taskRef, entry.projectName].filter(Boolean).join(' · ')}
      >
        {q.isError && q.error instanceof ApiError && q.error.status === 404 ? (
          <p className="text-[13px] text-muted-foreground">{t('time.entryNotFound')}</p>
        ) : (
          <div className="space-y-5">
            <div className="flex items-end justify-between gap-3">
              <div>
                <div className="font-mono text-[32px] font-semibold leading-none tabular-nums">{fmtDur(seconds)}</div>
                <div className="mt-1.5 text-xs text-muted-foreground">{fmtLongDay(entryDay(entry))}</div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={(e) => { onClose(); open(`/projects/${entry.projectId}/tasks/${entry.taskId}`, e); }}
                onAuxClick={(e) => open(`/projects/${entry.projectId}/tasks/${entry.taskId}`, e)}
              >
                {t('time.openTask')} <ArrowUpRight size={13} />
              </Button>
            </div>

            {/* What the form below cannot change; the rest shows only to readers. */}
            {(!editable || range || !mine || invoiced) && (
              <div className="divide-y divide-border rounded-lg border border-border px-3">
                {!editable && <Fact icon={<CalendarDays size={14} />} label={t('time.date')}>{fmtLongDay(entryDay(entry))}</Fact>}
                {range && <Fact icon={<Clock size={14} />} label={t('time.timeOfDay')}>{range}</Fact>}
                {!mine && entry.userName && (
                  <Fact icon={<User size={14} />} label={t('time.person')}>
                    <span className="inline-flex items-center gap-1.5"><Avatar name={entry.userName} size={16} />{entry.userName}</span>
                  </Fact>
                )}
                {!editable && (
                  <Fact icon={<FileText size={14} />} label={t('time.note')}>
                    {entry.note ? <span className="whitespace-pre-wrap">{entry.note}</span> : <span className="text-faint">{t('time.noNote')}</span>}
                  </Fact>
                )}
                {(!editable || invoiced) && (
                  <Fact icon={<Receipt size={14} />} label={t('time.billable')}>
                    {entry.billable === false ? t('time.nonBillable') : t('time.billable')}
                    {invoiced && <Badge className="ml-2">{t('time.invoiced')}</Badge>}
                  </Fact>
                )}
              </div>
            )}

            {editable && (
              <form
                className="space-y-3"
                onSubmit={(e) => { e.preventDefault(); submit(); }}
              >
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">{t('time.duration')}</label>
                    <Input value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="1h 30m" disabled={invoiced} />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">{t('time.date')}</label>
                    <DateField value={day} onChange={(v) => setDay(v ?? '')} clearable={false} />
                  </div>
                </div>
                {invoiced && <p className="text-xs text-muted-foreground">{t('time.invoicedHint')}</p>}
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{t('time.note')}</label>
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
                </div>
                <label className="flex items-center justify-between gap-3 text-[13px]">
                  <span>{t('time.billable')}</span>
                  <Switch checked={billable} onChange={setBillable} label={t('time.billable')} />
                </label>
                {error && <p className="text-xs text-destructive">{error}</p>}
                <div className="flex items-center justify-between gap-2 pt-1">
                  <Button type="button" variant="ghost" size="sm" className="text-destructive" onClick={() => setConfirmDelete(true)} disabled={invoiced}>
                    <Trash2 size={13} /> {t('time.deleteEntry')}
                  </Button>
                  <Button type="submit" size="sm" disabled={!dirty || save.isPending}>{t('common.save')}</Button>
                </div>
              </form>
            )}
          </div>
        )}
      </SidePanel>
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
        title={t('time.deleteEntry')}
        body={t('time.deleteEntryConfirm')}
        confirmLabel={t('common.delete')}
        danger
        pending={remove.isPending}
      />
    </>
  );
}

/* ───────────────────────── Log time ───────────────────────── */

interface MyTaskLite { id: string; title: string; ref?: string | null; key?: string | null; number?: number | null }
interface MeTasksBuckets { overdue?: MyTaskLite[]; today?: MyTaskLite[]; week?: MyTaskLite[]; later?: MyTaskLite[] }

/** The user's open tasks, flattened for the timer/entry task pickers. */
export function useMyTaskOptions(enabled: boolean): { id: string; label: string }[] {
  const q = useQuery({
    queryKey: ['me', 'tasks'],
    queryFn: () => api.get<MeTasksBuckets>('/me/tasks'),
    enabled,
    staleTime: 30_000,
  });
  const seen = new Set<string>();
  const out: { id: string; label: string }[] = [];
  for (const bucket of [q.data?.overdue, q.data?.today, q.data?.week, q.data?.later]) {
    for (const task of bucket ?? []) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      const ref = task.ref ?? (task.key && task.number != null ? `${task.key}-${task.number}` : '');
      out.push({ id: task.id, label: ref ? `${ref} · ${task.title}` : task.title });
    }
  }
  return out;
}

/** Task dropdown for time tracking. */
export function TaskSelect({ value, onChange, open }: { value: string; onChange: (id: string) => void; open: boolean }) {
  const t = useT();
  const options = useMyTaskOptions(open);
  if (open && options.length === 0) {
    return <p className="rounded-md border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">{t('time.noMyTasks')}</p>;
  }
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="w-full">
      <option value="">{t('time.pickTask')}</option>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </Select>
  );
}

/**
 * Add time by hand. With a `task` the dialog logs against it (the task page);
 * without one it asks which of the user's tasks.
 */
export function LogTimeDialog({ open, onClose, task, defaultDay }: {
  open: boolean; onClose: () => void; task?: { id: string; label: string }; defaultDay?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [taskId, setTaskId] = useState('');
  const [day, setDay] = useState(defaultDay ?? isoDay(new Date()));
  const [duration, setDuration] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTaskId(task?.id ?? '');
    setDay(defaultDay ?? isoDay(new Date()));
    setDuration('');
    setNote('');
    setError(null);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = useMutation({
    mutationFn: (durationSeconds: number) => api.post('/time/entries', { taskId, startedAt: day, durationSeconds, note }),
    onSuccess: () => { toast(t('common.saved')); invalidateTime(qc); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : t('time.addEntryFailed')),
  });

  return (
    <Dialog open={open} onClose={onClose} title={task ? t('time.logTimeOn').replace('{task}', task.label) : t('time.addManualEntry')} width={420}>
      <form
        className="space-y-3 px-4 pb-4 pt-1"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          if (!taskId) { setError(t('time.taskRequired')); return; }
          const secs = parseDuration(duration);
          if (secs == null) { setError(t('time.durationInvalid')); return; }
          add.mutate(secs);
        }}
      >
        {!task && (
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('time.task')}</label>
            <TaskSelect value={taskId} onChange={setTaskId} open={open} />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('time.duration')}</label>
            <Input autoFocus value={duration} onChange={(e) => setDuration(e.target.value)} placeholder="1h 30m" />
            <p className="text-[11px] text-faint">{t('time.durationHint')}</p>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('time.date')}</label>
            <DateField value={day} onChange={(v) => setDay(v ?? isoDay(new Date()))} clearable={false} />
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('time.note')}</label>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={add.isPending}><Plus size={13} /> {t('time.logTime')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Loading rows for an entry list. */
export function EntryListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-9 w-full" />)}
    </div>
  );
}
