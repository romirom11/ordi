/**
 * Settings → Agents shows every agent of the workspace in one list: those
 * ordi runs itself and those that connect from outside under their own name
 * (team bots). People's own agents are not here – they live in each person's
 * Profile → MCP & API.
 */

export type AgentKind = 'ordi' | 'outside';

export type AgentEntry<O, X> =
  | { kind: 'ordi'; id: string; name: string; agent: O }
  | { kind: 'outside'; id: string; name: string; agent: X };

/** Both kinds in one list, by name; a name both kinds share keeps ordi's first. */
export function mergeAgents<O extends { id: string; name: string }, X extends { id: string; name: string }>(
  ordi: O[], outside: X[], locale?: string,
): AgentEntry<O, X>[] {
  const entries: AgentEntry<O, X>[] = [
    ...ordi.map((a) => ({ kind: 'ordi' as const, id: a.id, name: a.name, agent: a })),
    ...outside.map((a) => ({ kind: 'outside' as const, id: a.id, name: a.name, agent: a })),
  ];
  return entries.sort((a, b) => a.name.localeCompare(b.name, locale, { sensitivity: 'base' }) || (a.kind === b.kind ? 0 : a.kind === 'ordi' ? -1 : 1));
}

/**
 * Whether nothing can run the agents ordi runs: no worker has reported in
 * as online. Off by design when a separate worker container is online, so
 * the api's own worker being off is not, alone, a problem.
 */
export function noWorkerOnline(overview: { workerEnabled: boolean; workers: { online: boolean }[] } | undefined): boolean {
  return !!overview && !overview.workerEnabled && !overview.workers.some((w) => w.online);
}
