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
import { accessibleProjectIds, accessibleSpaceIds, editableSpaceIds, effectiveProjectRole } from '../../core/access';

const { users, roles, externalAgents, apiTokens, projectMembers, projects, spaceMembers } = schema;

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
  /** Projects it is on that the viewer cannot open. */
  hiddenProjects: number;
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

/**
 * An external agent's token is in someone's hands, so nobody hands out more
 * than they hold: giving the agent a role, or a token for it, needs every
 * permission that role grants. Without this, agents.manage alone would turn
 * into any role short of Owner – make the agent Admin, mint its token, use it.
 */
async function assertCanGrantRole(actor: Actor, roleId: string): Promise<void> {
  const granted = await loadRolePermissions(roleId);
  const missing = [...granted].filter((p) => !actor.access.permissions.has(p));
  if (missing.length) {
    throw err.forbidden(`This agent's role grants permissions you do not hold (${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''})`, missing[0]!);
  }
}

/** The owner is a person: questions without an addressee go to them. */
async function assertOwner(userId: string): Promise<void> {
  const { db } = getDb();
  const [owner] = await db.select({ isActive: users.isActive, actorType: users.actorType }).from(users).where(eq(users.id, userId));
  if (!owner || !owner.isActive || owner.actorType !== 'user') {
    throw err.validation('The owner must be an active person, not an agent');
  }
}

const PROJECT_RANK: Record<string, number> = { viewer: 1, member: 2, admin: 3 };

/**
 * A token works wherever the agent is a member, so whoever mints one must
 * reach all of that themselves, at the same level or higher: otherwise
 * agents.manage would open every private project or space an agent was ever
 * added to.
 */
async function assertCanReachAgentResources(actor: Actor, agentId: string): Promise<void> {
  const { db } = getDb();
  const [projectRows, spaceRows] = await Promise.all([
    db.select({ id: projects.id, key: projects.key, visibility: projects.visibility, role: projectMembers.role })
      .from(projectMembers).innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(and(eq(projectMembers.userId, agentId), isNull(projects.deletedAt))),
    db.select({ spaceId: spaceMembers.spaceId, role: spaceMembers.role }).from(spaceMembers).where(eq(spaceMembers.userId, agentId)),
  ]);
  const shortOf = projectRows.filter((p) => {
    const mine = effectiveProjectRole(actor, { id: p.id, visibility: p.visibility as 'workspace' | 'private' });
    return (mine ? PROJECT_RANK[mine]! : 0) < (PROJECT_RANK[p.role] ?? 0);
  });
  if (shortOf.length) {
    throw err.forbidden(`The agent works in projects you cannot reach at its level (${shortOf.map((p) => p.key).join(', ')}) – ask someone who can to issue its token`, 'projects.write');
  }
  if (spaceRows.length) {
    const [viewable, editable] = await Promise.all([accessibleSpaceIds(actor), editableSpaceIds(actor)]);
    const short = spaceRows.filter((s) => !(s.role === 'editor' ? editable : viewable).includes(s.spaceId));
    if (short.length) throw err.forbidden('The agent is a member of knowledge-base spaces you cannot reach at its level – ask someone who can to issue its token', 'kb.write');
  }
}

/**
 * Agents are set up by a person at the keyboard: not by an agent, and not
 * with an API token – otherwise a token could mint its own permanent successor.
 */
export function assertSignedInPerson(actor: Actor): void {
  if (actor.actorType === 'agent' || actor.apiTokenId) {
    throw err.forbidden('Managing external agents needs a signed-in person, not an API token', 'agents.manage');
  }
}

async function loadRow(id: string) {
  const { db } = getDb();
  const [row] = await db.select({ user: users, ext: externalAgents }).from(users)
    .innerJoin(externalAgents, eq(externalAgents.userId, users.id)).where(eq(users.id, id));
  if (!row) throw err.notFound('External agent not found');
  return row;
}

async function views(actor: Actor, ids: string[]): Promise<ExternalAgentView[]> {
  if (!ids.length) return [];
  const { db } = getDb();
  const reachable = new Set(await accessibleProjectIds(actor));
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
    // Projects the viewer cannot open are counted, not named.
    projects: memberships.filter((m) => m.userId === user.id && reachable.has(m.id)).map(({ id, key, name }) => ({ id, key, name })),
    hiddenProjects: memberships.filter((m) => m.userId === user.id && !reachable.has(m.id)).length,
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

export async function listExternalAgents(actor: Actor): Promise<ExternalAgentView[]> {
  const { db } = getDb();
  const rows = await db.select({ id: externalAgents.userId }).from(externalAgents);
  return views(actor, rows.map((r) => r.id));
}

export async function getExternalAgent(actor: Actor, id: string): Promise<ExternalAgentView> {
  await loadRow(id);
  return (await views(actor, [id]))[0]!;
}

export async function createExternalAgent(actor: Actor, input: CreateExternalAgentInput): Promise<ExternalAgentView> {
  const { db } = getDb();
  const roleId = input.roleId ?? await defaultAgentRoleId();
  await assertRole(roleId);
  await assertCanGrantRole(actor, roleId);
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
  return getExternalAgent(actor, id);
}

export async function updateExternalAgent(actor: Actor, id: string, input: UpdateExternalAgentInput): Promise<ExternalAgentView> {
  const { db } = getDb();
  await loadRow(id);
  const userPatch: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) userPatch.name = input.name;
  if (input.roleId !== undefined) {
    await assertRole(input.roleId);
    await assertCanGrantRole(actor, input.roleId);
    userPatch.roleId = input.roleId;
  }
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
  return getExternalAgent(actor, id);
}

/** Switching an agent off revokes every token it holds; switching it back on needs a new one. */
export async function setExternalAgentActive(actor: Actor, id: string, active: boolean): Promise<ExternalAgentView> {
  const { db } = getDb();
  await loadRow(id);
  await db.transaction(async (tx) => {
    // Takes the row lock token issuance waits on (see issueExternalAgentToken).
    await tx.update(users).set({ isActive: active }).where(eq(users.id, id));
    if (!active) {
      await tx.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.userId, id), isNull(apiTokens.revokedAt)));
    }
    await writeActivity(tx, {
      entityType: 'agent', entityId: id, action: active ? 'enabled' : 'disabled', actorId: actor.userId, actorType: actor.actorType,
    });
  });
  return getExternalAgent(actor, id);
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
  await assertCanGrantRole(actor, row.user.roleId);
  await assertCanReachAgentResources(actor, id);
  const raw = `ordi_${generateToken(24)}`;
  const tokenId = ulid();
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
  await db.transaction(async (tx) => {
    // The agent row stays locked until the token is in: a switch-off running
    // at the same time either comes first (and this refuses) or comes after
    // (and revokes this token with the rest).
    const [locked] = await tx.select({ isActive: users.isActive, roleId: users.roleId }).from(users).where(eq(users.id, id)).for('update');
    if (!locked?.isActive) throw err.domain('This agent is switched off; switch it on before issuing a token');
    // The role was checked against the issuer before the lock; a change in
    // between would mint a token wider than what was checked.
    if (locked.roleId !== row.user.roleId) throw err.conflict('The agent\'s role changed while the token was being issued – try again');
    const scopes = [...(await loadRolePermissions(locked.roleId))];
    await tx.insert(apiTokens).values({
      id: tokenId, userId: id, name: input.name, hash: sha256(raw), prefix: raw.slice(0, 12), scopes, readOnly: false, expiresAt,
    });
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
