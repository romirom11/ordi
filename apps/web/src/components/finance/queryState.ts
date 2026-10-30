/**
 * What a Finance list or summary may claim about its query.
 *
 * "No invoices" and "nothing overdue" are business statements. They used to be
 * what a failed first load rendered too, because the views read
 * `data ?? []` and showed the empty state once loading stopped. A query that
 * failed with nothing cached is unknown, not empty; one that failed on a
 * refetch keeps showing the last good data, marked as not up to date.
 */
export type QueryView = 'loading' | 'error' | 'empty' | 'ready';

export interface QueryLike {
  isError: boolean;
  data: unknown;
}

export function queryView(q: QueryLike, isEmpty: (data: unknown) => boolean = () => false): { view: QueryView; stale: boolean } {
  if (q.data === undefined) {
    if (q.isError) return { view: 'error', stale: false };
    return { view: 'loading', stale: false };
  }
  // Cached data outlives a failed refetch: keep it, but say it is old.
  const stale = q.isError;
  return { view: isEmpty(q.data) ? 'empty' : 'ready', stale };
}
