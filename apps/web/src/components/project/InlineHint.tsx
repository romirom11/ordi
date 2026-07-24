import { useState, type ReactNode } from 'react';
import { Lightbulb, X } from 'lucide-react';
import { cn } from '../ui';

/**
 * Dismissible hint card (Notion/Linear onboarding style). Dismissal is
 * remembered per `id` in localStorage so it stays out of the way afterwards.
 * Local to the project/task feature; if a shared components/Hint lands later
 * this can be swapped for it.
 */
export function InlineHint({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  const storageKey = `ordi:hint:${id}`;
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(storageKey) === '1'; } catch { return false; }
  });
  if (dismissed) return null;
  const dismiss = () => {
    setDismissed(true);
    try { localStorage.setItem(storageKey, '1'); } catch { /* private mode */ }
  };
  return (
    <div
      className={cn(
        'anim-fade-in flex items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[13px] text-muted-foreground',
        className,
      )}
    >
      <Lightbulb size={15} className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1 leading-relaxed">{children}</div>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-faint transition-colors duration-150 hover:bg-muted hover:text-foreground"
      >
        <X size={13} />
      </button>
    </div>
  );
}
