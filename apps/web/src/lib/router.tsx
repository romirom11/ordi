import { createContext, useContext, useEffect, useState, type ReactNode, type MouseEvent } from 'react';

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

export function Link({ to, children, className, onClick }: { to: string; children: ReactNode; className?: string; onClick?: () => void }) {
  const navigate = useNavigate();
  const handle = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey) return;
    e.preventDefault();
    onClick?.();
    navigate(to);
  };
  return <a href={to} className={className} onClick={handle}>{children}</a>;
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
