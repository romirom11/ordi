/**
 * The tool catalog itself: the list tools exist (an agent can obtain ids
 * without already having them), responses are compacted, and secrets like
 * portalToken never reach the model's context.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, decodeEntities, scrub, textToDoc } from './server';
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
      companyId: null, leadId: null, startDate: null, targetDate: null, customFields: {},
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
    // customFields ride along: an agent that wrote one has to be able to read it
    // back without moving the deal to see it.
    expect(body.data).toEqual([{
      id: 'd1', title: 'Retainer', companyId: 'c1', projectId: 'p1', stageId: 's1', amount: '5000', currency: 'USD',
      expectedCloseDate: null, ownerId: null, lostReason: undefined, customFields: { secretish: 1 },
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

describe('decodeEntities', () => {
  it('decodes escaped text in every string field of a write body', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = await connect(fakeApi({}, posts));
    await client.callTool({ name: 'create_contact', arguments: {
      companyId: 'c1', firstName: 'Stanislav', position: 'Co-founder &amp; CEO &#39;verified&#39;',
    } });
    expect(posts[0]!.body).toMatchObject({ position: "Co-founder & CEO 'verified'" });
  });

  it('leaves clean text and non-strings alone', () => {
    expect(decodeEntities({ a: 'R&D dept', n: 5, ok: true })).toEqual({ a: 'R&D dept', n: 5, ok: true });
    expect(decodeEntities('a &lt;b&gt; &quot;c&quot;')).toBe('a <b> "c"');
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

/** fakeApi with PATCH capture, for the update tools. */
function fakeApiRw(
  routes: Record<string, unknown>,
  posts: Array<{ path: string; body: unknown }> = [],
  patches: Array<{ path: string; body: unknown }> = [],
): OrdiClient {
  const client = fakeApi(routes, posts);
  client.patch = async <T>(path: string, body?: unknown): Promise<T> => {
    patches.push({ path, body });
    return { ok: true } as T;
  };
  return client;
}

describe('reading back what was written', () => {
  it('offers a single-record read for every CRM entity, and notes', async () => {
    const client = await connect(fakeApi({}));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['get_company', 'get_contact', 'get_deal', 'list_notes']) expect(names).toContain(n);
  });

  it('get_deal reads without moving the deal', async () => {
    const client = await connect(fakeApi({ '/deals/d1': {
      id: 'd1', title: 'Retainer', stageId: 's1', customFields: { lost_reason_code: 'price' }, version: 4,
    } }));
    const body = JSON.parse((await client.callTool({ name: 'get_deal', arguments: { dealId: 'd1' } }) as any).content[0].text);
    expect(body).toEqual({ id: 'd1', title: 'Retainer', stageId: 's1', customFields: { lost_reason_code: 'price' } });
  });

  it('list_notes renders bodies as text', async () => {
    const client = await connect(fakeApi({ '/notes': { data: [
      { id: 'n1', dealId: 'd1', companyId: null, contactId: null, pinned: false, createdAt: 'x', createdBy: 'u1',
        body: textToDoc('PROSPECT CARD\nBudget confirmed'), version: 1 },
    ] } }));
    const body = JSON.parse((await client.callTool({ name: 'list_notes', arguments: { dealId: 'd1' } }) as any).content[0].text);
    expect(body.data[0].text).toBe('PROSPECT CARD\nBudget confirmed');
  });

  it('list_notes needs a target', async () => {
    const client = await connect(fakeApi({}));
    expect((await client.callTool({ name: 'list_notes', arguments: {} })).isError).toBe(true);
  });
});

describe('CRM update tools', () => {
  it('patch company, contact and deal by id', async () => {
    const patches: Array<{ path: string; body: unknown }> = [];
    const client = await connect(fakeApiRw({}, [], patches));
    await client.callTool({ name: 'update_company', arguments: { companyId: 'c1', customFields: { icp_fit: 'high' } } });
    await client.callTool({ name: 'update_contact', arguments: { contactId: 'ct1', position: 'CTO' } });
    await client.callTool({ name: 'update_deal', arguments: { dealId: 'd1', amount: 9000 } });
    expect(patches).toEqual([
      { path: '/companies/c1', body: { customFields: { icp_fit: 'high' } } },
      { path: '/contacts/ct1', body: { position: 'CTO' } },
      { path: '/deals/d1', body: { amount: 9000 } },
    ]);
  });

  it('move_deal writes the structured reason with the move', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const patches: Array<{ path: string; body: unknown }> = [];
    const client = await connect(fakeApiRw({}, posts, patches));
    await client.callTool({ name: 'move_deal', arguments: {
      dealId: 'd1', stageId: 'lost', lostReason: 'Postponed', customFields: { lost_reason_code: 'timing' },
    } });
    expect(patches).toEqual([{ path: '/deals/d1', body: { customFields: { lost_reason_code: 'timing' } } }]);
    expect(posts).toEqual([{ path: '/deals/d1/move', body: { stageId: 'lost', lostReason: 'Postponed' } }]);
  });

  it('update_custom_field retires a definition instead of deleting it', async () => {
    const patches: Array<{ path: string; body: unknown }> = [];
    const client = await connect(fakeApiRw({}, [], patches));
    await client.callTool({ name: 'update_custom_field', arguments: { fieldId: 'f1', deprecated: true } });
    expect(patches).toEqual([{ path: '/custom-fields/f1', body: { deprecated: true } }]);
  });
});

describe('create_company does not double the CRM', () => {
  it('refuses a name that already exists and names the record to update', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = await connect(fakeApi({ '/companies': { data: [
      { id: 'c1', name: 'Northwind ', domain: 'https://www.northwind.io/', status: 'lead' },
    ], nextCursor: null } }, posts));
    const res = await client.callTool({ name: 'create_company', arguments: { name: 'northwind' } });
    expect(res.isError).toBe(true);
    expect((res.content as any)[0].text).toContain('c1');
    expect(posts).toEqual([]);
  });

  it('matches on domain too, and allowDuplicate overrides', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const routes = { '/companies': { data: [{ id: 'c1', name: 'Other', domain: 'northwind.io' }], nextCursor: null } };
    const client = await connect(fakeApi(routes, posts));
    expect((await client.callTool({ name: 'create_company', arguments: { name: 'Northwind Inc', domain: 'www.northwind.io' } })).isError).toBe(true);
    await client.callTool({ name: 'create_company', arguments: { name: 'Northwind Inc', domain: 'www.northwind.io', allowDuplicate: true } });
    expect(posts).toEqual([{ path: '/companies', body: { name: 'Northwind Inc', domain: 'www.northwind.io' } }]);
  });

  it('creates anyway when the lookup is not permitted', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = await connect(fakeApi({}, posts)); // every GET throws
    await client.callTool({ name: 'create_company', arguments: { name: 'Northwind' } });
    expect(posts).toEqual([{ path: '/companies', body: { name: 'Northwind' } }]);
  });
});

describe('request_leave', () => {
  it('files for the token owner when no employee is named', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const client = await connect(fakeApi({}, posts));
    await client.callTool({ name: 'request_leave', arguments: { leaveTypeId: 'lt1', fromDate: '2026-09-01', toDate: '2026-09-05' } });
    expect(posts).toEqual([{ path: '/leave-requests', body: { leaveTypeId: 'lt1', fromDate: '2026-09-01', toDate: '2026-09-05', reason: '' } }]);
  });
});
