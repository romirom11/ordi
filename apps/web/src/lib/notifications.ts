/**
 * Notification vocabulary, shared by the bell that lists them and the realtime
 * stream that announces them. Both used to carry their own copy of the labels,
 * so a new type showed up translated in one place and as `task_assigned` in
 * the other.
 */
import { extendDict } from './i18n';

extendDict({
  en: {
    'notif.task.assigned': 'Task assigned to you',
    'notif.task.status_changed': 'Task status changed',
    'notif.comment.mentioned': 'You were mentioned',
    'notif.comment.created': 'New comment on your task',
    'notif.page.mentioned': 'You were mentioned on a page',
    'notif.invoice.paid': 'Invoice paid',
    'notif.payment.recorded': 'Payment recorded',
    'notif.quote.accepted': 'Quote accepted',
    'notif.quote.declined': 'Quote declined',
    'notif.leave.requested': 'Leave request pending',
    'notif.leave.decided': 'Leave request decided',
    'notif.git.pr_merged': 'Pull request merged',
    'notif.sales.work_digest': 'Your sales work is ready',
    'notif.agent.run_finished': 'An agent finished your task',
    'notif.agent.needs_input': 'An agent needs your input',
    'notif.agent.credential_expiring': 'A Claude credential expires soon',
    'notif.agent.credential_expired': 'A Claude credential expired',
  },
  uk: {
    'notif.task.assigned': 'Вам призначено задачу',
    'notif.task.status_changed': 'Змінено статус задачі',
    'notif.comment.mentioned': 'Вас згадали',
    'notif.comment.created': 'Новий коментар у вашій задачі',
    'notif.page.mentioned': 'Вас згадали на сторінці',
    'notif.invoice.paid': 'Рахунок оплачено',
    'notif.payment.recorded': 'Зафіксовано оплату',
    'notif.quote.accepted': 'Кошторис прийнято',
    'notif.quote.declined': 'Кошторис відхилено',
    'notif.leave.requested': 'Запит на відпустку',
    'notif.leave.decided': 'Рішення щодо відпустки',
    'notif.git.pr_merged': 'Пулреквест злито',
    'notif.sales.work_digest': 'Черга продажів готова',
    'notif.agent.run_finished': 'Агент завершив вашу задачу',
    'notif.agent.needs_input': 'Агенту потрібна ваша відповідь',
    'notif.agent.credential_expiring': 'Доступ Claude скоро протермінується',
    'notif.agent.credential_expired': 'Доступ Claude протерміновано',
  },
});

export interface Notif {
  id: string;
  type: string;
  entityRef: string | null;
  payload: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

/** What a row in the bell needs to resolve its label and its link. */
export type NotifRef = Pick<Notif, 'type' | 'entityRef'> & { payload?: Record<string, unknown> | null };

/**
 * Where a notification takes the reader. Mirrors notificationPath() in
 * apps/api/src/workers/consumers.ts, which builds the button in the email:
 * the same notification must not land in two different places.
 */
export function notifLink(n: NotifRef): string | null {
  const p = n.payload ?? {};
  const projectId = p.projectId as string | undefined;
  const taskId = (p.taskId as string | undefined) ?? (p.id as string | undefined);
  const pageId = p.pageId as string | undefined;
  const spaceId = p.spaceId as string | undefined;
  // A mention on a KB page belongs to the page, not to an unrelated task list.
  if (pageId && spaceId) return `/kb/${spaceId}/${pageId}`;
  if (n.type.startsWith('task.') || n.type.startsWith('comment.') || n.type.startsWith('git.')
    || n.type === 'agent.run_finished' || n.type === 'agent.needs_input') {
    return projectId && taskId ? `/projects/${projectId}/tasks/${taskId}` : '/my-tasks';
  }
  if (n.type === 'invoice.paid' || n.type === 'payment.recorded') {
    return p.invoiceId ? `/finance/invoices/${p.invoiceId as string}` : '/finance';
  }
  if (n.type.startsWith('quote.')) return '/finance';
  if (n.type.startsWith('leave.')) return '/people';
  if (n.type === 'sales.work_digest') return '/crm/work';
  // The server's payload.link is absolute; the route is the part the router takes.
  if (n.type.startsWith('agent.credential_')) return '/settings/agents';
  return null;
}

/** One line describing a notification: its label, and the ref when it has one. */
export function notifText(n: NotifRef, t: (key: string, fallback?: string) => string): string {
  const label = t(`notif.${n.type}`, n.type.replace(/[._]/g, ' '));
  const ref = n.entityRef ?? (n.payload?.ref as string | undefined) ?? '';
  return ref ? `${label}: ${ref}` : label;
}
