/**
 * Profile → MCP & API → Connections: one list of every client that can act
 * for the person – those connected as them and those connected as their own
 * agent, whether signed in through the browser or given a token by hand.
 * Every sign-in is a connection of its own (a laptop and a server each keep
 * theirs), so one client can appear several times: connections are grouped
 * by client and by whom they act as, each with its own last use and its own
 * Disconnect. Tokens for scripts are not connections and are kept apart.
 */

export type ActsAs = 'agent' | 'you';

/** A token from GET /auth/tokens: the person's own. */
export interface OwnToken {
  id: string;
  name: string;
  prefix?: string | null;
  scopes?: string[] | null;
  readOnly?: boolean;
  lastUsedAt?: string | null;
  createdAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  /** The client it connects; null for a token for scripts. */
  client?: string | null;
  /** Signed in through the browser rather than given a token by hand. */
  oauth?: boolean;
}

/** A token of the person's own agent, from GET /my-agent: named after its client. */
export interface AgentToken {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt?: string | null;
  oauth?: boolean;
}

export interface Connection {
  id: string;
  actsAs: ActsAs;
  /** How it connected: through a browser sign-in, or with a token made by hand. */
  via: 'signIn' | 'token';
  prefix: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface ConnectionGroup {
  key: string;
  client: string;
  actsAs: ActsAs;
  connections: Connection[];
}

function live(t: { revokedAt?: string | null; expiresAt?: string | null }, now: number): boolean {
  return !t.revokedAt && !(t.expiresAt && new Date(t.expiresAt).getTime() <= now);
}

function lastActivity(c: Connection): number {
  const at = c.lastUsedAt ?? c.createdAt;
  return at ? new Date(at).getTime() : 0;
}

/**
 * The person's connections, grouped by client and by whom they act as.
 * Revoked or expired ones are history and left out. Groups are ordered by
 * client name, the agent's before the person's own for the same client;
 * connections within a group by most recent use first.
 */
export function buildConnections(own: OwnToken[], agentTokens: AgentToken[], now = Date.now()): ConnectionGroup[] {
  const groups = new Map<string, ConnectionGroup>();
  const add = (client: string, conn: Connection) => {
    const key = `${conn.actsAs}:${client}`;
    const group = groups.get(key) ?? { key, client, actsAs: conn.actsAs, connections: [] };
    group.connections.push(conn);
    groups.set(key, group);
  };
  for (const t of own) {
    if (!t.client || !live(t, now)) continue;
    add(t.client, {
      id: t.id, actsAs: 'you', via: t.oauth ? 'signIn' : 'token', prefix: t.prefix ?? null,
      createdAt: t.createdAt ?? null, lastUsedAt: t.lastUsedAt ?? null, expiresAt: t.expiresAt ?? null,
    });
  }
  for (const t of agentTokens) {
    if (!live(t, now)) continue;
    add(t.name, {
      id: t.id, actsAs: 'agent', via: t.oauth ? 'signIn' : 'token', prefix: t.prefix,
      createdAt: t.createdAt ?? null, lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt,
    });
  }
  return [...groups.values()]
    .map((g) => ({ ...g, connections: [...g.connections].sort((a, b) => lastActivity(b) - lastActivity(a)) }))
    .sort((a, b) => a.client.localeCompare(b.client) || (a.actsAs === b.actsAs ? 0 : a.actsAs === 'agent' ? -1 : 1));
}

/** Tokens for scripts: made by hand, connecting no client. Revoked ones apart, newest first. */
export function scriptTokens(own: OwnToken[], now = Date.now()): { active: OwnToken[]; revoked: OwnToken[] } {
  const newest = (a: OwnToken, b: OwnToken) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  const scripts = own.filter((t) => !t.client);
  return {
    active: scripts.filter((t) => live(t, now)).sort(newest),
    revoked: scripts.filter((t) => !live(t, now)).sort(newest),
  };
}

/**
 * The dictionary key for "N connections" in a locale: Intl's plural category
 * (English one/other; Ukrainian one/few/many) picks the form.
 */
export function connectionsKey(n: number, locale: string): string {
  return `oauth.connections.${new Intl.PluralRules(locale).select(n)}`;
}

/** A token just issued from "No browser? Connect with a token", shown once. */
export interface IssuedToken {
  id: string;
  token: string;
  /** The client picked when it was made, the name it got, and whom it acts as. */
  client: string;
  clientName: string;
  actsAs: ActsAs;
}

/**
 * Whether the token just issued may still be shown and put into the configs
 * on screen. Only for exactly what it was made for – the same client, name
 * and identity, so a token acting as the person never lands in a config the
 * page says is for their agent – and only while it still exists: once it is
 * disconnected, or the agent switched off, its secret leaves the screen.
 */
export function showIssued(
  issued: IssuedToken | null,
  current: { client: string; clientName: string; actsAs: ActsAs },
  own: OwnToken[] | undefined,
  agentTokens: AgentToken[] | undefined,
  now = Date.now(),
): issued is IssuedToken {
  if (!issued) return false;
  if (issued.client !== current.client || issued.clientName !== current.clientName || issued.actsAs !== current.actsAs) return false;
  // Not refetched yet after issuing: trust it until the lists say otherwise.
  const list: { id: string; revokedAt?: string | null; expiresAt?: string | null }[] | undefined = issued.actsAs === 'you' ? own : agentTokens;
  if (!list) return true;
  const row = list.find((t) => t.id === issued.id);
  return !!row && live(row, now);
}
