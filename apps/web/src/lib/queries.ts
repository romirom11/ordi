/**
 * Shared query hooks for lookups used across unrelated features.
 *
 * A React Query cache entry is keyed by name only, so two features fetching
 * the same endpoint under the same key MUST agree on the stored shape –
 * otherwise whichever mounts first wins and the other one reads the wrong
 * type at runtime. Anything shared lives here, unwrapped to a plain array.
 */
import { useMemo } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api, qs } from './api';

export interface UserLookup {
  id: string;
  /** Always set by the API – users cannot exist without a name. */
  name: string;
  email?: string | null;
  avatar?: string | null;
  /**
   * Deactivated users are included so historical records (comments, audit
   * rows, memberships) keep their name and photo. Pickers filter with
   * `activeUsers()`; renderers must not.
   */
  isActive?: boolean;
  /** `agent` marks an AI agent employee – rendered with a badge everywhere. */
  actorType?: string;
}

/** Everyone in the workspace, past and present – for resolving people on records. */
export function useUsersLookup(): UseQueryResult<UserLookup[]> {
  return useQuery({
    queryKey: ['users-lookup'],
    queryFn: () => api.get<{ data: UserLookup[] }>('/users/lookup').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

/** The pickable subset of a lookup result: people who can still be assigned. */
export function activeUsers<T extends { isActive?: boolean }>(users: T[] | undefined): T[] {
  return (users ?? []).filter((u) => u.isActive !== false);
}

/**
 * Alphabetical copy for pickers. The API lists newest-first (ULID desc), which
 * reads as random in a dropdown of fifty client names.
 */
export function byName<T extends { name: string }>(rows: T[] | undefined): T[] {
  return [...(rows ?? [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

export type ProjectMemberRole = 'admin' | 'member' | 'viewer';

export interface ProjectMember {
  projectId: string;
  userId: string;
  role: ProjectMemberRole;
  canWriteTasks: boolean;
}

/**
 * Which vocabulary a label belongs to. Task labels ("Bug", "Frontend"),
 * project labels ("Retainer", "Internal") and lead labels are separate sets –
 * a picker only ever shows its own.
 */
export type LabelScope = 'task' | 'project' | 'lead';

export interface LabelLookup { id: string; name: string; color?: string | null; scope?: LabelScope }

/** The label vocabulary of one scope – read by every picker and the filters. */
export function useLabels(scope: LabelScope): UseQueryResult<LabelLookup[]> {
  return useQuery({
    queryKey: ['labels', scope],
    queryFn: () => api.get<{ data: LabelLookup[] }>(`/labels${qs({ scope })}`).then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

/** Members of one project – read by both the properties rail and the access panel. */
export function useProjectMembers(projectId: string): UseQueryResult<ProjectMember[]> {
  return useQuery({
    queryKey: ['project-members', projectId],
    queryFn: () => api.get<{ data: ProjectMember[] }>(`/projects/${projectId}/members`).then((r) => r.data),
  });
}

export interface LeaveTypeLookup {
  id: string;
  name: string;
  isPaid?: boolean;
  needsApproval?: boolean;
  affectsBalance?: boolean;
  allowHalfDay?: boolean;
  /** numeric columns arrive as strings */
  annualQuota?: string | number;
  carryForwardLimit?: string | number;
  carryForwardExpiry?: string | null;
}

/** The absence vocabulary – read by the request form and edited in settings. */
export function useLeaveTypes(): UseQueryResult<LeaveTypeLookup[]> {
  return useQuery({
    queryKey: ['leaveTypes'],
    queryFn: () => api.get<{ data: LeaveTypeLookup[] }>('/leave-types').then((r) => r.data),
  });
}

export interface Holiday {
  id: string;
  /** 'YYYY-MM-DD' */
  date: string;
  name: string;
  calendarId?: string;
}

/** Public holidays from every calendar – the team calendar paints them, and a
 *  leave request is not charged for them. */
export function useHolidays(): UseQueryResult<Holiday[]> {
  return useQuery({
    queryKey: ['holidays'],
    queryFn: () => api.get<{ data: Holiday[] }>('/holidays').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

/**
 * The same list in the shape `leaveDays()` takes. This is every calendar, while
 * the API charges a request against the calendars assigned to that employee –
 * the same approximation the API itself falls back to while assignment has no
 * UI, and the API stays the authority on the number that is stored.
 */
export function useHolidaySet(): ReadonlySet<string> {
  const { data } = useHolidays();
  return useMemo(() => new Set((data ?? []).map((h) => (h.date ?? '').slice(0, 10))), [data]);
}

/** One leave type's standing for a person and period, as `/leave-entitlements` reports it. */
export interface LeaveEntitlement {
  leaveTypeId: string;
  leaveTypeName: string;
  period: string;
  allocated: number;
  carried: number;
  used: number;
  /** Days undecided requests already hold. */
  pending: number;
  /** allocated + carried − used − pending. */
  remaining: number;
  /** False for a type with no quota, or one that does not draw down a balance. */
  tracked: boolean;
  affectsBalance: boolean;
  allowHalfDay: boolean;
  annualQuota: number;
}

/**
 * Days still bookable per leave type. Without an employeeId this is the caller's
 * own card – self-service, no people.read needed; with one it is that person's,
 * which the API gates on people.read. Errors are not retried: an account with no
 * employee record has no entitlement to report and the card says so instead.
 */
export function useLeaveEntitlements(employeeId?: string): UseQueryResult<LeaveEntitlement[]> {
  return useQuery({
    queryKey: ['leave-entitlements', employeeId ?? 'me'],
    queryFn: () => api
      .get<{ data: LeaveEntitlement[] }>(`/leave-entitlements${qs({ employeeId })}`)
      .then((r) => r.data),
    retry: false,
  });
}

/**
 * The same lookup as a map, for tables that render an owner per row. Three CRM
 * tabs were each building this from `useUsersLookup` by hand, and one of them
 * forgot the memo so it rebuilt on every keystroke.
 */
export function useUserMap() {
  const usersQ = useUsersLookup();
  const byId = useMemo(
    () => new Map((usersQ.data ?? []).map((user) => [user.id, user])),
    [usersQ.data],
  );
  return byId;
}

/* ────────────────────────── AI agent employees ────────────────────────── */

/** An agent employee as `/agents` describes it (plan 2026-09-05-001). */
export interface AgentLookup {
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
  /** False while no active credential resolves for the agent. */
  dispatchable: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The workspace's agents – read by the Agents panel and by the member dialog,
 * which only needs to know that the list changed after it creates one.
 * Requires `agents.manage`, so callers without it pass `enabled: false`.
 */
export function useAgents(enabled = true): UseQueryResult<AgentLookup[]> {
  return useQuery({
    queryKey: ['agents'],
    queryFn: () => api.get<{ data: AgentLookup[] }>('/agents').then((r) => r.data),
    enabled,
  });
}

/** A workspace MCP connector as `/mcp-connectors` describes it. */
export interface McpConnectorLookup {
  id: string;
  slug: string;
  name: string;
  source: string;
  libraryKey: string | null;
  transport: string;
  url: string | null;
  command: string | null;
  args: string[];
  authMode: string;
  status: string;
  tools: { name: string; description?: string }[];
  toolCount: number;
  lastTestedAt: string | null;
  lastError: string | null;
  /** Which secret keys are stored – never their values. */
  secretKeys: string[];
  oauth: { authorized: boolean; authorizedBy: string | null; authorizedAt: string | null; pending: boolean } | null;
  agentCount: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/**
 * The connector library of this workspace – read by the Connectors panel, the
 * agent editor and the member dialog. Requires `integrations.manage`.
 */
export function useMcpConnectors(enabled = true): UseQueryResult<McpConnectorLookup[]> {
  return useQuery({
    queryKey: ['mcp-connectors'],
    queryFn: () => api.get<{ data: McpConnectorLookup[] }>('/mcp-connectors').then((r) => r.data),
    enabled,
  });
}
