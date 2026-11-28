/**
 * What Profile → Connections → Your agent may show for its query. "You have no agent yet –
 * create one" is a statement about the account: a first load that failed is
 * not that, and offering creation then only ends in "You already have an
 * agent" for someone who has one.
 */
import { queryView, type QueryLike } from '../finance/queryState';

export type MyAgentView = 'loading' | 'error' | 'none' | 'ready';

export function myAgentView(q: QueryLike): MyAgentView {
  const { view } = queryView(q, (agent) => agent === null);
  return view === 'empty' ? 'none' : view;
}

/**
 * What Save (or Enter) does with the name being edited: a blank name is not
 * a name, so editing stays open; the same name has nothing to save, so it
 * just closes; anything else is saved, trimmed.
 */
export type RenameOutcome = { kind: 'save'; name: string } | { kind: 'close' } | { kind: 'invalid' };

export function renameOutcome(draft: string, current: string): RenameOutcome {
  const next = draft.trim();
  if (!next) return { kind: 'invalid' };
  return next === current ? { kind: 'close' } : { kind: 'save', name: next };
}
