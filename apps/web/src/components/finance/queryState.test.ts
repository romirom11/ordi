/**
 * The regression: a Finance list whose first request failed rendered "No
 * invoices yet" and the dashboard rendered 0 outstanding – a failure dressed
 * up as a fact about the business.
 */
import { describe, expect, it } from 'vitest';
import { queryView } from './queryState';

const rowsEmpty = (d: unknown) => ((d as { data: unknown[] }).data.length === 0);

describe('queryView', () => {
  it('reports a failed first load as an error, never as an empty list', () => {
    expect(queryView({ isError: true, data: undefined }, rowsEmpty)).toEqual({ view: 'error', stale: false });
  });

  it('is loading until the first answer arrives', () => {
    expect(queryView({ isError: false, data: undefined }, rowsEmpty)).toEqual({ view: 'loading', stale: false });
  });

  it('calls a successful empty answer empty', () => {
    expect(queryView({ isError: false, data: { data: [] } }, rowsEmpty)).toEqual({ view: 'empty', stale: false });
  });

  it('keeps cached rows after a failed refetch and marks them stale', () => {
    expect(queryView({ isError: true, data: { data: [{ id: 'a' }] } }, rowsEmpty)).toEqual({ view: 'ready', stale: true });
  });

  it('marks a cached empty answer stale too – the emptiness may be out of date', () => {
    expect(queryView({ isError: true, data: { data: [] } }, rowsEmpty)).toEqual({ view: 'empty', stale: true });
  });

  it('treats a summary without an emptiness rule as ready once it has data', () => {
    expect(queryView({ isError: false, data: { receivables: {} } })).toEqual({ view: 'ready', stale: false });
  });
});
