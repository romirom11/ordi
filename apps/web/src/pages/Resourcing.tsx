import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useCan } from '../lib/auth';
import { Button, IconButton, Input, Select, Card, Avatar, PageHeader, PageBody, Breadcrumbs, EmptyState, Skeleton, appLocale, cn } from '../components/ui';
import { Dialog, DropdownMenu, MenuItem, MenuLabel, MenuSeparator, toast } from '../components/overlays';
import { ChevronLeft, ChevronRight, Plus, Trash2, Users } from 'lucide-react';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'resourcing.emptyRange': 'Nobody is allocated in this range',
    'resourcing.emptyRangeHint': 'Add allocations to plan the team’s load over the coming weeks.',
    'resourcing.legendUnder': 'Under-utilized',
    'resourcing.legendOk': 'On track',
    'resourcing.legendOver': 'Over-allocated',
    'resourcing.thisWeekShort': 'Now',
    'resourcing.addForUser': 'Add allocation',
    'resourcing.allocationDeleted': 'Allocation removed',
    'resourcing.pickUserProject': 'Pick a person and a project.',
    'resourcing.hoursRequired': 'Enter hours per week.',
    'resourcing.datesRequired': 'Pick the from and to dates.',
    'resourcing.datesOrder': 'The end date must be after the start date.',
  },
  uk: {
    'resourcing.emptyRange': 'У цьому діапазоні нікого не розподілено',
    'resourcing.emptyRangeHint': 'Додайте розподіли, щоб спланувати завантаження команди на наступні тижні.',
    'resourcing.legendUnder': 'Недовантажений',
    'resourcing.legendOk': 'В нормі',
    'resourcing.legendOver': 'Перевантажений',
    'resourcing.thisWeekShort': 'Зараз',
    'resourcing.addForUser': 'Додати розподіл',
    'resourcing.allocationDeleted': 'Розподіл видалено',
    'resourcing.pickUserProject': 'Оберіть людину та проєкт.',
    'resourcing.hoursRequired': 'Вкажіть години на тиждень.',
    'resourcing.datesRequired': 'Оберіть дати початку та завершення.',
    'resourcing.datesOrder': 'Дата завершення має бути після дати початку.',
  },
});

interface Allocation {
  id: string;
  userId: string;
  projectId: string;
  hoursPerWeek: number | string;
  fromDate?: string | null;
  toDate?: string | null;
}
interface UserRow { id: string; name?: string | null; email?: string | null; avatar?: string | null }
interface ProjectRow { id: string; name?: string | null }
interface LeaveRow {
  id: string;
  userId?: string;
  employeeUserId?: string;
  fromDate?: string | null;
  toDate?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

const WEEKS_SHOWN = 6;
const CAPACITY_HOURS = 40;

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
function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return isoDate(d);
}
/** ISO date-string overlap check against [weekStart, weekEnd]; open-ended ranges overlap. */
function overlapsWeek(from: string | null | undefined, to: string | null | undefined, weekStart: string, weekEnd: string): boolean {
  const f = (from ?? '').slice(0, 10);
  const t = (to ?? '').slice(0, 10);
  if (f && f > weekEnd) return false;
  if (t && t < weekStart) return false;
  return true;
}
function shortDate(iso: string): string {
  return new Date(iso + 'T00:00:00').toLocaleDateString(appLocale(), { month: 'short', day: 'numeric' });
}
function weekRangeLabel(ws: string): string {
  const start = new Date(ws + 'T00:00:00');
  const end = new Date(addDays(ws, 6) + 'T00:00:00');
  const sameMonth = start.getMonth() === end.getMonth();
  const startStr = start.toLocaleDateString(appLocale(), { month: 'short', day: 'numeric' });
  const endStr = end.toLocaleDateString(appLocale(), sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
  return `${startStr}–${endStr}`;
}

type Tone = 'empty' | 'under' | 'ok' | 'over';
function utilizationTone(hours: number): Tone {
  if (hours <= 0) return 'empty';
  if (hours <= CAPACITY_HOURS * 0.8) return 'under';
  if (hours <= CAPACITY_HOURS) return 'ok';
  return 'over';
}
const TONE_CLASS: Record<Exclude<Tone, 'empty'>, string> = {
  under: 'bg-muted text-muted-foreground',
  ok: 'bg-success/15 text-success',
  over: 'bg-destructive/15 text-destructive',
};

export function ResourcingPage() {
  const t = useT();
  const can = useCan();
  if (!can('people.read') && !can('projects.read')) {
    return (
      <div>
        <PageHeader title={t('nav.resourcing')} />
        <EmptyState title={t('resourcing.noAccess')} hint={t('resourcing.noAccessHint')} />
      </div>
    );
  }
  return <ResourcingView />;
}

function ResourcingView() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const canWrite = can('people.write');
  const [rangeStart, setRangeStart] = useState(() => isoDate(mondayOf(new Date())));
  const weekCols = Array.from({ length: WEEKS_SHOWN }, (_, i) => addDays(rangeStart, i * 7));
  const rangeEnd = addDays(weekCols[weekCols.length - 1]!, 6);
  const thisWeek = isoDate(mondayOf(new Date()));

  const allocations = useQuery({
    queryKey: ['allocations'],
    queryFn: async () => {
      try {
        return await api.get<{ data: Allocation[] }>('/allocations');
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) return { forbidden: true as const, data: [] as Allocation[] };
        throw err;
      }
    },
  });
  const users = useQuery({
    queryKey: ['users', 'resourcing'],
    queryFn: async (): Promise<{ data: UserRow[] }> => {
      try {
        return await api.get<{ data: UserRow[] }>('/users');
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) return { data: [] };
        throw err;
      }
    },
  });
  const projects = useQuery({
    queryKey: ['projects', 'resourcing'],
    queryFn: async (): Promise<{ data: ProjectRow[] }> => {
      try {
        return await api.get<{ data: ProjectRow[] }>('/projects');
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) return { data: [] };
        throw err;
      }
    },
  });
  const leaves = useQuery({
    queryKey: ['leaveRequests', 'approved'],
    queryFn: async (): Promise<{ data: LeaveRow[] }> => {
      try {
        return await api.get<{ data: LeaveRow[] }>('/leave-requests' + qs({ status: 'approved' }));
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) return { data: [] };
        throw err;
      }
    },
  });

  const [form, setForm] = useState({ userId: '', projectId: '', hoursPerWeek: '', fromDate: '', toDate: '' });
  const [showForm, setShowForm] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const addAllocation = useMutation({
    mutationFn: () =>
      api.post('/allocations', {
        userId: form.userId,
        projectId: form.projectId,
        hoursPerWeek: Number(form.hoursPerWeek),
        fromDate: form.fromDate,
        toDate: form.toDate || undefined,
      }),
    onSuccess: () => {
      setForm({ userId: '', projectId: '', hoursPerWeek: '', fromDate: '', toDate: '' });
      setShowForm(false);
      toast(t('common.saved'));
      qc.invalidateQueries({ queryKey: ['allocations'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('resourcing.addFailed')),
  });
  const deleteAllocation = useMutation({
    mutationFn: (id: string) => api.del(`/allocations/${id}`),
    onSuccess: () => { toast(t('resourcing.allocationDeleted')); qc.invalidateQueries({ queryKey: ['allocations'] }); },
    onError: () => toast.error(t('resourcing.deleteFailed')),
  });

  const userName = (userId: string): string => {
    const u = (users.data?.data ?? []).find((x) => x.id === userId);
    return u?.name ?? u?.email ?? userId.slice(0, 8);
  };
  const projectName = (projectId: string): string => {
    const p = (projects.data?.data ?? []).find((x) => x.id === projectId);
    return p?.name ?? projectId.slice(0, 8);
  };
  const isAbsent = (userId: string, weekStart: string, weekEnd: string): boolean =>
    (leaves.data?.data ?? []).some((l) => {
      const lu = l.userId ?? l.employeeUserId;
      return lu === userId && overlapsWeek(l.fromDate ?? l.startDate, l.toDate ?? l.endDate, weekStart, weekEnd);
    });

  const allocForbidden = (allocations.data as { forbidden?: boolean } | undefined)?.forbidden === true;
  const allAllocations = allocations.data?.data ?? [];
  const rangeAllocations = allAllocations.filter((a) => overlapsWeek(a.fromDate, a.toDate, rangeStart, rangeEnd));
  const userIds = [...new Set(rangeAllocations.map((a) => a.userId))].sort((a, b) => userName(a).localeCompare(userName(b)));

  const openAddFor = (userId?: string, weekStart?: string) => {
    const from = weekStart ?? rangeStart;
    // API requires both dates – default to a 4-week window ending on a Sunday.
    setForm({ userId: userId ?? '', projectId: '', hoursPerWeek: '', fromDate: from, toDate: addDays(from, 27) });
    setShowForm(true);
    setFormError(null);
  };

  const isLoading = allocations.isLoading || users.isLoading || projects.isLoading || leaves.isLoading;

  return (
    <div>
      <PageHeader
        title={t('nav.resourcing')}
        subtitle={t('resourcing.subtitle')}
        breadcrumbs={<Breadcrumbs items={[{ label: t('nav.resourcing') }]} />}
        actions={canWrite && <Button size="sm" onClick={() => openAddFor()}><Plus size={14} /> {t('resourcing.addAllocation')}</Button>}
      />
      <PageBody width="full">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <IconButton size="sm" onClick={() => setRangeStart(addDays(rangeStart, -7))} aria-label="Previous"><ChevronLeft size={15} /></IconButton>
            <span className="min-w-[9rem] text-center text-[13px] font-medium tabular-nums">{shortDate(rangeStart)} – {shortDate(rangeEnd)}</span>
            <IconButton size="sm" onClick={() => setRangeStart(addDays(rangeStart, 7))} aria-label="Next"><ChevronRight size={15} /></IconButton>
          </div>
          <button className="text-xs text-muted-foreground transition-colors hover:text-foreground" onClick={() => setRangeStart(thisWeek)}>{t('tasks.thisWeek')}</button>

          <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-muted-foreground/40" /> {t('resourcing.legendUnder')}</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-success" /> {t('resourcing.legendOk')}</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-destructive" /> {t('resourcing.legendOver')}</span>
          </div>
        </div>

        {isLoading ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : allocForbidden ? (
          <EmptyState title={t('resourcing.allocForbidden')} hint={t('resourcing.allocForbiddenHint')} />
        ) : allocations.isError ? (
          <p className="text-sm text-destructive">{t('resourcing.loadFailed')}</p>
        ) : userIds.length === 0 ? (
          <EmptyState
            icon={<Users size={20} />}
            title={t('resourcing.emptyRange')}
            hint={t('resourcing.emptyRangeHint')}
            action={canWrite ? <Button size="sm" onClick={() => openAddFor()}><Plus size={14} /> {t('resourcing.addAllocation')}</Button> : undefined}
          />
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="sticky left-0 z-10 min-w-[180px] bg-card px-4 py-2 font-medium">{t('resourcing.person')}</th>
                    {weekCols.map((ws) => (
                      <th key={ws} className={cn('min-w-[92px] px-2 py-2 text-center font-medium', ws === thisWeek && 'text-foreground')}>
                        {weekRangeLabel(ws)}
                        {ws === thisWeek && <span className="ml-1 rounded bg-primary/15 px-1 py-px text-[10px] font-medium text-primary">{t('resourcing.thisWeekShort')}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {userIds.map((userId, ri) => {
                    const user = (users.data?.data ?? []).find((u) => u.id === userId);
                    return (
                      <tr key={userId} className="group row-enter border-b border-border last:border-0" style={{ ['--i' as string]: Math.min(ri, 10) }}>
                        <td className="sticky left-0 z-10 bg-card px-4 py-2 align-middle transition-colors duration-150 group-hover:bg-muted/40">
                          <div className="flex items-center gap-2">
                            <Avatar name={user?.name ?? userId} src={user?.avatar} size={22} />
                            <span className="truncate font-medium">{userName(userId)}</span>
                          </div>
                        </td>
                        {weekCols.map((ws) => {
                          const we = addDays(ws, 6);
                          const allocs = rangeAllocations.filter((a) => a.userId === userId && overlapsWeek(a.fromDate, a.toDate, ws, we));
                          const total = allocs.reduce((a, x) => a + Number(x.hoursPerWeek), 0);
                          const absent = isAbsent(userId, ws, we);
                          const tone = utilizationTone(total);
                          return (
                            <td key={ws} className="px-2 py-2 text-center align-middle transition-colors duration-150 group-hover:bg-muted/40">
                              <LoadCell
                                total={total}
                                tone={tone}
                                absent={absent}
                                allocs={allocs}
                                canWrite={canWrite}
                                projectName={projectName}
                                onAdd={() => openAddFor(userId, ws)}
                                onDelete={(id) => deleteAllocation.mutate(id)}
                                weekLabel={weekRangeLabel(ws)}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </PageBody>

      <Dialog open={showForm} onClose={() => setShowForm(false)} title={t('resourcing.addAllocation')} width={440}>
        <form
          className="space-y-3 px-4 pb-4 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            setFormError(null);
            if (!form.userId || !form.projectId) { setFormError(t('resourcing.pickUserProject')); return; }
            if (!(Number(form.hoursPerWeek) > 0)) { setFormError(t('resourcing.hoursRequired')); return; }
            if (!form.fromDate || !form.toDate) { setFormError(t('resourcing.datesRequired')); return; }
            if (form.toDate < form.fromDate) { setFormError(t('resourcing.datesOrder')); return; }
            addAllocation.mutate();
          }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('time.groupUser')}</label>
              <Select value={form.userId} onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))} className="block w-full">
                <option value="">{t('common.select')}</option>
                {(users.data?.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name ?? u.email ?? u.id.slice(0, 8)}</option>)}
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('time.groupProject')}</label>
              <Select value={form.projectId} onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value }))} className="block w-full">
                <option value="">{t('common.select')}</option>
                {(projects.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name ?? p.id.slice(0, 8)}</option>)}
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('resourcing.hoursPerWeek')}</label>
              <Input type="number" min={1} max={80} value={form.hoursPerWeek} onChange={(e) => setForm((f) => ({ ...f, hoursPerWeek: e.target.value }))} />
            </div>
            <div />
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('resourcing.from')}</label>
              <Input type="date" value={form.fromDate} onChange={(e) => setForm((f) => ({ ...f, fromDate: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('resourcing.to')}</label>
              <Input type="date" value={form.toDate} onChange={(e) => setForm((f) => ({ ...f, toDate: e.target.value }))} />
            </div>
          </div>
          {(formError || addAllocation.isError) && (
            <p className="text-xs text-destructive">{formError ?? t('resourcing.addFailed')}</p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={addAllocation.isPending}>{t('common.add')}</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function LoadCell({ total, tone, absent, allocs, canWrite, projectName, onAdd, onDelete, weekLabel }: {
  total: number; tone: Tone; absent: boolean; allocs: Allocation[]; canWrite: boolean;
  projectName: (id: string) => string; onAdd: () => void; onDelete: (id: string) => void; weekLabel: string;
}) {
  const t = useT();

  if (tone === 'empty') {
    return canWrite ? (
      <button
        onClick={onAdd}
        title={t('resourcing.addForUser')}
        className="mx-auto grid h-6 w-10 place-items-center rounded-full border border-dashed border-border text-faint transition-colors duration-150 hover:border-primary/50 hover:text-primary"
      >
        <Plus size={11} />
      </button>
    ) : (
      <span className="text-faint">–</span>
    );
  }

  const chip = (
    <button className={cn('inline-flex h-6 min-w-[2.75rem] items-center justify-center gap-1 rounded-full px-2 text-xs font-medium tabular-nums transition-transform duration-150 hover:scale-105', TONE_CLASS[tone])}>
      {total}h
      {absent && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current opacity-60" title={t('resourcing.absent')} />}
    </button>
  );

  return (
    <DropdownMenu trigger={chip} align="start" width={200}>
      <MenuLabel>{weekLabel}{absent ? ` · ${t('resourcing.absent')}` : ''}</MenuLabel>
      {allocs.map((a) => (
        <MenuItem
          key={a.id}
          icon={canWrite ? <Trash2 size={13} className="text-faint" /> : undefined}
          disabled={!canWrite}
          onSelect={canWrite ? () => onDelete(a.id) : undefined}
        >
          <span className="flex w-full items-center justify-between gap-2">
            <span className="truncate">{projectName(a.projectId)}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{Number(a.hoursPerWeek)}h</span>
          </span>
        </MenuItem>
      ))}
      {canWrite && (
        <>
          <MenuSeparator />
          <MenuItem icon={<Plus size={13} />} onSelect={onAdd}>{t('resourcing.addForUser')}</MenuItem>
        </>
      )}
    </DropdownMenu>
  );
}
