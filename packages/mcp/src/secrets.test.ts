/**
 * Secrets over MCP: an agent learns that a secret exists and what it holds,
 * never a value – not a password, not a login or URL, not an API-key hint.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from './server';
import { OrdiClient } from './client';

const PROJECT = { id: 'p-1', key: 'ACM', name: 'Acme', status: 'active' };
const SECRETS = [
  {
    id: 's-1', name: 'ACME_ADMIN', description: 'Client admin', environment: 'test', expiresAt: '2000-01-01', availableToAgents: false,
    fields: [
      { key: 'url', label: 'URL', type: 'url', hasValue: true, value: 'https://admin.acme.test' },
      { key: 'login', label: 'Login', type: 'text', hasValue: true, value: 'ops@acme.test' },
      { key: 'password', label: 'Password', type: 'password', hasValue: true },
    ],
  },
  {
    id: 's-2', name: 'STRIPE_TEST', description: null, environment: 'test', expiresAt: null, availableToAgents: true,
    fields: [{ key: 'api_key', label: 'API key', type: 'api_key', hasValue: true, hint: 'Wxyz' }],
  },
  {
    id: 's-3', name: 'DOPPLER_KEY', description: null, environment: 'test', expiresAt: null, availableToAgents: true, source: 'provider',
    provider: { connectionId: 'c-1', kind: 'doppler', label: 'Acme dev', state: 'error', error: 'Doppler refused the token' },
    fields: [{ key: 'api_key', label: 'API key', type: 'api_key', hasValue: true, ref: 'STRIPE_KEY' }],
  },
];

function fake() {
  const api = new OrdiClient({ baseUrl: 'http://test', token: 't' });
  api.get = async <T>(path: string): Promise<T> => {
    if (path === '/projects') return { data: [PROJECT] } as T;
    if (path === `/projects/${PROJECT.id}/secrets`) return { data: SECRETS } as T;
    throw new Error(`unexpected GET ${path}`);
  };
  return api;
}

async function connect(api: OrdiClient) {
  const server = buildServer(api);
  const client = new Client({ name: 'test', version: '0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return client;
}
const text = (res: any) => res.content[0].text as string;

describe('secrets over MCP', () => {
  it('lists names, fields and env vars, and nothing a value could hide in', async () => {
    const client = await connect(fake());
    const res = await client.callTool({ name: 'list_project_secrets', arguments: { project: 'ACM' } });
    const body = JSON.parse(text(res));
    expect(body.data[0]).toMatchObject({
      name: 'ACME_ADMIN', expired: true, availableToAgents: false,
      fields: [{ key: 'url', hasValue: true }, { key: 'login', hasValue: true }, { key: 'password', hasValue: true }],
      envVars: [{ field: 'url', variable: 'SECRET_ACME_ADMIN__URL' }, { field: 'login', variable: 'SECRET_ACME_ADMIN__LOGIN' }, { field: 'password', variable: 'SECRET_ACME_ADMIN__PASSWORD' }],
    });
    // A one-field secret is its own variable.
    expect(body.data[1].envVars).toEqual([{ field: 'api_key', variable: 'SECRET_STRIPE_TEST' }]);
    for (const leak of ['admin.acme.test', 'ops@acme.test', 'Wxyz', '"hint"', '"value"']) expect(text(res)).not.toContain(leak);
  });

  it('says where the values live, and whether a provider can supply them', async () => {
    const client = await connect(fake());
    const body = JSON.parse(text(await client.callTool({ name: 'list_project_secrets', arguments: { project: 'ACM' } })));
    expect(body.data[1]).toMatchObject({ storedIn: 'ordi', reachable: true });
    expect(body.data[2]).toMatchObject({ name: 'DOPPLER_KEY', storedIn: 'doppler', reachable: false, envVars: [{ field: 'api_key', variable: 'SECRET_DOPPLER_KEY' }] });
    // The provider's own names and errors stay with the people who manage it.
    expect(JSON.stringify(body.data[2])).not.toContain('STRIPE_KEY');
  });

  it('checks one secret by name, case-insensitively, and says when there is none', async () => {
    const client = await connect(fake());
    const hit = JSON.parse(text(await client.callTool({ name: 'check_project_secret', arguments: { project: 'ACM', name: 'stripe_test' } })));
    expect(hit).toMatchObject({ exists: true, name: 'STRIPE_TEST', availableToAgents: true, expired: false });
    const miss = JSON.parse(text(await client.callTool({ name: 'check_project_secret', arguments: { project: 'ACM', name: 'NOPE' } })));
    expect(miss).toEqual({ exists: false, name: 'NOPE' });
  });

  it('offers no tool that returns a value', async () => {
    const client = await connect(fake());
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_project_secrets', 'check_project_secret']));
    expect(names.some((n) => /reveal|secret_value|get_secret/.test(n))).toBe(false);
  });
});
