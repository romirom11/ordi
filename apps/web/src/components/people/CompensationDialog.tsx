import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { Button, Input, Select, Spinner } from '../ui';
import { Dialog, toast } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';
import { DateField } from '../DatePicker';

extendDict({
  en: {
    'people.addCompensation': 'Add compensation',
    'people.compType': 'Type',
    'people.compMonthly': 'Monthly',
    'people.compHourly': 'Hourly',
    'people.compContractor': 'Contractor',
    'people.amount': 'Amount',
    'people.effectiveFrom': 'Effective from',
    'people.compAdded': 'Compensation record added',
    'people.compAddFailed': 'Could not add the compensation record',
  },
  uk: {
    'people.addCompensation': 'Додати компенсацію',
    'people.compType': 'Тип',
    'people.compMonthly': 'Щомісячна',
    'people.compHourly': 'Погодинна',
    'people.compContractor': 'Підряд',
    'people.amount': 'Сума',
    'people.effectiveFrom': 'Діє з',
    'people.compAdded': 'Запис про компенсацію додано',
    'people.compAddFailed': 'Не вдалося додати запис про компенсацію',
  },
});

const COMP_TYPES = ['monthly', 'hourly', 'contractor'] as const;
const COMP_TYPE_KEY: Record<string, string> = {
  monthly: 'people.compMonthly', hourly: 'people.compHourly', contractor: 'people.compContractor',
};

function today(): string { return new Date().toISOString().slice(0, 10); }

export function CompensationDialog({ employeeId, open, onClose }: { employeeId: string; open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [form, setForm] = useState({ compType: 'monthly', amount: '', currency: 'USD', effectiveFrom: today() });

  useEffect(() => {
    if (open) setForm({ compType: 'monthly', amount: '', currency: 'USD', effectiveFrom: today() });
  }, [open]);

  const create = useMutation({
    mutationFn: () => api.post('/compensation', {
      employeeId,
      compType: form.compType,
      amount: Number(form.amount),
      currency: form.currency.trim().toUpperCase() || 'USD',
      effectiveFrom: form.effectiveFrom,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['compensation', employeeId] });
      toast(t('people.compAdded'));
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('people.compAddFailed')),
  });

  const valid = Number(form.amount) > 0 && !!form.effectiveFrom && form.currency.trim().length === 3;

  return (
    <Dialog open={open} onClose={onClose} width={400} title={t('people.addCompensation')}>
      <form className="space-y-3 px-4 pb-4 pt-1" onSubmit={(e) => { e.preventDefault(); if (valid) create.mutate(); }}>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('people.compType')}</label>
          <Select className="w-full" value={form.compType} onChange={(e) => setForm((f) => ({ ...f, compType: e.target.value }))}>
            {COMP_TYPES.map((c) => <option key={c} value={c}>{t(COMP_TYPE_KEY[c]!)}</option>)}
          </Select>
        </div>
        <div className="grid grid-cols-[1fr_88px] gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('people.amount')}</label>
            <Input type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">{t('common.currency')}</label>
            <Input value={form.currency} maxLength={3} onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} />
          </div>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('people.effectiveFrom')}</label>
          <DateField value={form.effectiveFrom} onChange={(v) => setForm((f) => ({ ...f, effectiveFrom: v ?? '' }))} clearable={false} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={create.isPending || !valid}>{create.isPending ? <Spinner /> : t('common.add')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
