import {
  createContext, useCallback, useContext, useEffect, useState,
  type ReactNode, type MouseEvent, type CSSProperties,
} from 'react';

interface RouterState {
  path: string;
  navigate: (to: string, opts?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterState | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname + window.location.search);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname + window.location.search);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = (to: string, opts?: { replace?: boolean }) => {
    if (opts?.replace) window.history.replaceState({}, '', to);
    else window.history.pushState({}, '', to);
    setPath(to);
    window.scrollTo(0, 0);
  };
  return <RouterContext.Provider value={{ path, navigate }}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterState {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter outside provider');
  return ctx;
}

export function useNavigate() {
  return useRouter().navigate;
}

export function usePathname(): string {
  return useRouter().path.split('?')[0]!;
}

export function useSearchParams(): URLSearchParams {
  const { path } = useRouter();
  return new URLSearchParams(path.split('?')[1] ?? '');
}

/**
 * Provided by TabsProvider (lib/tabs.tsx). When present, Ctrl/Cmd-click and
 * middle-click on internal <Link>s open an in-app tab instead of a browser tab.
 */
export const NewTabContext = createContext<((to: string) => void) | null>(null);

/**
 * The parts of a mouse event that decide how a click should open something.
 * Loose on purpose so callers can pass a React MouseEvent, a DOM MouseEvent or
 * nothing at all (a programmatic open).
 */
export interface OpenIntent {
  metaKey?: boolean;
  ctrlKey?: boolean;
  button?: number;
  preventDefault?: () => void;
}

/**
 * Open an in-app url the way the click asked for it: plain click navigates the
 * active tab, Ctrl/Cmd-click and middle-click open a new in-app tab.
 *
 * Rows, cards and cells that navigate MUST go through this instead of calling
 * navigate() directly. A bare `onClick={() => navigate(url)}` swallows the
 * modifier, so Cmd-click silently does nothing and the context menu becomes
 * the only way to open a second tab – which is exactly the papercut this
 * exists to remove. <Link> is built on it too.
 */
export function useOpen(): (to: string, e?: OpenIntent) => void {
  const navigate = useNavigate();
  const openInNewTab = useContext(NewTabContext);
  return useCallback((to: string, e?: OpenIntent) => {
    const button = e?.button ?? 0;
    // Right-click belongs to the context menu, never to navigation.
    if (button === 2) return;
    if (button === 1 || e?.metaKey || e?.ctrlKey) {
      // Without a TabsProvider (public pages) let the browser do its default.
      if (!openInNewTab) return;
      e?.preventDefault?.();
      openInNewTab(to);
      return;
    }
    if (button !== 0) return;
    e?.preventDefault?.();
    navigate(to);
  }, [navigate, openInNewTab]);
}

export function Link({ to, children, className, style, title, onClick }: {
  to: string; children: ReactNode; className?: string; style?: CSSProperties;
  title?: string; onClick?: () => void;
}) {
  const open = useOpen();
  const handle = (e: MouseEvent) => {
    if (!e.metaKey && !e.ctrlKey && e.button === 0) onClick?.();
    open(to, e);
  };
  return (
    <a href={to} className={className} style={style} title={title} onClick={handle} onAuxClick={(e) => open(to, e)}>
      {children}
    </a>
  );
}

/** Match a pattern like /projects/:id/tasks/:taskId against a path. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const pp = pattern.split('/').filter(Boolean);
  const ap = path.split('/').filter(Boolean);
  if (pp.length !== ap.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i]!;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(ap[i]!);
    else if (seg !== ap[i]) return null;
  }
  return params;
}

export interface RouteDef {
  pattern: string;
  render: (params: Record<string, string>) => ReactNode;
}

export function Routes({ routes, fallback }: { routes: RouteDef[]; fallback?: ReactNode }) {
  const path = usePathname();
  for (const route of routes) {
    const params = matchPath(route.pattern, path);
    if (params) return <>{route.render(params)}</>;
  }
  return <>{fallback ?? <div className="p-8">Not found</div>}</>;
}
