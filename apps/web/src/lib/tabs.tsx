/**
 * In-app tab system (Linear-style): open tasks/projects/pages in browser-like
 * tabs inside the app shell.
 *
 * Model: tabs = [{id, url, title}] + activeId, persisted to localStorage.
 * Semantics are browser-like – normal navigation rewrites the ACTIVE tab;
 * Ctrl/Cmd/middle-click on internal links opens a new tab (see lib/router.tsx).
 * Pages call usePageTitle(title) to name the active tab; a fallback title is
 * derived from the URL until they do.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { NewTabContext, usePathname, useRouter } from './router';

export interface TabItem {
  id: string;
  url: string;
  /** Registered by the page via usePageTitle. '' → fallback derived from url. */
  title: string;
  /** Per-tab navigation stack, oldest first. Always contains `url` at `pos`. */
  history: string[];
  /** Index of `url` inside `history`; entries after it are the forward stack. */
  pos: number;
}

interface TabsState { tabs: TabItem[]; activeId: string }

export interface TabsApi {
  tabs: TabItem[];
  activeId: string;
  /** Open url in a new tab (inserted after the active one) and switch to it. */
  openInNewTab: (url: string) => void;
  /** Open a fresh tab at '/'. */
  newTab: () => void;
  closeTab: (id: string) => void;
  /** Put the most recently closed tab back where it was (⌘⇧T). */
  reopenClosed: () => void;
  activateTab: (id: string) => void;
  /** Switch to the next (+1) / previous (-1) tab, cycling. */
  activateDelta: (delta: number) => void;
  /** Jump to the nth tab, 1-based; n beyond the end lands on the last one. */
  activateIndex: (n: number) => void;
  /** Drag-reorder: move `id` to the slot currently held by `targetId`. */
  reorderTabs: (id: string, targetId: string) => void;
  setActiveTitle: (title: string) => void;
  /** Step the ACTIVE tab through its own history: -1 back, +1 forward. */
  go: (delta: number) => void;
  canGoBack: boolean;
  canGoForward: boolean;
}

const STORAGE_KEY = 'ordi:tabs';
/** Cap the per-tab stack so long sessions cannot grow localStorage without bound. */
const MAX_HISTORY = 50;
/** How many closed tabs ⌘⇧T can walk back through. Session-only, never persisted. */
const MAX_CLOSED = 10;
const TabsContext = createContext<TabsApi | null>(null);

let seq = 0;
function newId(): string {
  return `t${Date.now().toString(36)}${(seq++).toString(36)}`;
}

function currentUrl(): string {
  return window.location.pathname + window.location.search;
}

function makeTab(url: string): TabItem {
  return { id: newId(), url, title: '', history: [url], pos: 0 };
}

/**
 * Record a navigation on a tab. Landing on the entry either side of the current
 * one is treated as a move within the stack rather than a new entry, so the
 * browser's own back/forward buttons stay in step with the in-tab arrows.
 */
function advance(tab: TabItem, url: string): TabItem {
  const { history, pos } = tab;
  if (history[pos - 1] === url) return { ...tab, url, title: '', pos: pos - 1 };
  if (history[pos + 1] === url) return { ...tab, url, title: '', pos: pos + 1 };
  const next = [...history.slice(0, pos + 1), url].slice(-MAX_HISTORY);
  return { ...tab, url, title: '', history: next, pos: next.length - 1 };
}

function loadInitial(): TabsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<TabsState>;
      const tabs = (Array.isArray(parsed.tabs) ? parsed.tabs : [])
        .filter((t): t is TabItem => !!t && typeof (t as TabItem).id === 'string'
          && typeof (t as TabItem).url === 'string' && (t as TabItem).url.startsWith('/'))
        .map((t) => {
          // Tabs persisted before per-tab history existed start a fresh stack.
          const stack = Array.isArray(t.history) && t.history.every((u) => typeof u === 'string' && u.startsWith('/'))
            ? t.history.slice(-MAX_HISTORY) : [t.url];
          const at = typeof t.pos === 'number' && stack[t.pos] === t.url ? t.pos : stack.indexOf(t.url);
          const pos = at >= 0 ? at : stack.length - 1;
          return {
            id: t.id, url: t.url, title: typeof t.title === 'string' ? t.title : '',
            history: stack[pos] === t.url ? stack : [t.url], pos: stack[pos] === t.url ? pos : 0,
          };
        });
      if (tabs.length) {
        // Browser URL wins on restore: prefer the tab matching the current URL.
        const url = currentUrl();
        const match = tabs.find((t) => t.url === url);
        const activeId = match?.id
          ?? (tabs.some((t) => t.id === parsed.activeId) ? parsed.activeId! : tabs[0]!.id);
        return { tabs, activeId };
      }
    }
  } catch { /* private mode / corrupt state */ }
  const tab = makeTab(currentUrl());
  return { tabs: [tab], activeId: tab.id };
}

export function TabsProvider({ children }: { children: ReactNode }) {
  const { path, navigate } = useRouter();
  const [state, setState] = useState<TabsState>(loadInitial);

  const stateRef = useRef(state);
  stateRef.current = state;
  /** Closed tabs, newest first, with the slot each one occupied. */
  const closedRef = useRef<{ tab: TabItem; at: number }[]>([]);

  // Browser-like semantics: any normal navigation rewrites the ACTIVE tab.
  // This runs during render (render-phase state update) so it settles BEFORE
  // page children mount – a page's usePageTitle() effect always runs after the
  // url sync and its registered title is never clobbered.
  const active = state.tabs.find((t) => t.id === state.activeId);
  if (active && active.url !== path) {
    setState((s) => ({
      ...s,
      tabs: s.tabs.map((t) => (t.id === s.activeId && t.url !== path ? advance(t, path) : t)),
    }));
  }

  // Persist
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* private mode */ }
  }, [state]);

  const activateTab = useCallback((id: string) => {
    const tab = stateRef.current.tabs.find((t) => t.id === id);
    if (!tab || id === stateRef.current.activeId) return;
    setState((s) => ({ ...s, activeId: id }));
    if (tab.url !== currentUrl()) navigate(tab.url);
  }, [navigate]);

  const openInNewTab = useCallback((url: string) => {
    const tab = makeTab(url);
    setState((s) => {
      const idx = s.tabs.findIndex((t) => t.id === s.activeId);
      const tabs = [...s.tabs];
      tabs.splice(idx < 0 ? tabs.length : idx + 1, 0, tab);
      return { tabs, activeId: tab.id };
    });
    if (url !== currentUrl()) navigate(url);
  }, [navigate]);

  const newTab = useCallback(() => openInNewTab('/'), [openInNewTab]);

  const closeTab = useCallback((id: string) => {
    const s = stateRef.current;
    const idx = s.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const closed = s.tabs[idx]!;
    // Remember where it sat so ⌘⇧T restores the strip, not just the url.
    closedRef.current = [{ tab: closed, at: idx }, ...closedRef.current].slice(0, MAX_CLOSED);
    const rest = s.tabs.filter((t) => t.id !== id);
    if (rest.length === 0) {
      // Closing the last tab leaves a single tab at '/'.
      const tab = makeTab('/');
      setState({ tabs: [tab], activeId: tab.id });
      if (currentUrl() !== '/') navigate('/');
      return;
    }
    if (id === s.activeId) {
      const next = rest[Math.min(idx, rest.length - 1)]!;
      setState({ tabs: rest, activeId: next.id });
      if (next.url !== currentUrl()) navigate(next.url);
    } else {
      setState({ tabs: rest, activeId: s.activeId });
    }
  }, [navigate]);

  const reopenClosed = useCallback(() => {
    const entry = closedRef.current[0];
    if (!entry) return;
    closedRef.current = closedRef.current.slice(1);
    // A fresh id: the old one may still be alive if the tab was duplicated.
    const tab: TabItem = { ...entry.tab, id: newId() };
    setState((s) => {
      const tabs = [...s.tabs];
      tabs.splice(Math.min(entry.at, tabs.length), 0, tab);
      return { tabs, activeId: tab.id };
    });
    if (tab.url !== currentUrl()) navigate(tab.url);
  }, [navigate]);

  const activateDelta = useCallback((delta: number) => {
    const s = stateRef.current;
    if (s.tabs.length < 2) return;
    const idx = s.tabs.findIndex((t) => t.id === s.activeId);
    const next = s.tabs[(idx + delta + s.tabs.length) % s.tabs.length];
    if (next) activateTab(next.id);
  }, [activateTab]);

  const activateIndex = useCallback((n: number) => {
    const s = stateRef.current;
    // Browser convention: the highest digit means "last tab", not "ninth".
    const tab = n >= 9 ? s.tabs[s.tabs.length - 1] : s.tabs[n - 1];
    if (tab) activateTab(tab.id);
  }, [activateTab]);

  const reorderTabs = useCallback((id: string, targetId: string) => {
    if (id === targetId) return;
    setState((s) => {
      const from = s.tabs.findIndex((t) => t.id === id);
      const to = s.tabs.findIndex((t) => t.id === targetId);
      if (from === -1 || to === -1) return s;
      const tabs = s.tabs.slice();
      const [moved] = tabs.splice(from, 1);
      tabs.splice(to, 0, moved!);
      return { ...s, tabs };
    });
  }, []);

  const go = useCallback((delta: number) => {
    const s = stateRef.current;
    const tab = s.tabs.find((t) => t.id === s.activeId);
    if (!tab) return;
    const pos = tab.pos + delta;
    const url = tab.history[pos];
    if (url === undefined || url === tab.url) return;
    setState((st) => ({
      ...st,
      tabs: st.tabs.map((t) => (t.id === st.activeId ? { ...t, url, title: '', pos } : t)),
    }));
    navigate(url);
  }, [navigate]);

  const setActiveTitle = useCallback((title: string) => {
    setState((s) => {
      const tab = s.tabs.find((t) => t.id === s.activeId);
      if (!tab || tab.title === title) return s;
      return { ...s, tabs: s.tabs.map((t) => (t.id === s.activeId ? { ...t, title } : t)) };
    });
  }, []);

  const activeTab = state.tabs.find((t) => t.id === state.activeId);
  const api = useMemo<TabsApi>(() => ({
    tabs: state.tabs,
    activeId: state.activeId,
    openInNewTab, newTab, closeTab, reopenClosed, activateTab, activateDelta, activateIndex,
    reorderTabs, setActiveTitle, go,
    canGoBack: !!activeTab && activeTab.pos > 0,
    canGoForward: !!activeTab && activeTab.pos < activeTab.history.length - 1,
  }), [state.tabs, state.activeId, openInNewTab, newTab, closeTab, reopenClosed, activateTab,
    activateDelta, activateIndex, reorderTabs, setActiveTitle, go, activeTab]);

  return (
    <TabsContext.Provider value={api}>
      <NewTabContext.Provider value={openInNewTab}>
        {children}
      </NewTabContext.Provider>
    </TabsContext.Provider>
  );
}

/** Tab API, or null outside TabsProvider (e.g. public pages). */
export function useTabs(): TabsApi | null {
  return useContext(TabsContext);
}

/**
 * Register the active tab's title (and document.title). Pages call this –
 * PageHeader does it automatically for plain-string titles. Safe no-op when
 * TabsProvider is absent (public pages) or title is empty/undefined.
 */
export function usePageTitle(title?: string | null): void {
  const ctx = useContext(TabsContext);
  const path = usePathname();
  const setActiveTitle = ctx?.setActiveTitle;
  useEffect(() => {
    if (!title) return;
    document.title = `${title} · ordi`;
    setActiveTitle?.(title);
    // path in deps: re-register when switching between tabs showing pages
    // with identical titles (effect must re-run for the newly active tab).
  }, [title, setActiveTitle, path]);
}

/* ── Fallback titles derived from the URL (until a page registers one) ── */

const SEGMENT_TITLE_KEYS: Record<string, string> = {
  '': 'nav.dashboard',
  'my-tasks': 'nav.myTasks',
  projects: 'nav.projects',
  crm: 'nav.crm',
  companies: 'nav.crm',
  deals: 'nav.crm',
  kb: 'nav.knowledge',
  time: 'nav.time',
  finance: 'nav.finance',
  people: 'nav.people',
  resourcing: 'nav.resourcing',
  dashboards: 'nav.dashboards',
  settings: 'nav.settings',
  profile: 'nav.profile',
};

/** Human title for a url when the page hasn't registered one yet. */
export function tabFallbackTitle(url: string, t: (key: string, fallback?: string) => string): string {
  const seg = url.split('?')[0]!.split('/').filter(Boolean)[0] ?? '';
  const key = SEGMENT_TITLE_KEYS[seg];
  if (key) return t(key);
  return seg ? seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-/g, ' ') : t('nav.dashboard');
}
