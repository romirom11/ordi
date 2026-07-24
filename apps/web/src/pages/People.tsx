import { useMemo, useState, type ReactNode, type CSSProperties } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useCan } from '../lib/auth';
import {
  Button, Input, Select, Textarea, Card, Badge, PageHeader, EmptyState, Skeleton, Spinner,
  Avatar, SegmentedControl, fmtMoney, fmtDate, cn,
} from '../components/ui';
import { Dialog, DropdownMenu, MenuItem, toast } from '../components/overlays';
import {
  Plus, Check, X, UserPlus, Users, CalendarClock, Briefcase, MoreHorizontal,
  ChevronRight, LayoutGrid, UserCheck, UserX, Sparkles,
} from 'lucide-react';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'people.statusActive': 'Active',
    'people.statusOnLeave': 'On leave',
    'people.statusTerminated': 'Terminated',
    'people.leavePending': 'Pending',
    'people.leaveApproved': 'Approved',
    'people.leaveRejected': 'Rejected',
    'people.leaveCanceled': 'Canceled',
    'people.actions': 'Actions',
    'people.createFailed': 'Could not create the employee',
    'people.lifecycleFailed': 'Could not update the employee',
    'people.onboarded': 'Employee onboarded',
    'people.exited': 'Employee exited',
    'people.leaveCreateFailed': 'Could not submit the request',
    'people.leaveDecideFailed': 'Could not update the request',
    'people.leaveApprovedToast': 'Request approved',
    'people.leaveRejectedToast': 'Request rejected',
    'people.leaveSubmitted': 'Request submitted',
    'people.moveFailed': 'Could not move the applicant',
    'people.hireFailed': 'Could not hire the applicant',
    'people.hired': 'Applicant hired',
    'people.moved': 'Applicant moved',
    'people.moveTo': 'Move to…',
    'people.searchPlaceholder': 'Filter by name or role…',
  },
  uk: {
    'people.statusActive': 'Активний',
    'people.statusOnLeave': 'У відпустці',
    'people.statusTerminated': 'Звільнений',
    'people.leavePending': 'Очікує',
    'people.leaveApproved': 'Погоджено',
    'people.leaveRejected': 'Відхилено',
    'people.leaveCanceled': 'Скасовано',
    'people.actions': 'Дії',
    'people.createFailed': 'Не вдалося створити співробітника',
    'people.lifecycleFailed': 'Не вдалося оновити співробітника',
    'people.onboarded': 'Співробітника найнято',
    'people.exited': 'Співробітника звільнено',
    'people.leaveCreateFailed': 'Не вдалося надіслати заявку',
    'people.leaveDecideFailed': 'Не вдалося оновити заявку',
    'people.leaveApprovedToast': 'Заявку погоджено',
    'people.leaveRejectedToast': 'Заявку відхилено',
    'people.leaveSubmitted': 'Заявку надіслано',
    'people.moveFailed': 'Не вдалося перемістити кандидата',
    'people.hireFailed': 'Не вдалося найняти кандидата',
    'people.hired': 'Кандидата найнято',
    'people.moved': 'Кандидата переміщено',
    'people.moveTo': 'Перемістити до…',
    'people.searchPlaceholder': 'Фільтр за іменем або посадою…',
  },
});

const EMP_STATUS_META: Record<string, { color: string; key: string }> = {
  active: { color: '#22c55e', key: 'people.statusActive' },
  on_leave: { color: '#f59e0b', key: 'people.statusOnLeave' },
  terminated: { color: '#6b7280', key: 'people.statusTerminated' },
};
const LEAVE_STATUS_META: Record<string, { color: string; key: string }> = {
  pending: { color: '#f59e0b', key: 'people.leavePending' },
  approved: { color: '#22c55e', key: 'people.leaveApproved' },
  rejected: { color: '#ef4444', key: 'people.leaveRejected' },
  canceled: { color: '#6b7280', key: 'people.leaveCanceled' },
};
const DEPT_COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ec4899', '#06b6d4', '#a855f7', '#84cc16', '#f43f5e'];
function deptColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return DEPT_COLORS[Math.abs(h) % DEPT_COLORS.length]!;
}

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

function StatusPill({ status, meta }: { status: string; meta: Record<string, { color: string; key: string }> }) {
  const t = useT();
  const m = meta[status] ?? { color: '#8a8f98', key: '' };
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium">
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: m.color }} />
      <span className="text-muted-foreground">{m.key ? t(m.key) : status}</span>
    </span>
  );
}

type Tab = 'employees' | 'leave' | 'recruiting' | 'dashboard';

export function PeoplePage() {
  const t = useT();
  const can = useCan();
  const [tab, setTab] = useState<Tab>('employees');

  if (!can('people.read')) {
    return <EmptyState icon={<Users size={20} />} title={t('resourcing.noAccess')} hint={t('people.noAccessHint')} />;
  }

  const tabs: { key: Tab; label: string; icon: ReactNode; show: boolean }[] = [
    { key: 'employees', label: t('people.employees'), icon: <Users size={13} />, show: true },
    { key: 'leave', label: t('people.leave'), icon: <CalendarClock size={13} />, show: true },
    { key: 'recruiting', label: t('people.recruiting'), icon: <Briefcase size={13} />, show: can('people.recruit') },
    { key: 'dashboard', label: t('nav.dashboard'), icon: <LayoutGrid size={13} />, show: true },
  ];

  return (
    <div>
      <PageHeader
        title={t('nav.people')}
        actions={<SegmentedControl options={tabs.filter((tb) => tb.show)} value={tab} onChange={(v) => setTab(v as Tab)} />}
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
  const [filter, setFilter] = useState<string>('all');
  const [form, setForm] = useState({ firstName: '', lastName: '', position: '', department: '' });
  const employees = useQuery({ queryKey: ['employees'], queryFn: () => api.get<{ data: Employee[] }>('/employees') });
  const create = useMutation({
    mutationFn: () => api.post('/employees', { firstName: form.firstName, lastName: form.lastName, position: form.position, department: form.department }),
    onSuccess: () => {
      setForm({ firstName: '', lastName: '', position: '', department: '' });
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ['employees'] });
    },
    onError: () => toast.error(t('people.createFailed')),
  });
  const rows = employees.data?.data ?? [];

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rows.length };
    for (const e of rows) { const s = e.status ?? 'active'; c[s] = (c[s] ?? 0) + 1; }
    return c;
  }, [rows]);
  const shown = filter === 'all' ? rows : rows.filter((e) => (e.status ?? 'active') === filter);

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        {rows.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {(['all', ...Object.keys(EMP_STATUS_META)] as const).map((f) => {
              const n = counts[f] ?? 0;
              if (f !== 'all' && n === 0) return null;
              const active = filter === f;
              const meta = EMP_STATUS_META[f];
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors duration-150',
                    active ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {meta && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: meta.color }} />}
                  {f === 'all' ? t('common.all') : t(meta!.key)}
                  <span className="tabular-nums text-faint">{n}</span>
                </button>
              );
            })}
          </div>
        ) : <div />}
        {canWrite && <Button size="sm" onClick={() => setShowForm((v) => !v)}><Plus size={14} /> {t('people.newEmployee')}</Button>}
      </div>

      <Dialog open={showForm && canWrite} onClose={() => setShowForm(false)} title={t('people.newEmployee')} width={440}>
        <form
          className="space-y-3 px-4 pb-4 pt-1"
          onSubmit={(e) => { e.preventDefault(); if (form.firstName) create.mutate(); }}
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('crm.firstName')}</label>
              <Input autoFocus value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('crm.lastName')}</label>
              <Input value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('people.position')}</label>
              <Input value={form.position} onChange={(e) => setForm((f) => ({ ...f, position: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('people.department')}</label>
              <Input value={form.department} onChange={(e) => setForm((f) => ({ ...f, department: e.target.value }))} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowForm(false)}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={create.isPending || !form.firstName}>{create.isPending ? <Spinner /> : t('common.create')}</Button>
          </div>
        </form>
      </Dialog>

      {employees.isLoading ? (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={cn('flex items-center gap-3 px-4 py-2.5', i > 0 && 'border-t border-border')}>
              <Skeleton className="h-7 w-7 rounded-full" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<Users size={20} />} title={t('people.noEmployees')} hint={t('people.noEmployeesHint')} />
      ) : shown.length === 0 ? (
        <EmptyState icon={<Users size={20} />} title={t('crm.noMatch')} hint={t('crm.noMatchHint')} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {shown.map((e, i) => {
            const name = empName(e) || t('people.unnamed');
            const dept = e.departmentName ?? e.department;
            return (
              <button
                key={e.id}
                onClick={() => setSelected(e.id)}
                style={{ ['--i' as string]: Math.min(i, 10) }}
                className={cn(
                  'row-enter flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-muted/60',
                  i > 0 && 'border-t border-border',
                )}
              >
                <Avatar name={name} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-foreground">{name}</div>
                  <div className="truncate text-xs text-faint">{e.positionTitle ?? e.position ?? '—'}</div>
                </div>
                {dept && <Badge color={deptColor(dept)} className="hidden shrink-0 sm:inline-flex">{dept}</Badge>}
                <StatusPill status={e.status ?? 'active'} meta={EMP_STATUS_META} />
              </button>
            );
          })}
        </div>
      )}

      {selected && <EmployeeDialog id={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function EmployeeDialog({ id, onClose }: { id: string; onClose: () => void }) {
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
    onSuccess: (_r, action) => {
      qc.invalidateQueries({ queryKey: ['employee', id] });
      qc.invalidateQueries({ queryKey: ['employees'] });
      toast(action === 'onboard' ? t('people.onboarded') : t('people.exited'));
    },
    onError: () => toast.error(t('people.lifecycleFailed')),
  });

  const comp = compensation.data ? (Array.isArray(compensation.data) ? compensation.data : compensation.data.data) : [];
  const name = employee.data ? (empName(employee.data) || t('people.unnamed')) : t('people.employee');

  return (
    <Dialog open onClose={onClose} width={440} title={
      <span className="flex items-center gap-2">
        <Avatar name={name} size={22} />
        <span className="truncate">{name}</span>
      </span>
    }>
      <div className="px-4 pb-4 pt-1 text-[13px]">
        {employee.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : employee.data ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 text-muted-foreground">
                <div className="truncate">{employee.data.positionTitle ?? employee.data.position ?? '—'}</div>
                <div className="truncate text-xs text-faint">{employee.data.departmentName ?? employee.data.department ?? '—'}</div>
              </div>
              <StatusPill status={employee.data.status ?? 'active'} meta={EMP_STATUS_META} />
            </div>

            {can('people.write') && (
              <DropdownMenu
                trigger={<Button size="sm" variant="outline">{t('people.actions')} <MoreHorizontal size={14} /></Button>}
              >
                <MenuItem icon={<UserCheck size={13} />} onSelect={() => lifecycle.mutate('onboard')} disabled={lifecycle.isPending}>{t('people.onboard')}</MenuItem>
                <MenuItem icon={<UserX size={13} />} danger onSelect={() => lifecycle.mutate('exit')} disabled={lifecycle.isPending}>{t('people.exit')}</MenuItem>
              </DropdownMenu>
            )}

            {can('people.read_compensation') && (
              <div>
                <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">{t('people.compensation')}</div>
                {compensation.isLoading ? (
                  <Skeleton className="h-12 w-full" />
                ) : comp.length === 0 ? (
                  <p className="text-muted-foreground">{t('people.noCompensation')}</p>
                ) : (
                  <div className="space-y-1">
                    {comp.map((c, i) => (
                      <div key={c.id ?? String(i)} className="flex items-center justify-between rounded-md bg-muted/50 px-3 py-1.5">
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
          <p className="text-muted-foreground">{t('people.employeeNotFound')}</p>
        )}
      </div>
    </Dialog>
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
      toast(t('people.leaveSubmitted'));
    },
    onError: () => toast.error(t('people.leaveCreateFailed')),
  });
  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' }) => api.post(`/leave-requests/${id}/${action}`),
    onSuccess: (_r, vars) => {
      qc.invalidateQueries({ queryKey: ['leaveRequests'] });
      toast(vars.action === 'approve' ? t('people.leaveApprovedToast') : t('people.leaveRejectedToast'));
    },
    onError: () => toast.error(t('people.leaveDecideFailed')),
  });
  const rows = requests.data?.data ?? [];
  const typeList = types.data?.data ?? [];

  return (
    <div className="grid gap-6 p-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        {requests.isLoading ? (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {[0, 1, 2].map((i) => (
              <div key={i} className={cn('flex items-center gap-3 px-4 py-2.5', i > 0 && 'border-t border-border')}>
                <Skeleton className="h-4 w-32" /><Skeleton className="ml-auto h-4 w-24" />
              </div>
            ))}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState icon={<CalendarClock size={20} />} title={t('people.noLeaveRequests')} hint={t('people.noLeaveRequestsHint')} />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            {rows.map((r, i) => (
              <div
                key={r.id}
                style={{ ['--i' as string]: Math.min(i, 10) }}
                className={cn('row-enter group flex items-center gap-3 px-4 py-2.5 text-[13px]', i > 0 && 'border-t border-border')}
              >
                <Avatar name={r.employeeName} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-foreground">{r.employeeName ?? '—'}</div>
                  <div className="truncate text-xs text-faint">{r.leaveTypeName ?? '—'}</div>
                </div>
                <div className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:flex">
                  <span className="tabular-nums">{fmtDate(r.fromDate)}</span>
                  <ChevronRight size={11} className="text-faint" />
                  <span className="tabular-nums">{fmtDate(r.toDate)}</span>
                </div>
                <StatusPill status={r.status ?? 'pending'} meta={LEAVE_STATUS_META} />
                {canApprove && r.status === 'pending' && (
                  <span className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                    <button
                      className="rounded-md p-1.5 text-success transition-colors hover:bg-success/10"
                      title={t('people.approve')}
                      onClick={() => decide.mutate({ id: r.id, action: 'approve' })}
                      disabled={decide.isPending}
                    ><Check size={14} /></button>
                    <button
                      className="rounded-md p-1.5 text-destructive transition-colors hover:bg-destructive/10"
                      title={t('people.reject')}
                      onClick={() => decide.mutate({ id: r.id, action: 'reject' })}
                      disabled={decide.isPending}
                    ><X size={14} /></button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <Card className="h-fit p-4">
        <div className="mb-3 text-[13px] font-medium">{t('people.requestLeave')}</div>
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (form.leaveTypeId && form.fromDate) create.mutate(); }}>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('dashboards.type')}</label>
            <Select value={form.leaveTypeId} onChange={(e) => setForm((f) => ({ ...f, leaveTypeId: e.target.value }))} className="w-full">
              <option value="">{t('common.select')}</option>
              {typeList.map((lt) => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('resourcing.from')}</label>
              <Input type="date" value={form.fromDate} onChange={(e) => setForm((f) => ({ ...f, fromDate: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('resourcing.to')}</label>
              <Input type="date" value={form.toDate} onChange={(e) => setForm((f) => ({ ...f, toDate: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('people.reason')}</label>
            <Textarea value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} rows={2} />
          </div>
          <Button type="submit" size="sm" className="w-full" disabled={create.isPending || !form.leaveTypeId || !form.fromDate}>
            {create.isPending ? <Spinner /> : t('people.submitRequest')}
          </Button>
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['applicants'] });
      toast(t('people.moved'));
    },
    onError: () => toast.error(t('people.moveFailed')),
  });
  const hire = useMutation({
    mutationFn: (id: string) => api.post(`/applicants/${id}/hire`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['applicants'] });
      qc.invalidateQueries({ queryKey: ['employees'] });
      toast(t('people.hired'));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('people.hireFailed')),
  });

  const stageList = (stages.data?.data ?? []).slice().sort((a, b) => Number(a.position ?? 0) - Number(b.position ?? 0));
  const appRows = applicants.data?.data ?? [];
  const stageOf = (a: Applicant): string => a.stageId ?? a.stage ?? '';

  if (openings.isLoading) {
    return (
      <div className="flex gap-3 p-6">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-64 w-64" />)}
      </div>
    );
  }
  if (list.length === 0) return <EmptyState icon={<Briefcase size={20} />} title={t('people.noOpenings')} hint={t('people.noOpeningsHint')} />;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <span className="text-[13px] text-muted-foreground">{t('people.opening')}</span>
        <Select value={activeOpening} onChange={(e) => setOpeningId(e.target.value)}>
          {list.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
        </Select>
      </div>
      {applicants.isLoading ? (
        <div className="flex gap-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-64 w-64" />)}</div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {stageList.map((st) => {
            const cards = appRows.filter((a) => stageOf(a) === st.id || stageOf(a) === st.name);
            return (
              <div key={st.id} className="w-64 shrink-0">
                <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
                  <span className="truncate">{st.name}</span>
                  <span className="tabular-nums text-faint">{cards.length}</span>
                </div>
                <div className="space-y-2">
                  {cards.map((a) => (
                    <Card key={a.id} className="p-2.5 text-[13px]">
                      <div className="flex items-start gap-2">
                        <Avatar name={a.name} size={22} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{a.name ?? t('people.applicant')}</div>
                          {a.email && <div className="truncate text-xs text-faint">{a.email}</div>}
                        </div>
                      </div>
                      <div className="mt-2 flex items-center gap-1">
                        <DropdownMenu
                          className="flex-1"
                          width={160}
                          trigger={<Button size="xs" variant="outline" className="w-full justify-between">{t('people.moveTo')} <ChevronRight size={12} /></Button>}
                        >
                          {stageList.filter((s) => s.id !== st.id).map((s) => (
                            <MenuItem key={s.id} onSelect={() => move.mutate({ id: a.id, stageId: s.id })}>{s.name}</MenuItem>
                          ))}
                        </DropdownMenu>
                        {!st.isHired && (
                          <button
                            className="shrink-0 rounded-md p-1.5 text-success transition-colors hover:bg-success/10"
                            title={t('people.hire')}
                            onClick={() => hire.mutate(a.id)}
                            disabled={hire.isPending}
                          ><UserPlus size={14} /></button>
                        )}
                      </div>
                    </Card>
                  ))}
                  {cards.length === 0 && (
                    <div className="rounded-lg border border-dashed border-border py-4 text-center text-xs text-faint">{t('people.empty')}</div>
                  )}
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
  if (dash.isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 p-6 md:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
      </div>
    );
  }
  const tiles: { label: string; value: string; icon: ReactNode }[] = [
    { label: t('people.headcount'), value: String(d?.headcount ?? d?.activeCount ?? 0), icon: <Users size={15} /> },
    { label: t('people.onLeave'), value: String(d?.onLeave ?? 0), icon: <CalendarClock size={15} /> },
    { label: t('people.newHires'), value: String(d?.newHires ?? 0), icon: <Sparkles size={15} /> },
    { label: t('people.openPositions'), value: String(d?.openPositions ?? d?.openOpenings ?? 0), icon: <Briefcase size={15} /> },
    { label: t('people.inPipeline'), value: String(d?.pipelineCount ?? d?.applicants ?? 0), icon: <UserPlus size={15} /> },
    { label: t('people.upcomingLeave'), value: String(d?.upcomingLeave ?? 0), icon: <CalendarClock size={15} /> },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 p-6 md:grid-cols-3">
      {tiles.map((tile, i) => (
        <div key={tile.label} className="row-enter" style={{ ['--i' as string]: i } as CSSProperties}>
          <Card className="p-4">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{tile.icon} {tile.label}</div>
            <div className="mt-1.5 text-2xl font-semibold tabular-nums">{tile.value}</div>
          </Card>
        </div>
      ))}
    </div>
  );
}
