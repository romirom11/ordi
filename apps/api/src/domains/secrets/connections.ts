/**
 * Connections to external secret stores (plan 2026-11-05-001, U5, R30-R38).
 *
 * A workspace admin (`integrations.manage`) connects Doppler once with a
 * read-only service token scoped to one config, and links the connection to
 * the projects that may use it. The token is stored encrypted and never
 * returned. A project's people then add secrets from it by name (R31): the
 * config is never mirrored, and its values stay in Doppler, fetched only for
 * a reveal or a run.
 *
 * Every provider call goes through `callProvider`, which keeps the
 * connection's status in step with what the provider last said, so the card
 * in Settings and the secrets that use it show a revoked token (R35).
 */
import { getDb, schema, eq, and, inArray, sql } from '@ordi/db';
import { ulid } from 'ulid';
import type { z } from 'zod';
import type {
  SecretProviderKind, secretProviderConnectionInputSchema, secretProviderConnectionPatchSchema,
} from '@ordi/shared';
import type { Actor } from '../../context';
import { writeActivity } from '../../core/activity';
import { encrypt, decrypt } from '../../lib/crypto';
import { err } from '../../lib/errors';
import {
  PROVIDER_LABEL, ProviderError, cachedNames, forgetNames, providerFor,
  type ProviderTarget, type SecretProvider,
} from './providers';

const { secretProviderConnections: connections, projectSecretProviderLinks: links, projectSecrets, projects } = schema;

type ConnectionRow = typeof connections.$inferSelect;
type ConnectionInput = z.infer<typeof secretProviderConnectionInputSchema>;
type ConnectionPatch = z.infer<typeof secretProviderConnectionPatchSchema>;

export interface ConnectionView {
  id: string;
  kind: SecretProviderKind;
  label: string;
  /** Where the token points (Doppler project and config). */
  project: string | null;
  config: string | null;
  status: 'ok' | 'error';
  lastError: string | null;
  checkedAt: string | null;
  createdAt: string;
  /** Settings only. */
  projectIds?: string[];
  secretCount?: number;
}

function targetOf(row: ConnectionRow): Partial<ProviderTarget> {
  return (row.config ?? {}) as Partial<ProviderTarget>;
}

function toView(row: ConnectionRow): ConnectionView {
  const target = targetOf(row);
  return {
    id: row.id, kind: row.kind as SecretProviderKind, label: row.label,
    project: target.project ?? null, config: target.config ?? null,
    status: row.status as 'ok' | 'error', lastError: row.lastError,
    checkedAt: row.checkedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(),
  };
}

function openToken(row: ConnectionRow): string {
  try {
    return (JSON.parse(decrypt(row.credentials)) as { token: string }).token;
  } catch {
    throw err.domain('The stored token for this connection cannot be read; connect it again');
  }
}

function providerOf(row: ConnectionRow): SecretProvider {
  return providerFor(row.kind as SecretProviderKind, { token: openToken(row), ...targetOf(row) });
}

/** A provider error as the API answers it: 422 with what the provider said, never the token. */
export function providerFailure(kind: SecretProviderKind, e: ProviderError) {
  return err.domain(e.message, { provider: kind, reason: e.kind });
}

/**
 * Run one provider call for a stored connection, and record how it went:
 * a failure marks the connection (and so its secrets) as in error until a
 * later call succeeds. The status is written only when it changes.
 */
export async function callProvider<T>(row: ConnectionRow, fn: (p: SecretProvider) => Promise<T>): Promise<T> {
  const { db } = getDb();
  try {
    const out = await fn(providerOf(row));
    if (row.status !== 'ok' || row.lastError) {
      await db.update(connections).set({ status: 'ok', lastError: null, checkedAt: new Date() }).where(eq(connections.id, row.id));
    }
    return out;
  } catch (e) {
    if (!(e instanceof ProviderError)) throw e;
    // A rate limit says nothing about the connection itself.
    if (e.kind !== 'rate_limited' && (row.status !== 'error' || row.lastError !== e.message)) {
      await db.update(connections).set({ status: 'error', lastError: e.message, checkedAt: new Date() }).where(eq(connections.id, row.id));
    }
    throw providerFailure(row.kind as SecretProviderKind, e);
  }
}

export async function loadConnection(id: string): Promise<ConnectionRow> {
  const { db } = getDb();
  const [row] = await db.select().from(connections).where(eq(connections.id, id));
  if (!row) throw err.notFound('Connection not found');
  return row;
}

function assertManage(actor: Actor): void {
  if (!actor.access.permissions.has('integrations.manage')) {
    throw err.forbidden('Connecting secret stores needs integrations.manage', 'integrations.manage');
  }
}

const auditEntry = (actor: Actor, id: string, action: string, diff: Record<string, unknown>) => ({
  entityType: 'secret_provider_connection', entityId: id, action, diff,
  actorId: actor.userId, actorType: actor.actorType,
});

// ── Settings: the workspace's connections ──

export async function listConnections(actor: Actor): Promise<ConnectionView[]> {
  assertManage(actor);
  const { db } = getDb();
  const rows = await db.select().from(connections).orderBy(connections.createdAt);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const linked = await db.select({ connectionId: links.connectionId, projectId: links.projectId }).from(links)
    .where(inArray(links.connectionId, ids));
  const counts = await db.select({ connectionId: projectSecrets.providerConnectionId, n: sql<number>`count(*)::int` })
    .from(projectSecrets).where(inArray(projectSecrets.providerConnectionId, ids)).groupBy(projectSecrets.providerConnectionId);
  return rows.map((r) => ({
    ...toView(r),
    projectIds: linked.filter((l) => l.connectionId === r.id).map((l) => l.projectId),
    secretCount: counts.find((c) => c.connectionId === r.id)?.n ?? 0,
  }));
}

/** Verify first: a token that does not work is never stored (R30). */
async function verifyToken(kind: SecretProviderKind, token: string, target: Partial<ProviderTarget>): Promise<ProviderTarget> {
  try {
    return await providerFor(kind, { token, ...target }).verify();
  } catch (e) {
    if (e instanceof ProviderError) throw providerFailure(kind, e);
    throw e;
  }
}

export async function createConnection(actor: Actor, input: ConnectionInput): Promise<ConnectionView> {
  assertManage(actor);
  if (!!input.project !== !!input.config) throw err.validation('Enter both the project and the config, or neither');
  const target = await verifyToken(input.kind, input.token, { project: input.project, config: input.config });
  const label = input.label?.trim() || `${PROVIDER_LABEL[input.kind]} · ${target.project}/${target.config}`;
  const { db } = getDb();
  const id = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(connections).values({
      id, kind: input.kind, label, credentials: encrypt(JSON.stringify({ token: input.token })),
      config: target, status: 'ok', checkedAt: new Date(), createdBy: actor.userId,
    });
    await writeActivity(tx, auditEntry(actor, id, 'connected', { kind: { to: input.kind }, label: { to: label }, target: { to: target } }));
  });
  return toView(await loadConnection(id));
}

export async function updateConnection(actor: Actor, id: string, patch: ConnectionPatch): Promise<ConnectionView> {
  assertManage(actor);
  const row = await loadConnection(id);
  const set: Partial<ConnectionRow> = {};
  const diff: Record<string, unknown> = {};
  if (patch.label && patch.label !== row.label) {
    set.label = patch.label;
    diff.label = { from: row.label, to: patch.label };
  }
  const before = targetOf(row);
  const retarget = (patch.project && patch.project !== before.project) || (patch.config && patch.config !== before.config);
  if (patch.token || retarget) {
    const token = patch.token ?? openToken(row);
    // A new token may point elsewhere: read the target back unless one was given.
    const given = patch.project || patch.config
      ? { project: patch.project ?? before.project, config: patch.config ?? before.config }
      : patch.token ? {} : before;
    const target = await verifyToken(row.kind as SecretProviderKind, token, given);
    if (patch.token) {
      set.credentials = encrypt(JSON.stringify({ token }));
      diff.token = { changed: true };
    }
    if (target.project !== before.project || target.config !== before.config) {
      set.config = target;
      diff.target = { from: before, to: target };
    }
    Object.assign(set, { status: 'ok', lastError: null, checkedAt: new Date() });
  }
  if (!Object.keys(set).length) return toView(row);
  const { db } = getDb();
  await db.transaction(async (tx) => {
    await tx.update(connections).set(set).where(eq(connections.id, id));
    if (Object.keys(diff).length) await writeActivity(tx, auditEntry(actor, id, 'updated', diff));
  });
  forgetNames(id);
  return toView(await loadConnection(id));
}

/** Ask the provider again, for the card's "Check" button. */
export async function checkConnection(actor: Actor, id: string): Promise<ConnectionView> {
  assertManage(actor);
  const row = await loadConnection(id);
  forgetNames(id);
  try {
    await callProvider(row, (p) => cachedNames(id, p));
  } catch {
    // The failure is on the connection now; the card shows it.
  }
  return toView(await loadConnection(id));
}

/**
 * Remove a connection. Its secrets stay, disconnected (R36): their names,
 * fields and audience remain visible until someone removes or relinks them.
 */
export async function deleteConnection(actor: Actor, id: string): Promise<void> {
  assertManage(actor);
  const row = await loadConnection(id);
  const { db } = getDb();
  await db.transaction(async (tx) => {
    // provider_connection_id goes to null (ON DELETE SET NULL); links go with the row.
    await tx.delete(connections).where(eq(connections.id, id));
    await writeActivity(tx, auditEntry(actor, id, 'disconnected', { label: { from: row.label } }));
  });
  forgetNames(id);
}

/** The projects that may add secrets from a connection: the full list replaces the old one. */
export async function setConnectionProjects(actor: Actor, id: string, projectIds: string[]): Promise<ConnectionView> {
  assertManage(actor);
  await loadConnection(id);
  const wanted = [...new Set(projectIds)];
  const { db } = getDb();
  if (wanted.length) {
    const found = await db.select({ id: projects.id }).from(projects)
      .where(and(inArray(projects.id, wanted), sql`${projects.deletedAt} is null`));
    if (found.length !== wanted.length) throw err.validation('One of the projects does not exist');
  }
  const current = (await db.select({ projectId: links.projectId }).from(links).where(eq(links.connectionId, id))).map((l) => l.projectId);
  const added = wanted.filter((p) => !current.includes(p));
  const removed = current.filter((p) => !wanted.includes(p));
  await db.transaction(async (tx) => {
    if (removed.length) await tx.delete(links).where(and(eq(links.connectionId, id), inArray(links.projectId, removed)));
    if (added.length) await tx.insert(links).values(added.map((projectId) => ({ projectId, connectionId: id, createdBy: actor.userId })));
    if (added.length || removed.length) await writeActivity(tx, auditEntry(actor, id, 'projects_changed', { added, removed }));
  });
  return (await listConnections(actor)).find((c) => c.id === id)!;
}

// ── Projects: the connections a project may use ──

/** Connections linked to a project, keyed by id. */
export async function linkedConnections(projectId: string): Promise<Map<string, ConnectionRow>> {
  const { db } = getDb();
  const rows = await db.select({ c: connections }).from(links)
    .innerJoin(connections, eq(connections.id, links.connectionId))
    .where(eq(links.projectId, projectId));
  return new Map(rows.map((r) => [r.c.id, r.c]));
}

/** A connection the project may use, or a 422 saying it may not. */
export async function connectionForProject(projectId: string, connectionId: string): Promise<ConnectionRow> {
  const linked = await linkedConnections(projectId);
  const row = linked.get(connectionId);
  if (!row) throw err.domain('This project is not linked to that connection; a workspace admin links it in Settings → Integrations');
  return row;
}

export { toView as connectionView };
