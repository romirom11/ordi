import { useMemo, useState, type ReactNode, type CSSProperties } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, qs, ApiError } from '../lib/api';
import { useNavigate } from '../lib/router';
import { useTabs } from '../lib/tabs';
import { useCan } from '../lib/auth';
import {
  Button, Input, Select, Textarea, Card, Badge, PageHeader, EmptyState, Skeleton, Spinner,
  Avatar, SegmentedControl, fmtMoney, fmtDate, cn,
} from '../components/ui';
import { Dialog, DropdownMenu, MenuItem, ContextMenu, toast, type ContextMenuEntry } from '../components/overlays';
import {
  Plus, Check, X, UserPlus, Users, CalendarClock, Briefcase,
  ChevronRight, LayoutGrid, Sparkles, ExternalLink, Copy, FilePlus, IdCard, Network,
} from 'lucide-react';
import { CreateProfileDialog, type CreateProfileTarget } from '../components/people/CreateProfileDialog';
import { OrgStructureView } from '../components/people/OrgStructureView';
import { useLeaveTypes } from '../lib/queries';
import { useT, extendDict } from '../lib/i18n';
import { DateField } from '../components/DatePicker';

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
    'people.leaveFor': 'For',
    'people.leaveForMe': 'Myself',
    'people.moveFailed': 'Could not move the applicant',
    'people.hireFailed': 'Could not hire the applicant',
    'people.hired': 'Applicant hired',
    'people.moved': 'Applicant moved',
    'people.moveTo': 'Move to…',
    'people.searchPlaceholder': 'Filter by name or role…',
    'people.noProfile': 'No profile',
    'people.statusDeactivated': 'Deactivated',
    'people.openProfile': 'Open profile',
    'people.openNewTab': 'Open in new tab',
    'people.copyEmail': 'Copy email',
    'people.emailCopied': 'Email copied',
    'people.noEmail': 'No email',
    'people.directoryHint': 'Everyone in the workspace shows here – including users without an employee profile yet.',
    'people.org': 'Organization',
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
    'people.leaveFor': 'Кому',
    'people.leaveForMe': 'Собі',
    'people.moveFailed': 'Не вдалося перемістити кандидата',
    'people.hireFailed': 'Не вдалося найняти кандидата',
    'people.hired': 'Кандидата найнято',
    'people.moved': 'Кандидата переміщено',
    'people.moveTo': 'Перемістити до…',
    'people.searchPlaceholder': 'Фільтр за іменем або посадою…',
    'people.noProfile': 'Немає профілю',
    'people.statusDeactivated': 'Деактивований',
    'people.openProfile': 'Відкрити профіль',
    'people.openNewTab': 'Відкрити в новій вкладці',
    'people.copyEmail': 'Копіювати ел. пошту',
    'people.emailCopied': 'Ел. пошту скопійовано',
    'people.noEmail': 'Немає ел. пошти',
    'people.directoryHint': 'Тут показані всі люди робочого простору – зокрема користувачі, які ще не мають профілю співробітника.',
    'people.org': 'Організація',
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

type Tab = 'employees' | 'leave' | 'recruiting' | 'org' | 'dashboard';

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
    { key: 'org', label: t('people.org'), icon: <Network size={13} />, show: can('people.write') },
    { key: 'dashboard', label: t('nav.dashboard'), icon: <LayoutGrid size={13} />, show: true },
  ];

  return (
    <div>
      <PageHeader
        title={t('nav.people')}
        actions={<SegmentedControl options={tabs.filter((tb) => tb.show)} value={tab} onChange={(v) => setTab(v as Tab)} />}
      />
      {tab === 'employees' && <DirectoryView />}
      {tab === 'leave' && <LeaveView />}
      {tab === 'recruiting' && can('people.recruit') && <RecruitingView />}
      {tab === 'org' && can('people.write') && <OrgStructureView />}
      {tab === 'dashboard' && <PeopleDashboardView />}
    </div>
  );
}

const DIR_STATUS_META: Record<string, { color: string; key: string }> = {
  active: { color: '#22c55e', key: 'people.statusActive' },
  deactivated: { color: '#6b7280', key: 'people.statusDeactivated' },
};

interface DirectoryRow {
  userId: string | null; employeeId: string | null; name: string; email: string | null;
  avatar: string | null; position: string | null; departmentName: string | null;
  status: 'active' | 'deactivated'; hasEmployeeProfile: boolean;
}

type DirFilter = 'all' | 'active' | 'deactivated' | 'no_profile';

function DirectoryView() {
  const t = useT();
  const can = useCan();
  const navigate = useNavigate();
  const tabs = useTabs();
  const canWrite = can('people.write');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<DirFilter>('all');
  const [createTarget, setCreateTarget] = useState<CreateProfileTarget | null>(null);

  const directory = useQuery({ queryKey: ['peopleDirectory'], queryFn: () => api.get<{ data: DirectoryRow[] }>('/people/directory') });
  const rows = directory.data?.data ?? [];

  const counts = useMemo(() => {
    const c: Record<DirFilter, number> = { all: rows.length, active: 0, deactivated: 0, no_profile: 0 };
    for (const r of rows) {
      c[r.status] += 1;
      if (!r.hasEmployeeProfile) c.no_profile += 1;
    }
    return c;
  }, [rows]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === 'active' && r.status !== 'active') return false;
      if (filter === 'deactivated' && r.status !== 'deactivated') return false;
      if (filter === 'no_profile' && r.hasEmployeeProfile) return false;
      if (!q) return true;
      return r.name.toLowerCase().includes(q)
        || (r.email ?? '').toLowerCase().includes(q)
        || (r.position ?? '').toLowerCase().includes(q);
    });
  }, [rows, query, filter]);

  const openRow = (r: DirectoryRow) => {
    if (r.hasEmployeeProfile && r.employeeId) navigate(`/people/${r.employeeId}`);
    else if (canWrite) setCreateTarget({ userId: r.userId, name: r.name, email: r.email });
  };

  const copyEmail = (email: string | null) => {
    if (!email) { toast.error(t('people.noEmail')); return; }
    navigator.clipboard?.writeText(email).then(() => toast(t('people.emailCopied'))).catch(() => toast.error(email));
  };

  const menuFor = (r: DirectoryRow): ContextMenuEntry[] => {
    const items: ContextMenuEntry[] = [];
    if (r.hasEmployeeProfile && r.employeeId) {
      items.push({ key: 'open', label: t('people.openProfile'), icon: <IdCard size={15} />, onSelect: () => navigate(`/people/${r.employeeId}`) });
      if (tabs) items.push({ key: 'newtab', label: t('people.openNewTab'), icon: <ExternalLink size={15} />, onSelect: () => tabs.openInNewTab(`/people/${r.employeeId}`) });
    } else if (canWrite) {
      items.push({ key: 'create', label: t('people.createProfile'), icon: <FilePlus size={15} />, onSelect: () => setCreateTarget({ userId: r.userId, name: r.name, email: r.email }) });
    }
    items.push({ type: 'separator' });
    items.push({ key: 'copy', label: t('people.copyEmail'), icon: <Copy size={15} />, disabled: !r.email, onSelect: () => copyEmail(r.email) });
    return items;
  };

  const filters: { key: DirFilter; label: string; color?: string }[] = [
    { key: 'all', label: t('common.all') },
    { key: 'active', label: t('people.statusActive'), color: DIR_STATUS_META.active!.color },
    { key: 'deactivated', label: t('people.statusDeactivated'), color: DIR_STATUS_META.deactivated!.color },
    { key: 'no_profile', label: t('people.noProfile') },
  ];

  return (
    <div className="p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {filters.map((f) => {
            const n = counts[f.key];
            if (f.key !== 'all' && n === 0) return null;
            const active = filter === f.key;
            return (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors duration-150',
                  active ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                {f.color && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: f.color }} />}
                {f.label}
                <span className="tabular-nums text-faint">{n}</span>
              </button>
            );
          })}
        </div>
        <div className="w-full max-w-xs sm:w-64">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('people.searchPlaceholder')} />
        </div>
      </div>

      {directory.isLoading ? (
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
        <EmptyState icon={<Users size={20} />} title={t('people.noEmployees')} hint={t('people.directoryHint')} />
      ) : shown.length === 0 ? (
        <EmptyState icon={<Users size={20} />} title={t('crm.noMatch')} hint={t('crm.noMatchHint')} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          {shown.map((r, i) => {
            const dept = r.departmentName;
            return (
              <ContextMenu key={r.userId ?? r.employeeId ?? String(i)} items={menuFor(r)}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => openRow(r)}
                  onKeyDown={(e) => { if (e.key === 'Enter') openRow(r); }}
                  style={{ ['--i' as string]: Math.min(i, 10) }}
                  className={cn(
                    'row-enter group flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 hover:bg-muted/60',
                    i > 0 && 'border-t border-border',
                  )}
                >
                  <Avatar name={r.name} src={r.avatar} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium text-foreground">{r.name}</span>
                      {!r.hasEmployeeProfile && (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">{t('people.noProfile')}</span>
                      )}
                    </div>
                    <div className="truncate text-xs text-faint">{r.position ?? '–'}</div>
                  </div>
                  {dept && <Badge color={deptColor(dept)} className="hidden shrink-0 sm:inline-flex">{dept}</Badge>}
                  <StatusPill status={r.status} meta={DIR_STATUS_META} />
                  {!r.hasEmployeeProfile && canWrite && (
                    <button
                      title={t('people.createProfile')}
                      onClick={(e) => { e.stopPropagation(); setCreateTarget({ userId: r.userId, name: r.name, email: r.email }); }}
                      className="shrink-0 rounded-md p-1.5 text-muted-foreground opacity-0 transition-all duration-150 hover:bg-primary/10 hover:text-primary group-hover:opacity-100"
                    >
                      <FilePlus size={15} />
                    </button>
                  )}
                </div>
              </ContextMenu>
            );
          })}
        </div>
      )}

      {createTarget && (
        <CreateProfileDialog
          open
          target={createTarget}
          onClose={() => setCreateTarget(null)}
          onCreated={(employeeId) => navigate(`/people/${employeeId}`)}
        />
      )}
    </div>
  );
}

function LeaveView() {
  const t = useT();
  const qc = useQueryClient();
  const can = useCan();
  const canApprove = can('people.approve_leave');
  const requests = useQuery({ queryKey: ['leaveRequests'], queryFn: () => api.get<{ data: LeaveRequest[] }>('/leave-requests') });
  const types = useLeaveTypes();
  // Filing for someone else is an HR act; everyone else files for themselves,
  // which the API infers from the session – no employee id to send.
  const canRequestForOthers = can('people.write') || can('people.manage_leave') || can('people.approve_leave');
  const directory = useQuery({
    queryKey: ['peopleDirectory'],
    queryFn: () => api.get<{ data: DirectoryRow[] }>('/people/directory'),
    enabled: canRequestForOthers && can('people.read'),
  });
  const staff = (directory.data?.data ?? []).filter((r) => r.employeeId && r.status === 'active');
  const [form, setForm] = useState({ employeeId: '', leaveTypeId: '', fromDate: '', toDate: '', reason: '' });
  const create = useMutation({
    mutationFn: () => api.post('/leave-requests', {
      ...(form.employeeId ? { employeeId: form.employeeId } : {}),
      leaveTypeId: form.leaveTypeId, fromDate: form.fromDate, toDate: form.toDate, reason: form.reason,
    }),
    onSuccess: () => {
      setForm({ employeeId: '', leaveTypeId: '', fromDate: '', toDate: '', reason: '' });
      qc.invalidateQueries({ queryKey: ['leaveRequests'] });
      toast(t('people.leaveSubmitted'));
    },
    // The API says exactly what is wrong ("your account is not linked to an
    // employee record", "overlaps an existing request"); a generic failure
    // toast threw that away and left people guessing.
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('people.leaveCreateFailed')),
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
  const typeList = types.data ?? [];

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
                  <div className="truncate font-medium text-foreground">{r.employeeName ?? '–'}</div>
                  <div className="truncate text-xs text-faint">{r.leaveTypeName ?? '–'}</div>
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
          {canRequestForOthers && staff.length > 0 && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('people.leaveFor')}</label>
              <Select value={form.employeeId} onChange={(e) => setForm((f) => ({ ...f, employeeId: e.target.value }))} className="w-full">
                <option value="">{t('people.leaveForMe')}</option>
                {staff.map((r) => <option key={r.employeeId} value={r.employeeId!}>{r.name}</option>)}
              </Select>
            </div>
          )}
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
              <DateField value={form.fromDate} onChange={(v) => setForm((f) => ({ ...f, fromDate: v ?? '' }))} clearable={false} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('resourcing.to')}</label>
              <DateField value={form.toDate} onChange={(v) => setForm((f) => ({ ...f, toDate: v ?? '' }))} clearable={false} min={form.fromDate || undefined} />
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
  // API shape: { headcount: {active,onLeave,newHires,exits}, openJobOpenings, pipeline: [{count}], upcomingAbsences: [] }
  // (with fallbacks for older/flat shapes so this keeps working either way).
  const pipelineCount = Array.isArray(d?.pipeline)
    ? d.pipeline.reduce((a: number, p: any) => a + Number(p?.count ?? 0), 0)
    : d?.pipelineCount ?? d?.applicants ?? 0;
  const tiles: { label: string; value: string; icon: ReactNode }[] = [
    { label: t('people.headcount'), value: String(d?.headcount?.active ?? d?.headcount ?? d?.activeCount ?? 0), icon: <Users size={15} /> },
    { label: t('people.onLeave'), value: String(d?.headcount?.onLeave ?? d?.onLeave ?? 0), icon: <CalendarClock size={15} /> },
    { label: t('people.newHires'), value: String(d?.headcount?.newHires ?? d?.newHires ?? 0), icon: <Sparkles size={15} /> },
    { label: t('people.openPositions'), value: String(d?.openJobOpenings ?? d?.openPositions ?? d?.openOpenings ?? 0), icon: <Briefcase size={15} /> },
    { label: t('people.inPipeline'), value: String(pipelineCount), icon: <UserPlus size={15} /> },
    { label: t('people.upcomingLeave'), value: String(d?.upcomingAbsences?.length ?? d?.upcomingLeave ?? 0), icon: <CalendarClock size={15} /> },
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
