import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { Button, Input, Select, Spinner } from '../ui';
import { Dialog, toast } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';
import { DateField } from '../DatePicker';

extendDict({
  en: {
    'people.editEmployee': 'Edit employee',
    'people.phone': 'Phone',
    'people.noManager': 'No manager',
    'people.editSaved': 'Employee updated',
    'people.editFailed': 'Could not save the employee',
    'people.editConflict': 'Someone else changed this record. The latest data has been loaded, please retry.',
    'people.firstNameRequired': 'First name is required',
    'people.email': 'Email',
    'people.noDepartment': 'No department',
    'people.noPosition': 'No position',
  },
  uk: {
    'people.editEmployee': 'Редагувати співробітника',
    'people.phone': 'Телефон',
    'people.noManager': 'Без керівника',
    'people.editSaved': 'Співробітника оновлено',
    'people.editFailed': 'Не вдалося зберегти співробітника',
    'people.editConflict': 'Хтось інший змінив цей запис. Дані оновлено, спробуйте ще раз.',
    'people.firstNameRequired': 'Імʼя обовʼязкове',
    'people.email': 'Ел. пошта',
    'people.noDepartment': 'Без відділу',
    'people.noPosition': 'Без посади',
  },
});

interface Department { id: string; name: string }
interface Position { id: string; title: string }
interface EmployeeLite { id: string; firstName?: string | null; lastName?: string | null; name?: string | null }

export interface EditableEmployee {
  id: string; firstName?: string | null; lastName?: string | null;
  positionId?: string | null; departmentId?: string | null;
  managerId?: string | null; employmentType?: string | null; joinDate?: string | null;
  birthday?: string | null;
  version?: number;
}

const EMP_TYPE_KEY: Record<string, string> = {
  full_time: 'people.typeFullTime', part_time: 'people.typePartTime', contractor: 'people.typeContractor',
};

function formFrom(e: EditableEmployee) {
  return {
    firstName: e.firstName ?? '',
    lastName: e.lastName ?? '',
    positionId: e.positionId ?? '',
    departmentId: e.departmentId ?? '',
    managerId: e.managerId ?? '',
    employmentType: e.employmentType ?? 'full_time',
    joinDate: e.joinDate ?? '',
    birthday: e.birthday ?? '',
  };
}

export function EditEmployeeDialog({ employee, open, onClose }: {
  employee: EditableEmployee; open: boolean; onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [form, setForm] = useState(() => formFrom(employee));

  useEffect(() => {
    if (open) setForm(formFrom(employee));
  }, [open, employee]);

  const departments = useQuery({ queryKey: ['departments'], queryFn: () => api.get<{ data: Department[] }>('/departments'), enabled: open });
  const positions = useQuery({ queryKey: ['positions'], queryFn: () => api.get<{ data: Position[] }>('/positions'), enabled: open });
  const emps = useQuery({ queryKey: ['employees'], queryFn: () => api.get<{ data: EmployeeLite[] }>('/employees'), enabled: open });

  const managers = (emps.data?.data ?? []).filter((m) => m.id !== employee.id);
  const managerLabel = (m: EmployeeLite) => m.name ?? ([m.firstName, m.lastName].filter(Boolean).join(' ') || t('people.unnamed'));

  const save = useMutation({
    mutationFn: () => api.patch(`/employees/${employee.id}`, {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      positionId: form.positionId || null,
      departmentId: form.departmentId || null,
      managerId: form.managerId || null,
      employmentType: form.employmentType,
      joinDate: form.joinDate || null,
      birthday: form.birthday || null,
      ...(typeof employee.version === 'number' ? { version: employee.version } : {}),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employee', employee.id] });
      qc.invalidateQueries({ queryKey: ['employees'] });
      qc.invalidateQueries({ queryKey: ['peopleDirectory'] });
      toast(t('people.editSaved'));
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'version_conflict') {
        qc.invalidateQueries({ queryKey: ['employee', employee.id] });
        toast.error(t('people.editConflict'));
      } else {
        toast.error(e instanceof ApiError ? e.message : t('people.editFailed'));
      }
    },
  });

  const label = (text: string) => <label className="text-xs font-medium text-muted-foreground">{text}</label>;

  return (
    <Dialog open={open} onClose={onClose} width={480} title={t('people.editEmployee')}>
      <form
        className="space-y-3 px-4 pb-4 pt-1"
        onSubmit={(e) => { e.preventDefault(); if (form.firstName.trim() && !save.isPending) save.mutate(); }}
      >
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            {label(t('crm.firstName'))}
            <Input autoFocus value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} />
          </div>
          <div className="space-y-1">
            {label(t('crm.lastName'))}
            <Input value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            {label(t('people.position'))}
            <Select className="w-full" value={form.positionId} onChange={(e) => setForm((f) => ({ ...f, positionId: e.target.value }))}>
              <option value="">{t('people.noPosition')}</option>
              {(positions.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </Select>
          </div>
          <div className="space-y-1">
            {label(t('people.department'))}
            <Select className="w-full" value={form.departmentId} onChange={(e) => setForm((f) => ({ ...f, departmentId: e.target.value }))}>
              <option value="">{t('people.noDepartment')}</option>
              {(departments.data?.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </div>
        </div>
        <div className="space-y-1">
          {label(t('people.manager'))}
          <Select className="w-full" value={form.managerId} onChange={(e) => setForm((f) => ({ ...f, managerId: e.target.value }))}>
            <option value="">{t('people.noManager')}</option>
            {managers.map((m) => <option key={m.id} value={m.id}>{managerLabel(m)}</option>)}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            {label(t('people.employmentType'))}
            <Select className="w-full" value={form.employmentType} onChange={(e) => setForm((f) => ({ ...f, employmentType: e.target.value }))}>
              {Object.entries(EMP_TYPE_KEY).map(([k, key]) => <option key={k} value={k}>{t(key)}</option>)}
            </Select>
          </div>
          <div className="space-y-1">
            {label(t('people.joinDate'))}
            <DateField value={form.joinDate} onChange={(v) => setForm((f) => ({ ...f, joinDate: v ?? '' }))} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            {label(t('people.birthday'))}
            <DateField value={form.birthday} onChange={(v) => setForm((f) => ({ ...f, birthday: v ?? '' }))} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={save.isPending || !form.firstName.trim()}>
            {save.isPending ? <Spinner /> : t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
