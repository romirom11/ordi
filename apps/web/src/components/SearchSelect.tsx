/**
 * SearchSelect – the app-styled replacement for a native <select>.
 *
 * A DropdownMenu carrying the option list, with a search box once the list is
 * long enough to need one (or when `searchable` says so). The default trigger
 * looks like our form controls; rails pass their own chip via `trigger`.
 * `footer` takes extra menu entries (a "create new…" action, a clear row).
 *
 * Filtering matches `label` + `hint`; `render` only changes what a row looks
 * like (a status pill, an avatar row), so custom rows stay searchable.
 */
import { useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from './ui';
import { DropdownMenu, MenuLabel, MenuSeparator, useMenuClose } from './overlays';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: { 'select.noMatches': 'No matches' },
  uk: { 'select.noMatches': 'Нічого не знайдено' },
});

export interface SearchSelectOption {
  value: string;
  /** Plain-text label – what filtering matches and, without `render`, the row itself. */
  label: string;
  icon?: ReactNode;
  /** Faint right-aligned detail (a project key, a position, an email). */
  hint?: string;
  /** Custom row content, e.g. a status pill. Filtering still uses `label`. */
  render?: ReactNode;
  /** Shown but not pickable (e.g. an inactive template). */
  disabled?: boolean;
}

/** Options stop fitting in one glance around here – that is when search appears. */
const SEARCH_FROM = 8;

export function SearchSelect({
  value, options, onChange, placeholder, disabled, className, triggerClassName,
  width = 240, align = 'start', searchable, trigger, footer, menuLabel,
}: {
  value?: string | null;
  options: SearchSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Classes for the anchor container – pass `w-full` to fill a form row. */
  className?: string;
  /** Classes for the default trigger button. */
  triggerClassName?: string;
  width?: number;
  align?: 'start' | 'end';
  /** Force the search box on or off; by default it appears from 8 options. */
  searchable?: boolean;
  /** Custom trigger (e.g. a RailChip). The default looks like a form select. */
  trigger?: ReactNode;
  /** Extra menu entries below the list (e.g. a "create new…" MenuItem). */
  footer?: ReactNode;
  menuLabel?: string;
}) {
  const t = useT();
  const current = options.find((option) => option.value === (value ?? ''));

  const defaultTrigger = (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        'flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-transparent px-2.5 text-left text-[13px] outline-none',
        'transition-colors duration-150 hover:border-border-strong focus:border-primary/60 focus:ring-2 focus:ring-ring/25',
        'disabled:pointer-events-none disabled:opacity-50',
        triggerClassName,
      )}
    >
      {current?.icon && <span className="shrink-0 text-muted-foreground [&>svg]:block">{current.icon}</span>}
      <span className={cn('min-w-0 flex-1 truncate', !current && 'text-faint')}>
        {current ? (current.render ?? current.label) : (placeholder ?? t('common.select'))}
      </span>
      <ChevronDown size={13} className="shrink-0 text-faint" />
    </button>
  );

  return (
    <DropdownMenu
      align={align}
      width={width}
      disabled={disabled}
      className={className}
      trigger={trigger ?? defaultTrigger}
    >
      {menuLabel && <MenuLabel>{menuLabel}</MenuLabel>}
      <OptionList
        value={value ?? ''}
        options={options}
        onChange={onChange}
        withSearch={searchable ?? options.length >= SEARCH_FROM}
      />
      {footer && (
        <>
          <MenuSeparator />
          {footer}
        </>
      )}
    </DropdownMenu>
  );
}

/**
 * Menu body – its own component so the query resets with each open (the menu
 * unmounts when closed). The search input owns the keyboard: arrows move the
 * highlight, Enter picks it, Escape falls through to close the menu.
 */
function OptionList({ value, options, onChange, withSearch }: {
  value: string;
  options: SearchSelectOption[];
  onChange: (value: string) => void;
  withSearch: boolean;
}) {
  const t = useT();
  const close = useMenuClose();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? options.filter((option) => `${option.label} ${option.hint ?? ''}`.toLowerCase().includes(needle))
    : options;

  const pick = (next: string) => {
    close();
    if (next !== value) onChange(next);
  };
  const move = (delta: number) => {
    if (matches.length === 0) return;
    const next = (active + delta + matches.length) % matches.length;
    setActive(next);
    listRef.current?.children[next]?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <>
      {withSearch && (
        <div className="relative px-1 pb-1 pt-0.5">
          <Search size={13} className="pointer-events-none absolute left-3 top-[9px] text-faint" />
          <input
            autoFocus
            value={query}
            onChange={(event) => { setQuery(event.target.value); setActive(0); }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
              if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
              if (event.key === 'Enter') {
                event.preventDefault();
                const target = matches[active];
                if (target && !target.disabled) pick(target.value);
              }
            }}
            placeholder={`${t('common.search')}…`}
            className="h-7 w-full rounded-md border border-border bg-surface pl-6 pr-2 text-[13px] outline-none placeholder:text-faint focus:border-primary/60"
          />
        </div>
      )}
      <div ref={listRef} className="max-h-60 overflow-y-auto">
        {matches.map((option, index) => (
          <button
            key={option.value || '__empty__'}
            type="button"
            role="menuitemradio"
            aria-checked={option.value === value}
            disabled={option.disabled}
            onClick={() => pick(option.value)}
            onMouseEnter={() => setActive(index)}
            className={cn(
              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground transition-colors duration-150',
              index === active && 'bg-muted',
              option.disabled && 'pointer-events-none opacity-50',
            )}
          >
            {option.icon && <span className="shrink-0 text-muted-foreground [&>svg]:block">{option.icon}</span>}
            {/* Options wrap too – a picker whose choices cannot be read defeats itself. */}
            <span className="min-w-0 flex-1 break-words">{option.render ?? option.label}</span>
            {option.hint && <span className="shrink-0 text-[11px] text-faint">{option.hint}</span>}
            {option.value === value && <Check size={13} className="shrink-0 text-primary" />}
          </button>
        ))}
        {matches.length === 0 && <p className="px-2.5 py-2 text-xs text-faint">{t('select.noMatches')}</p>}
      </div>
    </>
  );
}
