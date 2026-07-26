/**
 * The one calendar in the app.
 *
 * `Calendar` is the grid itself; `DateField` is the grid behind a text input
 * that also accepts typing. Everything that used to render a native
 * <input type="date"> goes through here, so the popup looks the same, follows
 * the user's date format, and starts the week where their locale does.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import {
  addDays, addMonths, formatDay, formatMonthTitle, isSameDay, parseDay, parseTyped,
  toDayValue, today, weekdayLabels, weekStartsOn,
} from '../lib/dates';
import { useT, extendDict } from '../lib/i18n';
import { cn } from './ui';

extendDict({
  en: {
    'date.today': 'Today',
    'date.clear': 'Clear',
    'date.prevMonth': 'Previous month',
    'date.nextMonth': 'Next month',
    'date.open': 'Open calendar',
    'date.placeholder': 'Pick a date',
  },
  uk: {
    'date.today': 'Сьогодні',
    'date.clear': 'Очистити',
    'date.prevMonth': 'Попередній місяць',
    'date.nextMonth': 'Наступний місяць',
    'date.open': 'Відкрити календар',
    'date.placeholder': 'Оберіть дату',
  },
});

/** The 42 cells of a month grid, padded with the neighbouring months. */
function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() - weekStartsOn() + 7) % 7;
  const start = addDays(first, -offset);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}

export function Calendar({ value, onSelect, min, max, footer }: {
  value?: string | Date | null;
  onSelect: (day: string) => void;
  /** Inclusive bounds, as 'yyyy-MM-dd'. */
  min?: string | null;
  max?: string | null;
  footer?: ReactNode;
}) {
  const t = useT();
  const selected = parseDay(value);
  const now = today();
  const [cursor, setCursor] = useState<Date>(() => selected ?? now);
  const [focused, setFocused] = useState<Date>(() => selected ?? now);
  const gridRef = useRef<HTMLDivElement>(null);

  // Reopening on a different value should land on that value's month.
  const key = selected ? toDayValue(selected) : '';
  useEffect(() => {
    if (selected) { setCursor(selected); setFocused(selected); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const days = useMemo(() => monthGrid(cursor), [cursor]);
  const labels = useMemo(() => weekdayLabels(), []);
  const minDay = min ?? null;
  const maxDay = max ?? null;

  const disabled = (d: Date): boolean => {
    const v = toDayValue(d);
    return (!!minDay && v < minDay) || (!!maxDay && v > maxDay);
  };

  const move = (next: Date) => {
    setFocused(next);
    if (next.getMonth() !== cursor.getMonth() || next.getFullYear() !== cursor.getFullYear()) setCursor(next);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in step) { e.preventDefault(); move(addDays(focused, step[e.key]!)); return; }
    if (e.key === 'PageUp') { e.preventDefault(); move(addMonths(focused, -1)); return; }
    if (e.key === 'PageDown') { e.preventDefault(); move(addMonths(focused, 1)); return; }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!disabled(focused)) onSelect(toDayValue(focused));
    }
  };

  // Keep the roving tabindex on the focused cell while the grid has focus.
  useEffect(() => {
    const el = gridRef.current;
    if (!el || !el.contains(document.activeElement)) return;
    el.querySelector<HTMLElement>('[data-focused="true"]')?.focus();
  }, [focused]);

  return (
    <div className="w-[248px] select-none p-2">
      <div className="mb-1.5 flex items-center gap-1">
        <button
          type="button" aria-label={t('date.prevMonth')} onClick={() => setCursor(addMonths(cursor, -1))}
          className="grid h-6 w-6 place-items-center rounded-md text-faint transition-colors duration-150 hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft size={15} />
        </button>
        <span className="flex-1 text-center text-[13px] font-medium first-letter:uppercase">{formatMonthTitle(cursor)}</span>
        <button
          type="button" aria-label={t('date.nextMonth')} onClick={() => setCursor(addMonths(cursor, 1))}
          className="grid h-6 w-6 place-items-center rounded-md text-faint transition-colors duration-150 hover:bg-muted hover:text-foreground"
        >
          <ChevronRight size={15} />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5 pb-1">
        {labels.map((l, i) => (
          <span key={i} className="grid h-6 place-items-center text-[10px] font-medium uppercase tracking-wide text-faint">
            {l.slice(0, 2)}
          </span>
        ))}
      </div>

      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-to-interactive-role */}
      <div ref={gridRef} role="grid" className="grid grid-cols-7 gap-0.5" onKeyDown={onKeyDown}>
        {days.map((d) => {
          const outside = d.getMonth() !== cursor.getMonth();
          const isSelected = !!selected && isSameDay(d, selected);
          const isToday = isSameDay(d, now);
          const isFocused = isSameDay(d, focused);
          const off = disabled(d);
          return (
            <button
              key={toDayValue(d)}
              type="button"
              role="gridcell"
              data-focused={isFocused}
              aria-selected={isSelected}
              tabIndex={isFocused ? 0 : -1}
              disabled={off}
              onClick={() => onSelect(toDayValue(d))}
              onFocus={() => setFocused(d)}
              className={cn(
                'grid h-8 place-items-center rounded-md text-[13px] tabular-nums transition-colors duration-150',
                'outline-none focus-visible:ring-1 focus-visible:ring-primary',
                off && 'cursor-not-allowed text-faint/40',
                !off && !isSelected && 'hover:bg-muted',
                outside && !isSelected ? 'text-faint' : 'text-foreground',
                isToday && !isSelected && 'font-semibold text-primary',
                isSelected && 'bg-primary font-medium text-primary-foreground hover:bg-primary',
              )}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>

      {footer}
    </div>
  );
}

export function DateField({ value, onChange, placeholder, disabled, clearable = true, min, max, size = 'md', className, id }: {
  /** 'yyyy-MM-dd', or null/'' for empty. */
  value?: string | null;
  onChange: (value: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
  clearable?: boolean;
  min?: string | null;
  max?: string | null;
  /** 'sm' fits dense table rows; 'md' matches the standard Input height. */
  size?: 'sm' | 'md';
  className?: string;
  id?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({});

  const shown = draft ?? formatDay(value);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const h = popRef.current?.offsetHeight ?? 300;
    const w = popRef.current?.offsetWidth ?? 264;
    const below = r.bottom + 6;
    const top = below + h > window.innerHeight - 8 ? Math.max(8, r.top - h - 6) : below;
    setPos({ top, left: Math.min(Math.max(8, r.left), window.innerWidth - w - 8) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node) || anchorRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  /** Typing is a convenience, not the contract: unparseable text reverts. */
  const commitTyped = () => {
    if (draft === null) return;
    const text = draft.trim();
    setDraft(null);
    if (!text) { if (value) onChange(null); return; }
    const parsed = parseTyped(text);
    if (parsed) onChange(toDayValue(parsed));
  };

  return (
    <>
      <div
        ref={anchorRef}
        className={cn(
          'flex items-center gap-1.5 rounded-md border border-border bg-surface transition-colors duration-150',
          size === 'sm' ? 'h-7 gap-1 px-1.5 text-xs' : 'h-9 px-2.5 text-[13px]',
          'focus-within:border-primary/60',
          disabled ? 'cursor-not-allowed opacity-60' : 'hover:border-border-strong',
          className,
        )}
      >
        <CalendarDays size={size === 'sm' ? 12 : 14} className="shrink-0 text-faint" />
        <input
          id={id}
          value={shown}
          disabled={disabled}
          placeholder={placeholder ?? t('date.placeholder')}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => { if (!disabled) setOpen(true); }}
          onBlur={commitTyped}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitTyped(); setOpen(false); }
            if (e.key === 'ArrowDown' && !open) setOpen(true);
          }}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint disabled:cursor-not-allowed"
        />
        {clearable && value && !disabled && (
          <button
            type="button"
            aria-label={t('date.clear')}
            onClick={() => { setDraft(null); onChange(null); }}
            className="grid h-5 w-5 shrink-0 place-items-center rounded text-faint transition-colors duration-150 hover:bg-muted hover:text-foreground"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {open && !disabled && createPortal(
        <div
          ref={popRef}
          className="fixed z-[70] overflow-hidden rounded-lg border border-border bg-elevated shadow-pop"
          style={{ ...pos, animation: 'dropdown-in var(--duration-fast) var(--ease-smooth-out) both' }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <Calendar
            value={value}
            min={min}
            max={max}
            onSelect={(day) => { setDraft(null); onChange(day); setOpen(false); }}
            footer={(
              <div className="mt-1.5 flex items-center justify-between border-t border-border pt-1.5">
                <button
                  type="button"
                  onClick={() => { setDraft(null); onChange(toDayValue(today())); setOpen(false); }}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                >
                  {t('date.today')}
                </button>
                {clearable && value && (
                  <button
                    type="button"
                    onClick={() => { setDraft(null); onChange(null); setOpen(false); }}
                    className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
                  >
                    {t('date.clear')}
                  </button>
                )}
              </div>
            )}
          />
        </div>,
        document.body,
      )}
    </>
  );
}
