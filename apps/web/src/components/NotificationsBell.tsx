/**
 * NotificationsBell – the bell in the sidebar's identity row. An icon button
 * with a live unread count, sitting beside the account button rather than
 * taking a nav-style row of its own: the bell and the badge already say what
 * a text label would, and the row it used to occupy was competing with real
 * navigation. Clicking opens the panel upward, anchored to the sidebar.
 */
import { useState, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell, Inbox, CheckSquare, AtSign, Receipt, CalendarRange, FileCheck2, BookText, CheckCheck,
} from 'lucide-react';
import { api } from '../lib/api';
import { useNavigate } from '../lib/router';
import { useT, extendDict } from '../lib/i18n';
import { setBadge } from '../lib/desktop';
import { cn, fmtRelative, Tooltip } from './ui';
import { ContextMenu } from './overlays';

extendDict({
  en: {
    'notif.task.assigned': 'Task assigned to you',
    'notif.task.status_changed': 'Task status changed',
    'notif.comment.mentioned': 'You were mentioned',
    'notif.page.mentioned': 'You were mentioned on a page',
    'notif.invoice.paid': 'Invoice paid',
    'notif.payment.recorded': 'Payment recorded',
    'notif.quote.accepted': 'Quote accepted',
    'notif.leave.requested': 'Leave request pending',
    'notif.leave.decided': 'Leave request decided',
    'notif.git.pr_merged': 'Pull request merged',
  },
  uk: {
    'notif.task.assigned': 'Вам призначено задачу',
    'notif.task.status_changed': 'Змінено статус задачі',
    'notif.comment.mentioned': 'Вас згадали',
    'notif.page.mentioned': 'Вас згадали на сторінці',
    'notif.invoice.paid': 'Рахунок оплачено',
    'notif.payment.recorded': 'Зафіксовано оплату',
    'notif.quote.accepted': 'Кошторис прийнято',
    'notif.leave.requested': 'Запит на відпустку',
    'notif.leave.decided': 'Рішення щодо відпустки',
    'notif.git.pr_merged': 'Пулреквест злито',
  },
});

interface Notif { id: string; type: string; entityRef: string | null; payload: Record<string, unknown>; readAt: string | null; createdAt: string }

/** Deep link for a notification, mirroring the server-side email links. */
function notifLink(n: Notif): string | null {
  const p = n.payload ?? {};
  const projectId = p.projectId as string | undefined;
  const taskId = (p.taskId as string | undefined) ?? (p.id as string | undefined);
  if (n.type.startsWith('task.') || n.type === 'comment.mentioned') {
    return projectId && taskId ? `/projects/${projectId}/tasks/${taskId}` : '/my-tasks';
  }
  if (n.type === 'page.mentioned' && p.spaceId && p.pageId) return `/kb/${p.spaceId as string}/${p.pageId as string}`;
  if (n.type === 'invoice.paid' || n.type === 'payment.recorded') {
    return p.invoiceId ? `/finance/invoices/${p.invoiceId as string}` : '/finance';
  }
  if (n.type === 'quote.accepted') return '/finance';
  if (n.type.startsWith('leave.')) return '/people';
  return null;
}

/** Icon per notification type family. */
function notifIcon(type: string): ReactNode {
  if (type.startsWith('task.')) return <CheckSquare size={14} />;
  if (type.startsWith('comment.')) return <AtSign size={14} />;
  if (type.startsWith('page.')) return <BookText size={14} />;
  if (type.startsWith('invoice.') || type.startsWith('payment.')) return <Receipt size={14} />;
  if (type.startsWith('quote.')) return <FileCheck2 size={14} />;
  if (type.startsWith('leave.')) return <CalendarRange size={14} />;
  return <Bell size={14} />;
}

export function NotificationsBell() {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // The bell sits at the right edge of a narrow sidebar, so a panel anchored to
  // it would hang off the left of the screen. Line the panel up with the
  // sidebar's own left edge instead and let it grow rightwards over the page.
  const [panelPos, setPanelPos] = useState<{ left: number; bottom: number }>({ left: 10, bottom: 10 });
  useLayoutEffect(() => {
    if (!open || !rootRef.current) return;
    const bell = rootRef.current.getBoundingClientRect();
    const rail = rootRef.current.closest('aside')?.getBoundingClientRect();
    setPanelPos({
      left: Math.max(8, (rail?.left ?? bell.left) + 10),
      bottom: Math.max(8, window.innerHeight - bell.top + 6),
    });
  }, [open]);
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
      <ContextMenu
        items={[
          { key: 'read', label: t('notifications.markAllRead'), icon: <CheckCheck size={13} />, disabled: unread === 0, onSelect: () => readAll.mutate() },
        ]}
      >
      <Tooltip label={t('notifications.title')} side="top">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-label={unread > 0 ? `${t('notifications.title')} (${unread})` : t('notifications.title')}
          aria-expanded={open}
          className={cn(
            'relative grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors duration-150',
            open ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
          )}
        >
          <Bell size={16} />
          {/* Pulled clear of the glyph: a two-digit badge sitting on the
              button's corner used to cover most of the bell. */}
          {unread > 0 && (
            <span className={cn(
              'anim-pop-in absolute -right-1.5 -top-1.5 grid h-[14px] place-items-center rounded-full',
              'bg-primary px-[3px] text-[9px] font-semibold leading-none tabular-nums text-primary-foreground',
              'ring-2 ring-background',
              unread > 9 ? 'min-w-[18px]' : 'min-w-[14px]',
            )}>
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      </Tooltip>
      </ContextMenu>
      {open && (
        <div
          className="fixed z-50 w-80 overflow-hidden rounded-lg border border-border bg-elevated shadow-pop"
          style={{
            left: panelPos.left,
            bottom: panelPos.bottom,
            animation: 'dropdown-in 250ms var(--ease-smooth-out) both',
            transformOrigin: 'bottom left',
          }}
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-[13px] font-semibold">{t('notifications.title')}</span>
            {unread > 0 && (
              <button className="text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground" onClick={() => readAll.mutate()}>
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
            {(data?.data ?? []).map((n, i) => {
              const to = notifLink(n);
              return (
                <button
                  key={n.id}
                  type="button"
                  disabled={!to}
                  onClick={() => { if (to) { setOpen(false); navigate(to); } }}
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
