/**
 * Hint — subtle, dismissible tip card for first-time users.
 * Dismissal is persisted per hint id in localStorage ('ordi:hint:<id>').
 * Children are already-translated content (callers own their i18n keys).
 */
import { useState, type ReactNode } from 'react';
import { Lightbulb, X } from 'lucide-react';
import { cn } from './ui';
import { extendDict, useT } from '../lib/i18n';

extendDict({
  en: { 'hint.dismiss': 'Dismiss' },
  uk: { 'hint.dismiss': 'Приховати' },
});

const PREFIX = 'ordi:hint:';

export function isHintDismissed(id: string): boolean {
  try { return localStorage.getItem(PREFIX + id) === '1'; } catch { return false; }
}

/** Snapshot of a hint's dismissed state (read once on mount). */
export function useHintDismissed(id: string): boolean {
  const [dismissed] = useState(() => isHintDismissed(id));
  return dismissed;
}

/** Clear all persisted hint dismissals (hints reappear on next render/mount). */
export function resetAllHints(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) keys.push(k);
    }
    for (const k of keys) localStorage.removeItem(k);
  } catch { /* private mode */ }
}

export function Hint({ id, icon, title, action, children, className }: {
  id: string;
  icon?: ReactNode;
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const t = useT();
  const [dismissed, setDismissed] = useState(() => isHintDismissed(id));
  const [leaving, setLeaving] = useState(false);

  if (dismissed) return null;

  const dismiss = () => {
    try { localStorage.setItem(PREFIX + id, '1'); } catch { /* private mode */ }
    setLeaving(true);
    window.setTimeout(() => setDismissed(true), 150);
  };

  return (
    <div
      className={cn(
        'anim-pop-in flex items-start gap-2.5 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2 text-[13px]',
        'transition-[opacity,transform] duration-[150ms] ease-smooth-out',
        leaving && 'scale-[0.98] opacity-0',
        className,
      )}
    >
      <span className="mt-px shrink-0 text-primary">{icon ?? <Lightbulb size={14} />}</span>
      <div className="min-w-0 flex-1 leading-snug">
        {title && <div className="font-medium text-foreground">{title}</div>}
        <div className={cn(title ? 'text-muted-foreground' : 'text-foreground/90')}>{children}</div>
        {action && <div className="mt-1.5">{action}</div>}
      </div>
      <button
        aria-label={t('hint.dismiss')}
        onClick={dismiss}
        className="-mr-1 grid h-5 w-5 shrink-0 place-items-center rounded text-faint transition-colors duration-150 hover:bg-primary/10 hover:text-foreground"
      >
        <X size={12} />
      </button>
    </div>
  );
}
