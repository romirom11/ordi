import { useState, type CSSProperties, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../ui';

/**
 * A staggered list row that self-cleans: it plays `.row-enter` on mount, then
 * drops the class once the animation ends. This matters because the shared
 * keyframe settles on `filter: blur(0)`, and a lingering filter promotes the
 * row to its own composited layer that can visually paint over portalled
 * dialogs/menus. Clearing it after entry keeps the motion but avoids the glitch.
 */
export function AnimatedRow({ index = 0, className, style, children, onClick }: {
  index?: number; className?: string; style?: CSSProperties; children: ReactNode; onClick?: () => void;
}) {
  const [done, setDone] = useState(false);
  return (
    <div
      onClick={onClick}
      onAnimationEnd={() => setDone(true)}
      className={cn(!done && 'row-enter', className)}
      style={done ? style : { ...style, ['--i' as string]: Math.min(index, 10) }}
    >
      {children}
    </div>
  );
}

/**
 * Shared building blocks for the settings area – a Linear-style slim layout:
 * section heading + one-line description, then borderless rows separated by
 * hairlines instead of heavy bordered boxes.
 */

export function SectionHead({ title, desc, actions }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-base font-semibold leading-tight">{title}</h2>
        {desc && <p className="mt-0.5 text-[13px] text-muted-foreground">{desc}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A labelled setting row. On wide layouts label sits left, control right. */
export function SettingRow({ label, hint, children, className }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-4 border-b border-border py-3.5 last:border-0', className)}>
      {(label || hint) && (
        <div className="min-w-0">
          {label && <div className="text-[13px] font-medium">{label}</div>}
          {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** A label-above form field for stacked forms. */
export function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/** A card-less list container with hairline-separated rows. */
export function RowList({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-lg border border-border bg-card', className)}>{children}</div>;
}

/**
 * Progressive disclosure (the Apple rule the whole settings area follows):
 * secondary or state-dependent content stays behind a labelled toggle, primary
 * actions never do. Used for advanced config, fallbacks and reference lists.
 */
export function Disclosure({ label, children, defaultOpen = false, className }: {
  label: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 text-[13px] text-muted-foreground transition-colors duration-150 hover:text-foreground"
      >
        <ChevronRight size={14} className={cn('transition-transform duration-[250ms] ease-smooth-out', open && 'rotate-90')} />
        {label}
      </button>
      <div className={cn('grid transition-[grid-template-rows] duration-[250ms] ease-smooth-out', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
        <div className="overflow-hidden">{children}</div>
      </div>
    </div>
  );
}

/** Tiny state chip for integration card headers: a dot plus a word. */
export function StatusChip({ tone, children }: { tone: 'ok' | 'muted' | 'off'; children: ReactNode }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
      <span className={cn('h-1.5 w-1.5 rounded-full', tone === 'ok' ? 'bg-success' : tone === 'muted' ? 'bg-primary' : 'bg-faint')} />
      {children}
    </span>
  );
}
