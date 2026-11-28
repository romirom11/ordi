/**
 * The bell shows only what you can still open. A notification is written for
 * someone who could open its project or page at the time; one taken off the
 * private project since (or moved out of the page's space, or kept out of a
 * page made private) used to go on reading its title and link in the list and
 * counting it as unread. Such rows are now left out of the list and the count,
 * and come back as they were when access does: they are hidden, not deleted.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { ulid } from 'ulid';
import { emit } from '../core/events';
import { processOutboxOnce } from '../workers/relay';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { generateToken } from '../lib/crypto';

/** Reads projects and the knowledge base, edits nothing there. */
const READER = ['projects.read', 'kb.read', 'time.track'];

let owner: ReturnType<typeof reqAs>;
let ownerId = '';
let reader: { userId: string; as: ReturnType<typeof reqAs> };
let openProject = '';
let secretProject = '';

type Bell = { data: { id: string; type: string; readAt: string | null; payload: Record<string, unknown> }[]; unread: number };
const bell = async (): Promise<Bell> => json(reader.as.get('/notifications'));

async function assignedTask(projectId: string, title: string): Promise<string> {
  const res = await owner.post('/tasks', { projectId, title, assigneeIds: [reader.userId] });
  expect(res.status).toBe(201);
  await processOutboxOnce();
  return (await json(res)).id;
}

const addToSecret = async () =>
  expect((await owner.post(`/projects/${secretProject}/members`, { userId: reader.userId, role: 'member' })).status).toBe(201);
const removeFromSecret = async () =>
  expect((await owner.del(`/projects/${secretProject}/members/${reader.userId}`)).status).toBeLessThan(300);

beforeAll(async () => {
  await resetDb();
  const users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  ownerId = users.owner!.userId;
  const { db } = getDb();
  const roleId = ulid();
  await db.insert(schema.roles).values({ id: roleId, key: `reader-${roleId}`, name: 'Reader', description: 'custom', isSystem: false });
  await db.insert(schema.rolePermissions).values(READER.map((p) => ({ roleId, permission: p as any })));
  const userId = ulid();
  await db.insert(schema.users).values({ id: userId, email: `${userId}@test.local`, name: 'Reader', passwordHash: 'x', roleId });
  const token = generateToken();
  await db.insert(schema.sessions).values({ id: ulid(), userId, token, expiresAt: new Date(Date.now() + 3600_000) });
  reader = { userId, as: reqAs(`ordi_session=${token}`) };

  const typeId = (await json(owner.post('/project-types', { name: 'Bell', revenueSource: 'none' }))).id;
  openProject = (await json(owner.post('/projects', { name: 'Open', key: 'OPN', projectTypeId: typeId, visibility: 'workspace' }))).id;
  secretProject = (await json(owner.post('/projects', { name: 'Skunkworks', key: 'SKW', projectTypeId: typeId, visibility: 'private' }))).id;
});

describe('a task notification from a private project', () => {
  let secretTask = '';
  let openTask = '';
  let secretNote = '';

  beforeAll(async () => {
    await addToSecret();
    secretTask = await assignedTask(secretProject, 'Falcon launch');
    openTask = await assignedTask(openProject, 'Public chores');
    // A row the secrets service writes itself, past notify().
    secretNote = ulid();
    await getDb().db.insert(schema.notifications).values({
      id: secretNote, userId: reader.userId, type: 'secret.access_overridden', dedupeKey: `test:${secretNote}`,
      entityRef: `project_secret:${ulid()}`, payload: { secretId: ulid(), projectId: secretProject, title: 'Falcon API key' },
    });
  });

  it('shows while the person is on the project', async () => {
    const { data, unread } = await bell();
    expect(data.map((n) => n.payload.taskId)).toEqual(expect.arrayContaining([secretTask, openTask]));
    expect(data.some((n) => n.id === secretNote)).toBe(true);
    expect(unread).toBe(3);
  });

  it('leaves the list and the count once they are taken off it', async () => {
    await removeFromSecret();
    const res = await bell();
    expect(res.data.some((n) => n.payload.taskId === secretTask)).toBe(false);
    expect(res.data.some((n) => n.id === secretNote)).toBe(false);
    expect(JSON.stringify(res)).not.toContain('Falcon');
    expect(JSON.stringify(res)).not.toContain(secretProject);
    // The public project's notification is untouched.
    expect(res.data.find((n) => n.payload.taskId === openTask)).toMatchObject({ type: 'task.assigned', readAt: null });
    expect(res.unread).toBe(1);
  });

  it('marks all read without touching the hidden rows', async () => {
    expect((await reader.as.post('/notifications/read-all')).status).toBe(200);
    expect((await bell()).unread).toBe(0);
    const { db } = getDb();
    const rows = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, reader.userId));
    // Kept, and still unread for when access returns.
    const hidden = rows.filter((r) => (r.payload as Record<string, unknown>).projectId === secretProject);
    expect(hidden).toHaveLength(2);
    expect(hidden.every((r) => r.readAt === null)).toBe(true);
    expect(rows.find((r) => (r.payload as Record<string, unknown>).taskId === openTask)?.readAt).not.toBeNull();
  });

  it('comes back as it was when they are added again', async () => {
    await addToSecret();
    const res = await bell();
    expect(res.data.find((n) => n.payload.taskId === secretTask)).toMatchObject({ type: 'task.assigned', readAt: null });
    expect(res.data.some((n) => n.id === secretNote)).toBe(true);
    expect(res.unread).toBe(2);
  });

  it('goes with a deleted project and returns with its restore', async () => {
    const { db } = getDb();
    await db.update(schema.projects).set({ deletedAt: new Date() }).where(eq(schema.projects.id, secretProject));
    expect((await bell()).data.some((n) => n.payload.taskId === secretTask)).toBe(false);
    await db.update(schema.projects).set({ deletedAt: null }).where(eq(schema.projects.id, secretProject));
    expect((await bell()).data.some((n) => n.payload.taskId === secretTask)).toBe(true);
  });

  it('leaves news that is not about project work alone, project or not', async () => {
    // Finance news may name a project its audience cannot open (the consumer
    // does not gate it either); a reminder with no project at all stays too.
    await removeFromSecret();
    const { db } = getDb();
    const paid = ulid();
    const expiring = ulid();
    await db.insert(schema.notifications).values([
      { id: paid, userId: reader.userId, type: 'invoice.paid', dedupeKey: `test:${paid}`, entityRef: 'INV-1', payload: { invoiceId: ulid(), projectId: secretProject } },
      { id: expiring, userId: reader.userId, type: 'agent.credential_expiring', dedupeKey: `test:${expiring}`, entityRef: 'cred', payload: { credentialId: ulid() } },
    ]);
    const { data } = await bell();
    expect(data.map((n) => n.id)).toEqual(expect.arrayContaining([paid, expiring]));
    await addToSecret();
  });
});

describe('a page mention', () => {
  let spaceId = '';
  let pageId = '';

  beforeAll(async () => {
    const { db } = getDb();
    spaceId = ulid();
    pageId = ulid();
    await db.insert(schema.kbSpaces).values({ id: spaceId, name: 'Handbook' });
    await db.insert(schema.kbPages).values({ id: pageId, spaceId, title: 'Orbit handbook', createdBy: ownerId, published: true });
    await emit({
      type: 'page.mentioned', aggregateType: 'page', aggregateId: pageId,
      payload: { pageId, spaceId, mentions: [reader.userId] },
      actorId: ownerId, actorType: 'user',
    });
    await processOutboxOnce();
  });

  const mentioned = async () => (await bell()).data.some((n) => n.type === 'page.mentioned' && n.payload.pageId === pageId);
  const setPage = (patch: Partial<typeof schema.kbPages.$inferInsert>) =>
    getDb().db.update(schema.kbPages).set(patch).where(eq(schema.kbPages.id, pageId));

  it('shows while the page is open to them', async () => {
    expect(await mentioned()).toBe(true);
  });

  it('hides while the page is private to its author, and returns when it is not', async () => {
    await setPage({ visibility: 'private' });
    expect(await mentioned()).toBe(false);
    expect(JSON.stringify(await bell())).not.toContain('Orbit');
    await setPage({ visibility: 'public' });
    expect(await mentioned()).toBe(true);
  });

  it('hides while the page is a draft', async () => {
    await setPage({ published: false });
    expect(await mentioned()).toBe(false);
    await setPage({ published: true });
    expect(await mentioned()).toBe(true);
  });

  it('hides while its space is closed to them', async () => {
    const { db } = getDb();
    await db.update(schema.kbSpaces).set({ visibility: 'private' }).where(eq(schema.kbSpaces.id, spaceId));
    expect(await mentioned()).toBe(false);
    await db.insert(schema.spaceMembers).values({ spaceId, userId: reader.userId, role: 'viewer' });
    expect(await mentioned()).toBe(true);
  });

  it('hides once the page is deleted', async () => {
    await setPage({ deletedAt: new Date() });
    expect(await mentioned()).toBe(false);
    await setPage({ deletedAt: null });
    expect(await mentioned()).toBe(true);
  });
});
