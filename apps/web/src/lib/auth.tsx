import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from './api';
import { projectAccessRank, type AccessContext, type MeResponse } from '@ordi/shared';

export function useMeQuery(): UseQueryResult<MeResponse> {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<MeResponse>('/me'),
    retry: false,
    staleTime: 60_000,
  });
}

const MeContext = createContext<MeResponse | null>(null);

export function MeProvider({ me, children }: { me: MeResponse; children: ReactNode }) {
  return <MeContext.Provider value={me}>{children}</MeContext.Provider>;
}

export function useMe(): MeResponse {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe outside provider');
  return me;
}

export function useCan(): (permission: string) => boolean {
  const me = useMe();
  const set = new Set(me.permissions);
  return (permission: string) => set.has(permission);
}

export type ProjectRole = 'admin' | 'member' | 'viewer' | null;
const ROLE_OF_RANK: ProjectRole[] = [null, 'viewer', 'member', 'admin'];

/**
 * What the current user may do inside one project – the membership row, or what
 * a workspace project grants their permissions. Resolved with the same function
 * the API authorizes with, so the page never offers a control the server will
 * refuse (nor hides one it would allow, which is what a plain
 * `can('projects.write')` check did to project admins without that permission).
 *
 * `visibility` is undefined while the project loads; membership alone answers
 * until it arrives.
 */
export function useProjectRole(projectId: string, visibility?: 'workspace' | 'private'): ProjectRole {
  const me = useMe();
  return useMemo(() => {
    const ctx: AccessContext = {
      permissions: new Set(me.permissions),
      projectMemberships: new Map(me.projectMemberships.map((m) => [m.projectId, m.role as 'admin' | 'member' | 'viewer'])),
      spaceMemberships: new Map(me.spaceMemberships.map((m) => [m.spaceId, m.role as 'editor' | 'viewer'])),
    };
    const rank = projectAccessRank(ctx, { visibility: visibility ?? 'private', projectId });
    return ROLE_OF_RANK[rank] ?? null;
  }, [me, projectId, visibility]);
}
