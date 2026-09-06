/**
 * MCP OAuth 2.1 client for connectors (plan 2026-09-05-001, R38-R39). ordi
 * is the OAuth client: it discovers the authorization server, registers
 * dynamically (or uses a pre-registered client), sends the admin to consent
 * with PKCE, exchanges the code and refreshes tokens. The MCP SDK's
 * `OAuthClientProvider` contract drives all of it; this module is the
 * persistence behind it.
 */
import { getDb, schema, eq } from '@ordi/db';
import { auth, UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { Actor } from '../../context';
import { env } from '../../env';
import { err } from '../../lib/errors';
import { encrypt, decrypt, generateToken } from '../../lib/crypto';
import { writeActivity } from '../../core/activity';
import { logger } from '../../lib/logger';

const { mcpConnectors, mcpConnectorOauth } = schema;

type OauthRow = typeof mcpConnectorOauth.$inferSelect;

/** Where providers send the admin back; must be reachable on the public app origin. */
export function connectorCallbackUrl(): string {
  return `${env.appUrl.replace(/\/$/, '')}/api/v1/mcp-connectors/oauth/callback`;
}

/** An in-flight consent is abandoned after this long. */
const PENDING_TTL_MS = 15 * 60_000;

function parseJson<T>(blob: string | null): T | undefined {
  if (!blob) return undefined;
  try { return JSON.parse(decrypt(blob)) as T; } catch { return undefined; }
}

export function hasOAuthTokens(row: OauthRow): boolean {
  return Boolean(parseJson<OAuthTokens>(row.tokens)?.access_token);
}

async function ensureRow(connectorId: string): Promise<OauthRow> {
  const { db } = getDb();
  const [row] = await db.select().from(mcpConnectorOauth).where(eq(mcpConnectorOauth.connectorId, connectorId));
  if (row) return row;
  await db.insert(mcpConnectorOauth).values({ connectorId }).onConflictDoNothing();
  const [created] = await db.select().from(mcpConnectorOauth).where(eq(mcpConnectorOauth.connectorId, connectorId));
  return created!;
}

/** A provider without dynamic registration: the admin supplied client id and secret. */
export async function storePreregisteredClient(connectorId: string, clientId: string, clientSecret: string | null): Promise<void> {
  const { db } = getDb();
  await ensureRow(connectorId);
  const info: OAuthClientInformationMixed = clientSecret ? { client_id: clientId, client_secret: clientSecret } : { client_id: clientId };
  await db.update(mcpConnectorOauth).set({ clientInfo: encrypt(JSON.stringify(info)) }).where(eq(mcpConnectorOauth.connectorId, connectorId));
}

/**
 * The SDK contract, backed by mcp_connector_oauth. Authorization redirects are
 * captured rather than followed: the route returns the URL to the browser.
 */
export class ConnectorOAuthProvider implements OAuthClientProvider {
  /** Set by `redirectToAuthorization` during `startAuthorization`. */
  pendingAuthorizationUrl: URL | null = null;

  constructor(private readonly connectorId: string, private readonly serverUrl: string) {}

  get redirectUrl(): string {
    return connectorCallbackUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'ordi',
      client_uri: env.appUrl,
      redirect_uris: [connectorCallbackUrl()],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  async state(): Promise<string> {
    const state = generateToken(24);
    const { db } = getDb();
    await ensureRow(this.connectorId);
    await db.update(mcpConnectorOauth).set({ pendingState: state, pendingStartedAt: new Date() })
      .where(eq(mcpConnectorOauth.connectorId, this.connectorId));
    return state;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const row = await ensureRow(this.connectorId);
    return parseJson<OAuthClientInformationMixed>(row.clientInfo);
  }

  async saveClientInformation(info: OAuthClientInformationMixed): Promise<void> {
    const { db } = getDb();
    await ensureRow(this.connectorId);
    await db.update(mcpConnectorOauth).set({ clientInfo: encrypt(JSON.stringify(info)), authorizationServer: this.serverUrl })
      .where(eq(mcpConnectorOauth.connectorId, this.connectorId));
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const row = await ensureRow(this.connectorId);
    return parseJson<OAuthTokens>(row.tokens);
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const { db } = getDb();
    await ensureRow(this.connectorId);
    const accessExpiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
    await db.update(mcpConnectorOauth).set({ tokens: encrypt(JSON.stringify(tokens)), accessExpiresAt })
      .where(eq(mcpConnectorOauth.connectorId, this.connectorId));
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.pendingAuthorizationUrl = authorizationUrl;
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    const { db } = getDb();
    await ensureRow(this.connectorId);
    await db.update(mcpConnectorOauth).set({ pendingVerifier: encrypt(codeVerifier) })
      .where(eq(mcpConnectorOauth.connectorId, this.connectorId));
  }

  async codeVerifier(): Promise<string> {
    const row = await ensureRow(this.connectorId);
    if (!row.pendingVerifier) throw new Error('No authorization in progress');
    return decrypt(row.pendingVerifier);
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const { db } = getDb();
    const patch: Partial<typeof mcpConnectorOauth.$inferInsert> = {};
    if (scope === 'all' || scope === 'tokens') { patch.tokens = null; patch.accessExpiresAt = null; }
    if (scope === 'all' || scope === 'client') patch.clientInfo = null;
    if (scope === 'all' || scope === 'verifier') { patch.pendingVerifier = null; patch.pendingState = null; }
    if (Object.keys(patch).length) {
      await db.update(mcpConnectorOauth).set(patch).where(eq(mcpConnectorOauth.connectorId, this.connectorId));
    }
  }
}

/**
 * Begin (or complete, when tokens already exist) the consent flow for a
 * connector. Returns the URL the browser must open, or null when the
 * connector is already authorized.
 */
export async function startConnectorOAuth(actor: Actor, connectorId: string): Promise<{ authorizationUrl: string | null }> {
  const { db } = getDb();
  const [connector] = await db.select().from(mcpConnectors).where(eq(mcpConnectors.id, connectorId));
  if (!connector) throw err.notFound('Connector not found');
  if (connector.authMode !== 'oauth' || !connector.url) throw err.domain('This connector does not use OAuth');
  const provider = new ConnectorOAuthProvider(connectorId, connector.url);
  // A stale in-flight consent must not block a fresh start.
  await provider.invalidateCredentials('verifier');
  let result: 'AUTHORIZED' | 'REDIRECT';
  try {
    result = await auth(provider, { serverUrl: connector.url });
  } catch (e) {
    logger.warn({ connector: connector.slug, err: (e as Error).message }, 'connector oauth start failed');
    throw err.domain(`Could not start authorization: ${(e as Error).message}`);
  }
  if (result === 'AUTHORIZED') {
    await db.update(mcpConnectors).set({ status: 'active', lastError: null }).where(eq(mcpConnectors.id, connectorId));
    return { authorizationUrl: null };
  }
  const url = provider.pendingAuthorizationUrl;
  if (!url) throw err.domain('The authorization server did not produce a consent url');
  await writeActivity(db, {
    entityType: 'mcp_connector', entityId: connectorId, action: 'authorization_started',
    actorId: actor.userId, actorType: actor.actorType, diff: { authorizationServer: url.origin },
  });
  return { authorizationUrl: url.toString() };
}

/** The browser comes back with code + state; exchange it and record who authorized. */
export async function completeConnectorOAuth(actor: Actor, code: string, state: string): Promise<{ connectorId: string; slug: string }> {
  const { db } = getDb();
  const [oauth] = await db.select().from(mcpConnectorOauth).where(eq(mcpConnectorOauth.pendingState, state));
  if (!oauth) throw err.notFound('Unknown or expired authorization state');
  if (oauth.pendingStartedAt && Date.now() - oauth.pendingStartedAt.getTime() > PENDING_TTL_MS) {
    await db.update(mcpConnectorOauth).set({ pendingState: null, pendingVerifier: null }).where(eq(mcpConnectorOauth.connectorId, oauth.connectorId));
    throw err.domain('The authorization took too long; start again');
  }
  const [connector] = await db.select().from(mcpConnectors).where(eq(mcpConnectors.id, oauth.connectorId));
  if (!connector?.url) throw err.notFound('Connector not found');
  const provider = new ConnectorOAuthProvider(connector.id, connector.url);
  try {
    const result = await auth(provider, { serverUrl: connector.url, authorizationCode: code });
    if (result !== 'AUTHORIZED') throw new Error('Token exchange did not complete');
  } catch (e) {
    await db.update(mcpConnectors).set({ lastError: (e as Error).message }).where(eq(mcpConnectors.id, connector.id));
    throw err.domain(`Authorization failed: ${(e as Error).message}`);
  }
  await db.update(mcpConnectorOauth).set({
    pendingState: null, pendingVerifier: null, pendingStartedAt: null,
    authorizedBy: actor.userId, authorizedAt: new Date(),
  }).where(eq(mcpConnectorOauth.connectorId, connector.id));
  await db.update(mcpConnectors).set({ status: 'active', lastError: null }).where(eq(mcpConnectors.id, connector.id));
  await writeActivity(db, {
    entityType: 'mcp_connector', entityId: connector.id, action: 'authorized',
    actorId: actor.userId, actorType: actor.actorType,
  });
  return { connectorId: connector.id, slug: connector.slug };
}

/** Forget tokens and client registration; the connector goes back to needs_auth. */
export async function revokeConnectorOAuth(actor: Actor, connectorId: string): Promise<void> {
  const { db } = getDb();
  const provider = new ConnectorOAuthProvider(connectorId, '');
  await provider.invalidateCredentials('tokens');
  await db.update(mcpConnectorOauth).set({ authorizedBy: null, authorizedAt: null }).where(eq(mcpConnectorOauth.connectorId, connectorId));
  await db.update(mcpConnectors).set({ status: 'needs_auth' }).where(eq(mcpConnectors.id, connectorId));
  await writeActivity(db, {
    entityType: 'mcp_connector', entityId: connectorId, action: 'authorization_revoked',
    actorId: actor.userId, actorType: actor.actorType,
  });
}

export { UnauthorizedError };
