import { describe, expect, it } from 'vitest';
import { canonicalPath } from './router';

describe('canonicalPath', () => {
  it('sends the old addresses of the connections page to its new one', () => {
    expect(canonicalPath('/profile/mcp')).toBe('/profile/connections');
    expect(canonicalPath('/settings/mcp')).toBe('/profile/connections');
  });

  it('keeps the query', () => {
    expect(canonicalPath('/profile/mcp?x=1')).toBe('/profile/connections?x=1');
  });

  it('leaves every other address alone', () => {
    for (const p of ['/profile', '/profile/connections', '/settings/integrations', '/profile/mcpx', '/']) expect(canonicalPath(p)).toBe(p);
  });
});
