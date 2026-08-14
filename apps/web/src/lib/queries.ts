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
