/**
 * Serve the built SPA from the API process, so one container is the whole
 * application. This is the standard shape for self-hosted products (n8n,
 * Directus, Outline, Grafana, Gitea all do it): a separate static-file
 * container adds a network boundary whose routing has to be re-taught to
 * every proxy in front, and misrouted OAuth discovery on that boundary is
 * exactly how MCP clients failed to connect to real deployments.
 *
 * Mechanics, matched to what Vite emits:
 * - /assets/* files carry a content hash in the name → Cache-Control
 *   immutable for a year. serveStatic answers range requests and, with
 *   precompressed, serves the .gz files the Docker build generates next to
 *   text assets (or .br if someone adds them).
 * - index.html is the one mutable file → no-cache (revalidate every load),
 *   kept in memory since it is the answer to every SPA route.
 * - API-ish prefixes are never swallowed by the SPA fallback: an unknown
 *   /api/v1/* stays a JSON-shaped 404 instead of 200 index.html, which would
 *   otherwise poison clients with HTML.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AppEnv } from './context';

/** Prefixes that belong to the API even when nothing matched them. */
const API_PREFIXES = ['/api/', '/healthz', '/readyz', '/.well-known/'];

export function webDistDir(): string | null {
  // Anchored to this module (apps/api/src or dist), NOT to process.cwd() -
  // the dist must be found no matter which directory the server was
  // launched from. WEB_DIST overrides for unusual layouts.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.WEB_DIST,
    path.resolve(here, '../../web/dist'),
    path.resolve(process.cwd(), '../web/dist'),
  ].filter((c): c is string => !!c);
  return candidates.find((c) => existsSync(path.join(c, 'index.html'))) ?? null;
}

export function mountWeb(app: Hono<AppEnv>, dist: string): void {
  // serveStatic resolves root against cwd (documented Hono behaviour), so
  // hand it a cwd-relative path however WEB_DIST was spelled.
  const root = path.relative(process.cwd(), dist) || '.';
  const indexHtml = readFileSync(path.join(dist, 'index.html'), 'utf8');

  const isApiPath = (p: string) =>
    API_PREFIXES.some((prefix) => p === prefix.replace(/\/$/, '') || p.startsWith(prefix));

  app.use('/assets/*', serveStatic({
    root,
    precompressed: true,
    onFound: (_p, c) => c.header('Cache-Control', 'public, max-age=31536000, immutable'),
  }));
  // Root-level files the SPA references by exact name (favicons, manifest…).
  // Only paths that look like files: everything else must reach the HTML
  // fallback below (serveStatic would otherwise answer '/' itself, without
  // the no-cache header), and API traffic never pays a filesystem stat.
  const rootStatic = serveStatic({ root, precompressed: true });
  const looksLikeFile = (p: string) => /\.[A-Za-z0-9]+$/.test(p);
  app.use('*', (c, next) =>
    (!isApiPath(c.req.path) && looksLikeFile(c.req.path) ? rootStatic(c, next) : next()));

  app.get('*', (c, next) => {
    if (isApiPath(c.req.path)) return next(); // fall through to the API's own 404 shape
    return c.html(indexHtml, 200, { 'Cache-Control': 'no-cache' });
  });
}
