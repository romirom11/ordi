/**
 * `in` on a custom field: "any of these values". It used to bind the list as
 * one value, which the query builder spreads into `= any($1, $2)` – invalid
 * SQL, so every such request failed with a 500. MCP's list_tasks sends any
 * array as `in`, whatever the field's type. Each value is now a bound
 * parameter cast to the field's type, and a list that cannot be compared is a
 * 400.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { getDb, schema } from '@ordi/db';
import { ulid } from 'ulid';
import { PgDialect } from 'drizzle-orm/pg-core';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { generateToken } from '../lib/crypto';
import { buildCustomFieldFilter } from '../core/customfields';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let projectId: string;
let sizedAsNumber: string;
let sizedAsText: string;

const owner = () => reqAs(users.owner!.cookie);

type Filter = { field_key: string; op: string; value: unknown };
const cfQuery = (filters: Filter[] | unknown) => `cf=${encodeURIComponent(JSON.stringify(filters))}`;

async function list(filters: Filter[], query = `projectId=${projectId}&`) {
  return owner().get(`/tasks?${query}${cfQuery(filters)}`);
}

async function titles(key: string, value: unknown, query?: string): Promise<string[]> {
  const res = await list([{ field_key: key, op: 'in', value }], query);
  expect(res.status).toBe(200);
  return ((await json(res)).data as { title: string }[]).map((t) => t.title).sort();
}

async function field(key: string, type: string, extra: Record<string, unknown> = {}) {
  const res = await owner().post('/custom-fields', { entityType: 'tasks', key, label: key, type, ...extra });
  expect(res.status).toBe(201);
}

async function task(project: string, title: string, customFields: Record<string, unknown>) {
  const res = await owner().post('/tasks', { projectId: project, title, customFields });
  expect(res.status).toBe(201);
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  const type = await json(owner().post('/project-types', { name: 'Content', revenueSource: 'none' }));
  const project = async (name: string, key: string) =>
    (await json(owner().post('/projects', { name, key, projectTypeId: type.id }))).id as string;
  projectId = await project('Content', 'CIN');
  sizedAsNumber = await project('Sized by number', 'SZN');
  sizedAsText = await project('Sized by text', 'SZT');

  await field('platform', 'text');
  await field('tier', 'select', { options: [{ value: 'gold', label: 'Gold' }, { value: 'silver', label: 'Silver' }, { value: 'bronze', label: 'Bronze' }] });
  await field('tags', 'multiselect', { options: [{ value: 'video', label: 'Video' }, { value: 'blog', label: 'Blog' }, { value: 'pod', label: 'Pod' }] });
  await field('points', 'number');
  await field('launch', 'date');
  await field('source', 'url');
  await field('reviewer', 'user');
  await field('urgent', 'checkbox');

  const member = users.member!.userId;
  const admin = users.admin?.userId ?? users.owner!.userId;
  await task(projectId, 'Alpha', {
    platform: 'linkedin', tier: 'gold', tags: ['video', 'blog'], points: 3, launch: '2026-08-03',
    source: 'https://a.example', reviewer: member, urgent: true,
  });
  await task(projectId, 'Bravo', {
    platform: 'x', tier: 'silver', tags: ['pod'], points: 5, launch: '2026-08-10',
    source: 'https://b.example', reviewer: admin, urgent: false,
  });
  await task(projectId, 'Charlie', {
    platform: "o'reilly", tier: 'bronze', tags: [], points: 8.5, launch: '2026-09-01',
    source: 'https://c.example', urgent: false,
  });
  await task(projectId, 'Delta', {});
  // Values are stored as sent: nothing checks them against the field's type.
  await task(projectId, 'Echo', { points: '', launch: '2026-02-30', tags: { video: false }, tier: ['gold'] });
  await task(projectId, 'Foxtrot', { points: { n: 3 }, launch: 'soon', tags: 'pod', tier: null });
  await task(projectId, 'Golf', { points: '5', launch: '2026-08-10T09:30:00Z' });

  // One key, two projects, two types.
  const sized = await owner().post('/custom-fields', { entityType: 'tasks', key: 'size', label: 'Size', type: 'number', projectId: sizedAsNumber });
  expect(sized.status).toBe(201);
  const sizedText = await owner().post('/custom-fields', { entityType: 'tasks', key: 'size', label: 'Size', type: 'text', projectId: sizedAsText });
  expect(sizedText.status).toBe(201);
  await task(sizedAsNumber, 'Number one', { size: 1 });
  await task(sizedAsNumber, 'Number two', { size: 2 });
  await task(sizedAsNumber, 'Number ten', { size: 10 });
  await task(sizedAsText, 'Text one', { size: '1' });
  await task(sizedAsText, 'Text small', { size: 'small' });
  await task(sizedAsText, 'Text large', { size: 'large' });
});

describe('in with several values, per type', () => {
  it('text', async () => {
    expect(await titles('platform', ['linkedin', 'x'])).toEqual(['Alpha', 'Bravo']);
    expect(await titles('platform', ['linkedin'])).toEqual(['Alpha']);
  });

  it('select', async () => {
    expect(await titles('tier', ['gold', 'bronze'])).toEqual(['Alpha', 'Charlie']);
  });

  it('multiselect: a record holding any of the values', async () => {
    // An object's keys are not its values; a lone string is one value.
    expect(await titles('tags', ['blog', 'pod'])).toEqual(['Alpha', 'Bravo', 'Foxtrot']);
    expect(await titles('tags', ['video'])).toEqual(['Alpha']);
    expect(await titles('tags', ['n'])).toEqual([]);
    expect(await titles('tags', ['nothing'])).toEqual([]);
  });

  it('number, given as numbers or numeric text', async () => {
    expect(await titles('points', [3, 8.5])).toEqual(['Alpha', 'Charlie']);
    expect(await titles('points', ['5', 3])).toEqual(['Alpha', 'Bravo', 'Golf']);
  });

  it('date', async () => {
    expect(await titles('launch', ['2026-08-10', '2026-09-01'])).toEqual(['Bravo', 'Charlie', 'Golf']);
  });

  it('url', async () => {
    expect(await titles('source', ['https://a.example', 'https://c.example'])).toEqual(['Alpha', 'Charlie']);
  });

  it('user', async () => {
    expect(await titles('reviewer', [users.member!.userId])).toEqual(['Alpha']);
  });

  it('companies take it too', async () => {
    expect((await owner().post('/custom-fields', {
      entityType: 'companies', key: 'segment', label: 'Segment', type: 'select',
      options: [{ value: 'smb', label: 'SMB' }, { value: 'ent', label: 'Enterprise' }, { value: 'gov', label: 'Gov' }],
    })).status).toBe(201);
    for (const [name, segment] of [['Small Co', 'smb'], ['Big Co', 'ent'], ['State', 'gov']]) {
      expect((await owner().post('/companies', { name, status: 'active', customFields: { segment } })).status).toBe(201);
    }
    const res = await owner().get(`/companies?${cfQuery([{ field_key: 'segment', op: 'in', value: ['smb', 'gov'] }])}`);
    expect(res.status).toBe(200);
    expect(((await json(res)).data as { name: string }[]).map((c) => c.name).sort()).toEqual(['Small Co', 'State']);
  });
});

describe('a key two projects define with different types', () => {
  const everywhere = 'limit=200&';

  it('numbers match in both projects, each by its own type', async () => {
    expect(await titles('size', [1, 2], everywhere)).toEqual(['Number one', 'Number two', 'Text one']);
  });

  it('values that are no numbers match only where the key is text; the numbers among them match in both', async () => {
    expect(await titles('size', ['small', 'large'], everywhere)).toEqual(['Text large', 'Text small']);
    expect(await titles('size', ['small', '1'], everywhere)).toEqual(['Number one', 'Text one', 'Text small']);
  });

  it('inside the number project, text values are a 400', async () => {
    const res = await list([{ field_key: 'size', op: 'in', value: ['small'] }], `projectId=${sizedAsNumber}&`);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await json(res))).toContain('needs numbers');
  });

  it('inside the text project, numbers match as text', async () => {
    expect(await titles('size', [1, 10], `projectId=${sizedAsText}&`)).toEqual(['Text one']);
  });
});

describe('an empty list', () => {
  it.each(['platform', 'tier', 'tags', 'points', 'launch', 'source', 'reviewer'])('on %s is a 400', async (key) => {
    const res = await list([{ field_key: key, op: 'in', value: [] }]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await json(res))).toContain('non-empty list');
  });

  it('on a key two projects type differently is a 400', async () => {
    const res = await list([{ field_key: 'size', op: 'in', value: [] }], 'limit=200&');
    expect(res.status).toBe(400);
  });
});

describe('an invalid value', () => {
  const bad: [string, string, unknown][] = [
    ['a single value, not a list', 'platform', 'linkedin'],
    ['null', 'tier', null],
    ['an object', 'tier', { gold: true }],
    ['a list holding an object', 'platform', [{ x: 1 }]],
    ['a list holding a list', 'tags', [['video']]],
    ['a list holding null', 'platform', [null]],
    ['a list holding a boolean', 'tier', [true]],
    ['a number field given text', 'points', ['three']],
    ['a number field given a blank', 'points', [' ']],
    ['a date field given text', 'launch', ['soon']],
    ['a date that does not exist', 'launch', ['2026-02-30']],
    ['year 0000', 'launch', ['0000-01-01']],
    ['a number with a no-break space', 'points', ['\u00a03']],
    ['a number with a space', 'points', [' 3']],
    ['a hex number', 'points', ['0x10']],
    ['Infinity', 'points', ['Infinity']],
  ];

  it.each(bad)('%s is a 400', async (_name, key, value) => {
    const res = await list([{ field_key: key, op: 'in', value }]);
    expect(res.status).toBe(400);
  });

  it('a list longer than the cap is a 400', async () => {
    const value = Array.from({ length: 501 }, (_, i) => `v${i}`);
    expect((await list([{ field_key: 'platform', op: 'in', value }])).status).toBe(400);
  });

  it('a checkbox takes eq, not in', async () => {
    const res = await list([{ field_key: 'urgent', op: 'in', value: [true] }]);
    expect(res.status).toBe(400);
    expect((await list([{ field_key: 'urgent', op: 'eq', value: true }])).status).toBe(200);
  });

  it('a list given to eq is a 400, not a 500', async () => {
    expect((await list([{ field_key: 'platform', op: 'eq', value: ['linkedin', 'x'] }])).status).toBe(400);
    expect((await list([{ field_key: 'points', op: 'gt', value: [1, 2] }])).status).toBe(400);
  });

  it('the other operators check their operands too', async () => {
    expect((await list([{ field_key: 'points', op: 'eq', value: 'three' }])).status).toBe(400);
    expect((await list([{ field_key: 'points', op: 'between', value: [[1, 2], 3] }])).status).toBe(400);
    expect((await list([{ field_key: 'launch', op: 'before', value: '2026-02-30' }])).status).toBe(400);
    expect((await list([{ field_key: 'platform', op: 'contains', value: { a: 1 } }])).status).toBe(400);
    // A timestamp still reads as its day for the date operators.
    const res = await list([{ field_key: 'launch', op: 'eq', value: '2026-08-10T12:00:00Z' }]);
    expect(res.status).toBe(200);
    expect(((await json(res)).data as { title: string }[]).map((t) => t.title).sort()).toEqual(['Bravo', 'Golf']);
  });

  it('a stored value of the wrong type is no match, not a 500, for any operator', async () => {
    expect(await titles('points', [3])).toEqual(['Alpha']);
    for (const [op, value] of [['eq', 3], ['gt', 0], ['lt', 100], ['between', [0, 100]]] as const) {
      expect((await list([{ field_key: 'points', op, value }])).status).toBe(200);
    }
    for (const [op, value] of [['eq', '2026-08-03'], ['before', '2030-01-01'], ['after', '2000-01-01']] as const) {
      expect((await list([{ field_key: 'launch', op, value }])).status).toBe(200);
    }
    // A list stored in a select field is no match for its text.
    expect(await titles('tier', ['gold'])).toEqual(['Alpha']);
  });

  it('a cf that is not a JSON list of filters is a 400', async () => {
    expect((await owner().get(`/tasks?projectId=${projectId}&cf=${encodeURIComponent('not json')}`)).status).toBe(400);
    expect((await owner().get(`/tasks?projectId=${projectId}&cf=`)).status).toBe(400);
    expect((await owner().get('/companies?cf=')).status).toBe(400);
    expect((await owner().get(`/tasks?projectId=${projectId}&${cfQuery({ field_key: 'platform', op: 'in', value: ['x'] })}`)).status).toBe(400);
    expect((await owner().get(`/tasks?projectId=${projectId}&${cfQuery([{ field_key: 'platform', op: 'like', value: 'x' }])}`)).status).toBe(400);
    expect((await owner().get(`/companies?cf=${encodeURIComponent('{')}`)).status).toBe(400);
  });
});

describe('someone who can open no project', () => {
  it('gets a 400 for a malformed filter, not an empty list', async () => {
    const { db } = getDb();
    const roleId = ulid();
    await db.insert(schema.roles).values({ id: roleId, key: `none-${roleId}`, name: 'No projects', description: 'custom', isSystem: false });
    await db.insert(schema.rolePermissions).values({ roleId, permission: 'crm.read' as any });
    const userId = ulid();
    await db.insert(schema.users).values({ id: userId, email: `${userId}@test.local`, name: 'Outside', passwordHash: 'x', roleId });
    const token = generateToken();
    await db.insert(schema.sessions).values({ id: ulid(), userId, token, expiresAt: new Date(Date.now() + 3600_000) });
    const outsider = reqAs(`ordi_session=${token}`);
    const empty = await outsider.get(`/tasks?${cfQuery([{ field_key: 'platform', op: 'in', value: [] }])}`);
    expect(empty.status).toBe(400);
    const valid = await outsider.get(`/tasks?${cfQuery([{ field_key: 'platform', op: 'in', value: ['x'] }])}`);
    expect(valid.status).toBe(200);
    expect((await json(valid)).data).toEqual([]);
  });
});

describe('values are bound, never spliced into the SQL', () => {
  it('the key and every value are parameters of the query', async () => {
    const dialect = new PgDialect();
    for (const [key, value] of [['platform', ["x') or true --", 'linkedin']], ['tags', ["video'] or true"]], ['points', ['1', 2]]] as const) {
      const built = await buildCustomFieldFilter('tasks', { field_key: key, op: 'in', value: [...value] });
      const query = dialect.sqlToQuery(built);
      expect(query.params).toContain(key);
      for (const v of value) {
        expect(query.params).toContain(String(v));
        if (typeof v === 'string' && v.length > 2) expect(query.sql).not.toContain(v);
      }
      expect(query.sql).not.toContain(`'${key}'`);
    }
  });

  it('a quote in a value matches that text exactly', async () => {
    expect(await titles('platform', ["o'reilly"])).toEqual(['Charlie']);
  });

  it('an injection attempt matches nothing and breaks nothing', async () => {
    expect(await titles('platform', ["x') or true --", "linkedin' or '1'='1"])).toEqual([]);
    expect(await titles('tags', ["video'] or true --"])).toEqual([]);
    expect((await list([{ field_key: 'points', op: 'in', value: ['1); drop table tasks; --'] }])).status).toBe(400);
    // The table is still there.
    expect(await titles('platform', ['linkedin'])).toEqual(['Alpha']);
  });
});
