/**
 * Project secrets (plan 2026-11-05-001, U1): storing, listing, editing and
 * revealing the credentials a client hands over.
 *
 * Every decision goes through secretAccess (shared/calc/rbac): the workspace
 * role, the project role and the secret's audience must all agree. Values
 * are decrypted in exactly one place, reveal(); everything else works on the
 * metadata in `project_secrets.fields`, so no other path can return a value.
 *
 * The trail: every create, change, reveal and copy is an activity row on the
 * `project_secret` entity, marked sensitive and never carrying a value. The
 * project's own activity – read by everyone on the project – hears only of
 * project-wide secrets; a restricted secret leaves no trace there.
 *
 * A provider secret (U5) has the same metadata, audience and trail, but no
 * payload: each field names a secret in Doppler (`ref`), read at the moment
 * of a reveal or a run start and dropped afterwards.
 */
import { getDb, schema, eq, and, asc, desc, inArray, sql } from '@ordi/db';
import { ulid } from 'ulid';
import {
  secretAccess, isProjectWideSecret, projectAccessRank, secretEnvVars,
  SECRET_VALUE_TYPES,
  type SecretAccess, type SecretAudiencePrincipal, type SecretFieldType, type SecretEnvironment,
} from '@ordi/shared';
import type { z } from 'zod';
import type { secretInputSchema, secretPatchSchema, secretFieldInputSchema } from '@ordi/shared';
import type { Actor } from '../../context';
import { effectiveProjectRole } from '../../core/access';
import { loadRolePermissions } from '../../core/rbac';
import { writeActivity } from '../../core/activity';
import { assertVersion } from '../../core/locking';
import { encrypt, decrypt } from '../../lib/crypto';
import { checkRate } from '../../lib/rate-limit';
import { err, ApiException } from '../../lib/errors';
import { callProvider, connectionForProject, connectionView, linkedConnections } from './connections';
import { cachedNames } from './providers';

const { projectSecrets, projectSecretAudience, projectSecretPayloads, projectResources, projects, employees, departments, projectMembers, notifications } = schema;

type SecretRow = typeof projectSecrets.$inferSelect;
type Db = ReturnType<typeof getDb>['db'];
type SecretInput = z.infer<typeof secretInputSchema>;
type SecretPatch = z.infer<typeof secretPatchSchema>;
type FieldInput = z.infer<typeof secretFieldInputSchema>;

/** What lists may show about a field. A url or text value is not secret and travels in the clear. */
export interface SecretFieldMeta {
  key: string;
  label: string;
  type: SecretFieldType;
  hasValue: boolean;
  /** url / text only. */
  value?: string;
  /** api_key only: the last four characters, for telling keys apart. Never in MCP. */
  hint?: string;
  /** Provider secrets: the name of the provider secret the field reads. */
  ref?: string;
}

/** Where a provider secret's values come from, and whether they can be reached. */
export interface SecretProviderState {
  connectionId: string | null;
  kind: string | null;
  label: string | null;
  /** disconnected: the connection was removed, or the project is no longer linked to it. */
  state: 'ok' | 'error' | 'disconnected';
  error: string | null;
  /** Fields whose provider secret is gone (renamed or deleted there). Checked when one secret is opened. */
  missing?: string[];
}

export interface SecretView {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  environment: SecretEnvironment;
  source: string;
  expiresAt: string | null;
  availableToAgents: boolean;
  fields: SecretFieldMeta[];
  audience: SecretAudiencePrincipal[];
  lastRevealedAt: string | null;
  lastRevealedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
  access: Pick<SecretAccess, 'reveal' | 'write' | 'manage'>;
  /** source = provider only. */
  provider: SecretProviderState | null;
}

const isValueType = (t: SecretFieldType) => SECRET_VALUE_TYPES.includes(t);

// ── Who the actor is, as far as audiences go ──

/** The actor's department and every department above it (an audience naming "Engineering" covers "Frontend"). */
export async function departmentChain(userId: string): Promise<Set<string>> {
  const { db } = getDb();
  const [emp] = await db.select({ departmentId: employees.departmentId }).from(employees)
    .where(and(eq(employees.userId, userId), sql`(${employees.exitDate} is null or ${employees.exitDate} > current_date::text)`));
  const chain = new Set<string>();
  if (!emp?.departmentId) return chain;
  const all = await db.select({ id: departments.id, parentId: departments.parentId }).from(departments);
  const parent = new Map(all.map((d) => [d.id, d.parentId]));
  let at: string | null | undefined = emp.departmentId;
  while (at && !chain.has(at)) {
    chain.add(at);
    at = parent.get(at);
  }
  return chain;
}

export interface ActorContext {
  actor: Actor;
  departments: Set<string>;
}

export async function actorContext(actor: Actor): Promise<ActorContext> {
  return { actor, departments: await departmentChain(actor.userId) };
}

async function projectRole(actor: Actor, projectId: string): Promise<'admin' | 'member' | 'viewer' | null> {
  const { db } = getDb();
  const [p] = await db.select({ id: projects.id, visibility: projects.visibility, deletedAt: projects.deletedAt })
    .from(projects).where(eq(projects.id, projectId));
  if (!p || p.deletedAt) return null;
  return effectiveProjectRole(actor, { id: p.id, visibility: p.visibility as 'workspace' | 'private' });
}

// ── Reading ──

async function audiencesOf(secretIds: string[]): Promise<Map<string, SecretAudiencePrincipal[]>> {
  const out = new Map<string, SecretAudiencePrincipal[]>();
  if (!secretIds.length) return out;
  const { db } = getDb();
  const rows = await db.select().from(projectSecretAudience).where(inArray(projectSecretAudience.secretId, secretIds));
  for (const r of rows) {
    const p: SecretAudiencePrincipal = r.principalType === 'project'
      ? { type: 'project' }
      : { type: r.principalType as 'user' | 'department', id: r.principalId };
    out.set(r.secretId, [...(out.get(r.secretId) ?? []), p]);
  }
  return out;
}

type LastReveal = { at: Date; by: string | null };

/**
 * When each secret was last shown or copied, from its trail. Not a column on
 * the secret: an update there would bump its version under whoever is editing.
 */
async function lastReveals(secretIds: string[]): Promise<Map<string, LastReveal>> {
  const out = new Map<string, LastReveal>();
  if (!secretIds.length) return out;
  const { db } = getDb();
  const log = schema.activityLog;
  const rows = await db.selectDistinctOn([log.entityId], { entityId: log.entityId, actorId: log.actorId, createdAt: log.createdAt })
    .from(log)
    .where(and(eq(log.entityType, 'project_secret'), inArray(log.action, ['revealed', 'copied']), inArray(log.entityId, secretIds)))
    .orderBy(log.entityId, desc(log.createdAt));
  for (const r of rows) out.set(r.entityId, { at: r.createdAt, by: r.actorId });
  return out;
}

type ConnectionRow = typeof schema.secretProviderConnections.$inferSelect;

/** The provider state of each provider secret among `rows`, from the project's links; no call to the provider. */
async function providerStates(projectId: string, rows: SecretRow[]): Promise<Map<string, SecretProviderState>> {
  const out = new Map<string, SecretProviderState>();
  const provider = rows.filter((r) => r.source === 'provider');
  if (!provider.length) return out;
  const linked = await linkedConnections(projectId);
  const unlinkedIds = [...new Set(provider.map((r) => r.providerConnectionId).filter((id): id is string => !!id && !linked.has(id)))];
  const { db } = getDb();
  const others = unlinkedIds.length
    ? new Map((await db.select().from(schema.secretProviderConnections).where(inArray(schema.secretProviderConnections.id, unlinkedIds))).map((c) => [c.id, c]))
    : new Map<string, ConnectionRow>();
  for (const r of provider) {
    const conn = r.providerConnectionId ? linked.get(r.providerConnectionId) ?? others.get(r.providerConnectionId) : undefined;
    const isLinked = !!r.providerConnectionId && linked.has(r.providerConnectionId);
    out.set(r.id, {
      connectionId: r.providerConnectionId, kind: conn?.kind ?? null, label: conn?.label ?? null,
      state: !conn || !isLinked ? 'disconnected' : conn.status === 'error' ? 'error' : 'ok',
      error: !conn ? 'The connection was removed' : !isLinked ? 'This project is no longer linked to the connection' : conn.lastError,
    });
  }
  return out;
}

function toView(row: SecretRow, audience: SecretAudiencePrincipal[], access: SecretAccess, last?: LastReveal, provider?: SecretProviderState): SecretView {
  return {
    id: row.id, projectId: row.projectId, name: row.name, description: row.description,
    environment: row.environment as SecretEnvironment, source: row.source,
    expiresAt: row.expiresAt, availableToAgents: row.availableToAgents,
    fields: row.fields as SecretFieldMeta[],
    audience,
    lastRevealedAt: last?.at.toISOString() ?? null,
    lastRevealedBy: last?.by ?? null,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    access: { reveal: access.reveal, write: access.write, manage: access.manage },
    provider: row.source === 'provider' ? provider ?? null : null,
  };
}

/**
 * The secrets of a project the actor may list, by id, with their access.
 * `ids` narrows it (the resources list asks for the ones it holds).
 */
export async function listSecrets(ctx: ActorContext, projectId: string, ids?: string[]): Promise<Map<string, SecretView>> {
  const out = new Map<string, SecretView>();
  const role = await projectRole(ctx.actor, projectId);
  if (!role) return out;
  const { db } = getDb();
  const where = ids
    ? and(eq(projectSecrets.projectId, projectId), ids.length ? inArray(projectSecrets.id, ids) : sql`false`)
    : eq(projectSecrets.projectId, projectId);
  const rows = await db.select().from(projectSecrets).where(where).orderBy(asc(projectSecrets.name));
  const audiences = await audiencesOf(rows.map((r) => r.id));
  const reveals = await lastReveals(rows.map((r) => r.id));
  const states = await providerStates(projectId, rows);
  for (const row of rows) {
    const audience = audiences.get(row.id) ?? [];
    const access = secretAccess({
      permissions: ctx.actor.access.permissions, projectRole: role, audience,
      userId: ctx.actor.userId, departmentIds: ctx.departments,
    });
    if (access.list) out.set(row.id, toView(row, audience, access, reveals.get(row.id), states.get(row.id)));
  }
  return out;
}

interface Loaded { row: SecretRow; audience: SecretAudiencePrincipal[]; access: SecretAccess }

/** One secret and the actor's access to it; 404 when they may not even know it exists. */
async function load(ctx: ActorContext, id: string): Promise<Loaded> {
  const { db } = getDb();
  const [row] = await db.select().from(projectSecrets).where(eq(projectSecrets.id, id));
  if (!row) throw err.notFound('Secret not found');
  const audience = (await audiencesOf([id])).get(id) ?? [];
  const access = secretAccess({
    permissions: ctx.actor.access.permissions, projectRole: await projectRole(ctx.actor, row.projectId), audience,
    userId: ctx.actor.userId, departmentIds: ctx.departments,
  });
  if (!access.list) throw err.notFound('Secret not found');
  return { row, audience, access };
}

/**
 * One secret. For a provider secret this also asks the provider which of its
 * names still exist (names only, cached a minute), so the panel can say
 * "Doppler: secret not found" before anyone tries a reveal (R35).
 */
export async function getSecret(ctx: ActorContext, id: string): Promise<SecretView> {
  const { row, audience, access } = await load(ctx, id);
  let provider = (await providerStates(row.projectId, [row])).get(id);
  if (provider && provider.state !== 'disconnected' && row.providerConnectionId) {
    const conn = (await linkedConnections(row.projectId)).get(row.providerConnectionId)!;
    try {
      const names = new Set(await callProvider(conn, (p) => cachedNames(conn.id, p)));
      const missing = (row.fields as SecretFieldMeta[]).filter((f) => f.ref && !names.has(f.ref)).map((f) => f.ref!);
      provider = { ...provider, state: 'ok', error: null, missing };
    } catch (e) {
      provider = { ...provider, state: 'error', error: e instanceof Error ? e.message : 'The provider could not be reached' };
    }
  }
  return toView(row, audience, access, (await lastReveals([id])).get(id), provider);
}

// ── Writing ──

function readPayload(ciphertext: string | undefined): Record<string, string> {
  if (!ciphertext) return {};
  return JSON.parse(decrypt(ciphertext)) as Record<string, string>;
}

/**
 * Split the fields into what lists may show and what gets encrypted. `previous`
 * supplies the values a field keeps when the edit left its value out.
 */
function splitFields(fields: FieldInput[], previous: { meta: SecretFieldMeta[]; values: Record<string, string> }) {
  const meta: SecretFieldMeta[] = [];
  const values: Record<string, string> = {};
  const before = new Map(previous.meta.map((m) => [m.key, m]));
  for (const f of fields) {
    const old = before.get(f.key);
    // A value left out keeps the old one, but only when the field stays the same kind of field.
    const keep = f.value === undefined && old && isValueType(old.type) === isValueType(f.type);
    const value = f.value !== undefined ? f.value : keep ? (isValueType(f.type) ? previous.values[f.key] : old!.value) ?? '' : '';
    const m: SecretFieldMeta = { key: f.key, label: f.label, type: f.type, hasValue: value !== '' };
    if (isValueType(f.type)) {
      if (value !== '') values[f.key] = value;
      if (f.type === 'api_key' && value.length >= 12) m.hint = value.slice(-4);
    } else if (value !== '') {
      m.value = value;
    }
    meta.push(m);
  }
  return { meta, values };
}

/**
 * A provider secret's fields: metadata and the provider name each reads,
 * never a value. `previous` lets an edit leave a field's ref out to keep it.
 */
function providerFields(fields: FieldInput[], previous: SecretFieldMeta[] = []): SecretFieldMeta[] {
  const before = new Map(previous.map((m) => [m.key, m]));
  return fields.map((f) => {
    if (f.value) throw err.validation('A provider secret keeps its values in the provider');
    const ref = f.ref ?? before.get(f.key)?.ref;
    if (!ref) throw err.validation(`Choose which provider secret the field ${f.label} reads`);
    return { key: f.key, label: f.label, type: f.type, hasValue: true, ref };
  });
}

/** Every ref must exist in the provider when it is chosen; a typo would otherwise surface only at the next run. */
async function assertRefsExist(conn: ConnectionRow, meta: SecretFieldMeta[]): Promise<void> {
  const names = new Set(await callProvider(conn, (p) => cachedNames(conn.id, p)));
  const missing = meta.filter((m) => m.ref && !names.has(m.ref)).map((m) => m.ref!);
  if (missing.length) throw err.validation(`The provider has no secret named ${missing.join(', ')}`);
}

/** People and departments named in an audience must exist. */
async function validateAudience(audience: SecretAudiencePrincipal[]): Promise<void> {
  const { db } = getDb();
  const userIds = audience.filter((p) => p.type === 'user').map((p) => (p as { id: string }).id);
  const deptIds = audience.filter((p) => p.type === 'department').map((p) => (p as { id: string }).id);
  if (userIds.length) {
    const found = await db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, userIds));
    if (found.length !== new Set(userIds).size) throw err.validation('The audience names someone who does not exist');
  }
  if (deptIds.length) {
    const found = await db.select({ id: departments.id }).from(departments).where(inArray(departments.id, deptIds));
    if (found.length !== new Set(deptIds).size) throw err.validation('The audience names a department that does not exist');
  }
}

function dedupeAudience(audience: SecretAudiencePrincipal[]): SecretAudiencePrincipal[] {
  const seen = new Set<string>();
  return audience.filter((p) => {
    const k = p.type === 'project' ? 'project' : `${p.type}:${p.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function writeAudience(db: Db, secretId: string, audience: SecretAudiencePrincipal[]): Promise<void> {
  await db.delete(projectSecretAudience).where(eq(projectSecretAudience.secretId, secretId));
  await db.insert(projectSecretAudience).values(audience.map((p) => ({
    secretId, principalType: p.type, principalId: p.type === 'project' ? '' : p.id,
  })));
}

const sensitive = (actor: Actor, secretId: string, action: string, diff: Record<string, unknown>) => ({
  entityType: 'project_secret', entityId: secretId, action, diff, sensitivity: 'sensitive' as const,
  actorId: actor.userId, actorType: actor.actorType,
});

export async function createSecret(ctx: ActorContext, projectId: string, input: SecretInput): Promise<SecretView> {
  const { actor } = ctx;
  const role = await projectRole(actor, projectId);
  if (!role) throw err.notFound('Project not found');
  const perms = actor.access.permissions;
  if (!perms.has('secrets.write')) throw err.forbidden('Adding secrets needs secrets.write', 'secrets.write');
  if (role === 'viewer') throw err.forbidden('Adding secrets needs member access to the project');

  const audience = dedupeAudience(input.audience);
  await validateAudience(audience);
  // Whoever adds a secret must be able to reach it afterwards, unless they govern every secret anyway.
  const own = secretAccess({ permissions: perms, projectRole: role, audience, userId: actor.userId, departmentIds: ctx.departments });
  if (!own.inAudience && !own.manage) throw err.domain('Include yourself in who can see the values, or you could not open this secret again');
  if (input.availableToAgents && input.environment === 'production' && !own.manage) {
    throw err.forbidden('Only secrets.manage can let agents use a production secret', 'secrets.manage');
  }

  const { db } = getDb();
  const [dupe] = await db.select({ id: projectSecrets.id }).from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.name, input.name)));
  if (dupe) throw err.domain(`This project already has a secret named ${input.name}`);

  const fromProvider = input.source === 'provider';
  let meta: SecretFieldMeta[];
  let values: Record<string, string> = {};
  if (fromProvider) {
    const conn = await connectionForProject(projectId, input.connectionId!);
    meta = providerFields(input.fields);
    await assertRefsExist(conn, meta);
  } else {
    ({ meta, values } = splitFields(input.fields, { meta: [], values: {} }));
  }
  const id = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(projectSecrets).values({
      id, projectId, name: input.name, description: input.description || null,
      environment: input.environment, expiresAt: input.expiresAt ?? null,
      availableToAgents: !!input.availableToAgents, fields: meta, createdBy: actor.userId,
      source: input.source, providerConnectionId: fromProvider ? input.connectionId! : null,
    });
    await writeAudience(tx as unknown as Db, id, audience);
    // A provider secret has no payload: its values never enter ordi's database.
    if (!fromProvider) await tx.insert(projectSecretPayloads).values({ secretId: id, ciphertext: encrypt(JSON.stringify(values)) });
    const [pos] = await tx.select({ max: sql<number | null>`max(${projectResources.position})` })
      .from(projectResources).where(eq(projectResources.projectId, projectId));
    await tx.insert(projectResources).values({
      id: ulid(), projectId, kind: 'secret', secretId: id, position: (pos?.max ?? -1) + 1, createdBy: actor.userId,
    });
    await writeActivity(tx, sensitive(actor, id, 'created', {
      name: { to: input.name }, fields: { to: meta.map((m) => m.key) }, environment: { to: input.environment },
      ...(fromProvider ? { source: { to: 'provider' }, refs: { to: meta.map((m) => m.ref) } } : {}),
    }));
    if (isProjectWideSecret(audience)) {
      await writeActivity(tx, {
        entityType: 'project', entityId: projectId, action: 'resource_added',
        after: { kind: 'secret', name: input.name }, actorId: actor.userId, actorType: actor.actorType,
      });
    }
  });
  return getSecret(ctx, id);
}

const sameAudience = (a: SecretAudiencePrincipal[], b: SecretAudiencePrincipal[]) => {
  const key = (p: SecretAudiencePrincipal) => (p.type === 'project' ? 'project' : `${p.type}:${p.id}`);
  const sa = new Set(a.map(key));
  return a.length === b.length && b.every((p) => sa.has(key(p)));
};

export async function updateSecret(ctx: ActorContext, id: string, patch: SecretPatch): Promise<SecretView> {
  const { actor } = ctx;
  const { row, audience, access } = await load(ctx, id);
  assertVersion(row, patch.version);

  const touchesContent = patch.fields !== undefined || patch.description !== undefined || patch.expiresAt !== undefined
    || patch.connectionId !== undefined;
  const touchesGovernance = patch.audience !== undefined || patch.environment !== undefined || patch.availableToAgents !== undefined;
  if (touchesContent && !access.write) throw err.forbidden('Editing this secret needs secrets.write and a place in its audience', 'secrets.write');
  if (touchesGovernance && !access.write && !access.manage) throw err.forbidden('Changing who can use this secret needs secrets.manage', 'secrets.manage');

  const environment = (patch.environment ?? row.environment) as SecretEnvironment;
  let availableToAgents = patch.availableToAgents ?? row.availableToAgents;
  // Becoming a production secret switches agent use off, unless a manager turns it on in the same edit.
  if (environment === 'production' && row.environment !== 'production' && patch.availableToAgents === undefined) availableToAgents = false;
  // Agents on a production secret is a manager's call: turning it on, or moving an agent-enabled secret to production.
  const newlyAgentProduction = availableToAgents && environment === 'production'
    && (!row.availableToAgents || row.environment !== 'production');
  if (newlyAgentProduction && !access.manage) {
    throw err.forbidden('Only secrets.manage can let agents use a production secret', 'secrets.manage');
  }

  let nextAudience = audience;
  if (patch.audience) {
    nextAudience = dedupeAudience(patch.audience);
    await validateAudience(nextAudience);
    const after = secretAccess({
      permissions: actor.access.permissions, projectRole: await projectRole(actor, row.projectId), audience: nextAudience,
      userId: actor.userId, departmentIds: ctx.departments,
    });
    if (!after.inAudience && !after.manage) throw err.domain('This change would leave you without access; keep yourself in the audience');
  }

  const isProvider = row.source === 'provider';
  if (!isProvider && patch.connectionId) throw err.validation('Only a provider secret has a connection');
  if (!isProvider && patch.fields?.some((f) => f.ref)) throw err.validation('Only a provider secret reads from a provider');
  let providerMeta: SecretFieldMeta[] | null = null;
  const connectionId = patch.connectionId ?? row.providerConnectionId;
  if (isProvider && (patch.fields || (patch.connectionId && patch.connectionId !== row.providerConnectionId))) {
    // Relinking a disconnected secret, or new refs: both must exist in a connection the project may use.
    if (!connectionId) throw err.domain('This secret is disconnected; choose a connection for it');
    const conn = await connectionForProject(row.projectId, connectionId);
    providerMeta = patch.fields ? providerFields(patch.fields, row.fields as SecretFieldMeta[]) : row.fields as SecretFieldMeta[];
    await assertRefsExist(conn, providerMeta);
  }

  const { db } = getDb();
  const diff: Record<string, unknown> = {};
  const set: Partial<SecretRow> = {};
  if (isProvider && patch.connectionId && patch.connectionId !== row.providerConnectionId) {
    set.providerConnectionId = patch.connectionId;
    diff.connection = { from: row.providerConnectionId, to: patch.connectionId };
  }
  if (patch.description !== undefined && (patch.description || null) !== row.description) {
    set.description = patch.description || null;
    diff.description = { changed: true };
  }
  if (patch.expiresAt !== undefined && patch.expiresAt !== row.expiresAt) {
    set.expiresAt = patch.expiresAt;
    diff.expiresAt = { from: row.expiresAt, to: patch.expiresAt };
  }
  if (environment !== row.environment) {
    set.environment = environment;
    diff.environment = { from: row.environment, to: environment };
  }
  if (availableToAgents !== row.availableToAgents) {
    set.availableToAgents = availableToAgents;
    diff.availableToAgents = { from: row.availableToAgents, to: availableToAgents };
  }
  const audienceChanged = !!patch.audience && !sameAudience(audience, nextAudience);
  if (audienceChanged) diff.audience = { from: audience, to: nextAudience };

  await db.transaction(async (tx) => {
    if (patch.fields && providerMeta) {
      set.fields = providerMeta;
      diff.fields = {
        from: (row.fields as SecretFieldMeta[]).map((m) => m.key), to: providerMeta.map((m) => m.key),
        refs: providerMeta.map((m) => m.ref),
      };
    } else if (patch.fields) {
      const [payload] = await tx.select().from(projectSecretPayloads).where(eq(projectSecretPayloads.secretId, id));
      const { meta, values } = splitFields(patch.fields, { meta: row.fields as SecretFieldMeta[], values: readPayload(payload?.ciphertext) });
      set.fields = meta;
      await tx.insert(projectSecretPayloads).values({ secretId: id, ciphertext: encrypt(JSON.stringify(values)) })
        .onConflictDoUpdate({ target: projectSecretPayloads.secretId, set: { ciphertext: encrypt(JSON.stringify(values)), updatedAt: new Date() } });
      // Which fields changed, never what they hold.
      diff.fields = {
        from: (row.fields as SecretFieldMeta[]).map((m) => m.key),
        to: meta.map((m) => m.key),
        valuesSet: patch.fields.filter((f) => f.value !== undefined).map((f) => f.key),
      };
    }
    if (Object.keys(set).length) {
      await tx.update(projectSecrets).set(set).where(eq(projectSecrets.id, id));
    } else if (audienceChanged) {
      // The version still moves, so a concurrent editor sees the change.
      await tx.update(projectSecrets).set({ updatedAt: new Date() }).where(eq(projectSecrets.id, id));
    }
    if (audienceChanged) await writeAudience(tx as unknown as Db, id, nextAudience);
    if (Object.keys(diff).length) await writeActivity(tx, sensitive(actor, id, 'updated', diff));

    // Break-glass (R53): someone outside the audience, acting on secrets.manage alone, changed who gets in.
    if (audienceChanged && !access.inAudience) {
      await writeActivity(tx, sensitive(actor, id, 'access_overridden', { audience: { from: audience, to: nextAudience } }));
      await notifyAccessOverride(tx as unknown as Db, row, audience, actor);
    }
  });
  return getSecret(ctx, id);
}

/** Tell the secret's creator and the project admins it was shared with that a manager changed its audience. */
async function notifyAccessOverride(db: Db, row: SecretRow, audience: SecretAudiencePrincipal[], actor: Actor): Promise<void> {
  const admins = await db.select({ userId: projectMembers.userId }).from(projectMembers)
    .where(and(eq(projectMembers.projectId, row.projectId), eq(projectMembers.role, 'admin')));
  const named = new Set(audience.filter((p) => p.type === 'user').map((p) => (p as { id: string }).id));
  const projectWide = isProjectWideSecret(audience);
  const recipients = new Set<string>();
  if (row.createdBy) recipients.add(row.createdBy);
  for (const a of admins) if (projectWide || named.has(a.userId)) recipients.add(a.userId);
  recipients.delete(actor.userId);
  if (!recipients.size) return;
  const stamp = Date.now();
  await db.insert(notifications).values([...recipients].map((userId) => ({
    id: ulid(), userId, type: 'secret.access_overridden',
    dedupeKey: `secret.access_overridden:${row.id}:${userId}:${stamp}`,
    entityRef: `project_secret:${row.id}`,
    payload: { secretId: row.id, projectId: row.projectId, title: row.name, actorName: actor.name },
  })));
}

export async function deleteSecret(ctx: ActorContext, id: string): Promise<{ projectId: string }> {
  const { actor } = ctx;
  const { row, audience, access } = await load(ctx, id);
  if (!access.write) throw err.forbidden('Deleting this secret needs secrets.write and a place in its audience', 'secrets.write');
  const { db } = getDb();
  await db.transaction(async (tx) => {
    // Payload, audience and the resource row go with it (ON DELETE CASCADE).
    await tx.delete(projectSecrets).where(eq(projectSecrets.id, id));
    await writeActivity(tx, sensitive(actor, id, 'deleted', { name: { from: row.name } }));
    if (isProjectWideSecret(audience)) {
      await writeActivity(tx, {
        entityType: 'project', entityId: row.projectId, action: 'resource_removed',
        after: { kind: 'secret', name: row.name }, actorId: actor.userId, actorType: actor.actorType,
      });
    }
  });
  return { projectId: row.projectId };
}

// ── Revealing ──

/** Reveals per person per minute: enough for real use, too few to scrape a project with a stolen session. */
const REVEALS_PER_MINUTE = 30;

/**
 * The one place a value leaves the server. Needs a signed-in session: API
 * tokens (MCP, agents) cannot reveal until a token scope for it exists
 * (plan U6), and agent runs get values another way (U4).
 */
export async function revealSecretField(
  ctx: ActorContext, id: string, field: string, purpose: 'reveal' | 'copy',
): Promise<{ field: string; value: string }> {
  const { actor } = ctx;
  if (actor.tokenScopes !== null) throw err.forbidden('Revealing a secret needs a signed-in session');
  const { row, access } = await load(ctx, id);
  if (!access.reveal) throw err.forbidden('Revealing this secret needs secrets.reveal, member access to the project and a place in its audience', 'secrets.reveal');
  const meta = (row.fields as SecretFieldMeta[]).find((m) => m.key === field);
  if (!meta) throw err.notFound('Field not found');
  checkRate(`secret-reveal:${actor.userId}`, REVEALS_PER_MINUTE, 60_000);

  const { db } = getDb();
  let value = '';
  if (row.source === 'provider') {
    value = await providerValue(row, meta);
  } else if (isValueType(meta.type)) {
    const [payload] = await db.select().from(projectSecretPayloads).where(eq(projectSecretPayloads.secretId, id));
    value = readPayload(payload?.ciphertext)[field] ?? '';
  } else {
    value = meta.value ?? '';
  }
  await writeActivity(db, sensitive(actor, id, purpose === 'copy' ? 'copied' : 'revealed', { field: { to: field } }));
  return { field, value };
}

/** One field of a provider secret, fetched for this request only (R33). */
async function providerValue(row: SecretRow, meta: SecretFieldMeta): Promise<string> {
  if (!row.providerConnectionId) throw err.domain('This secret is disconnected: its connection was removed');
  const conn = (await linkedConnections(row.projectId)).get(row.providerConnectionId);
  if (!conn) throw err.domain('This secret is disconnected: the project is no longer linked to its connection');
  const got = await callProvider(conn, (p) => p.getValues([meta.ref!]));
  if (!(meta.ref! in got)) throw err.domain(`The provider has no secret named ${meta.ref}; it may have been renamed or deleted there`);
  return got[meta.ref!]!;
}

/** The secret's own trail, for those who may reveal it or govern it. */
export async function secretActivity(ctx: ActorContext, id: string) {
  const { access } = await load(ctx, id);
  if (!access.reveal && !access.manage && !access.write) throw err.forbidden('The trail is for those who can use or manage this secret');
  const { db } = getDb();
  return db.select().from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, 'project_secret'), eq(schema.activityLog.entityId, id)))
    .orderBy(sql`${schema.activityLog.createdAt} desc`)
    .limit(100);
}

// ── Choosing an audience ──

interface Person { id: string; name: string; avatar: string | null }

/**
 * Everyone who could be in an audience, with what the three layers make of
 * them. Computed for every active person at once: a workspace is a few dozen
 * people, and the dialog must show who will really get in, not who was named.
 */
async function workspaceAccess(projectId: string) {
  const { db } = getDb();
  const [project] = await db.select({ visibility: projects.visibility }).from(projects).where(eq(projects.id, projectId));
  const people = await db.select({
    id: schema.users.id, name: schema.users.name, avatar: schema.users.avatar, roleId: schema.users.roleId,
  }).from(schema.users).where(and(eq(schema.users.isActive, true), eq(schema.users.actorType, 'user')));
  const memberships = new Map((await db.select({ userId: projectMembers.userId, role: projectMembers.role })
    .from(projectMembers).where(eq(projectMembers.projectId, projectId))).map((m) => [m.userId, m.role as 'admin' | 'member' | 'viewer']));
  const depts = await db.select({ id: departments.id, name: departments.name, parentId: departments.parentId }).from(departments);
  const parent = new Map(depts.map((d) => [d.id, d.parentId]));
  const staff = await db.select({ userId: employees.userId, departmentId: employees.departmentId }).from(employees)
    .where(sql`${employees.userId} is not null and (${employees.exitDate} is null or ${employees.exitDate} > current_date::text)`);
  const deptOf = new Map(staff.map((e) => [e.userId!, e.departmentId]));
  const roleRanks = ['viewer', 'member', 'admin'] as const;

  const rows = [];
  for (const p of people) {
    const permissions = await loadRolePermissions(p.roleId);
    const rank = project ? projectAccessRank(
      { permissions, projectMemberships: memberships.has(p.id) ? new Map([[projectId, memberships.get(p.id)!]]) : new Map(), spaceMemberships: new Map() },
      { visibility: project.visibility as 'workspace' | 'private', projectId },
    ) : 0;
    const chain = new Set<string>();
    let at = deptOf.get(p.id) ?? null;
    while (at && !chain.has(at)) { chain.add(at); at = parent.get(at) ?? null; }
    rows.push({ person: { id: p.id, name: p.name, avatar: p.avatar } as Person, permissions, projectRole: rank ? roleRanks[rank - 1]! : null, departments: chain });
  }
  return { rows, departments: depts };
}

async function assertCanShare(ctx: ActorContext, projectId: string): Promise<void> {
  const role = await projectRole(ctx.actor, projectId);
  const perms = ctx.actor.access.permissions;
  if (!role) throw err.notFound('Project not found');
  const writer = perms.has('secrets.write') && role !== 'viewer';
  if (!writer && !perms.has('secrets.manage')) throw err.forbidden('Sharing secrets needs secrets.write', 'secrets.write');
}

// ── Adding from a provider ──

/** The connections a project may add secrets from, for those who may add secrets. */
export async function projectProviders(ctx: ActorContext, projectId: string) {
  await assertCanAdd(ctx, projectId);
  return [...(await linkedConnections(projectId)).values()].map(connectionView);
}

/** The names in a linked connection, for the "From Doppler" picker (R31). Names only, never values. */
export async function providerNames(ctx: ActorContext, projectId: string, connectionId: string): Promise<{ names: string[] }> {
  await assertCanAdd(ctx, projectId);
  const conn = await connectionForProject(projectId, connectionId);
  return { names: await callProvider(conn, (p) => cachedNames(conn.id, p)) };
}

async function assertCanAdd(ctx: ActorContext, projectId: string): Promise<void> {
  const role = await projectRole(ctx.actor, projectId);
  if (!role) throw err.notFound('Project not found');
  if (!ctx.actor.access.permissions.has('secrets.write')) throw err.forbidden('Adding secrets needs secrets.write', 'secrets.write');
  if (role === 'viewer') throw err.forbidden('Adding secrets needs member access to the project');
}

/** Who and what an audience can name in this project: people on it, and departments. */
export async function audienceOptions(ctx: ActorContext, projectId: string) {
  await assertCanShare(ctx, projectId);
  const { rows, departments: depts } = await workspaceAccess(projectId);
  return {
    people: rows.filter((r) => r.projectRole && r.projectRole !== 'viewer').map((r) => r.person)
      .sort((a, b) => a.name.localeCompare(b.name)),
    departments: depts.map((d) => ({ id: d.id, name: d.name, parentId: d.parentId }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The people an audience really lets reveal values, all three layers applied. */
export async function audiencePreview(ctx: ActorContext, projectId: string, audience: SecretAudiencePrincipal[]) {
  await assertCanShare(ctx, projectId);
  const { rows } = await workspaceAccess(projectId);
  const canReveal: Person[] = [];
  let canList = 0;
  for (const r of rows) {
    const a = secretAccess({ permissions: r.permissions, projectRole: r.projectRole, audience, userId: r.person.id, departmentIds: r.departments });
    if (a.reveal) canReveal.push(r.person);
    if (a.list) canList += 1;
  }
  return { canReveal: canReveal.sort((a, b) => a.name.localeCompare(b.name)), canList };
}

// ── Expiry reminders ──

const EXPIRY_LEAD_DAYS = 14;

/**
 * Daily: a reminder two weeks before a secret's credential stops working, and
 * one on the day. It goes to the secret's creator and the project's admins –
 * only those of them the secret is open to, so a restricted secret's name
 * reaches nobody outside its audience. Deduplicated per secret and milestone.
 */
export async function runSecretExpiry(now = new Date()): Promise<{ notified: number }> {
  const { db } = getDb();
  const day = (offset: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset)).toISOString().slice(0, 10);
  const milestones = new Map([[day(EXPIRY_LEAD_DAYS), 'secret.expiring'], [day(0), 'secret.expired']]);
  const due = await db.select().from(projectSecrets)
    .innerJoin(projects, eq(projects.id, projectSecrets.projectId))
    .where(and(inArray(projectSecrets.expiresAt, [...milestones.keys()]), sql`${projects.deletedAt} is null`));
  let notified = 0;
  for (const { project_secrets: secret } of due) {
    const type = milestones.get(secret.expiresAt!)!;
    const audience = (await audiencesOf([secret.id])).get(secret.id) ?? [];
    const { rows } = await workspaceAccess(secret.projectId);
    for (const r of rows) {
      const access = secretAccess({ permissions: r.permissions, projectRole: r.projectRole, audience, userId: r.person.id, departmentIds: r.departments });
      const concerned = r.person.id === secret.createdBy || r.projectRole === 'admin';
      if (!access.list || !concerned) continue;
      const inserted = await db.insert(notifications).values({
        id: ulid(), userId: r.person.id, type,
        dedupeKey: `${type}:${secret.id}:${secret.expiresAt}:${r.person.id}`,
        entityRef: `project_secret:${secret.id}`,
        payload: { secretId: secret.id, projectId: secret.projectId, title: secret.name, expiresAt: secret.expiresAt },
      }).onConflictDoNothing().returning({ id: notifications.id });
      notified += inserted.length;
    }
  }
  return { notified };
}

// ── Secrets in agent runs (plan U4, R21-R29) ──

export interface AgentSecretVar {
  variable: string;
  secretName: string;
  fieldLabel: string;
}

interface AgentSecretPlan {
  /** Secrets the run gets, with the variables each field becomes. */
  use: { secret: SecretRow; vars: (AgentSecretVar & { field: string })[]; restricted: boolean }[];
  /** Secrets marked for agents that the run does not get, and why. */
  skipped: { name: string; reason: string }[];
  /** How many more were left out because the person behind the run cannot open them – unnamed: the run log is read by the whole project. */
  withheld: number;
  /** Restricted secrets left out because their provider could not supply them – counted, not named, for the same reason. */
  unavailable: number;
}

/** What the three layers make of one person on one project (the same inputs secretAccess takes for the actor). */
async function personOnProject(userId: string, projectId: string): Promise<{ permissions: Set<string>; projectRole: 'admin' | 'member' | 'viewer' | null; departments: Set<string> } | null> {
  const { db } = getDb();
  const [user] = await db.select({ roleId: schema.users.roleId, isActive: schema.users.isActive, actorType: schema.users.actorType })
    .from(schema.users).where(eq(schema.users.id, userId));
  if (!user || !user.isActive || user.actorType !== 'user') return null;
  const [project] = await db.select({ visibility: projects.visibility }).from(projects).where(eq(projects.id, projectId));
  if (!project) return null;
  const [membership] = await db.select({ role: projectMembers.role }).from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  const permissions = await loadRolePermissions(user.roleId);
  const rank = projectAccessRank(
    { permissions, projectMemberships: membership ? new Map([[projectId, membership.role as 'admin' | 'member' | 'viewer']]) : new Map(), spaceMemberships: new Map() },
    { visibility: project.visibility as 'workspace' | 'private', projectId },
  );
  return { permissions, projectRole: rank ? (['viewer', 'member', 'admin'] as const)[rank - 1]! : null, departments: await departmentChain(userId) };
}

/**
 * Which of a project's secrets an agent run gets. Three conditions:
 *
 * - the secret's agent switch is on (R21);
 * - the agent is itself a member of the project (R21);
 * - the person behind the run – who assigned the task, retried it, or wrote
 *   the comment it answers – could reveal the secret themselves. An agent
 *   holding a value can always find some way to show it (encoded, split), so
 *   a run must never hand anyone more than they could open in the panel:
 *   without this, assigning a task to an agent would be a way around a
 *   secret's audience.
 *
 * An expired secret is left out with a reason. Metadata only: nothing is
 * decrypted here.
 */
export async function agentSecretPlan(
  projectId: string, agentUserId: string, requesterId: string | null, today = new Date().toISOString().slice(0, 10),
): Promise<AgentSecretPlan> {
  const { db } = getDb();
  const [membership] = await db.select({ role: projectMembers.role }).from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, agentUserId)));
  const rows = await db.select().from(projectSecrets)
    .where(and(eq(projectSecrets.projectId, projectId), eq(projectSecrets.availableToAgents, true)))
    .orderBy(asc(projectSecrets.name));
  const plan: AgentSecretPlan = { use: [], skipped: [], withheld: 0, unavailable: 0 };
  if (!rows.length) return plan;
  const audiences = await audiencesOf(rows.map((r) => r.id));
  const linked = rows.some((r) => r.source === 'provider') ? await linkedConnections(projectId) : new Map<string, ConnectionRow>();
  const requester = requesterId ? await personOnProject(requesterId, projectId) : null;
  const requesterCanReveal = (secret: SecretRow) => !!requester && secretAccess({
    permissions: requester.permissions, projectRole: requester.projectRole, audience: audiences.get(secret.id) ?? [],
    userId: requesterId!, departmentIds: requester.departments,
  }).reveal;
  if (!membership || membership.role === 'viewer') {
    // Named only where the whole project may know the name.
    for (const r of rows) {
      if (isProjectWideSecret(audiences.get(r.id) ?? [])) plan.skipped.push({ name: r.name, reason: 'the agent is not a member of the project' });
      else plan.withheld += 1;
    }
    return plan;
  }
  for (const secret of rows) {
    const restricted = !isProjectWideSecret(audiences.get(secret.id) ?? []);
    if (!requesterCanReveal(secret)) {
      if (restricted) plan.withheld += 1;
      else plan.skipped.push({ name: secret.name, reason: 'the person who started the run cannot open it' });
      continue;
    }
    if (secret.source === 'provider' && (!secret.providerConnectionId || !linked.has(secret.providerConnectionId))) {
      if (restricted) plan.unavailable += 1;
      else plan.skipped.push({ name: secret.name, reason: 'its provider connection was removed or unlinked' });
      continue;
    }
    if (secret.expiresAt && secret.expiresAt < today) { plan.skipped.push({ name: secret.name, reason: `it expired on ${secret.expiresAt}` }); continue; }
    const fields = secret.fields as SecretFieldMeta[];
    const label = new Map(fields.map((f) => [f.key, f.label]));
    const vars = secretEnvVars(secret.name, fields).map((v) => ({ ...v, secretName: secret.name, fieldLabel: label.get(v.field) ?? v.field }));
    if (vars.length) plan.use.push({ secret, vars, restricted });
  }
  return plan;
}

/**
 * The values for a run: decrypted here, in the API, and handed to the worker
 * with the bundle – the standalone worker holds no ENCRYPTION_KEY. Provider
 * secrets are fetched now, one request per connection, and held only in the
 * bundle (R33); one the provider cannot supply is left out with the reason,
 * and the run still starts (R29). Each secret a run receives is noted on the
 * secret's own trail.
 */
export async function resolveRunSecrets(
  run: { id: string; projectId: string; agentUserId: string; taskId: string; requestedBy: string | null },
  opts: { record?: boolean } = {},
): Promise<{
  vars: { variable: string; value: string }[];
  /** Names the whole project may see; restricted ones are only counted. */
  used: string[]; usedRestricted: number;
  skipped: { name: string; reason: string }[]; withheld: number;
  /** Restricted secrets their provider could not supply. */
  unavailable: number;
}> {
  const plan = await agentSecretPlan(run.projectId, run.agentUserId, run.requestedBy);
  const { db } = getDb();
  const skipped = [...plan.skipped];
  let unavailable = plan.unavailable;

  // Provider values, one call per connection for every ref the run needs.
  const fetched = new Map<string, Record<string, string> | Error>();
  const byConnection = new Map<string, Set<string>>();
  for (const { secret } of plan.use) {
    if (secret.source !== 'provider') continue;
    const refs = byConnection.get(secret.providerConnectionId!) ?? new Set<string>();
    for (const f of secret.fields as SecretFieldMeta[]) if (f.ref) refs.add(f.ref);
    byConnection.set(secret.providerConnectionId!, refs);
  }
  if (byConnection.size) {
    const linked = await linkedConnections(run.projectId);
    for (const [connectionId, refs] of byConnection) {
      const conn = linked.get(connectionId);
      try {
        if (!conn) throw new Error('its provider connection was removed or unlinked');
        fetched.set(connectionId, await callProvider(conn, (p) => p.getValues([...refs])));
      } catch (e) {
        fetched.set(connectionId, e instanceof Error ? e : new Error('its provider could not be reached'));
      }
    }
  }

  const vars: { variable: string; value: string }[] = [];
  const delivered: typeof plan.use = [];
  for (const entry of plan.use) {
    const { secret, vars: wanted, restricted } = entry;
    const meta = new Map((secret.fields as SecretFieldMeta[]).map((f) => [f.key, f]));
    let valueOf: (field: string) => string | undefined;
    if (secret.source === 'provider') {
      const got = fetched.get(secret.providerConnectionId!);
      const missing = got instanceof Error ? [] : (secret.fields as SecretFieldMeta[]).filter((f) => f.ref && !(f.ref in got!)).map((f) => f.ref!);
      if (got instanceof Error || missing.length) {
        if (restricted) unavailable += 1;
        else skipped.push({
          name: secret.name,
          reason: got instanceof Error
            ? (got instanceof ApiException ? `the provider failed: ${got.message}` : got.message)
            : `the provider has no secret named ${missing.join(', ')}`,
        });
        continue;
      }
      valueOf = (field) => got![meta.get(field)!.ref!];
    } else {
      const [payload] = await db.select().from(projectSecretPayloads).where(eq(projectSecretPayloads.secretId, secret.id));
      const values = readPayload(payload?.ciphertext);
      valueOf = (field) => {
        const m = meta.get(field);
        return m && isValueType(m.type) ? values[field] : m?.value;
      };
    }
    for (const v of wanted) {
      const value = valueOf(v.field);
      if (value) vars.push({ variable: v.variable, value });
    }
    delivered.push(entry);
    if (opts.record) {
      await writeActivity(db, {
        entityType: 'project_secret', entityId: secret.id, action: 'used_in_run', sensitivity: 'sensitive',
        diff: { run: { to: run.id }, task: { to: run.taskId } }, actorId: run.agentUserId, actorType: 'agent',
      });
    }
  }
  return {
    vars,
    used: delivered.filter((u) => !u.restricted).map((u) => u.secret.name),
    usedRestricted: delivered.filter((u) => u.restricted).length,
    skipped,
    withheld: plan.withheld,
    unavailable,
  };
}
