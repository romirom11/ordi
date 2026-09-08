/**
 * Leave self-service on the profile page. Works without people.read: the API
 * scopes GET /leave-requests to the caller's own requests, /leave-entitlements
 * to their own balances, and `?scope=approvals` lists requests waiting on the
 * caller as approver (empty for most people). When the account has no linked
 * employee record the own-requests query fails – we show a hint instead of the
 * list, but still render the approvals section if there is anything to decide.
 *
 * The card shows what is left per type and the form checks a range against it
 * before it is sent, using the same `@ordi/shared` calc the API enforces with –
 * the point being that you see the refusal while picking dates, not after.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Check, ChevronRight, Plus, X } from 'lucide-react';
import { leaveDays, exceedsEntitlement } from '@ordi/shared';
import { api, ApiError } from '../../lib/api';
import { useHolidaySet, useLeaveTypes, useMyLeaveEntitlements, type LeaveEntitlement } from '../../lib/queries';
import { extendDict, useT } from '../../lib/i18n';
import { Avatar, Badge, Button, Checkbox, Input, Select, Skeleton, Card, Spinner, cn, fmtDate } from '../ui';
import { ConfirmDialog, Dialog, toast } from '../overlays';
import { DateField } from '../DatePicker';

extendDict({
  en: {
    'leave.myLeave': 'My leave',
    'leave.myLeaveHint': 'Your requests and balances for the current period.',
    'leave.request': 'Request leave',
    'leave.type': 'Leave type',
    'leave.typePlaceholder': 'Select a type…',
    'leave.from': 'From',
    'leave.to': 'To',
    'leave.halfDay': 'Half day',
    'leave.reason': 'Reason',
    'leave.reasonPlaceholder': 'Optional',
    'leave.submit': 'Submit',
    'leave.submitted': 'Request submitted.',
    'leave.submitFailed': 'Could not submit the request.',
    'leave.noRequests': 'No leave requests yet.',
    'leave.notLinked': 'This account is not linked to an employee record – contact HR.',
    'leave.cancelRequest': 'Cancel request',
    'leave.cancelConfirmTitle': 'Cancel leave request?',
    'leave.cancelConfirmBody': 'The request will be marked as canceled. This cannot be undone.',
    'leave.canceledToast': 'Request canceled.',
    'leave.cancelFailed': 'Could not cancel the request.',
    'leave.approvals': 'Approvals',
    'leave.approvalsHint': 'Requests waiting for your decision.',
    'leave.approve': 'Approve',
    'leave.reject': 'Reject',
    'leave.rejectTitle': 'Reject leave request',
    'leave.rejectComment': 'Comment',
    'leave.rejectCommentHint': 'A short comment is required so the person knows why.',
    'leave.approvedToast': 'Request approved.',
    'leave.rejectedToast': 'Request rejected.',
    'leave.decideFailed': 'Could not update the request.',
    'leave.statusPending': 'Pending',
    'leave.statusApproved': 'Approved',
    'leave.statusRejected': 'Rejected',
    'leave.statusCanceled': 'Canceled',
    'leave.of': 'of',
    'leave.daysShort': 'd',
    'leave.left': 'left',
    'leave.pendingHeld': 'pending',
    'leave.noQuota': 'no quota',
    'leave.thisRequest': 'This request',
    'leave.remaining': 'Left after it',
    'leave.notEnough': 'That is more than you have left. Shorten the range or pick another type.',
  },
  uk: {
    'leave.myLeave': 'Мої відпустки',
    'leave.myLeaveHint': 'Ваші запити та залишки за поточний період.',
    'leave.request': 'Подати запит',
    'leave.type': 'Тип відпустки',
    'leave.typePlaceholder': 'Оберіть тип…',
    'leave.from': 'З',
    'leave.to': 'По',
    'leave.halfDay': 'Пів дня',
    'leave.reason': 'Причина',
    'leave.reasonPlaceholder': 'Необовʼязково',
    'leave.submit': 'Надіслати',
    'leave.submitted': 'Заявку надіслано.',
    'leave.submitFailed': 'Не вдалося надіслати заявку.',
    'leave.noRequests': 'Поки немає запитів на відпустку.',
    'leave.notLinked': 'Обліковий запис не звʼязано з карткою співробітника – зверніться до HR.',
    'leave.cancelRequest': 'Скасувати запит',
    'leave.cancelConfirmTitle': 'Скасувати запит на відпустку?',
    'leave.cancelConfirmBody': 'Запит буде позначено як скасований. Цю дію не можна відмінити.',
    'leave.canceledToast': 'Запит скасовано.',
    'leave.cancelFailed': 'Не вдалося скасувати запит.',
    'leave.approvals': 'Погодження',
    'leave.approvalsHint': 'Запити, що чекають на ваше рішення.',
    'leave.approve': 'Погодити',
    'leave.reject': 'Відхилити',
    'leave.rejectTitle': 'Відхилити запит на відпустку',
    'leave.rejectComment': 'Коментар',
    'leave.rejectCommentHint': 'Короткий коментар обовʼязковий, щоб людина знала причину.',
    'leave.approvedToast': 'Заявку погоджено.',
    'leave.rejectedToast': 'Заявку відхилено.',
    'leave.decideFailed': 'Не вдалося оновити заявку.',
    'leave.statusPending': 'Очікує',
    'leave.statusApproved': 'Погоджено',
    'leave.statusRejected': 'Відхилено',
    'leave.statusCanceled': 'Скасовано',
    'leave.of': 'з',
    'leave.daysShort': 'дн.',
    'leave.left': 'лишилось',
    'leave.pendingHeld': 'на погодженні',
    'leave.noQuota': 'без квоти',
    'leave.thisRequest': 'Ця заявка',
    'leave.remaining': 'Залишок після неї',
    'leave.notEnough': 'Це більше, ніж у вас лишилось. Скоротіть період або оберіть інший тип.',
  },
});

interface LeaveRequest {
  id: string;
  employeeId?: string;
  leaveTypeId?: string;
  fromDate: string;
  toDate: string;
  halfDay?: boolean;
  reason?: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'canceled';
  approverId?: string | null;
  decidedAt?: string | null;
  decisionComment?: string | null;
  createdAt?: string;
  employeeName?: string | null;
  employeeAvatar?: string | null;
  leaveTypeName?: string | null;
}

const STATUS_META: Record<LeaveRequest['status'], { color: string; key: string }> = {
  pending: { color: '#f59e0b', key: 'leave.statusPending' },
  approved: { color: '#22c55e', key: 'leave.statusApproved' },
  rejected: { color: '#ef4444', key: 'leave.statusRejected' },
  canceled: { color: '#6b7280', key: 'leave.statusCanceled' },
};

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Working days a range costs – the shared calc the API charges with, so the
 * number on a row is the number that was deducted. Counting calendar days here
 * used to show a Mon–Fri week as 5 and a Fri–Mon one as 4, neither of which
 * matched the balance.
 */
function requestDays(r: Pick<LeaveRequest, 'fromDate' | 'toDate' | 'halfDay'>, holidays: ReadonlySet<string>): number | null {
  if (!r.fromDate || !r.toDate || r.toDate < r.fromDate) return null;
  return leaveDays(r.fromDate, r.toDate, r.halfDay ?? false, holidays);
}

function DateRange({ from, to }: { from: string; to: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
      <span className="tabular-nums">{fmtDate(from)}</span>
      <ChevronRight size={11} className="text-faint" />
      <span className="tabular-nums">{fmtDate(to)}</span>
    </span>
  );
}

function StatusBadge({ status }: { status: LeaveRequest['status'] }) {
  const t = useT();
  const meta = STATUS_META[status] ?? STATUS_META.pending;
  return <Badge color={meta.color}>{t(meta.key)}</Badge>;
}

export function MyLeaveCard() {
  const t = useT();
  const qc = useQueryClient();

  const types = useLeaveTypes();
  // 403 when the account has no employee record – surfaced as a hint, not retried.
  const mine = useQuery({
    queryKey: ['my-leave'],
    queryFn: () => api.get<{ data: LeaveRequest[] }>('/leave-requests').then((r) => r.data),
    retry: false,
  });
  const entitlements = useMyLeaveEntitlements();
  const holidays = useHolidaySet();
  const approvals = useQuery({
    queryKey: ['leave-approvals'],
    queryFn: () => api.get<{ data: LeaveRequest[] }>('/leave-requests?scope=approvals').then((r) => r.data),
    retry: false,
  });

  const typeName = useMemo(() => {
    const map = new Map<string, string>();
    for (const lt of types.data ?? []) map.set(lt.id, lt.name);
    return map;
  }, [types.data]);

  const entitlementOf = useMemo(() => {
    const map = new Map<string, LeaveEntitlement>();
    for (const e of entitlements.data ?? []) map.set(e.leaveTypeId, e);
    return map;
  }, [entitlements.data]);

  // Only types with something to draw down say anything useful here; the rest
  // ("no quota", or types that never touch a balance) would just be zeros.
  const tracked = (entitlements.data ?? []).filter((e) => e.tracked);

  /* ── request dialog ── */
  const emptyForm = { leaveTypeId: '', fromDate: '', toDate: '', halfDay: false, reason: '' };
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const selectedType = (types.data ?? []).find((lt) => lt.id === form.leaveTypeId);
  const selectedEntitlement = entitlementOf.get(form.leaveTypeId);
  const formDays = requestDays(form, holidays);
  // The same rule the API refuses with, so the form does not offer to send a
  // request the server is going to reject.
  const overBalance = selectedEntitlement != null && formDays != null
    && exceedsEntitlement(selectedEntitlement, formDays);

  const invalidateOwn = () => {
    void qc.invalidateQueries({ queryKey: ['my-leave'] });
    void qc.invalidateQueries({ queryKey: ['my-leave-entitlements'] });
  };

  const create = useMutation({
    mutationFn: () => api.post<{ id: string; days: number }>('/leave-requests', {
      leaveTypeId: form.leaveTypeId,
      fromDate: form.fromDate,
      toDate: form.toDate,
      ...(selectedType?.allowHalfDay && form.halfDay ? { halfDay: true } : {}),
      ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
    }),
    onSuccess: () => {
      setDialogOpen(false);
      setForm(emptyForm);
      invalidateOwn();
      toast(t('leave.submitted'));
    },
    // 422 carries the exact problem ("overlaps an existing request") – show it.
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('leave.submitFailed')),
  });

  /* ── cancel own request ── */
  const [cancelTarget, setCancelTarget] = useState<LeaveRequest | null>(null);
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/leave-requests/${id}/cancel`, {}),
    onSuccess: () => {
      setCancelTarget(null);
      invalidateOwn();
      toast(t('leave.canceledToast'));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('leave.cancelFailed')),
  });

  /* ── approve / reject ── */
  const [rejectTarget, setRejectTarget] = useState<LeaveRequest | null>(null);
  const [rejectComment, setRejectComment] = useState('');
  const decide = useMutation({
    mutationFn: ({ id, action, comment }: { id: string; action: 'approve' | 'reject'; comment?: string }) =>
      api.post(`/leave-requests/${id}/${action}`, comment ? { comment } : {}),
    onSuccess: (_r, vars) => {
      setRejectTarget(null);
      setRejectComment('');
      void qc.invalidateQueries({ queryKey: ['leave-approvals'] });
      invalidateOwn();
      toast(vars.action === 'approve' ? t('leave.approvedToast') : t('leave.rejectedToast'));
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('leave.decideFailed')),
  });

  const rows = mine.data ?? [];
  const approvalRows = approvals.data ?? [];
  const notLinked = mine.isError;

  return (
    <>
      <Card className="p-4">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <CalendarClock size={15} className="text-faint" /> {t('leave.myLeave')}
          </div>
          {!notLinked && (
            <Button size="sm" variant="outline" onClick={() => { setForm(emptyForm); setDialogOpen(true); }}>
              <Plus size={13} /> {t('leave.request')}
            </Button>
          )}
        </div>
        <p className="mb-3 text-xs text-muted-foreground">{t('leave.myLeaveHint')}</p>

        {!notLinked && tracked.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-x-5 gap-y-1.5 text-xs">
            {tracked.map((e) => (
              <span key={e.leaveTypeId} className="flex items-center gap-1.5">
                <span className="text-muted-foreground">{e.leaveTypeName}</span>
                <span className={cn('font-medium tabular-nums', e.remaining <= 0 && 'text-destructive')}>
                  {fmtNum(e.remaining)}
                  {' '}
                  <span className="font-normal text-faint">
                    {t('leave.of')} {fmtNum(e.allocated + e.carried)} {t('leave.daysShort')}
                  </span>
                </span>
                {/* Days already asked for are gone from the remainder – say so,
                    otherwise the number looks wrong next to a pending request. */}
                {e.pending > 0 && (
                  <span className="text-faint">· {fmtNum(e.pending)} {t('leave.pendingHeld')}</span>
                )}
              </span>
            ))}
          </div>
        )}

        {mine.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : notLinked ? (
          <p className="py-2 text-sm text-muted-foreground">{t('leave.notLinked')}</p>
        ) : rows.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{t('leave.noRequests')}</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            {rows.map((r, i) => {
              const days = requestDays(r, holidays);
              return (
                <div key={r.id} className={cn('flex items-center gap-3 px-3 py-2 text-[13px]', i > 0 && 'border-t border-border')}>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{r.leaveTypeName ?? typeName.get(r.leaveTypeId ?? '') ?? '–'}</div>
                    {r.decisionComment && <div className="truncate text-xs text-faint">{r.decisionComment}</div>}
                  </div>
                  <DateRange from={r.fromDate} to={r.toDate} />
                  {days != null && (
                    <span className="hidden shrink-0 text-xs text-faint tabular-nums sm:inline">{fmtNum(days)} {t('leave.daysShort')}</span>
                  )}
                  <StatusBadge status={r.status} />
                  {(r.status === 'pending' || r.status === 'approved') && (
                    <button
                      className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      title={t('leave.cancelRequest')}
                      onClick={() => setCancelTarget(r)}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {approvalRows.length > 0 && (
        <Card className="p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-medium">
            <Check size={15} className="text-faint" /> {t('leave.approvals')}
            <Badge className="bg-warning/15 text-warning">{approvalRows.length}</Badge>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">{t('leave.approvalsHint')}</p>
          <div className="overflow-hidden rounded-lg border border-border">
            {approvalRows.map((r, i) => (
              <div key={r.id} className={cn('flex items-center gap-3 px-3 py-2 text-[13px]', i > 0 && 'border-t border-border')}>
                <Avatar name={r.employeeName ?? '–'} src={r.employeeAvatar} size={24} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{r.employeeName ?? '–'}</div>
                  <div className="truncate text-xs text-faint">
                    {r.leaveTypeName ?? typeName.get(r.leaveTypeId ?? '') ?? '–'}
                    {r.reason ? ` · ${r.reason}` : ''}
                  </div>
                </div>
                <DateRange from={r.fromDate} to={r.toDate} />
                <span className="flex shrink-0 items-center gap-1">
                  <button
                    className="rounded-md p-1.5 text-success transition-colors hover:bg-success/10"
                    title={t('leave.approve')}
                    onClick={() => decide.mutate({ id: r.id, action: 'approve' })}
                    disabled={decide.isPending}
                  >
                    <Check size={14} />
                  </button>
                  <button
                    className="rounded-md p-1.5 text-destructive transition-colors hover:bg-destructive/10"
                    title={t('leave.reject')}
                    onClick={() => { setRejectComment(''); setRejectTarget(r); }}
                    disabled={decide.isPending}
                  >
                    <X size={14} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} title={t('leave.request')} width={420}>
        <form
          className="space-y-3 px-4 pb-4 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.leaveTypeId && form.fromDate && form.toDate && !overBalance && !create.isPending) create.mutate();
          }}
        >
          <label className="block space-y-1.5 text-xs text-muted-foreground">
            <span className="block">{t('leave.type')}</span>
            <Select
              value={form.leaveTypeId}
              onChange={(e) => setForm((f) => ({ ...f, leaveTypeId: e.target.value, halfDay: false }))}
              className="block w-full"
            >
              <option value="">{t('leave.typePlaceholder')}</option>
              {(types.data ?? []).map((lt) => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
            </Select>
            {/* What the picked type leaves, before any dates are chosen. */}
            {selectedEntitlement && (
              <span className="block text-faint">
                {selectedEntitlement.tracked
                  ? `${fmtNum(selectedEntitlement.remaining)} ${t('leave.daysShort')} ${t('leave.left')}`
                  : t('leave.noQuota')}
              </span>
            )}
          </label>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <span className="block">{t('leave.from')}</span>
              <DateField
                value={form.fromDate}
                onChange={(v) => setForm((f) => ({ ...f, fromDate: v ?? '', toDate: f.toDate && v && f.toDate < v ? v : f.toDate }))}
                clearable={false}
              />
            </div>
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <span className="block">{t('leave.to')}</span>
              <DateField
                value={form.toDate}
                onChange={(v) => setForm((f) => ({ ...f, toDate: v ?? '' }))}
                min={form.fromDate || null}
                clearable={false}
              />
            </div>
          </div>
          {selectedType?.allowHalfDay && (
            <label className="flex cursor-pointer items-center gap-2 text-[13px]">
              <Checkbox checked={form.halfDay} onChange={(v) => setForm((f) => ({ ...f, halfDay: v }))} />
              {t('leave.halfDay')}
            </label>
          )}
          <label className="block space-y-1.5 text-xs text-muted-foreground">
            <span className="block">{t('leave.reason')}</span>
            <Input
              value={form.reason}
              onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
              placeholder={t('leave.reasonPlaceholder')}
            />
          </label>
          {/* Working days the range costs and what it leaves, live – weekends and
              public holidays are not charged, so the count is rarely the span. */}
          {formDays != null && (
            <div className="rounded-lg border border-border px-3 py-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('leave.thisRequest')}</span>
                <span className="font-medium tabular-nums">{fmtNum(formDays)} {t('leave.daysShort')}</span>
              </div>
              {selectedEntitlement?.tracked && (
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-muted-foreground">{t('leave.remaining')}</span>
                  <span className={cn('font-medium tabular-nums', overBalance && 'text-destructive')}>
                    {fmtNum(selectedEntitlement.remaining - formDays)} {t('leave.daysShort')}
                  </span>
                </div>
              )}
              {overBalance && <p className="mt-1.5 text-destructive">{t('leave.notEnough')}</p>}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" size="sm" variant="ghost" onClick={() => setDialogOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" variant="primary" disabled={create.isPending || overBalance || !form.leaveTypeId || !form.fromDate || !form.toDate}>
              {create.isPending ? <Spinner /> : t('leave.submit')}
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog open={rejectTarget != null} onClose={() => setRejectTarget(null)} title={t('leave.rejectTitle')} width={400}>
        <form
          className="space-y-3 px-4 pb-4 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (rejectTarget && rejectComment.trim() && !decide.isPending) {
              decide.mutate({ id: rejectTarget.id, action: 'reject', comment: rejectComment.trim() });
            }
          }}
        >
          {rejectTarget && (
            <p className="text-[13px] text-muted-foreground">
              {rejectTarget.employeeName ?? '–'} · {fmtDate(rejectTarget.fromDate)} – {fmtDate(rejectTarget.toDate)}
            </p>
          )}
          <label className="block space-y-1.5 text-xs text-muted-foreground">
            <span className="block">{t('leave.rejectComment')}</span>
            <Input autoFocus value={rejectComment} onChange={(e) => setRejectComment(e.target.value)} />
            <span className="block text-faint">{t('leave.rejectCommentHint')}</span>
          </label>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" size="sm" variant="ghost" onClick={() => setRejectTarget(null)}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" variant="destructive" disabled={decide.isPending || !rejectComment.trim()}>
              {t('leave.reject')}
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={cancelTarget != null}
        onClose={() => setCancelTarget(null)}
        onConfirm={() => { if (cancelTarget) cancel.mutate(cancelTarget.id); }}
        title={t('leave.cancelConfirmTitle')}
        body={t('leave.cancelConfirmBody')}
        confirmLabel={t('leave.cancelRequest')}
        cancelLabel={t('common.cancel')}
        danger
        pending={cancel.isPending}
      />
    </>
  );
}
