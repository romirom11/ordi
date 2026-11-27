/**
 * Workflow status tools: an agent adds, edits, reorders and removes a
 * project's task statuses by name, and the tools say what the board looks
 * like afterwards.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from './server';
import { OrdiClient, OrdiApiError } from './client';

type Row = Record<string, any>;

const PROJECT = { id: '01JBFAKEPROJECT00000000001', key: 'CONTENT', name: 'Content', status: 'active' };

/** The status endpoints, in memory, with the server's ordering and default rules. */
function fakeOrdi() {
  const client = new OrdiClient({ baseUrl: 'http://test', token: 't' });
  let statuses: Row[] = [
    { id: 'st-todo', name: 'Todo', category: 'todo', color: '#3b82f6', position: 1000, isDefault: true },
    { id: 'st-doing', name: 'In Progress', category: 'in_progress', color: '#f59e0b', position: 2000, isDefault: false },
    { id: 'st-done', name: 'Done', category: 'done', color: '#10b981', position: 3000, isDefault: false },
  ];
  const calls: { method: string; path: string; body?: any }[] = [];
  const sorted = () => [...statuses].sort((a, b) => a.position - b.position);
  let next = 1;

  client.get = async <T>(path: string): Promise<T> => {
    calls.push({ method: 'GET', path });
    if (path === '/projects') return { data: [PROJECT] } as T;
    if (path === `/projects/${PROJECT.id}/task-statuses`) return { data: sorted() } as T;
    throw new OrdiApiError(404, 'not_found', `GET ${path}`);
  };
  client.post = async <T>(path: string, body?: any): Promise<T> => {
    calls.push({ method: 'POST', path, body });
    if (path === `/projects/${PROJECT.id}/task-statuses`) {
      const row = { id: `st-new${next++}`, color: '#6b7280', isDefault: false, ...body, position: Math.max(...statuses.map((s) => s.position)) + 1000 };
      if (row.isDefault) statuses.forEach((s) => { s.isDefault = false; });
      statuses.push(row);
      return row as T;
    }
    throw new OrdiApiError(404, 'not_found', `POST ${path}`);
  };
  client.patch = async <T>(path: string, body?: any): Promise<T> => {
    calls.push({ method: 'PATCH', path, body });
    if (path === `/projects/${PROJECT.id}/task-statuses/order`) {
      body.ids.forEach((id: string, i: number) => { statuses.find((s) => s.id === id)!.position = (i + 1) * 1000; });
      return { data: sorted() } as T;
    }
    const one = /^\/task-statuses\/([^/]+)$/.exec(path);
    if (one) {
      const row = statuses.find((s) => s.id === one[1])!;
      if (body.isDefault) statuses.forEach((s) => { s.isDefault = false; });
      Object.assign(row, body);
      return row as T;
    }
    throw new OrdiApiError(404, 'not_found', `PATCH ${path}`);
  };
  client.del = async <T>(path: string): Promise<T> => {
    calls.push({ method: 'DELETE', path });
    const [route, query] = path.split('?');
    const id = route!.replace('/task-statuses/', '');
    const to = new URLSearchParams(query).get('migrateTo')!;
    const gone = statuses.find((s) => s.id === id)!;
    statuses = statuses.filter((s) => s.id !== id);
    if (gone.isDefault) statuses.find((s) => s.id === to)!.isDefault = true;
    return { ok: true, movedTasks: 4 } as T;
  };
  return { client, calls, statuses: () => sorted() };
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

describe('workflow status tools', () => {
  it('adds a status by project key, at the place asked for', async () => {
    const fake = fakeOrdi();
    const client = await connect(fake.client);
    const res = body(await client.callTool({ name: 'create_workflow_status', arguments: {
      project: 'content', name: 'Awaiting client', category: 'in_progress', color: '#0ea5e9', index: 1,
    } }));
    expect(res.action).toBe('created');
    expect(res.status).toMatchObject({ name: 'Awaiting client', category: 'in_progress', color: '#0ea5e9' });
    expect(res.statuses.map((s: Row) => s.name)).toEqual(['Todo', 'Awaiting client', 'In Progress', 'Done']);
    expect(fake.calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'Awaiting client', category: 'in_progress', color: '#0ea5e9' });
  });

  it('edits a status found by name and moves it', async () => {
    const fake = fakeOrdi();
    const client = await connect(fake.client);
    const res = body(await client.callTool({ name: 'update_workflow_status', arguments: {
      project: 'CONTENT', status: 'in progress', name: 'Doing', isDefault: true, index: 0,
    } }));
    expect(res.status).toMatchObject({ id: 'st-doing', name: 'Doing', isDefault: true });
    expect(res.statuses.map((s: Row) => s.name)).toEqual(['Doing', 'Todo', 'Done']);
    expect(fake.statuses().filter((s) => s.isDefault).map((s) => s.id)).toEqual(['st-doing']);
  });

  it('never resolves a status from its category', async () => {
    const client = await connect(fakeOrdi().client);
    // in_progress is the category of "In Progress", but not a name.
    const miss: any = await client.callTool({ name: 'update_workflow_status', arguments: { project: 'CONTENT', status: 'in_progress', name: 'X' } });
    expect(miss.isError).toBe(true);
    expect(miss.content[0].text).toContain('Unknown status "in_progress"');
  });

  it('refuses an empty update', async () => {
    const client = await connect(fakeOrdi().client);
    const res: any = await client.callTool({ name: 'update_workflow_status', arguments: { project: 'CONTENT', status: 'Todo' } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Nothing to update');
  });

  it('removes a status by moving its tasks first', async () => {
    const fake = fakeOrdi();
    const client = await connect(fake.client);
    const res = body(await client.callTool({ name: 'delete_workflow_status', arguments: { project: 'CONTENT', status: 'Todo', moveTasksTo: 'In Progress' } }));
    expect(res).toMatchObject({ action: 'deleted', movedTasks: 4, movedTo: { id: 'st-doing' } });
    expect(fake.calls.find((c) => c.method === 'DELETE')!.path).toBe('/task-statuses/st-todo?migrateTo=st-doing');
    expect(res.statuses.find((s: Row) => s.id === 'st-doing').isDefault).toBe(true);

    const same: any = await client.callTool({ name: 'delete_workflow_status', arguments: { project: 'CONTENT', status: 'Done', moveTasksTo: 'done' } });
    expect(same.isError).toBe(true);
  });
});
