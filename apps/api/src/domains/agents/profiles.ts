/**
 * Agent profiles (plan 2026-09-05-001, R1-R5, R44-R49). An agent is a
 * users row with actor_type = 'agent' plus a profile; creation, role, limits,
 * assign policy and connector grants are `agents.manage` operations. The
 * assign-policy check lives here because the task service calls it on every
 * assignment.
 */
import { getDb, schema, eq, and, inArray } from '@ordi/db';
import { ulid } from 'ulid';
import type { CreateAgentInput, UpdateAgentInput } from '@ordi/shared';
import type { Actor } from '../../context';
import { err } from '../../lib/errors';
import { writeActivity } from '../../core/activity';
import { assertVersion } from '../../core/locking';
import { resolveCredentialChain } from './credentials';

const { users, roles, agentProfiles, agentConnectors, mcpConnectors, projectMembers } = schema;

export interface AgentView {
  id: string;
  name: string;
  email: string;
  avatar: string | null;
  roleId: string;
  roleName: string;
  isActive: boolean;
  runtime: string;
  model: string | null;
  instructions: string;
  completionCategory: string;
  assignPolicy: string;
  maxRunMinutes: number;
  maxTurns: number;
  maxBudgetUsd: number | null;
  concurrency: number;
  credentialId: string | null;
  fallbackCredentialId: string | null;
  enabled: boolean;
  connectorIds: string[];
  projectIds: string[];
  /** False when no active credential resolves for this agent (R9). */
  dispatchable: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

async function loadView(userId: string): Promise<AgentView> {
  const { db } = getDb();
  const [row] = await db.select({
    user: users, profile: agentProfiles, roleName: roles.name,
  }).from(users)
    .innerJoin(agentProfiles, eq(agentProfiles.userId, users.id))
    .leftJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, userId));
  if (!row) throw err.notFound('Agent not found');
  const [grants, memberships, chain] = await Promise.all([
    db.select({ connectorId: agentConnectors.connectorId }).from(agentConnectors).where(eq(agentConnectors.agentUserId, userId)),
    db.select({ projectId: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.userId, userId)),
    resolveCredentialChain(row.profile),
  ]);
  const p = row.profile;
  return {
    id: row.user.id, name: row.user.name, email: row.user.email, avatar: row.user.avatar,
    roleId: row.user.roleId, roleName: row.roleName ?? '', isActive: row.user.isActive,
    runtime: p.runtime, model: p.model, instructions: p.instructions,
    completionCategory: p.completionCategory, assignPolicy: p.assignPolicy,
    maxRunMinutes: p.maxRunMinutes, maxTurns: p.maxTurns,
    maxBudgetUsd: p.maxBudgetUsd != null ? Number(p.maxBudgetUsd) : null,
    concurrency: p.concurrency, credentialId: p.credentialId, fallbackCredentialId: p.fallbackCredentialId,
    enabled: p.enabled,
    connectorIds: grants.map((g) => g.connectorId),
    projectIds: memberships.map((m) => m.projectId),
    dispatchable: p.enabled && row.user.isActive && chain.length > 0,
    version: p.version,
    createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
  };
}

export async function listAgents(): Promise<AgentView[]> {
  const { db } = getDb();
  const ids = await db.select({ userId: agentProfiles.userId }).from(agentProfiles).orderBy(agentProfiles.createdAt);
  return Promise.all(ids.map((r) => loadView(r.userId)));
}

export async function getAgent(userId: string): Promise<AgentView> {
  return loadView(userId);
}

async function assertConnectorsExist(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { db } = getDb();
  const rows = await db.select({ id: mcpConnectors.id }).from(mcpConnectors).where(inArray(mcpConnectors.id, ids));
  if (rows.length !== new Set(ids).size) throw err.validation('Unknown connector in connectorIds');
}

async function defaultAgentRoleId(): Promise<string> {
  const { db } = getDb();
  const [agentRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, 'agent'));
  if (agentRole) return agentRole.id;
  const [member] = await db.select({ id: roles.id }).from(roles).where(eq(roles.key, 'member'));
  if (member) return member.id;
  throw err.domain('No role available for the agent; create the Agent role first');
}

function agentEmail(id: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
  return `${slug}-${id.slice(-6).toLowerCase()}@agents.ordi.local`;
}

export async function createAgent(actor: Actor, input: CreateAgentInput): Promise<AgentView> {
  const { db } = getDb();
  await assertConnectorsExist(input.connectorIds);
  const roleId = input.roleId ?? await defaultAgentRoleId();
  const [role] = await db.select({ id: roles.id, key: roles.key }).from(roles).where(eq(roles.id, roleId));
  if (!role) throw err.validation('Unknown role');
  if (role.key === 'owner') throw err.domain('An agent cannot hold the Owner role');
  const id = ulid();
  const email = input.email ?? agentEmail(id, input.name);
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id, email, name: input.name, passwordHash: null, roleId, avatar: input.avatar ?? null,
      timezone: input.timezone ?? 'UTC', locale: input.locale ?? 'en', actorType: 'agent',
      emailNotificationPrefs: { __all: false },
    });
    await tx.insert(agentProfiles).values({
      userId: id, runtime: input.runtime, model: input.model ?? null, instructions: input.instructions,
      completionCategory: input.completionCategory, assignPolicy: input.assignPolicy,
      maxRunMinutes: input.maxRunMinutes, maxTurns: input.maxTurns,
      maxBudgetUsd: input.maxBudgetUsd != null ? String(input.maxBudgetUsd) : null,
      concurrency: input.concurrency, credentialId: input.credentialId ?? null,
      fallbackCredentialId: input.fallbackCredentialId ?? null, enabled: input.enabled, createdBy: actor.userId,
    });
    if (input.connectorIds.length) {
      await tx.insert(agentConnectors).values(input.connectorIds.map((connectorId) => ({ agentUserId: id, connectorId })));
    }
    await writeActivity(tx, {
      entityType: 'agent', entityId: id, action: 'created', actorId: actor.userId, actorType: actor.actorType,
      diff: { name: input.name, runtime: input.runtime, roleId, assignPolicy: input.assignPolicy, connectorIds: input.connectorIds },
    });
  });
  return loadView(id);
}

export async function updateAgent(actor: Actor, id: string, input: UpdateAgentInput): Promise<AgentView> {
  const { db } = getDb();
  const [row] = await db.select({ user: users, profile: agentProfiles }).from(users)
    .innerJoin(agentProfiles, eq(agentProfiles.userId, users.id)).where(eq(users.id, id));
  if (!row) throw err.notFound('Agent not found');
  assertVersion(row.profile, input.version, await loadView(id));
  if (input.connectorIds) await assertConnectorsExist(input.connectorIds);

  const userPatch: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) userPatch.name = input.name;
  if (input.avatar !== undefined) userPatch.avatar = input.avatar;
  if (input.roleId !== undefined) {
    const [role] = await db.select({ id: roles.id, key: roles.key }).from(roles).where(eq(roles.id, input.roleId));
    if (!role) throw err.validation('Unknown role');
    if (role.key === 'owner') throw err.domain('An agent cannot hold the Owner role');
    userPatch.roleId = input.roleId;
  }
  const profilePatch: Partial<typeof agentProfiles.$inferInsert> = {};
  for (const k of ['runtime', 'model', 'instructions', 'completionCategory', 'assignPolicy', 'maxRunMinutes', 'maxTurns', 'concurrency', 'credentialId', 'fallbackCredentialId', 'enabled'] as const) {
    if (input[k] !== undefined) (profilePatch as Record<string, unknown>)[k] = input[k];
  }
  if (input.maxBudgetUsd !== undefined) profilePatch.maxBudgetUsd = input.maxBudgetUsd != null ? String(input.maxBudgetUsd) : null;

  await db.transaction(async (tx) => {
    if (Object.keys(userPatch).length) await tx.update(users).set(userPatch).where(eq(users.id, id));
    if (Object.keys(profilePatch).length) {
      await tx.update(agentProfiles).set(profilePatch)
        .where(and(eq(agentProfiles.userId, id), eq(agentProfiles.version, row.profile.version)));
    }
    if (input.connectorIds) {
      await tx.delete(agentConnectors).where(eq(agentConnectors.agentUserId, id));
      if (input.connectorIds.length) {
        await tx.insert(agentConnectors).values(input.connectorIds.map((connectorId) => ({ agentUserId: id, connectorId })));
      }
    }
    await writeActivity(tx, {
      entityType: 'agent', entityId: id, action: 'updated', actorId: actor.userId, actorType: actor.actorType,
      diff: { ...userPatch, ...profilePatch, connectorIds: input.connectorIds },
    });
  });
  return loadView(id);
}

/** Disabling keeps history; the user row is deactivated so nothing dispatches or logs in. */
export async function setAgentActive(actor: Actor, id: string, active: boolean): Promise<AgentView> {
  const { db } = getDb();
  const [row] = await db.select({ id: agentProfiles.userId }).from(agentProfiles).where(eq(agentProfiles.userId, id));
  if (!row) throw err.notFound('Agent not found');
  await db.update(users).set({ isActive: active }).where(eq(users.id, id));
  await db.update(agentProfiles).set({ enabled: active }).where(eq(agentProfiles.userId, id));
  await writeActivity(db, {
    entityType: 'agent', entityId: id, action: active ? 'enabled' : 'disabled',
    actorId: actor.userId, actorType: actor.actorType,
  });
  return loadView(id);
}

// ── Assignment policy (R49) ──

export interface AgentAssignmentContext {
  /** Agent user ids among the assignees, with their policy. */
  agents: { userId: string; assignPolicy: string; enabled: boolean }[];
}

/** Which of the given user ids are agents, and their profiles. */
export async function agentProfilesAmong(userIds: string[]): Promise<Map<string, typeof agentProfiles.$inferSelect>> {
  const out = new Map<string, typeof agentProfiles.$inferSelect>();
  if (!userIds.length) return out;
  const { db } = getDb();
  const rows = await db.select().from(agentProfiles).where(inArray(agentProfiles.userId, userIds));
  for (const r of rows) out.set(r.userId, r);
  return out;
}

/**
 * Throw when the actor may not assign one of `assigneeIds` (an agent) on this
 * project: the agent must be a project member and the actor must satisfy the
 * agent's assign policy. Humans among the assignees are not checked here.
 */
export async function assertCanAssignAgents(
  actor: Actor,
  projectId: string,
  assigneeIds: string[],
  projectRole: 'admin' | 'member' | 'viewer' | null,
): Promise<void> {
  const profiles = await agentProfilesAmong(assigneeIds);
  if (profiles.size === 0) return;
  const { db } = getDb();
  const members = await db.select({ userId: projectMembers.userId }).from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), inArray(projectMembers.userId, [...profiles.keys()])));
  const memberSet = new Set(members.map((m) => m.userId));
  const canManage = actor.access.permissions.has('agents.manage');
  for (const [userId, profile] of profiles) {
    if (!memberSet.has(userId)) {
      throw err.domain('This agent is not a member of the project; add it under project members first', { code: 'agent_not_member', userId });
    }
    const allowed = profile.assignPolicy === 'project_members'
      ? projectRole === 'admin' || projectRole === 'member' || canManage
      : profile.assignPolicy === 'project_admins'
        ? projectRole === 'admin' || canManage
        : canManage;
    if (!allowed) {
      throw err.forbidden(
        profile.assignPolicy === 'agents_managers'
          ? 'Only people with agents.manage may assign work to this agent'
          : 'Only project admins may assign work to this agent',
        'agents.manage',
      );
    }
  }
}
