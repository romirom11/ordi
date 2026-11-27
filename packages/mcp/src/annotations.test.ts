/**
 * Every tool a client lists carries a title and read/write hints, and the
 * table they come from matches the catalog exactly: no tool served bare, no
 * entry left behind by a removed tool.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCP_TOOLS } from '@ordi/shared';
import { buildServer } from './server';
import { OrdiClient } from './client';

async function listTools() {
  const server = buildServer(new OrdiClient({ baseUrl: 'http://test', token: 't' }));
  const client = new Client({ name: 'test', version: '0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return (await client.listTools()).tools;
}

describe('tool annotations', () => {
  it('the table and the served catalog name the same tools', async () => {
    const served = (await listTools()).map((t) => t.name).sort();
    expect(served).toEqual(Object.keys(MCP_TOOLS).sort());
  });

  it('every tool has a title and says whether it reads or writes', async () => {
    for (const tool of await listTools()) {
      expect(tool.name.length, tool.name).toBeLessThanOrEqual(64);
      expect(tool.title, tool.name).toBeTruthy();
      expect(tool.annotations?.title, tool.name).toBe(tool.title);
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
      expect(typeof tool.annotations?.destructiveHint, tool.name).toBe('boolean');
      // A tool that only reads cannot also destroy.
      expect(tool.annotations?.readOnlyHint && tool.annotations?.destructiveHint, tool.name).toBe(false);
    }
  });

  it('marks deleting, rewriting and emailing as destructive, and lookups as read-only', async () => {
    const byName = new Map((await listTools()).map((t) => [t.name, t.annotations]));
    for (const name of ['delete_workflow_status', 'remove_project_resource', 'update_kb_page', 'send_invoice']) {
      expect(byName.get(name)?.destructiveHint, name).toBe(true);
    }
    for (const name of ['search', 'list_tasks', 'get_task', 'list_project_secrets']) {
      expect(byName.get(name)?.readOnlyHint, name).toBe(true);
    }
    expect(byName.get('create_task')).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get('send_invoice')?.openWorldHint).toBe(true);
    expect(byName.get('list_tasks')?.openWorldHint).toBe(false);
  });
});
