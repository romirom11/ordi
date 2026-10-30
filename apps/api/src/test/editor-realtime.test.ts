import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq, getDb, schema } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { consumers } from '../workers/consumers';
import { broadcaster, type SSEMessage } from '../core/events';
import type { DomainEvent } from '@ordi/shared';

let owner: ReturnType<typeof reqAs>;
beforeAll(async () => {
  await resetDb();
  const users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
});

describe('editor updates reach open details without leaking text', () => {
  it('emits a project-scoped task update for description-only changes', async () => {
    const type = await json(owner.post('/project-types', { name: 'Realtime', revenueSource: 'none' }));
    const project = await json(owner.post('/projects', { name: 'Realtime', key: 'RTE', projectTypeId: type.id }));
    const task = await json(owner.post('/tasks', { projectId: project.id, title: 'Task' }));
    const response = await owner.patch(`/tasks/${task.id}`, { description: { type: 'doc', content: [] }, version: task.version });
    expect(response.status).toBe(200);
    await expectUpdate('task.updated', 'task', task.id, { taskId: task.id, projectId: project.id }, 'projectScope', project.id);
    expect((await owner.patch(`/tasks/${task.id}`, { title: 'Stale', version: task.version })).status).toBe(409);
    const events = await getDb().db.select().from(schema.events).where(and(eq(schema.events.type, 'task.updated'), eq(schema.events.aggregateId, task.id)));
    expect(events).toHaveLength(1);
  });

  it('emits a space-scoped page update for body-only changes', async () => {
    const space = await json(owner.post('/spaces', { name: 'Private', visibility: 'private' }));
    const page = await json(owner.post('/pages', { spaceId: space.id, title: 'Page' }));
    const response = await owner.patch(`/pages/${page.id}`, { body: { type: 'doc', content: [] }, version: page.version });
    expect(response.status).toBe(200);
    await expectUpdate('page.updated', 'page', page.id, { pageId: page.id, spaceId: space.id }, 'spaceScope', space.id);
  });
});

async function expectUpdate(type: DomainEvent['type'], aggregateType: DomainEvent['aggregateType'], id: string, payload: Record<string, string>, scope: 'projectScope' | 'spaceScope', scopeId: string) {
  const [event] = await getDb().db.select().from(schema.events).where(and(eq(schema.events.type, type), eq(schema.events.aggregateId, id)));
  expect(event?.payload).toEqual(payload);
  const frames: SSEMessage[] = [];
  const unsubscribe = broadcaster.subscribe((message) => frames.push(message));
  try {
    await consumers.find((consumer) => consumer.name === 'sse')!.handle({
      id: event!.id, type, aggregateType, aggregateId: id, payload,
      actorId: event!.actorId, actorType: 'user', occurredAt: event!.occurredAt.toISOString(),
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]![scope]).toEqual([scopeId]);
    expect(frames[0]!.data).not.toHaveProperty('body');
    expect(frames[0]!.data).not.toHaveProperty('description');
  } finally { unsubscribe(); }
}
