/**
 * One client's connections made by signing in (Profile → MCP & API): the
 * client once, then each connection – a laptop, a server – with its own last
 * use and its own Revoke. See oauthConnections.ts for how they are grouped.
 */
import type { ReactNode } from 'react';
import { Link2 } from 'lucide-react';
import { Button } from '../ui';
import { useLocale, useT, extendDict } from '../../lib/i18n';
import { connectionsKey, type ConnectionGroup, type ConnectionLike } from './oauthConnections';

extendDict({
  en: {
    'oauth.connections.one': '{n} connection',
    'oauth.connections.other': '{n} connections',
    'oauth.signedIn': 'signed in {date}',
    'oauth.cleanup': 'Unused sign-ins are removed automatically after a day; idle ones after 90 days.',
  },
  uk: {
    'oauth.connections.one': '{n} підключення',
    'oauth.connections.few': '{n} підключення',
    'oauth.connections.many': '{n} підключень',
    'oauth.connections.other': '{n} підключення',
    'oauth.signedIn': 'вхід {date}',
    'oauth.cleanup': 'Невикористані входи видаляються автоматично через добу, неактивні – через 90 днів.',
  },
});

export function OAuthConnectionGroup<T extends ConnectionLike>({
  group, detail, badge, revokeLabel, onRevoke,
}: {
  group: ConnectionGroup<T>;
  /** What tells this connection apart: when it signed in, when it was last used. */
  detail: (tok: T) => ReactNode;
  badge?: ReactNode;
  revokeLabel: string;
  onRevoke: (tok: T) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const n = group.connections.length;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <Link2 size={15} />
        </div>
        <span className="truncate text-[13px] font-medium">{group.client}</span>
        <span className="shrink-0 text-xs text-faint">· {t(connectionsKey(n, locale)).replace('{n}', String(n))}</span>
        {badge}
      </div>
      <ul className="mt-1 space-y-0.5 pl-10">
        {group.connections.map((tok) => (
          <li key={tok.id} className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{detail(tok)}</span>
            <Button size="xs" variant="ghost" className="shrink-0 text-muted-foreground hover:text-destructive" onClick={() => onRevoke(tok)}>
              {revokeLabel}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
