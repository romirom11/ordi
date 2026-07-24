import type { ReactNode } from 'react';
import { cn } from '../ui';

/**
 * Shared building blocks for the settings area — a Linear-style slim layout:
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
