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
import { PERSONAL_AGENT_PERMISSIONS, type CreateExternalAgentInput, type UpdateExternalAgentInput } from '@ordi/shared';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { generateToken, sha256 } from '../../lib/crypto';
import { writeActivity } from '../../core/activity';
import { loadRolePermissions } from '../../core/rbac';
import {
  accessibleProjectIds, accessibleSpaceIds, editableSpaceIds, effectiveProjectRolesIncludingDeleted,
} from '../../core/access';

const { users, roles, externalAgents, apiTokens, projectMembers, projects, spaceMembers } = schema;

export interface ExternalAgentToken {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
  /** Issued when a client connected by signing in (OAuth), not made by hand. */
  oauth: boolean;
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
  /** 'team' – a shared bot; 'personal' – someone's own agent (Profile → MCP & API). */
  kind: 'team' | 'personal';
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
export async function assertCanGrantRole(actor: Actor, roleId: string): Promise<void> {
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
    // Deleted projects too: a token minted now still works there once the
    // project is restored.
    db.select({ id: projects.id, key: projects.key, visibility: projects.visibility, role: projectMembers.role })
      .from(projectMembers).innerJoin(projects, eq(projects.id, projectMembers.projectId))
      .where(eq(projectMembers.userId, agentId)),
    db.select({ spaceId: spaceMembers.spaceId, role: spaceMembers.role }).from(spaceMembers).where(eq(spaceMembers.userId, agentId)),
  ]);
  const roles = await effectiveProjectRolesIncludingDeleted(actor, projectRows.map((p) => ({ id: p.id, visibility: p.visibility as 'workspace' | 'private' })));
  const shortOf = projectRows.filter((p) => {
    const mine = roles.get(p.id) ?? null;
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
    kind: ext.kind === 'personal' ? 'personal' as const : 'team' as const,
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
        oauth: !!t.oauthClientId,
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
    // The owner checked again under a lock deactivation also takes: an agent
    // cannot be created for someone whose departure is being processed.
    const [owner] = await tx.select({ isActive: users.isActive, actorType: users.actorType }).from(users)
      .where(eq(users.id, ownerUserId)).for('share');
    if (!owner?.isActive || owner.actorType !== 'user') throw err.validation('The owner must be an active person, not an agent');
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
  const row = await loadRow(id);
  if (row.ext.kind === 'personal' && (input.ownerUserId !== undefined || input.roleId !== undefined)) {
    throw err.domain('A personal agent belongs to its owner and works with their reach – its owner and role do not change');
  }
  const userPatch: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) userPatch.name = input.name;
  if (input.roleId !== undefined) {
    await assertRole(input.roleId);
    await assertCanGrantRole(actor, input.roleId);
    userPatch.roleId = input.roleId;
  }
  if (input.ownerUserId !== undefined) await assertOwner(input.ownerUserId);
  const ownerChanges = input.ownerUserId !== undefined && input.ownerUserId !== row.ext.ownerUserId;
  await db.transaction(async (tx) => {
    if (ownerChanges) {
      // Person before agent – the order deactivation locks them in – and the
      // new owner checked again under the lock, so a deactivation running at
      // the same time cannot be handed an agent it has already passed over.
      const [next] = await tx.select({ isActive: users.isActive, actorType: users.actorType }).from(users)
        .where(eq(users.id, input.ownerUserId!)).for('share');
      if (!next?.isActive || next.actorType !== 'user') throw err.validation('The owner must be an active person, not an agent');
      await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for('update');
    }
    if (Object.keys(userPatch).length) await tx.update(users).set(userPatch).where(eq(users.id, id));
    if (ownerChanges) {
      await tx.update(externalAgents).set({ ownerUserId: input.ownerUserId! }).where(eq(externalAgents.userId, id));
      // The previous owner may hold a copy of its tokens: the new owner starts fresh.
      await tx.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.userId, id), isNull(apiTokens.revokedAt)));
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
  const row = await loadRow(id);
  await db.transaction(async (tx) => {
    if (active) {
      // Person before agent, the order deactivation locks them in, and the
      // owner read again under the lock: an owner leaving right now is seen.
      const [owner] = await tx.select({ isActive: users.isActive, actorType: users.actorType }).from(users)
        .where(eq(users.id, row.ext.ownerUserId)).for('share');
      // Then the agent's user row – the lock owner changes hold while they
      // rewrite the owner – so the owner read next is the current one.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, id)).for('update');
      const [still] = await tx.select({ ownerUserId: externalAgents.ownerUserId }).from(externalAgents)
        .where(eq(externalAgents.userId, id));
      if (!owner?.isActive || owner.actorType !== 'user' || still?.ownerUserId !== row.ext.ownerUserId) {
        throw err.domain('Its owner is no longer active – give it a new owner before switching it on');
      }
    }
    // Takes the row lock token issuance waits on (see issueExternalAgentToken).
    await tx.update(users).set({ isActive: active }).where(eq(users.id, id));
    if (!active) {
      await tx.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.userId, id), isNull(apiTokens.revokedAt)));
      // A consent given before the switch-off must not turn into a token
      // once it is back on: pending sign-ins as this agent are dropped too.
      await tx.delete(schema.oauthAuthCodes).where(eq(schema.oauthAuthCodes.agentUserId, id));
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
  if (row.ext.kind === 'personal') throw err.forbidden('Only its owner issues tokens for a personal agent, in their Profile', 'agents.manage');
  await assertCanGrantRole(actor, row.user.roleId);
  await assertCanReachAgentResources(actor, id);
  const raw = `ordi_${generateToken(24)}`;
  const tokenId = ulid();
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
  await db.transaction(async (tx) => {
    // Person before agent, the order deactivation takes them in: an issuer
    // being deactivated right now is seen as inactive here, not after.
    const [issuer] = await tx.select({ isActive: users.isActive }).from(users).where(eq(users.id, actor.userId)).for('share');
    if (!issuer?.isActive) throw err.forbidden('Your account is no longer active', 'agents.manage');
    // The agent row stays locked until the token is in: a switch-off running
    // at the same time either comes first (and this refuses) or comes after
    // (and revokes this token with the rest).
    const [locked] = await tx.select({ isActive: users.isActive, roleId: users.roleId }).from(users).where(eq(users.id, id)).for('update');
    if (!locked?.isActive) throw err.domain('This agent is switched off; switch it on before issuing a token');
    // The role was checked against the issuer before the lock; a change in
    // between would mint a token wider than what was checked.
    if (locked.roleId !== row.user.roleId) throw err.conflict('The agent\'s role changed while the token was being issued – try again');
    // Same for the role's contents: the scopes are read again here, so a
    // permission added to the role since the check must not slip in.
    const scopes = [...(await loadRolePermissions(locked.roleId, tx))];
    if (scopes.some((p) => !actor.access.permissions.has(p))) {
      throw err.conflict('The agent\'s role changed while the token was being issued – try again');
    }
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
      expiresAt: expiresAt?.toISOString() ?? null, createdAt: created!.createdAt.toISOString(), oauth: false,
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

/** The external agents a person owns – what deactivating them would leave behind. */
export async function externalAgentsOwnedBy(userId: string): Promise<{ id: string; name: string; isActive: boolean; kind: string }[]> {
  const { db } = getDb();
  // `kind` tells the deactivation dialog which go to the successor (team
  // bots) and which are switched off whatever happens (their own agent).
  return db.select({ id: users.id, name: users.name, isActive: users.isActive, kind: externalAgents.kind }).from(externalAgents)
    .innerJoin(users, eq(users.id, externalAgents.userId))
    .where(eq(externalAgents.ownerUserId, userId))
    .orderBy(users.name);
}

/**
 * A person is leaving: the agents that work for them must not keep working on
 * tokens they may have a copy of. Every token of each agent they own is
 * revoked. With a successor who is a person the agents move to them – still
 * switched on, waiting for a fresh token; otherwise they are switched off.
 *
 * Runs inside the deactivation's transaction, after it has locked the
 * person's row: owner changes and token issuance lock the person before the
 * agent (see below), so neither can slip in between and survive.
 */
export async function handOverOwnedAgents(
  tx: any,
  actor: Actor,
  fromUserId: string,
  toUserId: string | null,
): Promise<{ id: string; name: string; outcome: 'transferred' | 'disabled' }[]> {
  const owned: { id: string; name: string; kind: string }[] = await tx.select({ id: users.id, name: users.name, kind: externalAgents.kind })
    .from(externalAgents)
    .innerJoin(users, eq(users.id, externalAgents.userId))
    .where(eq(externalAgents.ownerUserId, fromUserId))
    .orderBy(users.name)
    .for('update', { of: users });
  if (!owned.length) return [];
  let successor: string | null = null;
  if (toUserId) {
    const [next] = await tx.select({ isActive: users.isActive, actorType: users.actorType }).from(users).where(eq(users.id, toUserId)).for('share');
    if (next?.isActive && next.actorType === 'user') successor = toUserId;
  }
  // A personal agent is its owner's and nobody else's: it is switched off,
  // never handed on. A team bot moves to the successor when there is one.
  const moved = successor ? owned.filter((a) => a.kind !== 'personal').map((a) => a.id) : [];
  const stopped = owned.filter((a) => !moved.includes(a.id)).map((a) => a.id);
  await tx.update(apiTokens).set({ revokedAt: new Date() }).where(and(inArray(apiTokens.userId, owned.map((a) => a.id)), isNull(apiTokens.revokedAt)));
  if (moved.length) await tx.update(externalAgents).set({ ownerUserId: successor! }).where(inArray(externalAgents.userId, moved));
  if (stopped.length) await tx.update(users).set({ isActive: false }).where(inArray(users.id, stopped));
  await tx.delete(schema.oauthAuthCodes).where(inArray(schema.oauthAuthCodes.agentUserId, owned.map((a) => a.id)));
  for (const agent of owned) {
    const transferred = moved.includes(agent.id);
    await writeActivity(tx, {
      entityType: 'agent', entityId: agent.id, action: transferred ? 'owner_handed_over' : 'disabled',
      actorId: actor.userId, actorType: actor.actorType,
      diff: { fromOwner: fromUserId, toOwner: transferred ? successor : null, reason: 'owner_deactivated' },
    });
  }
  return owned.map((a) => ({ id: a.id, name: a.name, outcome: moved.includes(a.id) ? 'transferred' as const : 'disabled' as const }));
}

// ── A person's own agent (Profile → MCP & API) ──

/** The caller's own agent, or null. */
export async function getMyAgent(actor: Actor): Promise<ExternalAgentView | null> {
  const { db } = getDb();
  const [row] = await db.select({ id: externalAgents.userId }).from(externalAgents)
    .where(and(eq(externalAgents.ownerUserId, actor.userId), eq(externalAgents.kind, 'personal')));
  return row ? (await views(actor, [row.id]))[0]! : null;
}

async function myAgentId(actor: Actor): Promise<string> {
  const mine = await getMyAgent(actor);
  if (!mine) throw err.notFound('You have no agent yet – create one first');
  return mine.id;
}

function assertPerson(actor: Actor): void {
  assertSignedInPerson(actor);
  if (actor.actorType !== 'user') throw err.forbidden('Only a person has an agent of their own', 'projects.read');
}

/**
 * Anyone signed in may have one agent of their own. It needs no role or
 * memberships: every request it makes is held to what its owner can do then,
 * as a member at most (see buildPersonalAgentAccess).
 */
export async function createMyAgent(actor: Actor, name: string): Promise<ExternalAgentView> {
  assertPerson(actor);
  const { db } = getDb();
  if (await getMyAgent(actor)) throw err.domain('You already have an agent – rename it, or connect more clients to it');
  const roleId = await defaultAgentRoleId();
  const id = ulid();
  try {
    await db.transaction(async (tx) => {
      const [me] = await tx.select({ isActive: users.isActive }).from(users).where(eq(users.id, actor.userId)).for('share');
      if (!me?.isActive) throw err.forbidden('Your account is no longer active', 'projects.read');
      await tx.insert(users).values({
        id, email: agentEmail(id, name), name, passwordHash: null, roleId,
        actorType: 'agent', emailNotificationPrefs: { __all: false },
      });
      await tx.insert(externalAgents).values({ userId: id, ownerUserId: actor.userId, kind: 'personal', createdBy: actor.userId });
      await writeActivity(tx, {
        entityType: 'agent', entityId: id, action: 'created', actorId: actor.userId, actorType: actor.actorType,
        diff: { name, kind: 'personal', ownerUserId: actor.userId },
      });
    });
  } catch (e) {
    // Two tabs at once: the one-per-person index decides. The driver's code
    // sits on the error itself or, wrapped by the ORM, on its cause.
    const pg = e as { code?: string; cause?: { code?: string } };
    if ((pg.code ?? pg.cause?.code) === '23505') throw err.domain('You already have an agent');
    throw e;
  }
  return (await views(actor, [id]))[0]!;
}

export async function renameMyAgent(actor: Actor, name: string): Promise<ExternalAgentView> {
  assertPerson(actor);
  const id = await myAgentId(actor);
  const { db } = getDb();
  await db.update(users).set({ name }).where(eq(users.id, id));
  await writeActivity(db, { entityType: 'agent', entityId: id, action: 'updated', actorId: actor.userId, actorType: actor.actorType, diff: { name } });
  return (await views(actor, [id]))[0]!;
}

export async function setMyAgentActive(actor: Actor, active: boolean): Promise<ExternalAgentView> {
  assertPerson(actor);
  return setExternalAgentActive(actor, await myAgentId(actor), active);
}

/**
 * A token for one client – "Claude Code", "Codex" – so each can be cut off on
 * its own and the agent's comments say which one wrote them.
 */
export async function issueMyAgentToken(
  actor: Actor,
  input: { client: string; expiresInDays: number | null },
): Promise<{ token: string; tokenInfo: ExternalAgentToken }> {
  assertPerson(actor);
  const id = await myAgentId(actor);
  const { db } = getDb();
  const raw = `ordi_${generateToken(24)}`;
  const tokenId = ulid();
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null;
  await db.transaction(async (tx) => {
    // Owner before agent, the order deactivation takes them in.
    const [me] = await tx.select({ isActive: users.isActive }).from(users).where(eq(users.id, actor.userId)).for('share');
    if (!me?.isActive) throw err.forbidden('Your account is no longer active', 'projects.read');
    const [locked] = await tx.select({ isActive: users.isActive }).from(users).where(eq(users.id, id)).for('update');
    if (!locked?.isActive) throw err.domain('Your agent is switched off; switch it on before connecting a client');
    await tx.insert(apiTokens).values({
      // The scope is the most a personal agent may ever do; each request is
      // narrowed further to what its owner can do at that moment.
      id: tokenId, userId: id, name: input.client, hash: sha256(raw), prefix: raw.slice(0, 12),
      scopes: [...PERSONAL_AGENT_PERMISSIONS], readOnly: false, expiresAt,
    });
  });
  await writeActivity(db, {
    entityType: 'agent', entityId: id, action: 'token_issued', actorId: actor.userId, actorType: actor.actorType,
    diff: { tokenId, client: input.client, expiresAt: expiresAt?.toISOString() ?? null },
  });
  const [created] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
  return {
    token: raw,
    tokenInfo: {
      id: tokenId, name: input.client, prefix: created!.prefix, lastUsedAt: null,
      expiresAt: expiresAt?.toISOString() ?? null, createdAt: created!.createdAt.toISOString(), oauth: false,
    },
  };
}

export async function revokeMyAgentToken(actor: Actor, tokenId: string): Promise<{ ok: true }> {
  assertPerson(actor);
  return revokeExternalAgentToken(actor, await myAgentId(actor), tokenId);
}

/** Which of these users are someone's own agent – never assigned, never a member of anything. */
export async function personalAgentIds(userIds: string[]): Promise<Set<string>> {
  if (!userIds.length) return new Set();
  const { db } = getDb();
  const rows = await db.select({ id: externalAgents.userId }).from(externalAgents)
    .where(and(inArray(externalAgents.userId, userIds), eq(externalAgents.kind, 'personal')));
  return new Set(rows.map((r) => r.id));
}

/** The own agents of these people (at most one each). */
export async function personalAgentIdsOf(ownerUserIds: string[]): Promise<string[]> {
  if (!ownerUserIds.length) return [];
  const { db } = getDb();
  const rows = await db.select({ id: externalAgents.userId }).from(externalAgents)
    .where(and(inArray(externalAgents.ownerUserId, ownerUserIds), eq(externalAgents.kind, 'personal')));
  return rows.map((r) => r.id);
}

export async function assertNotPersonalAgent(userId: string, what: string): Promise<void> {
  if ((await personalAgentIds([userId])).size) {
    throw err.validation(`A personal agent works its owner's tasks with its owner's access, so it cannot be ${what}`);
  }
}
