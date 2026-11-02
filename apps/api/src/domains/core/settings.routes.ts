import { Hono } from 'hono';
import { getDb, schema, eq, sql } from '@ordi/db';
import { workspaceSettingsUpdateSchema } from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { emailConfigured, trySendEmail, verifyEmailTransport } from '../../lib/email';
import {
  ENV_SENDER_ID, LEGACY_SENDER_ID, encryptIntegrationSecrets, invalidateRuntimeConfig, runtimeConfig, saveMailSenders, storeSlackAppConfig,
  type MailSender, type StoredMailSender,
} from '../../lib/runtime-config';
import { ulid } from 'ulid';
import { createSlackApp, SlackManifestError } from '../integrations/slack-app';
import { invalidateModuleCache } from '../../core/modules';
import { integrationsConfigSchema, mailRolesSchema, mailSenderInputSchema, mailSenderUpdateSchema } from '@ordi/shared';
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

  // ── Mail senders (Settings → Email) ──
  // Secrets never leave the API: a sender reports whether it has a password.
  const publicSender = (s: MailSender) => ({
    id: s.id, name: s.name, from: s.smtp.from, replyTo: s.replyTo, source: s.source,
    host: s.smtp.host, port: s.smtp.port, secure: s.smtp.secure, user: s.smtp.user, hasPassword: !!s.smtp.pass,
  });
  const logSenders = (c: Parameters<typeof currentActor>[0], diff: Record<string, unknown>) => writeActivity(getDb().db, {
    entityType: 'workspace', entityId: 'workspace', action: 'mail_senders_updated',
    actorId: currentActor(c).userId, actorType: currentActor(c).actorType, diff,
  });
  const notEnv = (id: string) => {
    if (id === ENV_SENDER_ID) throw err.validation('The server .env sender is read-only – change SMTP_URL on the server');
  };

  app.get('/mail-senders', guard('settings.manage'), async (c) => {
    const cfg = await runtimeConfig();
    return c.json({ senders: cfg.senders.map(publicSender), systemSenderId: cfg.systemSenderId, invoiceSenderId: cfg.invoiceSenderId });
  });

  app.post('/mail-senders', guard('settings.manage'), async (c) => {
    const input = mailSenderInputSchema.parse(await c.req.json());
    const id = ulid();
    await saveMailSenders((senders, roles) => ({
      senders: [...senders, { id, name: input.name, from: input.from, replyTo: input.replyTo || undefined, host: input.host, port: input.port, secure: input.secure, user: input.user, pass: input.pass }],
      roles,
    }));
    await logSenders(c, { created: id, name: input.name });
    const cfg = await runtimeConfig();
    return c.json(publicSender(cfg.senders.find((s) => s.id === id)!), 201);
  });

  app.patch('/mail-senders/:id', guard('settings.manage'), async (c) => {
    const id = c.req.param('id');
    notEnv(id);
    const input = mailSenderUpdateSchema.parse(await c.req.json());
    let found = false;
    await saveMailSenders((senders, roles) => ({
      senders: senders.map((s) => {
        if (s.id !== id) return s;
        found = true;
        const next: StoredMailSender = { ...s, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as StoredMailSender;
        if (input.replyTo === '') delete next.replyTo;
        if (!input.pass) next.pass = s.pass;
        return next;
      }),
      roles,
    }));
    if (!found) throw err.notFound('Mail sender not found');
    await logSenders(c, { updated: id, keys: Object.keys(input).filter((k) => k !== 'pass') });
    const cfg = await runtimeConfig();
    return c.json(publicSender(cfg.senders.find((s) => s.id === id)!));
  });

  app.delete('/mail-senders/:id', guard('settings.manage'), async (c) => {
    const id = c.req.param('id');
    notEnv(id);
    let found = false;
    await saveMailSenders((senders, roles) => {
      found = senders.some((s) => s.id === id);
      // A role on a deleted sender falls back to the default (first sender).
      return {
        senders: senders.filter((s) => s.id !== id),
        roles: { system: roles.system === id ? null : roles.system, invoices: roles.invoices === id ? null : roles.invoices },
      };
    });
    if (!found) throw err.notFound('Mail sender not found');
    await logSenders(c, { deleted: id });
    return c.json({ ok: true });
  });

  app.put('/mail-senders/roles', guard('settings.manage'), async (c) => {
    const input = mailRolesSchema.parse(await c.req.json());
    const cfg = await runtimeConfig();
    for (const id of [input.system, input.invoices]) {
      if (id && !cfg.senders.some((s) => s.id === id)) throw err.validation(`Unknown mail sender: ${id}`);
    }
    await saveMailSenders((senders, roles) => ({
      senders,
      roles: {
        system: input.system !== undefined ? input.system : roles.system,
        invoices: input.invoices !== undefined ? input.invoices : roles.invoices,
      },
    }));
    await logSenders(c, { roles: input });
    const next = await runtimeConfig();
    return c.json({ systemSenderId: next.systemSenderId, invoiceSenderId: next.invoiceSenderId });
  });

  app.get('/mail-senders/:id/health', guard('settings.manage'), async (c) => {
    const id = c.req.param('id');
    if (!(await runtimeConfig()).senders.some((s) => s.id === id)) throw err.notFound('Mail sender not found');
    return c.json(await verifyEmailTransport(id));
  });

  app.post('/mail-senders/:id/test', guard('settings.manage'), async (c) => {
    const id = c.req.param('id');
    const sender = (await runtimeConfig()).senders.find((s) => s.id === id);
    if (!sender) throw err.notFound('Mail sender not found');
    const actor = currentActor(c);
    const [user] = await getDb().db.select().from(schema.users).where(eq(schema.users.id, actor.userId!));
    if (!user?.email) throw err.validation('Your account has no email address');
    const result = await trySendEmail({
      to: user.email,
      senderId: id,
      subject: `ordi test email from ${sender.name}`,
      body: `If you are reading this, ordi can send mail as ${sender.smtp.from}.`,
      html: `<p>If you are reading this, ordi can send mail as <b>${sender.smtp.from.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]!)}</b>.</p>`,
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
      slack: cfg.slack ? { clientId: cfg.slack.clientId, hasSecret: !!cfg.slack.clientSecret, hasSigningSecret: !!cfg.slack.signingSecret } : null,
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
    // SMTP is a sender now: the old single setting edits sender "smtp", which
    // saveMailSenders writes (and encrypts) on its own.
    if (patch.smtp) {
      const smtp = patch.smtp;
      await saveMailSenders((senders, roles) => {
        const prev = senders.find((s) => s.id === LEGACY_SENDER_ID);
        const next: StoredMailSender = {
          id: LEGACY_SENDER_ID, name: prev?.name ?? 'Default', replyTo: prev?.replyTo,
          host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, pass: smtp.pass || prev?.pass, from: smtp.from,
        };
        return { senders: prev ? senders.map((s) => (s.id === LEGACY_SENDER_ID ? next : s)) : [next, ...senders], roles };
      });
    }
    const [fresh] = await db.select().from(schema.workspaceSettings)
      .where(eq(schema.workspaceSettings.id, 'workspace'));
    const latest = ((fresh?.integrations ?? {}) as Record<string, unknown>);
    const encrypted = encryptIntegrationSecrets({ ...patch, smtp: undefined });
    const merged: Record<string, unknown> = { ...latest };
    for (const key of ['github', 'githubApp', 'slack'] as const) {
      const incoming = encrypted[key];
      if (incoming === undefined) continue;
      const prev = (latest[key] ?? {}) as Record<string, unknown>;
      const next = { ...prev, ...incoming } as Record<string, unknown>;
      for (const secretKey of ['pass', 'clientSecret', 'privateKey', 'webhookSecret', 'signingSecret']) {
        if (next[secretKey] === '' || next[secretKey] === undefined) {
          if (prev[secretKey]) next[secretKey] = prev[secretKey];
          else delete next[secretKey];
        }
      }
      merged[key] = next;
    }

    if (fresh) {
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

  // One-click Slack setup: exchange an app configuration token for a freshly
  // created Slack app (Manifest API) and store its credentials – the Slack
  // counterpart of the GitHub App manifest flow.
  app.post('/integrations-config/slack-app', guard('settings.manage'), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { configToken?: unknown };
    const configToken = typeof body.configToken === 'string' ? body.configToken.trim() : '';
    if (!configToken) throw err.validation('configToken is required');

    const { db } = getDb();
    const [ws] = await db.select().from(schema.workspaceSettings)
      .where(eq(schema.workspaceSettings.id, 'workspace'));

    let created;
    try {
      created = await createSlackApp(configToken, ws?.name || 'ordi');
    } catch (e) {
      if (e instanceof SlackManifestError) throw err.validation(`Slack refused to create the app – ${e.message}`);
      throw err.validation('Could not reach Slack to create the app');
    }
    await storeSlackAppConfig({
      clientId: created.clientId,
      clientSecret: created.clientSecret,
      signingSecret: created.signingSecret,
    });
    await writeActivity(db, {
      entityType: 'workspace', entityId: 'workspace', action: 'integrations_config_updated',
      actorId: currentActor(c).userId, actorType: currentActor(c).actorType,
      diff: { keys: ['slack'], slackAppId: created.appId },
    });
    return c.json({ ok: true, appId: created.appId });
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
