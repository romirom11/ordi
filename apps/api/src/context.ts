import type { AccessContext } from '@ordi/shared';

export interface Actor {
  userId: string;
  actorType: 'user' | 'agent' | 'system' | 'integration';
  roleId: string;
  roleName: string;
  email: string;
  name: string;
  locale: string;
  timezone: string;
  readOnly: boolean;
  /** null => full role scope (session); set => API-token scope subset. */
  tokenScopes: string[] | null;
  /** The API token the request came with; agent runs are recognised by theirs. */
  apiTokenId?: string | null;
  /** A person's own agent: whose it is. Its reach is that person's, bounded. */
  ownerUserId?: string | null;
  agentKind?: 'personal' | null;
  /** For a personal agent: the client it connected with ("Codex"), from its token's name. */
  clientLabel?: string | null;
  access: AccessContext;
}

export type Variables = {
  actor: Actor;
  requestId: string;
  /**
   * Set by a route whose answer is not a document read (the audit feed):
   * file paths in it are signed only for a reader with a right of their own
   * to the file (core/file-links).
   */
  fileLinksStrict?: boolean;
};

export type AppEnv = { Variables: Variables };
