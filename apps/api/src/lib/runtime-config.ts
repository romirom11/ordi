/**
 * Integration settings that can be configured from the UI instead of the
 * server .env: mail senders (SMTP), and the GitHub/Slack OAuth apps.
 *
 * Values live in `workspace_settings.integrations`; secrets are encrypted at
 * rest and never leave the API. Environment variables remain the fallback, so
 * existing deployments keep working untouched – but anything set in the UI
 * wins, because that is the more explicit and more recent decision.
 */
import { getDb, schema, eq } from '@ordi/db';
import { env } from '../env';
import { decrypt, encrypt } from './crypto';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/**
 * One address ordi can send mail from (Settings → Email). The workspace keeps
 * a list of them; one is the system sender (invites, password resets,
 * notifications) and one the default for invoices and quotes. SMTP_URL in the
 * server env shows up as a read-only sender with id "env".
 */
export interface MailSender {
  id: string;
  name: string;
  /** Where replies go when it is not the From address, e.g. the accountant. */
  replyTo: string | null;
  source: 'db' | 'env';
  smtp: SmtpConfig;
}

/** Stored shape of a sender – `pass` is ciphertext. */
export interface StoredMailSender {
  id: string;
  name: string;
  replyTo?: string;
  host: string;
  port?: number;
  secure?: boolean;
  user?: string;
  pass?: string;
  from?: string;
}

export interface MailRoles {
  system?: string | null;
  invoices?: string | null;
}

/** The env sender's id; it cannot be edited or deleted from the UI. */
export const ENV_SENDER_ID = 'env';
/** The id the pre-senders single SMTP setting (`integrations.smtp`) maps to. */
export const LEGACY_SENDER_ID = 'smtp';

export interface OAuthAppConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * A GitHub App owned by this ordi instance (created via the manifest flow or
 * pasted in manually). The private key signs installation-token JWTs; the
 * webhook secret verifies every incoming delivery for this app.
 */
export interface GithubAppConfig {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  htmlUrl: string;
}

export interface RuntimeConfig {
  /** The system sender's SMTP settings – what mail goes out through by default. */
  smtp: SmtpConfig | null;
  /** Where the system sender comes from, for the settings screen. */
  smtpSource: 'db' | 'env' | 'none';
  senders: MailSender[];
  systemSenderId: string | null;
  invoiceSenderId: string | null;
  github: OAuthAppConfig | null;
  githubSource: 'db' | 'env' | 'none';
  githubApp: GithubAppConfig | null;
  slack: SlackAppConfig | null;
  slackSource: 'db' | 'env' | 'none';
}

/** Slack adds the request-signing secret for inbound events/commands. */
export interface SlackAppConfig extends OAuthAppConfig {
  signingSecret: string;
}

/** Stored shape – secrets here are ciphertext. */
interface StoredIntegrations {
  /** The single SMTP setting from before senders; read as sender "smtp". */
  smtp?: { host?: string; port?: number; secure?: boolean; user?: string; pass?: string; from?: string; name?: string; replyTo?: string };
  mailSenders?: StoredMailSender[];
  mailRoles?: MailRoles;
  github?: { clientId?: string; clientSecret?: string };
  githubApp?: { appId?: string; slug?: string; privateKey?: string; webhookSecret?: string; htmlUrl?: string };
  slack?: { clientId?: string; clientSecret?: string; signingSecret?: string };
}

/** SMTP_URL as the same shape, so both sources resolve identically. */
function smtpFromEnv(): SmtpConfig | null {
  if (!env.smtpUrl) return null;
  try {
    const u = new URL(env.smtpUrl);
    return {
      host: u.hostname,
      port: Number(u.port) || (u.protocol === 'smtps:' ? 465 : 587),
      secure: u.protocol === 'smtps:',
      user: decodeURIComponent(u.username),
      pass: decodeURIComponent(u.password),
      from: env.smtpFrom,
    };
  } catch {
    return null;
  }
}

/** Decrypt a stored secret, tolerating values written before encryption existed. */
function readSecret(value: string | undefined): string {
  if (!value) return '';
  try {
    return decrypt(value);
  } catch {
    return value;
  }
}

/**
 * Every stored sender, with the legacy single SMTP setting folded in as
 * sender "smtp" until the first write moves it into the list.
 */
export function storedMailSenders(integrations: Record<string, unknown>): StoredMailSender[] {
  const stored = integrations as StoredIntegrations;
  const list = Array.isArray(stored.mailSenders) ? [...stored.mailSenders] : [];
  const legacy = stored.smtp;
  if (legacy?.host && !list.some((s) => s.id === LEGACY_SENDER_ID)) {
    list.unshift({
      id: LEGACY_SENDER_ID, name: legacy.name || 'Default', replyTo: legacy.replyTo,
      host: legacy.host, port: legacy.port, secure: legacy.secure, user: legacy.user, pass: legacy.pass, from: legacy.from,
    });
  }
  return list;
}

function toSender(s: StoredMailSender): MailSender {
  return {
    id: s.id,
    name: s.name,
    replyTo: s.replyTo?.trim() || null,
    source: 'db',
    smtp: {
      host: s.host,
      port: s.port ?? 587,
      secure: s.secure ?? false,
      user: s.user ?? '',
      pass: readSecret(s.pass),
      from: s.from || env.smtpFrom,
    },
  };
}

/**
 * The sender to use: an explicit id when it exists, otherwise the one holding
 * the role. An id that was deleted since (a queued reminder, say) falls back
 * to the role rather than failing the delivery.
 */
export function pickSender(cfg: RuntimeConfig, id?: string | null, role: 'system' | 'invoices' = 'system'): MailSender | null {
  const byId = (x: string | null | undefined) => (x ? cfg.senders.find((s) => s.id === x) ?? null : null);
  return byId(id) ?? byId(role === 'invoices' ? cfg.invoiceSenderId : cfg.systemSenderId);
}

let cache: { at: number; value: RuntimeConfig } | null = null;
const TTL_MS = 30_000;

async function resolve(): Promise<RuntimeConfig> {
  const { db } = getDb();
  const [ws] = await db.select().from(schema.workspaceSettings)
    .where(eq(schema.workspaceSettings.id, 'workspace'));
  const stored = ((ws?.integrations ?? {}) as StoredIntegrations);

  const envSmtp = smtpFromEnv();
  const senders: MailSender[] = storedMailSenders(stored as Record<string, unknown>).map(toSender);
  if (envSmtp) senders.push({ id: ENV_SENDER_ID, name: 'Server (.env)', replyTo: null, source: 'env', smtp: envSmtp });
  const has = (id: string | null | undefined): id is string => !!id && senders.some((s) => s.id === id);
  // Unset roles keep the old precedence: a sender set in the UI wins over the env.
  const systemSender = senders.find((s) => s.id === stored.mailRoles?.system) ?? senders[0] ?? null;
  const systemSenderId = systemSender?.id ?? null;
  const invoiceSenderId = has(stored.mailRoles?.invoices) ? stored.mailRoles!.invoices! : systemSenderId;

  const dbGithub = stored.github?.clientId
    ? { clientId: stored.github.clientId, clientSecret: readSecret(stored.github.clientSecret) }
    : null;
  const envGithub = env.githubOAuthClientId && env.githubOAuthClientSecret
    ? { clientId: env.githubOAuthClientId, clientSecret: env.githubOAuthClientSecret }
    : null;

  const dbGithubApp = stored.githubApp?.appId && stored.githubApp?.slug
    ? {
      appId: stored.githubApp.appId,
      slug: stored.githubApp.slug,
      privateKey: readSecret(stored.githubApp.privateKey),
      webhookSecret: readSecret(stored.githubApp.webhookSecret),
      htmlUrl: stored.githubApp.htmlUrl ?? `https://github.com/apps/${stored.githubApp.slug}`,
    }
    : null;

  const dbSlack = stored.slack?.clientId
    ? { clientId: stored.slack.clientId, clientSecret: readSecret(stored.slack.clientSecret), signingSecret: readSecret(stored.slack.signingSecret) }
    : null;
  const envSlack = env.slackClientId && env.slackClientSecret
    ? { clientId: env.slackClientId, clientSecret: env.slackClientSecret, signingSecret: env.slackSigningSecret }
    : null;

  return {
    smtp: systemSender?.smtp ?? null,
    smtpSource: systemSender?.source ?? 'none',
    senders,
    systemSenderId,
    invoiceSenderId,
    github: dbGithub ?? envGithub,
    githubSource: dbGithub ? 'db' : envGithub ? 'env' : 'none',
    githubApp: dbGithubApp,
    slack: dbSlack ?? envSlack,
    slackSource: dbSlack ? 'db' : envSlack ? 'env' : 'none',
  };
}

export async function runtimeConfig(): Promise<RuntimeConfig> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    cache = { at: Date.now(), value: await resolve() };
  }
  return cache.value;
}

/** Call after writing settings so the next read sees them immediately. */
export function invalidateRuntimeConfig(): void {
  cache = null;
}

/** Encrypt the secrets in an incoming patch before it is stored. */
export function encryptIntegrationSecrets(patch: {
  smtp?: { pass?: string } & Record<string, unknown>;
  github?: { clientSecret?: string } & Record<string, unknown>;
  githubApp?: { privateKey?: string; webhookSecret?: string } & Record<string, unknown>;
  slack?: { clientSecret?: string; signingSecret?: string } & Record<string, unknown>;
}): typeof patch {
  const out = { ...patch };
  if (out.smtp?.pass) out.smtp = { ...out.smtp, pass: encrypt(out.smtp.pass) };
  if (out.github?.clientSecret) out.github = { ...out.github, clientSecret: encrypt(out.github.clientSecret) };
  if (out.githubApp) {
    out.githubApp = { ...out.githubApp };
    if (out.githubApp.privateKey) out.githubApp.privateKey = encrypt(out.githubApp.privateKey);
    if (out.githubApp.webhookSecret) out.githubApp.webhookSecret = encrypt(out.githubApp.webhookSecret);
  }
  if (out.slack) {
    out.slack = { ...out.slack };
    if (out.slack.clientSecret) out.slack.clientSecret = encrypt(out.slack.clientSecret);
    if (out.slack.signingSecret) out.slack.signingSecret = encrypt(out.slack.signingSecret);
  }
  return out;
}

/**
 * Rewrite the sender list and roles in one go. The first write also moves the
 * legacy single SMTP setting into the list (as sender "smtp"), so from then on
 * there is one place senders live. `pass` values given here are plaintext and
 * get encrypted; an empty or missing one keeps the stored secret.
 */
export async function saveMailSenders(
  update: (senders: StoredMailSender[], roles: MailRoles) => { senders: StoredMailSender[]; roles: MailRoles },
): Promise<void> {
  const { db } = getDb();
  const [existing] = await db.select().from(schema.workspaceSettings)
    .where(eq(schema.workspaceSettings.id, 'workspace'));
  const current = ((existing?.integrations ?? {}) as Record<string, unknown>);
  const before = storedMailSenders(current);
  const next = update(before.map((s) => ({ ...s })), { ...((current as StoredIntegrations).mailRoles ?? {}) });
  const senders = next.senders.map((s) => {
    const prev = before.find((p) => p.id === s.id);
    const pass = s.pass === undefined || s.pass === '' ? prev?.pass : (s.pass === prev?.pass ? s.pass : encrypt(s.pass));
    const out: StoredMailSender = { ...s };
    if (pass) out.pass = pass; else delete out.pass;
    return out;
  });
  const merged: Record<string, unknown> = { ...current, mailSenders: senders, mailRoles: next.roles };
  delete merged.smtp;
  if (existing) {
    await db.update(schema.workspaceSettings).set({ integrations: merged })
      .where(eq(schema.workspaceSettings.id, 'workspace'));
  } else {
    await db.insert(schema.workspaceSettings).values({ id: 'workspace', integrations: merged });
  }
  invalidateRuntimeConfig();
}

/**
 * Store (or replace) the Slack app credentials, e.g. right after the Manifest
 * API created the app and handed them back. Secrets are encrypted before they
 * land.
 */
export async function storeSlackAppConfig(slack: SlackAppConfig): Promise<void> {
  const { db } = getDb();
  const [existing] = await db.select().from(schema.workspaceSettings)
    .where(eq(schema.workspaceSettings.id, 'workspace'));
  const current = ((existing?.integrations ?? {}) as Record<string, unknown>);
  const merged = {
    ...current,
    slack: {
      clientId: slack.clientId,
      clientSecret: encrypt(slack.clientSecret),
      signingSecret: encrypt(slack.signingSecret),
    },
  };
  if (existing) {
    await db.update(schema.workspaceSettings).set({ integrations: merged })
      .where(eq(schema.workspaceSettings.id, 'workspace'));
  } else {
    await db.insert(schema.workspaceSettings).values({ id: 'workspace', integrations: merged });
  }
  invalidateRuntimeConfig();
}

export async function storeGithubAppConfig(app: GithubAppConfig): Promise<void> {
  const { db } = getDb();
  const [existing] = await db.select().from(schema.workspaceSettings)
    .where(eq(schema.workspaceSettings.id, 'workspace'));
  const current = ((existing?.integrations ?? {}) as Record<string, unknown>);
  const merged = {
    ...current,
    githubApp: {
      appId: app.appId,
      slug: app.slug,
      privateKey: encrypt(app.privateKey),
      webhookSecret: encrypt(app.webhookSecret),
      htmlUrl: app.htmlUrl,
    },
  };
  if (existing) {
    await db.update(schema.workspaceSettings).set({ integrations: merged })
      .where(eq(schema.workspaceSettings.id, 'workspace'));
  } else {
    await db.insert(schema.workspaceSettings).values({ id: 'workspace', integrations: merged });
  }
  invalidateRuntimeConfig();
}
