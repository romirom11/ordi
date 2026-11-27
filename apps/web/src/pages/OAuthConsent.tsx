/**
 * The consent half of "connect an MCP client by logging in".
 *
 * An MCP client (Claude, Cursor, ...) sends the person here with standard
 * OAuth query params. If they are not signed in, Login brings them back via
 * ?next=. Approving asks the API to mint a one-time code and redirects to the
 * client's callback; the client then exchanges it for a token over PKCE.
 *
 * A person with an agent of their own chooses who the client works as: their
 * agent (the default – its own name, their reach, tasks and the knowledge base
 * only) or themselves. The API decides which agent; the page only says "mine".
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Bot, Check, ShieldCheck, X } from 'lucide-react';
import { api } from '../lib/api';
import { useMeQuery } from '../lib/auth';
import { Avatar, Button, Card, Spinner, cn } from '../components/ui';
import { BrandMark } from '../components/BrandMark';
import { useT, extendDict } from '../lib/i18n';
import { denyRedirect } from '../lib/oauthRedirect';

extendDict({
  en: {
    'oauth.title': 'Authorize access',
    'oauth.subtitle': '{client} wants to connect to your workspace.',
    'oauth.as': 'You are signed in as',
    'oauth.scopeHint': 'It will act with your permissions – it can do what you can do, nothing more. You can revoke access anytime in Profile → MCP & API.',
    'oauth.connectAs': 'Connect it as',
    'oauth.asAgent': 'As my agent {name}',
    'oauth.asAgentHint': 'It works under its agent name and asks you when unsure. It can do only what you can with tasks and the knowledge base, never finance, people, settings or secrets.',
    'oauth.asMe': 'As me',
    'oauth.asMeHint': 'It acts with your permissions and writes under your name.',
    'oauth.revokeHint': 'You can disconnect it anytime in Profile → MCP & API.',
    'oauth.noAgent': 'Want it to work under a name of its own instead of yours?',
    'oauth.noAgentLink': 'Create your agent in Profile → MCP & API',
    'oauth.agentOff': 'Your agent {name} is switched off. Switch it on in Profile → MCP & API to connect as it.',
    'oauth.approve': 'Authorize',
    'oauth.deny': 'Deny',
    'oauth.invalid': 'This authorization request is invalid or incomplete. Start again from the app you are connecting.',
    'oauth.unknownClient': 'Unknown client. Start again from the app you are connecting.',
    'oauth.failed': 'Could not complete the authorization. Start again from the app you are connecting.',
    'oauth.redirecting': 'Taking you back to the app...',
  },
  uk: {
    'oauth.title': 'Надати доступ',
    'oauth.subtitle': '{client} хоче підключитися до вашого воркспейсу.',
    'oauth.as': 'Ви увійшли як',
    'oauth.scopeHint': 'Він діятиме з вашими правами – зможе те саме, що й ви, і не більше. Доступ можна відкликати будь-коли в Профіль → MCP і API.',
    'oauth.connectAs': 'Підключити як',
    'oauth.asAgent': 'Як мій агент {name}',
    'oauth.asAgentHint': 'Він працює під іменем агента і питає вас, коли щось незрозуміло. Може лише те, що й ви, із задачами та базою знань, ніколи фінанси, людей, налаштування чи секрети.',
    'oauth.asMe': 'Як я',
    'oauth.asMeHint': 'Він діє з вашими правами і пише від вашого імені.',
    'oauth.revokeHint': 'Відключити його можна будь-коли в Профіль → MCP і API.',
    'oauth.noAgent': 'Хочете, щоб він працював під окремим іменем, а не вашим?',
    'oauth.noAgentLink': 'Створіть агента в Профіль → MCP і API',
    'oauth.agentOff': 'Ваш агент {name} вимкнений. Увімкніть його в Профіль → MCP і API, щоб підключитися як він.',
    'oauth.approve': 'Дозволити',
    'oauth.deny': 'Відхилити',
    'oauth.invalid': 'Запит на авторизацію некоректний або неповний. Почніть знову із застосунку, який підключаєте.',
    'oauth.unknownClient': 'Невідомий клієнт. Почніть знову із застосунку, який підключаєте.',
    'oauth.failed': 'Не вдалося завершити авторизацію. Почніть знову із застосунку, який підключаєте.',
    'oauth.redirecting': 'Повертаємо вас у застосунок...',
  },
});

interface ClientInfo { id: string; name: string; redirectUris: string[]; myAgent: { name: string; isActive: boolean } | null }
type ActAs = 'me' | 'agent';

export function OAuthConsentPage() {
  const t = useT();
  const me = useMeQuery();
  const [done, setDone] = useState(false);
  // null until the person picks: then their own agent, when it can be used, is the default.
  const [picked, setPicked] = useState<ActAs | null>(null);

  const params = useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    return {
      responseType: q.get('response_type') ?? '',
      clientId: q.get('client_id') ?? '',
      redirectUri: q.get('redirect_uri') ?? '',
      state: q.get('state') ?? undefined,
      codeChallenge: q.get('code_challenge') ?? '',
      codeChallengeMethod: q.get('code_challenge_method') ?? '',
    };
  }, []);

  const paramsOk = params.responseType === 'code' && !!params.clientId
    && !!params.redirectUri && !!params.codeChallenge && params.codeChallengeMethod === 'S256';

  const client = useQuery({
    queryKey: ['oauth-client', params.clientId],
    queryFn: () => api.get<ClientInfo>(`/oauth/client?client_id=${encodeURIComponent(params.clientId)}`),
    enabled: paramsOk && !!me.data,
    retry: false,
    // Back from creating or switching on their agent in the other tab: offer it now.
    refetchOnWindowFocus: true,
  });

  const canAsAgent = !!client.data?.myAgent?.isActive;
  const actAs: ActAs = picked ?? (canAsAgent ? 'agent' : 'me');

  const approve = useMutation({
    mutationFn: () => api.post<{ redirectTo: string }>('/oauth/approve', {
      actAs: canAsAgent ? actAs : 'me',
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: 'S256',
    }),
    onSuccess: (r) => { setDone(true); window.location.href = r.redirectTo; },
  });

  // Back to the client only at a redirect it registered: the request's own
  // redirect_uri is whatever the link said, and could be javascript:.
  const deny = () => {
    window.location.href = denyRedirect(client.data?.redirectUris ?? [], params.redirectUri, params.state) ?? '/';
  };

  // Not signed in → login first, then straight back here with the same query.
  if (me.isError) {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
    return null;
  }
  if (me.isLoading || !me.data) {
    return <div className="grid h-screen place-items-center"><Spinner /></div>;
  }

  const shell = (body: React.ReactNode) => (
    <div className="grid min-h-screen place-items-center bg-background p-4">
      <Card className="w-full max-w-md p-6">
        <div className="mb-5 flex flex-col items-center gap-3 text-center">
          <BrandMark size={40} />
          {body === null ? null : body}
        </div>
      </Card>
    </div>
  );

  if (!paramsOk) {
    return shell(<p className="text-sm text-muted-foreground">{t('oauth.invalid')}</p>);
  }
  if (client.isError) {
    return shell(<p className="text-sm text-muted-foreground">{t('oauth.unknownClient')}</p>);
  }
  if (client.isLoading || !client.data) {
    return shell(<Spinner />);
  }
  if (done) {
    return shell(<p className="text-sm text-muted-foreground">{t('oauth.redirecting')}</p>);
  }

  return (
    <div className="grid min-h-screen place-items-center bg-background p-4">
      <Card className="w-full max-w-md p-6">
        <div className="mb-5 flex flex-col items-center gap-3 text-center">
          <BrandMark size={40} />
          <div>
            <h1 className="text-lg font-semibold">{t('oauth.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('oauth.subtitle').replace('{client}', client.data.name)}
            </p>
          </div>
        </div>

        <div className="mb-4 flex items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
          <Bot size={18} className="shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium">{client.data.name}</div>
            <div className="truncate text-xs text-faint">{safeHost(params.redirectUri)}</div>
          </div>
        </div>

        {canAsAgent ? (
          <>
            <div className="mb-1 text-xs text-muted-foreground">{t('oauth.connectAs')}</div>
            <div role="radiogroup" aria-label={t('oauth.connectAs')} className="mb-4 space-y-2">
              <ActAsOption
                checked={actAs === 'agent'}
                onSelect={() => setPicked('agent')}
                avatar={<Avatar name={client.data.myAgent!.name} size={26} agent />}
                title={t('oauth.asAgent').replace('{name}', client.data.myAgent!.name)}
                hint={t('oauth.asAgentHint')}
              />
              <ActAsOption
                checked={actAs === 'me'}
                onSelect={() => setPicked('me')}
                avatar={<Avatar name={me.data.user.name} src={me.data.user.avatar} size={26} />}
                title={`${t('oauth.asMe')} (${me.data.user.name})`}
                hint={t('oauth.asMeHint')}
              />
            </div>
            <p className="mb-5 flex items-start gap-2 text-xs text-muted-foreground">
              <ShieldCheck size={14} className="mt-0.5 shrink-0 text-success" />
              {t('oauth.revokeHint')}
            </p>
          </>
        ) : (
          <>
            <div className="mb-1 text-xs text-muted-foreground">{t('oauth.as')}</div>
            <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5">
              <Avatar name={me.data.user.name} src={me.data.user.avatar} size={26} />
              <div className="min-w-0">
                <div className="truncate text-[13px] font-medium">{me.data.user.name}</div>
                <div className="truncate text-xs text-faint">{me.data.user.email}</div>
              </div>
            </div>

            <p className="mb-3 flex items-start gap-2 text-xs text-muted-foreground">
              <ShieldCheck size={14} className="mt-0.5 shrink-0 text-success" />
              {t('oauth.scopeHint')}
            </p>
            <p className="mb-5 text-xs text-faint">
              {client.data.myAgent
                ? t('oauth.agentOff').replace('{name}', client.data.myAgent.name)
                : <>{t('oauth.noAgent')}{' '}
                  {/* A new tab: the consent request stays open here to approve afterwards. */}
                  <a href="/profile/mcp" target="_blank" rel="noopener" className="text-primary underline-offset-2 hover:underline">{t('oauth.noAgentLink')}</a></>}
            </p>
          </>
        )}

        {approve.isError && <p className="mb-3 text-sm text-destructive">{t('oauth.failed')}</p>}

        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={deny} disabled={approve.isPending}>
            <X size={14} /> {t('oauth.deny')}
          </Button>
          <Button className="flex-1" onClick={() => approve.mutate()} disabled={approve.isPending}>
            {approve.isPending ? <Spinner /> : <Check size={14} />} {t('oauth.approve')}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function ActAsOption({ checked, onSelect, avatar, title, hint }: {
  checked: boolean;
  onSelect: () => void;
  avatar: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <label className={cn(
      'flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5',
      checked ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
    )}>
      <input type="radio" name="actAs" className="mt-1.5 shrink-0" checked={checked} onChange={onSelect} />
      <span className="shrink-0">{avatar}</span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium">{title}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

function safeHost(uri: string): string {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : `${u.protocol}//...`;
  } catch { return ''; }
}
