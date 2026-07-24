import { type ReactNode, useState, useEffect } from 'react';
import {
  LayoutDashboard, CheckSquare, Building2, Handshake, FolderKanban, BookText,
  Clock, Receipt, Users, Settings, Search, LogOut,
} from 'lucide-react';
import { Link, usePathname, useNavigate } from '../lib/router';
import { useMe, useCan } from '../lib/auth';
import { api } from '../lib/api';
import { cn } from './ui';
import { CommandPalette } from './CommandPalette';
import { TimerIndicator } from './TimerIndicator';
import { NotificationsBell } from './NotificationsBell';

interface NavItem { to: string; label: string; icon: ReactNode; perm?: string; anyAuth?: boolean }

export function Shell({ children }: { children: ReactNode }) {
  const me = useMe();
  const can = useCan();
  const path = usePathname();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((o) => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const nav: NavItem[] = [
    { to: '/', label: 'Dashboard', icon: <LayoutDashboard size={17} />, anyAuth: true },
    { to: '/my-tasks', label: 'My tasks', icon: <CheckSquare size={17} />, anyAuth: true },
    { to: '/companies', label: 'Clients', icon: <Building2 size={17} />, perm: 'crm.read' },
    { to: '/deals', label: 'Deals', icon: <Handshake size={17} />, perm: 'deals.read' },
    { to: '/projects', label: 'Projects', icon: <FolderKanban size={17} />, anyAuth: true },
    { to: '/kb', label: 'Knowledge', icon: <BookText size={17} />, perm: 'kb.read' },
    { to: '/time', label: 'Time', icon: <Clock size={17} />, perm: 'time.track' },
    { to: '/finance', label: 'Finance', icon: <Receipt size={17} />, perm: 'finance.read' },
    { to: '/people', label: 'People', icon: <Users size={17} />, perm: 'people.read' },
  ];
  const visible = nav.filter((n) => n.anyAuth || (n.perm && can(n.perm)));

  const logout = async () => {
    await api.post('/auth/logout').catch(() => {});
    window.location.href = '/login';
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-52 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex h-12 items-center gap-2 px-4 font-semibold">
          <div className="grid h-6 w-6 place-items-center rounded bg-primary text-primary-foreground text-xs">o</div>
          ordi
        </div>
        <button onClick={() => setPaletteOpen(true)}
          className="mx-3 mb-2 flex h-8 items-center gap-2 rounded-md border border-border px-2 text-xs text-muted-foreground hover:bg-muted">
          <Search size={13} /> Search <span className="ml-auto rounded bg-muted px-1">⌘K</span>
        </button>
        <nav className="flex-1 space-y-0.5 px-2">
          {visible.map((n) => {
            const active = n.to === '/' ? path === '/' : path.startsWith(n.to);
            return (
              <Link key={n.to} to={n.to}
                className={cn('flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm', active ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60')}>
                {n.icon} {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-border p-2">
          <TimerIndicator />
          {(can('settings.manage') || can('users.manage') || can('roles.manage') || can('integrations.manage') || can('finance.settings')) && (
            <Link to="/settings" className={cn('mt-1 flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted/60', path.startsWith('/settings') && 'bg-muted')}>
              <Settings size={17} /> Settings
            </Link>
          )}
          <button onClick={logout} className="mt-1 flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted/60">
            <LogOut size={17} /> {me.user.name}
          </button>
        </div>
      </aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        <div className="flex h-12 items-center justify-end gap-2 border-b border-border px-4">
          <NotificationsBell />
        </div>
        <div className="flex-1 overflow-auto">{children}</div>
      </main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={navigate} />
    </div>
  );
}
