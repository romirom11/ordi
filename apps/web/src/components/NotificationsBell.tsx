import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { setBadge } from '../lib/desktop';

interface Notif { id: string; type: string; entityRef: string | null; payload: Record<string, unknown>; readAt: string | null; createdAt: string }

export function NotificationsBell() {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ data: Notif[]; unread: number }>('/notifications'),
    refetchInterval: 60_000,
  });
  const readAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const unread = data?.unread ?? 0;
  // Desktop: mirror the unread count onto the dock/taskbar badge (PRD §18).
  useEffect(() => { setBadge(unread); }, [unread]);
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="relative rounded-md p-2 hover:bg-muted">
        <Bell size={17} />
        {unread > 0 && <span className="absolute right-1 top-1 grid h-4 min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] text-destructive-foreground">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-40 w-80 rounded-lg border border-border bg-card shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2 text-sm font-medium">
            {t('notifications.title')}
            <button className="text-xs text-muted-foreground hover:underline" onClick={() => readAll.mutate()}>{t('notifications.markAllRead')}</button>
          </div>
          <div className="max-h-96 overflow-auto">
            {(data?.data ?? []).length === 0 && <div className="p-4 text-sm text-muted-foreground">{t('common.nothingYet')}</div>}
            {(data?.data ?? []).map((n) => (
              <div key={n.id} className={`border-b border-border px-3 py-2 text-sm ${n.readAt ? 'opacity-60' : ''}`}>
                <div className="font-medium">{n.type}</div>
                <div className="text-xs text-muted-foreground">{n.entityRef ?? ''} · {new Date(n.createdAt).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
