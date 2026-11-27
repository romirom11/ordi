/**
 * Profile → MCP & API → My agent: one agent of your own for Claude Code,
 * Codex and the like. It works your tasks under its own name – it asks you
 * instead of writing as you – and can do only what you can, as a member at
 * most: tasks and the knowledge base, never finance, people, settings or
 * secrets. Each client gets its own token, so the comments it writes say
 * which one, and each can be cut off on its own.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, KeyRound } from 'lucide-react';
import { EXTERNAL_AGENT_TOKEN_DAYS, MY_AGENT_TOKEN_DEFAULT_DAYS } from '@ordi/shared';
import { api, ApiError } from '../../lib/api';
import { Avatar, Button, Input, Select, Skeleton, Spinner, Switch, cn, fmtDate, fmtRelative } from '../ui';
import { ConfirmDialog, toast } from '../overlays';
import { IssuedToken } from './ExternalAgentsSection';
import { useT, extendDict } from '../../lib/i18n';
import { myAgentView } from './myAgentView';
import { OAuthConnectionGroup } from './OAuthConnectionGroup';
import { groupConnections } from './oauthConnections';

extendDict({
  en: {
    'myAgent.title': 'My agent',
    'myAgent.desc': 'Run Claude Code, Codex or another client on your tasks under a name of its own: it asks you when unsure instead of writing as you, and it can only do what you can with tasks and the knowledge base – never finance, people, settings or secrets.',
    'myAgent.namePh': 'e.g. Jarvis',
    'myAgent.create': 'Create my agent',
    'myAgent.on': 'Switched on',
    'myAgent.onHint': 'Switching it off disconnects every client.',
    'myAgent.clients': 'Connected clients',
    'myAgent.noClients': 'No clients connected yet',
    'myAgent.connect': 'Connect a client',
    'myAgent.client': 'Client',
    'myAgent.other': 'Other',
    'myAgent.otherPh': 'Client name',
    'myAgent.validFor': 'Valid for',
    'myAgent.days': '{n} days',
    'myAgent.never': 'Never expires',
    'myAgent.lastUsed': 'last used {when}',
    'myAgent.neverUsed': 'not used yet',
    'myAgent.expires': 'expires {date}',
    'myAgent.disconnect': 'Disconnect',
    'myAgent.disconnectTitle': 'Disconnect this client?',
    'myAgent.disconnectBody': 'Its token stops working at the next request.',
    'myAgent.disconnected': 'Client disconnected',
    'myAgent.offTitle': 'Switch your agent off?',
    'myAgent.offBody': 'Every connected client is disconnected for good: switching it back on needs a new token for each.',
    'myAgent.off': 'Switch off',
    'myAgent.asYou': 'A client that connects by signing in through the browser asks whether it works as your agent or as you.',
    'myAgent.viaSignIn': 'connected by signing in',
  },
  uk: {
    'myAgent.title': 'Мій агент',
    'myAgent.desc': 'Запускайте Claude Code, Codex чи інший клієнт на своїх задачах під окремим іменем: коли щось незрозуміло, він питає вас, а не пише від вашого імені, і може лише те, що й ви, із задачами та базою знань – ніколи фінанси, людей, налаштування чи секрети.',
    'myAgent.namePh': 'напр. Jarvis',
    'myAgent.create': 'Створити мого агента',
    'myAgent.on': 'Увімкнено',
    'myAgent.onHint': 'Вимкнення відключає всі клієнти.',
    'myAgent.clients': 'Підключені клієнти',
    'myAgent.noClients': 'Ще жодного клієнта',
    'myAgent.connect': 'Підключити клієнт',
    'myAgent.client': 'Клієнт',
    'myAgent.other': 'Інший',
    'myAgent.otherPh': 'Назва клієнта',
    'myAgent.validFor': 'Термін дії',
    'myAgent.days': '{n} днів',
    'myAgent.never': 'Безстроковий',
    'myAgent.lastUsed': 'востаннє {when}',
    'myAgent.neverUsed': 'ще не використовувався',
    'myAgent.expires': 'діє до {date}',
    'myAgent.disconnect': 'Відключити',
    'myAgent.disconnectTitle': 'Відключити цей клієнт?',
    'myAgent.disconnectBody': 'Його токен перестане працювати на наступному запиті.',
    'myAgent.disconnected': 'Клієнт відключено',
    'myAgent.offTitle': 'Вимкнути вашого агента?',
    'myAgent.offBody': 'Усі підключені клієнти буде відключено назавжди: після ввімкнення кожному знадобиться новий токен.',
    'myAgent.off': 'Вимкнути',
    'myAgent.asYou': 'Клієнт, що підключається через вхід у браузері, питає, чи працювати як ваш агент, чи як ви.',
    'myAgent.viaSignIn': 'підключено через вхід',
  },
});

interface AgentToken { id: string; name: string; prefix: string; lastUsedAt: string | null; expiresAt: string | null; createdAt?: string | null; oauth?: boolean }
interface MyAgent { id: string; name: string; avatar: string | null; isActive: boolean; tokens: AgentToken[] }

const CLIENTS = ['Claude Code', 'Codex', 'Cursor'] as const;
const KEY = ['my-agent'];

export function MyAgentCard() {
  const t = useT();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api.get<{ agent: MyAgent | null }>('/my-agent').then((r) => r.agent) });
  const refresh = () => { qc.invalidateQueries({ queryKey: KEY }); qc.invalidateQueries({ queryKey: ['users-lookup'] }); };
  const apiError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed'));
  const view = myAgentView(q);

  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.post('/my-agent', { name: name.trim() }),
    onSuccess: () => { setName(''); refresh(); },
    onError: apiError,
  });

  return (
    <div className="mb-8 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint"><Bot size={13} /> {t('myAgent.title')}</div>
      <p className="mt-1 text-xs text-muted-foreground">{t('myAgent.desc')}</p>
      {view === 'loading' ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : view === 'error' ? (
        <div className="mt-3 flex items-center gap-2 text-[13px] text-muted-foreground">
          {t('common.loadFailed')}
          <Button size="xs" variant="ghost" onClick={() => q.refetch()}>{t('common.retry')}</Button>
        </div>
      ) : view === 'none' || !q.data ? (
        <form className="mt-3 flex gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
          <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={t('myAgent.namePh')} className="max-w-xs" />
          <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>{create.isPending && <Spinner />} {t('myAgent.create')}</Button>
        </form>
      ) : (
        <AgentDetails agent={q.data} onChanged={refresh} onError={apiError} />
      )}
      <p className="mt-3 text-[11px] text-faint">{t('myAgent.asYou')} {t('oauth.cleanup')}</p>
    </div>
  );
}

function AgentDetails({ agent, onChanged, onError }: { agent: MyAgent; onChanged: () => void; onError: (e: unknown) => void }) {
  const t = useT();
  const [name, setName] = useState(agent.name);
  const [client, setClient] = useState<string>(CLIENTS[0]);
  const [otherClient, setOtherClient] = useState('');
  const [days, setDays] = useState(String(MY_AGENT_TOKEN_DEFAULT_DAYS));
  const [issued, setIssued] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<AgentToken | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  // A token issued through a sign-in is named after its client: those are
  // grouped by client, tokens issued here stay one per row.
  const { groups, others } = groupConnections(agent.tokens, (tok) => (tok.oauth ? tok.name : null));
  const lastUsed = (tok: AgentToken) => (tok.lastUsedAt ? t('myAgent.lastUsed').replace('{when}', fmtRelative(tok.lastUsedAt)) : t('myAgent.neverUsed'));
  const expiry = (tok: AgentToken) => (tok.expiresAt ? t('myAgent.expires').replace('{date}', fmtDate(tok.expiresAt)) : t('myAgent.never'));
  // Renamed elsewhere (another tab) or put back after a failed rename.
  useEffect(() => { setName(agent.name); }, [agent.name]);

  const rename = useMutation({
    mutationFn: (n: string) => api.patch('/my-agent', { name: n }),
    onSuccess: onChanged,
    onError: (e) => { setName(agent.name); onError(e); },
  });
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.post(`/my-agent/${on ? 'enable' : 'disable'}`),
    onSuccess: (_r, on) => { setConfirmOff(false); if (!on) setIssued(null); onChanged(); },
    onError: (e) => { setConfirmOff(false); onError(e); },
  });
  const clientName = client === 'other' ? otherClient.trim() : client;
  const issue = useMutation({
    mutationFn: () => api.post<{ token: string }>('/my-agent/tokens', { client: clientName, expiresInDays: days === 'never' ? null : Number(days) }),
    onSuccess: (r) => { setIssued(r.token); onChanged(); },
    onError,
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/my-agent/tokens/${id}`),
    // The token shown once may be the one just cut off: do not leave it on screen.
    onSuccess: () => { setRevoking(null); setIssued(null); onChanged(); toast(t('myAgent.disconnected')); },
    onError: (e) => { setRevoking(null); onError(e); },
  });

  return (
    <div className="mt-3 space-y-4">
      <div className="flex items-center gap-3">
        <Avatar name={agent.name} src={agent.avatar} size={28} agent className={agent.isActive ? undefined : 'opacity-50'} />
        <Input value={name} maxLength={60} className="max-w-xs" onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const next = name.trim();
            if (!next) setName(agent.name);
            else if (next !== agent.name) rename.mutate(next);
          }} />
        <div className="ml-auto flex items-center gap-2" title={t('myAgent.onHint')}>
          <span className="text-xs text-muted-foreground">{t('myAgent.on')}</span>
          <Switch checked={agent.isActive} disabled={toggle.isPending} onChange={(v) => (v ? toggle.mutate(true) : setConfirmOff(true))} label={t('myAgent.on')} />
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t('myAgent.clients')}</div>
        <div className="rounded-lg border border-border">
          {agent.tokens.length === 0 ? (
            <p className="px-3 py-2.5 text-[13px] text-muted-foreground">{t('myAgent.noClients')}</p>
          ) : (
            <>
              {groups.map((group, i) => (
                <div key={`client:${group.client}`} className={cn('flex items-center gap-3 px-3 py-2', i > 0 && 'border-t border-border')}>
                  <OAuthConnectionGroup
                    group={group}
                    badge={<span className="truncate text-xs text-muted-foreground">· {t('myAgent.viaSignIn')}</span>}
                    revokeLabel={t('myAgent.disconnect')}
                    onRevoke={setRevoking}
                    detail={(tok) => <><span className="font-mono text-[11px]">{tok.prefix}…</span>{' · '}{lastUsed(tok)}{' · '}{expiry(tok)}</>}
                  />
                </div>
              ))}
              {others.map((tok, j) => (
                <div key={tok.id} className={cn('flex items-center gap-3 px-3 py-2', groups.length + j > 0 && 'border-t border-border')}>
                  <span className="text-[13px] font-medium">{tok.name}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                    {lastUsed(tok)}{' · '}{expiry(tok)}
                  </span>
                  <Button size="xs" variant="ghost" className="text-destructive" onClick={() => setRevoking(tok)}>{t('myAgent.disconnect')}</Button>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-xs font-medium text-muted-foreground">{t('myAgent.connect')}</div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={client} onChange={(e) => setClient(e.target.value)} className="h-8 w-36 text-xs" aria-label={t('myAgent.client')}>
            {CLIENTS.map((c) => <option key={c} value={c}>{c}</option>)}
            <option value="other">{t('myAgent.other')}</option>
          </Select>
          {client === 'other' && (
            <Input value={otherClient} maxLength={40} onChange={(e) => setOtherClient(e.target.value)} placeholder={t('myAgent.otherPh')} className="h-8 w-40 text-xs" />
          )}
          <Select value={days} onChange={(e) => setDays(e.target.value)} className="h-8 w-36 text-xs" aria-label={t('myAgent.validFor')}>
            {EXTERNAL_AGENT_TOKEN_DAYS.map((d) => <option key={d} value={String(d)}>{t('myAgent.days').replace('{n}', String(d))}</option>)}
            <option value="never">{t('myAgent.never')}</option>
          </Select>
          <Button size="sm" disabled={!agent.isActive || !clientName || issue.isPending} onClick={() => issue.mutate()}>
            {issue.isPending ? <Spinner /> : <KeyRound size={13} />} {t('myAgent.connect')}
          </Button>
        </div>
        {issued && <div className="mt-3"><IssuedToken token={issued} /></div>}
      </div>

      <ConfirmDialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={() => toggle.mutate(false)}
        title={t('myAgent.offTitle')}
        body={t('myAgent.offBody')}
        confirmLabel={t('myAgent.off')}
        danger
        pending={toggle.isPending}
      />
      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => { if (revoking) revoke.mutate(revoking.id); }}
        title={t('myAgent.disconnectTitle')}
        // Several connections of one client look alike: name the one going.
        body={revoking ? `${revoking.name} (${revoking.prefix}…). ${t('myAgent.disconnectBody')}` : t('myAgent.disconnectBody')}
        confirmLabel={t('myAgent.disconnect')}
        danger
        pending={revoke.isPending}
      />
    </div>
  );
}
