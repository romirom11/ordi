/**
 * Editing a project from an agent: the description goes in and comes out as
 * plain text while ordi stores the editor's JSON, and every write carries the
 * version it read so a person's edit in the meantime is not overwritten.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { textToDoc } from '@ordi/shared';
import { buildServer } from './server';
import { OrdiClient, OrdiApiError } from './client';

type Row = Record<string, any>;

/** A real ULID shape, so the tools take it as an id rather than a key. */
const PROJECT_ID = '01JBFAKEPRJCT0000000000001';

function fakeOrdi(description: string | null) {
  const client = new OrdiClient({ baseUrl: 'http://test', token: 't' });
  const project: Row = {
    id: PROJECT_ID, key: 'CONTENT', name: 'Content', status: 'active', priority: 'none',
    summary: null, description, startDate: null, targetDate: null, leadId: null, version: 3,
  };
  const patches: Row[] = [];
  client.get = async <T>(path: string): Promise<T> => {
    if (path === '/projects') return { data: [project] } as T;
    if (path === `/projects/${PROJECT_ID}`) return { ...project } as T;
    throw new OrdiApiError(404, 'not_found', `GET ${path}`);
  };
  client.patch = async <T>(path: string, body?: any): Promise<T> => {
    patches.push(body);
    if (path !== `/projects/${PROJECT_ID}`) throw new OrdiApiError(404, 'not_found', `PATCH ${path}`);
    if (body.version !== undefined && body.version !== project.version) {
      throw new OrdiApiError(409, 'version_conflict', 'The record was modified by someone else', { version: project.version });
    }
    const { version: _v, ...rest } = body;
    Object.assign(project, rest, { version: project.version + 1 });
    return { ...project } as T;
  };
  return { client, project, patches };
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

describe('update_project', () => {
  it('reads the stored description as text with the version to send back', async () => {
    const fake = fakeOrdi(JSON.stringify(textToDoc('Goals for Q1\n\nShip the site')));
    const client = await connect(fake.client);
    const status = body(await client.callTool({ name: 'get_project_status', arguments: { projectId: PROJECT_ID } }));
    expect(status.description).toBe('Goals for Q1\n\nShip the site');
    expect(status.version).toBe(3);
  });

  it('reads legacy plain-text descriptions as they are', async () => {
    const client = await connect(fakeOrdi('Just a sentence').client);
    const status = body(await client.callTool({ name: 'get_project_status', arguments: { projectId: PROJECT_ID } }));
    expect(status.description).toBe('Just a sentence');
  });

  it('writes the description as the editor JSON, by project key, locked to the version read', async () => {
    const fake = fakeOrdi(null);
    const client = await connect(fake.client);
    const res = body(await client.callTool({ name: 'update_project', arguments: {
      project: 'content', description: 'Line one\n\nLine two', summary: ' Website rebuild ', expectedVersion: 3,
    } }));
    expect(fake.patches).toHaveLength(1);
    expect(fake.patches[0]).toMatchObject({ summary: 'Website rebuild', version: 3 });
    expect(JSON.parse(fake.patches[0]!.description)).toEqual(textToDoc('Line one\n\nLine two'));
    expect(res.project).toMatchObject({ key: 'CONTENT', summary: 'Website rebuild', description: 'Line one\n\nLine two', version: 4 });
  });

  it('locks to a fresh read when no version is given, and clears with null', async () => {
    const fake = fakeOrdi('Old text');
    const client = await connect(fake.client);
    await client.callTool({ name: 'update_project', arguments: { project: PROJECT_ID, description: null } });
    expect(fake.patches[0]).toEqual({ description: null, version: 3 });
  });

  it('refuses a stale version with a way forward', async () => {
    const client = await connect(fakeOrdi('Old text').client);
    const res: any = await client.callTool({ name: 'update_project', arguments: { project: 'CONTENT', description: 'New', expectedVersion: 2 } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('get_project_status');
  });

  it('refuses an empty update', async () => {
    const client = await connect(fakeOrdi(null).client);
    const res: any = await client.callTool({ name: 'update_project', arguments: { project: 'CONTENT' } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('Nothing to update');
  });
});
