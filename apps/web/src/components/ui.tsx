import { clsx } from 'clsx';
import { forwardRef, Fragment, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes, type CSSProperties } from 'react';
import { ChevronRight } from 'lucide-react';
import { usePageTitle } from '../lib/tabs';
import { Link } from '../lib/router';

export function cn(...args: Parameters<typeof clsx>): string {
  return clsx(...args);
}

/* ───────────────────────── Buttons ───────────────────────── */

export type ButtonVariant = 'default' | 'primary' | 'outline' | 'ghost' | 'destructive';

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant; size?: 'xs' | 'sm' | 'md';
}>(function Button({ variant = 'default', size = 'md', className, ...props }, ref) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium',
        'transition-all duration-150 ease-smooth-out active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50',
        size === 'xs' ? 'h-6 px-2 text-xs' : size === 'sm' ? 'h-7 px-2.5 text-[13px]' : 'h-8 px-3 text-[13px]',
        (variant === 'default' || variant === 'primary') &&
          'bg-primary text-primary-foreground shadow-sm hover:brightness-110',
        variant === 'outline' && 'border border-border bg-card text-foreground hover:bg-muted hover:border-border-strong',
        variant === 'ghost' && 'text-muted-foreground hover:bg-muted hover:text-foreground',
        variant === 'destructive' && 'bg-destructive text-destructive-foreground hover:brightness-110',
        className,
      )}
      {...props}
    />
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { size?: 'sm' | 'md' }>(
  function IconButton({ className, size = 'md', ...props }, ref) {
    return (
      <button
        ref={ref}
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground',
          'transition-colors duration-150 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
          size === 'sm' ? 'h-6 w-6' : 'h-7 w-7',
          className,
        )}
        {...props}
      />
    );
  },
);

/* ───────────────────────── Form controls ───────────────────────── */

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-8 w-full rounded-md border border-input bg-transparent px-2.5 text-[13px] outline-none',
        'transition-colors duration-150 placeholder:text-faint',
        'hover:border-border-strong focus:border-primary/60 focus:ring-2 focus:ring-ring/25',
        className,
      )}
      {...props}
    />
  );
});

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'w-full rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] outline-none',
        'transition-colors duration-150 placeholder:text-faint',
        'hover:border-border-strong focus:border-primary/60 focus:ring-2 focus:ring-ring/25',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select
      className={cn(
        'h-8 cursor-pointer rounded-md border border-input bg-transparent px-2 text-[13px] outline-none',
        'transition-colors duration-150 hover:border-border-strong focus:border-primary/60 [&>option]:bg-elevated',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

export function Switch({ checked, onChange, disabled, label }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full transition-colors duration-150',
        checked ? 'bg-primary' : 'bg-border-strong',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      <span
        className="absolute left-[2px] h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform"
        style={{ transform: checked ? 'translateX(12px)' : 'translateX(0)', transitionDuration: 'var(--duration-medium)', transitionTimingFunction: 'var(--ease-bounce)' }}
      />
    </button>
  );
}

/** Animated checkbox – box fills, then the checkmark path draws (transitions.dev №25). */
export function Checkbox({ checked, onChange, disabled }: { checked: boolean; onChange?: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange?.(!checked); }}
      className={cn(
        'grid h-4 w-4 shrink-0 place-items-center rounded border transition-colors duration-150',
        checked ? 'border-primary bg-primary' : 'border-border-strong bg-transparent hover:border-primary/60',
        disabled && 'pointer-events-none opacity-50',
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
    </button>
  );
}

/* ───────────────────────── Layout / surfaces ───────────────────────── */

export function Card({ className, children, onClick }: { className?: string; children: ReactNode; onClick?: () => void }) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'rounded-lg border border-border bg-card text-card-foreground',
        onClick && 'cursor-pointer transition-colors duration-150 hover:border-border-strong',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Badge({ children, color, className }: { children: ReactNode; color?: string; className?: string }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium', !color && 'bg-muted text-muted-foreground', className)}
      style={color ? { backgroundColor: color + '26', color } : undefined}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border bg-muted px-1 font-sans text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}

/** Breadcrumb trail – 13px links separated by chevrons; last item is the current page. */
export interface BreadcrumbItem { label: ReactNode; to?: string; icon?: ReactNode }

export function Breadcrumbs({ items, className }: { items: BreadcrumbItem[]; className?: string }) {
  // A lone crumb for the current page only repeats the page title – render
  // trails, not echoes. A lone parent link is a real trail, so it stays.
  if (items.length === 0 || (items.length === 1 && !items[0]!.to)) return null;
  return (
    <nav aria-label="Breadcrumb" className={cn('flex min-w-0 items-center gap-1 text-[13px]', className)}>
      {items.map((it, i) => {
        const inner = (
          <>
            {it.icon && <span className="shrink-0 [&>svg]:block">{it.icon}</span>}
            <span className="truncate">{it.label}</span>
          </>
        );
        return (
          <Fragment key={i}>
            {i > 0 && <ChevronRight size={12} className="shrink-0 text-faint" aria-hidden />}
            {it.to ? (
              <Link
                to={it.to}
                className="flex min-w-0 items-center gap-1 text-muted-foreground transition-colors duration-150 hover:text-foreground"
              >
                {inner}
              </Link>
            ) : (
              <span className="flex min-w-0 items-center gap-1 font-medium text-foreground">{inner}</span>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}

/** The one standard page content container – pages wrap their body in this. */
export function PageBody({ children, width = 'default', className }: {
  children: ReactNode; width?: 'default' | 'wide' | 'full'; className?: string;
}) {
  return (
    <div
      className={cn(
        'w-full px-6 py-6',
        width === 'default' && 'mx-auto max-w-3xl',
        width === 'wide' && 'mx-auto max-w-5xl',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({ title, actions, subtitle, breadcrumbs }: {
  title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumbs?: ReactNode;
}) {
  // Name the active in-app tab after this page (no-op outside TabsProvider).
  usePageTitle(typeof title === 'string' ? title : undefined);
  return (
    <div className="flex min-h-[52px] items-center justify-between gap-3 border-b border-border px-6 py-2.5">
      <div className="min-w-0">
        {breadcrumbs && <div className="mb-0.5 text-xs">{breadcrumbs}</div>}
        <h1 className="truncate text-[15px] font-semibold leading-tight">{title}</h1>
        {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}

export function EmptyState({ title, hint, action, icon }: { title: string; hint?: string; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="anim-fade-in flex flex-col items-center justify-center gap-1.5 py-16 text-center">
      {icon && <div className="mb-2 grid h-11 w-11 place-items-center rounded-xl border border-border bg-muted/50 text-muted-foreground">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="max-w-sm text-[13px] text-muted-foreground">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <div className={cn('h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/40 border-t-foreground', className)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} />;
}

/* ───────────────────────── Avatars ───────────────────────── */

const AVATAR_HUES = [211, 262, 330, 16, 42, 152, 190, 280, 100];
function hueFor(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_HUES[Math.abs(h) % AVATAR_HUES.length]!;
}

export function Avatar({ name, src, size = 20, className }: { name?: string | null; src?: string | null; size?: number; className?: string }) {
  const initials = (name ?? '?')
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  const hue = hueFor(name ?? '?');
  const style: CSSProperties = { width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.42)) };
  if (src) {
    return <img src={src} alt={name ?? ''} style={style} className={cn('shrink-0 rounded-full object-cover', className)} />;
  }
  return (
    <span
      style={{ ...style, backgroundColor: `hsl(${hue} 45% 38%)`, color: 'white' }}
      className={cn('grid shrink-0 select-none place-items-center rounded-full font-semibold leading-none', className)}
      title={name ?? undefined}
    >
      {initials}
    </span>
  );
}

/** Overlapping avatar row with lift-on-hover (transitions.dev №11, simplified). */
export function AvatarGroup({ users, size = 20, max = 4 }: {
  users: { id: string; name?: string | null; avatar?: string | null }[]; size?: number; max?: number;
}) {
  const shown = users.slice(0, max);
  const rest = users.length - shown.length;
  return (
    <span className="flex items-center">
      {shown.map((u, i) => (
        <span
          key={u.id}
          className="rounded-full ring-2 ring-card transition-transform duration-[350ms] [transition-timing-function:var(--ease-bounce-strong)] hover:-translate-y-0.5 hover:scale-105 hover:duration-150 hover:[transition-timing-function:var(--ease-smooth-out)]"
          style={{ marginLeft: i === 0 ? 0 : -Math.round(size / 3), zIndex: i + 1 }}
        >
          <Avatar name={u.name} src={u.avatar} size={size} />
        </span>
      ))}
      {rest > 0 && (
        <span
          style={{ width: size, height: size, marginLeft: -Math.round(size / 3), fontSize: Math.max(8, Math.round(size * 0.38)) }}
          className="z-10 grid place-items-center rounded-full bg-muted font-medium text-muted-foreground ring-2 ring-card"
        >
          +{rest}
        </span>
      )}
    </span>
  );
}

/* ───────────────────────── Status / priority icons (Linear-style) ───────────────────────── */

export const CATEGORY_COLOR: Record<string, string> = {
  backlog: '#8a8f98',
  todo: '#8a8f98',
  in_progress: '#f2c94c',
  done: '#5e6ad2',
  canceled: '#8a8f98',
};

/** Linear-style status circle: dashed=backlog, ring=todo, pie=in progress, check=done, ×=canceled. */
export function StatusIcon({ category, color, size = 14, className }: { category?: string; color?: string; size?: number; className?: string }) {
  const c = color || CATEGORY_COLOR[category ?? 'todo'] || '#8a8f98';
  const common = { width: size, height: size, viewBox: '0 0 14 14', className: cn('shrink-0', className) };
  switch (category) {
    case 'backlog':
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.6" strokeDasharray="1.8 2.1" strokeLinecap="round" />
        </svg>
      );
    case 'in_progress':
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.6" />
          <path d="M7 3.8 A3.2 3.2 0 0 1 7 10.2 Z" fill={c} />
        </svg>
      );
    case 'done':
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r="6" fill={c} />
          <path d="M4.3 7.2 L6.2 9 L9.8 5.2" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'canceled':
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r="6" fill={c} />
          <path d="M5 5 L9 9 M9 5 L5 9" stroke="white" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      );
    default: // todo
      return (
        <svg {...common} aria-hidden>
          <circle cx="7" cy="7" r="5.5" fill="none" stroke={c} strokeWidth="1.6" />
        </svg>
      );
  }
}

export const PRIORITY_META: Record<string, { label: string; color: string }> = {
  urgent: { label: 'Urgent', color: '#fc7840' },
  high: { label: 'High', color: '#8a8f98' },
  medium: { label: 'Medium', color: '#8a8f98' },
  low: { label: 'Low', color: '#8a8f98' },
  none: { label: 'No priority', color: '#8a8f98' },
};

/** Linear-style priority glyph: signal bars, orange “!” square for urgent, dash for none. */
export function PriorityIcon({ priority = 'none', size = 14, className }: { priority?: string; size?: number; className?: string }) {
  const common = { width: size, height: size, viewBox: '0 0 14 14', className: cn('shrink-0', className) };
  const gray = '#8a8f98';
  if (priority === 'urgent') {
    return (
      <svg {...common} aria-hidden>
        <rect x="1" y="1" width="12" height="12" rx="3" fill="#fc7840" />
        <path d="M7 3.6 V7.8 M7 9.8 v0.4" stroke="white" strokeWidth="1.7" strokeLinecap="round" />
      </svg>
    );
  }
  if (priority === 'none') {
    return (
      <svg {...common} aria-hidden>
        <path d="M2.5 7 h2 M6 7 h2 M9.5 7 h2" stroke={gray} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  const active = priority === 'low' ? 1 : priority === 'medium' ? 2 : 3;
  return (
    <svg {...common} aria-hidden>
      <rect x="1.5" y="8" width="2.6" height="4" rx="1" fill={active >= 1 ? gray : 'none'} stroke={gray} strokeWidth={active >= 1 ? 0 : 1} opacity={active >= 1 ? 1 : 0.4} />
      <rect x="5.7" y="5.5" width="2.6" height="6.5" rx="1" fill={active >= 2 ? gray : 'none'} stroke={gray} strokeWidth={active >= 2 ? 0 : 1} opacity={active >= 2 ? 1 : 0.4} />
      <rect x="9.9" y="2.5" width="2.6" height="9.5" rx="1" fill={active >= 3 ? gray : 'none'} stroke={gray} strokeWidth={active >= 3 ? 0 : 1} opacity={active >= 3 ? 1 : 0.4} />
    </svg>
  );
}

/* ───────────────────────── Progress ───────────────────────── */

export function ProgressBar({ value, className, color }: { value: number; className?: string; color?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className={cn('h-1.5 overflow-hidden rounded-full bg-muted', className)}>
      <div
        className="h-full origin-left rounded-full transition-transform duration-500 ease-smooth-out"
        style={{ width: '100%', transform: `scaleX(${pct / 100})`, backgroundColor: color ?? 'hsl(var(--primary))' }}
      />
    </div>
  );
}

/** Small circular progress (Linear-style project/cycle donut). */
export function ProgressRing({ value, size = 16, stroke = 2.5, color, className }: {
  value: number; size?: number; stroke?: number; color?: string; className?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cn('shrink-0 -rotate-90', className)} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--border-strong))" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={color ?? 'hsl(var(--primary))'} strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={circ} strokeDashoffset={circ * (1 - pct / 100)}
        style={{ transition: 'stroke-dashoffset var(--duration-very-slow) var(--ease-smooth-out)' }}
      />
    </svg>
  );
}

/* ───────────────────────── Tooltip (CSS, delayed in / instant out) ───────────────────────── */

export function Tooltip({ label, children, side = 'top' }: { label: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'right' }) {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 whitespace-nowrap rounded-md bg-elevated px-2 py-1 text-xs text-foreground shadow-pop',
          'opacity-0 transition-opacity duration-150 ease-out group-hover/tt:opacity-100 group-hover/tt:delay-[80ms]',
          side === 'top' && 'bottom-full left-1/2 mb-1.5 -translate-x-1/2',
          side === 'bottom' && 'top-full left-1/2 mt-1.5 -translate-x-1/2',
          side === 'right' && 'left-full top-1/2 ml-1.5 -translate-y-1/2',
        )}
      >
        {label}
      </span>
    </span>
  );
}

/* ───────────────────────── Tabs (sliding underline) ───────────────────────── */

export function Tabs<T extends string>({ tabs, value, onChange, className }: {
  tabs: { key: T; label: ReactNode; icon?: ReactNode }[]; value: T; onChange: (t: T) => void; className?: string;
}) {
  return (
    <nav className={cn('flex items-center gap-0.5', className)} role="tablist">
      {tabs.map((tb) => (
        <button
          key={tb.key}
          role="tab"
          aria-selected={value === tb.key}
          onClick={() => onChange(tb.key)}
          className={cn(
            'relative flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-150',
            value === tb.key ? 'font-medium text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          {tb.icon} {tb.label}
          {value === tb.key && (
            <span className="absolute inset-x-2 -bottom-[7px] h-0.5 rounded-full bg-primary" />
          )}
        </button>
      ))}
    </nav>
  );
}

/** Segmented control with sliding pill (transitions.dev №16, CSS-grid variant). */
export function SegmentedControl<T extends string>({ options, value, onChange, className }: {
  options: { key: T; label: ReactNode; icon?: ReactNode; title?: string }[]; value: T; onChange: (v: T) => void; className?: string;
}) {
  const idx = Math.max(0, options.findIndex((o) => o.key === value));
  return (
    <div
      className={cn('relative inline-grid select-none items-stretch rounded-md border border-border bg-muted/60 p-0.5', className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <span
        aria-hidden
        className="absolute bottom-0.5 top-0.5 rounded-[5px] bg-card shadow-sm ring-1 ring-border transition-transform duration-[250ms] ease-smooth-out"
        style={{ width: `calc((100% - 4px) / ${options.length})`, transform: `translateX(calc(${idx} * 100% + 2px))` }}
      />
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          title={o.title}
          onClick={() => onChange(o.key)}
          className={cn(
            'relative z-10 flex items-center justify-center gap-1 rounded px-2 py-1 text-xs transition-colors duration-150',
            value === o.key ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {o.icon} {o.label}
        </button>
      ))}
    </div>
  );
}

/* ───────────────────────── Formatters ───────────────────────── */

/** BCP-47 locale matching the APP language (not the browser), for date/number formatting. */
export function appLocale(): string | undefined {
  try {
    const l = localStorage.getItem('ordi:locale');
    if (l === 'uk') return 'uk-UA';
    if (l === 'en') return 'en-US';
  } catch { /* SSR / private mode */ }
  return undefined;
}

const money = new Map<string, Intl.NumberFormat>();
export function fmtMoney(amount: number | string, currency = 'USD'): string {
  const loc = appLocale();
  const key = `${loc ?? ''}:${currency}`;
  if (!money.has(key)) money.set(key, new Intl.NumberFormat(loc, { style: 'currency', currency }));
  return money.get(key)!.format(Number(amount));
}

export function fmtDate(d?: string | null): string {
  if (!d) return '–';
  const date = new Date(d);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(appLocale(), sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtRelative(d?: string | null): string {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d`;
  return fmtDate(d);
}
