/**
 * Workspace Claude credentials (plan 2026-09-05-001, R6-R11). The owner
 * connects a subscription token or an API key once; every agent draws on it.
 * Secrets are AES-GCM at rest and never leave this module except into the
 * runtime adapter's child environment.
 */
import { getDb, schema, eq, and, isNull, sql } from '@ordi/db';
import { ulid } from 'ulid';
import type { AgentCredentialInput } from '@ordi/shared';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Actor } from '../../context';
import { env } from '../../env';
import { err } from '../../lib/errors';
import { encrypt, decrypt } from '../../lib/crypto';
import { writeActivity } from '../../core/activity';
import { assertVersion } from '../../core/locking';
import { runtimeAdapter, type RuntimeCredential } from './runtime';

const { agentCredentials } = schema;

type CredentialRow = typeof agentCredentials.$inferSelect;

/** The env fallback (R8) shows up as a virtual, read-only credential. */
export const ENV_CREDENTIAL_ID = 'env:anthropic';

export interface CredentialView {
  id: string;
  provider: string;
  kind: string;
  label: string;
  slot: string | null;
  status: string;
  expiresAt: string | null;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
  connectedBy: string | null;
  connectedAt: string;
  revokedAt: string | null;
  version: number;
  /** Set on the env-provided credential, which the UI cannot edit. */
  fromEnv?: boolean;
}

function toView(row: CredentialRow): CredentialView {
  return {
    id: row.id, provider: row.provider, kind: row.kind, label: row.label, slot: row.slot,
    status: row.status,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastVerifyError: row.lastVerifyError,
    connectedBy: row.connectedBy, connectedAt: row.connectedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    version: row.version,
  };
}

function envCredentialView(): CredentialView | null {
  if (!env.anthropicApiKey) return null;
  return {
    id: ENV_CREDENTIAL_ID, provider: 'anthropic', kind: 'api_key', label: 'ANTHROPIC_API_KEY (environment)',
    slot: null, status: 'active', expiresAt: null, lastVerifiedAt: null, lastVerifyError: null,
    connectedBy: null, connectedAt: new Date(0).toISOString(), revokedAt: null, version: 1, fromEnv: true,
  };
}

export async function listCredentials(): Promise<CredentialView[]> {
  const { db } = getDb();
  const rows = await db.select().from(agentCredentials).orderBy(agentCredentials.createdAt);
  const views = rows.map(toView);
  const fromEnv = envCredentialView();
  return fromEnv ? [...views, fromEnv] : views;
}

/** Only one active credential per slot: taking a slot vacates it elsewhere. */
async function vacateSlot(slot: string, exceptId: string | null): Promise<void> {
  const { db } = getDb();
  const cond = exceptId
    ? and(eq(agentCredentials.slot, slot), sql`${agentCredentials.id} <> ${exceptId}`)
    : eq(agentCredentials.slot, slot);
  await db.update(agentCredentials).set({ slot: null }).where(cond);
}

export async function createCredential(actor: Actor, input: AgentCredentialInput): Promise<CredentialView> {
  const { db } = getDb();
  const id = ulid();
  // First credential becomes primary unless the caller chose otherwise.
  const [existingPrimary] = await db.select({ id: agentCredentials.id }).from(agentCredentials)
    .where(and(eq(agentCredentials.slot, 'primary'), eq(agentCredentials.status, 'active')));
  const slot = input.slot === undefined ? (existingPrimary ? null : 'primary') : input.slot;
  if (slot) await vacateSlot(slot, null);
  const expiresAt = input.expiresAt ? new Date(input.expiresAt)
    : input.kind === 'subscription' ? new Date(Date.now() + 365 * 24 * 3600_000) : null;
  await db.insert(agentCredentials).values({
    id, provider: input.provider, kind: input.kind, label: input.label,
    secret: encrypt(input.secret), slot, expiresAt, connectedBy: actor.userId,
  });
  await writeActivity(db, {
    entityType: 'agent_credential', entityId: id, action: 'connected',
    actorId: actor.userId, actorType: actor.actorType,
    diff: { provider: input.provider, kind: input.kind, label: input.label, slot },
  });
  const [row] = await db.select().from(agentCredentials).where(eq(agentCredentials.id, id));
  return toView(row!);
}

export async function updateCredential(actor: Actor, id: string, input: {
  label?: string; slot?: string | null; secret?: string; expiresAt?: string | null; version: number;
}): Promise<CredentialView> {
  const { db } = getDb();
  const [row] = await db.select().from(agentCredentials).where(eq(agentCredentials.id, id));
  if (!row) throw err.notFound('Credential not found');
  assertVersion(row, input.version, toView(row));
  const patch: Partial<typeof agentCredentials.$inferInsert> = {};
  if (input.label !== undefined) patch.label = input.label;
  if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (input.secret !== undefined) {
    patch.secret = encrypt(input.secret);
    patch.status = 'active';
    patch.revokedAt = null;
    patch.lastVerifiedAt = null;
    patch.lastVerifyError = null;
    patch.connectedBy = actor.userId;
    patch.connectedAt = new Date();
  }
  if (input.slot !== undefined) {
    if (input.slot) await vacateSlot(input.slot, id);
    patch.slot = input.slot;
  }
  await db.update(agentCredentials).set(patch).where(and(eq(agentCredentials.id, id), eq(agentCredentials.version, row.version)));
  await writeActivity(db, {
    entityType: 'agent_credential', entityId: id, action: input.secret ? 'rotated' : 'updated',
    actorId: actor.userId, actorType: actor.actorType,
    diff: { label: input.label, slot: input.slot },
  });
  const [after] = await db.select().from(agentCredentials).where(eq(agentCredentials.id, id));
  return toView(after!);
}

export async function revokeCredential(actor: Actor, id: string): Promise<void> {
  const { db } = getDb();
  const [row] = await db.select().from(agentCredentials).where(eq(agentCredentials.id, id));
  if (!row) throw err.notFound('Credential not found');
  await db.update(agentCredentials).set({ status: 'revoked', revokedAt: new Date(), slot: null }).where(eq(agentCredentials.id, id));
  await writeActivity(db, {
    entityType: 'agent_credential', entityId: id, action: 'revoked',
    actorId: actor.userId, actorType: actor.actorType, diff: { label: row.label },
  });
}

/** Load a decrypted credential for a run. Never exposed over a route. */
export async function loadRuntimeCredential(id: string): Promise<(RuntimeCredential & { id: string; provider: string }) | null> {
  if (id === ENV_CREDENTIAL_ID) {
    return env.anthropicApiKey ? { id, provider: 'anthropic', kind: 'api_key', secret: env.anthropicApiKey } : null;
  }
  const { db } = getDb();
  const [row] = await db.select().from(agentCredentials).where(eq(agentCredentials.id, id));
  if (!row || row.status !== 'active') return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;
  return { id: row.id, provider: row.provider, kind: row.kind as RuntimeCredential['kind'], secret: decrypt(row.secret) };
}

/**
 * Which credentials a run may use, in order (R9): the profile's override, the
 * workspace primary, then the profile fallback, the workspace fallback and the
 * env key. Only active, unexpired ones are returned.
 */
export async function resolveCredentialChain(profile: { credentialId: string | null; fallbackCredentialId: string | null }): Promise<string[]> {
  const { db } = getDb();
  const slots = await db.select({ id: agentCredentials.id, slot: agentCredentials.slot })
    .from(agentCredentials)
    .where(and(eq(agentCredentials.status, 'active'), isNull(agentCredentials.revokedAt)));
  const primary = slots.find((s) => s.slot === 'primary')?.id ?? null;
  const fallback = slots.find((s) => s.slot === 'fallback')?.id ?? null;
  const order = [profile.credentialId, primary, profile.fallbackCredentialId, fallback, env.anthropicApiKey ? ENV_CREDENTIAL_ID : null];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (await loadRuntimeCredential(id)) out.push(id);
  }
  return out;
}

/** R10: a minimal runtime call proving the credential works. */
export async function verifyCredential(actor: Actor, id: string): Promise<{ ok: boolean; error: string | null; model: string | null }> {
  const cred = await loadRuntimeCredential(id);
  if (!cred) throw err.notFound('Credential not found or not active');
  const adapter = runtimeAdapter('claude_code');
  const configDir = await mkdtemp(join(tmpdir(), 'ordi-verify-'));
  try {
    const result = await adapter.verify({ kind: cred.kind, secret: cred.secret }, { configDir });
    if (id !== ENV_CREDENTIAL_ID) {
      const { db } = getDb();
      await db.update(agentCredentials).set({
        lastVerifiedAt: result.ok ? new Date() : null,
        lastVerifyError: result.ok ? null : result.error,
      }).where(eq(agentCredentials.id, id));
      await writeActivity(db, {
        entityType: 'agent_credential', entityId: id, action: result.ok ? 'verified' : 'verify_failed',
        actorId: actor.userId, actorType: actor.actorType, diff: { model: result.model, error: result.error },
      });
    }
    return result;
  } finally {
    await rm(configDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Daily job (R11): expire what has expired and return the credentials that
 * expire within fourteen days so the caller can notify agents.manage holders.
 */
export async function sweepCredentialExpiry(now = new Date()): Promise<{ expired: string[]; expiringSoon: CredentialView[] }> {
  const { db } = getDb();
  const rows = await db.select().from(agentCredentials).where(eq(agentCredentials.status, 'active'));
  const expired: string[] = [];
  const expiringSoon: CredentialView[] = [];
  const soon = now.getTime() + 14 * 24 * 3600_000;
  for (const row of rows) {
    if (!row.expiresAt) continue;
    if (row.expiresAt <= now) {
      await db.update(agentCredentials).set({ status: 'expired', slot: null }).where(eq(agentCredentials.id, row.id));
      expired.push(row.id);
    } else if (row.expiresAt.getTime() <= soon) {
      expiringSoon.push(toView(row));
    }
  }
  return { expired, expiringSoon };
}
