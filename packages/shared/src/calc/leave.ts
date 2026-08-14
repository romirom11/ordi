/** Leave balance math (PRD §12.2): accrual, carry-forward, deduction/restore. */

export interface LeaveBalance {
  allocated: number;
  used: number;
  carried: number;
}

export function availableBalance(b: LeaveBalance): number {
  return round2(b.allocated + b.carried - b.used);
}

/**
 * Working-day count for a leave request (half-day supported). `holidays` is a
 * set of 'YYYY-MM-DD' public-holiday dates – a holiday inside the range must
 * not charge a leave day any more than a weekend does.
 */
export function leaveDays(fromDate: string, toDate: string, halfDay: boolean, holidays?: ReadonlySet<string>): number {
  const from = new Date(fromDate.slice(0, 10) + 'T00:00:00Z');
  const to = new Date(toDate.slice(0, 10) + 'T00:00:00Z');
  if (to < from) return 0;
  if (halfDay) return 0.5;
  let days = 0;
  for (let d = new Date(from); d <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue; // weekends
    if (holidays?.has(d.toISOString().slice(0, 10))) continue;
    days += 1;
  }
  return days;
}

/** Carry-forward at period rollover with a cap and (optional) expiry policy. */
export function carryForward(remaining: number, limit: number): number {
  return round2(Math.max(0, Math.min(remaining, limit)));
}

/** Two date ranges overlap (used to block conflicting requests). */
export function rangesOverlap(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom.slice(0, 10) <= bTo.slice(0, 10) && bFrom.slice(0, 10) <= aTo.slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
