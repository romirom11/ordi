/**
 * A private project leaves no traces on what its outsiders can open: the
 * task lists of a workspace project, its task filters, a company's overview
 * and the trail of a task that moved away.
 *
 * As in private-project-reads.test.ts, two people hold the same broad role
 * and differ only in being on the private project. The outsider must learn
 * nothing about it (not that one of its tasks blocks theirs, not that a field
 * key exists in it, not how many of its tasks are open, not where a task
 * went); the member must see what they always saw.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { generateToken } from '../lib/crypto';

const BROAD = ['projects.read', 'crm.read', 'settings.manage', 'time.read_all'];

let owner: ReturnType<typeof reqAs>;
let insider: { userId: string; as: ReturnType<typeof reqAs> };
let outsider: { userId: string; as: ReturnType<typeof reqAs> };
let roleId = '';
let typeId = '';

let openProject = '';
let secretProject = '';

async function person(name: string) {
  const { db } = getDb();
  const userId = ulid();
  await db.insert(schema.users).values({ id: userId, email: `${userId}@test.local`, name, passwordHash: 'x', roleId });
  const token = generateToken();
  await db.insert(schema.sessions).values({ id: ulid(), userId, token, expiresAt: new Date(Date.now() + 3600_000) });
  return { userId, as: reqAs(`ordi_session=${token}`) };
}

async function task(projectId: string, title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await owner.post('/tasks', { projectId, title, ...extra });
  expect(res.status).toBe(201);
  return (await json(res)).id;
}

beforeAll(async () => {
  await resetDb();
  const users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  const { db } = getDb();
  roleId = ulid();
  await db.insert(schema.roles).values({ id: roleId, key: `broad-${roleId}`, name: 'Broad', description: 'custom', isSystem: false });
  await db.insert(schema.rolePermissions).values(BROAD.map((p) => ({ roleId, permission: p as any })));
  insider = await person('Insider');
  outsider = await person('Outsider');

  typeId = (await json(owner.post('/project-types', { name: 'Traces', revenueSource: 'none' }))).id;
  openProject = (await json(owner.post('/projects', { name: 'Open', key: 'OPN', projectTypeId: typeId, visibility: 'workspace' }))).id;
  secretProject = (await json(owner.post('/projects', { name: 'Skunkworks', key: 'SKW', projectTypeId: typeId, visibility: 'private' }))).id;
  expect((await owner.post(`/projects/${secretProject}/members`, { userId: insider.userId, role: 'member', canWriteTasks: true })).status).toBe(201);
});

type ListedTask = { id: string; blocked: boolean };
const listed = async (who: typeof outsider, query = `projectId=${openProject}`) =>
  (await json(who.as.get(`/tasks?${query}`))).data as ListedTask[];

describe('a task blocked by a task in a private project', () => {
  let waiting = '';
  let alsoWaiting = '';
  beforeAll(async () => {
    waiting = await task(openProject, 'Waiting on something');
    const secretBlocker = await task(secretProject, 'Falcon launch');
    expect((await owner.post(`/tasks/${secretBlocker}/relations`, { relatedTaskId: waiting, type: 'blocks' })).status).toBe(201);
    // One blocked both from inside and from a project everyone can open.
    alsoWaiting = await task(openProject, 'Waiting on two');
    const openBlocker = await task(openProject, 'Public prerequisite');
    expect((await owner.post(`/tasks/${secretBlocker}/relations`, { relatedTaskId: alsoWaiting, type: 'blocks' })).status).toBe(201);
    expect((await owner.post(`/tasks/${openBlocker}/relations`, { relatedTaskId: alsoWaiting, type: 'blocks' })).status).toBe(201);
  });

  it('is not flagged blocked for someone who cannot open the blocker', async () => {
    const rows = await listed(outsider);
    expect(rows.find((t) => t.id === waiting)?.blocked).toBe(false);
    // A blocker they can open still counts.
    expect(rows.find((t) => t.id === alsoWaiting)?.blocked).toBe(true);
    // The same without naming the project.
    expect((await listed(outsider, 'limit=100')).find((t) => t.id === waiting)?.blocked).toBe(false);
  });

  it('is flagged blocked for a member of the blocker\'s project', async () => {
    const rows = await listed(insider);
    expect(rows.find((t) => t.id === waiting)?.blocked).toBe(true);
    expect(rows.find((t) => t.id === alsoWaiting)?.blocked).toBe(true);
  });
});

describe('filtering tasks by a private project\'s field', () => {
  let marked = '';
  beforeAll(async () => {
    const res = await owner.post('/custom-fields', {
      entityType: 'tasks', key: 'falcon_budget', label: 'Falcon budget', type: 'number', projectId: secretProject,
    });
    expect(res.status).toBe(201);
    marked = await task(secretProject, 'Budgeted', { customFields: { falcon_budget: 500 } });
  });

  const filter = (who: typeof outsider, key: string, op: string, value: unknown, query = '') =>
    who.as.get(`/tasks?${query}cf=${encodeURIComponent(JSON.stringify([{ field_key: key, op, value }]))}`);

  it('answers the same as a key nobody made, whatever the operator', async () => {
    for (const op of ['gt', 'contains']) {
      const guessed = await filter(outsider, 'falcon_budget', op, 1);
      const madeUp = await filter(outsider, 'no_such_field', op, 1);
      expect(guessed.status).toBe(madeUp.status);
      const guessedBody = JSON.stringify(await json(guessed)).replaceAll('falcon_budget', 'KEY');
      const madeUpBody = JSON.stringify(await json(madeUp)).replaceAll('no_such_field', 'KEY');
      expect(guessedBody).toBe(madeUpBody);
      expect(guessedBody).not.toContain('number');
    }
    // Inside a project they can open, too.
    const inOpen = await filter(outsider, 'falcon_budget', 'gt', 1, `projectId=${openProject}&`);
    const madeUpInOpen = await filter(outsider, 'no_such_field', 'gt', 1, `projectId=${openProject}&`);
    expect(inOpen.status).toBe(madeUpInOpen.status);
  });

  it('works as before for a member of the project', async () => {
    const res = await filter(insider, 'falcon_budget', 'gt', 100);
    expect(res.status).toBe(200);
    expect(((await json(res)).data as ListedTask[]).map((t) => t.id)).toEqual([marked]);
    // The key's type still decides the operators.
    expect((await filter(insider, 'falcon_budget', 'contains', 'x')).status).toBe(400);
    // Listing another project with it finds nothing there, as it always did.
    const elsewhere = await filter(insider, 'falcon_budget', 'gt', 100, `projectId=${openProject}&`);
    expect(elsewhere.status).toBe(200);
    expect((await json(elsewhere)).data).toEqual([]);
  });

  it('casts a shared key only in the projects where it has that type', async () => {
    // The open project keeps the same key as text, holding a value that is no number.
    const res = await owner.post('/custom-fields', {
      entityType: 'tasks', key: 'falcon_budget', label: 'Budget note', type: 'text', projectId: openProject,
    });
    expect(res.status).toBe(201);
    const noted = await task(openProject, 'Noted', { customFields: { falcon_budget: 'about a thousand' } });
    const forMember = await filter(insider, 'falcon_budget', 'gt', 100);
    expect(forMember.status).toBe(200);
    expect(((await json(forMember)).data as ListedTask[]).map((t) => t.id)).toEqual([marked]);
    const text = await filter(outsider, 'falcon_budget', 'contains', 'thousand');
    expect(text.status).toBe(200);
    expect(((await json(text)).data as ListedTask[]).map((t) => t.id)).toEqual([noted]);
    // An operator both types take matches in each project by that project's type.
    const both = await filter(insider, 'falcon_budget', 'eq', 500);
    expect(both.status).toBe(200);
    expect(((await json(both)).data as ListedTask[]).map((t) => t.id)).toEqual([marked]);
    const asText = await filter(insider, 'falcon_budget', 'eq', 'about a thousand', `projectId=${openProject}&`);
    expect(((await json(asText)).data as ListedTask[]).map((t) => t.id)).toEqual([noted]);
    const textEverywhere = await filter(insider, 'falcon_budget', 'eq', 'about a thousand');
    expect(textEverywhere.status).toBe(200);
    expect(((await json(textEverywhere)).data as ListedTask[]).map((t) => t.id)).toEqual([noted]);
    // For the outsider the key is the open project's text field only.
    const asNumber = await filter(outsider, 'falcon_budget', 'gt', 100);
    expect(asNumber.status).toBe(400);
    expect(JSON.stringify(await json(asNumber))).toContain("type 'text'");
  });
});

describe('a shared saved view naming a private project in its filters', () => {
  it('is listed only for those who can open it, and cannot be saved onto it from outside', async () => {
    const res = await insider.as.post('/saved-views', {
      entityType: 'tasks', name: 'Falcon board', isShared: true, filters: { projectId: secretProject, taskFilters: {} },
    });
    expect(res.status).toBe(201);
    const viewId = (await json(res)).id;
    const ids = async (who: typeof outsider) => ((await json(who.as.get('/saved-views?entityType=tasks'))).data as { id: string }[]).map((v) => v.id);
    expect(await ids(outsider)).not.toContain(viewId);
    expect(await ids(insider)).toContain(viewId);
    const probe = await outsider.as.post('/saved-views', { entityType: 'tasks', name: 'Probe', filters: { projectId: secretProject } });
    expect(probe.status).toBe(404);
    // A view of a project the outsider can open is still theirs to save and see.
    const own = await outsider.as.post('/saved-views', { entityType: 'tasks', name: 'Mine', isShared: true, filters: { projectId: openProject } });
    expect(own.status).toBe(201);
    expect(await ids(insider)).toContain((await json(own)).id);
  });
});

describe('a company\'s overview', () => {
  let company = '';
  beforeAll(async () => {
    const res = await owner.post('/companies', { name: 'Acme' });
    expect(res.status).toBe(201);
    company = (await json(res)).id;
    const shared = (await json(owner.post('/projects', { name: 'Acme site', key: 'ACS', projectTypeId: typeId, visibility: 'workspace', companyId: company }))).id;
    const hidden = (await json(owner.post('/projects', { name: 'Acme merger', key: 'ACM', projectTypeId: typeId, visibility: 'private', companyId: company }))).id;
    expect((await owner.post(`/projects/${hidden}/members`, { userId: insider.userId, role: 'viewer' })).status).toBe(201);
    await task(shared, 'Homepage');
    await task(hidden, 'Due diligence');
    await task(hidden, 'Term sheet');
  });

  const overview = async (who: typeof outsider) => json(who.as.get(`/companies/${company}/overview`));

  it('counts only the projects, and their open tasks, the caller can open', async () => {
    const o = await overview(outsider);
    expect(o.totalProjects).toBe(1);
    expect(o.activeProjects).toBe(1);
    expect(o.openTasks).toBe(1);
  });

  it('counts the private project for its member', async () => {
    const o = await overview(insider);
    expect(o.totalProjects).toBe(2);
    expect(o.activeProjects).toBe(2);
    expect(o.openTasks).toBe(3);
  });
});

describe('a task moved into a private project', () => {
  let left = '';
  let moved = '';
  beforeAll(async () => {
    left = await task(openProject, 'Moving out');
    const res = await owner.post(`/tasks/${left}/move`, { targetProjectId: secretProject });
    expect(res.status).toBe(200);
    moved = (await json(res)).id;
  });

  type ActivityRow = { action: string; entityId: string; diff: Record<string, unknown> };
  const movedRecord = async (rows: ActivityRow[]) => rows.find((r) => r.entityId === left && r.action === 'moved');

  it('says on the left-behind task that it moved, not where, to someone who cannot open the destination', async () => {
    const trail = (await json(outsider.as.get(`/audit/entity/task/${left}`))).data as ActivityRow[];
    const record = await movedRecord(trail);
    expect(record).toBeDefined();
    expect(JSON.stringify(trail)).not.toContain(secretProject);
    expect(JSON.stringify(trail)).not.toContain(moved);
    const feed = (await json(outsider.as.get('/dashboard'))).recentActivity as ActivityRow[];
    expect(JSON.stringify(feed)).not.toContain(secretProject);
    expect(JSON.stringify(feed)).not.toContain(moved);
  });

  it('names the destination to a member of it', async () => {
    const record = await movedRecord((await json(insider.as.get(`/audit/entity/task/${left}`))).data as ActivityRow[]);
    expect(record?.diff).toMatchObject({ targetProjectId: { to: secretProject }, newTaskId: { to: moved } });
  });
});
