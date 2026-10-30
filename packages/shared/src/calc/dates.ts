/**
 * Calendar-month arithmetic for recurring schedules (UTC). Date#setUTCMonth
 * alone rolls over: Jan 31 + 1 month is Mar 3, and February never gets its
 * run. Here the day clamps to the last day of the target month instead.
 */
export function addMonthsUtc(d: Date, months: number): Date {
  const day = d.getUTCDate();
  const out = new Date(d.getTime());
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

/** `addMonthsUtc` for a YYYY-MM-DD date. */
export function addMonthsIso(date: string, months: number): string {
  return addMonthsUtc(new Date(date + 'T00:00:00Z'), months).toISOString().slice(0, 10);
}
