/**
 * Profile → Connections → Connected clients: one list of every client that
 * can act for the person – those connected as them and those connected as
 * their own agent, whether signed in through the browser or given a token by
 * hand. Every sign-in is a connection of its own (a laptop and a server each
 * keep theirs), so one client can appear several times: each connection is a
 * row of its own, with its own last use and its own Disconnect, and repeats
 * of one client are told apart by a short suffix. Tokens for scripts are not
 * connections and are kept apart.
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

/** One line of Connected clients: a single connection. */
export interface ConnectionRow {
  client: string;
  actsAs: ActsAs;
  /**
   * Set only when the same client is connected more than once as the same
   * identity: the end of the token's prefix, so a laptop and a server can be
   * told apart without a date in front of everything.
   */
  suffix: string | null;
  connection: Connection;
}

const PREFIX_HEAD = /^ordi_/;
const SUFFIX_MIN = 4;

/**
 * The shortest tails of the prefixes, at least four characters, that tell
 * every connection of one group apart. Tokens are random, so four nearly
 * always do; two that happen to end alike get as many more as it takes.
 */
function suffixes(prefixes: (string | null)[]): (string | null)[] {
  const bodies = prefixes.map((p) => (p ? p.replace(PREFIX_HEAD, '') : null));
  const longest = Math.max(SUFFIX_MIN, ...bodies.map((b) => b?.length ?? 0));
  for (let n = SUFFIX_MIN; n <= longest; n++) {
    const tails = bodies.map((b) => (b ? b.slice(-n) : null));
    const known = tails.filter((x): x is string => x !== null);
    if (new Set(known).size === known.length) return tails;
  }
  return bodies;
}

/** The connections flattened into rows, in the groups' order, each a line of its own. */
export function connectionRows(groups: ConnectionGroup[]): ConnectionRow[] {
  return groups.flatMap((g) => {
    const tails = g.connections.length > 1 ? suffixes(g.connections.map((c) => c.prefix)) : g.connections.map(() => null);
    return g.connections.map((connection, i) => ({ client: g.client, actsAs: g.actsAs, suffix: tails[i] ?? null, connection }));
  });
}

/**
 * What a row says after the client's name, and its tooltip. The line keeps
 * to what tells one connection from another and what needs doing: when it
 * was last used, and when it runs out. How and when it was connected – rarely
 * the question – is left to the tooltip, with the full prefix.
 */
export function connectionLine(
  row: ConnectionRow,
  t: (key: string) => string,
  fmt: { date: (iso: string) => string; relative: (iso: string) => string },
): { meta: string[]; tooltip: string } {
  const c = row.connection;
  const meta = [
    c.lastUsedAt ? t('mcp.lastUsed').replace('{when}', fmt.relative(c.lastUsedAt)) : t('mcp.neverUsed'),
    ...(c.expiresAt ? [t('mcp.until').replace('{date}', fmt.date(c.expiresAt))] : []),
  ];
  const tooltip = [
    c.createdAt ? t(c.via === 'signIn' ? 'mcp.signedIn' : 'mcp.tokenMade').replace('{date}', fmt.date(c.createdAt)) : null,
    c.prefix ? `${c.prefix}…` : null,
  ].filter(Boolean).join(' · ');
  return { meta, tooltip };
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
 * The dictionary key for a count in a locale, e.g. "N permissions": Intl's
 * plural category (English one/other; Ukrainian one/few/many) picks the form.
 */
export function pluralKey(base: string, n: number, locale: string): string {
  return `${base}.${new Intl.PluralRules(locale).select(n)}`;
}

/**
 * What Connections may show while its two lists come in: rows from a list
 * that has loaded show at once, whichever other list failed; each failed list
 * is named so it alone can be retried; "nothing connected" is said only once
 * both have answered.
 */
export function connectionsView(
  lists: { own: ListState; agent: ListState },
  count: number,
): { skeleton: boolean; failed: ('own' | 'agent')[]; empty: boolean } {
  const all = [lists.own, lists.agent];
  const failed = (['own', 'agent'] as const).filter((k) => lists[k].isError && lists[k].data === undefined);
  const pending = all.some((q) => q.isLoading);
  return { skeleton: count === 0 && pending && failed.length === 0, failed, empty: count === 0 && !pending && failed.length === 0 };
}

interface ListState { isLoading: boolean; isError: boolean; data: unknown }

/** A token just issued from "No browser? Connect with a token", shown once. */
export interface IssuedToken {
  id: string;
  token: string;
  /** When the create call answered: a list fetched before then cannot know it yet. */
  at: number;
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
  lists: { own?: OwnToken[]; ownAt?: number; agent?: AgentToken[]; agentAt?: number },
  now = Date.now(),
): issued is IssuedToken {
  if (!issued) return false;
  if (issued.client !== current.client || issued.clientName !== current.clientName || issued.actsAs !== current.actsAs) return false;
  const [list, fetchedAt]: [{ id: string; revokedAt?: string | null; expiresAt?: string | null }[] | undefined, number | undefined] =
    issued.actsAs === 'you' ? [lists.own, lists.ownAt] : [lists.agent, lists.agentAt];
  const row = list?.find((t) => t.id === issued.id);
  if (row) return live(row, now);
  // Not in a list fetched before the token existed: that list is stale, so
  // the create answer is trusted and the setup shows at once. Missing from a
  // list fetched since, it was disconnected or the agent switched off.
  return !list || (fetchedAt ?? 0) < issued.at;
}
