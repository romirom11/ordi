import { describe, it, expect } from 'vitest';
import { connectionsKey, groupConnections } from './oauthConnections';

interface Tok { id: string; client: string | null; lastUsedAt?: string | null; createdAt?: string | null; revokedAt?: string | null }

describe('groupConnections', () => {
  const tokens: Tok[] = [
    { id: 'laptop', client: 'Claude Code', lastUsedAt: '2026-11-20T10:00:00Z', createdAt: '2026-11-01T00:00:00Z' },
    { id: 'server', client: 'Claude Code', lastUsedAt: '2026-11-27T10:00:00Z', createdAt: '2026-11-02T00:00:00Z' },
    { id: 'fresh', client: 'Claude Code', lastUsedAt: null, createdAt: '2026-11-28T00:00:00Z' },
    { id: 'gone', client: 'Claude Code', lastUsedAt: null, createdAt: '2026-10-01T00:00:00Z', revokedAt: '2026-10-02T00:00:00Z' },
    { id: 'codex', client: 'Codex', lastUsedAt: null, createdAt: '2026-11-03T00:00:00Z' },
    { id: 'ci', client: null, lastUsedAt: null, createdAt: '2026-01-01T00:00:00Z' },
    { id: 'old-ci', client: null, revokedAt: '2026-02-01T00:00:00Z' },
  ];

  it('one entry per client, connections by most recent use, hand-made tokens apart', () => {
    const { groups, others } = groupConnections(tokens, (t) => t.client);
    expect(groups.map((g) => g.client)).toEqual(['Claude Code', 'Codex']);
    // Not yet used counts from when it was issued.
    expect(groups[0]!.connections.map((t) => t.id)).toEqual(['fresh', 'server', 'laptop']);
    expect(groups[1]!.connections.map((t) => t.id)).toEqual(['codex']);
    // Hand-made tokens stay as they are, revoked ones included.
    expect(others.map((t) => t.id)).toEqual(['ci', 'old-ci']);
  });

  it('leaves revoked connections out, and a client with none left', () => {
    const { groups } = groupConnections([tokens[3]!], (t) => t.client);
    expect(groups).toEqual([]);
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
