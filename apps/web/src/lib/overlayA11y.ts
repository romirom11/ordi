/**
 * Accessibility plumbing shared by the overlay primitives (Dialog,
 * DropdownMenu, ContextMenu, the command palette).
 *
 * One stack orders every open overlay, so Escape closes only the topmost one:
 * a picker inside a dialog used to take the dialog down with it, because each
 * overlay listened on window for itself. A modal layer also makes everything
 * that was on the page before it `inert` – menus and popovers it opens later
 * are portaled after it, so they stay usable without any registration.
 *
 * The pieces are written against minimal structural types so the ordering and
 * keyboard rules can be unit-tested without a DOM.
 */

/* ───────────────────────── Layer stack ───────────────────────── */

/** The parts of an element the inert bookkeeping touches. */
export interface InertTarget {
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

export interface OverlayLayer {
  /** Runs when Escape reaches this layer while it is the topmost one. */
  onEscape: () => void;
  /** The layer's surface – where focus falls back to when a layer above it closes. */
  element?: () => HTMLElement | null;
  /**
   * Modal layers only: the page that was there when the layer opened (direct
   * children of <body>, minus the layer's own root). It goes inert while this
   * is the topmost modal layer.
   */
  background?: InertTarget[];
}

/** Elements carrying this attribute are never made inert (the toast region). */
export const KEEP_ATTR = 'data-overlay-keep';

type KeyTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

export function createOverlayStack(getTarget: () => KeyTarget | undefined) {
  const layers: OverlayLayer[] = [];
  const managedInert = new Set<InertTarget>();
  let target: KeyTarget | undefined;

  const onKeyDown = (event: Event) => {
    const e = event as KeyboardEvent;
    // Something closer to the focus already handled it (an inline editor that
    // reverts on Escape, an editor suggestion list), or an IME is composing.
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
    const top = layers[layers.length - 1];
    if (!top) return;
    e.preventDefault();
    // Window listeners added later (an unregistered popover) would close a
    // second layer for the same key press.
    e.stopImmediatePropagation();
    top.onEscape();
  };

  /** Inert exactly the background of the topmost modal layer – nothing else. */
  const syncInert = () => {
    let topModal: OverlayLayer | undefined;
    for (let i = layers.length - 1; i >= 0; i--) {
      if (layers[i]!.background) { topModal = layers[i]; break; }
    }
    const wanted = new Set(topModal?.background ?? []);
    for (const el of managedInert) {
      if (!wanted.has(el)) { el.removeAttribute('inert'); managedInert.delete(el); }
    }
    for (const el of wanted) {
      if (managedInert.has(el) || el.hasAttribute(KEEP_ATTR)) continue;
      // Already inert for some other reason: not ours to release later.
      if (el.hasAttribute('inert')) continue;
      el.setAttribute('inert', '');
      managedInert.add(el);
    }
  };

  const remove = (layer: OverlayLayer) => {
    const i = layers.indexOf(layer);
    if (i === -1) return;
    layers.splice(i, 1);
    syncInert();
    if (layers.length === 0 && target) {
      target.removeEventListener('keydown', onKeyDown);
      target = undefined;
    }
  };

  return {
    /** Register an open overlay on top; returns its removal. */
    push(layer: OverlayLayer): () => void {
      layers.push(layer);
      syncInert();
      if (!target) {
        target = getTarget();
        target?.addEventListener('keydown', onKeyDown);
      }
      return () => remove(layer);
    },
    isTop(layer: OverlayLayer): boolean {
      return layers[layers.length - 1] === layer;
    },
    /** The layer just below `layer`, if any – where focus falls back to. */
    below(layer: OverlayLayer): OverlayLayer | undefined {
      const i = layers.indexOf(layer);
      return i > 0 ? layers[i - 1] : undefined;
    },
    size(): number {
      return layers.length;
    },
  };
}

export const overlayStack = createOverlayStack(() => (typeof window === 'undefined' ? undefined : window));

/* ───────────────────────── Keyboard rules ───────────────────────── */

/**
 * Index the roving cursor moves to for a navigation key, wrapping at the ends.
 * `current` is -1 when nothing in the list has focus yet. Returns null for a
 * key that is not list navigation.
 */
export function navIndex(count: number, current: number, key: string, orientation: 'vertical' | 'horizontal' = 'vertical'): number | null {
  if (count === 0) return null;
  const next = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
  const prev = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === next) return current < 0 ? 0 : (current + 1) % count;
  if (key === prev) return current < 0 ? count - 1 : (current - 1 + count) % count;
  return null;
}

/**
 * Type-to-select: the first label after `current` (wrapping) that starts with
 * the typed prefix. A prefix of one repeated letter cycles through the items
 * sharing that letter, the way native menus behave.
 */
export function typeaheadIndex(labels: string[], current: number, prefix: string): number {
  const needle = prefix.toLowerCase();
  if (!needle || labels.length === 0) return -1;
  const repeated = needle.split('').every((ch) => ch === needle[0]);
  const search = repeated ? needle[0]! : needle;
  // Continuing a word keeps the current item if it still matches.
  const start = repeated ? current + 1 : Math.max(current, 0);
  for (let step = 0; step < labels.length; step++) {
    const i = (start + step) % labels.length;
    if (labels[i]!.trim().toLowerCase().startsWith(search)) return i;
  }
  return -1;
}

/** Where Tab should land inside a focus-contained surface, or null to let the browser move on. */
export function wrapTabIndex(count: number, current: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (current < 0) return shift ? count - 1 : 0;
  if (!shift && current === count - 1) return 0;
  if (shift && current === 0) return count - 1;
  return null;
}

/* ───────────────────────── DOM helpers ───────────────────────── */

const TABBABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', 'summary',
  '[contenteditable=""]', '[contenteditable="true"]', '[tabindex]',
].join(',');

function isVisible(el: HTMLElement): boolean {
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/** Elements Tab can reach inside `root`, in DOM order. */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE))
    .filter((el) => el.tabIndex >= 0 && !el.closest('[inert]') && isVisible(el));
}

/** Enabled menu items that belong to `menu` itself (not to a nested submenu). */
export function menuItemsOf(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"]'))
    .filter((el) => el.closest('[role="menu"]') === menu
      && !(el as HTMLButtonElement).disabled
      && el.getAttribute('aria-disabled') !== 'true'
      && isVisible(el));
}

/** A field that owns its own keys (arrows move the caret, letters type). */
export function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'range', 'color', 'file'].includes(type);
  }
  return (el as HTMLElement).isContentEditable === true;
}

function focusable(el: HTMLElement | null | undefined): el is HTMLElement {
  return !!el && el.isConnected && !el.closest('[inert]') && !(el as HTMLButtonElement).disabled && isVisible(el);
}

/* Safari and the WebKit desktop shell do not focus a button on click, so
 * document.activeElement says <body> right after a mouse-opened dialog. The
 * last pointer-down target stands in for it. */
let lastPointer: { el: Element; at: number } | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (e) => {
    if (e.target instanceof Element) lastPointer = { el: e.target, at: Date.now() };
  }, true);
}

/** The element focus should go back to when an overlay that is opening now closes. */
export function captureReturnTarget(): HTMLElement | null {
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== document.body) return active;
  if (lastPointer && Date.now() - lastPointer.at < 1000 && lastPointer.el.isConnected) {
    const host = lastPointer.el.closest<HTMLElement>(`${TABBABLE},[role="button"]`);
    if (host) return host;
  }
  return null;
}

/** True when focus is nowhere useful – on <body>, or inside `within` (a closing overlay). */
export function focusIsLost(within?: Element | null): boolean {
  const active = document.activeElement;
  return !active || active === document.body || (!!within && within.contains(active));
}

/**
 * Focus `target`, or a logical replacement if it is gone (the row a delete
 * confirmation was opened from no longer exists): the first tabbable spot of
 * `fallback`, else the page's <main>.
 */
export function restoreFocus(target: HTMLElement | null, fallback?: HTMLElement | null): void {
  if (focusable(target)) {
    target.focus({ preventScroll: true });
    if (document.activeElement === target) return;
  }
  if (fallback && fallback.isConnected) {
    const first = tabbables(fallback)[0];
    (first ?? fallback).focus({ preventScroll: true });
    if (fallback.contains(document.activeElement)) return;
  }
  const main = document.querySelector<HTMLElement>('main');
  if (main && !main.closest('[inert]')) {
    if (!main.hasAttribute('tabindex')) {
      main.setAttribute('tabindex', '-1');
      main.setAttribute('data-focus-fallback', '');
    }
    main.focus({ preventScroll: true });
  }
}
