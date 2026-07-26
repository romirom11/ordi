import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { ulid } from 'ulid';
import type { AppEnv } from './context';
import { env } from './env';
import { handleError } from './lib/errors';
import { authMiddleware } from './core/auth';
import { moduleGate } from './core/modules';
import { SERVER_VERSION } from './version';
import { oauthRoutes } from './domains/core/oauth.routes';
import { mcpRoutes, authorizationServerMetadata, protectedResourceMetadata } from './domains/core/mcp.routes';
import { getDb, sql } from '@ordi/db';

// domain routers
import { authRoutes } from './domains/core/auth.routes';
import { setupRoutes } from './domains/core/setup.routes';
import { meRoutes } from './domains/core/me.routes';
import { usersRoutes } from './domains/core/users.routes';
import { rolesRoutes } from './domains/core/roles.routes';
import { customFieldsRoutes } from './domains/core/customfields.routes';
import { searchRoutes } from './domains/core/search.routes';
import { notificationsRoutes } from './domains/core/notifications.routes';
import { savedViewsRoutes } from './domains/core/savedviews.routes';
import { attachmentsRoutes } from './domains/core/attachments.routes';
import { auditRoutes } from './domains/core/audit.routes';
import { dlqRoutes } from './domains/core/dlq.routes';
import { importExportRoutes } from './domains/core/importexport.routes';
import { openApiDoc, docsHtml } from './domains/core/openapi';
import { dashboardRoutes } from './domains/core/dashboard.routes';
import { streamRoutes } from './domains/core/stream.routes';
import { settingsRoutes } from './domains/core/settings.routes';
import { desktopRoutes } from './domains/core/desktop.routes';
import { crmRoutes } from './domains/crm/routes';
import { projectsRoutes } from './domains/projects/routes';
import { tasksRoutes } from './domains/projects/tasks.routes';
import { kbRoutes } from './domains/kb/routes';
import { timeRoutes } from './domains/time/routes';
import { financeRoutes } from './domains/finance/routes';
import { peopleRoutes } from './domains/people/routes';
import { integrationsRoutes } from './domains/integrations/routes';
import { publicRoutes } from './domains/public/routes';

async function readyz(c: Context) {
  try {
    await getDb().db.execute(sql`select 1`);
    return c.json({ status: 'ready' });
  } catch {
    return c.json({ status: 'not_ready' }, 503);
  }
}

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('requestId', c.req.header('x-request-id') ?? ulid());
    await next();
  });

  // OAuth discovery/registration/token and the MCP endpoint are consumed by
  // third-party MCP clients (some browser-based), so they get open CORS; the
  // rest of the API stays locked to the app's own origins.
  const publicOAuthPath = (path: string): boolean =>
    path.startsWith('/.well-known/') || path.includes('/.well-known/')
    || path === '/api/v1/oauth/register' || path === '/api/v1/oauth/token'
    || path === '/api/v1/mcp';
  const openCors = cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization', 'mcp-protocol-version'] });
  const appCors = cors({
    origin: (origin) => (env.corsOrigins.includes(origin) || !origin ? origin : env.corsOrigins[0]!),
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });
  app.use('*', (c, next) => (publicOAuthPath(c.req.path) ? openCors(c, next) : appCors(c, next)));

  app.onError((e, c) => handleError(e, c));

  // Health (PRD §19.2). Also exposed under /api/v1 so it is reachable through
  // web proxies that forward only /api/* – the desktop instance gate uses that.
  app.get('/healthz', (c) => c.json({ status: 'ok', version: SERVER_VERSION }));
  app.get('/api/v1/healthz', (c) => c.json({ status: 'ok', version: SERVER_VERSION }));
  app.get('/readyz', (c) => readyz(c));
  app.get('/api/v1/readyz', (c) => readyz(c));

  // OAuth discovery for MCP clients (RFC 8414 / RFC 9728). Served on every
  // path variant clients try: at the root, with the issuer path inserted, and
  // under /api/v1 for proxies that forward only /api/*.
  const asMeta = (c: Context) => c.json(authorizationServerMetadata());
  const prMeta = (c: Context) => c.json(protectedResourceMetadata());
  for (const base of ['', '/api/v1']) {
    app.get(`${base}/.well-known/oauth-authorization-server`, asMeta);
    app.get(`${base}/.well-known/oauth-authorization-server/*`, asMeta);
    app.get(`${base}/.well-known/oauth-protected-resource`, prMeta);
    app.get(`${base}/.well-known/oauth-protected-resource/*`, prMeta);
    // Some clients probe OIDC discovery first; answer with the same document.
    app.get(`${base}/.well-known/openid-configuration`, asMeta);
    app.get(`${base}/.well-known/openid-configuration/*`, asMeta);
  }

  // OAuth grant endpoints + hosted MCP. Outside the authed router: register
  // and token are anonymous by design, /mcp does its own bearer handling so it
  // can answer 401 with the discovery header instead of the app error shape.
  app.route('/api/v1/oauth', oauthRoutes());
  app.route('/api/v1/mcp', mcpRoutes());

  // Public routes (no auth): invoices/quotes/portal/intake/careers/git webhooks.
  // Mounted twice: at the root (direct API access) and under /api/v1, because the
  // web proxy (nginx/Vite) forwards only /api/* to this service and the SPA's
  // public pages fetch their data through that prefix.
  app.route('/', publicRoutes());
  app.route('/api/v1', publicRoutes());

  // OpenAPI contract (PRD §15.1) – public, static document
  app.get('/api/docs/openapi.json', (c) => c.json(openApiDoc as Record<string, unknown>));
  app.get('/api/docs', (c) => c.html(docsHtml));

  // Authenticated API
  const api = new Hono<AppEnv>();
  api.use('*', authMiddleware);
  api.use('*', moduleGate); // a module switched off answers 404, not just hidden nav
  api.route('/auth', authRoutes());
  api.route('/setup', setupRoutes()); // first-run setup (public; locked once an owner exists)
  api.route('/me', meRoutes());
  api.route('/users', usersRoutes());
  api.route('/roles', rolesRoutes());
  api.route('/custom-fields', customFieldsRoutes());
  api.route('/search', searchRoutes());
  api.route('/notifications', notificationsRoutes());
  api.route('/saved-views', savedViewsRoutes());
  api.route('/attachments', attachmentsRoutes());
  api.route('/audit', auditRoutes());
  api.route('/dlq', dlqRoutes());
  api.route('/', importExportRoutes()); // /export/*.csv, /import/*
  api.route('/', dashboardRoutes()); // /dashboard, /dashboards
  api.route('/stream', streamRoutes());
  api.route('/settings', settingsRoutes());
  api.route('/desktop', desktopRoutes()); // where to download the desktop app
  api.route('/', crmRoutes()); // /companies, /contacts, /deals, /deal-stages, /notes
  api.route('/', projectsRoutes()); // /projects, /project-types, /task-statuses...
  api.route('/', tasksRoutes()); // /tasks, /cycles, /labels, /me/tasks, /drafts
  api.route('/', kbRoutes()); // /spaces, /pages
  api.route('/', timeRoutes()); // /time
  api.route('/', financeRoutes()); // /invoices, /quotes, /payments...
  api.route('/', peopleRoutes()); // /employees, /leave...
  api.route('/', integrationsRoutes()); // /integrations, /webhooks, /git

  app.route('/api/v1', api);

  return app;
}
