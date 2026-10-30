/**
 * NotificationsBell – the bell in the sidebar's identity row. An icon button
 * with a live unread count, sitting beside the account button rather than
 * taking a nav-style row of its own: the bell and the badge already say what
 * a text label would, and the row it used to occupy was competing with real
 * navigation. Clicking opens the panel upward, anchored to the sidebar.
 */
import { useState, useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell, Inbox, CheckSquare, AtSign, Receipt, CalendarRange, FileCheck2, BookText, CheckCheck,
  GitPullRequest, X,
} from 'lucide-react';
import { api } from '../lib/api';
import { useNavigate, usePathname } from '../lib/router';
import { useT } from '../lib/i18n';
import { setBadge } from '../lib/desktop';
import { notifLink, type Notif } from '../lib/notifications';
import { cn, fmtRelative, IconButton } from './ui';
import { ContextMenu, useOverlayLayer } from './overlays';
import { focusIsLost, restoreFocus, tabbables, wrapTabIndex } from '../lib/overlayA11y';
import { QueryFeedback } from './QueryFeedback';

/** Icon per notification type family. */
function notifIcon(type: string): ReactNode {
  if (type.startsWith('task.')) return <CheckSquare size={14} />;
  if (type.startsWith('comment.')) return <AtSign size={14} />;
  if (type.startsWith('page.')) return <BookText size={14} />;
  if (type.startsWith('git.')) return <GitPullRequest size={14} />;
  if (type.startsWith('invoice.') || type.startsWith('payment.')) return <Receipt size={14} />;
  if (type.startsWith('quote.')) return <FileCheck2 size={14} />;
  if (type.startsWith('leave.')) return <CalendarRange size={14} />;
  return <Bell size={14} />;
}

export function NotificationsBell({ visible = true }: { visible?: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useOverlayLayer(open, () => setOpen(false));
  useEffect(() => { setOpen(false); }, [path, visible]);
  // The row lives inside a narrow sidebar, so the panel is wider than its
  // trigger: line it up with the sidebar's left edge and let it grow
  // rightwards over the page. Vertically it starts at the row and is clamped
  // into the viewport, so the same code works wherever the row ends up.
  const [panelPos, setPanelPos] = useState<{ left: number; top: number }>({ left: 10, top: 10 });
  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const row = rootRef.current.getBoundingClientRect();
    const rail = rootRef.current.closest('aside')?.getBoundingClientRect();
    const h = panelRef.current?.offsetHeight ?? 300;
    setPanelPos({
      left: Math.max(8, (rail?.left ?? row.left) + 10),
      top: Math.min(Math.max(8, row.top), Math.max(8, window.innerHeight - h - 8)),
    });
  }, [open]);
  const notificationsQ = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ data: Notif[]; unread: number }>('/notifications'),
    refetchInterval: 60_000,
  });
  const { data } = notificationsQ;
  const readAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  // Opening a notification is reading it. Following the link without this left
  // the row glowing as new and the badge counting something already seen,
  // which is why the bell kept insisting on a mention answered minutes ago.
  const markRead = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (panel) (tabbables(panel)[0] ?? panel).focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      if (focusIsLost(panel)) restoreFocus(triggerRef.current);
    };
  }, [open]);

  const unread = data?.unread ?? 0;
  // Desktop: mirror the unread count onto the dock/taskbar badge (PRD §18).
  useEffect(() => { setBadge(unread); }, [unread]);

  return (
    <div className="relative" ref={rootRef}>
      <ContextMenu
        items={[
          { key: 'read', label: t('notifications.markAllRead'), icon: <CheckCheck size={13} />, disabled: unread === 0, onSelect: () => readAll.mutate() },
        ]}
      >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={unread > 0 ? `${t('notifications.title')} (${unread})` : t('notifications.title')}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        className={cn(
          'group/nav flex w-full items-center gap-2.5 rounded-md px-2 py-[5px] text-left text-[13px] transition-colors duration-150',
          open ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )}
      >
        <span className={cn('transition-colors', open ? 'text-foreground' : 'text-faint group-hover/nav:text-muted-foreground')}>
          <Bell size={16} />
        </span>
        <span className="min-w-0 flex-1 truncate">{t('notifications.title')}</span>
        {/* The count reads at a glance here – as a badge over the glyph, two
            digits covered the bell. */}
        {unread > 0 && (
          <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      </ContextMenu>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={t('notifications.title')}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key !== 'Tab' || !panelRef.current) return;
            const items = tabbables(panelRef.current);
            const next = wrapTabIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
            if (next !== null) { e.preventDefault(); items[next]!.focus(); }
          }}
          className="fixed z-50 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-elevated shadow-pop"
          style={{
            left: panelPos.left,
            top: panelPos.top,
            animation: 'dropdown-in 250ms var(--ease-smooth-out) both',
            transformOrigin: 'top left',
          }}
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-[13px] font-semibold">{t('notifications.title')}</span>
            {unread > 0 && (
              <button type="button" disabled={readAll.isPending} className="text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground" onClick={() => readAll.mutate()}>
                {t('notifications.markAllRead')}
              </button>
            )}
            <IconButton type="button" size="sm" aria-label={t('common.close')} onClick={() => setOpen(false)}><X size={14} /></IconButton>
          </div>
          <div className="max-h-96 overflow-auto p-1">
            {notificationsQ.isError && <QueryFeedback stale={data !== undefined} pending={notificationsQ.isFetching} onRetry={() => void notificationsQ.refetch()} />}
            {notificationsQ.isLoading && <p className="p-4 text-xs text-muted-foreground">{t('common.loading')}</p>}
            {!notificationsQ.isLoading && !notificationsQ.isError && (data?.data ?? []).length === 0 && (
              <div className="flex flex-col items-center gap-2 py-10 text-muted-foreground">
                <Inbox size={20} className="text-faint" />
                <span className="text-[13px]">{t('common.nothingYet')}</span>
              </div>
            )}
            {(data?.data ?? []).map((n, i) => {
              const to = notifLink(n);
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => {
                    if (!n.readAt) markRead.mutate(n.id);
                    if (to) { setOpen(false); navigate(to); }
                  }}
                  className={cn(
                    'row-enter flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors duration-150 hover:bg-muted',
                    n.readAt && 'opacity-55',
                    !to && 'cursor-default',
                  )}
                  style={{ ['--i' as string]: Math.min(i, 8) }}
                >
                  <span className="relative mt-px grid h-6 w-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                    {notifIcon(n.type)}
                    {!n.readAt && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-elevated" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{t(`notif.${n.type}`, n.type.replace(/[._]/g, ' '))}</div>
                    {n.entityRef && <div className="truncate font-mono text-[11px] text-muted-foreground">{n.entityRef}</div>}
                  </div>
                  <span className="shrink-0 pt-px text-[11px] tabular-nums text-faint">{fmtRelative(n.createdAt)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
