/**
 * One place that decides how a date is written and parsed.
 *
 * The choice lives on the user record (profile → preferences) and is mirrored
 * to localStorage so plain functions can format without a hook – the same trick
 * appLocale() uses for language. 'auto' defers to the app language.
 *
 * Dates that mean a calendar day (due dates, invoice dates, leave) are stored
 * and exchanged as 'yyyy-MM-dd' and must never go through `new Date(iso)`
 * unqualified: that parses as UTC midnight and shifts a day in negative
 * offsets. Use parseDay/formatDay for those and keep timestamps separate.
 */
import { DATE_FORMATS, type DateFormat } from '@ordi/shared';

const STORAGE_KEY = 'ordi:dateFormat';

export { DATE_FORMATS, type DateFormat };

export function rememberDateFormat(format: string): void {
  try { localStorage.setItem(STORAGE_KEY, format); } catch { /* private mode */ }
}

export function currentDateFormat(): DateFormat {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw && (DATE_FORMATS as readonly string[]).includes(raw)) return raw as DateFormat;
  } catch { /* private mode */ }
  return 'auto';
}

/** BCP-47 locale matching the APP language (not the browser). */
export function appLocale(): string | undefined {
  try {
    const l = localStorage.getItem('ordi:locale');
    if (l === 'uk') return 'uk-UA';
    if (l === 'en') return 'en-US';
  } catch { /* private mode */ }
  return undefined;
}

/** Sunday-first only for locales that actually start there. */
export function weekStartsOn(): 0 | 1 {
  return appLocale() === 'en-US' ? 0 : 1;
}

/* ────────────────────────── Day values (yyyy-MM-dd) ────────────────────────── */

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Parse a stored value into a LOCAL date. Accepts 'yyyy-MM-dd' and full ISO. */
export function parseDay(value?: string | Date | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const m = DAY_RE.exec(value);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Serialize a local date back to 'yyyy-MM-dd' without a timezone round-trip. */
export function toDayValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function today(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function addMonths(date: Date, delta: number): Date {
  const d = new Date(date.getFullYear(), date.getMonth() + delta, 1);
  // Keep the day of month where the target month is long enough for it.
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(date.getDate(), last));
  return d;
}

export function addDays(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + delta);
}

/* ────────────────────────────── Formatting ────────────────────────────── */

const MONTHS_SHORT = new Map<string, string[]>();
function monthShort(date: Date): string {
  const loc = appLocale() ?? 'en';
  if (!MONTHS_SHORT.has(loc)) {
    const fmt = new Intl.DateTimeFormat(appLocale(), { month: 'short' });
    MONTHS_SHORT.set(loc, Array.from({ length: 12 }, (_, m) => fmt.format(new Date(2021, m, 1))));
  }
  return MONTHS_SHORT.get(loc)![date.getMonth()]!;
}

function applyPattern(date: Date, format: Exclude<DateFormat, 'auto'>): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const dd = pad(date.getDate());
  const MM = pad(date.getMonth() + 1);
  const yyyy = String(date.getFullYear());
  switch (format) {
    case 'dd.MM.yyyy': return `${dd}.${MM}.${yyyy}`;
    case 'dd/MM/yyyy': return `${dd}/${MM}/${yyyy}`;
    case 'MM/dd/yyyy': return `${MM}/${dd}/${yyyy}`;
    case 'yyyy-MM-dd': return `${yyyy}-${MM}-${dd}`;
    case 'd MMM yyyy': return `${date.getDate()} ${monthShort(date)} ${yyyy}`;
  }
}

/**
 * The user-facing rendering of a calendar day.
 *
 * `compact` drops the year when it is the current one – right for dense lists,
 * wrong for a field the user is about to edit. It only applies to 'auto';
 * an explicit pattern is written out in full, because that is what was asked for.
 */
export function formatDay(value?: string | Date | null, opts?: { compact?: boolean }): string {
  const date = parseDay(value);
  if (!date) return '';
  const format = currentDateFormat();
  if (format !== 'auto') return applyPattern(date, format);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(appLocale(), opts?.compact && sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Day plus clock, for timestamps rather than calendar days. */
export function formatDateTime(value?: string | Date | null): string {
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString(appLocale(), { hour: '2-digit', minute: '2-digit' });
  return `${formatDay(date)}, ${time}`;
}

/** Month heading in the calendar, e.g. "July 2026". */
export function formatMonthTitle(date: Date): string {
  return date.toLocaleDateString(appLocale(), { month: 'long', year: 'numeric' });
}

/** Short weekday initials, ordered from the locale's first day. */
export function weekdayLabels(): string[] {
  const start = weekStartsOn();
  const fmt = new Intl.DateTimeFormat(appLocale(), { weekday: 'short' });
  // 2021-08-01 was a Sunday, which makes the offset arithmetic obvious.
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2021, 7, 1 + ((start + i) % 7))));
}

/** What the chosen format looks like, for the picker in settings. */
export function formatSample(format: DateFormat): string {
  const sample = new Date(2026, 2, 9);
  return format === 'auto'
    ? sample.toLocaleDateString(appLocale(), { month: 'short', day: 'numeric', year: 'numeric' })
    : applyPattern(sample, format);
}

/**
 * Read back what the user typed. Accepts the active pattern first, then the
 * other separators and ISO, so pasting a date from elsewhere still lands.
 */
export function parseTyped(input: string): Date | null {
  const text = input.trim();
  if (!text) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return build(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const parts = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(text);
  if (parts) {
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    let year = Number(parts[3]);
    if (year < 100) year += 2000;
    // Month-first only where that is the active format and the value allows it.
    const monthFirst = currentDateFormat() === 'MM/dd/yyyy' || a > 12;
    return monthFirst && a <= 12 ? build(year, a, b) : build(year, b, a);
  }
  return null;
}

function build(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  // Rejects 31 February and friends, which JS would silently roll over.
  return d.getMonth() === month - 1 && d.getDate() === day ? d : null;
}
