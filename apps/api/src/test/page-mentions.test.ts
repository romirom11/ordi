/**
 * Mentions on a knowledge-base page reach only the people who can open it.
 *
 * The report: @-mentioning someone on a page notified (and emailed) everyone
 * named, so the title of a draft, a private page or a page in a closed space
 * reached people the page itself is closed to. Being mentioned does not open a
 * page: the space rule (membership, the linked project, workspace permissions)
 * and the page rule (a draft for editors, a private page for its author and
 * the editors) both decide, read when the notification is delivered.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { processOutboxOnce } from '../workers/relay';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let openSpace = '';

const mentioning = (...userIds: string[]) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: userIds.map((id) => ({ type: 'mention', attrs: { id } })) }],
});

async function pageMentionsFor(userId: string): Promise<{ type: string; payload: any }[]> {
  const { db } = getDb();
  const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, userId));
  return rows.filter((r) => r.type === 'page.mentioned').map((r) => ({ type: r.type, payload: r.payload as any }));
}

async function emailsTo(userId: string): Promise<number> {
  const { db } = getDb();
  const [user] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId));
  const rows = await db.select().from(schema.emailDeliveries).where(eq(schema.emailDeliveries.to, user!.email));
  return rows.length;
}

const as = (key: string) => reqAs(users[key]!.cookie);

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  openSpace = (await json(as('owner').post('/spaces', { name: 'Handbook', visibility: 'workspace' }))).id;
});

beforeEach(async () => {
  const { db } = getDb();
  await db.delete(schema.notifications);
  await db.delete(schema.emailDeliveries);
});

describe('a page mention reaches readers of the page only', () => {
  it('reaches a reader of a workspace space, not someone without the knowledge base', async () => {
    // sales holds kb.read; finance holds no kb permission at all.
    await json(as('member').post('/pages', {
      spaceId: openSpace, title: 'Release checklist', body: mentioning(users.sales!.userId, users.finance!.userId),
    }));
    await processOutboxOnce();

    expect(await pageMentionsFor(users.sales!.userId)).toHaveLength(1);
    expect(await pageMentionsFor(users.finance!.userId)).toEqual([]);
    expect(await emailsTo(users.finance!.userId)).toBe(0);
  });

  it('keeps a draft to the space editors', async () => {
    // manager edits workspace spaces (kb.write); sales only reads them.
    await json(as('member').post('/pages', {
      spaceId: openSpace, title: 'Layoffs plan', published: false,
      body: mentioning(users.sales!.userId, users.manager!.userId),
    }));
    await processOutboxOnce();

    expect(await pageMentionsFor(users.manager!.userId)).toHaveLength(1);
    expect(await pageMentionsFor(users.sales!.userId)).toEqual([]);
    expect(await emailsTo(users.sales!.userId)).toBe(0);
  });

  it('keeps a private page to its author and the editors, on the page and in its comments', async () => {
    const page = await json(as('member').post('/pages', {
      spaceId: openSpace, title: 'My salary notes', visibility: 'private',
      body: mentioning(users.sales!.userId, users.manager!.userId),
    }));
    await json(as('member').post(`/pages/${page.id}/comments`, { body: mentioning(users.sales!.userId) }));
    await processOutboxOnce();

    expect(await pageMentionsFor(users.manager!.userId)).toHaveLength(1);
    expect(await pageMentionsFor(users.sales!.userId)).toEqual([]);
  });

  it('holds a private space to its members', async () => {
    const closed = (await json(as('owner').post('/spaces', { name: 'Board', visibility: 'private' }))).id;
    await json(as('owner').post(`/spaces/${closed}/members`, { userId: users.hr!.userId, role: 'viewer' }));
    // sales reads workspace spaces, which does not open a private one.
    await json(as('owner').post('/pages', {
      spaceId: closed, title: 'Acquisition', body: mentioning(users.sales!.userId, users.hr!.userId),
    }));
    await processOutboxOnce();

    expect(await pageMentionsFor(users.hr!.userId)).toHaveLength(1);
    expect(await pageMentionsFor(users.sales!.userId)).toEqual([]);
  });

  it('opens a project space to the project’s members only', async () => {
    const { db } = getDb();
    const type = await json(as('owner').post('/project-types', { name: 'Internal', revenueSource: 'none' }));
    const project = await json(as('owner').post('/projects', { name: 'Skunkworks', key: 'SKW', projectTypeId: type.id, visibility: 'private' }));
    await json(as('owner').post(`/projects/${project.id}/members`, { userId: users.guest!.userId, role: 'viewer' }));
    const spaceId = ulid();
    // A private space that belongs to a private project: only the project opens it.
    await db.insert(schema.kbSpaces).values({ id: spaceId, name: 'Skunkworks docs', visibility: 'private', projectId: project.id });
    const pageId = ulid();
    await db.insert(schema.kbPages).values({ id: pageId, spaceId, title: 'Prototype', createdBy: users.owner!.userId });
    await json(as('owner').post(`/pages/${pageId}/comments`, { body: mentioning(users.guest!.userId, users.sales!.userId) }));
    await processOutboxOnce();

    // The guest has no permissions, only the project membership.
    expect(await pageMentionsFor(users.guest!.userId)).toHaveLength(1);
    expect(await pageMentionsFor(users.sales!.userId)).toEqual([]);
  });

  it('decides at delivery: a page made private before the mention goes out tells nobody outside it', async () => {
    const page = await json(as('member').post('/pages', {
      spaceId: openSpace, title: 'Open for now', body: mentioning(users.sales!.userId),
    }));
    // The mention is queued; the page closes before the worker gets to it.
    const { db } = getDb();
    await db.update(schema.kbPages).set({ visibility: 'private' }).where(eq(schema.kbPages.id, page.id));
    await processOutboxOnce();

    expect(await pageMentionsFor(users.sales!.userId)).toEqual([]);
  });

  it('says nothing about a deleted page', async () => {
    const page = await json(as('member').post('/pages', {
      spaceId: openSpace, title: 'Gone soon', body: mentioning(users.sales!.userId),
    }));
    expect((await as('member').del(`/pages/${page.id}`)).status).toBe(200);
    await processOutboxOnce();

    expect(await pageMentionsFor(users.sales!.userId)).toEqual([]);
  });

  it('holds a mention added by an edit to the same rule', async () => {
    const page = await json(as('member').post('/pages', { spaceId: openSpace, title: 'Reorg draft', published: false }));
    const res = await as('member').patch(`/pages/${page.id}`, {
      version: page.version, body: mentioning(users.sales!.userId, users.manager!.userId),
    });
    expect(res.status).toBe(200);
    await processOutboxOnce();

    expect(await pageMentionsFor(users.manager!.userId)).toHaveLength(1);
    expect(await pageMentionsFor(users.sales!.userId)).toEqual([]);
  });

  it('says nothing once the space is deleted', async () => {
    const doomed = (await json(as('owner').post('/spaces', { name: 'Old wiki', visibility: 'workspace' }))).id;
    await json(as('owner').post('/pages', { spaceId: doomed, title: 'Legacy', body: mentioning(users.sales!.userId) }));
    await getDb().db.update(schema.kbSpaces).set({ deletedAt: new Date() }).where(eq(schema.kbSpaces.id, doomed));
    await processOutboxOnce();

    expect(await pageMentionsFor(users.sales!.userId)).toEqual([]);
  });

  it('keeps a draft in a project space to those who edit the project', async () => {
    const { db } = getDb();
    const type = await json(as('owner').post('/project-types', { name: 'Client', revenueSource: 'none' }));
    const project = await json(as('owner').post('/projects', { name: 'Atlas', key: 'ATL', projectTypeId: type.id, visibility: 'private' }));
    await json(as('owner').post(`/projects/${project.id}/members`, { userId: users.hr!.userId, role: 'member' }));
    await json(as('owner').post(`/projects/${project.id}/members`, { userId: users.guest!.userId, role: 'viewer' }));
    const spaceId = ulid();
    await db.insert(schema.kbSpaces).values({ id: spaceId, name: 'Atlas docs', visibility: 'private', projectId: project.id });
    const pageId = ulid();
    await db.insert(schema.kbPages).values({ id: pageId, spaceId, title: 'Pricing (draft)', published: false, createdBy: users.owner!.userId });
    await json(as('owner').post(`/pages/${pageId}/comments`, { body: mentioning(users.hr!.userId, users.guest!.userId) }));
    await processOutboxOnce();

    // A project member edits the project's space; a project viewer only reads it.
    expect(await pageMentionsFor(users.hr!.userId)).toHaveLength(1);
    expect(await pageMentionsFor(users.guest!.userId)).toEqual([]);
  });
});
