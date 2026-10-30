import { type ReactNode, type KeyboardEvent as ReactKeyboardEvent, useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, CheckSquare, Handshake, FolderKanban, BookText,
  Clock, Receipt, Users, Settings, Search, LogOut, LayoutGrid, CalendarRange,
  SquarePen, Sun, Moon, Monitor, ChevronDown, ChevronRight, GripVertical, User as UserIcon,
  SquareArrowOutUpRight, Link as LinkIcon, ArrowUp, ArrowDown,
  MonitorDown, UserPlus, PanelLeft, X,
} from 'lucide-react';
import { Link, usePathname, useNavigate } from '../lib/router';
import { useMe, useCan } from '../lib/auth';
import { appOrigin, api, setSessionToken } from '../lib/api';
import { useRealtime } from '../lib/sse';
import { useT, extendDict } from '../lib/i18n';
import { useTheme, type ThemePref } from '../lib/theme';
import { initDesktop, restartDesktop, isTauri, isMacDesktop } from '../lib/desktop';
import { TabsProvider, useTabs } from '../lib/tabs';
import { Avatar, cn, Kbd, Tooltip, IconButton } from './ui';
import { ContextMenu, DropdownMenu, MenuItem, MenuSeparator, MenuLabel, Toaster, toast, type ContextMenuEntry } from './overlays';
import { CommandPalette } from './CommandPalette';
import { TimerIndicator } from './TimerIndicator';
import { NotificationsBell } from './NotificationsBell';
import { QuickCreateTask } from './QuickCreateTask';
import { TabStrip } from './tabs/TabStrip';
import { ShortcutsDialog } from './ShortcutsDialog';
import { GO_TO, MOD, SHORTCUTS, isTypingTarget } from '../lib/shortcuts';
import { isNavActive } from '../lib/navSection';
import { VersionGuard } from './VersionGuard';
import { useActiveTimer, useStopTimer } from '../lib/timer';
import { useScrollRestoration } from '../lib/scrollRestoration';

extendDict({
  en: {
    'ctx.openInNewTab': 'Open in new tab',
    'ctx.copyLink': 'Copy link',
    'ctx.linkCopied': 'Link copied',
    'ctx.moveUp': 'Move up',
    'ctx.moveDown': 'Move down',
    'ctx.collapseSection': 'Collapse section',
    'ctx.expandSection': 'Expand section',
    'nav.section.work': 'Work',
    'nav.section.operations': 'Operations',
    'nav.section.insights': 'Insights',
  },
  uk: {
    'ctx.openInNewTab': 'Відкрити в новій вкладці',
    'ctx.copyLink': 'Копіювати посилання',
    'ctx.linkCopied': 'Посилання скопійовано',
    'ctx.moveUp': 'Перемістити вгору',
    'ctx.moveDown': 'Перемістити вниз',
    'ctx.collapseSection': 'Згорнути секцію',
    'ctx.expandSection': 'Розгорнути секцію',
    'nav.section.work': 'Робота',
    'nav.section.operations': 'Операції',
    'nav.section.insights': 'Аналітика',
  },
});

type NavSection = 'main' | 'work' | 'operations' | 'insights';

interface NavDef {
  key: string; to: string; labelKey: string; icon: ReactNode;
  section: NavSection;
  perm?: string; anyAuth?: boolean;
  /** Workspace module toggle key – hidden when modules[module] === false. */
  module?: string;
}

/** Stable nav catalog – user-defined order is stored as a flat list of keys. */
const NAV_DEFS: NavDef[] = [
  { key: 'dashboard', to: '/', labelKey: 'nav.dashboard', icon: <LayoutDashboard size={16} />, anyAuth: true, section: 'main' },
  { key: 'myTasks', to: '/my-tasks', labelKey: 'nav.myTasks', icon: <CheckSquare size={16} />, anyAuth: true, section: 'main' },
  { key: 'projects', to: '/projects', labelKey: 'nav.projects', icon: <FolderKanban size={16} />, anyAuth: true, section: 'work' },
  { key: 'crm', to: '/crm', labelKey: 'nav.crm', icon: <Handshake size={16} />, perm: 'crm.read', section: 'work', module: 'crm' },
  { key: 'kb', to: '/kb', labelKey: 'nav.knowledge', icon: <BookText size={16} />, perm: 'kb.read', section: 'work', module: 'kb' },
  { key: 'time', to: '/time', labelKey: 'nav.time', icon: <Clock size={16} />, perm: 'time.track', section: 'operations', module: 'time' },
  { key: 'finance', to: '/finance', labelKey: 'nav.finance', icon: <Receipt size={16} />, perm: 'finance.read', section: 'operations', module: 'finance' },
  // anyAuth: the directory is the workspace's own phone book – the API serves
  // a public slice to viewers without people.read (items with neither perm nor
  // anyAuth are hidden for everyone by the nav filter).
  { key: 'people', to: '/people', labelKey: 'nav.people', icon: <Users size={16} />, anyAuth: true, section: 'operations', module: 'people' },
  { key: 'resourcing', to: '/resourcing', labelKey: 'nav.resourcing', icon: <CalendarRange size={16} />, perm: 'projects.read', section: 'operations', module: 'resourcing' },
  { key: 'dashboards', to: '/dashboards', labelKey: 'nav.dashboards', icon: <LayoutGrid size={16} />, anyAuth: true, section: 'insights', module: 'dashboards' },
];

const SECTIONS: { key: NavSection; labelKey?: string }[] = [
  { key: 'main' },
  { key: 'work', labelKey: 'nav.section.work' },
  { key: 'operations', labelKey: 'nav.section.operations' },
  { key: 'insights', labelKey: 'nav.section.insights' },
];

const NAV_ORDER_KEY = 'ordi:navOrder';
const NAV_COLLAPSED_KEY = 'ordi:navCollapsed';
const SIDEBAR_HIDDEN_KEY = 'ordi:sidebarHidden';

/**
 * Below this width the 224px sidebar would leave the page too little room
 * (a 390px phone kept 166px for content), so it becomes a drawer opened from
 * the tab strip. The desktop app's minimum window width is 900, so it never
 * reaches compact mode – there the sidebar can only be hidden by choice.
 */
const COMPACT_QUERY = '(max-width: 899px)';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

function loadSidebarHidden(): boolean {
  try { return localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1'; } catch { return false; }
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function loadNavOrder(): string[] {
  try {
    const raw = localStorage.getItem(NAV_ORDER_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) return arr;
    }
  } catch { /* private mode */ }
  return NAV_DEFS.map((n) => n.key);
}

function loadCollapsed(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(NAV_COLLAPSED_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as unknown;
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj as Record<string, boolean>;
    }
  } catch { /* private mode */ }
  return {};
}

/**
 * Restart a CSS entrance animation on an element that is already mounted.
 * The reflow between removing and re-adding the class is load-bearing: without
 * it the browser coalesces both mutations and the animation never re-runs.
 */
function replayEntrance(el: HTMLElement): void {
  el.classList.remove('page-enter');
  void el.offsetWidth;
  el.classList.add('page-enter');
}

interface WorkspaceSettings {
  name?: string; logo?: string | null;
  /** Module toggles: false = hidden, undefined = enabled. */
  modules?: Record<string, boolean | undefined>;
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <TabsProvider>
      <ShellInner>{children}</ShellInner>
    </TabsProvider>
  );
}

function ShellInner({ children }: { children: ReactNode }) {
  const me = useMe();
  const can = useCan();
  const path = usePathname();
  const navigate = useNavigate();
  const t = useT();
  const tabs = useTabs();
  const activeTimer = useActiveTimer(can('time.track'));
  const stopTimer = useStopTimer();
  const { pref: themePref, setPref: setThemePref } = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  /* ── Sidebar visibility ──
   * Desktop: shown unless the user hid it (⌘\ or the strip's toggle); the
   * choice persists. Compact: a modal drawer, closed by default, that closes
   * again on navigation. */
  const compact = useMediaQuery(COMPACT_QUERY);
  const [sidebarHidden, setSidebarHidden] = useState(loadSidebarHidden);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const sidebarInline = !compact && !sidebarHidden;
  const sidebarShown = sidebarInline || (compact && drawerOpen);
  const asideRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  /** Where focus was when the drawer opened – it goes back there on close. */
  const drawerOpener = useRef<HTMLElement | null>(null);
  const toggleSidebar = useCallback(() => {
    if (compact) { setDrawerOpen((o) => !o); return; }
    setSidebarHidden((h) => {
      try { localStorage.setItem(SIDEBAR_HIDDEN_KEY, h ? '0' : '1'); } catch { /* private mode */ }
      return !h;
    });
  }, [compact]);
  const gChord = useRef<number>(0);
  const contentRef = useRef<HTMLDivElement>(null);
  useScrollRestoration(contentRef, `${tabs?.activeId ?? ''}:${path}`);

  const realtime = useRealtime();

  const wsQ = useQuery<WorkspaceSettings>({
    queryKey: ['workspace-settings'],
    queryFn: () => api.get<WorkspaceSettings>('/settings/workspace').catch(() => ({})),
    staleTime: 5 * 60_000,
  });
  const wsName = wsQ.data?.name || 'ordi';
  const wsLogo = wsQ.data?.logo || null;
  const modules = wsQ.data?.modules;

  // Desktop (Tauri) native events: OS quick-add shortcut + ordi:// deep links.
  useEffect(() => initDesktop({
    onQuickAdd: () => setQuickOpen(true),
    onMenu: (command) => {
      if (command === 'new-task') setQuickOpen(true);
      else if (command === 'search') setPaletteOpen(true);
      else if (command === 'sidebar') toggleSidebar();
      else if (command === 'preferences') navigate('/profile');
      else if (command === 'shortcuts') setKeysOpen(true);
    },
    onNavigate: navigate,
    onUpdateReady: (version) => toast.action(
      t('desktop.updateReady', 'Update installed').replace('{version}', version),
      { label: t('desktop.restart'), onSelect: restartDesktop },
    ),
  }), [navigate, t, toggleSidebar]);

  // App-wide keyboard scheme (PRD §17.1). Declared in lib/shortcuts; tab keys
  // live in TabStrip, which reads the same table.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const hit = (id: string) => SHORTCUTS.find((s) => s.id === id)?.match?.(e) ?? false;
      if (hit('palette')) { e.preventDefault(); setPaletteOpen((o) => !o); return; }
      // ⌘\ shows/hides the sidebar, ⌘, opens personal preferences (the
      // profile page holds language, theme, date format and notifications).
      if (hit('sidebar')) { e.preventDefault(); toggleSidebar(); return; }
      if (hit('preferences')) { e.preventDefault(); navigate('/profile'); return; }
      // "?" is Shift+/ – a bare-letter rule would never see it, so it is
      // checked before the typing guard bails on the shift modifier.
      if (hit('help') && !isTypingTarget(e)) { e.preventDefault(); setKeysOpen((o) => !o); return; }
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      const key = e.key.toLowerCase();

      if (gChord.current && Date.now() - gChord.current < 700) {
        gChord.current = 0;
        const dest = GO_TO.find((d) => d.key === key);
        if (dest) { e.preventDefault(); navigate(dest.to); return; }
      }
      if (key === 'g') { gChord.current = Date.now(); return; }
      gChord.current = 0;

      if (key === 'c') { e.preventDefault(); setQuickOpen(true); return; }
      if (key === 't') {
        e.preventDefault();
        if (!can('time.track') || stopTimer.isPending) return;
        if (activeTimer.isError) { toast.error(t('time.timerUnavailable', 'Could not check the timer. Retry')); return; }
        if (activeTimer.data) stopTimer.mutate(activeTimer.data);
        else toast.info(t('time.timerIdle', 'No timer running'));
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, toggleSidebar, can, activeTimer.data, activeTimer.isError, stopTimer.mutate, stopTimer.isPending, t]);

  // The drawer belongs to the page it was opened on, and to compact mode.
  useEffect(() => { setDrawerOpen(false); }, [path, compact]);

  // Drawer focus: move in on open, back to where it came from on close –
  // unless whatever closed it (a dialog opened from the drawer) already took
  // focus somewhere meaningful.
  useEffect(() => {
    if (!compact) return;
    if (drawerOpen) {
      drawerOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      asideRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
      return;
    }
    const opener = drawerOpener.current;
    drawerOpener.current = null;
    if (!opener) return;
    const active = document.activeElement;
    if (!active || active === document.body || asideRef.current?.contains(active)) {
      (opener.isConnected ? opener : toggleRef.current)?.focus();
    }
  }, [drawerOpen, compact]);

  /** Escape closes the drawer and Tab stays inside it while it is modal. */
  const onDrawerKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!compact || !drawerOpen) return;
    // Portaled menus opened from the drawer bubble through React here; their
    // keys are theirs.
    if (!asideRef.current?.contains(e.target as Node)) return;
    const innerLayer = (e.target as Element).closest('[role="dialog"], [role="menu"]');
    if (innerLayer && innerLayer !== asideRef.current) return;
    if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); setDrawerOpen(false); return; }
    if (e.key !== 'Tab') return;
    const items = Array.from(asideRef.current.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => el.getClientRects().length > 0 && !el.closest('[inert]'));
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  // One entrance per navigation; data refetches do not replay the whole page.
  useEffect(() => {
    if (contentRef.current) replayEntrance(contentRef.current);
  }, [path, tabs?.activeId]);

  /* ── Reorderable, sectioned nav ── */
  const [order, setOrder] = useState<string[]>(loadNavOrder);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(loadCollapsed);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const orderedNav = useMemo(() => {
    const byKey = new Map(NAV_DEFS.map((n) => [n.key, n]));
    const seen = new Set<string>();
    const out: NavDef[] = [];
    for (const k of order) {
      const def = byKey.get(k);
      if (def && !seen.has(k)) { out.push(def); seen.add(k); }
    }
    for (const def of NAV_DEFS) if (!seen.has(def.key)) out.push(def); // new items appended
    return out.filter((n) =>
      (n.anyAuth || (n.perm && can(n.perm)))
      && !(n.module && modules?.[n.module] === false));
  }, [order, can, modules]);

  const sectionOf = useMemo(() => new Map(NAV_DEFS.map((n) => [n.key, n.section])), []);
  const grouped = useMemo(() => {
    const g = new Map<NavSection, NavDef[]>();
    for (const n of orderedNav) {
      const list = g.get(n.section) ?? [];
      list.push(n);
      g.set(n.section, list);
    }
    return g;
  }, [orderedNav]);

  const commitOrder = (next: string[]) => {
    setOrder(next);
    try { localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  };

  /** Reorder – only within the same section. */
  const onDropOn = (targetKey: string) => {
    if (!dragKey || dragKey === targetKey) return;
    if (sectionOf.get(dragKey) !== sectionOf.get(targetKey)) return;
    const full = orderedNav.map((n) => n.key);
    const from = full.indexOf(dragKey);
    const to = full.indexOf(targetKey);
    if (from < 0 || to < 0) return;
    full.splice(to, 0, ...full.splice(from, 1));
    commitOrder(full);
  };

  const sectionHeaders = useRef<Partial<Record<NavSection, HTMLButtonElement | null>>>({});
  const toggleSection = (key: NavSection) => {
    const collapsing = !collapsed[key];
    setCollapsed((c) => {
      const next = { ...c, [key]: !c[key] };
      try { localStorage.setItem(NAV_COLLAPSED_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
    // A collapsed group is inert, so focus inside it (collapsing from an
    // item's context menu) would drop to <body>. Its header takes it instead.
    if (collapsing) {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        const group = document.getElementById(`nav-group-${key}`);
        if (!active || active === document.body || group?.contains(active)) sectionHeaders.current[key]?.focus();
      });
    }
  };

  const logout = async () => {
    await api.post('/auth/logout').catch(() => {});
    setSessionToken(null);
    window.location.href = '/login';
  };

  const themeItems: { key: ThemePref; label: string; icon: ReactNode }[] = [
    { key: 'dark', label: t('theme.dark'), icon: <Moon size={14} /> },
    { key: 'light', label: t('theme.light'), icon: <Sun size={14} /> },
    { key: 'system', label: t('theme.system'), icon: <Monitor size={14} /> },
  ];

  /** Reorder without dragging – the context-menu equivalent of drag & drop. */
  const moveWithinSection = (key: string, delta: number) => {
    const def = NAV_DEFS.find((d) => d.key === key);
    if (!def) return;
    const full = orderedNav.map((n) => n.key);
    const siblings = orderedNav.filter((n) => n.section === def.section).map((n) => n.key);
    const at = siblings.indexOf(key);
    const target = siblings[at + delta];
    if (target === undefined) return;
    const from = full.indexOf(key);
    full.splice(full.indexOf(target), 0, ...full.splice(from, 1));
    commitOrder(full);
  };

  const copyLink = (to: string) => {
    navigator.clipboard?.writeText(`${appOrigin()}${to}`)
      .then(() => toast(t('ctx.linkCopied')))
      .catch(() => toast.error(t('common.error')));
  };

  const renderNavItem = (n: NavDef) => {
    const active = isNavActive(n.to, path);
    const siblings = orderedNav.filter((s) => s.section === n.section);
    const at = siblings.findIndex((s) => s.key === n.key);
    const menu: ContextMenuEntry[] = [
      { key: 'newtab', label: t('ctx.openInNewTab'), icon: <SquareArrowOutUpRight size={13} />, onSelect: () => tabs?.openInNewTab(n.to) },
      { key: 'copy', label: t('ctx.copyLink'), icon: <LinkIcon size={13} />, onSelect: () => copyLink(n.to) },
      { type: 'separator' },
      { key: 'up', label: t('ctx.moveUp'), icon: <ArrowUp size={13} />, disabled: at <= 0, onSelect: () => moveWithinSection(n.key, -1) },
      { key: 'down', label: t('ctx.moveDown'), icon: <ArrowDown size={13} />, disabled: at < 0 || at >= siblings.length - 1, onSelect: () => moveWithinSection(n.key, 1) },
      ...(n.section === 'main' ? [] : [
        { type: 'separator' } as ContextMenuEntry,
        {
          key: 'collapse',
          label: collapsed[n.section] ? t('ctx.expandSection') : t('ctx.collapseSection'),
          icon: collapsed[n.section] ? <ChevronDown size={13} /> : <ChevronRight size={13} />,
          onSelect: () => toggleSection(n.section),
        } as ContextMenuEntry,
      ]),
    ];
    return (
      <ContextMenu key={n.key} items={menu}>
      <div
        key={n.key}
        draggable
        onDragStart={(e) => { setDragKey(n.key); e.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={() => { setDragKey(null); setOverKey(null); }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (overKey !== n.key) setOverKey(n.key); }}
        onDrop={(e) => { e.preventDefault(); onDropOn(n.key); setDragKey(null); setOverKey(null); }}
        className={cn(
          'group/nav relative rounded-md transition-all duration-150',
          dragKey === n.key && 'opacity-40',
          overKey === n.key && dragKey && dragKey !== n.key && sectionOf.get(dragKey) === n.section && 'ring-1 ring-primary/50',
        )}
      >
        <Link
          to={n.to}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'flex items-center gap-2.5 rounded-md px-2 py-[5px] text-[13px] transition-colors duration-150',
            active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          <span className={cn('transition-colors', active ? 'text-foreground' : 'text-faint group-hover/nav:text-muted-foreground')}>{n.icon}</span>
          <span className="flex-1 truncate">{t(n.labelKey)}</span>
          <GripVertical
            size={12}
            className="cursor-grab text-faint opacity-0 transition-opacity duration-150 group-hover/nav:opacity-60"
            aria-hidden
          />
        </Link>
      </div>
      </ContextMenu>
    );
  };

  // Remount the routed page per tab + top-level segment: tab switches and
  // section jumps replay .page-enter, while tab *title* updates do not.
  // Remount only when the SECTION or the tab changes – a detail page opened
  // from its own list must keep the surrounding subtree alive. The entrance
  // animation is replayed for every navigation separately, below.
  const contentKey = `${tabs?.activeId ?? 'tab'}:${path.split('/')[1] || 'home'}`;

  const settingsActive = isNavActive('/settings', path);
  const toggleLabel = sidebarShown ? t('nav.hideSidebar', 'Hide sidebar') : t('nav.showSidebar', 'Show sidebar');
  const skipToContent = () => {
    const el = contentRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
  };

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* First stop for keyboard users: past ~15 sidebar and tab-strip stops. */}
      <a
        href="#main-content"
        onClick={(e) => { e.preventDefault(); skipToContent(); }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[100] focus:rounded-md focus:border focus:border-border focus:bg-elevated focus:px-3 focus:py-1.5 focus:text-[13px] focus:shadow-pop"
      >
        {t('nav.skipToContent', 'Skip to content')}
      </a>

      {compact && drawerOpen && (
        <div className="fixed inset-0 z-40 bg-black/40" aria-hidden onClick={() => setDrawerOpen(false)} />
      )}
      {/* display:none (not just off-screen) when it is not shown, so none of
        * its links stay in the Tab order. It stays mounted so the timer and
        * notification state survive hiding it. A `hidden` attribute would
        * lose to the `flex` utility, hence the class. */}
      <aside
        id="app-sidebar"
        ref={asideRef}
        role={compact ? 'dialog' : undefined}
        aria-modal={compact ? true : undefined}
        aria-label={compact ? t('nav.sidebar', 'Sidebar') : undefined}
        onKeyDown={onDrawerKeyDown}
        className={cn(
          'w-56 shrink-0 flex-col',
          sidebarShown ? 'flex' : 'hidden',
          compact && 'fixed inset-y-0 left-0 z-50 max-w-[85vw] border-r border-border bg-background shadow-pop',
        )}
      >
        {/* macOS overlay title bar: the native buttons are drawn over the
            window's top-left corner, which is this sidebar. Nothing can live
            underneath them, so the sidebar opens with an empty strip that is
            theirs. Keep it in step with tauri.conf trafficLightPosition: the
            48px strip and y=18 leave an even 18px above and below a 12px
            light, so the buttons sit centred instead of crowding the frame.
            The strip is also the drag handle; without a drag region (and the
            core:window:allow-start-dragging permission) the window cannot be
            moved at all. */}
        {isMacDesktop && <div className="h-12 shrink-0" data-tauri-drag-region />}

        {/* One identity row, the way Linear does it: the workspace names the
            place, and who you are only matters when you open the menu – so
            the email lives inside it and there is no profile row at the foot
            of the sidebar telling you your own name. Search and new-task
            share the row as icons rather than owning one of their own. */}
        <div
          className="flex items-center gap-0.5 px-2.5 pb-1 pt-3"
          data-tauri-drag-region={isMacDesktop || undefined}
        >
          <ContextMenu
            items={[
              { key: 'profile', label: t('nav.profile'), icon: <UserIcon size={13} />, onSelect: () => navigate('/profile') },
              { key: 'newtab', label: t('ctx.openInNewTab'), icon: <SquareArrowOutUpRight size={13} />, onSelect: () => tabs?.openInNewTab('/profile') },
              { type: 'separator' },
              { key: 'signout', label: t('nav.signOut'), icon: <LogOut size={13} />, danger: true, onSelect: logout },
            ]}
          >
            <DropdownMenu
              width={216}
              className="min-w-0 flex-1"
              trigger={
                <button className="flex min-w-0 w-full items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors duration-150 hover:bg-muted">
                  {wsLogo ? (
                    <img src={wsLogo} alt="" className="h-5 w-5 shrink-0 rounded-md object-cover" />
                  ) : (
                    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-[hsl(var(--action))] text-[11px] font-bold text-primary-foreground">
                      {wsName.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{wsName}</span>
                  <ChevronDown size={13} className="shrink-0 text-faint" />
                </button>
              }
            >
              <MenuLabel>
                <span className="flex items-center gap-2">
                  <Avatar name={me.user.name} src={me.user.avatar} size={18} />
                  <span className="min-w-0 truncate">{me.user.email}</span>
                </span>
              </MenuLabel>
              <MenuItem icon={<UserIcon size={14} />} onSelect={() => navigate('/profile')}>{t('nav.profile')}</MenuItem>
              {can('users.manage') && (
                <MenuItem icon={<UserPlus size={14} />} onSelect={() => navigate('/settings/users')}>
                  {t('settings.inviteUser')}
                </MenuItem>
              )}
              {/* Pointless inside the desktop app – it is already the desktop app. */}
              {!isTauri && (
                <MenuItem icon={<MonitorDown size={14} />} onSelect={() => navigate('/download')}>
                  {t('desktop.download')}
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuLabel>{t('theme.title')}</MenuLabel>
              {themeItems.map((it) => (
                <MenuItem key={it.key} icon={it.icon} checked={themePref === it.key} onSelect={() => setThemePref(it.key)}>
                  {it.label}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem icon={<LogOut size={14} />} danger onSelect={logout}>{t('nav.signOut')}</MenuItem>
            </DropdownMenu>
          </ContextMenu>
          <Tooltip label={<span className="flex items-center gap-1.5">{t('nav.search')} <Kbd>{MOD}K</Kbd></span>}>
            <IconButton onClick={() => { setDrawerOpen(false); setPaletteOpen(true); }} aria-label={t('nav.search')}>
              <Search size={15} />
            </IconButton>
          </Tooltip>
          <Tooltip label={<span className="flex items-center gap-1.5">{t('tasks.newTask')} <Kbd>C</Kbd></span>}>
            <IconButton onClick={() => { setDrawerOpen(false); setQuickOpen(true); }} aria-label={t('tasks.newTask')} className="border border-border bg-card shadow-sm hover:border-border-strong">
              <SquarePen size={15} />
            </IconButton>
          </Tooltip>
          {compact && (
            <IconButton onClick={() => setDrawerOpen(false)} aria-label={t('nav.hideSidebar', 'Hide sidebar')}>
              <X size={15} />
            </IconButton>
          )}
        </div>

        {/* Nav – grouped sections, drag to reorder within a section */}
        <nav className="flex-1 overflow-y-auto px-2 pt-1">
          {/* Notifications reads as a destination with a count, not a badged
              icon: a two-digit count over a 16px glyph covers the glyph. */}
          <NotificationsBell visible={sidebarShown} />

          {SECTIONS.map((sec) => {
            const items = grouped.get(sec.key) ?? [];
            if (items.length === 0) return null;
            if (!sec.labelKey) {
              return <div key={sec.key} className="space-y-px">{items.map(renderNavItem)}</div>;
            }
            const isCollapsed = !!collapsed[sec.key];
            return (
              <div key={sec.key} className="pt-3">
                <button
                  ref={(el) => { sectionHeaders.current[sec.key] = el; }}
                  onClick={() => toggleSection(sec.key)}
                  aria-expanded={!isCollapsed}
                  aria-controls={`nav-group-${sec.key}`}
                  className="group/sec flex w-full items-center gap-0.5 rounded-md px-2 py-0.5 text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-faint transition-colors duration-150 hover:text-muted-foreground"
                >
                  <span className="truncate">{t(sec.labelKey)}</span>
                  <ChevronRight
                    size={11}
                    className={cn(
                      'shrink-0 transition-all ease-smooth-out',
                      isCollapsed ? 'opacity-70' : 'rotate-90 opacity-0 group-hover/sec:opacity-70',
                    )}
                    style={{ transitionDuration: '250ms' }}
                    aria-hidden
                  />
                </button>
                {/* Accordion collapse (transitions.dev): grid-rows 1fr↔0fr */}
                {/* Collapsed means out of the Tab order and the accessibility
                  * tree too, not only zero height. */}
                <div
                  id={`nav-group-${sec.key}`}
                  inert={isCollapsed || undefined}
                  aria-hidden={isCollapsed || undefined}
                  className="grid ease-smooth-out"
                  style={{
                    gridTemplateRows: isCollapsed ? '0fr' : '1fr',
                    transition: 'grid-template-rows 250ms var(--ease-smooth-out)',
                  }}
                >
                  <div className="min-h-0 overflow-hidden">
                    <div
                      className="space-y-px pt-0.5 transition-opacity ease-smooth-out"
                      style={{ opacity: isCollapsed ? 0 : 1, transitionDuration: isCollapsed ? '150ms' : '250ms' }}
                    >
                      {items.map(renderNavItem)}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </nav>

        {/* Footer: one identity row. The account opens its menu on a left
            click (the old row only had a right-click menu, which nobody
            finds), and the bell sits beside it instead of owning a row. */}
        <div className="space-y-1 p-2.5">
          {/* Settings is a destination, so it reads as one: a nav row at the
              foot of the nav rather than an item inside a dropdown. */}
          {(can('settings.manage') || can('users.manage') || can('roles.manage')) && (
            <ContextMenu
              items={[
                { key: 'newtab', label: t('ctx.openInNewTab'), icon: <SquareArrowOutUpRight size={13} />, onSelect: () => tabs?.openInNewTab('/settings') },
                { key: 'copy', label: t('ctx.copyLink'), icon: <LinkIcon size={13} />, onSelect: () => copyLink('/settings') },
              ]}
            >
              <Link
                to="/settings"
                aria-current={settingsActive ? 'page' : undefined}
                className={cn(
                  'group/nav flex items-center gap-2.5 rounded-md px-2 py-[5px] text-[13px] transition-colors duration-150',
                  settingsActive
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                <span className={cn('transition-colors', settingsActive ? 'text-foreground' : 'text-faint group-hover/nav:text-muted-foreground')}>
                  <Settings size={16} />
                </span>
                <span className="flex-1 truncate">{t('nav.settings')}</span>
              </Link>
            </ContextMenu>
          )}
          <TimerIndicator />
        </div>
      </aside>

      {/* Content column: tab strip above the Linear-style inset surface */}
      <main
        inert={(compact && drawerOpen) || undefined}
        className={cn('flex min-w-0 flex-1 flex-col overflow-hidden pb-2 pr-2 pt-1.5', !sidebarInline && 'pl-2')}
      >
        <TabStrip
          trafficLightInset={isMacDesktop && !sidebarInline}
          leading={(
            <Tooltip label={<span className="flex items-center gap-1.5">{toggleLabel} <Kbd>{`${MOD}\\`}</Kbd></span>} side="bottom">
              <button
                ref={toggleRef}
                type="button"
                aria-label={toggleLabel}
                aria-expanded={sidebarShown}
                aria-controls="app-sidebar"
                onClick={toggleSidebar}
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint transition-colors duration-150 hover:bg-muted hover:text-foreground"
              >
                <PanelLeft size={14} />
              </button>
            </Tooltip>
          )}
        />
        <VersionGuard />
        {realtime.reconnecting && <p role="status" className="px-3 py-1 text-xs text-muted-foreground">{t('common.reconnecting')}</p>}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
          <div
            ref={contentRef}
            key={contentKey}
            id="main-content"
            tabIndex={-1}
            className="page-enter flex min-h-0 flex-1 flex-col overflow-auto outline-none"
          >
            {children}
          </div>
        </div>
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={navigate} />
      <QuickCreateTask open={quickOpen} onClose={() => setQuickOpen(false)} />
      <ShortcutsDialog open={keysOpen} onClose={() => setKeysOpen(false)} />
      <Toaster />
    </div>
  );
}
