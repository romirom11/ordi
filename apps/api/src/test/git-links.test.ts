/**
 * The git-links module behind the webhook: a pull request row follows what
 * the forge last said, a branch stays as first recorded, and two deliveries
 * naming the same ref at once leave one row.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { syncGitLink } from '../domains/integrations/git-links';

let taskId: string;

beforeAll(async () => {
  await resetDb();
  const users = await seedRolesAndUsers();
  const owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Git links', revenueSource: 'none' }));
  const project = await json(owner.post('/projects', { name: 'Git links', key: 'GLK', projectTypeId: type.id }));
  taskId = (await json(owner.post('/tasks', { projectId: project.id, title: 'Link me', priority: 'none', assigneeIds: [], labelIds: [] }))).id;
});

const rows = async () => {
  const { db } = getDb();
  return db.select().from(schema.gitLinks).where(eq(schema.gitLinks.taskId, taskId));
};

describe('git links', () => {
  it('a pull request row follows the forge: state and title move, and the previous state is reported', async () => {
    const pr = { taskId, repositoryId: null, type: 'pr' as const, externalRef: '87', title: 'GLK-1: Link me', url: 'https://github.com/acme/app/pull/87', state: 'open', author: 'dev' };
    const opened = await syncGitLink(pr);
    expect(opened).toMatchObject({ created: true, previousState: null });
    const merged = await syncGitLink({ ...pr, title: 'GLK-1: Link me (edited)', state: 'merged' });
    expect(merged).toMatchObject({ id: opened.id, created: false, previousState: 'open' });
    const [row] = await rows();
    expect(row).toMatchObject({ id: opened.id, state: 'merged', title: 'GLK-1: Link me (edited)', author: 'dev' });
  });

  it('a branch is what it is: a second delivery does not rewrite it', async () => {
    const branch = { taskId, repositoryId: null, type: 'branch' as const, externalRef: 'feature/glk-1-link-me', title: 'feature/glk-1-link-me', author: 'dev' };
    const created = await syncGitLink(branch);
    expect(created.created).toBe(true);
    const again = await syncGitLink({ ...branch, title: 'renamed?', author: 'someone else' });
    expect(again).toMatchObject({ id: created.id, created: false, previousState: null });
    expect((await rows()).find((r) => r.type === 'branch')).toMatchObject({ title: branch.title, author: 'dev' });
  });

  it('deliveries naming the same ref at the same moment leave one row, created by one of them', async () => {
    const commit = { taskId, repositoryId: null, type: 'commit' as const, externalRef: 'abc123', title: 'GLK-1: one commit' };
    const results = await Promise.all([syncGitLink(commit), syncGitLink(commit), syncGitLink(commit)]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect((await rows()).filter((r) => r.type === 'commit')).toHaveLength(1);
  });
});
