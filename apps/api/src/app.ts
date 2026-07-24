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
import { meRoutes } from './domains/core/me.routes';
import { usersRoutes } from './domains/core/users.routes';
import { rolesRoutes } from './domains/core/roles.routes';
import { customFieldsRoutes } from './domains/core/customfields.routes';
import { searchRoutes } from './domains/core/search.routes';
import { notificationsRoutes } from './domains/core/notifications.routes';
import { savedViewsRoutes } from './domains/core/savedviews.routes';
import { attachmentsRoutes } from './domains/core/attachments.routes';
import { auditRoutes } from './domains/core/audit.routes';
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

  // Public routes (no auth): invoices/quotes/portal/intake/careers/git webhooks
  app.route('/', publicRoutes());

  // Authenticated API
  const api = new Hono<AppEnv>();
  api.use('*', authMiddleware);
  api.route('/auth', authRoutes());
  api.route('/me', meRoutes());
  api.route('/users', usersRoutes());
  api.route('/roles', rolesRoutes());
  api.route('/custom-fields', customFieldsRoutes());
  api.route('/search', searchRoutes());
  api.route('/notifications', notificationsRoutes());
  api.route('/saved-views', savedViewsRoutes());
  api.route('/attachments', attachmentsRoutes());
  api.route('/audit', auditRoutes());
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
