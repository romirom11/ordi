/**
 * Integration settings that can be configured from the UI instead of the
 * server .env: SMTP, and the GitHub/Slack OAuth apps.
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
  smtp: SmtpConfig | null;
  /** Where the effective SMTP settings came from, for the settings screen. */
  smtpSource: 'db' | 'env' | 'none';
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
  smtp?: { host?: string; port?: number; secure?: boolean; user?: string; pass?: string; from?: string };
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

let cache: { at: number; value: RuntimeConfig } | null = null;
const TTL_MS = 30_000;

async function resolve(): Promise<RuntimeConfig> {
  const { db } = getDb();
  const [ws] = await db.select().from(schema.workspaceSettings)
    .where(eq(schema.workspaceSettings.id, 'workspace'));
  const stored = ((ws?.integrations ?? {}) as StoredIntegrations);

  const envSmtp = smtpFromEnv();
  const dbSmtp = stored.smtp?.host
    ? {
      host: stored.smtp.host,
      port: stored.smtp.port ?? 587,
      secure: stored.smtp.secure ?? false,
      user: stored.smtp.user ?? '',
      pass: readSecret(stored.smtp.pass),
      from: stored.smtp.from || env.smtpFrom,
    }
    : null;

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
    smtp: dbSmtp ?? envSmtp,
    smtpSource: dbSmtp ? 'db' : envSmtp ? 'env' : 'none',
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
 * Store (or replace) the GitHub App credentials, e.g. right after the manifest
 * conversion handed them to us. Secrets are encrypted before they land.
 */
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
