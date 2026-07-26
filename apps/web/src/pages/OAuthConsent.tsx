/**
 * The consent half of "connect an MCP client by logging in".
 *
 * An MCP client (Claude, Cursor, ...) sends the person here with standard
 * OAuth query params. If they are not signed in, Login brings them back via
 * ?next=. Approving asks the API to mint a one-time code and redirects to the
 * client's callback; the client then exchanges it for a token over PKCE.
 */
import { useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Bot, Check, ShieldCheck, X } from 'lucide-react';
import { api } from '../lib/api';
import { useMeQuery } from '../lib/auth';
import { Avatar, Button, Card, Spinner } from '../components/ui';
import { BrandMark } from '../components/BrandMark';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'oauth.title': 'Authorize access',
    'oauth.subtitle': '{client} wants to connect to your workspace.',
    'oauth.as': 'You are signed in as',
    'oauth.scopeHint': 'It will act with your permissions – it can do what you can do, nothing more. You can revoke access anytime in Settings → MCP.',
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
    'oauth.scopeHint': 'Він діятиме з вашими правами – зможе те саме, що й ви, і не більше. Доступ можна відкликати будь-коли в Налаштування → MCP.',
    'oauth.approve': 'Дозволити',
    'oauth.deny': 'Відхилити',
    'oauth.invalid': 'Запит на авторизацію некоректний або неповний. Почніть знову із застосунку, який підключаєте.',
    'oauth.unknownClient': 'Невідомий клієнт. Почніть знову із застосунку, який підключаєте.',
    'oauth.failed': 'Не вдалося завершити авторизацію. Почніть знову із застосунку, який підключаєте.',
    'oauth.redirecting': 'Повертаємо вас у застосунок...',
  },
});

interface ClientInfo { id: string; name: string }

export function OAuthConsentPage() {
  const t = useT();
  const me = useMeQuery();
  const [done, setDone] = useState(false);

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
  });

  const approve = useMutation({
    mutationFn: () => api.post<{ redirectTo: string }>('/oauth/approve', {
      clientId: params.clientId,
      redirectUri: params.redirectUri,
      state: params.state,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: 'S256',
    }),
    onSuccess: (r) => { setDone(true); window.location.href = r.redirectTo; },
  });

  const deny = () => {
    try {
      const url = new URL(params.redirectUri);
      url.searchParams.set('error', 'access_denied');
      if (params.state) url.searchParams.set('state', params.state);
      window.location.href = url.toString();
    } catch {
      window.location.href = '/';
    }
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

        <div className="mb-1 text-xs text-muted-foreground">{t('oauth.as')}</div>
        <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-border px-3 py-2.5">
          <Avatar name={me.data.user.name} src={me.data.user.avatar} size={26} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{me.data.user.name}</div>
            <div className="truncate text-xs text-faint">{me.data.user.email}</div>
          </div>
        </div>

        <p className="mb-5 flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck size={14} className="mt-0.5 shrink-0 text-success" />
          {t('oauth.scopeHint')}
        </p>

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

function safeHost(uri: string): string {
  try {
    const u = new URL(uri);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.host : `${u.protocol}//...`;
  } catch { return ''; }
}
