import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ulid } from 'ulid';
import type { AppEnv } from './context';
import { env } from './env';
import { handleError } from './lib/errors';
import { authMiddleware } from './core/auth';
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
import { crmRoutes } from './domains/crm/routes';
import { projectsRoutes } from './domains/projects/routes';
import { tasksRoutes } from './domains/projects/tasks.routes';
import { kbRoutes } from './domains/kb/routes';
import { timeRoutes } from './domains/time/routes';
import { financeRoutes } from './domains/finance/routes';
import { peopleRoutes } from './domains/people/routes';
import { integrationsRoutes } from './domains/integrations/routes';
import { publicRoutes } from './domains/public/routes';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    c.set('requestId', c.req.header('x-request-id') ?? ulid());
    await next();
  });

  app.use('*', cors({
    origin: (origin) => (env.corsOrigins.includes(origin) || !origin ? origin : env.corsOrigins[0]!),
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'x-request-id'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  }));

  app.onError((e, c) => handleError(e, c));

  // Health (PRD §19.2)
  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', async (c) => {
    try {
      await getDb().db.execute(sql`select 1`);
      return c.json({ status: 'ready' });
    } catch {
      return c.json({ status: 'not_ready' }, 503);
    }
  });

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
