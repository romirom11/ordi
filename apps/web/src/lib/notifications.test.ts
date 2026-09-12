/**
 * Where a notification takes the reader. The bell resolved links type by type
 * and missed the ones it had no branch for: a mention on a knowledge page
 * opened the task list, and a merged pull request opened nothing at all.
 *
 * The same table is asserted against notificationPath() in
 * apps/api/src/test/notifications.test.ts, which builds the button in the
 * email – the two must not drift apart.
 */
import { describe, expect, it } from 'vitest';
import { notifLink, notifText } from './notifications';

const task = { projectId: 'p1', taskId: 't1' };

describe('notifLink', () => {
  it('opens the task a task notification is about', () => {
    for (const type of ['task.assigned', 'task.status_changed', 'comment.created', 'comment.mentioned', 'git.pr_merged', 'agent.needs_input']) {
      expect(notifLink({ type, entityRef: null, payload: task })).toBe('/projects/p1/tasks/t1');
    }
  });

  it('falls back to my tasks when the payload has no task to open', () => {
    expect(notifLink({ type: 'task.assigned', entityRef: null, payload: {} })).toBe('/my-tasks');
  });

  it('opens the page a mention on a knowledge page is about', () => {
    const payload = { pageId: 'pg1', spaceId: 'sp1' };
    expect(notifLink({ type: 'page.mentioned', entityRef: null, payload })).toBe('/kb/sp1/pg1');
    // A comment on a page carries the same ids and belongs in the same place.
    expect(notifLink({ type: 'comment.mentioned', entityRef: null, payload })).toBe('/kb/sp1/pg1');
  });

  it('opens the invoice a payment is about, and finance when it is unknown', () => {
    expect(notifLink({ type: 'invoice.paid', entityRef: null, payload: { invoiceId: 'i1' } })).toBe('/finance/invoices/i1');
    expect(notifLink({ type: 'payment.recorded', entityRef: null, payload: { invoiceId: 'i1' } })).toBe('/finance/invoices/i1');
    expect(notifLink({ type: 'invoice.paid', entityRef: null, payload: {} })).toBe('/finance');
  });

  it('routes the remaining families to their section', () => {
    expect(notifLink({ type: 'quote.accepted', entityRef: null, payload: {} })).toBe('/finance');
    expect(notifLink({ type: 'quote.declined', entityRef: null, payload: {} })).toBe('/finance');
    expect(notifLink({ type: 'leave.requested', entityRef: null, payload: {} })).toBe('/people');
    expect(notifLink({ type: 'leave.decided', entityRef: null, payload: {} })).toBe('/people');
    expect(notifLink({ type: 'sales.work_digest', entityRef: null, payload: {} })).toBe('/crm/work');
    expect(notifLink({ type: 'agent.credential_expired', entityRef: null, payload: {} })).toBe('/settings/agents');
  });

  it('has nothing to open for a type it does not know', () => {
    expect(notifLink({ type: 'something.new', entityRef: null, payload: {} })).toBeNull();
  });
});

describe('notifText', () => {
  const t = (key: string, fallback?: string) => (key === 'notif.task.assigned' ? 'Task assigned to you' : fallback ?? key);

  it('reads as the label plus the ref of the thing it is about', () => {
    expect(notifText({ type: 'task.assigned', entityRef: 'DEL-7', payload: {} }, t)).toBe('Task assigned to you: DEL-7');
    expect(notifText({ type: 'task.assigned', entityRef: null, payload: {} }, t)).toBe('Task assigned to you');
  });

  it('falls back to a readable type instead of the dictionary key', () => {
    expect(notifText({ type: 'something.new', entityRef: null, payload: {} }, t)).toBe('something new');
  });
});
