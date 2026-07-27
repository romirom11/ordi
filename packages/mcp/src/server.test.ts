/**
 * The tool catalog itself: the list tools exist (an agent can obtain ids
 * without already having them), responses are compacted, and secrets like
 * portalToken never reach the model's context.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, scrub, textToDoc } from './server';
import { OrdiClient } from './client';

function fakeApi(routes: Record<string, unknown>, posts: Array<{ path: string; body: unknown }> = []): OrdiClient {
  const client = new OrdiClient({ baseUrl: 'http://test', token: 't' });
  client.get = async <T>(path: string): Promise<T> => {
    const key = Object.keys(routes).find((r) => path.startsWith(r));
    if (!key) throw new Error(`unexpected GET ${path}`);
    return routes[key] as T;
  };
  client.post = async <T>(path: string, body?: unknown): Promise<T> => {
    posts.push({ path, body });
    return { id: 'new-id' } as T;
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

describe('CRM create/list tools', () => {
  it('exposes the full CRM surface: list and create for companies, contacts, deals', async () => {
    const client = await connect(fakeApi({}));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['list_contacts', 'list_deals', 'list_deal_stages', 'create_company', 'create_contact', 'create_deal']) {
      expect(names).toContain(n);
    }
  });

  it('list_deals compacts rows and filters by company and project', async () => {
    const api = fakeApi({ '/deals': { data: [{
      id: 'd1', title: 'Retainer', companyId: 'c1', projectId: 'p1', stageId: 's1', amount: '5000', currency: 'USD',
      expectedCloseDate: null, ownerId: null, customFields: { secretish: 1 }, version: 2, deletedAt: null,
      createdBy: 'u1', createdAt: 'x', updatedAt: 'x',
    }] } });
    let requested = '';
    const inner = api.get.bind(api);
    api.get = async <T>(path: string): Promise<T> => { requested = path; return inner<T>(path); };

    const client = await connect(api);
    const res = await client.callTool({ name: 'list_deals', arguments: { companyId: 'c1', projectId: 'p1' } });
    expect(requested).toBe('/deals?companyId=c1&projectId=p1');
    const body = JSON.parse((res.content as any)[0].text);
    expect(body.data).toEqual([{
      id: 'd1', title: 'Retainer', companyId: 'c1', projectId: 'p1', stageId: 's1', amount: '5000', currency: 'USD',
      expectedCloseDate: null, ownerId: null,
    }]);
  });

  it('create_deal passes projectId through to the API', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = await connect(fakeApi({}, posts));
    await client.callTool({ name: 'create_deal', arguments: { companyId: 'c1', title: 'SaaS lead', stageId: 's1', projectId: 'p1' } });
    expect(posts).toEqual([{ path: '/deals', body: { companyId: 'c1', title: 'SaaS lead', stageId: 's1', projectId: 'p1' } }]);
  });

  it('list_deal_stages returns id + won/lost flags for stage discovery', async () => {
    const client = await connect(fakeApi({ '/deal-stages': { data: [
      { id: 's1', name: 'Lead', position: 0, probability: 10, isWon: false, isLost: false, createdAt: 'x' },
    ] } }));
    const res = await client.callTool({ name: 'list_deal_stages', arguments: {} });
    const body = JSON.parse((res.content as any)[0].text);
    expect(body.data).toEqual([{ id: 's1', name: 'Lead', position: 0, probability: 10, isWon: false, isLost: false }]);
  });

  it('create_company / create_contact / create_deal POST to the CRM endpoints', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = await connect(fakeApi({}, posts));

    await client.callTool({ name: 'create_company', arguments: { name: 'Acme', status: 'lead' } });
    await client.callTool({ name: 'create_contact', arguments: { companyId: 'c1', firstName: 'Ada', email: 'ada@acme.io' } });
    await client.callTool({ name: 'create_deal', arguments: { companyId: 'c1', title: 'Website', stageId: 's1', amount: 5000 } });

    expect(posts).toEqual([
      { path: '/companies', body: { name: 'Acme', status: 'lead' } },
      { path: '/contacts', body: { companyId: 'c1', firstName: 'Ada', email: 'ada@acme.io' } },
      { path: '/deals', body: { companyId: 'c1', title: 'Website', stageId: 's1', amount: 5000 } },
    ]);
  });

  it('create_company rejects an unknown status before it reaches the API', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = await connect(fakeApi({}, posts));
    const res = await client.callTool({ name: 'create_company', arguments: { name: 'Acme', status: 'vip' } });
    expect(res.isError).toBe(true);
    expect(posts).toEqual([]);
  });
});

describe('custom field tools', () => {
  it('exposes list_custom_fields and create_custom_field', async () => {
    const client = await connect(fakeApi({}));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('list_custom_fields');
    expect(names).toContain('create_custom_field');
  });

  it('list_custom_fields compacts definitions and filters by entity', async () => {
    let requested = '';
    const api = fakeApi({ '/custom-fields': { data: [{
      id: 'f1', entityType: 'companies', key: 'nps', label: 'NPS', type: 'number',
      options: [], required: false, position: 0, showInList: true, isSortable: false,
      indexed: false, deprecated: false, createdAt: 'x', updatedAt: 'x',
    }] } });
    const inner = api.get.bind(api);
    api.get = async <T>(path: string): Promise<T> => { requested = path; return inner<T>(path); };

    const client = await connect(api);
    const res = await client.callTool({ name: 'list_custom_fields', arguments: { entityType: 'companies' } });
    expect(requested).toBe('/custom-fields?entityType=companies');
    const body = JSON.parse((res.content as any)[0].text);
    expect(body.data).toEqual([{
      id: 'f1', entityType: 'companies', key: 'nps', label: 'NPS', type: 'number',
      options: [], required: false, deprecated: false,
    }]);
  });

  it('create_custom_field POSTs the definition; unknown entity/type is rejected client-side', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = await connect(fakeApi({}, posts));

    await client.callTool({ name: 'create_custom_field', arguments: {
      entityType: 'deals', key: 'source', label: 'Source', type: 'select',
      options: [{ value: 'ads', label: 'Ads' }],
    } });
    const bad = await client.callTool({ name: 'create_custom_field', arguments: {
      entityType: 'weird', key: 'x', label: 'X', type: 'text',
    } });

    expect(bad.isError).toBe(true);
    expect(posts).toEqual([{
      path: '/custom-fields',
      body: { entityType: 'deals', key: 'source', label: 'Source', type: 'select', options: [{ value: 'ads', label: 'Ads' }] },
    }]);
  });

  it('create tools pass customFields values through', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = await connect(fakeApi({}, posts));
    await client.callTool({ name: 'create_company', arguments: { name: 'Acme', customFields: { nps: 9 } } });
    await client.callTool({ name: 'create_task', arguments: { projectId: 'p1', title: 'T', customFields: { sprint: 'q3' } } });
    expect(posts[0]!.body).toMatchObject({ name: 'Acme', customFields: { nps: 9 } });
    expect(posts[1]!.body).toMatchObject({ projectId: 'p1', title: 'T', customFields: { sprint: 'q3' } });
  });
});

describe('textToDoc', () => {
  it('splits blank-line-separated text into paragraphs, single newlines into hard breaks', () => {
    expect(textToDoc('Fit: 85/100\nStage: warm\n\nRisks: none')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [
          { type: 'text', text: 'Fit: 85/100' }, { type: 'hardBreak' }, { type: 'text', text: 'Stage: warm' },
        ] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Risks: none' }] },
      ],
    });
  });

  it('handles CRLF and empty text', () => {
    expect(textToDoc('a\r\nb')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }] }],
    });
    expect(textToDoc('')).toEqual({ type: 'doc', content: [{ type: 'paragraph', content: [] }] });
  });
});

describe('create_note', () => {
  it('preserves line structure and can target a deal', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = await connect(fakeApi({}, posts));
    await client.callTool({ name: 'create_note', arguments: { dealId: 'd1', text: 'Line 1\nLine 2\n\nPara 2' } });
    expect(posts[0]!.path).toBe('/notes');
    expect(posts[0]!.body).toMatchObject({ dealId: 'd1', body: textToDoc('Line 1\nLine 2\n\nPara 2') });
  });

  it('requires a target (company, contact or deal)', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = await connect(fakeApi({}, posts));
    const res = await client.callTool({ name: 'create_note', arguments: { text: 'orphan' } });
    expect(res.isError).toBe(true);
    expect(posts).toEqual([]);
  });
});
