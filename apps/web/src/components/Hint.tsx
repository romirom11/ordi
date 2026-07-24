/**
 * Hint – floating, dismissible tip cards for first-time users.
 * Rendered via portal into a shared fixed stack at the bottom-left of the
 * viewport (clear of the sidebar and of the bottom-right Toaster), so multiple
 * mounted hints stack vertically instead of overlapping.
 * Dismissal is persisted per hint id in localStorage ('ordi:hint:<id>').
 * Children are already-translated content (callers own their i18n keys).
 */
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
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

/**
 * Shared portal target: one fixed flex column at the bottom-left. All mounted
 * hints portal into it, so stacking is just DOM order – no measuring needed.
 * Left offset clears the w-56 (14rem) sidebar; the Toaster owns bottom-right.
 */
let hintRoot: HTMLElement | null = null;
function getHintRoot(): HTMLElement {
  if (!hintRoot || !document.body.contains(hintRoot)) {
    hintRoot = document.createElement('div');
    hintRoot.setAttribute('data-ordi-hints', '');
    hintRoot.className = 'pointer-events-none fixed bottom-4 z-[45] flex w-[340px] flex-col gap-2';
    hintRoot.style.left = 'calc(14rem + 16px)';
    document.body.appendChild(hintRoot);
  }
  return hintRoot;
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
    window.setTimeout(() => setDismissed(true), 200);
  };

  return createPortal(
    <div
      className={cn(
        'pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-elevated px-3 py-2.5 text-[13px] shadow-pop',
        className,
      )}
      style={{
        animation: leaving
          ? 'hint-out 200ms var(--ease-smooth-out) both'
          : 'toast-in 350ms var(--ease-smooth-out) both',
      }}
    >
      <style>{'@keyframes hint-out { from { opacity: 1; transform: translateY(0) } to { opacity: 0; transform: translateY(8px) } }'}</style>
      <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-md bg-primary/15 text-primary">
        {icon ?? <Lightbulb size={13} />}
      </span>
      <div className="min-w-0 flex-1 leading-snug">
        {title && <div className="font-medium text-foreground">{title}</div>}
        <div className={cn(title ? 'text-muted-foreground' : 'text-foreground/90')}>{children}</div>
        {action && <div className="mt-1.5">{action}</div>}
      </div>
      <button
        aria-label={t('hint.dismiss')}
        onClick={dismiss}
        className="-mr-1 -mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded text-faint transition-colors duration-150 hover:bg-muted hover:text-foreground"
      >
        <X size={12} />
      </button>
    </div>,
    getHintRoot(),
  );
}
