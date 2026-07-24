import type { AccessContext } from '@ordi/shared';

export interface Actor {
  userId: string;
  actorType: 'user' | 'agent' | 'system' | 'integration';
  roleId: string;
  roleName: string;
  email: string;
  name: string;
  locale: string;
  readOnly: boolean;
  /** null => full role scope (session); set => API-token scope subset. */
  tokenScopes: string[] | null;
  access: AccessContext;
}

export type Variables = {
  actor: Actor;
  requestId: string;
};

export type AppEnv = { Variables: Variables };
