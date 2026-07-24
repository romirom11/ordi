import { useState, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, Inbox } from 'lucide-react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { setBadge } from '../lib/desktop';
import { cn, IconButton, fmtRelative } from './ui';

interface Notif { id: string; type: string; entityRef: string | null; payload: Record<string, unknown>; readAt: string | null; createdAt: string }

export function NotificationsBell() {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ data: Notif[]; unread: number }>('/notifications'),
    refetchInterval: 60_000,
  });
  const readAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey); };
  }, [open]);

  const unread = data?.unread ?? 0;
  // Desktop: mirror the unread count onto the dock/taskbar badge (PRD §18).
  useEffect(() => { setBadge(unread); }, [unread]);

  return (
    <div className="relative" ref={rootRef}>
      <IconButton onClick={() => setOpen((o) => !o)} aria-label={t('notifications.title')} className="relative">
        <Bell size={15} />
        {unread > 0 && (
          <span className="anim-pop-in absolute -right-0.5 -top-0.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-primary px-0.5 text-[9px] font-semibold text-primary-foreground">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </IconButton>
      {open && (
        <div
          className="absolute left-0 top-8 z-50 w-80 overflow-hidden rounded-lg border border-border bg-elevated shadow-pop"
          style={{ animation: 'dropdown-in 250ms var(--ease-smooth-out) both', transformOrigin: 'top left' }}
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-[13px] font-semibold">{t('notifications.title')}</span>
            {unread > 0 && (
              <button className="text-xs text-muted-foreground transition-colors hover:text-foreground" onClick={() => readAll.mutate()}>
                {t('notifications.markAllRead')}
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-auto p-1">
            {(data?.data ?? []).length === 0 && (
              <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                <Inbox size={20} className="text-faint" />
                <span className="text-[13px]">{t('common.nothingYet')}</span>
              </div>
            )}
            {(data?.data ?? []).map((n, i) => (
              <div
                key={n.id}
                className={cn('row-enter flex items-start gap-2 rounded-md px-2 py-2 transition-colors hover:bg-muted', n.readAt && 'opacity-55')}
                style={{ ['--i' as string]: Math.min(i, 8) }}
              >
                <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-primary')} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{n.type.replace(/[._]/g, ' ')}</div>
                  <div className="truncate text-xs text-muted-foreground">{n.entityRef ?? ''}</div>
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-faint">{fmtRelative(n.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
