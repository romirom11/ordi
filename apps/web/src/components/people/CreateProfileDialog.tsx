import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { Button, Input, Select, Spinner } from '../ui';
import { Dialog, toast } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'people.createProfile': 'Create profile',
    'people.createProfileHint': 'Add an employee profile so this person appears with a position, department and HR records.',
    'people.profileCreated': 'Employee profile created',
    'people.noDepartment': 'No department',
    'people.noPosition': 'No position',
    'people.email': 'Email',
  },
  uk: {
    'people.createProfile': 'Створити профіль',
    'people.createProfileHint': 'Додайте профіль співробітника, щоб ця людина мала посаду, відділ і HR-записи.',
    'people.profileCreated': 'Профіль співробітника створено',
    'people.noDepartment': 'Без відділу',
    'people.noPosition': 'Без посади',
    'people.email': 'Ел. пошта',
  },
});

interface Department { id: string; name: string }
interface Position { id: string; title: string }

export interface CreateProfileTarget { userId?: string | null; name?: string | null; email?: string | null }

function splitName(name?: string | null): { firstName: string; lastName: string } {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: '', lastName: '' };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

export function CreateProfileDialog({ target, open, onClose, onCreated }: {
  target: CreateProfileTarget; open: boolean; onClose: () => void; onCreated?: (employeeId: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [form, setForm] = useState(() => ({ ...splitName(target.name), email: target.email ?? '', positionId: '', departmentId: '' }));

  useEffect(() => {
    if (open) setForm({ ...splitName(target.name), email: target.email ?? '', positionId: '', departmentId: '' });
  }, [open, target.name, target.email]);

  const departments = useQuery({ queryKey: ['departments'], queryFn: () => api.get<{ data: Department[] }>('/departments'), enabled: open });
  const positions = useQuery({ queryKey: ['positions'], queryFn: () => api.get<{ data: Position[] }>('/positions'), enabled: open });

  const create = useMutation({
    mutationFn: () => api.post<{ id: string }>('/employees', {
      userId: target.userId ?? undefined,
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      email: form.email.trim() || undefined,
      positionId: form.positionId || undefined,
      departmentId: form.departmentId || undefined,
    }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['peopleDirectory'] });
      qc.invalidateQueries({ queryKey: ['employees'] });
      toast(t('people.profileCreated'));
      onClose();
      if (r?.id) onCreated?.(r.id);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('people.createFailed')),
  });

  return (
    <Dialog open={open} onClose={onClose} width={440} title={t('people.createProfile')}>
      <form
        className="space-y-3 px-4 pb-4 pt-1"
        onSubmit={(e) => { e.preventDefault(); if (form.firstName.trim()) create.mutate(); }}
      >
        <p className="text-xs text-muted-foreground">{t('people.createProfileHint')}</p>
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
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('people.email')}</label>
          <Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('people.position')}</label>
            <Select className="w-full" value={form.positionId} onChange={(e) => setForm((f) => ({ ...f, positionId: e.target.value }))}>
              <option value="">{t('people.noPosition')}</option>
              {(positions.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('people.department')}</label>
            <Select className="w-full" value={form.departmentId} onChange={(e) => setForm((f) => ({ ...f, departmentId: e.target.value }))}>
              <option value="">{t('people.noDepartment')}</option>
              {(departments.data?.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={create.isPending || !form.firstName.trim()}>
            {create.isPending ? <Spinner /> : t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
