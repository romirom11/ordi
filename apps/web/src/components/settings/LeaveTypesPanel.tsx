/**
 * Settings → Leave types (PRD §12.2). The types the leave request form offers,
 * with the behaviour each carries: paid or not, whether it needs an approval,
 * whether it draws down a balance (and the annual quota it draws from), half
 * days, and how much of an unused balance carries into the next year.
 *
 * Until this panel existed the three seeded types were the whole vocabulary –
 * the API had the full CRUD, nothing in the app reached it.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Badge, Button, IconButton, Input, Spinner, Switch, Skeleton, EmptyState } from '../ui';
import { Dialog, ConfirmDialog, toast } from '../overlays';
import { DateField } from '../DatePicker';
import { SectionHead, Field, RowList, AnimatedRow, Disclosure } from './primitives';
import { useLeaveTypes, type LeaveTypeLookup } from '../../lib/queries';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'settings.leaveTypes': 'Leave types',
    'settings.leaveTypesDesc': 'The absence types people can request, and how each one behaves.',
    'ltypes.new': 'New type',
    'ltypes.edit': 'Edit type',
    'ltypes.paid': 'Paid',
    'ltypes.unpaid': 'Unpaid',
    'ltypes.needsApproval': 'Needs approval',
    'ltypes.needsApprovalHint': 'Requests wait for the manager or an approver. Off means it is granted on submit.',
    'ltypes.affectsBalance': 'Draws down a balance',
    'ltypes.affectsBalanceHint': 'Approved days are subtracted from the annual quota; cancelling gives them back.',
    'ltypes.allowHalfDay': 'Allow half days',
    'ltypes.annualQuota': 'Annual quota',
    'ltypes.annualQuotaHint': 'Days per year, allocated per employee.',
    'ltypes.days': 'days',
    'ltypes.carryForward': 'Carry-forward',
    'ltypes.carryForwardLimit': 'Carry-forward limit',
    'ltypes.carryForwardLimitHint': 'Unused days carried into the next period, at most this many. 0 = nothing carries.',
    'ltypes.carryForwardExpiry': 'Carried days expire on',
    'ltypes.carryForwardExpiryHint': 'Leave empty to keep them for the whole period.',
    'ltypes.noQuota': 'No quota',
    'ltypes.deleteTitle': 'Delete leave type',
    'ltypes.deleteConfirm': 'Delete this leave type? Types with existing requests cannot be deleted.',
    'ltypes.empty': 'No leave types yet',
    'ltypes.emptyHint': 'Add one so people have something to request.',
  },
  uk: {
    'settings.leaveTypes': 'Типи відсутностей',
    'settings.leaveTypesDesc': 'Типи відсутностей, які можна запросити, і поведінка кожного.',
    'ltypes.new': 'Новий тип',
    'ltypes.edit': 'Редагувати тип',
    'ltypes.paid': 'Оплачувана',
    'ltypes.unpaid': 'Неоплачувана',
    'ltypes.needsApproval': 'Потребує апруву',
    'ltypes.needsApprovalHint': 'Заявка чекає на менеджера або аппрувера. Вимкнено – надається одразу.',
    'ltypes.affectsBalance': 'Списує баланс',
    'ltypes.affectsBalanceHint': 'Схвалені дні віднімаються від річної квоти; скасування повертає їх.',
    'ltypes.allowHalfDay': 'Дозволити пів дня',
    'ltypes.annualQuota': 'Річна квота',
    'ltypes.annualQuotaHint': 'Днів на рік на кожного співробітника.',
    'ltypes.days': 'дн.',
    'ltypes.carryForward': 'Перенесення залишку',
    'ltypes.carryForwardLimit': 'Ліміт перенесення',
    'ltypes.carryForwardLimitHint': 'Скільки невикористаних днів переходить у наступний період. 0 – не переносяться.',
    'ltypes.carryForwardExpiry': 'Перенесені дні згорають',
    'ltypes.carryForwardExpiryHint': 'Порожньо – діють увесь період.',
    'ltypes.noQuota': 'Без квоти',
    'ltypes.deleteTitle': 'Видалити тип відсутності',
    'ltypes.deleteConfirm': 'Видалити цей тип? Типи, за якими вже є заявки, видалити не можна.',
    'ltypes.empty': 'Ще немає типів відсутностей',
    'ltypes.emptyHint': 'Додайте тип, щоб було що запросити.',
  },
});

type LeaveType = LeaveTypeLookup;

const num = (v: string | number | undefined): number => Number(v ?? 0);

export function LeaveTypesPanel() {
  const t = useT();
  const qc = useQueryClient();
  // The same hook the leave form reads, so its dropdown follows an edit here.
  const typesQ = useLeaveTypes();
  const types = typesQ.data ?? [];
  const [editing, setEditing] = useState<LeaveType | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<LeaveType | null>(null);

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/leave-types/${id}`),
    onSuccess: () => { setDeleting(null); qc.invalidateQueries({ queryKey: ['leaveTypes'] }); toast(t('common.saved')); },
    onError: (e) => { setDeleting(null); toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')); },
  });

  return (
    <div>
      <SectionHead
        title={t('settings.leaveTypes')}
        desc={t('settings.leaveTypesDesc')}
        actions={<Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> {t('ltypes.new')}</Button>}
      />

      {typesQ.isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : types.length === 0 ? (
        <EmptyState icon={<CalendarClock size={18} />} title={t('ltypes.empty')} hint={t('ltypes.emptyHint')} />
      ) : (
        <RowList>
          {types.map((lt, i) => (
            <AnimatedRow key={lt.id} index={i} className="group flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{lt.name}</span>
                  <Badge className={lt.isPaid === false ? 'bg-muted text-muted-foreground' : 'bg-success/10 text-success'}>
                    {lt.isPaid === false ? t('ltypes.unpaid') : t('ltypes.paid')}
                  </Badge>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span>
                    {lt.affectsBalance && num(lt.annualQuota) > 0
                      ? `${num(lt.annualQuota)} ${t('ltypes.days')}`
                      : t('ltypes.noQuota')}
                  </span>
                  {lt.needsApproval !== false && <><span className="text-faint">·</span><span>{t('ltypes.needsApproval')}</span></>}
                  {lt.allowHalfDay && <><span className="text-faint">·</span><span>{t('ltypes.allowHalfDay')}</span></>}
                  {num(lt.carryForwardLimit) > 0 && (
                    <><span className="text-faint">·</span><span>{t('ltypes.carryForward')} {num(lt.carryForwardLimit)}</span></>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
                <IconButton size="sm" aria-label={t('ltypes.edit')} onClick={() => setEditing(lt)}><Pencil size={14} /></IconButton>
                <IconButton size="sm" aria-label={t('common.delete')} className="text-destructive" onClick={() => setDeleting(lt)}><Trash2 size={14} /></IconButton>
              </div>
            </AnimatedRow>
          ))}
        </RowList>
      )}

      <LeaveTypeDialog
        open={createOpen || !!editing}
        type={editing}
        onClose={() => { setCreateOpen(false); setEditing(null); }}
      />

      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => { if (deleting) del.mutate(deleting.id); }}
        title={t('ltypes.deleteTitle')}
        body={t('ltypes.deleteConfirm')}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </div>
  );
}

function LeaveTypeDialog({ open, type, onClose }: { open: boolean; type: LeaveType | null; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [isPaid, setIsPaid] = useState(true);
  const [needsApproval, setNeedsApproval] = useState(true);
  const [affectsBalance, setAffectsBalance] = useState(true);
  const [allowHalfDay, setAllowHalfDay] = useState(false);
  const [annualQuota, setAnnualQuota] = useState('0');
  const [carryForwardLimit, setCarryForwardLimit] = useState('0');
  const [carryForwardExpiry, setCarryForwardExpiry] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(type?.name ?? '');
    setIsPaid(type?.isPaid ?? true);
    setNeedsApproval(type?.needsApproval ?? true);
    setAffectsBalance(type?.affectsBalance ?? true);
    setAllowHalfDay(type?.allowHalfDay ?? false);
    setAnnualQuota(String(num(type?.annualQuota)));
    setCarryForwardLimit(String(num(type?.carryForwardLimit)));
    setCarryForwardExpiry(type?.carryForwardExpiry ?? '');
  }, [open, type]);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(), isPaid, needsApproval, allowHalfDay, affectsBalance,
        // A type that draws no balance has no quota to carry either – sending
        // stale numbers would show a quota the requests never touch.
        annualQuota: affectsBalance ? Number(annualQuota) || 0 : 0,
        carryForwardLimit: affectsBalance ? Number(carryForwardLimit) || 0 : 0,
        carryForwardExpiry: affectsBalance && carryForwardExpiry ? carryForwardExpiry : null,
      };
      return type ? api.patch(`/leave-types/${type.id}`, body) : api.post('/leave-types', body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['leaveTypes'] });
      qc.invalidateQueries({ queryKey: ['leaveBalances'] });
      toast(t('common.saved'));
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('settings.saveFailed')),
  });

  return (
    <Dialog open={open} onClose={onClose} title={type ? t('ltypes.edit') : t('ltypes.new')} width={440}>
      <form
        className="space-y-3.5 px-4 pb-4 pt-1"
        onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) save.mutate(); }}
      >
        <Field label={t('common.name')}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Annual leave" />
        </Field>

        <div className="rounded-lg border border-border">
          <div className="flex items-center justify-between gap-4 border-b border-border px-3 py-2.5">
            <div className="min-w-0"><div className="text-[13px] font-medium">{t('ltypes.paid')}</div></div>
            <Switch checked={isPaid} onChange={setIsPaid} />
          </div>
          <div className="flex items-center justify-between gap-4 border-b border-border px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{t('ltypes.needsApproval')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t('ltypes.needsApprovalHint')}</div>
            </div>
            <Switch checked={needsApproval} onChange={setNeedsApproval} />
          </div>
          <div className="flex items-center justify-between gap-4 border-b border-border px-3 py-2.5">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">{t('ltypes.affectsBalance')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t('ltypes.affectsBalanceHint')}</div>
            </div>
            <Switch checked={affectsBalance} onChange={setAffectsBalance} />
          </div>
          <div className="flex items-center justify-between gap-4 px-3 py-2.5">
            <div className="min-w-0"><div className="text-[13px] font-medium">{t('ltypes.allowHalfDay')}</div></div>
            <Switch checked={allowHalfDay} onChange={setAllowHalfDay} />
          </div>
        </div>

        {/* Quota and carry-forward only mean something for a type that draws a balance. */}
        {affectsBalance && (
          <>
            <Field label={t('ltypes.annualQuota')}>
              <Input
                type="number" min={0} step={0.5} value={annualQuota}
                onChange={(e) => setAnnualQuota(e.target.value)}
              />
              <span className="mt-1 block text-xs text-muted-foreground">{t('ltypes.annualQuotaHint')}</span>
            </Field>

            <Disclosure label={t('ltypes.carryForward')} defaultOpen={Number(carryForwardLimit) > 0}>
              <div className="space-y-3 pt-3">
                <Field label={t('ltypes.carryForwardLimit')}>
                  <Input
                    type="number" min={0} step={0.5} value={carryForwardLimit}
                    onChange={(e) => setCarryForwardLimit(e.target.value)}
                  />
                  <span className="mt-1 block text-xs text-muted-foreground">{t('ltypes.carryForwardLimitHint')}</span>
                </Field>
                <Field label={t('ltypes.carryForwardExpiry')}>
                  <DateField value={carryForwardExpiry || null} onChange={(v) => setCarryForwardExpiry(v ?? '')} />
                  <span className="mt-1 block text-xs text-muted-foreground">{t('ltypes.carryForwardExpiryHint')}</span>
                </Field>
              </div>
            </Disclosure>
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={!name.trim() || save.isPending}>
            {save.isPending ? <Spinner /> : null} {type ? t('common.save') : t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
