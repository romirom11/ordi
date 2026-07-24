/**
 * Shared query hooks for lookups used across unrelated features.
 *
 * A React Query cache entry is keyed by name only, so two features fetching
 * the same endpoint under the same key MUST agree on the stored shape –
 * otherwise whichever mounts first wins and the other one reads the wrong
 * type at runtime. Anything shared lives here, unwrapped to a plain array.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from './api';

export interface UserLookup {
  id: string;
  /** Always set by the API – users cannot exist without a name. */
  name: string;
  email?: string | null;
  avatar?: string | null;
}

/** Everyone the current user can assign work to / add as a member. */
export function useUsersLookup(): UseQueryResult<UserLookup[]> {
  return useQuery({
    queryKey: ['users-lookup'],
    queryFn: () => api.get<{ data: UserLookup[] }>('/users/lookup').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}
