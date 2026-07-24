import { useMemo, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '../lib/router';
import { api } from '../lib/api';
import { useCan } from '../lib/auth';
import {
  Button, Badge, Breadcrumbs, PageBody, EmptyState, Skeleton, Avatar,
  fmtMoney, fmtDate, cn,
} from '../components/ui';
import { DropdownMenu, MenuItem, toast } from '../components/overlays';
import { CompensationDialog } from '../components/people/CompensationDialog';
import { EditEmployeeDialog } from '../components/people/EditEmployeeDialog';
import {
  Users, MoreHorizontal, UserCheck, UserX, Plus, Lock, Mail, Briefcase,
  CalendarClock, UserCog, AtSign, Pencil,
} from 'lucide-react';
import { usePageTitle } from '../lib/tabs';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'people.basicInfo': 'Basic info',
    'people.manager': 'Manager',
    'people.employmentType': 'Employment',
    'people.typeFullTime': 'Full-time',
    'people.typePartTime': 'Part-time',
    'people.typeContractor': 'Contractor',
    'people.joinDate': 'Join date',
    'people.probationEnd': 'Probation ends',
    'people.exitDate': 'Exit date',
    'people.userAccount': 'User account',
    'people.compExplain': 'Compensation records are visible only to roles with the people.read_compensation permission. HR or an admin can add a record.',
    'people.currentComp': 'Current',
  },
  uk: {
    'people.basicInfo': 'Основна інформація',
    'people.manager': 'Керівник',
    'people.employmentType': 'Зайнятість',
    'people.typeFullTime': 'Повна зайнятість',
    'people.typePartTime': 'Часткова зайнятість',
    'people.typeContractor': 'Підряд',
    'people.joinDate': 'Дата приєднання',
    'people.probationEnd': 'Кінець випробувального',
    'people.exitDate': 'Дата звільнення',
    'people.userAccount': 'Обліковий запис',
    'people.compExplain': 'Записи про компенсацію бачать лише ролі з правом people.read_compensation. Додати запис може HR/адмін.',
    'people.currentComp': 'Поточна',
  },
});

const EMP_STATUS_META: Record<string, { color: string; key: string }> = {
  active: { color: '#22c55e', key: 'people.statusActive' },
  on_leave: { color: '#f59e0b', key: 'people.statusOnLeave' },
  terminated: { color: '#6b7280', key: 'people.statusTerminated' },
};
const EMP_TYPE_KEY: Record<string, string> = {
  full_time: 'people.typeFullTime', part_time: 'people.typePartTime', contractor: 'people.typeContractor',
};

interface EmployeeUser { id: string; name: string; email: string; avatar?: string | null; isActive?: boolean }
interface EmployeeDetail {
  id: string; userId?: string | null; firstName?: string | null; lastName?: string | null; email?: string | null;
  phone?: string | null; positionId?: string | null; departmentId?: string | null; employmentType?: string | null;
  managerId?: string | null; joinDate?: string | null; probationEnd?: string | null; exitDate?: string | null;
  status?: string | null; version?: number; user?: EmployeeUser | null;
}
interface Compensation { id?: string; compType?: string; amount?: number | string; currency?: string; effectiveFrom?: string | null; effectiveTo?: string | null }
interface Position { id: string; title: string }
interface Department { id: string; name: string }
interface EmployeeLite { id: string; firstName?: string | null; lastName?: string | null; name?: string | null }

function StatusPill({ status }: { status: string }) {
  const t = useT();
  const m = EMP_STATUS_META[status] ?? { color: '#8a8f98', key: '' };
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium">
      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: m.color }} />
      <span className="text-muted-foreground">{m.key ? t(m.key) : status}</span>
    </span>
  );
}

function InfoRow({ icon, label, value }: { icon: ReactNode; label: string; value: ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-2">
      <span className="mt-0.5 flex w-32 shrink-0 items-center gap-2 text-xs text-muted-foreground">
        <span className="text-faint [&>svg]:block">{icon}</span>{label}
      </span>
      <span className="min-w-0 flex-1 text-[13px] text-foreground">{value}</span>
    </div>
  );
}

export function EmployeePage({ id }: { id: string }) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const can = useCan();
  const canWrite = can('people.write');
  const canComp = can('people.read_compensation');
  const [compOpen, setCompOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const employee = useQuery({ queryKey: ['employee', id], queryFn: () => api.get<EmployeeDetail>(`/employees/${id}`) });
  const positions = useQuery({ queryKey: ['positions'], queryFn: () => api.get<{ data: Position[] }>('/positions') });
  const departments = useQuery({ queryKey: ['departments'], queryFn: () => api.get<{ data: Department[] }>('/departments') });
  const emps = useQuery({ queryKey: ['employees'], queryFn: () => api.get<{ data: EmployeeLite[] }>('/employees') });
  const compensation = useQuery({
    queryKey: ['compensation', id],
    queryFn: () => api.get<{ data: Compensation[] }>(`/employees/${id}/compensation`),
    enabled: canComp,
  });

  const lifecycle = useMutation({
    mutationFn: (action: 'onboard' | 'exit') => api.post(`/employees/${id}/lifecycle`, { action }),
    onSuccess: (_r, action) => {
      qc.invalidateQueries({ queryKey: ['employee', id] });
      qc.invalidateQueries({ queryKey: ['employees'] });
      qc.invalidateQueries({ queryKey: ['peopleDirectory'] });
      toast(action === 'onboard' ? t('people.onboarded') : t('people.exited'));
    },
    onError: () => toast.error(t('people.lifecycleFailed')),
  });

  const e = employee.data;
  const name = e ? ([e.firstName, e.lastName].filter(Boolean).join(' ') || e.user?.name || t('people.unnamed')) : t('people.employee');
  const positionTitle = useMemo(() => positions.data?.data.find((p) => p.id === e?.positionId)?.title ?? null, [positions.data, e?.positionId]);
  const departmentName = useMemo(() => departments.data?.data.find((d) => d.id === e?.departmentId)?.name ?? null, [departments.data, e?.departmentId]);
  const managerName = useMemo(() => {
    if (!e?.managerId) return null;
    const m = emps.data?.data.find((x) => x.id === e.managerId);
    if (!m) return null;
    return m.name ?? ([m.firstName, m.lastName].filter(Boolean).join(' ') || null);
  }, [emps.data, e?.managerId]);

  const comp = compensation.data?.data ?? [];
  usePageTitle(e ? name : undefined);

  // Slim bar: parent trail + actions. Identity (name, role, department) lives
  // in the hero below, so nothing is stated twice.
  const header = (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
      <Breadcrumbs items={[{ label: t('nav.people'), to: '/people', icon: <Users size={13} /> }]} />
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <StatusPill status={e?.status ?? 'active'} />
        {canWrite && e && (
          <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
            <Pencil size={13} /> {t('common.edit')}
          </Button>
        )}
        {canWrite && (
          <DropdownMenu align="end" trigger={<Button size="sm" variant="outline">{t('people.actions')} <MoreHorizontal size={14} /></Button>}>
            <MenuItem icon={<UserCheck size={13} />} onSelect={() => lifecycle.mutate('onboard')} disabled={lifecycle.isPending}>{t('people.onboard')}</MenuItem>
            <MenuItem icon={<UserX size={13} />} danger onSelect={() => lifecycle.mutate('exit')} disabled={lifecycle.isPending}>{t('people.exit')}</MenuItem>
          </DropdownMenu>
        )}
      </div>
    </div>
  );

  if (employee.isLoading) {
    return (
      <div className="page-enter">
        {header}
        <PageBody>
          <div className="mb-6 flex items-center gap-4">
            <Skeleton className="h-12 w-12 rounded-full" />
            <div className="space-y-2"><Skeleton className="h-5 w-40" /><Skeleton className="h-4 w-28" /></div>
          </div>
          <Skeleton className="h-40 w-full" />
        </PageBody>
      </div>
    );
  }
  if (employee.isError || !e) {
    return (
      <div className="page-enter">
        {header}
        <EmptyState icon={<Users size={20} />} title={t('people.employeeNotFound')} action={<Button size="sm" variant="outline" onClick={() => navigate('/people')}>{t('nav.people')}</Button>} />
      </div>
    );
  }

  return (
    <div className="page-enter">
      {header}
      <PageBody>
        {/* Hero */}
        <div className="mb-6 flex items-center gap-4">
          <Avatar name={name} src={e.user?.avatar} size={48} />
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold leading-tight">{name}</h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
              {positionTitle && <span className="inline-flex items-center gap-1.5"><Briefcase size={13} className="text-faint" />{positionTitle}</span>}
              {departmentName && <Badge className="ml-0.5">{departmentName}</Badge>}
            </div>
            {e.user ? (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-muted-foreground">
                  <AtSign size={11} className="text-faint" />{t('people.userAccount')}
                </span>
                <span className="inline-flex items-center gap-1 text-muted-foreground"><Mail size={11} className="text-faint" />{e.user.email}</span>
              </div>
            ) : e.email ? (
              <div className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground"><Mail size={11} className="text-faint" />{e.email}</div>
            ) : null}
          </div>
        </div>

        {/* Basic info */}
        <section className="mb-6">
          <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{t('people.basicInfo')}</h2>
          <div className="divide-y divide-border rounded-xl border border-border bg-card px-4">
            {/* Position and department are already stated in the hero. */}
            <InfoRow icon={<UserCog size={13} />} label={t('people.manager')} value={managerName ?? '–'} />
            <InfoRow icon={<Briefcase size={13} />} label={t('people.employmentType')} value={e.employmentType ? t(EMP_TYPE_KEY[e.employmentType] ?? '') || e.employmentType : '–'} />
            <InfoRow icon={<CalendarClock size={13} />} label={t('people.joinDate')} value={e.joinDate ? fmtDate(e.joinDate) : '–'} />
            {e.probationEnd && <InfoRow icon={<CalendarClock size={13} />} label={t('people.probationEnd')} value={fmtDate(e.probationEnd)} />}
            {e.exitDate && <InfoRow icon={<CalendarClock size={13} />} label={t('people.exitDate')} value={fmtDate(e.exitDate)} />}
          </div>
        </section>

        {/* Compensation – only rendered when the viewer can read compensation */}
        {canComp && (
          <section className="mb-6">
            <div className="mb-1 flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
                <Lock size={11} />{t('people.compensation')}
              </h2>
              {canWrite && (
                <Button size="xs" variant="outline" onClick={() => setCompOpen(true)}><Plus size={13} /> {t('common.add')}</Button>
              )}
            </div>
            {compensation.isLoading ? (
              <Skeleton className="h-16 w-full rounded-xl" />
            ) : comp.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border bg-card px-4 py-6 text-center">
                <p className="mx-auto max-w-md text-[13px] text-muted-foreground">{t('people.compExplain')}</p>
                {canWrite && (
                  <Button size="sm" variant="outline" className="mt-3" onClick={() => setCompOpen(true)}><Plus size={13} /> {t('people.addCompensation')}</Button>
                )}
              </div>
            ) : (
              <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
                {comp.map((c, i) => {
                  const current = !c.effectiveTo;
                  return (
                    <div key={c.id ?? String(i)} className="flex items-center justify-between px-4 py-2.5 text-[13px]">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium capitalize text-foreground">{c.compType ?? 'monthly'}</span>
                          {current && <Badge className="bg-success/15 text-success">{t('people.currentComp')}</Badge>}
                        </div>
                        <div className="text-xs text-faint">
                          {fmtDate(c.effectiveFrom)}{c.effectiveTo ? ` → ${fmtDate(c.effectiveTo)}` : ''}
                        </div>
                      </div>
                      <span className={cn('shrink-0 font-semibold tabular-nums', current ? 'text-foreground' : 'text-muted-foreground')}>
                        {fmtMoney(c.amount ?? 0, c.currency ?? 'USD')}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </PageBody>

      <CompensationDialog employeeId={id} open={compOpen} onClose={() => setCompOpen(false)} />
      {canWrite && <EditEmployeeDialog employee={e} open={editOpen} onClose={() => setEditOpen(false)} />}
    </div>
  );
}
