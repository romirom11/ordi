/**
 * Leave balances per type – the same numbers on your own card and on somebody
 * else's employee page, so the two cannot drift.
 *
 * An employee card used to say nothing at all about leave unless it was your
 * own, which left HR with no way to answer "how many days does she have left?"
 * from the person's profile. The remaining-days strip therefore lives here and
 * is rendered by both `MyLeaveCard` (self-service) and `EmployeeLeaveBalances`
 * (someone else's card, gated on people.read like the API is).
 */
import { CalendarClock } from 'lucide-react';
import { extendDict, useT } from '../../lib/i18n';
import { useLeaveEntitlements, type LeaveEntitlement } from '../../lib/queries';
import { Card, Skeleton, cn } from '../ui';

extendDict({
  en: {
    'leave.of': 'of',
    'leave.daysShort': 'd',
    'leave.pendingHeld': 'pending',
    'leave.balances': 'Leave balance',
    'leave.balancesHint': 'Days left per type for the current period, with pending requests already held back.',
    'leave.noQuotaConfigured': 'No leave type has an annual quota yet – set one in Settings → Leave types.',
    'leave.balancesUnavailable': 'Leave balances are not available for this person.',
  },
  uk: {
    'leave.of': 'з',
    'leave.daysShort': 'дн.',
    'leave.pendingHeld': 'на погодженні',
    'leave.balances': 'Залишок відпустки',
    'leave.balancesHint': 'Скільки днів лишилось за кожним типом у поточному періоді; подані заявки вже враховані.',
    'leave.noQuotaConfigured': 'Жоден тип відсутності ще не має річної квоти – задайте її в Налаштуваннях → Типи відсутностей.',
    'leave.balancesUnavailable': 'Залишки відпустки для цієї людини недоступні.',
  },
});

/** Days render as whole numbers; a half day as one decimal, never as 0.5000001. */
export function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Only types with something allocated say anything useful – a type with no
 * quota, or one that never touches a balance, would just render zeros.
 */
export function trackedEntitlements(rows: LeaveEntitlement[] | undefined): LeaveEntitlement[] {
  return (rows ?? []).filter((e) => e.tracked);
}

/** One "Annual 16 of 20 d · 2 pending" line per type. */
export function LeaveBalanceStrip({ entitlements, className }: { entitlements: LeaveEntitlement[]; className?: string }) {
  const t = useT();
  return (
    <div className={cn('flex flex-wrap gap-x-5 gap-y-1.5 text-xs', className)}>
      {entitlements.map((e) => (
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
  );
}

/**
 * The strip, or the reason it is empty. Rendering nothing when no type has a
 * quota reads as a missing feature; saying where the quota is set does not.
 */
export function LeaveBalanceSummary({ entitlements, loading, failed }: {
  entitlements: LeaveEntitlement[] | undefined;
  loading?: boolean;
  failed?: boolean;
}) {
  const t = useT();
  if (loading) return <Skeleton className="h-5 w-64" />;
  if (failed) return <p className="text-sm text-muted-foreground">{t('leave.balancesUnavailable')}</p>;
  const tracked = trackedEntitlements(entitlements);
  if (!tracked.length) return <p className="text-xs text-muted-foreground">{t('leave.noQuotaConfigured')}</p>;
  return <LeaveBalanceStrip entitlements={tracked} />;
}

/** Somebody else's remaining days, on their employee card. */
export function EmployeeLeaveBalances({ employeeId }: { employeeId: string }) {
  const t = useT();
  const entitlements = useLeaveEntitlements(employeeId);
  return (
    <Card className="p-4">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium">
        <CalendarClock size={15} className="text-faint" /> {t('leave.balances')}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('leave.balancesHint')}</p>
      <LeaveBalanceSummary
        entitlements={entitlements.data}
        loading={entitlements.isLoading}
        failed={entitlements.isError}
      />
    </Card>
  );
}
