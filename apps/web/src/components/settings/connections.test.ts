import { describe, it, expect } from 'vitest';
import { buildConnections, connectionsKey, connectionsView, pluralKey, scriptTokens, showIssued, type AgentToken, type OwnToken } from './connections';

const NOW = new Date('2026-11-28T12:00:00Z').getTime();

const own: OwnToken[] = [
  // Signed in as the person from two machines, and one left unused and revoked by the clean-up.
  { id: 'laptop', name: 'Claude (OAuth)', client: 'Claude', oauth: true, lastUsedAt: '2026-11-20T10:00:00Z', createdAt: '2026-11-01T00:00:00Z' },
  { id: 'server', name: 'Claude (OAuth)', client: 'Claude', oauth: true, lastUsedAt: '2026-11-27T10:00:00Z', createdAt: '2026-11-02T00:00:00Z' },
  { id: 'gone', name: 'Claude (OAuth)', client: 'Claude', oauth: true, createdAt: '2026-10-01T00:00:00Z', revokedAt: '2026-10-02T00:00:00Z' },
  // Given a token by hand, as the person; one of them has run out.
  { id: 'zed', name: 'Zed', client: 'Zed', oauth: false, createdAt: '2026-11-10T00:00:00Z', expiresAt: '2027-02-10T00:00:00Z' },
  { id: 'expired', name: 'Cursor', client: 'Cursor', oauth: false, createdAt: '2026-08-01T00:00:00Z', expiresAt: '2026-11-01T00:00:00Z' },
  // Tokens for scripts.
  { id: 'ci', name: 'CI deploy', client: null, createdAt: '2026-06-01T00:00:00Z' },
  { id: 'old-ci', name: 'Old CI', client: null, createdAt: '2026-01-01T00:00:00Z', revokedAt: '2026-02-01T00:00:00Z' },
];

const agent: AgentToken[] = [
  { id: 'agent-claude', name: 'Claude', prefix: 'ordi_a', oauth: true, lastUsedAt: null, createdAt: '2026-11-25T00:00:00Z', expiresAt: '2027-02-23T00:00:00Z' },
  { id: 'agent-codex', name: 'Codex', prefix: 'ordi_b', oauth: false, lastUsedAt: '2026-11-28T09:00:00Z', expiresAt: null },
];

describe('buildConnections', () => {
  it('puts the agent’s clients and the person’s own in one list, each saying whom it acts as', () => {
    const groups = buildConnections(own, agent, NOW);
    expect(groups.map((g) => [g.client, g.actsAs])).toEqual([
      ['Claude', 'agent'], ['Claude', 'you'], ['Codex', 'agent'], ['Zed', 'you'],
    ]);
  });

  it('keeps each sign-in of a client, most recent use first, and leaves out revoked and expired ones', () => {
    const claude = buildConnections(own, agent, NOW).find((g) => g.key === 'you:Claude')!;
    expect(claude.connections.map((c) => c.id)).toEqual(['server', 'laptop']);
    expect(claude.connections.every((c) => c.via === 'signIn')).toBe(true);
    const ids = buildConnections(own, agent, NOW).flatMap((g) => g.connections.map((c) => c.id));
    expect(ids).not.toContain('gone');
    expect(ids).not.toContain('expired');
  });

  it('tells a token made by hand from a sign-in, and carries its expiry', () => {
    const zed = buildConnections(own, agent, NOW).find((g) => g.client === 'Zed')!.connections[0]!;
    expect(zed).toMatchObject({ via: 'token', actsAs: 'you', expiresAt: '2027-02-10T00:00:00Z' });
    const codex = buildConnections(own, agent, NOW).find((g) => g.client === 'Codex')!.connections[0]!;
    expect(codex).toMatchObject({ via: 'token', actsAs: 'agent', expiresAt: null });
  });

  it('never lists a token for scripts', () => {
    const ids = buildConnections(own, [], NOW).flatMap((g) => g.connections.map((c) => c.id));
    expect(ids).not.toContain('ci');
  });

  it('is empty with nothing connected', () => {
    expect(buildConnections([own[5]!], [], NOW)).toEqual([]);
  });
});

describe('scriptTokens', () => {
  it('holds only tokens for scripts, revoked ones apart', () => {
    const { active, revoked } = scriptTokens(own, NOW);
    expect(active.map((t) => t.id)).toEqual(['ci']);
    expect(revoked.map((t) => t.id)).toEqual(['old-ci']);
  });
});

describe('connectionsKey', () => {
  it('picks the plural form for the locale', () => {
    expect([1, 2, 21].map((n) => connectionsKey(n, 'en'))).toEqual(['oauth.connections.one', 'oauth.connections.other', 'oauth.connections.other']);
    expect([1, 2, 5, 11, 21, 22].map((n) => connectionsKey(n, 'uk'))).toEqual([
      'oauth.connections.one', 'oauth.connections.few', 'oauth.connections.many',
      'oauth.connections.many', 'oauth.connections.one', 'oauth.connections.few',
    ]);
  });
});

describe('showIssued', () => {
  const MADE = NOW - 1000;
  const issued = { id: 'zed', token: 'ordi_secret', at: MADE, client: 'other', clientName: 'Zed', actsAs: 'you' as const };
  const current = { client: 'other', clientName: 'Zed', actsAs: 'you' as const };
  const fresh = { own, ownAt: NOW, agent, agentAt: NOW };

  it('shows the token only for the client, name and identity it was made for', () => {
    expect(showIssued(issued, current, fresh, NOW)).toBe(true);
    expect(showIssued(issued, { ...current, actsAs: 'agent' }, fresh, NOW)).toBe(false);
    expect(showIssued(issued, { ...current, clientName: 'Zed 2' }, fresh, NOW)).toBe(false);
    expect(showIssued(issued, { ...current, client: 'cursor' }, fresh, NOW)).toBe(false);
  });

  it('takes the secret off screen once it is disconnected or the agent is switched off', () => {
    const revoked = own.map((t) => (t.id === 'zed' ? { ...t, revokedAt: '2026-11-28T11:00:00Z' } : t));
    expect(showIssued(issued, current, { ...fresh, own: revoked }, NOW)).toBe(false);
    const forAgent = { ...issued, id: 'agent-codex', actsAs: 'agent' as const };
    expect(showIssued(forAgent, { ...current, actsAs: 'agent' }, fresh, NOW)).toBe(true);
    expect(showIssued(forAgent, { ...current, actsAs: 'agent' }, { ...fresh, agent: [] }, NOW)).toBe(false);
  });

  it('shows a token just made at once, before the lists have caught up with it', () => {
    expect(showIssued(issued, current, {}, NOW)).toBe(true);
    // Cached lists from before the token existed do not hide it…
    const before = { own: own.filter((t) => t.id !== 'zed'), ownAt: MADE - 5000 };
    expect(showIssued(issued, current, before, NOW)).toBe(true);
    // …but one fetched since that still lacks it does.
    expect(showIssued(issued, current, { ...before, ownAt: NOW }, NOW)).toBe(false);
  });
});

describe('connectionsView', () => {
  const ok = { isLoading: false, isError: false, data: [] };
  const down = { isLoading: false, isError: true, data: undefined };
  const loading = { isLoading: true, isError: false, data: undefined };

  it('keeps the rows of the list that loaded and names the one that failed', () => {
    expect(connectionsView({ own: ok, agent: down }, 2)).toEqual({ skeleton: false, failed: ['agent'], empty: false });
    expect(connectionsView({ own: down, agent: ok }, 1)).toEqual({ skeleton: false, failed: ['own'], empty: false });
  });

  it('says nothing is connected only once both lists have answered', () => {
    expect(connectionsView({ own: ok, agent: loading }, 0)).toEqual({ skeleton: true, failed: [], empty: false });
    expect(connectionsView({ own: ok, agent: ok }, 0)).toEqual({ skeleton: false, failed: [], empty: true });
    expect(connectionsView({ own: ok, agent: down }, 0)).toEqual({ skeleton: false, failed: ['agent'], empty: false });
  });
});

describe('pluralKey', () => {
  it('picks the plural form of any count for the locale', () => {
    expect([1, 3].map((n) => pluralKey('mcp.permissions', n, 'en'))).toEqual(['mcp.permissions.one', 'mcp.permissions.other']);
    expect([1, 3, 5].map((n) => pluralKey('mcp.permissions', n, 'uk'))).toEqual(['mcp.permissions.one', 'mcp.permissions.few', 'mcp.permissions.many']);
  });
});
