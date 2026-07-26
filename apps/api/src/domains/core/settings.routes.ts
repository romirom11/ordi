import { Hono } from 'hono';
import { getDb, schema, eq, sql } from '@ordi/db';
import { workspaceSettingsUpdateSchema } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { emailConfigured, trySendEmail, verifyEmailTransport } from '../../lib/email';
import { encryptIntegrationSecrets, invalidateRuntimeConfig, runtimeConfig } from '../../lib/runtime-config';
import { invalidateModuleCache } from '../../core/modules';
import { integrationsConfigSchema } from '@ordi/shared';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';

/**
 * Mask a secret webhook URL for GET responses shown to non-managers: keep the
 * host and the last 4 chars, hide everything in between. Returns null if unset.
 */
function maskWebhookUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let host = 'hooks.slack.com';
  try { host = new URL(url).host; } catch { /* keep default */ }
  const last4 = url.slice(-4);
  return `https://${host}/…/${last4}`;
}

/** Workspace settings (PRD §14.7). Trash/restore also here. */
export function settingsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.get('/workspace', async (c) => {
    const { db } = getDb();
    const [ws] = await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.id, 'workspace'));
    if (!ws) return c.json({ id: 'workspace', name: 'ordi', modules: {}, integrations: { slackWebhookUrl: null }, invoiceSettings: {} });

    // GET is open to any authed user (Shell reads name/logo). Only settings.manage
    // holders may fetch the real webhook secret, and only when explicitly asked
    // via ?full=1; everyone else gets a masked preview.
    const actor = currentActor(c);
    const full = c.req.query('full') === '1' && actor.access.permissions.has('settings.manage');
    const integrations = (ws.integrations as { slackWebhookUrl?: string | null }) ?? {};
    const safeIntegrations = full
      ? integrations
      : { ...integrations, slackWebhookUrl: maskWebhookUrl(integrations.slackWebhookUrl) };
    return c.json({ ...ws, integrations: safeIntegrations });
  });

  app.patch('/workspace', guard('settings.manage'), async (c) => {
    const patch = workspaceSettingsUpdateSchema.parse(await c.req.json());
    const { db } = getDb();
    const [existing] = await db.select().from(schema.workspaceSettings).where(eq(schema.workspaceSettings.id, 'workspace'));

    const allowed: Record<string, unknown> = {};
    for (const k of ['name', 'logo', 'legalDetails', 'workingDays', 'defaultCurrency', 'defaultBillable', 'defaultEstimateUnit', 'sensitiveAuditRetentionMonths']) {
      if ((patch as Record<string, unknown>)[k] !== undefined) allowed[k] = (patch as Record<string, unknown>)[k];
    }
    // modules + integrations are merged (not replaced) so partial patches keep other keys.
    if (patch.modules !== undefined) {
      allowed.modules = { ...((existing?.modules as Record<string, unknown>) ?? {}), ...patch.modules };
    }
    if (patch.integrations !== undefined) {
      allowed.integrations = { ...((existing?.integrations as Record<string, unknown>) ?? {}), ...patch.integrations };
    }
    // invoiceSettings merged (not replaced) so partial patches keep other keys.
    if (patch.invoiceSettings !== undefined) {
      allowed.invoiceSettings = { ...((existing?.invoiceSettings as Record<string, unknown>) ?? {}), ...patch.invoiceSettings };
    }

    if (existing) {
      if (Object.keys(allowed).length) {
        await db.update(schema.workspaceSettings).set(allowed).where(eq(schema.workspaceSettings.id, 'workspace'));
      }
    } else {
      await db.insert(schema.workspaceSettings).values({ id: 'workspace', ...(allowed as any) });
    }
    if (patch.modules !== undefined) invalidateModuleCache();
    return c.json({ ok: true });
  });

  // Is outgoing mail actually working? Blocked SMTP ports are the single most
  // common reason invites and invoices silently do not arrive.
  app.get('/email/health', guard('settings.manage'), async (c) => {
    if (!await emailConfigured()) return c.json({ configured: false, ok: false });
    const result = await verifyEmailTransport();
    return c.json({ configured: true, ...result });
  });

  /** Prove delivery end to end, not just that the port answers. */
  app.post('/email/test', guard('settings.manage'), async (c) => {
    const actor = currentActor(c);
    const { db } = getDb();
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, actor.userId!));
    if (!user?.email) throw err.validation('Your account has no email address');
    const result = await trySendEmail({
      to: user.email,
      subject: 'ordi test email',
      body: 'If you are reading this, outgoing email from your ordi instance works.',
      html: '<p>If you are reading this, outgoing email from your ordi instance works.</p>',
    });
    return c.json({ ...result, to: user.email });
  });

  // Integration settings that would otherwise need a server restart to change.
  // Secrets are never returned – only whether one is set, and where the
  // effective value comes from.
  app.get('/integrations-config', guard('settings.manage'), async (c) => {
    const cfg = await runtimeConfig();
    return c.json({
      smtp: cfg.smtp
        ? {
          host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure,
          user: cfg.smtp.user, from: cfg.smtp.from, hasPassword: !!cfg.smtp.pass,
        }
        : null,
      smtpSource: cfg.smtpSource,
      github: cfg.github ? { clientId: cfg.github.clientId, hasSecret: !!cfg.github.clientSecret } : null,
      githubSource: cfg.githubSource,
      githubApp: cfg.githubApp
        ? {
          appId: cfg.githubApp.appId, slug: cfg.githubApp.slug, htmlUrl: cfg.githubApp.htmlUrl,
          hasPrivateKey: !!cfg.githubApp.privateKey, hasWebhookSecret: !!cfg.githubApp.webhookSecret,
        }
        : null,
      slack: cfg.slack ? { clientId: cfg.slack.clientId, hasSecret: !!cfg.slack.clientSecret } : null,
      slackSource: cfg.slackSource,
    });
  });

  app.patch('/integrations-config', guard('settings.manage'), async (c) => {
    const patch = integrationsConfigSchema.parse(await c.req.json());
    const { db } = getDb();
    const [existing] = await db.select().from(schema.workspaceSettings)
      .where(eq(schema.workspaceSettings.id, 'workspace'));
    const current = ((existing?.integrations ?? {}) as Record<string, unknown>);

    // An omitted secret means "keep the stored one" – the UI never receives it,
    // so it cannot send it back.
    const encrypted = encryptIntegrationSecrets(patch);
    const merged: Record<string, unknown> = { ...current };
    for (const key of ['smtp', 'github', 'githubApp', 'slack'] as const) {
      const incoming = encrypted[key];
      if (incoming === undefined) continue;
      const prev = (current[key] ?? {}) as Record<string, unknown>;
      const next = { ...prev, ...incoming } as Record<string, unknown>;
      for (const secretKey of ['pass', 'clientSecret', 'privateKey', 'webhookSecret']) {
        if (next[secretKey] === '' || next[secretKey] === undefined) {
          if (prev[secretKey]) next[secretKey] = prev[secretKey];
          else delete next[secretKey];
        }
      }
      merged[key] = next;
    }

    if (existing) {
      await db.update(schema.workspaceSettings).set({ integrations: merged })
        .where(eq(schema.workspaceSettings.id, 'workspace'));
    } else {
      await db.insert(schema.workspaceSettings).values({ id: 'workspace', integrations: merged });
    }
    invalidateRuntimeConfig();
    await writeActivity(db, {
      entityType: 'workspace', entityId: 'workspace', action: 'integrations_config_updated',
      actorId: currentActor(c).userId, actorType: currentActor(c).actorType,
      diff: { keys: Object.keys(patch) },
    });
    return c.json({ ok: true });
  });

  // Trash (PRD §14.7): list soft-deleted across the main business entities.
  app.get('/trash', guard('settings.manage'), async (c) => {
    const { db } = getDb();
    const [projects, tasks, invoices] = await Promise.all([
      db.execute(sql`select id, name, deleted_at from projects where deleted_at is not null limit 50`),
      db.execute(sql`select id, title, deleted_at from tasks where deleted_at is not null limit 50`),
      db.execute(sql`select id, number, deleted_at from invoices where deleted_at is not null limit 50`),
    ]);
    return c.json({ projects, tasks, invoices });
  });

  return app;
}
