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
 */
import { getDb, schema, eq, and, asc, inArray, sql } from '@ordi/db';
import { ulid } from 'ulid';
import {
  secretAccess, isProjectWideSecret,
  SECRET_VALUE_TYPES,
  type SecretAccess, type SecretAudiencePrincipal, type SecretFieldType, type SecretEnvironment,
} from '@ordi/shared';
import type { z } from 'zod';
import type { secretInputSchema, secretPatchSchema, secretFieldInputSchema } from '@ordi/shared';
import type { Actor } from '../../context';
import { effectiveProjectRole } from '../../core/access';
import { writeActivity } from '../../core/activity';
import { assertVersion } from '../../core/locking';
import { encrypt, decrypt } from '../../lib/crypto';
import { checkRate } from '../../lib/rate-limit';
import { err } from '../../lib/errors';

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

function toView(row: SecretRow, audience: SecretAudiencePrincipal[], access: SecretAccess): SecretView {
  return {
    id: row.id, projectId: row.projectId, name: row.name, description: row.description,
    environment: row.environment as SecretEnvironment, source: row.source,
    expiresAt: row.expiresAt, availableToAgents: row.availableToAgents,
    fields: row.fields as SecretFieldMeta[],
    audience,
    lastRevealedAt: row.lastRevealedAt?.toISOString() ?? null,
    lastRevealedBy: row.lastRevealedBy,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    access: { reveal: access.reveal, write: access.write, manage: access.manage },
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
  for (const row of rows) {
    const audience = audiences.get(row.id) ?? [];
    const access = secretAccess({
      permissions: ctx.actor.access.permissions, projectRole: role, audience,
      userId: ctx.actor.userId, departmentIds: ctx.departments,
    });
    if (access.list) out.set(row.id, toView(row, audience, access));
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

export async function getSecret(ctx: ActorContext, id: string): Promise<SecretView> {
  const { row, audience, access } = await load(ctx, id);
  return toView(row, audience, access);
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

  const { meta, values } = splitFields(input.fields, { meta: [], values: {} });
  const id = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(projectSecrets).values({
      id, projectId, name: input.name, description: input.description || null,
      environment: input.environment, expiresAt: input.expiresAt ?? null,
      availableToAgents: !!input.availableToAgents, fields: meta, createdBy: actor.userId,
    });
    await writeAudience(tx as unknown as Db, id, audience);
    await tx.insert(projectSecretPayloads).values({ secretId: id, ciphertext: encrypt(JSON.stringify(values)) });
    const [pos] = await tx.select({ max: sql<number | null>`max(${projectResources.position})` })
      .from(projectResources).where(eq(projectResources.projectId, projectId));
    await tx.insert(projectResources).values({
      id: ulid(), projectId, kind: 'secret', secretId: id, position: (pos?.max ?? -1) + 1, createdBy: actor.userId,
    });
    await writeActivity(tx, sensitive(actor, id, 'created', {
      name: { to: input.name }, fields: { to: meta.map((m) => m.key) }, environment: { to: input.environment },
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

  const touchesContent = patch.fields !== undefined || patch.description !== undefined || patch.expiresAt !== undefined;
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

  const { db } = getDb();
  const diff: Record<string, unknown> = {};
  const set: Partial<SecretRow> = {};
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
    if (patch.fields) {
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
    id: ulid(), userId, type: 'secret_access_overridden',
    dedupeKey: `secret_access_overridden:${row.id}:${userId}:${stamp}`,
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
  if (isValueType(meta.type)) {
    const [payload] = await db.select().from(projectSecretPayloads).where(eq(projectSecretPayloads.secretId, id));
    value = readPayload(payload?.ciphertext)[field] ?? '';
  } else {
    value = meta.value ?? '';
  }
  await db.update(projectSecrets).set({ lastRevealedAt: new Date(), lastRevealedBy: actor.userId })
    .where(eq(projectSecrets.id, id));
  await writeActivity(db, sensitive(actor, id, purpose === 'copy' ? 'copied' : 'revealed', { field: { to: field } }));
  return { field, value };
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
