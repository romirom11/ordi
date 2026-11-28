/**
 * Profile → MCP & API, top to bottom:
 *   1. Connect a client – pick the client, copy one thing. Signing in through
 *      the browser is the way; a token is the fallback behind a disclosure.
 *   2. Connections – everything that can act for the person: their own
 *      agent's clients and the clients connected as them, in one list.
 *   3. Your agent – its name and switch, what it can do behind a disclosure.
 *   4. Tokens for scripts – collapsed; they connect no client.
 */
import { useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Copy, KeyRound, Plug, Plus, Trash2, TriangleAlert, UserRound } from 'lucide-react';
import { EXTERNAL_AGENT_TOKEN_DAYS, MY_AGENT_TOKEN_DEFAULT_DAYS } from '@ordi/shared';
import { appOrigin, api, ApiError } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { Button, Input, Badge, Checkbox, SegmentedControl, Select, Switch, Skeleton, Spinner, fmtDate, fmtRelative, cn } from '../ui';
import { Dialog, ConfirmDialog, toast } from '../overlays';
import { SectionHead, SubHead, Field, RowList, Disclosure } from './primitives';
import { useLocale, useT, extendDict } from '../../lib/i18n';
import { MyAgentSection, useMyAgent } from './MyAgentSection';
import { buildConnections, connectionsKey, connectionsView, pluralKey, scriptTokens, showIssued, type ActsAs, type Connection, type ConnectionGroup, type IssuedToken, type OwnToken } from './connections';
import { CLIENT_NAMES, MCP_CLIENTS, signInSetup, tokenSetup, type McpClient } from './mcpClients';

extendDict({
  en: {
    'settings.mcp': 'MCP & API',
    'settings.mcpDesc': 'Connect an AI client to ordi and see which clients can act as you or your agent.',
    // 1. Connect a client
    'mcp.connectTitle': 'Connect a client',
    'mcp.clientOther': 'Other',
    'mcp.clientPicker': 'Your client',
    'mcp.step.terminal': 'Run in a terminal:',
    'mcp.step.desktop': 'In Claude Desktop, open Settings → Connectors → Add custom connector, and paste:',
    'mcp.step.cursor': 'Add to ~/.cursor/mcp.json:',
    'mcp.step.codex': 'Add to ~/.codex/config.toml:',
    'mcp.step.other': 'Add ordi as a remote MCP server at:',
    'mcp.step.desktopConfig': 'Add to claude_desktop_config.json. It runs ordi’s MCP server from a copy of the ordi repository:',
    'mcp.step.otherToken': 'Add ordi as a remote MCP server that sends this header:',
    'mcp.step.stdio': 'No remote MCP support? Run ordi’s MCP server from the root of a copy of the ordi repository:',
    'mcp.signInChoice': 'The client opens your browser so you can sign in. If your agent is switched on, you choose at sign-in whether the client works as your agent or as you.',
    'mcp.copied': 'Copied to clipboard.',
    'mcp.checkNotApi': 'Your proxy answers /.well-known/ with the web app, not the API',
    'mcp.checkNotApiFix': 'MCP clients look for {url} at the root of this domain. Route /.well-known/ to the API, the same place /api/ goes.',
    'mcp.checkScheme': 'Discovery advertises {issuer} on an https site',
    'mcp.checkSchemeFix': 'The API cannot see the original scheme. Pass X-Forwarded-Proto through your proxy, or set APP_URL to {origin}.',
    'mcp.checkHost': 'Discovery advertises {issuer}, not this address',
    'mcp.checkHostFix': 'Pass the Host header through your proxy, or set APP_URL to {origin}.',
    'mcp.checkFailed': 'Could not reach the discovery document',
    'mcp.checkFailedFix': 'MCP clients read {url} before anything else. Until it answers, connecting will fail.',
    // … with a token
    'mcp.tokenToggle': 'No browser? Connect with a token',
    'mcp.tokenIntro': 'For a client that can’t open a browser to sign in.',
    'mcp.tokenRisk.you': 'Anyone with this token can act with your permissions in ordi. Keep it private.',
    'mcp.tokenRisk.agent': 'Anyone with this token can act as your agent in ordi, with only what your agent may do. Keep it private.',
    'mcp.tokenFirst': 'Create the token, and the setup appears here with it filled in.',
    'mcp.localServer': 'Set up a local MCP server',
    'mcp.worksAs': 'Works as',
    'mcp.asAgent': 'Your agent',
    'mcp.asYou': 'You',
    'mcp.asYouOnly': 'It works as you. To connect it as your agent, create your agent or switch it on below.',
    'mcp.clientName': 'Client name',
    'mcp.clientNamePh': 'e.g. Zed',
    'mcp.validFor': 'Valid for',
    'mcp.days': '{n} days',
    'mcp.neverExpires': 'Never expires',
    'mcp.issueToken': 'Create token for {client}',
    'mcp.issueFailed': 'Could not create the token.',
    'mcp.tokenOnceWarning': 'Copy the token now – it will not be shown again.',
    'mcp.issuedFor': 'For {client}, works as: {whom}.',
    'mcp.agentLoadFailed': 'Could not check your agent, so no token can be made yet.',
    'mcp.copyFailed': 'Could not copy. Select the text and copy it yourself.',
    // 2. Connections
    'mcp.connections': 'Connections',
    'mcp.connectionsHint': 'Clients connected as you or your agent.',
    'mcp.someFailed': 'Some connections couldn’t be loaded.',
    'mcp.noConnections': 'No clients connected yet',
    'mcp.noConnectionsHint': 'Pick your client above and paste what it shows. The client appears here once it signs in.',
    'mcp.signedIn': 'signed in {date}',
    'mcp.tokenMade': 'token made {date}',
    'mcp.lastUsed': 'last used {when}',
    'mcp.neverUsed': 'not used yet',
    'mcp.expires': 'expires {date}',
    'mcp.disconnect': 'Disconnect',
    'mcp.disconnectTitle': 'Disconnect {client}?',
    'mcp.disconnectBody': '{what} loses access at its next request. To use it again, connect it again.',
    'mcp.disconnected': 'Disconnected.',
    'mcp.disconnectFailed': 'Could not disconnect.',
    'oauth.connections.one': '{n} connection',
    'oauth.connections.other': '{n} connections',
    'oauth.cleanup': 'Unused sign-ins are removed automatically after a day; idle ones after 90 days.',
    // 4. Tokens for scripts
    'mcp.scripts': 'Tokens for scripts',
    'mcp.scriptsHint': 'For CI and your own scripts that call the ordi API. A token acts as you, narrowed to the permissions you pick.',
    'mcp.noScripts': 'No tokens for scripts yet.',
    'mcp.showRevoked': 'Show revoked ({n})',
    'mcp.hideRevoked': 'Hide revoked',
    'mcp.createToken': 'Create token',
    'mcp.tokenName': 'Token name',
    'mcp.tokenNamePlaceholder': 'e.g. CI deploy',
    'mcp.readOnly': 'Read-only',
    'mcp.readOnlyHint': 'The script will only read data, no actions.',
    'mcp.scopes': 'Permissions',
    'mcp.permissions.one': '{n} permission',
    'mcp.permissions.other': '{n} permissions',
    'mcp.scopesSelected': '{n} selected',
    'mcp.selectAll': 'Select all',
    'mcp.clearAll': 'Clear',
    'mcp.scopeRequired': 'Pick at least one permission.',
    'mcp.tokenCreated': 'Token created.',
    'mcp.tokenCreateFailed': 'Could not create the token.',
    'mcp.loadFailed': 'Could not load your connections.',
    'mcp.created': 'Created {date}',
    'mcp.never': 'never',
    'mcp.revoked': 'Revoked',
    'mcp.revoke': 'Revoke',
    'mcp.revokeTitle': 'Revoke token',
    'mcp.revokeBody': 'Revoke "{name}"? Scripts using this token lose access immediately.',
    'mcp.tokenRevoked': 'Token revoked.',
    'mcp.revokeFailed': 'Could not revoke the token.',
  },
  uk: {
    'settings.mcp': 'MCP і API',
    'settings.mcpDesc': 'Підключіть AI-клієнт до ordi та подивіться, які клієнти можуть діяти від вашого імені чи від імені вашого агента.',
    'mcp.connectTitle': 'Підключити клієнт',
    'mcp.clientOther': 'Інший',
    'mcp.clientPicker': 'Ваш клієнт',
    'mcp.step.terminal': 'Виконайте в терміналі:',
    'mcp.step.desktop': 'У Claude Desktop відкрийте Settings → Connectors → Add custom connector і вставте:',
    'mcp.step.cursor': 'Додайте в ~/.cursor/mcp.json:',
    'mcp.step.codex': 'Додайте в ~/.codex/config.toml:',
    'mcp.step.other': 'Додайте ordi як віддалений MCP-сервер за адресою:',
    'mcp.step.desktopConfig': 'Додайте в claude_desktop_config.json. Він запускає MCP-сервер ordi з копії репозиторію ordi:',
    'mcp.step.otherToken': 'Додайте ordi як віддалений MCP-сервер із таким заголовком:',
    'mcp.step.stdio': 'Клієнт без віддаленого MCP? Запустіть MCP-сервер ordi з кореня копії репозиторію ordi:',
    'mcp.signInChoice': 'Клієнт відкриє браузер, щоб ви увійшли. Якщо ваш агент увімкнений, під час входу ви оберете, чи працюватиме клієнт як ваш агент, чи як ви.',
    'mcp.copied': 'Скопійовано в буфер обміну.',
    'mcp.checkNotApi': 'Ваш проксі віддає на /.well-known/ вебзастосунок, а не API',
    'mcp.checkNotApiFix': 'MCP-клієнти шукають {url} у корені цього домену. Спрямуйте /.well-known/ в API, туди ж, куди йде /api/.',
    'mcp.checkScheme': 'Дискавері віддає {issuer} на https-сайті',
    'mcp.checkSchemeFix': 'API не бачить оригінальної схеми. Передайте X-Forwarded-Proto через проксі або задайте APP_URL = {origin}.',
    'mcp.checkHost': 'Дискавері віддає {issuer}, а не цю адресу',
    'mcp.checkHostFix': 'Передайте заголовок Host через проксі або задайте APP_URL = {origin}.',
    'mcp.checkFailed': 'Не вдалося отримати документ дискавері',
    'mcp.checkFailedFix': 'MCP-клієнти читають {url} найпершим. Поки він не відповідає, підключення не спрацює.',
    'mcp.tokenToggle': 'Без браузера? Підключіться через токен',
    'mcp.tokenIntro': 'Для клієнта, який не може відкрити браузер для входу.',
    'mcp.tokenRisk.you': 'Будь-хто з цим токеном може діяти в ordi з вашими дозволами. Нікому його не показуйте.',
    'mcp.tokenRisk.agent': 'Будь-хто з цим токеном може діяти в ordi як ваш агент – лише в межах того, що дозволено агентові. Нікому його не показуйте.',
    'mcp.tokenFirst': 'Створіть токен – і тут з’явиться готове налаштування, уже з ним.',
    'mcp.localServer': 'Налаштувати локальний MCP-сервер',
    'mcp.worksAs': 'Працює як',
    'mcp.asAgent': 'Ваш агент',
    'mcp.asYou': 'Ви',
    'mcp.asYouOnly': 'Він працюватиме як ви. Щоб підключити його як вашого агента, створіть агента або увімкніть його нижче.',
    'mcp.clientName': 'Назва клієнта',
    'mcp.clientNamePh': 'напр. Zed',
    'mcp.validFor': 'Термін дії',
    'mcp.days': '{n} днів',
    'mcp.neverExpires': 'Безстроковий',
    'mcp.issueToken': 'Створити токен для {client}',
    'mcp.issueFailed': 'Не вдалося створити токен.',
    'mcp.tokenOnceWarning': 'Скопіюйте токен зараз – він більше не показуватиметься.',
    'mcp.issuedFor': 'Для {client}, працює як: {whom}.',
    'mcp.agentLoadFailed': 'Не вдалося перевірити вашого агента, тож токен поки не створити.',
    'mcp.copyFailed': 'Не вдалося скопіювати. Виділіть текст і скопіюйте його самі.',
    'mcp.connections': 'Підключення',
    'mcp.connectionsHint': 'Клієнти, підключені від вашого імені чи від імені вашого агента.',
    'mcp.someFailed': 'Не вдалося завантажити частину підключень.',
    'mcp.noConnections': 'Ще жодного підключеного клієнта',
    'mcp.noConnectionsHint': 'Оберіть свій клієнт вище і вставте те, що він показує. Клієнт з’явиться тут, щойно увійде.',
    'mcp.signedIn': 'вхід {date}',
    'mcp.tokenMade': 'токен від {date}',
    'mcp.lastUsed': 'востаннє {when}',
    'mcp.neverUsed': 'ще не використовувався',
    'mcp.expires': 'діє до {date}',
    'mcp.disconnect': 'Відключити',
    'mcp.disconnectTitle': 'Відключити {client}?',
    'mcp.disconnectBody': '{what} втратить доступ на наступному запиті. Щоб користуватися знову, підключіть його ще раз.',
    'mcp.disconnected': 'Відключено.',
    'mcp.disconnectFailed': 'Не вдалося відключити.',
    'oauth.connections.one': '{n} підключення',
    'oauth.connections.few': '{n} підключення',
    'oauth.connections.many': '{n} підключень',
    'oauth.connections.other': '{n} підключення',
    'oauth.cleanup': 'Невикористані входи видаляються автоматично через добу, неактивні – через 90 днів.',
    'mcp.scripts': 'Токени для скриптів',
    'mcp.scriptsHint': 'Для CI і ваших скриптів, що звертаються до API ordi. Токен діє від вашого імені в межах обраних дозволів.',
    'mcp.noScripts': 'Ще немає токенів для скриптів.',
    'mcp.showRevoked': 'Показати відкликані ({n})',
    'mcp.hideRevoked': 'Сховати відкликані',
    'mcp.createToken': 'Створити токен',
    'mcp.tokenName': 'Назва токена',
    'mcp.tokenNamePlaceholder': 'напр. CI deploy',
    'mcp.readOnly': 'Лише читання',
    'mcp.readOnlyHint': 'Скрипт тільки читатиме дані, без дій.',
    'mcp.scopes': 'Дозволи',
    'mcp.permissions.one': '{n} дозвіл',
    'mcp.permissions.few': '{n} дозволи',
    'mcp.permissions.many': '{n} дозволів',
    'mcp.permissions.other': '{n} дозволу',
    'mcp.scopesSelected': 'обрано: {n}',
    'mcp.selectAll': 'Обрати всі',
    'mcp.clearAll': 'Очистити',
    'mcp.scopeRequired': 'Оберіть щонайменше один дозвіл.',
    'mcp.tokenCreated': 'Токен створено.',
    'mcp.tokenCreateFailed': 'Не вдалося створити токен.',
    'mcp.loadFailed': 'Не вдалося завантажити ваші підключення.',
    'mcp.created': 'Створено {date}',
    'mcp.never': 'ніколи',
    'mcp.revoked': 'Відкликано',
    'mcp.revoke': 'Відкликати',
    'mcp.revokeTitle': 'Відкликати токен',
    'mcp.revokeBody': 'Відкликати «{name}»? Скрипти з цим токеном одразу втратять доступ.',
    'mcp.tokenRevoked': 'Токен відкликано.',
    'mcp.revokeFailed': 'Не вдалося відкликати токен.',
  },
});

const TOKENS_KEY = ['apiTokens'];

function useOwnTokens() {
  // Back from signing a client in through another tab: the new connection shows up.
  return useQuery({ queryKey: TOKENS_KEY, queryFn: () => api.get<{ data: OwnToken[] }>('/auth/tokens').then((r) => r.data), refetchOnWindowFocus: true });
}

export function McpPanel() {
  const t = useT();
  return (
    <div>
      <SectionHead title={t('settings.mcp')} desc={t('settings.mcpDesc')} />
      <ConnectSection />
      <ConnectionsSection />
      <MyAgentSection />
      <ScriptTokensSection />
    </div>
  );
}

/* ───────────────────────────── 1. Connect a client ───────────────────────────── */

function ConnectSection() {
  const t = useT();
  const [client, setClient] = useState<McpClient>('claude-code');
  const mcpUrl = `${appOrigin()}/api/v1/mcp`;
  const setup = signInSetup(client, mcpUrl);

  return (
    <section className="mb-10" aria-labelledby="mcp-connect">
      <SubHead title={<span id="mcp-connect">{t('mcp.connectTitle')}</span>} />
      <div role="group" aria-label={t('mcp.clientPicker')}>
        <SegmentedControl<McpClient>
          value={client}
          onChange={setClient}
          className="min-h-8 w-full max-w-xl text-xs"
          options={MCP_CLIENTS.map((key) => ({ key, label: key === 'other' ? t('mcp.clientOther') : CLIENT_NAMES[key] }))}
        />
      </div>
      <p className="mt-3 text-[13px] text-muted-foreground">{t(setup.step)}</p>
      <Snippet value={setup.snippet} primary className="mt-1.5" />
      <p className="mt-2 text-xs text-muted-foreground">{t('mcp.signInChoice')}</p>
      <DiscoveryCheck />
      <Disclosure label={t('mcp.tokenToggle')} className="mt-4">
        <TokenConnect client={client} mcpUrl={mcpUrl} />
      </Disclosure>
    </section>
  );
}

/**
 * The fallback for a client that cannot open a browser: a token for the
 * client picked above, as the person's agent or as the person, with an expiry.
 */
function TokenConnect({ client, mcpUrl }: { client: McpClient; mcpUrl: string }) {
  const t = useT();
  const qc = useQueryClient();
  const agent = useMyAgent();
  const own = useOwnTokens();
  // Whom the token acts as is never guessed: until the agent lookup answers,
  // nothing can be made, so a slow answer cannot turn into a token as you.
  const agentKnown = agent.data !== undefined;
  const agentOn = !!agent.data?.isActive;
  const [picked, setPicked] = useState<ActsAs | null>(null);
  const actsAs: ActsAs = agentOn ? (picked ?? 'agent') : 'you';
  const [otherName, setOtherName] = useState('');
  const [days, setDays] = useState(String(MY_AGENT_TOKEN_DEFAULT_DAYS));
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const clientName = client === 'other' ? otherName.trim() : CLIENT_NAMES[client];

  const issue = useMutation({
    mutationFn: async (): Promise<IssuedToken> => {
      const body = { client: clientName, expiresInDays: days === 'never' ? null : Number(days) };
      const made = { client, clientName, actsAs };
      if (actsAs === 'agent') {
        const r = await api.post<{ token: string; tokenInfo: { id: string } }>('/my-agent/tokens', body);
        return { ...made, id: r.tokenInfo.id, token: r.token, at: Date.now() };
      }
      const r = await api.post<{ id: string; token: string }>('/auth/tokens/client', body);
      return { ...made, id: r.id, token: r.token, at: Date.now() };
    },
    onSuccess: (made) => {
      setIssued(made);
      qc.invalidateQueries({ queryKey: TOKENS_KEY });
      qc.invalidateQueries({ queryKey: ['my-agent'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('mcp.issueFailed')),
  });

  const shown = showIssued(
    issued, { client, clientName, actsAs },
    { own: own.data, ownAt: own.dataUpdatedAt, agent: agent.data?.tokens, agentAt: agent.dataUpdatedAt },
  );
  // Only a real token is ever put into something to copy: a placeholder
  // would hand over a setup that cannot work.
  const setup = shown ? tokenSetup(client, mcpUrl, appOrigin(), issued.token) : null;
  const whom = actsAs === 'agent' ? t('mcp.asAgent') : t('mcp.asYou');

  return (
    <div className="space-y-3 pb-1 pl-5 pt-3">
      <p className="text-xs text-muted-foreground">{t('mcp.tokenIntro')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground" id="mcp-works-as">{t('mcp.worksAs')}</div>
          {agentOn ? (
            <div role="group" aria-labelledby="mcp-works-as">
              <SegmentedControl<ActsAs>
                value={actsAs}
                onChange={setPicked}
                className="h-8 w-56 text-xs"
                options={[
                  { key: 'agent', label: t('mcp.asAgent') },
                  { key: 'you', label: t('mcp.asYou') },
                ]}
              />
            </div>
          ) : (
            <div className="flex h-8 items-center"><ActsAsLabel actsAs="you" /></div>
          )}
        </div>
        {client === 'other' && (
          <Field label={t('mcp.clientName')}>
            <Input value={otherName} maxLength={40} onChange={(e) => setOtherName(e.target.value)} placeholder={t('mcp.clientNamePh')} className="h-8 w-40 text-xs" />
          </Field>
        )}
        <Field label={t('mcp.validFor')}>
          <Select value={days} onChange={(e) => setDays(e.target.value)} className="h-8 w-36 text-xs">
            {EXTERNAL_AGENT_TOKEN_DAYS.map((d) => <option key={d} value={String(d)}>{t('mcp.days').replace('{n}', String(d))}</option>)}
            <option value="never">{t('mcp.neverExpires')}</option>
          </Select>
        </Field>
        <Button size="sm" variant="outline" className="h-8" disabled={!agentKnown || !clientName || issue.isPending} onClick={() => issue.mutate()}>
          {issue.isPending || agent.isLoading ? <Spinner /> : <KeyRound size={13} aria-hidden />} {clientName ? t('mcp.issueToken').replace('{client}', clientName) : t('mcp.createToken')}
        </Button>
      </div>
      {agent.isError && !agentKnown ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          {t('mcp.agentLoadFailed')}
          <Button size="xs" variant="ghost" onClick={() => agent.refetch()}>{t('common.retry')}</Button>
        </p>
      ) : agentKnown && !agentOn ? (
        <p className="text-xs text-muted-foreground">{t('mcp.asYouOnly')}</p>
      ) : null}
      {/* Whose permissions a holder gets, said before the token exists. */}
      {agentKnown && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <TriangleAlert size={13} aria-hidden className="mt-px shrink-0 text-warning" />
          {t(`mcp.tokenRisk.${actsAs}`)}
        </p>
      )}

      {shown && setup ? (
        <>
          <div className="anim-pop-in space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3" role="status">
            <div className="flex items-center gap-1.5 text-xs font-medium text-warning"><TriangleAlert size={13} aria-hidden /> {t('mcp.tokenOnceWarning')}</div>
            <div className="text-xs text-muted-foreground">{t('mcp.issuedFor').replace('{client}', issued.clientName).replace('{whom}', whom)}</div>
            <Snippet value={issued.token} />
          </div>
          <div>
            <p className="text-[13px] text-muted-foreground">{t(setup.main.step)}</p>
            <Snippet value={setup.main.snippet} primary className="mt-1.5" />
          </div>
          {setup.stdio && (
            <Disclosure label={t('mcp.localServer')}>
              <div className="pb-1 pl-5 pt-2">
                <p className="text-xs text-muted-foreground">{t(setup.stdio.step)}</p>
                <Snippet value={setup.stdio.snippet} className="mt-1.5" />
              </div>
            </Disclosure>
          )}
        </>
      ) : (
        <p className="text-[13px] text-muted-foreground">{t('mcp.tokenFirst')}</p>
      )}
    </div>
  );
}

/**
 * MCP clients read the OAuth discovery document from the *root* of this domain
 * before anything else, and a deployment that proxies only /api/ to the API
 * answers it with the SPA's index.html. The client then reports something
 * opaque ("couldn't register with the sign-in service") with no hint that the
 * cause is one missing proxy route, so name it here instead. Silent when all
 * is well: there is nothing to do then.
 */
function DiscoveryCheck() {
  const t = useT();
  const origin = appOrigin();
  const url = `${origin}/.well-known/oauth-authorization-server`;

  const check = useQuery({
    queryKey: ['mcp-discovery', origin],
    staleTime: 60_000,
    retry: false,
    queryFn: async (): Promise<{ ok: true; issuer: string } | { ok: false; kind: 'notApi' | 'failed' | 'scheme' | 'host'; issuer?: string }> => {
      let res: Response;
      try { res = await fetch(url, { headers: { accept: 'application/json' } }); }
      catch { return { ok: false, kind: 'failed' }; }
      const text = await res.text();
      if (!res.ok) return { ok: false, kind: 'failed' };
      // The SPA fallback answers 200 with HTML – the single most common cause.
      if (text.trimStart().startsWith('<')) return { ok: false, kind: 'notApi' };
      let issuer: string;
      try { issuer = String((JSON.parse(text) as { issuer?: unknown }).issuer ?? ''); }
      catch { return { ok: false, kind: 'notApi' }; }
      if (!issuer) return { ok: false, kind: 'failed' };
      if (issuer === origin) return { ok: true, issuer };
      try {
        const a = new URL(issuer);
        const b = new URL(origin);
        if (a.host === b.host) return { ok: false, kind: 'scheme', issuer };
      } catch { /* unparseable issuer – report it as a host mismatch */ }
      return { ok: false, kind: 'host', issuer };
    },
  });

  if (!check.data || check.data.ok) return null;

  const { kind, issuer } = check.data;
  const key = kind === 'notApi' ? 'NotApi' : kind === 'scheme' ? 'Scheme' : kind === 'host' ? 'Host' : 'Failed';
  const title = t(`mcp.check${key}`).replace('{issuer}', issuer ?? '');
  const fix = t(`mcp.check${key}Fix`).replace('{url}', url).replace('{origin}', origin);

  return (
    <div className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5">
      <TriangleAlert size={13} aria-hidden className="mt-px shrink-0 text-warning" />
      <div className="min-w-0">
        <div className="text-[12px] font-medium">{title}</div>
        <div className="mt-0.5 break-words text-[11px] text-muted-foreground">{fix}</div>
      </div>
    </div>
  );
}

/* ───────────────────────────── 2. Connections ───────────────────────────── */

interface DisconnectTarget { group: ConnectionGroup; connection: Connection }

function ConnectionsSection() {
  const t = useT();
  const qc = useQueryClient();
  const own = useOwnTokens();
  const agent = useMyAgent();
  const [target, setTarget] = useState<DisconnectTarget | null>(null);

  const groups = buildConnections(own.data ?? [], agent.data?.tokens ?? []);
  // Each list stands on its own: one failing keeps the other's rows on screen.
  const view = connectionsView({ own, agent }, groups.length);
  const retry = () => { if (view.failed.includes('own')) void own.refetch(); if (view.failed.includes('agent')) void agent.refetch(); };

  const disconnect = useMutation({
    mutationFn: ({ connection }: DisconnectTarget) =>
      connection.actsAs === 'agent' ? api.del(`/my-agent/tokens/${connection.id}`) : api.del(`/auth/tokens/${connection.id}`),
    onSuccess: () => {
      setTarget(null);
      qc.invalidateQueries({ queryKey: TOKENS_KEY });
      qc.invalidateQueries({ queryKey: ['my-agent'] });
      toast(t('mcp.disconnected'));
    },
    onError: () => { setTarget(null); toast.error(t('mcp.disconnectFailed')); },
  });

  const what = target ? `${target.group.client}${target.connection.prefix ? ` (${target.connection.prefix}…)` : ''}` : '';

  return (
    <section className="mb-10" aria-labelledby="mcp-connections">
      <SubHead title={<span id="mcp-connections">{t('mcp.connections')}</span>} desc={t('mcp.connectionsHint')} />
      {view.failed.length > 0 && (
        <p className="mb-2 flex items-center gap-2 text-xs text-muted-foreground" role="status">
          {t(view.failed.length === 2 ? 'mcp.loadFailed' : 'mcp.someFailed')}
          <Button size="xs" variant="ghost" onClick={retry}>{t('common.retry')}</Button>
        </p>
      )}
      {view.skeleton ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : groups.length === 0 ? (!view.empty ? null : (
        <RowList className="flex items-start gap-3 px-3 py-3">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Plug size={15} aria-hidden /></div>
          <div className="min-w-0">
            <p className="text-[13px] font-medium">{t('mcp.noConnections')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('mcp.noConnectionsHint')}</p>
          </div>
        </RowList>
      )) : (
        <RowList>
          <ul>
            {groups.map((group) => (
              <ConnectionRow key={group.key} group={group} onDisconnect={(connection) => setTarget({ group, connection })} />
            ))}
          </ul>
        </RowList>
      )}
      <p className="mt-2 text-[11px] text-faint">{t('oauth.cleanup')}</p>

      <ConfirmDialog
        open={!!target}
        onClose={() => setTarget(null)}
        onConfirm={() => { if (target) disconnect.mutate(target); }}
        title={t('mcp.disconnectTitle').replace('{client}', target?.group.client ?? '')}
        body={t('mcp.disconnectBody').replace('{what}', what)}
        confirmLabel={t('mcp.disconnect')}
        danger
        pending={disconnect.isPending}
      />
    </section>
  );
}

/** Whom a connection acts as, in words: never told by colour alone. */
export function ActsAsLabel({ actsAs }: { actsAs: ActsAs }) {
  const t = useT();
  return (
    <Badge className="shrink-0">
      {actsAs === 'agent' ? <Bot size={12} aria-hidden /> : <UserRound size={12} aria-hidden />}
      {actsAs === 'agent' ? t('mcp.asAgent') : t('mcp.asYou')}
    </Badge>
  );
}

function ConnectionRow({ group, onDisconnect }: { group: ConnectionGroup; onDisconnect: (c: Connection) => void }) {
  const t = useT();
  const locale = useLocale();
  const n = group.connections.length;
  // Several connections of one client can share a day: the token's first
  // characters tell them apart.
  const detail = (c: Connection) => [
    n > 1 && c.prefix ? `${c.prefix}…` : null,
    c.createdAt ? t(c.via === 'signIn' ? 'mcp.signedIn' : 'mcp.tokenMade').replace('{date}', fmtDate(c.createdAt)) : null,
    c.lastUsedAt ? t('mcp.lastUsed').replace('{when}', fmtRelative(c.lastUsedAt)) : t('mcp.neverUsed'),
    c.expiresAt ? t('mcp.expires').replace('{date}', fmtDate(c.expiresAt)) : null,
  ].filter(Boolean).join(' · ');

  return (
    <li className="anim-fade-in flex items-start gap-3 border-b border-border px-3 py-2.5 last:border-0">
      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Plug size={15} aria-hidden /></div>
      <div className="min-w-0 flex-1">
        <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-[13px] font-medium">{group.client}</span>
          <ActsAsLabel actsAs={group.actsAs} />
          {n > 1 && <span className="text-xs text-faint">{t(connectionsKey(n, locale)).replace('{n}', String(n))}</span>}
        </div>
        <ul className="space-y-0.5">
          {group.connections.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 break-words" title={c.prefix ? `${c.prefix}…` : undefined}>{detail(c)}</span>
              <Button
                size="xs"
                variant="ghost"
                className="shrink-0 hover:text-destructive"
                aria-label={`${t('mcp.disconnect')}: ${group.client}${c.prefix ? ` (${c.prefix}…)` : ''}`}
                onClick={() => onDisconnect(c)}
              >
                {t('mcp.disconnect')}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

/* ───────────────────────────── 4. Tokens for scripts ───────────────────────────── */

function ScriptTokensSection() {
  const t = useT();
  const locale = useLocale();
  const qc = useQueryClient();
  const own = useOwnTokens();
  const [createOpen, setCreateOpen] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<OwnToken | null>(null);
  const [showRevoked, setShowRevoked] = useState(false);
  const { active, revoked } = scriptTokens(own.data ?? []);

  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/auth/tokens/${id}`),
    onSuccess: () => {
      setRevokeTarget(null);
      qc.invalidateQueries({ queryKey: TOKENS_KEY });
      toast(t('mcp.tokenRevoked'));
    },
    onError: () => toast.error(t('mcp.revokeFailed')),
  });

  const label = (
    <span>{t('mcp.scripts')}{own.data && active.length > 0 && <span className="tabular-nums text-faint"> ({active.length})</span>}</span>
  );
  const rows = showRevoked ? [...active, ...revoked] : active;

  return (
    <section aria-label={t('mcp.scripts')}>
      <Disclosure label={label}>
        <div className="space-y-3 pb-1 pl-5 pt-3">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs text-muted-foreground">{t('mcp.scriptsHint')}</p>
            <Button size="sm" variant="outline" className="shrink-0" onClick={() => setCreateOpen(true)}><Plus size={14} aria-hidden /> {t('mcp.createToken')}</Button>
          </div>

          {createdToken && (
            <div className="anim-pop-in rounded-lg border border-warning/40 bg-warning/5 p-3" role="status">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-warning">
                <TriangleAlert size={13} aria-hidden /> {t('mcp.tokenOnceWarning')}
              </div>
              <Snippet value={createdToken} />
              <Button size="xs" variant="ghost" className="mt-2" onClick={() => setCreatedToken(null)}>{t('common.close')}</Button>
            </div>
          )}

          {own.isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : own.isError && !own.data ? (
            <p className="text-[13px] text-muted-foreground">{t('mcp.loadFailed')}</p>
          ) : rows.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">{t('mcp.noScripts')}</p>
          ) : (
            <RowList>
              <ul>
                {rows.map((tok) => {
                  const dead = !!tok.revokedAt;
                  return (
                    <li key={tok.id} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
                      <div className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted', dead ? 'text-faint' : 'text-muted-foreground')}>
                        <KeyRound size={15} aria-hidden />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={cn('truncate text-[13px] font-medium', dead && 'text-muted-foreground line-through')}>{tok.name}</span>
                          {tok.readOnly && <Badge>{t('mcp.readOnly')}</Badge>}
                          {dead && <Badge className="bg-destructive/10 text-destructive">{t('mcp.revoked')}</Badge>}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                          <span className="font-mono text-[11px]">{tok.prefix ?? '?'}…</span>
                          {tok.createdAt && <span>· {t('mcp.created').replace('{date}', fmtDate(tok.createdAt))}</span>}
                          <span>· {tok.lastUsedAt ? t('mcp.lastUsed').replace('{when}', fmtRelative(tok.lastUsedAt)) : t('mcp.neverUsed')}</span>
                          {(tok.scopes?.length ?? 0) > 0 && <span className="tabular-nums">· {t(pluralKey('mcp.permissions', tok.scopes!.length, locale)).replace('{n}', String(tok.scopes!.length))}</span>}
                        </div>
                      </div>
                      {!dead && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 px-0 text-muted-foreground hover:text-destructive"
                          title={`${t('mcp.revoke')}: ${tok.name}`}
                          aria-label={`${t('mcp.revoke')}: ${tok.name}`}
                          onClick={() => setRevokeTarget(tok)}
                        >
                          <Trash2 size={14} aria-hidden />
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </RowList>
          )}
          {revoked.length > 0 && (
            <Button size="xs" variant="ghost" aria-expanded={showRevoked} onClick={() => setShowRevoked((v) => !v)}>
              {showRevoked ? t('mcp.hideRevoked') : t('mcp.showRevoked').replace('{n}', String(revoked.length))}
            </Button>
          )}
        </div>
      </Disclosure>

      <CreateTokenDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(raw) => { setCreatedToken(raw); setCreateOpen(false); }}
      />

      <ConfirmDialog
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={() => { if (revokeTarget) revoke.mutate(revokeTarget.id); }}
        title={t('mcp.revokeTitle')}
        body={t('mcp.revokeBody').replace('{name}', revokeTarget ? `${revokeTarget.name}${revokeTarget.prefix ? ` (${revokeTarget.prefix}…)` : ''}` : '')}
        confirmLabel={t('mcp.revoke')}
        danger
        pending={revoke.isPending}
      />
    </section>
  );
}

function CreateTokenDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (raw: string) => void }) {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [scopes, setScopes] = useState<string[]>([]);

  const allScopes = me.permissions;

  const create = useMutation({
    mutationFn: () => api.post<{ id: string; token: string }>('/auth/tokens', { name: name.trim(), readOnly, scopes }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: TOKENS_KEY });
      toast(t('mcp.tokenCreated'));
      onCreated(res.token);
      setName('');
      setReadOnly(false);
      setScopes([]);
    },
    onError: () => toast.error(t('mcp.tokenCreateFailed')),
  });

  const toggleScope = (s: string) => setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  const valid = name.trim().length > 0 && scopes.length > 0;

  return (
    <Dialog open={open} onClose={onClose} title={t('mcp.createToken')} width={480}>
      <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); if (valid && !create.isPending) create.mutate(); }}>
        <Field label={t('mcp.tokenName')}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('mcp.tokenNamePlaceholder')} autoFocus />
        </Field>

        <div className="flex items-center justify-between gap-4 py-1">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">{t('mcp.readOnly')}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{t('mcp.readOnlyHint')}</div>
          </div>
          <Switch checked={readOnly} onChange={setReadOnly} label={t('mcp.readOnly')} />
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t('mcp.scopes')} <span className="tabular-nums text-faint">({t('mcp.scopesSelected').replace('{n}', String(scopes.length))})</span>
            </span>
            <div className="flex gap-1">
              <Button type="button" size="xs" variant="ghost" onClick={() => setScopes([...allScopes])}>{t('mcp.selectAll')}</Button>
              <Button type="button" size="xs" variant="ghost" onClick={() => setScopes([])} disabled={scopes.length === 0}>{t('mcp.clearAll')}</Button>
            </div>
          </div>
          <div className="grid max-h-48 grid-cols-2 gap-x-3 gap-y-1.5 overflow-y-auto rounded-md border border-border p-2.5">
            {allScopes.map((p) => (
              <label key={p} className="flex cursor-pointer items-center gap-1.5 text-xs">
                <Checkbox checked={scopes.includes(p)} onChange={() => toggleScope(p)} />
                <span className="truncate font-mono text-[11px]">{p}</span>
              </label>
            ))}
          </div>
          {scopes.length === 0 && <p className="mt-1 text-[11px] text-faint">{t('mcp.scopeRequired')}</p>}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={!valid || create.isPending}>
            {create.isPending ? <Spinner /> : <Plus size={14} aria-hidden />} {t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ───────────────────────────── Shared bits ───────────────────────────── */

/**
 * Something to paste, with its Copy button. The page's one primary action –
 * the snippet for the picked client – carries the accent; every other copy
 * stays quiet.
 */
function Snippet({ value, primary, className }: { value: string; primary?: boolean; className?: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className={cn('flex flex-col items-start gap-2 sm:flex-row', className)}>
      {/* Lines wrap at spaces, and long addresses after their slashes and
          dots, rather than in the middle of a word. */}
      <pre
        className="w-full min-w-0 flex-1 whitespace-pre-wrap break-words rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-[12px] leading-relaxed text-foreground"
      >
        {breakable(value)}
      </pre>
      <Button
        size="sm"
        variant={primary ? 'default' : 'outline'}
        className="shrink-0"
        onClick={async () => {
          // Plain-http installs and denied permissions have no clipboard: say so
          // instead of a checkmark for nothing.
          try {
            if (!navigator.clipboard) throw new Error('no clipboard');
            await navigator.clipboard.writeText(value);
          } catch {
            toast.error(t('mcp.copyFailed'));
            return;
          }
          setCopied(true);
          toast(t('mcp.copied'));
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />} {t('common.copy')}
      </Button>
    </div>
  );
}

/** Line-break chances after the slashes, dots and colons of a long address; the text itself is unchanged. */
function breakable(value: string): ReactNode[] {
  return value.split(/(?<=[/.:])(?=[^/\s])/).flatMap((part, i) => (i === 0 ? [part] : [<wbr key={i} />, part]));
}
