/**
 * Overlay primitives: Dialog, DropdownMenu, and a toast system.
 * Motion follows transitions.dev tokens: open 250ms smooth-out with a slight
 * pre-scale, close 150ms; toasts rise from below and leave faster than they
 * arrive. All overlays close on Escape / outside click.
 */
import {
  createContext, useContext, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type ReactNode, type CSSProperties,
} from 'react';
import { createPortal } from 'react-dom';
import { X, CheckCircle2, AlertTriangle, Info, ChevronRight } from 'lucide-react';
import { cn, IconButton, Button } from './ui';

/* ───────────────────────── Dialog ───────────────────────── */

export function Dialog({ open, onClose, children, width = 480, title, hideClose }: {
  open: boolean; onClose: () => void; children: ReactNode; width?: number; title?: ReactNode; hideClose?: boolean;
}) {
  // Keep mounted briefly while closing so the exit animation can play.
  const [visible, setVisible] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) { setVisible(true); setClosing(false); return; }
    if (!visible) return;
    setClosing(true);
    const id = setTimeout(() => { setVisible(false); setClosing(false); }, 150);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!visible) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[12vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        background: 'hsl(var(--overlay) / 0.55)',
        animation: `${closing ? 'overlay-out' : 'overlay-in'} ${closing ? 'var(--duration-quick)' : 'var(--duration-fast)'} var(--ease-smooth-out) both`,
      }}
    >
      <style>{`@keyframes overlay-out { from { opacity: 1 } to { opacity: 0 } } @keyframes modal-out { from { opacity: 1; transform: scale(1) } to { opacity: 0; transform: scale(var(--scale-large)) } }`}</style>
      <div
        role="dialog"
        aria-modal
        className="w-full rounded-xl border border-border bg-elevated shadow-modal"
        style={{
          maxWidth: width,
          animation: `${closing ? 'modal-out' : 'modal-in'} ${closing ? 'var(--duration-quick)' : 'var(--duration-fast)'} var(--ease-smooth-out) both`,
        }}
      >
        {(title || !hideClose) && (
          <div className="flex items-center justify-between px-4 pb-0 pt-3.5">
            <h2 className="text-sm font-semibold">{title}</h2>
            {!hideClose && <IconButton size="sm" onClick={onClose} aria-label="Close"><X size={14} /></IconButton>}
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, body, confirmLabel, cancelLabel, danger, pending }: {
  open: boolean; onClose: () => void; onConfirm: () => void;
  title: ReactNode; body?: ReactNode; confirmLabel?: string; cancelLabel?: string; danger?: boolean; pending?: boolean;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} width={400}>
      <div className="px-4 pb-4 pt-2">
        {body && <p className="mb-4 text-[13px] text-muted-foreground">{body}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>{cancelLabel ?? 'Cancel'}</Button>
          <Button variant={danger ? 'destructive' : 'primary'} size="sm" onClick={onConfirm} disabled={pending}>
            {confirmLabel ?? 'Confirm'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/* ───────────────────────── Dropdown menu ───────────────────────── */

interface MenuCtxType { close: () => void }
const MenuCtx = createContext<MenuCtxType>({ close: () => {} });

/** Close the nearest DropdownMenu – for custom controls (inputs, etc.) inside a menu. */
export function useMenuClose(): () => void {
  return useContext(MenuCtx).close;
}

export function DropdownMenu({ trigger, children, align = 'start', side = 'bottom', width, matchAnchorWidth, disabled, className }: {
  trigger: ReactNode; children: ReactNode; align?: 'start' | 'end'; side?: 'bottom' | 'top' | 'right';
  width?: number;
  /**
   * Never render narrower than the trigger – `width` becomes a minimum. A
   * select whose menu is half its own control wraps every option for no
   * reason, so anything shaped like a form control opts in.
   */
  matchAnchorWidth?: boolean;
  disabled?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({});

  const close = useCallback(() => {
    setClosing(true);
    setTimeout(() => { setOpen(false); setClosing(false); }, 150);
  }, []);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const own = matchAnchorWidth ? Math.max(width ?? 0, r.width) : width;
    const mw = own ?? menuRef.current?.offsetWidth ?? 200;
    const mh = menuRef.current?.offsetHeight ?? 200;
    let top = side === 'top' ? r.top - mh - 6 : side === 'right' ? r.top : r.bottom + 6;
    let left = side === 'right' ? r.right + 6 : align === 'end' ? r.right - mw : r.left;
    // Clamp to viewport
    left = Math.min(Math.max(8, left), window.innerWidth - mw - 8);
    if (top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mh - 8);
    setPos({ top, left, width: own });
  }, [open, align, side, width, matchAnchorWidth]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || anchorRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    // Capture phase: a bubble-phase listener never fires for clicks inside a
    // Dialog, whose panel stops mousedown before it reaches the document – so
    // opening a second picker left the first menu hanging open over it.
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [open, close]);

  return (
    <>
      <div ref={anchorRef} className={cn('inline-flex', className)} onClick={(e) => { e.stopPropagation(); if (!disabled) (open ? close() : setOpen(true)); }}>
        {trigger}
      </div>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[60] min-w-[168px] overflow-hidden rounded-lg border border-border bg-elevated p-1 shadow-pop"
          style={{
            ...pos,
            transformOrigin: `${align === 'end' ? 'right' : 'left'} ${side === 'top' ? 'bottom' : 'top'}`,
            animation: closing
              ? 'dropdown-out var(--duration-quick) var(--ease-smooth-out) both'
              : 'dropdown-in var(--duration-fast) var(--ease-smooth-out) both',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <style>{`@keyframes dropdown-out { from { opacity: 1; transform: scale(1) } to { opacity: 0; transform: scale(var(--scale-tiny)) } }`}</style>
          <MenuCtx.Provider value={{ close }}>{children}</MenuCtx.Provider>
        </div>,
        document.body,
      )}
    </>
  );
}

export function MenuItem({ children, onSelect, icon, danger, disabled, shortcut, checked }: {
  children: ReactNode; onSelect?: () => void; icon?: ReactNode; danger?: boolean; disabled?: boolean;
  shortcut?: string; checked?: boolean;
}) {
  const { close } = useContext(MenuCtx);
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={() => { onSelect?.(); close(); }}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150',
        danger ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-muted',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      {icon && <span className="text-muted-foreground [&>svg]:block">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {checked && <span className="text-primary">✓</span>}
      {shortcut && <span className="text-[11px] text-faint">{shortcut}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="mx-1 my-1 h-px bg-border" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">{children}</div>;
}

/* ───────────────────────── Context menu (right-click) ───────────────────────── */

export type ContextMenuEntry =
  | {
      type?: undefined;
      key: string;
      label: ReactNode;
      icon?: ReactNode;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect?: () => void;
      /** One level of sub-items (opens to the right on hover). */
      children?: ContextMenuEntry[];
    }
  | { type: 'separator' }
  | { type: 'label'; label: ReactNode };

function isAction(e: ContextMenuEntry): e is Extract<ContextMenuEntry, { key: string }> {
  return e.type === undefined;
}

const CTX_MENU_WIDTH = 208;

function ContextMenuList({ items, onDone, autoFocus }: {
  items: ContextMenuEntry[]; onDone: () => void; autoFocus?: boolean;
}) {
  const [hoverKey, setHoverKey] = useState<string | null>(null); // open submenu
  const [activeIdx, setActiveIdx] = useState(-1); // keyboard cursor
  const hoverTimer = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);

  const actionable = items.filter((it) => isAction(it) && !it.disabled) as Extract<ContextMenuEntry, { key: string }>[];

  const scheduleSubmenu = (key: string | null) => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => setHoverKey(key), 150);
  };
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  // Keyboard navigation (best effort): up/down + enter, on the top level only.
  useEffect(() => {
    if (!autoFocus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((cur) => {
          if (actionable.length === 0) return -1;
          const delta = e.key === 'ArrowDown' ? 1 : -1;
          return (cur + delta + actionable.length) % actionable.length;
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        setActiveIdx((cur) => {
          const it = actionable[cur];
          if (it && !it.children) { it.onSelect?.(); onDone(); }
          if (it?.children) setHoverKey(it.key);
          return cur;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus, items, onDone]);

  return (
    <div ref={listRef} className="p-1">
      {items.map((it, i) => {
        if (it.type === 'separator') return <MenuSeparator key={`sep-${i}`} />;
        if (it.type === 'label') return <MenuLabel key={`label-${i}`}>{it.label}</MenuLabel>;
        const kbActive = actionable[activeIdx]?.key === it.key;
        return (
          <div
            key={it.key}
            className="relative"
            onMouseEnter={() => scheduleSubmenu(it.children ? it.key : null)}
          >
            <button
              role="menuitem"
              disabled={it.disabled}
              onClick={() => {
                if (it.children) { setHoverKey(it.key); return; }
                it.onSelect?.();
                onDone();
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150',
                it.danger ? 'text-destructive hover:bg-destructive/10' : 'text-foreground hover:bg-muted',
                kbActive && (it.danger ? 'bg-destructive/10' : 'bg-muted'),
                it.disabled && 'pointer-events-none opacity-50',
              )}
            >
              {it.icon && <span className={cn('[&>svg]:block', it.danger ? 'text-destructive' : 'text-muted-foreground')}>{it.icon}</span>}
              <span className="flex-1 truncate">{it.label}</span>
              {it.shortcut && <span className="text-[11px] text-faint">{it.shortcut}</span>}
              {it.children && <ChevronRight size={12} className="text-faint" aria-hidden />}
            </button>
            {it.children && hoverKey === it.key && (
              <div
                className="absolute -top-1 left-full z-10 min-w-[168px] overflow-hidden rounded-lg border border-border bg-elevated shadow-pop"
                style={{
                  transformOrigin: 'left top',
                  animation: 'dropdown-in var(--duration-fast) var(--ease-smooth-out) both',
                }}
                onMouseEnter={() => window.clearTimeout(hoverTimer.current)}
              >
                <ContextMenuList items={it.children} onDone={onDone} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * ContextMenu – Linear-style right-click menu. Wraps children; right-click
 * opens a portal menu at the cursor (clamped to viewport) with the dropdown
 * visual language. One level of submenu, Esc/outside closes, ↑/↓+Enter navigate.
 */
export function ContextMenu({ items, children, disabled, className }: {
  items: ContextMenuEntry[]; children: ReactNode; disabled?: boolean; className?: string;
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const [closing, setClosing] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({});
  const [origin, setOrigin] = useState('left top');

  const close = useCallback(() => {
    setClosing(true);
    setTimeout(() => { setAt(null); setClosing(false); }, 150);
  }, []);

  useLayoutEffect(() => {
    if (!at) return;
    const mw = menuRef.current?.offsetWidth ?? CTX_MENU_WIDTH;
    const mh = menuRef.current?.offsetHeight ?? 200;
    const flipX = at.x + mw > window.innerWidth - 8;
    const flipY = at.y + mh > window.innerHeight - 8;
    const left = Math.max(8, flipX ? at.x - mw : at.x);
    const top = Math.max(8, flipY ? at.y - mh : at.y);
    setOrigin(`${flipX ? 'right' : 'left'} ${flipY ? 'bottom' : 'top'}`);
    setPos({ top, left });
  }, [at]);

  useEffect(() => {
    if (!at) return;
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', close);
    };
  }, [at, close]);

  return (
    <>
      <div
        className={className ?? 'contents'}
        onContextMenu={(e) => {
          if (disabled) return;
          e.preventDefault();
          e.stopPropagation();
          setClosing(false);
          setAt({ x: e.clientX, y: e.clientY });
        }}
      >
        {children}
      </div>
      {at && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-[60] min-w-[184px] overflow-visible rounded-lg border border-border bg-elevated shadow-pop"
          style={{
            ...pos,
            transformOrigin: origin,
            animation: closing
              ? 'ctx-menu-out var(--duration-quick) var(--ease-smooth-out) both'
              : 'dropdown-in var(--duration-fast) var(--ease-smooth-out) both',
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <style>{`@keyframes ctx-menu-out { from { opacity: 1; transform: scale(1) } to { opacity: 0; transform: scale(var(--scale-tiny)) } }`}</style>
          <ContextMenuList items={items} onDone={close} autoFocus />
        </div>,
        document.body,
      )}
    </>
  );
}

/* ───────────────────────── Toasts ───────────────────────── */

export type ToastKind = 'success' | 'error' | 'info';
interface ToastAction { label: string; onSelect: () => void }
interface Toast { id: number; kind: ToastKind; message: string; action?: ToastAction; leaving?: boolean }

let toastId = 0;
let toasts: Toast[] = [];
const listeners = new Set<() => void>();

function emit() { listeners.forEach((l) => l()); }

function dismiss(id: number) {
  toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); emit(); }, 350);
}

export function toast(message: string, kind: ToastKind = 'success') {
  const id = ++toastId;
  toasts = [...toasts, { id, kind, message }];
  emit();
  setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3500);
}
toast.error = (m: string) => toast(m, 'error');
toast.info = (m: string) => toast(m, 'info');
/** A toast the user must act on – it stays until dismissed or acted upon. */
toast.action = (message: string, action: ToastAction, kind: ToastKind = 'info') => {
  toasts = [...toasts, { id: ++toastId, kind, message, action }];
  emit();
};

const ICONS: Record<ToastKind, ReactNode> = {
  success: <CheckCircle2 size={15} className="text-success" />,
  error: <AlertTriangle size={15} className="text-destructive" />,
  info: <Info size={15} className="text-primary" />,
};

export function Toaster() {
  const list = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => toasts,
  );
  if (list.length === 0) return null;
  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-80 flex-col gap-2">
      <style>{`@keyframes toast-out { from { opacity: 1; transform: translateY(0) } to { opacity: 0; transform: translateY(8px) } }`}</style>
      {list.map((t) => (
        <div
          key={t.id}
          className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-elevated px-3 py-2.5 text-[13px] shadow-pop"
          style={{ animation: t.leaving ? 'toast-out var(--duration-medium) var(--ease-smooth-out) both' : 'toast-in var(--duration-medium) var(--ease-smooth-out) both' }}
        >
          <span className="mt-px shrink-0">{ICONS[t.kind]}</span>
          <span className="flex-1 leading-snug">{t.message}</span>
          {t.action && (
            <button
              onClick={() => { t.action!.onSelect(); dismiss(t.id); }}
              className="shrink-0 font-medium text-primary transition-colors hover:underline"
            >
              {t.action.label}
            </button>
          )}
          <button onClick={() => dismiss(t.id)} className="shrink-0 text-faint transition-colors hover:text-foreground"><X size={13} /></button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
