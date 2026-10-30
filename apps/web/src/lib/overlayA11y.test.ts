/**
 * The overlay stack decides which overlay a key press belongs to. Before it,
 * every Dialog and DropdownMenu listened on window for itself, so Escape in a
 * picker inside a dialog closed both, and nothing kept focus out of the page
 * behind a dialog. These tests drive the stack with real Events on a plain
 * EventTarget – the unit environment has no DOM.
 */
import { describe, expect, it, vi } from 'vitest';
import { createOverlayStack, navIndex, typeaheadIndex, wrapTabIndex, KEEP_ATTR, type InertTarget } from './overlayA11y';

function keydown(key: string, init: { composing?: boolean } = {}): Event {
  const e = new Event('keydown', { cancelable: true });
  Object.defineProperty(e, 'key', { value: key });
  Object.defineProperty(e, 'isComposing', { value: !!init.composing });
  return e;
}

function el(attrs: string[] = []): InertTarget & { attrs: Set<string> } {
  const set = new Set(attrs);
  return {
    attrs: set,
    hasAttribute: (n) => set.has(n),
    setAttribute: (n) => { set.add(n); },
    removeAttribute: (n) => { set.delete(n); },
  };
}

describe('overlay stack – Escape', () => {
  it('closes only the topmost layer, one layer per press', () => {
    const win = new EventTarget();
    const stack = createOverlayStack(() => win);
    const dialog = vi.fn();
    const menu = vi.fn();
    stack.push({ onEscape: dialog, background: [] });
    const popMenu = stack.push({ onEscape: menu });

    win.dispatchEvent(keydown('Escape'));
    expect(menu).toHaveBeenCalledTimes(1);
    expect(dialog).not.toHaveBeenCalled();

    popMenu(); // the menu closed itself in response
    win.dispatchEvent(keydown('Escape'));
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(menu).toHaveBeenCalledTimes(1);
  });

  it('stops later window listeners from closing a second overlay for the same press', () => {
    const win = new EventTarget();
    const stack = createOverlayStack(() => win);
    const top = vi.fn();
    stack.push({ onEscape: top });
    const unregisteredPopover = vi.fn();
    win.addEventListener('keydown', unregisteredPopover);

    const e = keydown('Escape');
    win.dispatchEvent(e);
    expect(top).toHaveBeenCalledTimes(1);
    expect(unregisteredPopover).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(true);
  });

  it('leaves Escape alone when a field already handled it or an IME is composing', () => {
    const win = new EventTarget();
    const stack = createOverlayStack(() => win);
    const top = vi.fn();
    stack.push({ onEscape: top });

    const handled = keydown('Escape');
    handled.preventDefault(); // e.g. an editor suggestion list closing itself
    win.dispatchEvent(handled);
    win.dispatchEvent(keydown('Escape', { composing: true }));
    win.dispatchEvent(keydown('Enter'));
    expect(top).not.toHaveBeenCalled();
  });

  it('stops listening once the last layer is gone', () => {
    const win = new EventTarget();
    const remove = vi.spyOn(win, 'removeEventListener');
    const stack = createOverlayStack(() => win);
    const pop = stack.push({ onEscape: () => {} });
    pop();
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function));
    expect(stack.size()).toBe(0);
    pop(); // closing twice is harmless
    expect(stack.size()).toBe(0);
  });

  it('knows the layer below, for focus to fall back to', () => {
    const stack = createOverlayStack(() => new EventTarget());
    const a = { onEscape: () => {} };
    const b = { onEscape: () => {} };
    stack.push(a);
    stack.push(b);
    expect(stack.below(b)).toBe(a);
    expect(stack.below(a)).toBeUndefined();
    expect(stack.isTop(b)).toBe(true);
  });
});

describe('overlay stack – inert background', () => {
  it('makes the page behind a modal inert and releases it on close', () => {
    const stack = createOverlayStack(() => new EventTarget());
    const app = el();
    const toasts = el([KEEP_ATTR]);
    const pop = stack.push({ onEscape: () => {}, background: [app, toasts] });
    expect(app.attrs.has('inert')).toBe(true);
    expect(toasts.attrs.has('inert')).toBe(false); // toasts stay reachable

    pop();
    expect(app.attrs.has('inert')).toBe(false);
  });

  it('keeps menus opened over a dialog usable and hands back the right state for stacked dialogs', () => {
    const stack = createOverlayStack(() => new EventTarget());
    const app = el();
    const firstDialog = el();
    const popFirst = stack.push({ onEscape: () => {}, background: [app] });
    // A dropdown is non-modal: it never inerts anything.
    const popMenu = stack.push({ onEscape: () => {} });
    expect(firstDialog.attrs.has('inert')).toBe(false);
    popMenu();

    // A confirm dialog over the first one: the first goes inert too.
    const popSecond = stack.push({ onEscape: () => {}, background: [app, firstDialog] });
    expect(firstDialog.attrs.has('inert')).toBe(true);
    popSecond();
    expect(firstDialog.attrs.has('inert')).toBe(false);
    expect(app.attrs.has('inert')).toBe(true); // still behind the first dialog
    popFirst();
    expect(app.attrs.has('inert')).toBe(false);
  });

  it('does not release inert that something else set', () => {
    const stack = createOverlayStack(() => new EventTarget());
    const alreadyInert = el(['inert']);
    const pop = stack.push({ onEscape: () => {}, background: [alreadyInert] });
    pop();
    expect(alreadyInert.attrs.has('inert')).toBe(true);
  });

  it('copes with dialogs closing out of order', () => {
    const stack = createOverlayStack(() => new EventTarget());
    const app = el();
    const first = el();
    const popFirst = stack.push({ onEscape: () => {}, background: [app] });
    const popSecond = stack.push({ onEscape: () => {}, background: [app, first] });
    popFirst(); // the outer dialog went away first
    expect(app.attrs.has('inert')).toBe(true);
    expect(first.attrs.has('inert')).toBe(true);
    popSecond();
    expect(app.attrs.has('inert')).toBe(false);
    expect(first.attrs.has('inert')).toBe(false);
  });
});

describe('menu keyboard rules', () => {
  it('moves with arrows, wraps at the ends and jumps with Home/End', () => {
    expect(navIndex(3, -1, 'ArrowDown')).toBe(0);
    expect(navIndex(3, -1, 'ArrowUp')).toBe(2);
    expect(navIndex(3, 2, 'ArrowDown')).toBe(0);
    expect(navIndex(3, 0, 'ArrowUp')).toBe(2);
    expect(navIndex(3, 1, 'Home')).toBe(0);
    expect(navIndex(3, 1, 'End')).toBe(2);
    expect(navIndex(3, 1, 'ArrowRight', 'horizontal')).toBe(2);
    expect(navIndex(3, 1, 'ArrowRight')).toBeNull(); // not navigation in a vertical menu
    expect(navIndex(0, -1, 'ArrowDown')).toBeNull();
  });

  it('type-ahead finds the next match and cycles items sharing a letter', () => {
    const labels = ['Archive', 'Assign', 'Delete', 'Duplicate', 'Rename'];
    expect(typeaheadIndex(labels, -1, 'd')).toBe(2);
    expect(typeaheadIndex(labels, 2, 'dd')).toBe(3); // same letter again: next "D…"
    expect(typeaheadIndex(labels, 3, 'd')).toBe(2); // wraps around
    expect(typeaheadIndex(labels, 0, 'as')).toBe(1); // a word, not a cycle
    expect(typeaheadIndex(labels, 1, 'ass')).toBe(1); // still matching: stays put
    expect(typeaheadIndex(labels, 0, 'z')).toBe(-1);
  });

  it('wraps Tab inside a dialog only at its edges', () => {
    expect(wrapTabIndex(3, 2, false)).toBe(0);
    expect(wrapTabIndex(3, 0, true)).toBe(2);
    expect(wrapTabIndex(3, 1, false)).toBeNull(); // the browser moves on normally
    expect(wrapTabIndex(3, -1, false)).toBe(0); // focus on the panel itself
    expect(wrapTabIndex(3, -1, true)).toBe(2);
    expect(wrapTabIndex(0, -1, false)).toBeNull();
  });
});
