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
import { X, CheckCircle2, AlertTriangle, Info } from 'lucide-react';
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
        animation: `${closing ? 'overlay-out' : 'overlay-in'} ${closing ? 150 : 250}ms var(--ease-smooth-out) both`,
      }}
    >
      <style>{`@keyframes overlay-out { from { opacity: 1 } to { opacity: 0 } } @keyframes modal-out { from { opacity: 1; transform: scale(1) } to { opacity: 0; transform: scale(var(--scale-large)) } }`}</style>
      <div
        role="dialog"
        aria-modal
        className="w-full rounded-xl border border-border bg-elevated shadow-modal"
        style={{
          maxWidth: width,
          animation: `${closing ? 'modal-out' : 'modal-in'} ${closing ? 150 : 250}ms var(--ease-smooth-out) both`,
        }}
        onMouseDown={(e) => e.stopPropagation()}
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

export function ConfirmDialog({ open, onClose, onConfirm, title, body, confirmLabel, danger, pending }: {
  open: boolean; onClose: () => void; onConfirm: () => void;
  title: ReactNode; body?: ReactNode; confirmLabel?: string; danger?: boolean; pending?: boolean;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} width={400}>
      <div className="px-4 pb-4 pt-2">
        {body && <p className="mb-4 text-[13px] text-muted-foreground">{body}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
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

export function DropdownMenu({ trigger, children, align = 'start', side = 'bottom', width, disabled, className }: {
  trigger: ReactNode; children: ReactNode; align?: 'start' | 'end'; side?: 'bottom' | 'top' | 'right';
  width?: number; disabled?: boolean; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({});

  const close = useCallback(() => {
    setClosing(true);
    setTimeout(() => { setOpen(false); setClosing(false); }, 120);
  }, []);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    const mw = width ?? menuRef.current?.offsetWidth ?? 200;
    const mh = menuRef.current?.offsetHeight ?? 200;
    let top = side === 'top' ? r.top - mh - 6 : side === 'right' ? r.top : r.bottom + 6;
    let left = side === 'right' ? r.right + 6 : align === 'end' ? r.right - mw : r.left;
    // Clamp to viewport
    left = Math.min(Math.max(8, left), window.innerWidth - mw - 8);
    if (top + mh > window.innerHeight - 8) top = Math.max(8, window.innerHeight - mh - 8);
    setPos({ top, left, width });
  }, [open, align, side, width]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || anchorRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
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
              ? 'dropdown-out 120ms var(--ease-smooth-out) both'
              : 'dropdown-in 250ms var(--ease-smooth-out) both',
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
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-100',
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

/* ───────────────────────── Toasts ───────────────────────── */

export type ToastKind = 'success' | 'error' | 'info';
interface Toast { id: number; kind: ToastKind; message: string; leaving?: boolean }

let toastId = 0;
let toasts: Toast[] = [];
const listeners = new Set<() => void>();

function emit() { listeners.forEach((l) => l()); }

function dismiss(id: number) {
  toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
  emit();
  setTimeout(() => { toasts = toasts.filter((t) => t.id !== id); emit(); }, 250);
}

export function toast(message: string, kind: ToastKind = 'success') {
  const id = ++toastId;
  toasts = [...toasts, { id, kind, message }];
  emit();
  setTimeout(() => dismiss(id), kind === 'error' ? 6000 : 3500);
}
toast.error = (m: string) => toast(m, 'error');
toast.info = (m: string) => toast(m, 'info');

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
          style={{ animation: t.leaving ? 'toast-out 250ms var(--ease-smooth-out) both' : 'toast-in 350ms var(--ease-smooth-out) both' }}
        >
          <span className="mt-px shrink-0">{ICONS[t.kind]}</span>
          <span className="flex-1 leading-snug">{t.message}</span>
          <button onClick={() => dismiss(t.id)} className="shrink-0 text-faint transition-colors hover:text-foreground"><X size={13} /></button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
