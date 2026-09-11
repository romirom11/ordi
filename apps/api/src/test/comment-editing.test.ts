/**
 * Editing a comment (ORD-29): the author rewrites their own as a project
 * member, anyone else needs project admin, the rewrite is stamped with
 * `editedAt`, and a mention the edit introduces notifies once.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, and, eq } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;
let taskId: string;

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

const docMentioning = (userId: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { id: userId } }] }],
});

/** The comments of the task, freshly read. */
async function comments(cookie: string): Promise<any[]> {
  return (await json(reqAs(cookie).get(`/tasks/${taskId}/comments`))).data as any[];
}

async function addComment(cookie: string, body: unknown): Promise<string> {
  return (await json(reqAs(cookie).post(`/tasks/${taskId}/comments`, { body }))).id as string;
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Content', revenueSource: 'none' }));
  projectId = (await json(owner.post('/projects', { name: 'Content', key: 'CNT', projectTypeId: type.id }))).id;
  // Two plain project members – neither role carries projects.write, so their
  // level on the project is the membership row, not a workspace permission.
  for (const key of ['member', 'sales']) {
    await json(owner.post(`/projects/${projectId}/members`, { userId: users[key]!.userId, role: 'member', canWriteTasks: true }));
  }
  taskId = (await json(owner.post('/tasks', { projectId, title: 'Discussed thing' }))).id;
});

describe('comment editing', () => {
  it('lets the author rewrite their own comment and stamps editedAt', async () => {
    const commentId = await addComment(users.member!.cookie, doc('Looks good'));
    expect((await comments(users.member!.cookie)).find((c) => c.id === commentId).editedAt).toBeNull();

    const res = await reqAs(users.member!.cookie).patch(`/comments/${commentId}`, { body: doc('Looks good, shipping it') });
    expect(res.status).toBe(200);

    const edited = (await comments(users.member!.cookie)).find((c) => c.id === commentId);
    expect(JSON.stringify(edited.body)).toContain('shipping it');
    expect(edited.editedAt).not.toBeNull();
    // The rewrite is one comment, not a second one.
    expect(await comments(users.member!.cookie)).toHaveLength(1);
  });

  it('refuses another member and allows a project admin', async () => {
    const commentId = await addComment(users.member!.cookie, doc('Mine'));

    expect((await reqAs(users.sales!.cookie).patch(`/comments/${commentId}`, { body: doc('Not mine') })).status).toBe(403);
    expect(JSON.stringify((await comments(users.member!.cookie)).find((c) => c.id === commentId).body)).toContain('Mine');

    expect((await reqAs(users.owner!.cookie).patch(`/comments/${commentId}`, { body: doc('Moderated') })).status).toBe(200);
    expect(JSON.stringify((await comments(users.member!.cookie)).find((c) => c.id === commentId).body)).toContain('Moderated');
  });

  it('rejects a patch without a body instead of blanking the comment', async () => {
    const commentId = await addComment(users.member!.cookie, doc('Keep me'));

    // Absent, null, and a document with nothing in it – each would otherwise
    // have overwritten the comment with an empty body.
    for (const body of [{ mentions: [] }, { body: null }, { body: doc('   ') }, { body: { type: 'doc', content: [] } }]) {
      expect((await reqAs(users.member!.cookie).patch(`/comments/${commentId}`, body)).status).toBe(400);
    }
    expect(JSON.stringify((await comments(users.member!.cookie)).find((c) => c.id === commentId).body)).toContain('Keep me');
  });

  it('404s on a comment that does not exist', async () => {
    const res = await reqAs(users.owner!.cookie).patch('/comments/01JMISSING0000000000000000', { body: doc('Nobody') });
    expect(res.status).toBe(404);
  });

  it('notifies a mention the edit adds, and only that one', async () => {
    const { db } = getDb();
    const commentId = await addComment(users.member!.cookie, docMentioning(users.owner!.userId));
    const res = await reqAs(users.member!.cookie).patch(`/comments/${commentId}`, {
      body: {
        type: 'doc',
        content: [{
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { id: users.owner!.userId } },
            { type: 'mention', attrs: { id: users.sales!.userId } },
          ],
        }],
      },
    });
    expect(res.status).toBe(200);

    const events = await db.select().from(schema.events)
      .where(and(eq(schema.events.type, 'comment.mentioned'), eq(schema.events.aggregateId, commentId)))
      .orderBy(schema.events.occurredAt, schema.events.id);
    // One event for the post, one for the edit – the edit carries only the newcomer.
    expect(events).toHaveLength(2);
    expect((events[1]!.payload as any).mentions).toEqual([users.sales!.userId]);
  });
});
