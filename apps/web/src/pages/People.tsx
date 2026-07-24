import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { useCan } from '../lib/auth';
import { Button, Input, Select, Textarea, Card, Badge, PageHeader, EmptyState, Skeleton, fmtMoney, fmtDate, cn } from '../components/ui';
import { Plus, X, Check, Ban, UserPlus } from 'lucide-react';
import { useT } from '../lib/i18n';

const EMP_STATUS: Record<string, string> = { active: '#22c55e', on_leave: '#f59e0b', terminated: '#6b7280' };
const LEAVE_STATUS: Record<string, string> = { pending: '#f59e0b', approved: '#22c55e', rejected: '#ef4444', canceled: '#6b7280' };

interface Employee { id: string; firstName?: string | null; lastName?: string | null; name?: string | null; position?: string | null; positionTitle?: string | null; department?: string | null; departmentName?: string | null; status?: string | null }
interface Compensation { id?: string; compType?: string; amount?: number | string; currency?: string; effectiveFrom?: string | null; effectiveTo?: string | null }
interface LeaveRequest { id: string; employeeName?: string | null; leaveTypeName?: string | null; fromDate?: string | null; toDate?: string | null; status?: string | null; reason?: string | null }
interface LeaveType { id: string; name: string }
interface JobOpening { id: string; title: string; status?: string | null; department?: string | null; positionsCount?: number | string }
interface Applicant { id: string; name?: string | null; email?: string | null; stage?: string | null; stageId?: string | null }
interface ApplicantStage { id: string; name: string; position?: number; isHired?: boolean; isRejected?: boolean }

// Returns '' when the employee has no name; callers fall back to t('people.unnamed').
function empName(e: Employee): string {
  return (e.name ?? [e.firstName, e.lastName].filter(Boolean).join(' ')) || '';
}

type Tab = 'employees' | 'leave' | 'recruiting' | 'dashboard';

export function PeoplePage() {
  const t = useT();
  const can = useCan();
  const [tab, setTab] = useState<Tab>('employees');

  if (!can('people.read')) {
    return <EmptyState title={t('resourcing.noAccess')} hint={t('people.noAccessHint')} />;
  }

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: 'employees', label: t('people.employees'), show: true },
    { id: 'leave', label: t('people.leave'), show: true },
    { id: 'recruiting', label: t('people.recruiting'), show: can('people.recruit') },
    { id: 'dashboard', label: t('nav.dashboard'), show: true },
  ];

  return (
    <div>
      <PageHeader
        title={t('nav.people')}
        actions={
          <div className="flex rounded-md border border-border p-0.5 text-sm">
            {tabs.filter((tb) => tb.show).map((tb) => (
              <button key={tb.id} className={cn('rounded px-3 py-1', tab === tb.id && 'bg-muted font-medium')} onClick={() => setTab(tb.id)}>{tb.label}</button>
            ))}
          </div>
        }
      />
      {tab === 'employees' && <EmployeesView />}
      {tab === 'leave' && <LeaveView />}
      {tab === 'recruiting' && can('people.recruit') && <RecruitingView />}
      {tab === 'dashboard' && <PeopleDashboardView />}
    </div>
  );
}

function EmployeesView() {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const canWrite = can('people.write');
  const [selected, setSelected] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ firstName: '', lastName: '', position: '', department: '' });
  const employees = useQuery({ queryKey: ['employees'], queryFn: () => api.get<{ data: Employee[] }>('/employees') });
  const create = useMutation({
    mutationFn: () => api.post('/employees', { firstName: form.firstName, lastName: form.lastName, position: form.position, department: form.department }),
    onSuccess: () => {
      setForm({ firstName: '', lastName: '', position: '', department: '' });
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ['employees'] });
    },
  });
  const rows = employees.data?.data ?? [];

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-end">
        {canWrite && <Button size="sm" onClick={() => setShowForm((v) => !v)}><Plus size={14} /> {t('people.newEmployee')}</Button>}
      </div>
      {showForm && canWrite && (
        <Card className="mb-4 p-4">
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (form.firstName) create.mutate(); }}>
            <label className="text-xs text-muted-foreground">{t('crm.firstName')}<Input value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} className="mt-1 w-40" /></label>
            <label className="text-xs text-muted-foreground">{t('crm.lastName')}<Input value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} className="mt-1 w-40" /></label>
            <label className="text-xs text-muted-foreground">{t('people.position')}<Input value={form.position} onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))} className="mt-1 w-40" /></label>
            <label className="text-xs text-muted-foreground">{t('people.department')}<Input value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} className="mt-1 w-40" /></label>
            <Button type="submit" size="sm" disabled={create.isPending}>{t('common.create')}</Button>
          </form>
        </Card>
      )}

      {employees.isLoading ? (
        <Card className="p-4"><Skeleton className="h-40 w-full" /></Card>
      ) : rows.length === 0 ? (
        <EmptyState title={t('people.noEmployees')} hint={t('people.noEmployeesHint')} />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">{t('common.name')}</th>
                <th className="px-4 py-2 font-medium">{t('people.position')}</th>
                <th className="px-4 py-2 font-medium">{t('people.department')}</th>
                <th className="px-4 py-2 font-medium">{t('common.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/60" onClick={() => setSelected(e.id)}>
                  <td className="px-4 py-2 font-medium">{empName(e) || t('people.unnamed')}</td>
                  <td className="px-4 py-2 text-muted-foreground">{e.positionTitle ?? e.position ?? '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground">{e.departmentName ?? e.department ?? '—'}</td>
                  <td className="px-4 py-2"><Badge color={EMP_STATUS[e.status ?? 'active'] ?? '#6b7280'}>{e.status ?? 'active'}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {selected && <EmployeeDrawer id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function EmployeeDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const employee = useQuery({ queryKey: ['employee', id], queryFn: () => api.get<Employee>(`/employees/${id}`) });
  const compensation = useQuery({
    queryKey: ['compensation', id],
    queryFn: () => api.get<{ data: Compensation[] } | Compensation[]>(`/employees/${id}/compensation`),
    enabled: can('people.read_compensation'),
  });
  const lifecycle = useMutation({
    mutationFn: (action: 'onboard' | 'exit') => api.post(`/employees/${id}/lifecycle`, { action }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employee', id] });
      qc.invalidateQueries({ queryKey: ['employees'] });
    },
  });

  const comp = compensation.data ? (Array.isArray(compensation.data) ? compensation.data : compensation.data.data) : [];

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <div className="h-full w-full max-w-md overflow-auto border-l border-border bg-card p-6" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{employee.data ? (empName(employee.data) || t('people.unnamed')) : t('people.employee')}</h2>
          <button className="rounded p-1 hover:bg-muted" onClick={onClose}><X size={16} /></button>
        </div>
        {employee.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : employee.data ? (
          <div className="space-y-4 text-sm">
            <div>
              <div className="text-muted-foreground">{employee.data.positionTitle ?? employee.data.position ?? '—'} · {employee.data.departmentName ?? employee.data.department ?? '—'}</div>
              <div className="mt-1"><Badge color={EMP_STATUS[employee.data.status ?? 'active'] ?? '#6b7280'}>{employee.data.status ?? 'active'}</Badge></div>
            </div>
            {can('people.write') && (
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => lifecycle.mutate('onboard')} disabled={lifecycle.isPending}><Check size={14} /> {t('people.onboard')}</Button>
                <Button size="sm" variant="destructive" onClick={() => lifecycle.mutate('exit')} disabled={lifecycle.isPending}><Ban size={14} /> {t('people.exit')}</Button>
              </div>
            )}
            {can('people.read_compensation') && (
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('people.compensation')}</div>
                {compensation.isLoading ? (
                  <Skeleton className="h-12 w-full" />
                ) : comp.length === 0 ? (
                  <p className="text-muted-foreground">{t('people.noCompensation')}</p>
                ) : (
                  <div className="space-y-1">
                    {comp.map((c, i) => (
                      <div key={c.id ?? String(i)} className="flex items-center justify-between rounded bg-muted/50 px-3 py-1.5">
                        <span className="text-muted-foreground">{c.compType ?? 'salary'} · {t('resourcing.from').toLowerCase()} {fmtDate(c.effectiveFrom)}</span>
                        <span className="font-medium tabular-nums">{fmtMoney(c.amount ?? 0, c.currency ?? 'USD')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t('people.employeeNotFound')}</p>
        )}
      </div>
    </div>
  );
}

function LeaveView() {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const canApprove = can('people.approve_leave');
  const requests = useQuery({ queryKey: ['leaveRequests'], queryFn: () => api.get<{ data: LeaveRequest[] }>('/leave-requests') });
  const types = useQuery({ queryKey: ['leaveTypes'], queryFn: () => api.get<{ data: LeaveType[] }>('/leave-types') });
  const [form, setForm] = useState({ leaveTypeId: '', fromDate: '', toDate: '', reason: '' });
  const create = useMutation({
    mutationFn: () => api.post('/leave-requests', { leaveTypeId: form.leaveTypeId, fromDate: form.fromDate, toDate: form.toDate, reason: form.reason }),
    onSuccess: () => {
      setForm({ leaveTypeId: '', fromDate: '', toDate: '', reason: '' });
      qc.invalidateQueries({ queryKey: ['leaveRequests'] });
    },
  });
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' }) => api.post(`/leave-requests/${id}/${action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['leaveRequests'] }),
  });
  const rows = requests.data?.data ?? [];
  const typeList = types.data?.data ?? [];

  return (
    <div className="grid gap-6 p-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        {requests.isLoading ? (
          <Card className="p-4"><Skeleton className="h-40 w-full" /></Card>
        ) : rows.length === 0 ? (
          <EmptyState title={t('people.noLeaveRequests')} hint={t('people.noLeaveRequestsHint')} />
        ) : (
          <Card className="overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2 font-medium">{t('people.employee')}</th>
                  <th className="px-4 py-2 font-medium">{t('dashboards.type')}</th>
                  <th className="px-4 py-2 font-medium">{t('people.dates')}</th>
                  <th className="px-4 py-2 font-medium">{t('common.status')}</th>
                  {canApprove && <th className="px-4 py-2" />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 font-medium">{r.employeeName ?? '—'}</td>
                    <td className="px-4 py-2 text-muted-foreground">{r.leaveTypeName ?? '—'}</td>
                    <td className="px-4 py-2">{fmtDate(r.fromDate)} → {fmtDate(r.toDate)}</td>
                    <td className="px-4 py-2"><Badge color={LEAVE_STATUS[r.status ?? 'pending'] ?? '#6b7280'}>{r.status ?? 'pending'}</Badge></td>
                    {canApprove && (
                      <td className="px-4 py-2 text-right">
                        {r.status === 'pending' && (
                          <span className="inline-flex gap-1">
                            <button className="rounded p-1 text-green-600 hover:bg-muted" title={t('people.approve')} onClick={() => decide.mutate({ id: r.id, action: 'approve' })}><Check size={15} /></button>
                            <button className="rounded p-1 text-destructive hover:bg-muted" title={t('people.reject')} onClick={() => decide.mutate({ id: r.id, action: 'reject' })}><X size={15} /></button>
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>

      <Card className="h-fit p-4">
        <div className="mb-3 text-sm font-medium">{t('people.requestLeave')}</div>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (form.leaveTypeId && form.fromDate) create.mutate(); }}>
          <label className="block text-xs text-muted-foreground">{t('dashboards.type')}
            <Select value={form.leaveTypeId} onChange={(e) => setForm((f) => ({ ...f, leaveTypeId: e.target.value }))} className="mt-1 block w-full">
              <option value="">{t('common.select')}</option>
              {typeList.map((lt) => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
            </Select>
          </label>
          <label className="block text-xs text-muted-foreground">{t('resourcing.from')}<Input type="date" value={form.fromDate} onChange={(e) => setForm((f) => ({ ...f, fromDate: e.target.value }))} className="mt-1" /></label>
          <label className="block text-xs text-muted-foreground">{t('resourcing.to')}<Input type="date" value={form.toDate} onChange={(e) => setForm((f) => ({ ...f, toDate: e.target.value }))} className="mt-1" /></label>
          <label className="block text-xs text-muted-foreground">{t('people.reason')}<Textarea value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} rows={2} className="mt-1" /></label>
          <Button type="submit" size="sm" disabled={create.isPending}>{t('people.submitRequest')}</Button>
        </form>
      </Card>
    </div>
  );
}

function RecruitingView() {
  const t = useT();
  const qc = useQueryClient();
  const openings = useQuery({ queryKey: ['jobOpenings'], queryFn: () => api.get<{ data: JobOpening[] }>('/job-openings') });
  const stages = useQuery({ queryKey: ['applicantStages'], queryFn: () => api.get<{ data: ApplicantStage[] }>('/applicant-stages') });
  const [openingId, setOpeningId] = useState<string>('');
  const list = openings.data?.data ?? [];
  const activeOpening = openingId || list[0]?.id || '';
  const applicants = useQuery({
    queryKey: ['applicants', activeOpening],
    queryFn: () => api.get<{ data: Applicant[] }>('/applicants' + qs({ jobOpeningId: activeOpening })),
    enabled: !!activeOpening,
  });
  const move = useMutation({
    mutationFn: ({ id, stageId }: { id: string; stageId: string }) => api.post(`/applicants/${id}/move`, { stageId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['applicants'] }),
  });
  const hire = useMutation({
    mutationFn: (id: string) => api.post(`/applicants/${id}/hire`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['applicants'] });
      qc.invalidateQueries({ queryKey: ['employees'] });
    },
  });

  const stageList = (stages.data?.data ?? []).slice().sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
  const appRows = applicants.data?.data ?? [];
  const stageOf = (a: Applicant): string => a.stageId ?? a.stage ?? '';

  if (openings.isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;
  if (list.length === 0) return <EmptyState title={t('people.noOpenings')} hint={t('people.noOpeningsHint')} />;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <span className="text-sm text-muted-foreground">{t('people.opening')}</span>
        <Select value={activeOpening} onChange={(e) => setOpeningId(e.target.value)}>
          {list.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
        </Select>
      </div>
      {applicants.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {stageList.map((st) => {
            const cards = appRows.filter((a) => stageOf(a) === st.id || stageOf(a) === st.name);
            return (
              <div key={st.id} className="w-64 shrink-0">
                <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium">
                  <span>{st.name}</span>
                  <span className="text-muted-foreground">{cards.length}</span>
                </div>
                <div className="space-y-2">
                  {cards.map((a) => (
                    <Card key={a.id} className="p-2.5 text-sm">
                      <div className="font-medium">{a.name ?? t('people.applicant')}</div>
                      {a.email && <div className="truncate text-xs text-muted-foreground">{a.email}</div>}
                      <div className="mt-2 flex items-center gap-1">
                        <Select
                          value=""
                          onChange={(e) => { if (e.target.value) move.mutate({ id: a.id, stageId: e.target.value }); }}
                          className="h-7 flex-1 text-xs"
                        >
                          <option value="">{t('people.move')}</option>
                          {stageList.filter((s) => s.id !== st.id).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </Select>
                        {st.isHired ? null : (
                          <button className="rounded p-1 text-green-600 hover:bg-muted" title={t('people.hire')} onClick={() => hire.mutate(a.id)}><UserPlus size={14} /></button>
                        )}
                      </div>
                    </Card>
                  ))}
                  {cards.length === 0 && <div className="rounded border border-dashed border-border py-4 text-center text-xs text-muted-foreground">{t('people.empty')}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PeopleDashboardView() {
  const t = useT();
  const dash = useQuery({ queryKey: ['peopleDashboard'], queryFn: () => api.get<any>('/people/dashboard') });
  const d = dash.data;
  if (dash.isLoading) return <div className="p-6"><Skeleton className="h-40 w-full" /></div>;
  const tiles: { label: string; value: string }[] = [
    { label: t('people.headcount'), value: String(d?.headcount ?? d?.activeCount ?? 0) },
    { label: t('people.onLeave'), value: String(d?.onLeave ?? 0) },
    { label: t('people.newHires'), value: String(d?.newHires ?? 0) },
    { label: t('people.openPositions'), value: String(d?.openPositions ?? d?.openOpenings ?? 0) },
    { label: t('people.inPipeline'), value: String(d?.pipelineCount ?? d?.applicants ?? 0) },
    { label: t('people.upcomingLeave'), value: String(d?.upcomingLeave ?? 0) },
  ];
  return (
    <div className="grid grid-cols-2 gap-4 p-6 md:grid-cols-3">
      {tiles.map((tile) => (
        <Card key={tile.label} className="p-4">
          <div className="text-xs text-muted-foreground">{tile.label}</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{tile.value}</div>
        </Card>
      ))}
    </div>
  );
}
