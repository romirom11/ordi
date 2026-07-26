/**
 * The API serves the built SPA (single-container deployment). What matters:
 * the SPA answers every app route, static files come with the right cache
 * story, and API-shaped paths are never swallowed by the HTML fallback.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

let app: import('hono').Hono;

beforeAll(async () => {
  const dist = mkdtempSync(path.join(tmpdir(), 'ordi-dist-'));
  writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(path.join(dist, 'favicon.svg'), '<svg/>');
  mkdirSync(path.join(dist, 'assets'));
  writeFileSync(path.join(dist, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(path.join(dist, 'assets', 'index-abc123.js.gz'), gzipSync('console.log(1)'));

  process.env.WEB_DIST = dist;
  const { createApp } = await import('../app');
  app = createApp() as unknown as import('hono').Hono;
});

describe('SPA served by the API', () => {
  it('serves index.html for / and for client-side routes, no-cache', async () => {
    for (const p of ['/', '/projects/PRJ/tasks/42', '/settings/mcp', '/login']) {
      const res = await app.request(p);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<div id="root">');
      expect(res.headers.get('cache-control')).toBe('no-cache');
    }
  });

  it('serves hashed assets immutable, honouring precompression', async () => {
    const res = await app.request('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');

    const gz = await app.request('/assets/index-abc123.js', { headers: { 'accept-encoding': 'gzip' } });
    expect(gz.headers.get('content-encoding')).toBe('gzip');
  });

  it('serves root-level files by exact name', async () => {
    const res = await app.request('/favicon.svg');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<svg/>');
  });

  it('never swallows API-shaped paths into the HTML fallback', async () => {
    // Unknown API route: the API's own answer (401 – auth runs before
    // routing there, same as before the SPA moved in), and NOT the SPA
    // shell, which would poison every JSON client with a parse error.
    const unknown = await app.request('/api/v1/definitely-not-a-route');
    expect(unknown.status).toBe(401);
    expect(await unknown.text()).not.toContain('<div id="root">');

    // Live API endpoints keep answering as themselves.
    const healthz = await app.request('/healthz');
    expect((await healthz.json() as { status: string }).status).toBe('ok');
    const disc = await app.request('/.well-known/oauth-authorization-server');
    expect((await disc.json() as { issuer: string }).issuer).toBeTruthy();
    const mcp = await app.request('/api/v1/mcp', { method: 'POST', body: '{}' });
    expect(mcp.status).toBe(401);
  });
});
