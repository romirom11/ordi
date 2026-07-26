import { type ReactNode, useState, useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, CheckSquare, Handshake, FolderKanban, BookText,
  Clock, Receipt, Users, Settings, Search, LogOut, LayoutGrid, CalendarRange,
  SquarePen, Sun, Moon, Monitor, ChevronDown, ChevronRight, GripVertical, User as UserIcon,
  SquareArrowOutUpRight, Link as LinkIcon, ArrowUp, ArrowDown,
  MonitorDown,
} from 'lucide-react';
import { Link, usePathname, useNavigate } from '../lib/router';
import { useMe, useCan } from '../lib/auth';
import { appOrigin, api, setSessionToken } from '../lib/api';
import { useRealtime } from '../lib/sse';
import { useT, extendDict } from '../lib/i18n';
import { useTheme, type ThemePref } from '../lib/theme';
import { initDesktop, restartDesktop, isTauri, isMacDesktop } from '../lib/desktop';
import { TabsProvider, useTabs } from '../lib/tabs';
import { cn, Avatar, Kbd, Tooltip, IconButton } from './ui';
import { ContextMenu, DropdownMenu, MenuItem, MenuSeparator, MenuLabel, Toaster, toast, type ContextMenuEntry } from './overlays';
import { CommandPalette } from './CommandPalette';
import { TimerIndicator } from './TimerIndicator';
import { NotificationsBell } from './NotificationsBell';
import { QuickCreateTask } from './QuickCreateTask';
import { TabStrip } from './tabs/TabStrip';
import { VersionGuard } from './VersionGuard';

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
  { key: 'people', to: '/people', labelKey: 'nav.people', icon: <Users size={16} />, perm: 'people.read', section: 'operations', module: 'people' },
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

function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
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
  const { pref: themePref, setPref: setThemePref } = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const gChord = useRef<number>(0);

  useRealtime();

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
    onNavigate: navigate,
    onUpdateReady: (version) => toast.action(
      t('desktop.updateReady', 'Update installed').replace('{version}', version),
      { label: t('desktop.restart'), onSelect: restartDesktop },
    ),
  }), [navigate, t]);

  // Keyboard scheme (PRD §17.1): ⌘K palette, C new task, T stop timer,
  // G then D/P/C/F/K/T/M navigation. (Tab shortcuts live in TabStrip.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e)) return;
      const key = e.key.toLowerCase();

      if (gChord.current && Date.now() - gChord.current < 700) {
        gChord.current = 0;
        const map: Record<string, string> = {
          d: '/', p: '/projects', c: '/crm', f: '/finance', k: '/kb', t: '/time', m: '/my-tasks',
        };
        const to = map[key];
        if (to) { e.preventDefault(); navigate(to); return; }
      }
      if (key === 'g') { gChord.current = Date.now(); return; }
      gChord.current = 0;

      if (key === 'c') { e.preventDefault(); setQuickOpen(true); return; }
      if (key === 't') {
        e.preventDefault();
        api.post('/time/timer/stop').catch(() => {});
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

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

  const toggleSection = (key: NavSection) => {
    setCollapsed((c) => {
      const next = { ...c, [key]: !c[key] };
      try { localStorage.setItem(NAV_COLLAPSED_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
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
    const active = n.to === '/' ? path === '/' : path.startsWith(n.to);
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
  const contentKey = `${tabs?.activeId ?? 'tab'}:${path.split('/')[1] || 'home'}`;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <aside className="flex w-56 shrink-0 flex-col">
        {/* macOS overlay title bar: the traffic lights float over THIS corner,
            so the sidebar owes them a strip. It doubles as the drag handle –
            without a drag region the window cannot be moved at all. */}
        {isMacDesktop && <div className="h-7 shrink-0" data-tauri-drag-region />}
        {/* Workspace header */}
        <div className="flex items-center gap-1 px-3 pb-1 pt-3">
          <DropdownMenu
            width={210}
            trigger={
              <button className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors duration-150 hover:bg-muted">
                {wsLogo ? (
                  <img src={wsLogo} alt="" className="h-5 w-5 shrink-0 rounded-md object-cover" />
                ) : (
                  <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
                    {wsName.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="truncate text-[13px] font-semibold">{wsName}</span>
                <ChevronDown size={13} className="shrink-0 text-faint" />
              </button>
            }
          >
            <MenuLabel>{wsName}</MenuLabel>
            {(can('settings.manage') || can('users.manage') || can('roles.manage')) && (
              <MenuItem icon={<Settings size={14} />} onSelect={() => navigate('/settings')}>{t('nav.settings')}</MenuItem>
            )}
            <MenuItem icon={<UserIcon size={14} />} onSelect={() => navigate('/profile')}>{t('nav.profile')}</MenuItem>
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
        </div>

        {/* Quick actions: new task + search */}
        <div className="flex items-center gap-1.5 px-3 py-2">
          <button
            onClick={() => setQuickOpen(true)}
            className={cn(
              'flex h-7 flex-1 items-center gap-2 rounded-md border border-border bg-card px-2 text-[13px] font-medium shadow-sm',
              'transition-all duration-150 ease-smooth-out hover:border-border-strong hover:bg-muted active:scale-[0.98]',
            )}
          >
            <SquarePen size={14} className="text-muted-foreground" /> {t('tasks.newTask')}
          </button>
          <Tooltip label={<span className="flex items-center gap-1.5">{t('nav.search')} <Kbd>⌘K</Kbd></span>}>
            <IconButton onClick={() => setPaletteOpen(true)} aria-label={t('nav.search')} className="border border-border bg-card shadow-sm hover:border-border-strong">
              <Search size={14} />
            </IconButton>
          </Tooltip>
        </div>

        {/* Nav – grouped sections, drag to reorder within a section */}
        <nav className="flex-1 overflow-y-auto px-2 pt-1">
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
                  onClick={() => toggleSection(sec.key)}
                  aria-expanded={!isCollapsed}
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
                <div
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

        {/* Footer */}
        <div className="space-y-1 p-2.5">
          <TimerIndicator />
          <NotificationsBell />
          <ContextMenu
            items={[
              { key: 'profile', label: t('nav.profile'), icon: <UserIcon size={13} />, onSelect: () => navigate('/profile') },
              { key: 'newtab', label: t('ctx.openInNewTab'), icon: <SquareArrowOutUpRight size={13} />, onSelect: () => tabs?.openInNewTab('/profile') },
              { type: 'separator' },
              { key: 'signout', label: t('nav.signOut'), icon: <LogOut size={13} />, danger: true, onSelect: logout },
            ]}
          >
          <Link
            to="/profile"
            className={cn(
              'flex items-center gap-2.5 rounded-md px-2 py-[5px] text-[13px] transition-colors duration-150',
              path.startsWith('/profile') ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
            )}
          >
            <Avatar name={me.user.name} src={me.user.avatar} size={18} />
            <span className="truncate">{me.user.name}</span>
          </Link>
          </ContextMenu>
        </div>
      </aside>

      {/* Content column: tab strip above the Linear-style inset surface */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden pb-2 pr-2 pt-1.5">
        <TabStrip />
        <VersionGuard />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
          <div key={contentKey} className="page-enter flex min-h-0 flex-1 flex-col overflow-auto">
            {children}
          </div>
        </div>
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={navigate} />
      <QuickCreateTask open={quickOpen} onClose={() => setQuickOpen(false)} />
      <Toaster />
    </div>
  );
}
