/**
 * Profile → MCP & API lists what may act as you or your agent. Every sign-in
 * through the browser is a connection of its own (a laptop and a server each
 * keep theirs), so the same client can appear several times: they are shown
 * as one entry per client, each connection with its own last use and Revoke.
 * Tokens made by hand are listed one by one, as they always were.
 */

export interface ConnectionLike {
  id: string;
  lastUsedAt?: string | null;
  createdAt?: string | null;
  revokedAt?: string | null;
}

export interface ConnectionGroup<T> {
  client: string;
  connections: T[];
}

function lastActivity(t: ConnectionLike): number {
  const at = t.lastUsedAt ?? t.createdAt;
  return at ? new Date(at).getTime() : 0;
}

/**
 * Splits a token list into OAuth connections grouped by client and the rest.
 * `clientOf` names the client a token connected, or null for one made some
 * other way. A revoked connection is left out: it is history, and the
 * clean-up revoking unused sign-ins would otherwise leave a struck-through
 * pile in their place. Groups are ordered by name, connections by most recent
 * use first.
 */
export function groupConnections<T extends ConnectionLike>(
  tokens: T[],
  clientOf: (t: T) => string | null | undefined,
): { groups: ConnectionGroup<T>[]; others: T[] } {
  const byClient = new Map<string, T[]>();
  const others: T[] = [];
  for (const tok of tokens) {
    const client = clientOf(tok);
    if (!client) { others.push(tok); continue; }
    if (tok.revokedAt) continue;
    const list = byClient.get(client);
    if (list) list.push(tok);
    else byClient.set(client, [tok]);
  }
  const groups = [...byClient.entries()]
    .map(([client, connections]) => ({ client, connections: [...connections].sort((a, b) => lastActivity(b) - lastActivity(a)) }))
    .sort((a, b) => a.client.localeCompare(b.client));
  return { groups, others };
}

/**
 * The dictionary key for "N connections" in a locale: Intl's plural category
 * (English one/other; Ukrainian one/few/many) picks the form.
 */
export function connectionsKey(n: number, locale: string): string {
  return `oauth.connections.${new Intl.PluralRules(locale).select(n)}`;
}
