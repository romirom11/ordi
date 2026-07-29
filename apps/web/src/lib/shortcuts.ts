/**
 * The app's keyboard scheme, in one table (PRD §17.1).
 *
 * Every shortcut is declared exactly once: `match` is what a key handler runs,
 * `keys` is what the help sheet prints. Declaring the two separately is how a
 * scheme drifts out of sync with its own documentation, so handlers import the
 * matchers from here rather than re-deriving them from key codes.
 *
 * Platform note: `mod` is ⌘ on macOS and Ctrl elsewhere. A handful of browser
 * combinations (⌘T, ⌘W, ⌘1…9) cannot be intercepted in a normal tab; they are
 * still declared because the desktop shell owns them, and the browser simply
 * keeps its own behaviour. Where a browser-safe alternative exists (Alt+W for
 * closing a tab) both are bound.
 */

export type ShortcutGroup = 'general' | 'tabs' | 'navigation' | 'editor';

export interface Shortcut {
  id: string;
  group: ShortcutGroup;
  /** Chips rendered by the help sheet, already platform-resolved. */
  keys: readonly string[];
  /** i18n key for the one-line description. */
  labelKey: string;
  /**
   * Matches a keydown event. Absent when the behaviour is documented but has no
   * single matcher of its own (the G chord, whose second step is dynamic).
   */
  match?: (e: KeyboardEvent) => boolean;
}

/** True on Apple platforms, where the modifier is ⌘ rather than Ctrl. */
export const isApple: boolean =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent);

export const MOD = isApple ? '⌘' : 'Ctrl';
const ALT = isApple ? '⌥' : 'Alt';
const SHIFT = isApple ? '⇧' : 'Shift';

/* ── Matchers ────────────────────────────────────────────────────────────── */

const mod = (e: KeyboardEvent): boolean => e.metaKey || e.ctrlKey;

/** ⌘/Ctrl + code, with no other modifier. */
export function isMod(e: KeyboardEvent, code: string): boolean {
  return mod(e) && !e.shiftKey && !e.altKey && e.code === code;
}

/** ⌘/Ctrl + Shift + code. */
export function isModShift(e: KeyboardEvent, code: string): boolean {
  return mod(e) && e.shiftKey && !e.altKey && e.code === code;
}

/** Alt + code, without ⌘/Ctrl – the combinations a browser tab leaves alone. */
export function isAlt(e: KeyboardEvent, code: string): boolean {
  return e.altKey && !e.metaKey && !e.ctrlKey && e.code === code;
}

/**
 * True when the event targets something the user is typing into. Bare-letter
 * shortcuts must yield to it, or typing "c" in a comment opens a task dialog.
 */
export function isTypingTarget(e: KeyboardEvent | { target: EventTarget | null }): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/**
 * Digit row for ⌘1…⌘9. Returns the 1-based index, or 0 when the event is not a
 * mod+digit. Digit codes are used rather than `key` so a non-Latin layout still
 * reaches the right tab.
 */
export function modDigit(e: KeyboardEvent): number {
  if (!mod(e) || e.shiftKey || e.altKey) return 0;
  const m = /^Digit([1-9])$/.exec(e.code);
  return m ? Number(m[1]) : 0;
}

/* ── The scheme ──────────────────────────────────────────────────────────── */

/** Destinations reachable with the G chord. Shared by the handler and the help. */
export const GO_TO: readonly { key: string; to: string; labelKey: string }[] = [
  { key: 'd', to: '/', labelKey: 'nav.dashboard' },
  { key: 'm', to: '/my-tasks', labelKey: 'nav.myTasks' },
  { key: 'p', to: '/projects', labelKey: 'nav.projects' },
  { key: 'c', to: '/crm', labelKey: 'nav.crm' },
  { key: 'k', to: '/kb', labelKey: 'nav.knowledge' },
  { key: 't', to: '/time', labelKey: 'nav.time' },
  { key: 'f', to: '/finance', labelKey: 'nav.finance' },
  { key: 'e', to: '/people', labelKey: 'nav.people' },
  { key: 'r', to: '/resourcing', labelKey: 'nav.resourcing' },
  { key: 'b', to: '/dashboards', labelKey: 'nav.dashboards' },
  { key: 's', to: '/settings', labelKey: 'nav.settings' },
];

export const SHORTCUTS: readonly Shortcut[] = [
  /* General */
  { id: 'palette', group: 'general', keys: [MOD, 'K'], labelKey: 'keys.palette', match: (e) => isMod(e, 'KeyK') },
  { id: 'quickAdd', group: 'general', keys: ['C'], labelKey: 'keys.quickAdd' },
  { id: 'stopTimer', group: 'general', keys: ['T'], labelKey: 'keys.stopTimer' },
  { id: 'help', group: 'general', keys: [SHIFT, '?'], labelKey: 'keys.help', match: (e) => e.key === '?' && !mod(e) },
  { id: 'dismiss', group: 'general', keys: ['Esc'], labelKey: 'keys.dismiss' },

  /* Tabs */
  { id: 'newTab', group: 'tabs', keys: [MOD, 'T'], labelKey: 'keys.newTab', match: (e) => isMod(e, 'KeyT') || isAlt(e, 'KeyT') },
  { id: 'closeTab', group: 'tabs', keys: [ALT, 'W'], labelKey: 'keys.closeTab', match: (e) => isAlt(e, 'KeyW') },
  { id: 'reopenTab', group: 'tabs', keys: [MOD, SHIFT, 'T'], labelKey: 'keys.reopenTab', match: (e) => isModShift(e, 'KeyT') },
  { id: 'nextTab', group: 'tabs', keys: [MOD, SHIFT, ']'], labelKey: 'keys.nextTab', match: (e) => isModShift(e, 'BracketRight') },
  { id: 'prevTab', group: 'tabs', keys: [MOD, SHIFT, '['], labelKey: 'keys.prevTab', match: (e) => isModShift(e, 'BracketLeft') },
  { id: 'nthTab', group: 'tabs', keys: [MOD, '1…9'], labelKey: 'keys.nthTab' },

  /* Navigation */
  { id: 'back', group: 'navigation', keys: [MOD, '['], labelKey: 'keys.back', match: (e) => isMod(e, 'BracketLeft') || isAlt(e, 'ArrowLeft') },
  { id: 'forward', group: 'navigation', keys: [MOD, ']'], labelKey: 'keys.forward', match: (e) => isMod(e, 'BracketRight') || isAlt(e, 'ArrowRight') },
  { id: 'goTo', group: 'navigation', keys: ['G', '→'], labelKey: 'keys.goTo' },
  { id: 'openNewTab', group: 'navigation', keys: [MOD, 'click'], labelKey: 'keys.openNewTab' },
  { id: 'openNewTabMiddle', group: 'navigation', keys: ['Middle click'], labelKey: 'keys.openNewTabMiddle' },

  /* Editor */
  { id: 'editorSlash', group: 'editor', keys: ['/'], labelKey: 'keys.editorSlash' },
  { id: 'editorMention', group: 'editor', keys: ['@'], labelKey: 'keys.editorMention' },
  { id: 'editorRef', group: 'editor', keys: ['+'], labelKey: 'keys.editorRef' },
  { id: 'editorBold', group: 'editor', keys: [MOD, 'B'], labelKey: 'keys.editorBold' },
  { id: 'editorItalic', group: 'editor', keys: [MOD, 'I'], labelKey: 'keys.editorItalic' },
  { id: 'editorUnderline', group: 'editor', keys: [MOD, 'U'], labelKey: 'keys.editorUnderline' },
  { id: 'editorStrike', group: 'editor', keys: [MOD, SHIFT, 'X'], labelKey: 'keys.editorStrike' },
  { id: 'editorCode', group: 'editor', keys: [MOD, 'E'], labelKey: 'keys.editorCode' },
  { id: 'editorHighlight', group: 'editor', keys: [MOD, SHIFT, 'H'], labelKey: 'keys.editorHighlight' },
  { id: 'editorLink', group: 'editor', keys: [MOD, 'K'], labelKey: 'keys.editorLink' },
  { id: 'editorHeading', group: 'editor', keys: [MOD, ALT, '1…3'], labelKey: 'keys.editorHeading' },
  { id: 'editorSubmit', group: 'editor', keys: [MOD, '↵'], labelKey: 'keys.editorSubmit' },
];

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = ['general', 'tabs', 'navigation', 'editor'];

/** The declared shortcut for an id – used for tooltips that print a hint. */
export function shortcutKeys(id: string): string {
  const s = SHORTCUTS.find((x) => x.id === id);
  return s ? s.keys.join(isApple ? '' : '+') : '';
}
