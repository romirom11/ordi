/**
 * Comment reactions (ORD-13): one POST toggles the caller's emoji on and the
 * same POST takes it back, counts aggregate per emoji across users, and the
 * stored map rides along wherever comments are read.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;
let taskId: string;
let commentId: string;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Content', revenueSource: 'none' }));
  projectId = (await json(owner.post('/projects', { name: 'Content', key: 'CNT', projectTypeId: type.id }))).id;
  // The member has to be on the project to react.
  await json(owner.post(`/projects/${projectId}/members`, { userId: users.member!.userId, role: 'member', canWriteTasks: true }));
  taskId = (await json(owner.post('/tasks', { projectId, title: 'Discussed thing' }))).id;
  commentId = (await json(owner.post(`/tasks/${taskId}/comments`, {
    body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks good' }] }] },
  }))).id;
});

describe('comment reactions', () => {
  it('toggles on, aggregates across users, and toggles back off', async () => {
    const owner = reqAs(users.owner!.cookie);
    const member = reqAs(users.member!.cookie);

    const first = await json(owner.post(`/comments/${commentId}/reactions`, { emoji: '👍' }));
    expect(first.reacted).toBe(true);
    expect(first.reactions['👍']).toEqual([users.owner!.userId]);

    const second = await json(member.post(`/comments/${commentId}/reactions`, { emoji: '👍' }));
    expect(second.reactions['👍']).toHaveLength(2);

    // Reactions ride along with the comments read.
    const list = (await json(owner.get(`/tasks/${taskId}/comments`))).data as any[];
    expect(list[0].reactions['👍']).toHaveLength(2);

    const off = await json(owner.post(`/comments/${commentId}/reactions`, { emoji: '👍' }));
    expect(off.reacted).toBe(false);
    expect(off.reactions['👍']).toEqual([users.member!.userId]);
  });

  it('drops the emoji key entirely when the last reaction goes', async () => {
    const member = reqAs(users.member!.cookie);
    const gone = await json(member.post(`/comments/${commentId}/reactions`, { emoji: '👍' }));
    expect(gone.reactions['👍']).toBeUndefined();
  });

  it('rejects an over-long "emoji" and a comment that does not exist', async () => {
    const owner = reqAs(users.owner!.cookie);
    expect((await owner.post(`/comments/${commentId}/reactions`, { emoji: 'not an emoji at all' })).status).toBe(400);
    expect((await owner.post('/comments/01JMISSING0000000000000000/reactions', { emoji: '👍' })).status).toBe(404);
  });
});
