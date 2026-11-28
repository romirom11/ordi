/**
 * Where an Inbox row leads. A mention must open exactly where its bell row
 * does (lib/notifications.ts), and a task row the task itself.
 */
import { describe, expect, it } from 'vitest';
import { approvalLink, mentionLink, taskLink, type InboxMention } from './inbox';

const mention = (payload: Partial<InboxMention['payload']>, type = 'comment.mentioned'): InboxMention => ({
  id: 'n1', type, at: 'x', readAt: null, ref: 'ORD-1', title: 'T', actorName: 'Olena',
  payload: { taskId: null, projectId: null, pageId: null, spaceId: null, ...payload },
});

describe('inbox links', () => {
  it('opens the task a question or a stopped run is on', () => {
    expect(taskLink({ id: 't1', projectId: 'p1', ref: 'ORD-1', title: 'T' })).toBe('/projects/p1/tasks/t1');
  });

  it('opens a mention where the bell does: the task, or the KB page', () => {
    expect(mentionLink(mention({ taskId: 't1', projectId: 'p1' }))).toBe('/projects/p1/tasks/t1');
    expect(mentionLink(mention({ pageId: 'pg1', spaceId: 'sp1' }, 'page.mentioned'))).toBe('/kb/sp1/pg1');
  });

  it('sends a leave approval to where it is decided', () => {
    expect(approvalLink('e1')).toBe('/people/e1');
    expect(approvalLink(null)).toBe('/people?tab=leave');
  });
});
