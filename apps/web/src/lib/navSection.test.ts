/**
 * The regression: opening a company, lead or deal left no sidebar item
 * selected (and so no aria-current), because their URLs do not start with
 * /crm. Entry point does not matter – list, search and deep link all land on
 * the same URL – so the URL alone must decide.
 */
import { describe, expect, it } from 'vitest';
import { isNavActive } from './navSection';

describe('isNavActive', () => {
  it('keeps CRM selected on every CRM route, list or detail', () => {
    for (const path of ['/crm', '/crm/pipeline', '/companies', '/companies/c1', '/leads/l1', '/deals/d1', '/deals/d1?tab=notes']) {
      expect(isNavActive('/crm', path), path).toBe(true);
    }
  });

  it('does not light up another item on a CRM detail page', () => {
    expect(isNavActive('/projects', '/deals/d1')).toBe(false);
    expect(isNavActive('/', '/companies/c1')).toBe(false);
  });

  it('matches the dashboard only on the root', () => {
    expect(isNavActive('/', '/')).toBe(true);
    expect(isNavActive('/', '/projects')).toBe(false);
  });

  it('owns nested routes of a destination but not look-alike prefixes', () => {
    expect(isNavActive('/projects', '/projects/p1/tasks/t1')).toBe(true);
    expect(isNavActive('/finance', '/finance/invoices/i1')).toBe(true);
    expect(isNavActive('/settings', '/settings/users')).toBe(true);
    expect(isNavActive('/people', '/peoplex')).toBe(false);
  });
});
