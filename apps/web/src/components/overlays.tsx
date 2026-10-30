/**
 * Overlay primitives: Dialog, DropdownMenu, ContextMenu and a toast system.
 * Motion follows transitions.dev tokens: open 250ms smooth-out with a slight
 * pre-scale, close 150ms; toasts rise from below and leave faster than they
 * arrive. All overlays close on Escape / outside click.
 *
 * Keyboard and focus run through lib/overlayA11y: only the topmost overlay
 * answers Escape, a dialog keeps Tab inside itself and makes the page behind
 * it inert, menus move real DOM focus between their items, and closing puts
 * focus back on whatever opened the overlay.
 */
import {
  createContext, useContext, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore,
  type ReactNode, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { X, CheckCircle2, AlertTriangle, Info, ChevronRight } from 'lucide-react';
import { cn, IconButton, Button } from './ui';
import { useT } from '../lib/i18n';
import {
  overlayStack, captureReturnTarget, focusIsLost, restoreFocus, tabbables, menuItemsOf, isTextEntry,
  navIndex, typeaheadIndex, wrapTabIndex, type OverlayLayer,
} from '../lib/overlayA11y';

/* ───────────────────────── Overlay layers ───────────────────────── */

/**
 * Put a popover on the overlay stack while `open`, so Escape closes it alone
 * rather than also closing the dialog underneath. For popovers that are not
 * built on DropdownMenu (a date picker, a notification panel).
 */
export function useOverlayLayer(open: boolean, onEscape: () => void): void {
  const escRef = useRef(onEscape);
  useEffect(() => { escRef.current = onEscape; });
  useEffect(() => {
    if (!open) return;
    return overlayStack.push({ onEscape: () => escRef.current() });
  }, [open]);
}

/**
 * The element that had focus when `open` turned true. Read during that render,
 * because a child's autoFocus moves focus inside before any effect runs.
 */
function useReturnTarget(open: boolean): RefObject<HTMLElement | null> {
  const target = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) target.current = captureReturnTarget();
  wasOpen.current = open;
  return target;
}

function focusInitial(panel: HTMLElement) {
  const list = tabbables(panel);
  // The header's close button is a last resort, not the place to start.
  const first = list.find((el) => !el.hasAttribute('data-dialog-close')) ?? list[0] ?? panel;
  first.focus({ preventScroll: true });
}

/**
 * A modal surface while `active`: on the overlay stack, the page behind it
 * inert, focus moved inside (unless a child already took it), Tab wrapped at
 * the ends, and focus handed back on close – to the opener, or to the layer
 * below / the page when the opener has gone away.
 */
function useModalLayer({ active, rootRef, panelRef, onEscape, returnTo }: {
  active: boolean;
  rootRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  onEscape: () => void;
  returnTo: RefObject<HTMLElement | null>;
}) {
  const escRef = useRef(onEscape);
  useEffect(() => { escRef.current = onEscape; });

  useEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!root || !panel) return;
    const layer: OverlayLayer = {
      onEscape: () => escRef.current(),
      element: () => panelRef.current,
      background: Array.from(document.body.children).filter((el) => el !== root),
    };
    const pop = overlayStack.push(layer);
    if (!panel.contains(document.activeElement)) focusInitial(panel);

    // Native listener on the panel: menus and pickers are portaled elsewhere,
    // so their own Tab handling never reaches it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented || !overlayStack.isTop(layer)) return;
      const list = tabbables(panel);
      if (list.length === 0) { e.preventDefault(); panel.focus(); return; }
      const next = wrapTabIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (next !== null) { e.preventDefault(); list[next]!.focus(); }
    };
    panel.addEventListener('keydown', onKey);

    return () => {
      panel.removeEventListener('keydown', onKey);
      const below = overlayStack.below(layer)?.element?.() ?? null;
      pop(); // releases inert first – an inert opener cannot take focus
      if (focusIsLost(root)) restoreFocus(returnTo.current, below);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/* ───────────────────────── Dialog ───────────────────────── */

export function Dialog({ open, onClose, children, width = 480, title, hideClose, ariaLabel }: {
  open: boolean; onClose: () => void; children: ReactNode; width?: number; title?: ReactNode; hideClose?: boolean;
  /** Accessible name for a dialog without a visible `title`. Defaults to its first heading. */
  ariaLabel?: string;
}) {
  const t = useT();
  // Keep mounted briefly while closing so the exit animation can play.
  const [visible, setVisible] = useState(open);
  const [closing, setClosing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const returnTo = useReturnTarget(open);

  useEffect(() => {
    if (open) { setVisible(true); setClosing(false); return; }
    if (!visible) return;
    setClosing(true);
    const id = setTimeout(() => { setVisible(false); setClosing(false); }, 150);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useModalLayer({ active: open && visible && !closing, rootRef, panelRef, onEscape: onClose, returnTo });

  // A dialog with its own header instead of `title` is named by that heading.
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || !visible || !panel || title || ariaLabel) return;
    const heading = panel.querySelector('h1, h2, h3');
    if (!heading) return;
    if (!heading.id) heading.id = `${titleId}-heading`;
    panel.setAttribute('aria-labelledby', heading.id);
    return () => panel.removeAttribute('aria-labelledby');
  }, [open, visible, title, ariaLabel, titleId]);

  if (!visible) return null;

  return createPortal(
    <div
      ref={rootRef}
      inert={closing}
      aria-hidden={closing || undefined}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[12vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        background: 'hsl(var(--overlay) / 0.55)',
        animation: `${closing ? 'overlay-out' : 'overlay-in'} ${closing ? 'var(--duration-quick)' : 'var(--duration-fast)'} var(--ease-smooth-out) both`,
      }}
    >
      <style>{`@keyframes overlay-out { from { opacity: 1 } to { opacity: 0 } } @keyframes modal-out { from { opacity: 1; transform: scale(1) } to { opacity: 0; transform: scale(var(--scale-large)) } }`}</style>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        tabIndex={-1}
        className="w-full rounded-xl border border-border bg-elevated shadow-modal focus-visible:outline-none"
        style={{
          maxWidth: width,
          animation: `${closing ? 'modal-out' : 'modal-in'} ${closing ? 'var(--duration-quick)' : 'var(--duration-fast)'} var(--ease-smooth-out) both`,
        }}
      >
        {(title || !hideClose) && (
          <div className="flex items-center justify-between gap-2 px-4 pb-0 pt-3.5">
            {title ? <h2 id={titleId} className="text-sm font-semibold">{title}</h2> : <span />}
            {!hideClose && (
              <IconButton type="button" size="sm" onClick={onClose} aria-label={t('common.close')} data-dialog-close="">
                <X size={14} />
              </IconButton>
            )}
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
  const t = useT();
  return (
    <Dialog open={open} onClose={onClose} title={title} width={400}>
      <div className="px-4 pb-4 pt-2">
        {body && <p className="mb-4 text-[13px] text-muted-foreground">{body}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{cancelLabel ?? t('common.cancel')}</Button>
          <Button type="button" variant={danger ? 'destructive' : 'primary'} size="sm" onClick={onConfirm} disabled={pending}>
            {confirmLabel ?? t('common.confirm', 'Confirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/* ───────────────────────── Menu keyboard ───────────────────────── */

interface TypeBuffer { text: string; at: number }

/**
 * Arrow keys, Home/End and type-ahead over a menu's own items, moving real DOM
 * focus. Returns true when the key was used. A text field inside the menu (a
 * search box, a label name) keeps its keys.
 */
function navigateMenu(e: ReactKeyboardEvent, menu: HTMLElement, buffer: TypeBuffer): boolean {
  if (isTextEntry(e.target as Element)) return false;
  const items = menuItemsOf(menu);
  const current = items.indexOf(document.activeElement as HTMLElement);
  const idx = navIndex(items.length, current, e.key);
  if (idx !== null) { items[idx]!.focus(); return true; }
  if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const now = Date.now();
    buffer.text = now - buffer.at < 500 ? buffer.text + e.key : e.key;
    buffer.at = now;
    const hit = typeaheadIndex(items.map((el) => el.textContent ?? ''), current, buffer.text);
    if (hit >= 0) items[hit]!.focus();
    return true;
  }
  return false;
}

/* ───────────────────────── Dropdown menu ───────────────────────── */

interface MenuCtxType { close: () => void }
const MenuCtx = createContext<MenuCtxType>({ close: () => {} });

/** Close the nearest DropdownMenu – for custom controls (inputs, etc.) inside a menu. */
export function useMenuClose(): () => void {
  return useContext(MenuCtx).close;
}

/** What inside a trigger is already a control – it gets the menu semantics. */
const TRIGGER_CONTROL = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

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
  /* A trigger that is a plain span (a chip) gets no focus or keys of its own;
   * then the anchor itself plays the button. A real button trigger keeps its
   * role and just gains aria-haspopup / aria-expanded. */
  const triggerRef = useRef<HTMLElement | null>(null);
  const [anchorIsTrigger, setAnchorIsTrigger] = useState(false);
  const focusOnOpen = useRef<'first' | 'last' | 'menu'>('menu');
  const closingRef = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const typeBuffer = useRef<TypeBuffer>({ text: '', at: 0 });
  const menuId = useId();
  const expanded = open && !closing;

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    // Back to the trigger when focus was in the menu – not when the user
    // clicked somewhere else, which takes focus where they clicked.
    if (focusIsLost(menuRef.current)) {
      restoreFocus(triggerRef.current, anchorRef.current?.closest<HTMLElement>('[role="dialog"]'));
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closingRef.current = false;
      setOpen(false);
      setClosing(false);
    }, 150);
  }, []);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const openMenu = (focus: 'first' | 'last' | 'menu') => {
    if (disabled) return;
    window.clearTimeout(closeTimer.current);
    closingRef.current = false;
    setClosing(false);
    focusOnOpen.current = focus;
    setOpen(true);
  };

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const inner = anchor.querySelector<HTMLElement>(TRIGGER_CONTROL);
    triggerRef.current = inner ?? anchor;
    if (anchorIsTrigger !== !inner) setAnchorIsTrigger(!inner);
    if (inner) {
      inner.setAttribute('aria-haspopup', 'menu');
      inner.setAttribute('aria-expanded', String(expanded));
      if (expanded) inner.setAttribute('aria-controls', menuId);
      else inner.removeAttribute('aria-controls');
    }
  });

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
    if (!expanded) return;
    const menu = menuRef.current;
    if (!menu) return;
    const pop = overlayStack.push({ onEscape: close, element: () => menuRef.current });
    // A child that took focus itself (a search box) keeps it.
    if (!menu.contains(document.activeElement)) {
      const items = menuItemsOf(menu);
      const target = focusOnOpen.current === 'first' ? items[0]
        : focusOnOpen.current === 'last' ? items[items.length - 1] : undefined;
      (target ?? menu).focus({ preventScroll: true });
    }
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) || anchorRef.current?.contains(e.target as Node)) return;
      close();
    };
    // Capture phase: a bubble-phase listener never fires for clicks inside a
    // Dialog, whose panel stops mousedown before it reaches the document – so
    // opening a second picker left the first menu hanging open over it.
    document.addEventListener('mousedown', onDown, true);
    return () => { pop(); document.removeEventListener('mousedown', onDown, true); };
  }, [expanded, close]);

  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || e.target !== triggerRef.current) return;
    if (anchorIsTrigger && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      e.stopPropagation();
      if (open && !closing) close(); else openMenu('first');
      return;
    }
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !isTextEntry(e.target as Element)) {
      e.preventDefault();
      e.stopPropagation();
      if (!open || closing) { openMenu(e.key === 'ArrowDown' ? 'first' : 'last'); return; }
      const items = menuRef.current ? menuItemsOf(menuRef.current) : [];
      (e.key === 'ArrowDown' ? items[0] : items[items.length - 1])?.focus();
    }
  };

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') return; // the overlay stack owns Escape
    // Keys typed in a menu are the menu's: not a list row's Enter handler, not
    // an app-wide single-letter shortcut.
    if (!e.metaKey && !e.ctrlKey) e.stopPropagation();
    const menu = menuRef.current;
    if (!menu || e.isDefaultPrevented()) return;
    if (e.key === 'Tab') {
      const list = tabbables(menu);
      if (list.some((el) => isTextEntry(el))) {
        // A menu with a form in it (search, a name field): Tab moves between its fields.
        const next = wrapTabIndex(list.length, list.indexOf(document.activeElement as HTMLElement), e.shiftKey);
        if (next !== null) { e.preventDefault(); list[next]!.focus(); }
      } else {
        e.preventDefault();
        close();
      }
      return;
    }
    if (navigateMenu(e, menu, typeBuffer.current)) e.preventDefault();
  };

  return (
    <>
      <div
        ref={anchorRef}
        className={cn('inline-flex', anchorIsTrigger && 'rounded-md', className)}
        {...(anchorIsTrigger ? {
          role: 'button',
          tabIndex: disabled ? undefined : 0,
          'aria-haspopup': 'menu' as const,
          'aria-expanded': expanded,
          'aria-controls': expanded ? menuId : undefined,
          'aria-disabled': disabled || undefined,
        } : {})}
        onClick={(e) => {
          e.stopPropagation();
          if (disabled) return;
          // detail 0: a keyboard "click" (Enter/Space on a button trigger).
          if (open && !closing) close(); else openMenu(e.detail === 0 ? 'first' : 'menu');
        }}
        onKeyDown={onTriggerKeyDown}
      >
        {trigger}
      </div>
      {open && createPortal(
        <div
          ref={menuRef}
          id={menuId}
          inert={closing}
          aria-hidden={closing || undefined}
          role="menu"
          tabIndex={-1}
          className="fixed z-[60] min-w-[168px] overflow-hidden rounded-lg border border-border bg-elevated p-1 shadow-pop focus-visible:outline-none"
          style={{
            ...pos,
            transformOrigin: `${align === 'end' ? 'right' : 'left'} ${side === 'top' ? 'bottom' : 'top'}`,
            animation: closing
              ? 'dropdown-out var(--duration-quick) var(--ease-smooth-out) both'
              : 'dropdown-in var(--duration-fast) var(--ease-smooth-out) both',
          }}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={onMenuKeyDown}
        >
          <style>{`@keyframes dropdown-out { from { opacity: 1; transform: scale(1) } to { opacity: 0; transform: scale(var(--scale-tiny)) } }`}</style>
          <MenuCtx.Provider value={{ close }}>{children}</MenuCtx.Provider>
        </div>,
        document.body,
      )}
    </>
  );
}

/** Row styling shared by menu items: keyboard focus looks like hover, plus an inset ring. */
const ITEM_CLASS = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 focus-visible:[outline-offset:-2px]';

export function MenuItem({ children, onSelect, icon, danger, disabled, shortcut, checked }: {
  children: ReactNode; onSelect?: () => void; icon?: ReactNode; danger?: boolean; disabled?: boolean;
  shortcut?: string; checked?: boolean;
}) {
  const { close } = useContext(MenuCtx);
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => { onSelect?.(); close(); }}
      className={cn(
        ITEM_CLASS,
        danger ? 'text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10' : 'text-foreground hover:bg-muted focus-visible:bg-muted',
        disabled && 'pointer-events-none opacity-50',
      )}
    >
      {icon && <span className="text-muted-foreground [&>svg]:block">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      {checked && <span className="text-primary" aria-hidden>✓</span>}
      {shortcut && <span className="text-[11px] text-faint">{shortcut}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div role="separator" className="mx-1 my-1 h-px bg-border" />;
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

function ContextMenuList({ items, onDone, onBack, focusFirst }: {
  items: ContextMenuEntry[]; onDone: () => void;
  /** Submenus only: close this list and return to the parent item. */
  onBack?: () => void;
  /** Focus the first item on mount (a submenu opened from the keyboard). */
  focusFirst?: boolean;
}) {
  const [subKey, setSubKey] = useState<string | null>(null); // open submenu
  const [subFromKeyboard, setSubFromKeyboard] = useState(false);
  const hoverTimer = useRef<number | undefined>(undefined);
  const listRef = useRef<HTMLDivElement>(null);
  const typeBuffer = useRef<TypeBuffer>({ text: '', at: 0 });

  // An open submenu is its own layer: Escape closes it first.
  useOverlayLayer(!!onBack, () => onBack?.());

  const scheduleSubmenu = (key: string | null) => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => { setSubKey(key); setSubFromKeyboard(false); }, 150);
  };
  const openSubmenu = (key: string) => {
    window.clearTimeout(hoverTimer.current);
    setSubKey(key);
    setSubFromKeyboard(true);
  };
  const closeSubmenu = (key: string) => {
    setSubKey(null);
    listRef.current?.querySelector<HTMLElement>(`[data-ctx-key="${CSS.escape(key)}"]`)?.focus();
  };
  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);
  useEffect(() => {
    if (focusFirst && listRef.current) menuItemsOf(listRef.current)[0]?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') return; // the overlay stack owns Escape
    // The innermost list handles its keys; a parent list must not act again.
    e.stopPropagation();
    const list = listRef.current;
    if (!list) return;
    if (e.key === 'Tab') { e.preventDefault(); onDone(); return; }
    if (navigateMenu(e, list, typeBuffer.current)) { e.preventDefault(); return; }
    const key = (document.activeElement as HTMLElement | null)?.dataset.ctxKey;
    const entry = items.find((it) => isAction(it) && it.key === key) as Extract<ContextMenuEntry, { key: string }> | undefined;
    if (e.key === 'ArrowRight' && entry?.children && !entry.disabled) { e.preventDefault(); openSubmenu(entry.key); }
    else if (e.key === 'ArrowLeft' && onBack) { e.preventDefault(); onBack(); }
  };

  return (
    <div ref={listRef} role="menu" tabIndex={-1} className="p-1 focus-visible:outline-none" onKeyDown={onKeyDown}>
      {items.map((it, i) => {
        if (it.type === 'separator') return <MenuSeparator key={`sep-${i}`} />;
        if (it.type === 'label') return <MenuLabel key={`label-${i}`}>{it.label}</MenuLabel>;
        return (
          <div
            key={it.key}
            className="relative"
            onMouseEnter={() => scheduleSubmenu(it.children ? it.key : null)}
          >
            <button
              type="button"
              role="menuitem"
              data-ctx-key={it.key}
              aria-haspopup={it.children ? 'menu' : undefined}
              aria-expanded={it.children ? subKey === it.key : undefined}
              disabled={it.disabled}
              onClick={(e) => {
                if (it.children) {
                  if (e.detail === 0) openSubmenu(it.key); else setSubKey(it.key);
                  return;
                }
                it.onSelect?.();
                onDone();
              }}
              className={cn(
                ITEM_CLASS,
                it.danger ? 'text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10' : 'text-foreground hover:bg-muted focus-visible:bg-muted',
                it.disabled && 'pointer-events-none opacity-50',
              )}
            >
              {it.icon && <span className={cn('[&>svg]:block', it.danger ? 'text-destructive' : 'text-muted-foreground')}>{it.icon}</span>}
              <span className="flex-1 truncate">{it.label}</span>
              {it.shortcut && <span className="text-[11px] text-faint">{it.shortcut}</span>}
              {it.children && <ChevronRight size={12} className="text-faint" aria-hidden />}
            </button>
            {it.children && subKey === it.key && (
              <div
                className="absolute -top-1 left-full z-10 min-w-[168px] overflow-hidden rounded-lg border border-border bg-elevated shadow-pop"
                style={{
                  transformOrigin: 'left top',
                  animation: 'dropdown-in var(--duration-fast) var(--ease-smooth-out) both',
                }}
                onMouseEnter={() => window.clearTimeout(hoverTimer.current)}
              >
                <ContextMenuList
                  items={it.children}
                  onDone={onDone}
                  onBack={() => closeSubmenu(it.key)}
                  focusFirst={subFromKeyboard}
                />
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
 * (or the keyboard's context-menu key / Shift+F10) opens a portal menu at the
 * cursor (clamped to viewport) with the dropdown visual language. One level of
 * submenu, Esc/outside closes, arrows/Home/End/type-ahead move focus,
 * →/← enter and leave the submenu.
 */
export function ContextMenu({ items, children, disabled, className }: {
  items: ContextMenuEntry[]; children: ReactNode; disabled?: boolean; className?: string;
}) {
  const [at, setAt] = useState<{ x: number; y: number; keyboard: boolean } | null>(null);
  const [closing, setClosing] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({});
  const [origin, setOrigin] = useState('left top');
  const returnTo = useRef<HTMLElement | null>(null);
  const closingRef = useRef(false);
  const closeTimer = useRef<number | undefined>(undefined);

  const showMenu = (target: HTMLElement, x: number, y: number, keyboard: boolean) => {
    window.clearTimeout(closeTimer.current);
    closingRef.current = false;
    if (!at || closing) {
      returnTo.current = target.closest<HTMLElement>('a[href], button, [tabindex]:not([tabindex="-1"]), [role="button"]') ?? captureReturnTarget();
    }
    const rect = keyboard ? target.getBoundingClientRect() : null;
    setClosing(false);
    setAt(rect ? { x: rect.left + 8, y: rect.bottom, keyboard } : { x, y, keyboard });
  };

  const close = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (focusIsLost(menuRef.current)) restoreFocus(returnTo.current);
    setClosing(true);
    closeTimer.current = window.setTimeout(() => { closingRef.current = false; setAt(null); setClosing(false); }, 150);
  }, []);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

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
    if (!at || closing) return;
    const pop = overlayStack.push({ onEscape: close, element: () => menuRef.current });
    const list = menuRef.current?.querySelector<HTMLElement>('[role="menu"]');
    if (list && !list.contains(document.activeElement)) {
      const initial = at.keyboard ? menuItemsOf(list)[0] : undefined;
      (initial ?? list).focus({ preventScroll: true });
      if (!list.contains(document.activeElement)) list.focus({ preventScroll: true });
    }
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) close(); };
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', close);
    return () => {
      pop();
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', close);
    };
  }, [at, closing, close]);

  return (
    <>
      <div
        className={className ?? 'contents'}
        onKeyDown={(e) => {
          if (disabled || !((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) return;
          e.preventDefault();
          e.stopPropagation();
          showMenu(e.target as HTMLElement, 0, 0, true);
        }}
        onContextMenu={(e) => {
          if (disabled) return;
          e.preventDefault();
          e.stopPropagation();
          const native = e.nativeEvent as MouseEvent & { pointerType?: string };
          // Keyboard-opened (context-menu key, Shift+F10): no pointer, often no coordinates.
          const keyboard = native.pointerType !== undefined ? native.pointerType === '' : e.clientX === 0 && e.clientY === 0;
          showMenu(e.target as HTMLElement, e.clientX, e.clientY, keyboard);
        }}
      >
        {children}
      </div>
      {at && createPortal(
        <div
          ref={menuRef}
          inert={closing}
          aria-hidden={closing || undefined}
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
          <ContextMenuList items={items} onDone={close} />
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
  const translate = useT();
  const lastAnnounced = useRef(0);
  const [announcement, setAnnouncement] = useState<{ id: number; message: string; error: boolean }>({ id: 0, message: '', error: false });
  const list = useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => toasts,
  );
  useEffect(() => {
    const newest = list[list.length - 1];
    if (newest && newest.id > lastAnnounced.current) {
      lastAnnounced.current = newest.id;
      setAnnouncement({ id: newest.id, message: newest.message, error: newest.kind === 'error' });
    }
  }, [list]);
  return createPortal(
    <div data-overlay-keep className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {/* Keyed by toast id: the same text twice ("Saved.") is a new node, so it is announced again. */}
      <div role="status" aria-atomic="true" className="sr-only">{!announcement.error && <span key={announcement.id}>{announcement.message}</span>}</div>
      <div role="alert" aria-atomic="true" className="sr-only">{announcement.error && <span key={announcement.id}>{announcement.message}</span>}</div>
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
              type="button"
              onClick={() => { t.action!.onSelect(); dismiss(t.id); }}
              className="shrink-0 font-medium text-primary transition-colors hover:underline"
            >
              {t.action.label}
            </button>
          )}
          <button type="button" aria-label={translate('common.close')} onClick={() => dismiss(t.id)} className="grid h-6 w-6 shrink-0 place-items-center rounded text-faint transition-colors hover:text-foreground"><X size={13} /></button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
