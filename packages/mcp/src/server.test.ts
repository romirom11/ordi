/**
 * The tool catalog itself: the list tools exist (an agent can obtain ids
 * without already having them), responses are compacted, and secrets like
 * portalToken never reach the model's context.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, scrub } from './server';
import { OrdiClient } from './client';

function fakeApi(routes: Record<string, unknown>): OrdiClient {
  const client = new OrdiClient({ baseUrl: 'http://test', token: 't' });
  client.get = async <T>(path: string): Promise<T> => {
    const key = Object.keys(routes).find((r) => path.startsWith(r));
    if (!key) throw new Error(`unexpected GET ${path}`);
    return routes[key] as T;
  };
  return client;
}

async function connect(api: OrdiClient) {
  const server = buildServer(api);
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

const FULL_PROJECT_ROW = {
  id: 'p1', key: 'SOL', name: 'Solovei', status: 'active', priority: 'none',
  companyId: null, leadId: null, startDate: null, targetDate: null,
  templateSourceId: null, settings: { estimateUnit: 'hours' }, links: [],
  version: 3, deletedAt: null, createdAt: 'x', updatedAt: 'x',
};

const FULL_COMPANY_ROW = {
  id: 'c1', name: 'Kdnx', domain: null, status: 'client', ownerId: null,
  defaultCurrency: 'USD', paymentTermsDays: 14,
  portalToken: 'super-secret', portalEnabled: true, version: 1, deletedAt: null,
};

describe('scrub', () => {
  it('drops lock counters, soft-delete markers and secrets at any depth', () => {
    const out = scrub({ a: [{ version: 1, portalToken: 's', keep: { deletedAt: null, ok: 1 } }] }) as any;
    expect(out.a[0]).toEqual({ keep: { ok: 1 } });
  });

  it('leaves primitives and meaningful nulls alone', () => {
    expect(scrub({ companyId: null, n: 0, s: '' })).toEqual({ companyId: null, n: 0, s: '' });
  });
});

describe('tool catalog', () => {
  it('exposes list_projects and list_companies', async () => {
    const client = await connect(fakeApi({}));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('list_projects');
    expect(names).toContain('list_companies');
    expect(names).toContain('search');
  });

  it('list_projects returns compact rows and passes filters through', async () => {
    let requested = '';
    const api = fakeApi({ '/projects': { data: [FULL_PROJECT_ROW] } });
    const inner = api.get.bind(api);
    api.get = async <T>(path: string): Promise<T> => { requested = path; return inner<T>(path); };

    const client = await connect(api);
    const res = await client.callTool({ name: 'list_projects', arguments: { status: 'active' } });
    expect(requested).toBe('/projects?status=active');
    const body = JSON.parse((res.content as any)[0].text);
    expect(body.data).toEqual([{
      id: 'p1', key: 'SOL', name: 'Solovei', status: 'active', priority: 'none',
      companyId: null, leadId: null, startDate: null, targetDate: null,
    }]);
  });

  it('list_companies never leaks the portal token', async () => {
    const client = await connect(fakeApi({ '/companies': { data: [FULL_COMPANY_ROW], nextCursor: null } }));
    const res = await client.callTool({ name: 'list_companies', arguments: {} });
    const raw = (res.content as any)[0].text as string;
    expect(raw).not.toContain('super-secret');
    expect(raw).not.toContain('portalToken');
    const body = JSON.parse(raw);
    expect(body.data[0]).toMatchObject({ id: 'c1', name: 'Kdnx', status: 'client' });
  });
});
