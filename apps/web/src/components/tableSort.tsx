/**
 * Column sorting for client-side tables: the hook holding the sort state, the
 * comparator, and the clickable header. Shared by the CRM tables, the finance
 * lists and the time reports so every table sorts the same way.
 */
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { cn } from './ui';

export type SortDir = 'asc' | 'desc';
export interface SortState<K extends string = string> { key: K; dir: SortDir }

/**
 * First click ascending, second descending, third back to the server's
 * default order. Null when unsorted.
 */
export function useTableSort<K extends string>() {
  const [sort, setSort] = useState<SortState<K> | null>(null);
  const toggle = (key: K) => setSort((prev) => {
    if (prev?.key !== key) return { key, dir: 'asc' };
    return prev.dir === 'asc' ? { key, dir: 'desc' } : null;
  });
  return { sort, toggle };
}

/**
 * Sorts rows by a per-key value getter. Empty values sink to the bottom in
 * both directions – "no score" is not a very low score.
 */
export function sortRows<T, K extends string>(
  rows: T[],
  sort: SortState<K> | null,
  value: (row: T, key: K) => string | number | null | undefined,
): T[] {
  if (!sort) return rows;
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = value(a, sort.key);
    const vb = value(b, sort.key);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;
    return dir * (typeof va === 'number' && typeof vb === 'number'
      ? va - vb
      : String(va).localeCompare(String(vb)));
  });
}

/** A ranking map so statuses sort in lifecycle order, not alphabetically. */
export function useStatusRank(statuses: readonly string[]): Map<string, number> {
  return useMemo(() => new Map(statuses.map((status, index) => [status, index])), [statuses]);
}

/** Clickable column header: shows the sort direction, hints on hover. */
export function SortHeader<K extends string>({ label, sortKey, sort, onToggle, className }: {
  label: string;
  sortKey: K;
  sort: SortState<K> | null;
  onToggle: (key: K) => void;
  className?: string;
}) {
  const active = sort?.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort!.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <button
      type="button"
      onClick={() => onToggle(sortKey)}
      className={cn(
        'group/sort flex min-w-0 items-center gap-1 text-left font-semibold uppercase tracking-wide transition-colors duration-150 hover:text-foreground',
        active ? 'text-foreground' : 'text-faint',
        className,
      )}
    >
      <span className="truncate">{label}</span>
      <Icon size={11} className={cn('shrink-0', !active && 'opacity-0 transition-opacity duration-150 group-hover/sort:opacity-60')} />
    </button>
  );
}
