import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useCan } from '../lib/auth';
import { Button, Input, Select, Card, Badge, PageHeader, EmptyState, Skeleton, cn } from '../components/ui';
import { ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import { useT } from '../lib/i18n';

interface Allocation {
  id: string;
  userId: string;
  projectId: string;
  hoursPerWeek: number | string;
  fromDate?: string | null;
  toDate?: string | null;
}
interface UserRow { id: string; name?: string | null; email?: string | null }
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
  const [weekStart, setWeekStart] = useState(() => isoDate(mondayOf(new Date())));
  const weekEnd = addDays(weekStart, 6);

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
    queryKey: ['users'],
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
    queryKey: ['projects'],
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
      qc.invalidateQueries({ queryKey: ['allocations'] });
    },
  });
  const deleteAllocation = useMutation({
    mutationFn: (id: string) => api.del(`/allocations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['allocations'] }),
  });

  const userName = (userId: string): string => {
    const u = (users.data?.data ?? []).find((x) => x.id === userId);
    return u?.name ?? u?.email ?? userId.slice(0, 8);
  };
  const projectName = (projectId: string): string => {
    const p = (projects.data?.data ?? []).find((x) => x.id === projectId);
    return p?.name ?? projectId.slice(0, 8);
  };
  const isAbsent = (userId: string): boolean =>
    (leaves.data?.data ?? []).some((l) => {
      const lu = l.userId ?? l.employeeUserId;
      return lu === userId && overlapsWeek(l.fromDate ?? l.startDate, l.toDate ?? l.endDate, weekStart, weekEnd);
    });

  const allocForbidden = (allocations.data as { forbidden?: boolean } | undefined)?.forbidden === true;
  const weekAllocations = (allocations.data?.data ?? []).filter((a) => overlapsWeek(a.fromDate, a.toDate, weekStart, weekEnd));
  const byUser = new Map<string, Allocation[]>();
  for (const a of weekAllocations) {
    const bucket = byUser.get(a.userId);
    if (bucket) bucket.push(a);
    else byUser.set(a.userId, [a]);
  }
  const rows = [...byUser.entries()].sort((a, b) => userName(a[0]).localeCompare(userName(b[0])));

  const isLoading = allocations.isLoading || users.isLoading || projects.isLoading || leaves.isLoading;

  return (
    <div>
      <PageHeader
        title={t('nav.resourcing')}
        subtitle={t('resourcing.subtitle')}
        actions={canWrite && <Button size="sm" onClick={() => setShowForm((s) => !s)}><Plus size={14} /> {t('resourcing.addAllocation')}</Button>}
      />
      <div className="p-6">
        <div className="mb-4 flex items-center gap-3">
          <button className="rounded border border-border p-1.5 hover:bg-muted" onClick={() => setWeekStart(addDays(weekStart, -7))}><ChevronLeft size={15} /></button>
          <span className="text-sm font-medium">{t('time.weekOf')} {weekStart}</span>
          <button className="rounded border border-border p-1.5 hover:bg-muted" onClick={() => setWeekStart(addDays(weekStart, 7))}><ChevronRight size={15} /></button>
          <button className="text-xs text-muted-foreground hover:underline" onClick={() => setWeekStart(isoDate(mondayOf(new Date())))}>{t('tasks.thisWeek')}</button>
        </div>

        {canWrite && showForm && (
          <Card className="mb-4 max-w-3xl p-4">
            <div className="mb-3 text-sm font-medium">{t('resourcing.addAllocation')}</div>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (form.userId && form.projectId && Number(form.hoursPerWeek) > 0 && form.fromDate) addAllocation.mutate();
              }}
            >
              <label className="text-xs text-muted-foreground">
                {t('time.groupUser')}
                <Select value={form.userId} onChange={(e) => setForm((f) => ({ ...f, userId: e.target.value }))} className="mt-1 block min-w-36">
                  <option value="">{t('common.select')}</option>
                  {(users.data?.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.name ?? u.email ?? u.id.slice(0, 8)}</option>)}
                </Select>
              </label>
              <label className="text-xs text-muted-foreground">
                {t('time.groupProject')}
                <Select value={form.projectId} onChange={(e) => setForm((f) => ({ ...f, projectId: e.target.value }))} className="mt-1 block min-w-36">
                  <option value="">{t('common.select')}</option>
                  {(projects.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name ?? p.id.slice(0, 8)}</option>)}
                </Select>
              </label>
              <label className="text-xs text-muted-foreground">
                {t('resourcing.hoursPerWeek')}
                <Input type="number" min={1} max={80} value={form.hoursPerWeek} onChange={(e) => setForm((f) => ({ ...f, hoursPerWeek: e.target.value }))} className="mt-1 w-20" />
              </label>
              <label className="text-xs text-muted-foreground">
                {t('resourcing.from')}
                <Input type="date" value={form.fromDate} onChange={(e) => setForm((f) => ({ ...f, fromDate: e.target.value }))} className="mt-1" />
              </label>
              <label className="text-xs text-muted-foreground">
                {t('resourcing.to')}
                <Input type="date" value={form.toDate} onChange={(e) => setForm((f) => ({ ...f, toDate: e.target.value }))} className="mt-1" />
              </label>
              <Button type="submit" disabled={addAllocation.isPending}>{t('common.add')}</Button>
            </form>
            {addAllocation.isError && <p className="mt-2 text-xs text-destructive">{t('resourcing.addFailed')}</p>}
          </Card>
        )}

        {isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : allocForbidden ? (
          <EmptyState title={t('resourcing.allocForbidden')} hint={t('resourcing.allocForbiddenHint')} />
        ) : allocations.isError ? (
          <p className="text-sm text-destructive">{t('resourcing.loadFailed')}</p>
        ) : rows.length === 0 ? (
          <EmptyState
            title={t('resourcing.emptyWeek')}
            hint={t('resourcing.emptyWeekHint')}
            action={canWrite ? <Button size="sm" onClick={() => setShowForm(true)}><Plus size={14} /> {t('resourcing.addAllocation')}</Button> : undefined}
          />
        ) : (
          <Card>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">{t('resourcing.person')}</th>
                  <th className="px-4 py-2 font-medium">{t('resourcing.allocations')}</th>
                  <th className="px-4 py-2 text-right font-medium">{t('resourcing.totalPerWeek')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(([userId, allocs]) => {
                  const total = allocs.reduce((a, x) => a + Number(x.hoursPerWeek), 0);
                  return (
                    <tr key={userId} className="border-b border-border last:border-0">
                      <td className="px-4 py-2 align-top">
                        <span className="font-medium">{userName(userId)}</span>
                        {isAbsent(userId) && <Badge className="ml-2 bg-muted text-muted-foreground">{t('resourcing.absent')}</Badge>}
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex flex-wrap gap-1.5">
                          {allocs.map((a) => (
                            <span key={a.id} className="inline-flex items-center gap-1 rounded border border-border bg-muted/50 px-1.5 py-0.5 text-xs">
                              <span className="max-w-40 truncate">{projectName(a.projectId)}</span>
                              <span className="tabular-nums text-muted-foreground">{Number(a.hoursPerWeek)}h/wk</span>
                              {canWrite && (
                                <button
                                  className="ml-0.5 text-muted-foreground hover:text-destructive"
                                  title={t('resourcing.deleteAllocation')}
                                  onClick={() => deleteAllocation.mutate(a.id)}
                                >
                                  <Trash2 size={11} />
                                </button>
                              )}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className={cn('px-4 py-2 text-right align-top font-medium tabular-nums', total > 40 && 'text-destructive')}>
                        {total}h
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        )}
        {deleteAllocation.isError && <p className="mt-2 text-xs text-destructive">{t('resourcing.deleteFailed')}</p>}
      </div>
    </div>
  );
}
