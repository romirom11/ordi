/**
 * The MCP planning loop against the real API and database: find the project by
 * its key, read its structure, file a post with everything on it, re-run the
 * same generation without doubling it, and refuse to overwrite the edit a
 * person made in ordi in between.
 *
 * The tool catalog is driven exactly as a client drives it (in-memory MCP
 * transport); only the HTTP hop is replaced by the test app, so the API
 * contracts these tools depend on – customFields merging, `version` conflicts,
 * label scopes, the custom-field filter – are the real ones.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '@ordi/mcp/server';
import { OrdiClient, OrdiApiError } from '@ordi/mcp/client';
import { app, resetDb, seedRolesAndUsers, reqAs, json } from './helpers';

let users: Awaited<ReturnType<typeof seedRolesAndUsers>>;
let owner: ReturnType<typeof reqAs>;
let mcp: Client;
let projectId = '';
let statusByCategory: Record<string, string> = {};

/** An OrdiClient that speaks to the test app instead of a socket. */
function clientFor(cookie: string): OrdiClient {
  const client = new OrdiClient({ baseUrl: 'http://test', token: 'session' });
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const error = data?.error ?? {};
      throw new OrdiApiError(res.status, error.code ?? 'http_error', error.message ?? `HTTP ${res.status}`, error.details);
    }
    return data;
  };
  client.get = (path) => call('GET', path);
  client.post = (path, body) => call('POST', path, body);
  client.patch = (path, body) => call('PATCH', path, body);
  return client;
}

async function connectMcp(cookie: string): Promise<Client> {
  const server = buildServer(clientFor(cookie));
  const client = new Client({ name: 'test-agent', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const out = (res: any) => JSON.parse(res.content[0].text);
const failure = (res: any) => {
  expect(res.isError).toBe(true);
  return res.content[0].text as string;
};

async function tool(name: string, args: Record<string, unknown>) {
  return mcp.callTool({ name, arguments: args });
}

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
  owner = reqAs(users.owner!.cookie);
  const type = await json(owner.post('/project-types', { name: 'Content', revenueSource: 'none' }));
  const project = await json(owner.post('/projects', { name: 'Content calendar', key: 'CNT', projectTypeId: type.id }));
  projectId = project.id;
  const statuses = (await json(owner.get(`/projects/${projectId}/task-statuses`))).data as any[];
  statusByCategory = Object.fromEntries(statuses.map((s) => [s.category, s.id]));
  await owner.post('/labels', { name: 'LinkedIn', scope: 'task' });
  await owner.post('/labels', { name: 'Case study', scope: 'task' });
  await owner.post('/labels', { name: 'retainer', scope: 'project' });
  await owner.post('/custom-fields', { entityType: 'tasks', key: 'platform', label: 'Platform', type: 'text' });
  await owner.post('/custom-fields', { entityType: 'tasks', key: 'external_key', label: 'External key', type: 'text' });
  mcp = await connectMcp(users.owner!.cookie);
});

describe('the project and its structure', () => {
  it('is found by key, with the vocabulary the write tools accept', async () => {
    const schema = out(await tool('get_project_schema', { project: 'cnt' }));
    expect(schema.project).toMatchObject({ id: projectId, key: 'CNT', name: 'Content calendar' });
    expect(schema.statuses.map((s: any) => s.name)).toEqual(['Backlog', 'Todo', 'In Progress', 'In Review', 'Done', 'Canceled']);
    // Task labels only – "retainer" describes a project and has no place on a card.
    const labelNames = schema.labels.map((l: any) => l.name);
    expect(labelNames).toEqual(expect.arrayContaining(['LinkedIn', 'Case study']));
    expect(labelNames).not.toContain('retainer');
    expect(schema.customFields.map((f: any) => f.key)).toEqual(['platform', 'external_key']);
  });

  it('refuses a project label on a task instead of dropping it', async () => {
    const message = failure(await tool('create_task', {
      projectId: 'CNT', title: 'Wrong label', labels: ['retainer'],
    }));
    expect(message).toContain('retainer');
    expect(message).toContain('LinkedIn');
  });
});

describe('a post is filed once, whatever the run', () => {
  const args = {
    project: 'CNT',
    key: '2026-08-10-linkedin-agents',
    title: 'Agents in production',
    text: 'Hook line.\n\nWhat we learned shipping agents.\nThree things.',
    status: 'Todo',
    dueDate: '2026-08-10',
    labels: ['LinkedIn'],
    customFields: { platform: 'linkedin' },
    links: [{ url: 'https://news.example/agents', title: 'Trend source' }],
  };

  it('writes the whole card on the first run', async () => {
    const res = out(await tool('upsert_task', args));
    expect(res.action).toBe('created');
    expect(res.task).toMatchObject({
      ref: 'CNT-1', title: 'Agents in production', dueDate: '2026-08-10',
      status: 'Todo', labels: ['LinkedIn'], version: 1,
    });

    // …and ordi holds exactly that.
    const stored = await json(owner.get(`/tasks/${res.task.id}?include=labels,links`));
    expect(stored.dueDate).toBe('2026-08-10');
    expect(stored.statusId).toBe(statusByCategory.todo);
    expect(stored.customFields.platform).toBe('linkedin');
    expect(stored.customFields.external_key).toBe(args.key);
    expect(stored.links.map((l: any) => l.url)).toEqual(['https://news.example/agents']);
    expect(stored.description.content[0].content[0].text).toBe('Hook line.');
  });

  it('updates that same task on a re-run, and adds no second source', async () => {
    const res = out(await tool('upsert_task', { ...args, dueDate: '2026-08-12' }));
    expect(res.action).toBe('updated');
    expect(res.task.ref).toBe('CNT-1');

    const list = (await json(owner.get(`/tasks?projectId=${projectId}`))).data as any[];
    expect(list).toHaveLength(1);
    expect(list[0].dueDate).toBe('2026-08-12');
    const stored = await json(owner.get(`/tasks/${list[0].id}?include=links`));
    expect(stored.links).toHaveLength(1);
  });

  it('refuses to replace an edit made in ordi with the generated text', async () => {
    const [task] = (await json(owner.get(`/tasks?projectId=${projectId}`))).data as any[];
    await owner.patch(`/tasks/${task.id}`, { title: 'Agents in production — rewritten by hand' });

    const message = failure(await tool('upsert_task', args));
    expect(message).toContain('CNT-1');
    expect(message).toContain('get_task');
    expect((await json(owner.get(`/tasks/${task.id}`))).title).toBe('Agents in production — rewritten by hand');

    const forced = out(await tool('upsert_task', { ...args, force: true }));
    expect(forced.action).toBe('updated');
    expect((await json(owner.get(`/tasks/${task.id}`))).title).toBe('Agents in production');
  });

  it('names the existing task when create_task is given a key that is taken', async () => {
    const message = failure(await tool('create_task', {
      projectId: 'CNT', title: 'Agents in production', externalKey: args.key,
    }));
    expect(message).toContain('CNT-1');
    expect(((await json(owner.get(`/tasks?projectId=${projectId}`))).data as any[])).toHaveLength(1);
  });
});

describe('reading the calendar and the card', () => {
  beforeAll(async () => {
    await tool('upsert_task', {
      project: 'CNT', key: '2026-09-01-linkedin-case', title: 'Northwind case study',
      text: 'How Northwind cut reporting time.', status: 'Backlog', dueDate: '2026-09-01',
      labels: ['LinkedIn', 'Case study'], customFields: { platform: 'linkedin' },
    });
    await tool('upsert_task', {
      project: 'CNT', key: '2026-08-20-x-thread', title: 'X thread', status: 'Backlog',
      dueDate: '2026-08-20', customFields: { platform: 'x' },
    });
  });

  it('filters by window, status, labels and platform in one call', async () => {
    const august = out(await tool('list_tasks', { project: 'CNT', dueFrom: '2026-08-01', dueTo: '2026-08-31' }));
    expect(august.data.map((t: any) => t.title)).toEqual(['Agents in production', 'X thread']);

    const linkedin = out(await tool('list_tasks', { project: 'CNT', customFields: { platform: 'linkedin' } }));
    expect(linkedin.data.map((t: any) => t.title)).toEqual(['Agents in production', 'Northwind case study']);

    const cases = out(await tool('list_tasks', { project: 'CNT', labels: ['LinkedIn', 'Case study'] }));
    expect(cases.data.map((t: any) => t.title)).toEqual(['Northwind case study']);

    const backlog = out(await tool('list_tasks', { project: 'CNT', status: 'Backlog', dueTo: '2026-08-31' }));
    expect(backlog.data.map((t: any) => t.title)).toEqual(['X thread']);
  });

  it('opens the full card: text, date, status, labels, sources, comments, version', async () => {
    const [row] = out(await tool('list_tasks', { project: 'CNT', q: 'Agents' })).data;
    await tool('comment_on_task', { taskId: row.id, text: 'Tighten the hook' });

    const card = out(await tool('get_task', { taskId: row.id }));
    // The forced re-run above put the generated date back on the card.
    expect(card).toMatchObject({
      ref: 'CNT-1', title: 'Agents in production', dueDate: '2026-08-10',
      status: 'Todo', statusCategory: 'todo', labels: ['LinkedIn'],
    });
    expect(card.text).toBe('Hook line.\n\nWhat we learned shipping agents.\nThree things.');
    expect(card.links).toHaveLength(1);
    expect(card.comments.map((c: any) => c.text)).toEqual(['Tighten the hook']);
    expect(typeof card.version).toBe('number');
  });
});

describe('publishing', () => {
  it('moves the date and status, then keeps the permalink on the card', async () => {
    const [row] = out(await tool('list_tasks', { project: 'CNT', q: 'Agents' })).data;
    const card = out(await tool('get_task', { taskId: row.id }));

    const stale = failure(await tool('update_task', {
      taskId: row.id, status: 'Done', expectedVersion: card.version - 1,
    }));
    expect(stale).toContain('version_conflict');
    expect(stale).toContain(`Current version: ${card.version}`);

    const done = out(await tool('update_task', {
      taskId: row.id, status: 'Done', dueDate: '2026-08-13', expectedVersion: card.version,
      addLinks: [{ url: 'https://www.linkedin.com/posts/abc' }],
    }));
    expect(done.task).toMatchObject({ status: 'Done', dueDate: '2026-08-13' });

    // Re-attaching the permalink is a no-op, so a retried publish step is safe.
    const again = out(await tool('add_task_link', { taskId: row.id, url: 'https://www.linkedin.com/posts/abc' }));
    expect(again.added).toBe(false);
    expect(again.links.map((l: any) => l.url)).toEqual([
      'https://news.example/agents', 'https://www.linkedin.com/posts/abc',
    ]);
  });
});

describe('what a token cannot reach', () => {
  it('says the project is not among the ones it can see', async () => {
    const guest = await connectMcp(users.guest!.cookie);
    const res = await guest.callTool({ name: 'get_project_schema', arguments: { project: 'CNT' } });
    expect(res.isError).toBe(true);
    expect((res.content as any)[0].text).toContain('CNT');
  });
});
