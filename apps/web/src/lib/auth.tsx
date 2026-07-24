import { createContext, useContext, type ReactNode } from 'react';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from './api';
import type { MeResponse } from '@ordi/shared';

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
