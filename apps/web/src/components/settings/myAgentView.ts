/**
 * What Profile → My agent may show for its query. "You have no agent yet –
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
