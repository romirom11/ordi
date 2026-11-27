/**
 * External agents: Claude Code, Codex or any other agent that runs outside
 * ordi and connects over MCP. Each is an agent user of its own – comments,
 * edits and the audit trail name it, not the person who set it up – with a
 * role, project memberships (it reaches only the projects it is added to) and
 * tokens that can be revoked one by one. It has no agent_profiles row, so ordi
 * never dispatches it; the owner is the person behind it.
 */
import { getDb, schema, eq, and, inArray, isNull } from '@ordi/db';
import { ulid } from 'ulid';
import type { CreateExternalAgentInput, UpdateExternalAgentInput } from '@ordi/shared';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { generateToken, sha256 } from '../../lib/crypto';
import { writeActivity } from '../../core/activity';
import { loadRolePermissions } from '../../core/rbac';

const { users, roles, externalAgents, apiTokens, projectMembers, projects } = schema;

export interface ExternalAgentToken {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ExternalAgentView {
  id: string;
  name: string;
  avatar: string | null;
  isActive: boolean;
  roleId: string;
  roleName: string;
  ownerUserId: string;
  ownerName: string | null;
  projects: { id: string; key: string; name: string }[];
  /** Live tokens only: revoked and expired ones are not listed. */
  tokens: ExternalAgentToken[];
  createdAt: string;
}

function agentEmail(id: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
  return `${slug}-${id.slice(-6).toLowerCase()}@external.agents.ordi.local`;
}

async function defaultAgentRoleId(): Promise<string> {
  const { db } = getDb();
  const [agentRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, 'agent'));
  if (agentRole) return agentRole.id;
  const [member] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, 'member'));
  if (member) return member.id;
  throw err.domain('No role available for the agent; create the Agent role first');
}

async function assertRole(roleId: string): Promise<void> {
  const { db } = getDb();
  const [role] = await db.select({ key: roles.key }).from(roles).where(eq(roles.id, roleId));
  if (!role) throw err.validation('Unknown role');
  if (role.key === 'owner') throw err.domain('An agent cannot hold the Owner role');
}

/** The owner is a person: questions without an addressee go to them. */
async function assertOwner(userId: string): Promise<void> {
  const { db } = getDb();
  const [owner] = await db.select({ isActive: users.isActive, actorType: users.actorType }).from(users).where(eq(users.id, userId));
  if (!owner || !owner.isActive || owner.actorType !== 'user') {
    throw err.validation('The owner must be an active person, not an agent');
  }
}

async function loadRow(id: string) {
  const { db } = getDb();
  const [row] = await db.select({ user: users, ext: externalAgents }).from(users)
    .innerJoin(externalAgents, eq(externalAgents.userId, users.id)).where(eq(users.id, id));
  if (!row) throw err.notFound('External agent not found');
  return row;
}

async function views(ids: string[]): Promise<ExternalAgentView[]> {
  if (!ids.length) return [];
  const { db } = getDb();
  const rows = await db.select({ user: users, ext: externalAgents, roleName: roles.name }).from(users)
    .innerJoin(externalAgents, eq(externalAgents.userId, users.id))
    .leftJoin(roles, eq(roles.id, users.roleId))
    .where(inArray(users.id, ids))
    .orderBy(users.name);
  const ownerIds = [...new Set(rows.map((r) => r.ext.ownerUserId))];
  const [owners, memberships, tokens] = await Promise.all([
    db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ownerIds)),
    db.select({ userId: projectMembers.userId, id: projects.id, key: projects.key, name: projects.name })
      .from(projectMembers).innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(and(inArray(projectMembers.userId, ids), isNull(projects.deletedAt))),
    db.select().from(apiTokens).where(and(inArray(apiTokens.userId, ids), isNull(apiTokens.revokedAt))),
  ]);
  const now = Date.now();
  return rows.map(({ user, ext, roleName }) => ({
    id: user.id,
    name: user.name,
    avatar: user.avatar,
    isActive: user.isActive,
    roleId: user.roleId,
    roleName: roleName ?? '',
    ownerUserId: ext.ownerUserId,
    ownerName: owners.find((o) => o.id === ext.ownerUserId)?.name ?? null,
    projects: memberships.filter((m) => m.userId === user.id).map(({ id, key, name }) => ({ id, key, name })),
    tokens: tokens
      .filter((t) => t.userId === user.id && !(t.expiresAt && t.expiresAt.getTime() <= now))
      .map((t) => ({
        id: t.id, name: t.name, prefix: t.prefix,
        lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
        expiresAt: t.expiresAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
      })),
    createdAt: ext.createdAt.toISOString(),
  }));
}

export async function listExternalAgents(): Promise<ExternalAgentView[]> {
  const { db } = getDb();
  const rows = await db.select({ id: externalAgents.userId }).from(externalAgents);
  return views(rows.map((r) => r.id));
}

export async function getExternalAgent(id: string): Promise<ExternalAgentView> {
  await loadRow(id);
  return (await views([id]))[0]!;
}

export async function createExternalAgent(actor: Actor, input: CreateExternalAgentInput): Promise<ExternalAgentView> {
  const { db } = getDb();
  const roleId = input.roleId ?? await defaultAgentRoleId();
  await assertRole(roleId);
  const ownerUserId = input.ownerUserId ?? actor.userId;
  await assertOwner(ownerUserId);
  const id = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id, email: agentEmail(id, input.name), name: input.name, passwordHash: null, roleId,
      actorType: 'agent', emailNotificationPrefs: { __all: false },
    });
    await tx.insert(externalAgents).values({ userId: id, ownerUserId, createdBy: actor.userId });
    await writeActivity(tx, {
      entityType: 'agent', entityId: id, action: 'created', actorId: actor.userId, actorType: actor.actorType,
      diff: { name: input.name, kind: 'external', roleId, ownerUserId },
    });
  });
  return getExternalAgent(id);
}

export async function updateExternalAgent(actor: Actor, id: string, input: UpdateExternalAgentInput): Promise<ExternalAgentView> {
  const { db } = getDb();
  await loadRow(id);
  const userPatch: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) userPatch.name = input.name;
  if (input.roleId !== undefined) { await assertRole(input.roleId); userPatch.roleId = input.roleId; }
  if (input.ownerUserId !== undefined) await assertOwner(input.ownerUserId);
  await db.transaction(async (tx) => {
    if (Object.keys(userPatch).length) await tx.update(users).set(userPatch).where(eq(users.id, id));
    if (input.ownerUserId !== undefined) {
      await tx.update(externalAgents).set({ ownerUserId: input.ownerUserId }).where(eq(externalAgents.userId, id));
    }
    await writeActivity(tx, {
      entityType: 'agent', entityId: id, action: 'updated', actorId: actor.userId, actorType: actor.actorType,
      diff: { ...input },
    });
  });
  return getExternalAgent(id);
}

/** Switching an agent off revokes every token it holds; switching it back on needs a new one. */
export async function setExternalAgentActive(actor: Actor, id: string, active: boolean): Promise<ExternalAgentView> {
  const { db } = getDb();
  await loadRow(id);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ isActive: active }).where(eq(users.id, id));
    if (!active) {
      await tx.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.userId, id), isNull(apiTokens.revokedAt)));
    }
    await writeActivity(tx, {
      entityType: 'agent', entityId: id, action: active ? 'enabled' : 'disabled', actorId: actor.userId, actorType: actor.actorType,
    });
  });
  return getExternalAgent(id);
}

/**
 * A token for the agent to connect with. The raw value is returned once and
 * only its hash is kept. Its scope is the agent's role, and the project reach
 * is the agent's memberships, checked on every request.
 */
export async function issueExternalAgentToken(
  actor: Actor,
  id: string,
  input: { name: string; expiresInDays: number | null },
): Promise<{ token: string; tokenInfo: ExternalAgentToken }> {
  const { db } = getDb();
  const row = await loadRow(id);
  if (!row.user.isActive) throw err.domain('This agent is switched off; switch it on before issuing a token');
  const raw = `ordi_${generateToken(24)}`;
  const tokenId = ulid();
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
  const scopes = [...(await loadRolePermissions(row.user.roleId))];
  await db.insert(apiTokens).values({
    id: tokenId, userId: id, name: input.name, hash: sha256(raw), prefix: raw.slice(0, 12), scopes, readOnly: false, expiresAt,
  });
  await writeActivity(db, {
    entityType: 'agent', entityId: id, action: 'token_issued', actorId: actor.userId, actorType: actor.actorType,
    diff: { tokenId, name: input.name, expiresAt: expiresAt?.toISOString() ?? null },
  });
  const [created] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
  return {
    token: raw,
    tokenInfo: {
      id: tokenId, name: input.name, prefix: created!.prefix, lastUsedAt: null,
      expiresAt: expiresAt?.toISOString() ?? null, createdAt: created!.createdAt.toISOString(),
    },
  };
}

export async function revokeExternalAgentToken(actor: Actor, id: string, tokenId: string): Promise<{ ok: true }> {
  const { db } = getDb();
  await loadRow(id);
  const [token] = await db.select({ id: apiTokens.id }).from(apiTokens)
    .where(and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, id)));
  if (!token) throw err.notFound('Token not found');
  await db.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, tokenId));
  await writeActivity(db, {
    entityType: 'agent', entityId: id, action: 'token_revoked', actorId: actor.userId, actorType: actor.actorType,
    diff: { tokenId },
  });
  return { ok: true };
}
