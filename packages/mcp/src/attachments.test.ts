import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer, textToDoc, docToText } from './server';
import { OrdiClient } from './client';

async function connect(api: OrdiClient) {
  const server = buildServer(api);
  const client = new Client({ name: 'test', version: '0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return client;
}

function fakeClient(opts: {
  postFormImpl?: (path: string, form: FormData) => Promise<any>;
  fetchImpl?: typeof fetch;
} = {}): { api: OrdiClient; postFormCalls: { path: string; form: FormData }[] } {
  const api = new OrdiClient({ baseUrl: 'http://test', token: 't' });
  // Minimal GET stubs that buildServer may call (only needed for some tools – not for upload_attachment)
  (api as any).get = async () => ({ data: [] });

  const postFormCalls: { path: string; form: FormData }[] = [];
  const origFetch = globalThis.fetch;

  if (opts.fetchImpl) (globalThis as any).fetch = opts.fetchImpl;

  api.postForm = async <T>(path: string, form: FormData): Promise<T> => {
    postFormCalls.push({ path, form });
    if (opts.postFormImpl) return opts.postFormImpl(path, form) as T;
    // Default: pretend S3 stored it and returned signed src
    return { id: 'att-1', src: '/api/v1/files/att-1/abc123' } as T;
  };

  return { api, postFormCalls };
}

const tinyPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

describe('upload_attachment', () => {
  it('is exposed', async () => {
    const { api } = fakeClient();
    const client = await connect(api);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('upload_attachment');
  });

  it('uploads base64 and returns signed src + absolute url + hint', async () => {
    const { api, postFormCalls } = fakeClient();
    const client = await connect(api);

    const res: any = await client.callTool({
      name: 'upload_attachment',
      arguments: { filename: 'screen.png', data: tinyPngBase64 },
    });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse(res.content[0].text);
    expect(body.src).toBe('/api/v1/files/att-1/abc123');
    expect(body.url).toBe('http://test/api/v1/files/att-1/abc123');
    expect(body.filename).toBe('screen.png');
    expect(body.hint).toContain('![');

    // The multipart was built as POST /attachments with a File-like part.
    expect(postFormCalls).toHaveLength(1);
    expect(postFormCalls[0]!.path).toBe('/attachments');
    const file = postFormCalls[0]!.form.get('file') as File;
    expect(file.name).toBe('screen.png');
  });

  it('accepts data: URI prefix', async () => {
    const { api } = fakeClient();
    const client = await connect(api);
    const res: any = await client.callTool({
      name: 'upload_attachment',
      arguments: { filename: 'a.png', data: `data:image/png;base64,${tinyPngBase64}` },
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text).mime).toBe('image/png');
  });

  it('entityType without entityId is rejected client-side', async () => {
    const { api, postFormCalls } = fakeClient();
    const client = await connect(api);
    const res: any = await client.callTool({
      name: 'upload_attachment',
      arguments: { filename: 'a.png', data: tinyPngBase64, entityType: 'task' },
    });
    expect(res.isError).toBe(true);
    expect(postFormCalls).toHaveLength(0);
  });

  it('entityType+entityId are forwarded as form fields', async () => {
    const { api, postFormCalls } = fakeClient();
    const client = await connect(api);
    const res: any = await client.callTool({
      name: 'upload_attachment',
      arguments: { filename: 'spec.pdf', data: tinyPngBase64, entityType: 'task', entityId: 't1' },
    });
    expect(res.isError).toBeFalsy();
    expect(postFormCalls[0]!.form.get('entityType')).toBe('task');
    expect(postFormCalls[0]!.form.get('entityId')).toBe('t1');
  });

  it('blocked extensions are rejected before upload', async () => {
    const { api, postFormCalls } = fakeClient();
    const client = await connect(api);
    const res: any = await client.callTool({
      name: 'upload_attachment',
      arguments: { filename: 'evil.exe', data: tinyPngBase64 },
    });
    expect(res.isError).toBe(true);
    expect(String(res.content[0].text)).toContain('not allowed');
    expect(postFormCalls).toHaveLength(0);
  });

  it('requires one of data or url', async () => {
    const { api } = fakeClient();
    const client = await connect(api);
    const res: any = await client.callTool({
      name: 'upload_attachment',
      arguments: { filename: 'a.png' },
    });
    expect(res.isError).toBe(true);
  });

  it('can fetch from url server-side', async () => {
    const pngBytes = Buffer.from(tinyPngBase64, 'base64');
    const fetchImpl = async () =>
      new Response(pngBytes, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(pngBytes.length) } }) as any;

    const prevFetch = globalThis.fetch;
    (globalThis as any).fetch = fetchImpl;
    try {
      const { api, postFormCalls } = fakeClient({ fetchImpl });
      const client = await connect(api);
      const res: any = await client.callTool({
        name: 'upload_attachment',
        arguments: { filename: 'remote.png', url: 'https://example.com/a.png' },
      });
      expect(res.isError).toBeFalsy();
      expect(postFormCalls).toHaveLength(1);
    } finally {
      (globalThis as any).fetch = prevFetch;
    }
  });
});

describe('interleaved images in task text (upload + create)', () => {
  it('two uploads interleaved at arbitrary positions round-trip through doc', async () => {
    // Simulate the full flow without mocking the task API – unit-test the
    // textToDoc / docToText contract the flow depends on.
    const src1 = '/api/v1/files/att-1/tok1';
    const src2 = '/api/v1/files/att-2/tok2';
    const text =
      `Крок 1: натискаємо кнопку логіну\n\n![скрін логіну](${src1})\n\n` +
      `Крок 2: бачимо помилку 500\n\n![скрін помилки](${src2})\n\n` +
      `Очікуваний результат: редірект на /dashboard`;

    const doc: any = textToDoc(text);
    // Two image blocks in order
    const images = (doc.content as any[]).filter((b: any) => b.type === 'image');
    expect(images).toHaveLength(2);
    expect(images[0].attrs.src).toBe(src1);
    expect(images[1].attrs.src).toBe(src2);

    // Round-trip preserves interleaving
    expect(docToText(doc)).toBe(text);

    // absolutize for the agent, relativize on write
    const { absolutizeImageSrcs, relativizeImageSrcs } = await import('./format');
    const abs = absolutizeImageSrcs(text, 'http://test');
    expect(abs).toContain('http://test/api/v1/files/att-1/tok1');
    expect(abs).toContain('http://test/api/v1/files/att-2/tok2');
    expect(relativizeImageSrcs(abs, 'http://test')).toBe(text);
  });

  it('update interleaves a new image without losing existing ones', async () => {
    const srcOld = '/api/v1/files/old/tok';
    const prev = `Intro\n\n![old](${srcOld})\n\nOutro`;
    const srcNew = '/api/v1/files/new/tok';
    const next = prev.replace('Outro', `Middle\n\n![new](${srcNew})\n\nOutro`);

    const doc: any = textToDoc(next);
    const images = (doc.content as any[]).filter((b: any) => b.type === 'image');
    expect(images.map((i: any) => i.attrs.src)).toEqual([srcOld, srcNew]);
    expect(docToText(doc)).toBe(next);
  });
});
