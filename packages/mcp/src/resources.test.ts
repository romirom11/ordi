import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from './server';
import { OrdiClient } from './client';

const PROJECT = { id: 'p-1', key: 'LCH', name: 'Launch', status: 'active' };
type Call = { method: string; path: string; body?: unknown };

function fake() {
  const api = new OrdiClient({ baseUrl: 'http://test', token: 't' });
  const calls: Call[] = [];
  const resources = [
    { id: 'r-link', kind: 'link', label: 'Figma', url: 'https://figma.com/f', position: 0 },
    { id: 'r-file', kind: 'file', label: 'brief.pdf', url: null, position: 1, file: { id: 'a-1', filename: 'brief.pdf', size: 3, mime: 'application/pdf' } },
  ];
  api.get = async <T>(path: string): Promise<T> => {
    calls.push({ method: 'GET', path });
    if (path.startsWith('/projects?') || path === '/projects') return { data: [PROJECT] } as T;
    if (path === `/projects/${PROJECT.id}`) return PROJECT as T;
    if (path === `/projects/${PROJECT.id}/resources`) return { data: resources } as T;
    throw new Error(`unexpected GET ${path}`);
  };
  api.post = async <T>(path: string, body?: unknown): Promise<T> => {
    calls.push({ method: 'POST', path, body });
    return { id: 'r-new', ...(body as object), label: (body as any).label ?? 'Release checklist', url: (body as any).url ?? null } as T;
  };
  api.patch = async <T>(path: string, body?: unknown): Promise<T> => {
    calls.push({ method: 'PATCH', path, body });
    return { id: 'r-link', kind: 'link', label: 'Figma', url: 'https://figma.com/f', ...(body as object) } as T;
  };
  api.del = async <T>(path: string): Promise<T> => {
    calls.push({ method: 'DELETE', path });
    return { ok: true } as T;
  };
  return { api, calls };
}

async function connect(api: OrdiClient) {
  const server = buildServer(api);
  const client = new Client({ name: 'test', version: '0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return client;
}

const body = (res: any) => JSON.parse(res.content[0].text);

describe('project resources over MCP', () => {
  it('lists resources by project key', async () => {
    const { api } = fake();
    const client = await connect(api);
    const res = body(await client.callTool({ name: 'list_project_resources', arguments: { project: 'LCH' } }));
    expect(res.data.map((r: any) => r.kind)).toEqual(['link', 'file']);
    expect(res.data[1].file.filename).toBe('brief.pdf');
  });

  it('adds a link, labelled by its url when no label is given', async () => {
    const { api, calls } = fake();
    const client = await connect(api);
    await client.callTool({ name: 'add_project_resource', arguments: { project: 'LCH', kind: 'link', url: 'https://staging.example.com' } });
    expect(calls.at(-1)).toEqual({ method: 'POST', path: `/projects/${PROJECT.id}/resources`, body: { kind: 'link', label: 'https://staging.example.com', url: 'https://staging.example.com' } });
  });

  it('pins a page and refuses a page without its id', async () => {
    const { api, calls } = fake();
    const client = await connect(api);
    await client.callTool({ name: 'add_project_resource', arguments: { project: 'LCH', kind: 'kb_page', kbPageId: 'pg-1' } });
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { kind: 'kb_page', kbPageId: 'pg-1' } });
    const res: any = await client.callTool({ name: 'add_project_resource', arguments: { project: 'LCH', kind: 'kb_page' } });
    expect(res.isError).toBe(true);
  });

  it('updates a link and removes a resource', async () => {
    const { api, calls } = fake();
    const client = await connect(api);
    await client.callTool({ name: 'update_project_link', arguments: { resourceId: 'r-link', label: 'Figma designs' } });
    expect(calls.at(-1)).toEqual({ method: 'PATCH', path: '/project-resources/r-link', body: { label: 'Figma designs' } });
    await client.callTool({ name: 'remove_project_resource', arguments: { resourceId: 'r-link' } });
    expect(calls.at(-1)).toEqual({ method: 'DELETE', path: '/project-resources/r-link' });
  });
});
