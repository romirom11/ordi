/**
 * Multi-select for list views: a selection hook, a row checkbox that never
 * triggers the row's own click, and the floating action bar that appears while
 * something is selected. Shared by the CRM client table and project task lists.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from './ui';
import { extendDict, useT } from '../lib/i18n';

extendDict({
  en: {
    'bulk.selected': '{n} selected',
    'bulk.clear': 'Clear selection',
    'bulk.selectAll': 'Select all',
    'bulk.applied': 'Updated {n}',
    'bulk.partial': 'Updated {ok}, failed {failed}',
    'bulk.failed': 'Nothing could be updated',
  },
  uk: {
    'bulk.selected': 'Вибрано: {n}',
    'bulk.clear': 'Зняти виділення',
    'bulk.selectAll': 'Вибрати все',
    'bulk.applied': 'Оновлено: {n}',
    'bulk.partial': 'Оновлено: {ok}, не вдалося: {failed}',
    'bulk.failed': 'Не вдалося оновити жодного запису',
  },
});

export interface Selection<T> {
  ids: string[];
  size: number;
  has: (id: string) => boolean;
  /** Plain click toggles one row; shift-click extends from the last one touched. */
  toggle: (id: string, shiftKey?: boolean) => void;
  clear: () => void;
  toggleAll: () => void;
  allSelected: boolean;
  items: T[];
}

/**
 * Selection over the currently rendered rows. Ids that disappear from `rows`
 * (filtered out, deleted, refetched away) drop out of the selection, so a bulk
 * action can never hit a row the user no longer sees.
 */
export function useSelection<T extends { id: string }>(rows: T[]): Selection<T> {
  const [raw, setRaw] = useState<ReadonlySet<string>>(() => new Set());
  const lastTouched = useRef<string | null>(null);

  const present = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const ids = useMemo(() => rows.filter((r) => raw.has(r.id)).map((r) => r.id), [rows, raw]);

  // The anchor moves here, never inside the updater: StrictMode invokes updaters
  // twice, and a ref written in there would make the second pass see itself as
  // the anchor and silently degrade every range click into a single toggle.
  const toggle = useCallback((id: string, shiftKey = false) => {
    const anchor = lastTouched.current;
    lastTouched.current = id;
    setRaw((prev) => {
      const next = new Set([...prev].filter((x) => present.has(x)));
      if (shiftKey && anchor && anchor !== id) {
        const order = rows.map((r) => r.id);
        const from = order.indexOf(anchor);
        const to = order.indexOf(id);
        if (from !== -1 && to !== -1) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          const selecting = !next.has(id);
          for (const rid of order.slice(lo, hi + 1)) {
            if (selecting) next.add(rid);
            else next.delete(rid);
          }
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [present, rows]);

  const clear = useCallback(() => { lastTouched.current = null; setRaw(new Set()); }, []);

  const allSelected = rows.length > 0 && ids.length === rows.length;
  const toggleAll = useCallback(() => {
    setRaw((prev) => (rows.length > 0 && rows.every((r) => prev.has(r.id)) ? new Set() : new Set(rows.map((r) => r.id))));
  }, [rows]);

  const selectedSet = useMemo(() => new Set(ids), [ids]);
  return {
    ids,
    size: ids.length,
    has: (id: string) => selectedSet.has(id),
    toggle,
    clear,
    toggleAll,
    allSelected,
    items: rows.filter((r) => selectedSet.has(r.id)),
  };
}

/**
 * Checkbox for a clickable row. Deliberately not the shared `Checkbox`: that one
 * is a <button> (illegal inside the task list's own row <button>) and swallows
 * the click event, which hides the shift key that range-select needs. Handled in
 * the capture phase so the row underneath never opens.
 */
export function RowCheckbox({ checked, onToggle, className, label }: {
  checked: boolean; onToggle: (shiftKey: boolean) => void; className?: string; label?: string;
}) {
  const fire = (e: { stopPropagation: () => void; preventDefault: () => void; shiftKey: boolean }) => {
    e.stopPropagation();
    e.preventDefault();
    onToggle(e.shiftKey);
  };
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      tabIndex={0}
      onClickCapture={fire}
      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') fire(e); }}
      className={cn(
        'grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded border transition-colors duration-150',
        checked ? 'border-primary bg-primary' : 'border-border-strong bg-transparent hover:border-primary/60',
        className,
      )}
    >
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path
          d="M2.5 6.5L5 9L9.5 3.5"
          stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          style={{
            strokeDasharray: 12,
            strokeDashoffset: checked ? 0 : 12,
            transition: 'stroke-dashoffset var(--duration-medium) var(--ease-smooth-out)',
          }}
        />
      </svg>
    </span>
  );
}

/** Floating bar shown while rows are selected; actions are supplied by the caller. */
export function BulkBar({ count, onClear, children }: { count: number; onClear: () => void; children: ReactNode }) {
  const t = useT();
  if (count === 0) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-30 flex justify-center px-4">
      <div className="anim-pop-in pointer-events-auto flex max-w-full items-center gap-2 overflow-x-auto rounded-lg border border-border bg-elevated px-2.5 py-2 shadow-pop">
        <span className="shrink-0 px-1 text-[13px] font-medium tabular-nums">
          {t('bulk.selected').replace('{n}', String(count))}
        </span>
        <span className="h-4 w-px shrink-0 bg-border" />
        {children}
        <span className="h-4 w-px shrink-0 bg-border" />
        <button
          onClick={onClear}
          aria-label={t('bulk.clear')}
          className="grid h-6 w-6 shrink-0 place-items-center rounded text-faint transition-colors duration-150 hover:bg-muted hover:text-foreground"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

/**
 * Runs one request per selected row and reports how it went. Bulk endpoints do
 * not exist server-side, so partial failure is normal and must be visible
 * (a stale version conflict fails one row, not the batch).
 */
export async function runBulk<T>(items: T[], fn: (item: T) => Promise<unknown>): Promise<{ ok: number; failed: number }> {
  const results = await Promise.allSettled(items.map(fn));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  return { ok, failed: results.length - ok };
}

/** Toast message for a runBulk result, so every caller reports failures the same way. */
export function bulkMessage(t: (k: string, fallback?: string) => string, r: { ok: number; failed: number }): { text: string; error: boolean } {
  if (r.failed === 0) return { text: t('bulk.applied').replace('{n}', String(r.ok)), error: false };
  if (r.ok === 0) return { text: t('bulk.failed'), error: true };
  return { text: t('bulk.partial').replace('{ok}', String(r.ok)).replace('{failed}', String(r.failed)), error: true };
}
