/**
 * TabStrip – Linear-style in-app tab bar rendered by Shell above the routed
 * page. Tabs behave like browser tabs: click switches, × / middle-click
 * closes, + opens a new tab at '/', Alt+W closes the active tab and
 * Ctrl/Cmd+Shift+[ / ] cycle tabs.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BookText, CalendarRange, CheckSquare, Clock, FolderKanban, Handshake,
  LayoutDashboard, LayoutGrid, Plus, Receipt, Settings, User as UserIcon,
  Users, X,
} from 'lucide-react';
import { extendDict, useT } from '../../lib/i18n';
import { tabFallbackTitle, useTabs, type TabItem } from '../../lib/tabs';
import { cn, Tooltip } from '../ui';
import { ContextMenu, toast, type ContextMenuEntry } from '../overlays';
import { Hint } from '../Hint';

extendDict({
  en: {
    'tabs.newTab': 'New tab',
    'tabs.closeTab': 'Close tab',
    'tabs.closeOthers': 'Close other tabs',
    'tabs.closeRight': 'Close tabs to the right',
    'tabs.copyLink': 'Copy link',
    'tabs.linkCopied': 'Link copied',
    'tabs.newTabHint': 'Ctrl/Cmd+click any link to open it in a new tab. Alt+W closes the current one.',
  },
  uk: {
    'tabs.newTab': 'Нова вкладка',
    'tabs.closeTab': 'Закрити вкладку',
    'tabs.closeOthers': 'Закрити інші вкладки',
    'tabs.closeRight': 'Закрити вкладки праворуч',
    'tabs.copyLink': 'Копіювати посилання',
    'tabs.linkCopied': 'Посилання скопійовано',
    'tabs.newTabHint': 'Ctrl/Cmd+клік на будь-яке посилання відкриє його в новій вкладці. Alt+W закриває поточну.',
  },
});

/** Small icon per tab kind, derived from the URL. */
function tabIcon(url: string): ReactNode {
  const parts = url.split('?')[0]!.split('/').filter(Boolean);
  const seg = parts[0] ?? '';
  if (seg === 'projects' && parts.length >= 4 && parts[2] === 'tasks') return <CheckSquare size={13} />;
  switch (seg) {
    case '': return <LayoutDashboard size={13} />;
    case 'my-tasks': return <CheckSquare size={13} />;
    case 'projects': return <FolderKanban size={13} />;
    case 'crm': case 'companies': case 'deals': return <Handshake size={13} />;
    case 'kb': return <BookText size={13} />;
    case 'time': return <Clock size={13} />;
    case 'finance': return <Receipt size={13} />;
    case 'people': return <Users size={13} />;
    case 'resourcing': return <CalendarRange size={13} />;
    case 'dashboards': return <LayoutGrid size={13} />;
    case 'settings': return <Settings size={13} />;
    case 'profile': return <UserIcon size={13} />;
    default: return <LayoutDashboard size={13} />;
  }
}

export function TabStrip() {
  const tabs = useTabs();
  const t = useT();
  const [closingIds, setClosingIds] = useState<ReadonlySet<string>>(new Set());
  const stripRef = useRef<HTMLDivElement>(null);

  // Keep imperative handlers fresh without re-binding listeners.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  /** Close with a quick width-collapse, then remove from the model. */
  const closeAnimated = (id: string) => {
    if (!tabsRef.current) return;
    setClosingIds((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
    window.setTimeout(() => {
      setClosingIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      tabsRef.current?.closeTab(id);
    }, 140);
  };
  const closeRef = useRef(closeAnimated);
  closeRef.current = closeAnimated;

  // Keyboard: Alt+W close · Ctrl/Cmd+Shift+[ / ] switch (Ctrl/Cmd+W is browser-reserved).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const api = tabsRef.current;
      if (!api) return;
      if (e.altKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyW') {
        e.preventDefault();
        closeRef.current(api.activeId);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        e.preventDefault();
        api.activateDelta(e.code === 'BracketRight' ? 1 : -1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Keep the active tab in view when it changes.
  useEffect(() => {
    if (!tabs) return;
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tabs.activeId)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tabs?.activeId, tabs]);

  // Document title mirrors the active tab (pages override via usePageTitle).
  const activeTab = tabs?.tabs.find((tb) => tb.id === tabs.activeId);
  const activeLabel = activeTab ? (activeTab.title || tabFallbackTitle(activeTab.url, t)) : null;
  useEffect(() => {
    if (activeLabel) document.title = `${activeLabel} · ordi`;
  }, [activeLabel]);

  if (!tabs) return null;

  const renderTab = (tab: TabItem) => {
    const isActive = tab.id === tabs.activeId;
    const isClosing = closingIds.has(tab.id);
    const label = tab.title || tabFallbackTitle(tab.url, t);
    const menu: ContextMenuEntry[] = [
      { key: 'close', label: t('tabs.closeTab'), icon: <X size={13} />, onSelect: () => closeAnimated(tab.id) },
      {
        key: 'others',
        label: t('tabs.closeOthers'),
        disabled: tabs.tabs.length < 2,
        onSelect: () => tabs.tabs.filter((o) => o.id !== tab.id).forEach((o) => tabs.closeTab(o.id)),
      },
      {
        key: 'right',
        label: t('tabs.closeRight'),
        disabled: tabs.tabs.findIndex((o) => o.id === tab.id) >= tabs.tabs.length - 1,
        onSelect: () => tabs.tabs.slice(tabs.tabs.findIndex((o) => o.id === tab.id) + 1).forEach((o) => tabs.closeTab(o.id)),
      },
      { type: 'separator' },
      {
        key: 'copy',
        label: t('tabs.copyLink'),
        onSelect: () => {
          navigator.clipboard?.writeText(`${window.location.origin}${tab.url}`)
            .then(() => toast(t('tabs.linkCopied')))
            .catch(() => {});
        },
      },
    ];
    return (
      <ContextMenu key={tab.id} items={menu}>
      <div
        data-tab-id={tab.id}
        role="tab"
        aria-selected={isActive}
        tabIndex={0}
        title={label}
        onClick={() => tabs.activateTab(tab.id)}
        onKeyDown={(e) => { if (e.key === 'Enter') tabs.activateTab(tab.id); }}
        onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeAnimated(tab.id); } }}
        className={cn(
          'anim-pop-in group/tab relative flex h-7 min-w-0 max-w-[180px] shrink-0 cursor-pointer select-none items-center gap-1.5 overflow-hidden rounded-md border px-2 text-[13px]',
          'transition-[max-width,opacity,transform,padding] duration-[150ms] ease-smooth-out',
          isActive
            ? 'border-border bg-surface font-medium text-foreground shadow-sm'
            : 'border-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground',
          isClosing && 'pointer-events-none max-w-0 scale-95 border-transparent px-0 opacity-0',
        )}
      >
        <span className={cn('shrink-0', isActive ? 'text-muted-foreground' : 'text-faint')}>{tabIcon(tab.url)}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <button
          aria-label={t('tabs.closeTab')}
          onClick={(e) => { e.stopPropagation(); closeAnimated(tab.id); }}
          className={cn(
            'grid h-4 w-4 shrink-0 place-items-center rounded-sm text-faint transition-all duration-150 hover:bg-muted hover:text-foreground',
            isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover/tab:opacity-70 group-hover/tab:hover:opacity-100',
          )}
        >
          <X size={12} />
        </button>
      </div>
      </ContextMenu>
    );
  };

  return (
    <div className="shrink-0">
      <div className="flex items-center gap-1 pb-1 pl-2.5 pr-1 pt-1.5" role="tablist">
        <div
          ref={stripRef}
          className="flex min-w-0 items-center gap-1 overflow-x-auto"
          style={{ scrollbarWidth: 'none' }}
        >
          {tabs.tabs.map(renderTab)}
        </div>
        <Tooltip label={t('tabs.newTab')} side="bottom">
          <button
            aria-label={t('tabs.newTab')}
            onClick={tabs.newTab}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint transition-colors duration-150 hover:bg-muted hover:text-foreground"
          >
            <Plus size={14} />
          </button>
        </Tooltip>
      </div>
      {/* Floating tip (bottom-left card) – appears once a second tab is opened. */}
      {tabs.tabs.length > 1 && (
        <Hint id="tabs-new-tab">
          {t('tabs.newTabHint')}
        </Hint>
      )}
    </div>
  );
}
