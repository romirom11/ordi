import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fetchPublicUrl, isPublicAddress } from './remote-fetch';
import { buildServer } from './server';
import { OrdiClient } from './client';

// A local stand-in for "something inside the network". The default policy
// must never reach it; tests that need a body widen the policy explicitly.
const hits: string[] = [];
let bytesSent = 0;
const server = http.createServer((req, res) => {
  hits.push(req.url ?? '');
  if (req.url === '/big') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' }); // chunked, no content-length
    const chunk = Buffer.alloc(256 * 1024, 1);
    const pump = () => {
      while (bytesSent < 30 * 1024 * 1024) {
        bytesSent += chunk.length;
        if (!res.write(chunk)) return void res.once('drain', pump);
      }
      res.end();
    };
    res.on('close', () => res.removeAllListeners('drain'));
    return pump();
  }
  if (req.url === '/to-private') {
    res.writeHead(302, { location: 'http://10.0.0.1/secret' });
    return res.end();
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('INTERNAL');
});
let base = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });
beforeEach(() => { hits.length = 0; bytesSent = 0; });

const allowAll = () => true;

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', 'not-an-ip',
  ])('refuses %s', (addr) => expect(isPublicAddress(addr)).toBe(false));
  it.each(['1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])('allows %s', (addr) => expect(isPublicAddress(addr)).toBe(true));
});

describe('fetchPublicUrl', () => {
  it('refuses a loopback IP literal without connecting', async () => {
    await expect(fetchPublicUrl(`${base}/latest/meta-data`, { maxBytes: 1024 })).rejects.toThrow(/private or internal/);
    expect(hits).toEqual([]);
  });

  it('refuses a hostname that resolves to loopback, at connect time', async () => {
    const port = new URL(base).port;
    await expect(fetchPublicUrl(`http://localhost:${port}/x`, { maxBytes: 1024 })).rejects.toThrow(/private or internal/);
    expect(hits).toEqual([]);
  });

  it('refuses non-http schemes', async () => {
    await expect(fetchPublicUrl('file:///etc/passwd', { maxBytes: 1024 })).rejects.toThrow(/Only http\(s\)/);
  });

  it('checks every redirect hop', async () => {
    const onlyLoopback = (a: string) => a === '127.0.0.1';
    await expect(fetchPublicUrl(`${base}/to-private`, { maxBytes: 1024, isAllowed: onlyLoopback })).rejects.toThrow(/private or internal/);
    expect(hits).toEqual(['/to-private']);
  });

  it('stops reading a chunked body once it passes the cap', async () => {
    await expect(fetchPublicUrl(`${base}/big`, { maxBytes: 1024 * 1024, isAllowed: allowAll })).rejects.toThrow(/exceeds the 1048576 byte cap/);
    expect(bytesSent).toBeLessThan(30 * 1024 * 1024);
  });

  it('returns the body and content type of an allowed url', async () => {
    const file = await fetchPublicUrl(`${base}/ok`, { maxBytes: 1024, isAllowed: allowAll });
    expect(Buffer.from(file.bytes).toString()).toBe('INTERNAL');
    expect(file.contentType).toBe('text/plain; charset=utf-8');
  });
});

describe('upload_attachment with a url', () => {
  it('refuses an internal url and uploads nothing', async () => {
    const api = new OrdiClient({ baseUrl: 'http://test', token: 't' });
    (api as any).get = async () => ({ data: [] });
    const uploads: FormData[] = [];
    api.postForm = async <T>(_p: string, form: FormData): Promise<T> => { uploads.push(form); return { id: 'a', src: '/x' } as T; };
    const mcp = buildServer(api);
    const client = new Client({ name: 'test', version: '0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcp.connect(st);
    await client.connect(ct);
    const res: any = await client.callTool({ name: 'upload_attachment', arguments: { filename: 'x.txt', url: `${base}/latest/meta-data` } });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/private or internal/);
    expect(hits).toEqual([]);
    expect(uploads).toEqual([]);
  });
});
