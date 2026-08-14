/**
 * Slack notification formatting: messages carry Block Kit blocks with the task
 * reference as a compact mrkdwn link (no bare URL in the body) and a context
 * line naming the project, the assignees and the status.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { DomainEvent } from '@ordi/shared';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { buildSlackMessage } from '../workers/consumers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId = '';
let task: any;

function taskEvent(type: 'task.created' | 'task.status_changed'): DomainEvent {
  return {
    id: 'ev-1',
    type,
    aggregateType: 'task',
    aggregateId: task.id,
    payload: { projectId, ref: task.ref },
    occurredAt: new Date(0).toISOString(),
  } as DomainEvent;
}

function sectionText(msg: { blocks: unknown[] }): string {
  return (msg.blocks[0] as any).text.text as string;
}

function contextText(msg: { blocks: unknown[] }): string {
  return (msg.blocks[1] as any).elements[0].text as string;
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  const typeId = (await json(owner.post('/project-types', { name: 'Slack fmt', revenueSource: 'none' }))).id;
  projectId = (await json(owner.post('/projects', { name: 'Finqbit', key: 'FIN', projectTypeId: typeId }))).id;
  task = await json(owner.post('/tasks', {
    projectId,
    title: 'тестова задача <script> & co',
    assigneeIds: [users.member!.userId],
  }));
});

describe('task.created message', () => {
  it('links the ref instead of dumping a raw URL, and names project/assignee/status', async () => {
    const msg = (await buildSlackMessage(taskEvent('task.created')))!;
    expect(msg.projectId).toBe(projectId);

    const section = sectionText(msg);
    // The link is mrkdwn <url|label>: the URL hides behind the short ref.
    expect(section).toContain(`/projects/${projectId}/tasks/${task.id}|${task.ref}>`);
    expect(section).toContain('New task');
    // User text is escaped, not interpreted.
    expect(section).toContain('&lt;script&gt; &amp; co');

    const context = contextText(msg);
    expect(context).toContain('Finqbit');
    expect(context).toContain('Assignee: Member');
    expect(context).toContain('Status:');

    // The notification fallback is plain text without the giant URL.
    expect(msg.text).toBe(`New task ${task.ref}: тестова задача <script> & co`);
    expect(msg.text).not.toContain('http');
  });

  it('says Unassigned when nobody is on the task', async () => {
    const owner = reqAs(users.owner!.cookie);
    const bare = await json(owner.post('/tasks', { projectId, title: 'nobody yet' }));
    const msg = (await buildSlackMessage({
      ...taskEvent('task.created'), aggregateId: bare.id, payload: { projectId, ref: bare.ref },
    } as DomainEvent))!;
    expect(contextText(msg)).toContain('Unassigned');
  });
});

describe('task.status_changed message', () => {
  it('shows the new status inline and keeps the ref link', async () => {
    const msg = (await buildSlackMessage(taskEvent('task.status_changed')))!;
    const section = sectionText(msg);
    expect(section).toContain(`|${task.ref}>`);
    expect(section).toContain('→');
    expect(msg.text).toContain('moved to');
  });
});
