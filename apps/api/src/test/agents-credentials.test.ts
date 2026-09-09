/**
 * Workspace Claude credentials (plan 2026-09-05-001, R6-R11): secrets never
 * come back, the first credential becomes primary, slots are exclusive,
 * rotation resets status, verify goes through the runtime adapter, the
 * resolution chain orders overrides before workspace slots, and the daily
 * sweep expires tokens and warns two weeks ahead.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { getDb, schema, eq } from '@ordi/db';
import { resetDb, seedRolesAndUsers, reqAs, json } from './helpers';
import { addCredential, createAgent, type Users } from './agents-helpers';
import { setRuntimeAdapter, type RuntimeAdapter } from '../domains/agents/runtime';
import { resolveCredentialChain, sweepCredentialExpiry } from '../domains/agents/credentials';
import { runAgentCredentialExpiry } from '../workers/scheduled';

let users: Users;
let restore: (() => void) | null = null;

beforeAll(async () => {
  await resetDb();
  users = await seedRolesAndUsers();
});

afterEach(() => { restore?.(); restore = null; });

function fakeAdapter(verify: RuntimeAdapter['verify']): RuntimeAdapter {
  return {
    runtime: 'claude_code',
    available: async () => ({ ok: true, version: 'test', error: null }),
    run: async () => { throw new Error('not in this test'); },
    verify,
    suggestBranchSlug: async () => null,
  };
}

describe('credentials', () => {
  it('stores the secret encrypted, masks it in every response, and makes the first one primary', async () => {
    const owner = reqAs(users.owner!.cookie);
    const created = await addCredential(users, { kind: 'subscription', label: 'Owner Max', secret: 'sk-ant-oat01-verysecretvalue' });
    expect(created.slot).toBe('primary');
    expect(JSON.stringify(created)).not.toContain('verysecret');
    const list = await json(owner.get('/agent-credentials'));
    expect(JSON.stringify(list)).not.toContain('verysecret');
    const row = list.data.find((c: { id: string }) => c.id === created.id);
    expect(row.kind).toBe('subscription');
    expect(row.connectedBy).toBe(users.owner!.userId);
    // A subscription token defaults to a one-year expiry.
    expect(new Date(row.expiresAt).getTime()).toBeGreaterThan(Date.now() + 300 * 24 * 3600_000);
    const { db } = getDb();
    const [stored] = await db.select().from(schema.agentCredentials).where(eq(schema.agentCredentials.id, created.id));
    expect(stored!.secret).not.toContain('verysecret');
  });

  it('keeps one active credential per slot', async () => {
    const owner = reqAs(users.owner!.cookie);
    const second = await addCredential(users, { label: 'Company key', slot: 'primary' });
    const list = (await json(owner.get('/agent-credentials'))).data as { id: string; slot: string | null }[];
    expect(list.filter((c) => c.slot === 'primary').map((c) => c.id)).toEqual([second.id]);
    const moved = await json(owner.patch(`/agent-credentials/${second.id}`, { version: second.version, slot: 'fallback' }));
    expect(moved.slot).toBe('fallback');
  });

  it('rotation replaces the secret and resets status; revoke drops the slot', async () => {
    const owner = reqAs(users.owner!.cookie);
    const cred = await addCredential(users, { label: 'Rotating', slot: 'primary' });
    const { db } = getDb();
    await db.update(schema.agentCredentials).set({ status: 'expired' }).where(eq(schema.agentCredentials.id, cred.id));
    // The version trigger bumped the row: a stale version is a 409, a fresh one rotates.
    expect((await owner.patch(`/agent-credentials/${cred.id}`, { version: cred.version, secret: 'sk-ant-new-secret-value-99' })).status).toBe(409);
    const current = (await json(owner.get('/agent-credentials'))).data.find((c: { id: string }) => c.id === cred.id);
    const rotated = await json(owner.patch(`/agent-credentials/${cred.id}`, { version: current.version, secret: 'sk-ant-new-secret-value-99' }));
    expect(rotated.status).toBe('active');
    expect(rotated.lastVerifiedAt).toBeNull();
    expect((await owner.del(`/agent-credentials/${cred.id}`)).status).toBe(200);
    const after = (await json(owner.get('/agent-credentials'))).data.find((c: { id: string }) => c.id === cred.id);
    expect(after.status).toBe('revoked');
    expect(after.slot).toBeNull();
  });

  it('rejects other providers and short secrets, and hides everything from a manager', async () => {
    const owner = reqAs(users.owner!.cookie);
    expect((await owner.post('/agent-credentials', { provider: 'openai', kind: 'api_key', label: 'x', secret: 'sk-1234567890' })).status).toBe(400);
    expect((await owner.post('/agent-credentials', { provider: 'anthropic', kind: 'api_key', label: 'x', secret: 'short' })).status).toBe(400);
    const manager = reqAs(users.manager!.cookie);
    expect((await manager.post('/agent-credentials', { provider: 'anthropic', kind: 'api_key', label: 'x', secret: 'sk-1234567890' })).status).toBe(403);
  });

  it('verify runs a minimal call through the adapter with the decrypted secret and records the outcome', async () => {
    const owner = reqAs(users.owner!.cookie);
    const cred = await addCredential(users, { label: 'Verify me', secret: 'sk-ant-verify-1234567890' });
    let seen: { kind: string; secret: string } | null = null;
    restore = setRuntimeAdapter(fakeAdapter(async (c) => { seen = { kind: c.kind, secret: c.secret }; return { ok: true, error: null, model: 'claude-test' }; }));
    const res = await json(owner.post(`/agent-credentials/${cred.id}/verify`));
    expect(res).toEqual({ ok: true, error: null, model: 'claude-test' });
    expect(seen).toEqual({ kind: 'api_key', secret: 'sk-ant-verify-1234567890' });
    const after = (await json(owner.get('/agent-credentials'))).data.find((c: { id: string }) => c.id === cred.id);
    expect(after.lastVerifiedAt).not.toBeNull();

    restore();
    restore = setRuntimeAdapter(fakeAdapter(async () => ({ ok: false, error: 'authentication_failed', model: null })));
    const bad = await json(owner.post(`/agent-credentials/${cred.id}/verify`));
    expect(bad.ok).toBe(false);
    const again = (await json(owner.get('/agent-credentials'))).data.find((c: { id: string }) => c.id === cred.id);
    expect(again.lastVerifyError).toBe('authentication_failed');
    expect(again.lastVerifiedAt).toBeNull();
  });

  it('resolves the chain: profile override, workspace primary, profile fallback, workspace fallback', async () => {
    const owner = reqAs(users.owner!.cookie);
    const { db } = getDb();
    await db.update(schema.agentCredentials).set({ slot: null });
    const primary = await addCredential(users, { label: 'P', slot: 'primary' });
    const fallback = await addCredential(users, { label: 'F', slot: 'fallback' });
    const override = await addCredential(users, { label: 'O', slot: null });
    const revoked = await addCredential(users, { label: 'R', slot: null });
    await owner.del(`/agent-credentials/${revoked.id}`);
    expect(await resolveCredentialChain({ credentialId: null, fallbackCredentialId: null })).toEqual([primary.id, fallback.id]);
    expect(await resolveCredentialChain({ credentialId: override.id, fallbackCredentialId: revoked.id })).toEqual([override.id, primary.id, fallback.id]);
    const agent = await createAgent(users, { name: 'Chained', credentialId: override.id });
    const view = await json(owner.get(`/agents/${agent.id}`));
    expect(view.dispatchable).toBe(true);
  });

  it('the sweep expires past-due tokens and lists those expiring within two weeks', async () => {
    const soon = await addCredential(users, { kind: 'subscription', label: 'Soon', secret: 'sk-ant-oat01-soon-1234567', expiresAt: new Date(Date.now() + 3 * 24 * 3600_000).toISOString() });
    const gone = await addCredential(users, { kind: 'subscription', label: 'Gone', secret: 'sk-ant-oat01-gone-1234567', expiresAt: new Date(Date.now() - 60_000).toISOString() });
    const result = await sweepCredentialExpiry();
    expect(result.expired).toContain(gone.id);
    expect(result.expiringSoon.map((c) => c.id)).toContain(soon.id);
    const { db } = getDb();
    const [row] = await db.select().from(schema.agentCredentials).where(eq(schema.agentCredentials.id, gone.id));
    expect(row!.status).toBe('expired');
    // The daily job turns the sweep into notifications for agents.manage holders.
    await runAgentCredentialExpiry();
    const notes = await db.select().from(schema.notifications).where(eq(schema.notifications.userId, users.owner!.userId));
    expect(notes.some((n) => n.type === 'agent.credential_expiring')).toBe(true);
  });
});
