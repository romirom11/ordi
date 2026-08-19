/**
 * The project/task surface an agent plans from: find the project by key, read
 * its vocabulary, list a date window, open a card, and write it back without
 * doubling rows or overwriting somebody's edit.
 *
 * The fake below models the API closely enough for those properties to mean
 * something: it merges customFields by key, refuses a stale `version` with the
 * real error code, and rejects a custom-field filter whose key has no
 * definition – the three server behaviours the tools are built around.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, textToDoc, docToText } from './server';
import { OrdiClient, OrdiApiError } from './client';

type Row = Record<string, any>;

interface Fake {
  client: OrdiClient;
  gets: string[];
  posts: { path: string; body: any }[];
  patches: { path: string; body: any }[];
  tasks: Row[];
  links: Map<string, Row[]>;
  comments: Map<string, Row[]>;
  fields: Row[];
}

const STATUSES = [
  { id: 'st-idea', name: 'Idea', category: 'backlog', color: '#6b7280', position: 1000, isDefault: true },
  { id: 'st-sched', name: 'Scheduled', category: 'todo', color: '#3b82f6', position: 2000, isDefault: false },
  { id: 'st-pub', name: 'Published', category: 'done', color: '#10b981', position: 3000, isDefault: false },
];
const LABELS = [
  { id: 'lb-li', name: 'LinkedIn', color: '#0a66c2', scope: 'task' },
  { id: 'lb-case', name: 'Case study', color: '#f59e0b', scope: 'task' },
  { id: 'lb-retainer', name: 'retainer', color: '#111111', scope: 'project' },
];
const TYPES = [{ id: 'ty-post', name: 'Post', projectId: null, icon: 'circle', color: '#6b7280' }];
const PROJECT = { id: '01JBFAKEPROJECT00000000001', key: 'CONTENT', name: 'Content', status: 'active' };

/** An in-memory ordi with the parts of the task API these tools touch. */
function fakeOrdi(seed: Partial<{ tasks: Row[]; fields: Row[] }> = {}): Fake {
  const client = new OrdiClient({ baseUrl: 'http://test', token: 't' });
  const state: Fake = {
    client,
    gets: [],
    posts: [],
    patches: [],
    tasks: seed.tasks ?? [],
    links: new Map(),
    comments: new Map(),
    fields: seed.fields ?? [{ id: 'f-platform', entityType: 'tasks', key: 'platform', label: 'Platform', type: 'select', options: [{ value: 'linkedin', label: 'LinkedIn' }], required: false, deprecated: false }],
  };

  const withRef = (t: Row) => ({ ...t, ref: `${PROJECT.key}-${t.number}` });
  const notFound = (what: string) => new OrdiApiError(404, 'not_found', `${what} not found`);

  client.get = async <T>(path: string): Promise<T> => {
    state.gets.push(path);
    const [route, query] = path.split('?');
    const qs = new URLSearchParams(query ?? '');
    if (route === '/projects') return { data: [PROJECT] } as T;
    if (route === `/projects/${PROJECT.id}`) return PROJECT as T;
    if (route === `/projects/${PROJECT.id}/task-statuses`) return { data: STATUSES } as T;
    if (route === '/task-types') return { data: TYPES } as T;
    if (route === '/labels') return { data: LABELS.filter((l) => l.scope === (qs.get('scope') ?? l.scope)) } as T;
    if (route === '/custom-fields') return { data: state.fields } as T;
    if (route === '/users/lookup') return { data: [{ id: 'u1', name: 'Roman' }] } as T;

    if (route === '/tasks') {
      const wantLabels = (qs.get('label') ?? '').split(',').filter(Boolean);
      const cf = JSON.parse(qs.get('cf') ?? '[]') as { field_key: string; op: string; value: any }[];
      for (const f of cf) {
        // The API validates the filter against the custom-field registry.
        if (!state.fields.some((d) => d.key === f.field_key)) {
          throw new OrdiApiError(400, 'validation_error', `Unknown custom field '${f.field_key}'`);
        }
      }
      const data = state.tasks.filter((t) => (
        (!qs.get('projectId') || t.projectId === qs.get('projectId'))
        && (!qs.get('status') || t.statusId === qs.get('status'))
        && (!qs.get('type') || t.typeId === qs.get('type'))
        && (!qs.get('dueFrom') || (t.dueDate ?? '') >= qs.get('dueFrom')!)
        && (!qs.get('dueTo') || (t.dueDate ?? '') <= qs.get('dueTo')!)
        && wantLabels.every((id) => (t.labelIds ?? []).includes(id))
        && cf.every((f) => (f.op === 'in' ? f.value.includes(t.customFields?.[f.field_key]) : t.customFields?.[f.field_key] === f.value))
      )).map(withRef);
      return { data, nextCursor: null } as T;
    }

    const single = /^\/tasks\/([^/]+)$/.exec(route ?? '');
    if (single) {
      const task = state.tasks.find((t) => t.id === single[1]);
      if (!task) throw notFound('Task');
      const include = (qs.get('include') ?? '').split(',');
      const out: Row = withRef(task);
      if (include.includes('labels')) out.labels = (task.labelIds ?? []).map((id: string) => LABELS.find((l) => l.id === id));
      if (include.includes('links')) out.links = state.links.get(task.id) ?? [];
      if (include.includes('comments')) out.comments = state.comments.get(task.id) ?? [];
      if (include.includes('assignees')) out.assignees = (task.assigneeIds ?? []).map((id: string) => ({ userId: id, name: 'Roman' }));
      return out as T;
    }
    throw notFound(`GET ${path}`);
  };

  client.post = async <T>(path: string, body?: any): Promise<T> => {
    state.posts.push({ path, body });
    if (path === '/tasks') {
      const task: Row = {
        id: `t${state.tasks.length + 1}`,
        number: state.tasks.length + 1,
        projectId: body.projectId,
        title: body.title,
        description: body.description ?? null,
        statusId: body.statusId ?? 'st-idea',
        typeId: body.typeId ?? null,
        priority: body.priority ?? 'none',
        dueDate: body.dueDate ?? null,
        startDate: body.startDate ?? null,
        labelIds: body.labelIds ?? [],
        assigneeIds: body.assigneeIds ?? [],
        customFields: body.customFields ?? {},
        version: 1,
        createdAt: '2026-07-01T00:00:00Z',
        updatedAt: '2026-07-01T00:00:00Z',
      };
      state.tasks.push(task);
      return withRef(task) as T;
    }
    const link = /^\/tasks\/([^/]+)\/links$/.exec(path);
    if (link) {
      const rows = state.links.get(link[1]!) ?? [];
      rows.push({ id: `l${rows.length + 1}`, url: body.url, title: body.title });
      state.links.set(link[1]!, rows);
      return { id: `l${rows.length}` } as T;
    }
    throw notFound(`POST ${path}`);
  };

  client.patch = async <T>(path: string, body?: any): Promise<T> => {
    state.patches.push({ path, body });
    const single = /^\/tasks\/([^/]+)$/.exec(path);
    if (!single) throw notFound(`PATCH ${path}`);
    const task = state.tasks.find((t) => t.id === single[1]);
    if (!task) throw notFound('Task');
    if (body.version !== undefined && body.version !== task.version) {
      throw new OrdiApiError(409, 'version_conflict', 'The record was modified by someone else', { id: task.id, version: task.version });
    }
    for (const [k, v] of Object.entries(body)) {
      if (k === 'version') continue;
      if (k === 'customFields') task.customFields = { ...task.customFields, ...(v as Row) };
      else task[k] = v;
    }
    task.version += 1;
    return withRef(task) as T;
  };

  return state;
}

async function connect(api: OrdiClient) {
  const server = buildServer(api);
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const body = (res: any) => JSON.parse(res.content[0].text);
const errorText = (res: any) => res.content[0].text as string;

describe('finding the project and its structure', () => {
  it('exposes the whole planning surface', async () => {
    const client = await connect(fakeOrdi().client);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['get_project_schema', 'list_tasks', 'get_task', 'create_task', 'update_task', 'add_task_link', 'upsert_task']) {
      expect(names).toContain(n);
    }
  });

  it('answers a project key with its statuses, types, task labels and task fields', async () => {
    const api = fakeOrdi();
    const client = await connect(api.client);
    const schema = body(await client.callTool({ name: 'get_project_schema', arguments: { project: 'content' } }));
    expect(schema.project).toEqual({ id: PROJECT.id, key: 'CONTENT', name: 'Content', status: 'active' });
    expect(schema.statuses.map((s: Row) => s.name)).toEqual(['Idea', 'Scheduled', 'Published']);
    expect(schema.taskTypes).toEqual([{ id: 'ty-post', name: 'Post', scope: 'workspace' }]);
    // Project labels belong to the project picker, not to a task card.
    expect(schema.labels.map((l: Row) => l.name)).toEqual(['LinkedIn', 'Case study']);
    expect(schema.customFields).toEqual([{ key: 'platform', label: 'Platform', type: 'select', options: [{ value: 'linkedin', label: 'LinkedIn' }], required: false }]);
  });

  it('names the keys it can reach when the project is unknown', async () => {
    const client = await connect(fakeOrdi().client);
    const res = await client.callTool({ name: 'get_project_schema', arguments: { project: 'MARKETING' } });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain('CONTENT');
  });

  it('list_projects filters by key', async () => {
    const client = await connect(fakeOrdi().client);
    const found = body(await client.callTool({ name: 'list_projects', arguments: { key: 'content' } }));
    expect(found.data.map((p: Row) => p.id)).toEqual([PROJECT.id]);
    const missing = body(await client.callTool({ name: 'list_projects', arguments: { key: 'NOPE' } }));
    expect(missing.data).toEqual([]);
  });
});

describe('listing the calendar', () => {
  const seeded = () => fakeOrdi({ tasks: [
    { id: 't1', number: 1, projectId: PROJECT.id, title: 'Agents in production', statusId: 'st-sched', typeId: 'ty-post', priority: 'none', dueDate: '2026-08-10', labelIds: ['lb-li'], customFields: { platform: 'linkedin' }, version: 1, description: textToDoc('Body') },
    { id: 't2', number: 2, projectId: PROJECT.id, title: 'Case study: Northwind', statusId: 'st-sched', typeId: 'ty-post', priority: 'none', dueDate: '2026-08-03', labelIds: ['lb-li', 'lb-case'], customFields: { platform: 'linkedin' }, version: 1 },
    { id: 't3', number: 3, projectId: PROJECT.id, title: 'Old post', statusId: 'st-pub', typeId: 'ty-post', priority: 'none', dueDate: '2026-07-01', labelIds: [], customFields: { platform: 'x' }, version: 1 },
  ] });

  it('translates names to ids, passes the date window through and answers in calendar order', async () => {
    const api = seeded();
    const client = await connect(api.client);
    const res = body(await client.callTool({ name: 'list_tasks', arguments: {
      project: 'CONTENT', status: 'Scheduled', labels: ['LinkedIn'], type: 'Post',
      dueFrom: '2026-08-01', dueTo: '2026-08-31', customFields: { platform: 'linkedin' },
    } }));
    const requested = api.gets.find((g) => g.startsWith('/tasks?'))!;
    expect(requested).toContain('status=st-sched');
    expect(requested).toContain('label=lb-li');
    expect(requested).toContain('type=ty-post');
    expect(requested).toContain('dueFrom=2026-08-01');
    expect(requested).toContain('dueTo=2026-08-31');
    // Sorted by the date they are planned for, not by creation.
    expect(res.data.map((t: Row) => t.ref)).toEqual(['CONTENT-2', 'CONTENT-1']);
    expect(res.data[0]).toMatchObject({ status: 'Scheduled', type: 'Post', labels: ['LinkedIn', 'Case study'], dueDate: '2026-08-03' });
  });

  it('requires every named label to be present', async () => {
    const api = seeded();
    const client = await connect(api.client);
    const res = body(await client.callTool({ name: 'list_tasks', arguments: { project: 'CONTENT', labels: ['LinkedIn', 'Case study'] } }));
    expect(res.data.map((t: Row) => t.id)).toEqual(['t2']);
  });

  it('refuses an unknown status by naming the ones that exist', async () => {
    const client = await connect(seeded().client);
    const res = await client.callTool({ name: 'list_tasks', arguments: { project: 'CONTENT', status: 'Ready to post' } });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain('Scheduled');
  });
});

describe('opening a card', () => {
  it('returns text, date, status, labels, links, comments and the version to write back with', async () => {
    const api = fakeOrdi({ tasks: [{
      id: 't1', number: 7, projectId: PROJECT.id, title: 'Agents in production',
      description: textToDoc('Hook line.\n\nBody paragraph.'), statusId: 'st-sched', typeId: 'ty-post',
      priority: 'none', dueDate: '2026-08-10', labelIds: ['lb-li'], assigneeIds: ['u1'],
      customFields: { platform: 'linkedin', external_key: 'post-1' }, version: 4,
      createdAt: 'x', updatedAt: 'y',
    }] });
    api.links.set('t1', [{ id: 'l1', url: 'https://news.example/ai', title: 'Trend source' }]);
    api.comments.set('t1', [{ id: 'c1', authorId: 'u1', body: textToDoc('Shorten the hook'), createdAt: 'z', editedAt: null }]);

    const client = await connect(api.client);
    const card = body(await client.callTool({ name: 'get_task', arguments: { taskId: 't1' } }));
    expect(card).toMatchObject({
      ref: 'CONTENT-7', title: 'Agents in production', text: 'Hook line.\n\nBody paragraph.',
      dueDate: '2026-08-10', status: 'Scheduled', statusCategory: 'todo', labels: ['LinkedIn'],
      customFields: { platform: 'linkedin', external_key: 'post-1' }, version: 4,
    });
    expect(card.links).toEqual([{ id: 'l1', url: 'https://news.example/ai', title: 'Trend source' }]);
    expect(card.comments).toEqual([{ id: 'c1', authorId: 'u1', author: 'Roman', createdAt: 'z', editedAt: null, text: 'Shorten the hook', reactions: {} }]);
    expect(card.assignees).toEqual([{ userId: 'u1', name: 'Roman' }]);
  });
});

describe('images embedded in the body', () => {
  const SRC = '/api/v1/files/att1/token123';
  const withImage = () => fakeOrdi({ tasks: [{
    id: 't1', number: 1, projectId: PROJECT.id, title: 'Broken calendar', statusId: 'st-idea',
    priority: 'none', dueDate: null, labelIds: [], customFields: {}, version: 1,
    description: { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'The holiday name is cut off:' }] },
      { type: 'image', attrs: { src: SRC, alt: 'screenshot.png' } },
      { type: 'paragraph', content: [{ type: 'text', text: 'Show the full name.' }] },
    ] },
  }] });

  it('get_task shows the image as a fetchable markdown line, in place', async () => {
    const client = await connect(withImage().client);
    const card = body(await client.callTool({ name: 'get_task', arguments: { taskId: 't1' } }));
    expect(card.text).toBe(`The holiday name is cut off:\n\n![screenshot.png](http://test${SRC})\n\nShow the full name.`);
  });

  it('a rewrite keeps the image and stores its path root-relative again', async () => {
    const api = withImage();
    const client = await connect(api.client);
    const card = body(await client.callTool({ name: 'get_task', arguments: { taskId: 't1' } }));
    await client.callTool({ name: 'update_task', arguments: {
      taskId: 't1', text: card.text.replace('Show the full name.', 'Fixed.'), expectedVersion: 1,
    } });
    const stored = JSON.stringify(api.patches[0]!.body.description);
    expect(stored).toContain(`"src":"${SRC}"`);
    expect(stored).not.toContain('http://test');
    const after = body(await client.callTool({ name: 'get_task', arguments: { taskId: 't1' } }));
    expect(after.text).toBe(`The holiday name is cut off:\n\n![screenshot.png](http://test${SRC})\n\nFixed.`);
  });

  it('an upsert re-run over an image body is not mistaken for a hand edit', async () => {
    const api = fakeOrdi();
    const client = await connect(api.client);
    const args = {
      project: 'CONTENT', key: 'bug-1', title: 'Broken calendar', status: 'Idea',
      text: `Cut off:\n\n![screenshot.png](http://test${SRC})`,
    };
    await client.callTool({ name: 'upsert_task', arguments: args });
    expect(JSON.stringify(api.tasks[0]!.description)).toContain(`"src":"${SRC}"`);
    const rerun = await client.callTool({ name: 'upsert_task', arguments: args });
    expect(rerun.isError).toBeFalsy();
    expect(api.tasks).toHaveLength(1);
  });

  it('an image line round-trips through the stored document', () => {
    const text = 'Intro\n\n![shot](/api/v1/files/a/b)\n\nOutro';
    expect(docToText(textToDoc(text))).toBe(text);
  });
});

describe('creating a full card', () => {
  it('writes title, body, date, status, type, labels, custom fields and sources in one call', async () => {
    const api = fakeOrdi();
    const client = await connect(api.client);
    const res = body(await client.callTool({ name: 'create_task', arguments: {
      projectId: 'CONTENT', title: 'Agents in production',
      text: 'Hook line.\n\nBody paragraph.', status: 'Scheduled', type: 'Post',
      dueDate: '2026-08-10', labels: ['LinkedIn'], customFields: { platform: 'linkedin' },
      links: [{ url: 'https://news.example/ai', title: 'Trend source' }],
    } }));

    const created = api.posts.find((p) => p.path === '/tasks')!.body;
    expect(created).toMatchObject({
      projectId: PROJECT.id, title: 'Agents in production', statusId: 'st-sched', typeId: 'ty-post',
      dueDate: '2026-08-10', labelIds: ['lb-li'], customFields: { platform: 'linkedin' },
      description: textToDoc('Hook line.\n\nBody paragraph.'),
    });
    expect(api.posts.filter((p) => p.path.endsWith('/links'))).toHaveLength(1);
    expect(res).toMatchObject({ action: 'created', links: [{ url: 'https://news.example/ai', added: true }] });
    expect(res.task).toMatchObject({ ref: 'CONTENT-1', status: 'Scheduled', labels: ['LinkedIn'], version: 1 });
  });

  it('body text survives the round trip through the stored document', async () => {
    const api = fakeOrdi();
    const client = await connect(api.client);
    const text = 'Hook line.\n\nBody paragraph.\nSecond line.\n\nClosing.';
    await client.callTool({ name: 'create_task', arguments: { projectId: 'CONTENT', title: 'T', text } });
    const card = body(await client.callTool({ name: 'get_task', arguments: { taskId: 't1' } }));
    expect(card.text).toBe(text);
    expect(docToText(textToDoc(text))).toBe(text);
  });

  it('refuses a second task under an externalKey that already exists', async () => {
    const api = fakeOrdi({ tasks: [{
      id: 't1', number: 1, projectId: PROJECT.id, title: 'Already filed', statusId: 'st-idea',
      priority: 'none', dueDate: null, labelIds: [], customFields: { external_key: 'post-1' }, version: 1,
    }] });
    const client = await connect(api.client);
    const res = await client.callTool({ name: 'create_task', arguments: {
      projectId: 'CONTENT', title: 'Already filed', externalKey: 'post-1',
    } });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain('CONTENT-1');
    expect(api.posts).toEqual([]);
  });
});

describe('upsert_task is the repeatable write', () => {
  const args = {
    project: 'CONTENT', key: '2026-08-10-linkedin-agents', title: 'Agents in production',
    text: 'Hook line.\n\nBody paragraph.', status: 'Scheduled', dueDate: '2026-08-10',
    labels: ['LinkedIn'], customFields: { platform: 'linkedin' },
  };

  it('creates once and updates the same task on a re-run', async () => {
    const api = fakeOrdi();
    const client = await connect(api.client);

    const first = body(await client.callTool({ name: 'upsert_task', arguments: args }));
    expect(first.action).toBe('created');
    expect(api.tasks).toHaveLength(1);
    expect(api.tasks[0]!.customFields.external_key).toBe(args.key);

    const second = body(await client.callTool({ name: 'upsert_task', arguments: { ...args, dueDate: '2026-08-12' } }));
    expect(second.action).toBe('updated');
    expect(api.tasks).toHaveLength(1);
    expect(api.tasks[0]!.dueDate).toBe('2026-08-12');
    expect(api.posts.filter((p) => p.path === '/tasks')).toHaveLength(1);
  });

  it('uses the custom-field filter when the key field is defined, and scans when it is not', async () => {
    const defined = fakeOrdi({ fields: [{ id: 'f-key', entityType: 'tasks', key: 'external_key', label: 'External key', type: 'text', options: [], required: false, deprecated: false }] });
    const client = await connect(defined.client);
    await client.callTool({ name: 'upsert_task', arguments: args });
    expect(defined.gets.some((g) => g.includes('cf=') && g.includes('external_key'))).toBe(true);

    const undefinedField = fakeOrdi();
    const client2 = await connect(undefinedField.client);
    await client2.callTool({ name: 'upsert_task', arguments: args });
    // The filtered read is rejected, the scan answers, and the task is still created once.
    expect(undefinedField.tasks).toHaveLength(1);
  });

  it('refuses to overwrite an edit made in ordi, unless forced', async () => {
    const api = fakeOrdi();
    const client = await connect(api.client);
    await client.callTool({ name: 'upsert_task', arguments: args });

    // Someone rewrites the post and moves it in the app.
    api.tasks[0]!.title = 'Agents in production (edited by hand)';
    api.tasks[0]!.dueDate = '2026-08-17';
    api.tasks[0]!.version += 1;

    const refused = await client.callTool({ name: 'upsert_task', arguments: args });
    expect(refused.isError).toBe(true);
    expect(errorText(refused)).toContain('CONTENT-1');
    expect(api.tasks[0]!.title).toBe('Agents in production (edited by hand)');

    const forced = body(await client.callTool({ name: 'upsert_task', arguments: { ...args, force: true } }));
    expect(forced.action).toBe('updated');
    expect(api.tasks[0]!.title).toBe('Agents in production');
  });

  it('an untouched task is not mistaken for an edited one, however often it is written', async () => {
    const api = fakeOrdi();
    const client = await connect(api.client);
    await client.callTool({ name: 'upsert_task', arguments: args });
    for (let i = 0; i < 3; i++) {
      const res = await client.callTool({ name: 'upsert_task', arguments: args });
      expect(res.isError).toBeFalsy();
    }
    expect(api.tasks).toHaveLength(1);
  });

  it('leaves the task alone with ifExists: skip', async () => {
    const api = fakeOrdi();
    const client = await connect(api.client);
    await client.callTool({ name: 'upsert_task', arguments: args });
    const res = body(await client.callTool({ name: 'upsert_task', arguments: { ...args, title: 'Rewritten', ifExists: 'skip' } }));
    expect(res.action).toBe('skipped');
    expect(api.tasks[0]!.title).toBe('Agents in production');
  });
});

describe('editing a card', () => {
  const seeded = () => fakeOrdi({ tasks: [{
    id: 't1', number: 1, projectId: PROJECT.id, title: 'Agents in production',
    description: textToDoc('Draft'), statusId: 'st-sched', typeId: 'ty-post', priority: 'none',
    dueDate: '2026-08-10', labelIds: ['lb-li'], customFields: { platform: 'linkedin' }, version: 4,
  }] });

  it('moves the date, changes the status and text, and appends the published permalink', async () => {
    const api = seeded();
    const client = await connect(api.client);
    const res = body(await client.callTool({ name: 'update_task', arguments: {
      taskId: 't1', text: 'Final copy.', status: 'Published', dueDate: '2026-08-12',
      expectedVersion: 4,
      addLinks: [{ url: 'https://www.linkedin.com/posts/abc' }],
    } }));
    expect(api.patches[0]!.body).toMatchObject({
      description: textToDoc('Final copy.'), statusId: 'st-pub', dueDate: '2026-08-12', version: 4,
    });
    expect(res.task).toMatchObject({ status: 'Published', dueDate: '2026-08-12', version: 5 });
    // A link with no title is named after its host.
    expect(api.links.get('t1')).toEqual([{ id: 'l1', url: 'https://www.linkedin.com/posts/abc', title: 'linkedin.com' }]);
  });

  it('reports a stale expectedVersion as a conflict a model can recover from', async () => {
    const api = seeded();
    const client = await connect(api.client);
    const res = await client.callTool({ name: 'update_task', arguments: { taskId: 't1', title: 'x', expectedVersion: 2 } });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain('version_conflict');
    expect(errorText(res)).toContain('Current version: 4');
    expect(errorText(res)).toContain('get_task');
  });

  it('locks on the version it just read when none is given', async () => {
    const api = seeded();
    const client = await connect(api.client);
    await client.callTool({ name: 'update_task', arguments: { taskId: 't1', title: 'Renamed' } });
    expect(api.patches[0]!.body.version).toBe(4);
  });

  it('does not attach the same source twice', async () => {
    const api = seeded();
    api.links.set('t1', [{ id: 'l1', url: 'https://news.example/ai', title: 'Trend source' }]);
    const client = await connect(api.client);
    const res = body(await client.callTool({ name: 'add_task_link', arguments: { taskId: 't1', url: 'https://news.example/ai/' } }));
    expect(res.added).toBe(false);
    expect(api.links.get('t1')).toHaveLength(1);

    const added = body(await client.callTool({ name: 'add_task_link', arguments: { taskId: 't1', url: 'https://www.linkedin.com/posts/abc' } }));
    expect(added.added).toBe(true);
    expect(api.links.get('t1')).toHaveLength(2);
  });

  it('says what is missing instead of writing nothing', async () => {
    const api = seeded();
    const client = await connect(api.client);
    const res = await client.callTool({ name: 'update_task', arguments: { taskId: 't1' } });
    expect(res.isError).toBe(true);
    expect(api.patches).toEqual([]);
  });

  it('turns a missing task into a message that names the fix', async () => {
    const client = await connect(seeded().client);
    const res = await client.callTool({ name: 'get_task', arguments: { taskId: 'nope' } });
    expect(res.isError).toBe(true);
    expect(errorText(res)).toContain('not_found');
    expect(errorText(res)).toContain('list_tasks');
  });
});
