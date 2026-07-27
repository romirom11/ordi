import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Check, Copy, KeyRound, Plus, Trash2, TriangleAlert, Zap, BookOpen } from 'lucide-react';
import { appOrigin, api } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { Button, Input, Badge, Checkbox, SegmentedControl, Switch, Skeleton, Spinner, EmptyState, fmtDate, fmtRelative, cn } from '../ui';
import { Dialog, ConfirmDialog, toast } from '../overlays';
import { SectionHead, Field, RowList, AnimatedRow, Disclosure } from './primitives';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'settings.mcp': 'MCP',
    'settings.mcpDesc': 'Connect Claude, Cursor or any MCP client: the agent reads and manages ordi on your behalf. Agent rights = token rights.',
    'mcp.tokens': 'Access tokens',
    'mcp.tokensHint': 'Personal tokens the agent authenticates with. Scopes can only narrow your own permissions.',
    'mcp.createToken': 'Create token',
    'mcp.tokenName': 'Token name',
    'mcp.tokenNamePlaceholder': 'e.g. claude-desktop',
    'mcp.readOnly': 'Read-only',
    'mcp.readOnlyHint': 'The agent will only read data, no actions.',
    'mcp.scopes': 'Scopes',
    'mcp.scopesCount': 'scopes',
    'mcp.scopesSelected': 'selected',
    'mcp.selectAll': 'Select all',
    'mcp.clearAll': 'Clear',
    'mcp.tokenCreated': 'Token created.',
    'mcp.tokenOnceWarning': 'Copy the token now – it will not be shown again.',
    'mcp.tokenCreateFailed': 'Could not create the token.',
    'mcp.noTokens': 'No tokens yet',
    'mcp.noTokensHint': 'Create a token to connect an agent.',
    'mcp.loadFailed': 'Could not load tokens.',
    'mcp.created': 'Created',
    'mcp.lastUsed': 'Last used',
    'mcp.never': 'never',
    'mcp.revoked': 'Revoked',
    'mcp.revoke': 'Revoke',
    'mcp.revokeTitle': 'Revoke token',
    'mcp.revokeBody': 'Revoke "{name}"? Agents using this token will lose access immediately.',
    'mcp.tokenRevoked': 'Token revoked.',
    'mcp.revokeFailed': 'Could not revoke the token.',
    'mcp.copied': 'Copied to clipboard.',
    'mcp.oauthTitle': 'Connect a client',
    'mcp.oauthHint': 'Add ordi as a remote MCP server: the client opens the browser, you sign in and approve. No token to copy.',
    'mcp.checking': 'Checking discovery…',
    'mcp.checkOk': 'Discovery reachable at {issuer}',
    'mcp.checkNotApi': 'Your proxy answers /.well-known/ with the web app, not the API',
    'mcp.checkNotApiFix': 'MCP clients look for {url} at the root of this domain. Route /.well-known/ to the API, the same place /api/ goes.',
    'mcp.checkScheme': 'Discovery advertises {issuer} on an https site',
    'mcp.checkSchemeFix': 'The API cannot see the original scheme. Pass X-Forwarded-Proto through your proxy, or set APP_URL to {origin}.',
    'mcp.checkHost': 'Discovery advertises {issuer}, not this address',
    'mcp.checkHostFix': 'Pass the Host header through your proxy, or set APP_URL to {origin}.',
    'mcp.checkFailed': 'Could not reach the discovery document',
    'mcp.checkFailedFix': 'MCP clients read {url} before anything else. Until it answers, connecting will fail.',
    'mcp.oauthCopied': 'URL copied.',
    'mcp.desktopSteps': 'Settings -> Connectors -> Add custom connector, paste the URL above. No config file needed.',
    'mcp.codexHint': 'Add to ~/.codex/config.toml. Older Codex versions without remote MCP support can use the token setup below.',
    'mcp.cursorHint': 'Add to ~/.cursor/mcp.json (or Cursor Settings -> MCP -> Add).',
    'mcp.access': 'Access',
    'mcp.accessHint': 'Everything currently allowed to act as you: OAuth grants from clients and hand-made tokens. Revoke anything you do not recognise.',
    'mcp.stdioTitle': 'Without OAuth (stdio + token)',
    'mcp.capabilitiesToggle': 'What the agent can do',
    'mcp.connect': 'Connect a client',
    'mcp.connectHint': 'The stdio fallback for clients without OAuth support. Run the command from the root of the ordi repo (the built ordi-mcp bin works as an alternative). Replace YOUR_TOKEN with a token created above.',
    'mcp.snippetClaudeDesktop': 'Claude Desktop · claude_desktop_config.json',
    'mcp.snippetClaudeCode': 'Claude Code',
    'mcp.snippetCursor': 'Cursor · ~/.cursor/mcp.json',
    'mcp.capabilities': 'Agent capabilities',
    'mcp.capabilitiesHint': 'No destructive operations: the agent cannot delete or cancel anything.',
    'mcp.readTools': 'Read',
    'mcp.actionTools': 'Actions',
    'mcp.scopeRequired': 'Pick at least one scope.',
  },
  uk: {
    'settings.mcp': 'MCP',
    'settings.mcpDesc': 'Підключіть Claude, Cursor чи інший MCP-клієнт: агент читає і керує ordi від вашого імені. Права агента = права токена.',
    'mcp.tokens': 'Токени доступу',
    'mcp.tokensHint': 'Персональні токени, якими автентифікується агент. Скоупи лише звужують ваші власні права.',
    'mcp.createToken': 'Створити токен',
    'mcp.tokenName': 'Назва токена',
    'mcp.tokenNamePlaceholder': 'напр. claude-desktop',
    'mcp.readOnly': 'Лише читання',
    'mcp.readOnlyHint': 'Агент тільки читатиме дані, без дій.',
    'mcp.scopes': 'Скоупи',
    'mcp.scopesCount': 'скоупів',
    'mcp.scopesSelected': 'обрано',
    'mcp.selectAll': 'Обрати всі',
    'mcp.clearAll': 'Очистити',
    'mcp.tokenCreated': 'Токен створено.',
    'mcp.tokenOnceWarning': 'Скопіюйте токен зараз – він більше не показуватиметься.',
    'mcp.tokenCreateFailed': 'Не вдалося створити токен.',
    'mcp.noTokens': 'Ще немає токенів',
    'mcp.noTokensHint': 'Створіть токен, щоб підключити агента.',
    'mcp.loadFailed': 'Не вдалося завантажити токени.',
    'mcp.created': 'Створено',
    'mcp.lastUsed': 'Останнє використання',
    'mcp.never': 'ніколи',
    'mcp.revoked': 'Відкликано',
    'mcp.revoke': 'Відкликати',
    'mcp.revokeTitle': 'Відкликати токен',
    'mcp.revokeBody': 'Відкликати «{name}»? Агенти з цим токеном одразу втратять доступ.',
    'mcp.tokenRevoked': 'Токен відкликано.',
    'mcp.revokeFailed': 'Не вдалося відкликати токен.',
    'mcp.copied': 'Скопійовано в буфер обміну.',
    'mcp.oauthTitle': 'Підключити клієнта',
    'mcp.oauthHint': 'Додайте ordi як remote MCP-сервер: клієнт відкриє браузер, ви входите і підтверджуєте. Токен копіювати не треба.',
    'mcp.checking': 'Перевіряємо дискавері…',
    'mcp.checkOk': 'Дискавері доступне на {issuer}',
    'mcp.checkNotApi': 'Ваш проксі віддає на /.well-known/ вебзастосунок, а не API',
    'mcp.checkNotApiFix': 'MCP-клієнти шукають {url} у корені цього домену. Спрямуйте /.well-known/ в API, туди ж, куди йде /api/.',
    'mcp.checkScheme': 'Дискавері віддає {issuer} на https-сайті',
    'mcp.checkSchemeFix': 'API не бачить оригінальної схеми. Передайте X-Forwarded-Proto через проксі або задайте APP_URL = {origin}.',
    'mcp.checkHost': 'Дискавері віддає {issuer}, а не цю адресу',
    'mcp.checkHostFix': 'Передайте заголовок Host через проксі або задайте APP_URL = {origin}.',
    'mcp.checkFailed': 'Не вдалося отримати документ дискавері',
    'mcp.checkFailedFix': 'MCP-клієнти читають {url} найпершим. Поки він не відповідає, підключення не спрацює.',
    'mcp.oauthCopied': 'URL скопійовано.',
    'mcp.desktopSteps': 'Settings -> Connectors -> Add custom connector, вставте URL вище. Конфіг-файл не потрібен.',
    'mcp.codexHint': 'Додайте в ~/.codex/config.toml. Старіші версії Codex без remote MCP можуть використати варіант із токеном нижче.',
    'mcp.cursorHint': 'Додайте в ~/.cursor/mcp.json (або Cursor Settings -> MCP -> Add).',
    'mcp.access': 'Доступ',
    'mcp.accessHint': 'Все, що зараз може діяти від вашого імені: OAuth-гранти клієнтів і ручні токени. Відкликайте все, чого не впізнаєте.',
    'mcp.stdioTitle': 'Без OAuth (stdio + токен)',
    'mcp.capabilitiesToggle': 'Що вміє агент',
    'mcp.connect': 'Підключення клієнта',
    'mcp.connectHint': 'Stdio-варіант для клієнтів без підтримки OAuth. Команду запускайте з кореня репозиторію ordi (альтернатива – зібраний бінарник ordi-mcp). Замініть YOUR_TOKEN на токен, створений вище.',
    'mcp.snippetClaudeDesktop': 'Claude Desktop · claude_desktop_config.json',
    'mcp.snippetClaudeCode': 'Claude Code',
    'mcp.snippetCursor': 'Cursor · ~/.cursor/mcp.json',
    'mcp.capabilities': 'Можливості агента',
    'mcp.capabilitiesHint': 'Без деструктивних операцій: агент не може нічого видаляти чи скасовувати.',
    'mcp.readTools': 'Читання',
    'mcp.actionTools': 'Дії',
    'mcp.scopeRequired': 'Оберіть щонайменше один скоуп.',
  },
});

interface ApiToken {
  id: string;
  name: string;
  prefix?: string | null;
  scopes?: string[] | null;
  readOnly?: boolean;
  lastUsedAt?: string | null;
  revokedAt?: string | null;
  createdAt?: string | null;
}

/** Tool names mirrored from packages/mcp/src/server.ts (read-only summary). */
const READ_TOOLS = [
  'search', 'list_projects', 'list_companies', 'list_contacts', 'list_deals', 'list_deal_stages',
  'get_company_overview', 'list_my_tasks', 'get_project_status', 'get_cycle_progress',
  'list_overdue_invoices', 'get_receivables_aging', 'list_unbilled_time', 'find_kb_page',
  'get_project_profitability', 'get_labor_cost', 'get_team_availability', 'list_pending_leave',
  'get_recruitment_pipeline',
];
const ACTION_TOOLS = [
  'create_task', 'update_task_status', 'assign_task', 'comment_on_task', 'log_time',
  'create_invoice_from_time', 'create_invoice_from_project', 'send_invoice', 'record_payment',
  'send_payment_reminder', 'create_quote', 'create_note', 'create_company', 'create_contact',
  'create_deal', 'move_deal', 'create_kb_page',
  'request_leave', 'approve_leave', 'create_job_opening', 'move_applicant',
];

export function McpPanel() {
  const t = useT();
  const qc = useQueryClient();
  const tokens = useQuery({
    queryKey: ['apiTokens'],
    queryFn: () => api.get<{ data: ApiToken[] }>('/auth/tokens'),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiToken | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/auth/tokens/${id}`),
    onSuccess: () => {
      setRevokeTarget(null);
      qc.invalidateQueries({ queryKey: ['apiTokens'] });
      toast(t('mcp.tokenRevoked'));
    },
    onError: () => toast.error(t('mcp.revokeFailed')),
  });

  const rows = tokens.data?.data ?? [];
  const mcpUrl = `${appOrigin()}/api/v1/mcp`;

  return (
    <div>
      <SectionHead title={t('settings.mcp')} desc={t('settings.mcpDesc')} />

      {/* ── Connect: the URL + one snippet for the client you actually use ── */}
      <div className="mb-8 rounded-lg border border-primary/30 bg-primary/5 p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-primary">{t('mcp.oauthTitle')}</div>
        <p className="mt-1 text-xs text-muted-foreground">{t('mcp.oauthHint')}</p>
        <div className="mt-2.5 flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[12px]">{mcpUrl}</code>
          <Button size="sm" variant="outline" onClick={() => { navigator.clipboard?.writeText(mcpUrl); toast(t('mcp.oauthCopied')); }}>
            <Copy size={13} />
          </Button>
        </div>
        <ClientSetup mcpUrl={mcpUrl} />
        <DiscoveryCheck />
      </div>

      {/* ── Access: who can currently act as you ── */}
      <div className="mb-2">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">{t('mcp.access')}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('mcp.accessHint')}</p>
      </div>

      {createdToken && (
        <div className="anim-pop-in mb-3 rounded-lg border border-warning/40 bg-warning/5 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-warning">
            <TriangleAlert size={13} /> {t('mcp.tokenOnceWarning')}
          </div>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-md bg-muted/60 px-2 py-1.5 font-mono text-[11px]">{createdToken}</span>
            <CopyButton value={createdToken} label={t('common.copy')} />
          </div>
          <button
            className="mt-2 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
            onClick={() => setCreatedToken(null)}
          >
            {t('common.close')}
          </button>
        </div>
      )}

      {tokens.isLoading ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : tokens.isError ? (
        <p className="py-3 text-[13px] text-destructive">{t('mcp.loadFailed')}</p>
      ) : rows.length === 0 ? (
        <EmptyState icon={<KeyRound size={18} />} title={t('mcp.noTokens')} hint={t('mcp.noTokensHint')} />
      ) : (
        <RowList>
          {rows.map((tok, i) => {
            const dead = !!tok.revokedAt;
            return (
              <AnimatedRow key={tok.id} index={i} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
                <div className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted', dead ? 'text-faint' : 'text-muted-foreground')}>
                  <KeyRound size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={cn('truncate text-[13px] font-medium', dead && 'text-muted-foreground line-through')}>{tok.name}</span>
                    {tok.readOnly && <Badge>{t('mcp.readOnly')}</Badge>}
                    {dead && <Badge className="bg-destructive/10 text-destructive">{t('mcp.revoked')}</Badge>}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-xs text-faint">
                    <span className="font-mono text-[11px]">{tok.prefix ?? '?'}…</span>
                    {tok.createdAt && <span>{t('mcp.created')} {fmtDate(tok.createdAt)}</span>}
                    <span>· {t('mcp.lastUsed')}: {tok.lastUsedAt ? fmtRelative(tok.lastUsedAt) : t('mcp.never')}</span>
                    {(tok.scopes?.length ?? 0) > 0 && <span className="tabular-nums">· {tok.scopes?.length} {t('mcp.scopesCount')}</span>}
                  </div>
                </div>
                {!dead && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 px-0 text-muted-foreground hover:text-destructive"
                    title={`${t('mcp.revoke')}: ${tok.name}`}
                    onClick={() => setRevokeTarget(tok)}
                  >
                    <Trash2 size={14} />
                  </Button>
                )}
              </AnimatedRow>
            );
          })}
        </RowList>
      )}

      {/* ── Rarely needed: the token/stdio fallback and the tool reference ── */}
      <Disclosure label={t('mcp.stdioTitle')} className="mt-8">
        <div className="space-y-3 pt-3">
          <p className="text-xs text-muted-foreground">{t('mcp.connectHint')}</p>
          <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}><Plus size={14} /> {t('mcp.createToken')}</Button>
          <ConfigSnippets tokenValue={createdToken ?? 'YOUR_TOKEN'} />
        </div>
      </Disclosure>

      <Disclosure label={t('mcp.capabilitiesToggle')} className="mt-4">
        <div className="space-y-3 pt-3">
          <p className="text-xs text-muted-foreground">{t('mcp.capabilitiesHint')}</p>
          <ToolGroup icon={<BookOpen size={13} />} label={t('mcp.readTools')} tools={READ_TOOLS} />
          <ToolGroup icon={<Zap size={13} />} label={t('mcp.actionTools')} tools={ACTION_TOOLS} />
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
        body={t('mcp.revokeBody').replace('{name}', revokeTarget?.name ?? '')}
        confirmLabel={t('mcp.revoke')}
        danger
        pending={revoke.isPending}
      />
    </div>
  );
}

/* ────────────────────────────── Create token dialog ────────────────────────────── */

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
      qc.invalidateQueries({ queryKey: ['apiTokens'] });
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
          <Switch checked={readOnly} onChange={setReadOnly} />
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">
              {t('mcp.scopes')} <span className="tabular-nums text-faint">({scopes.length} {t('mcp.scopesSelected')})</span>
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
            {create.isPending ? <Spinner /> : <Plus size={14} />} {t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ─────────────────────── Per-client remote setup ─────────────────────── */

type McpClient = 'claude-code' | 'claude-desktop' | 'cursor' | 'codex';

/**
 * One client, one snippet. Everyone connects the same way (the URL above);
 * this only answers "where do I paste it" for the tool the person uses.
 */
/**
 * MCP clients read the OAuth discovery document from the *root* of this domain
 * before anything else, and a deployment that proxies only /api/ to the API
 * answers it with the SPA's index.html. The client then reports something
 * opaque ("couldn't register with the sign-in service") with no hint that the
 * cause is one missing proxy route, so name it here instead.
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

  if (check.isPending) {
    return (
      <div className="mt-3 flex items-center gap-2 text-[11px] text-faint">
        <Spinner className="h-3 w-3" /> {t('mcp.checking')}
      </div>
    );
  }
  if (!check.data) return null;

  if (check.data.ok) {
    return (
      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Check size={12} className="text-success" />
        {t('mcp.checkOk').replace('{issuer}', check.data.issuer)}
      </div>
    );
  }

  const { kind, issuer } = check.data;
  const title = t(`mcp.check${kind === 'notApi' ? 'NotApi' : kind === 'scheme' ? 'Scheme' : kind === 'host' ? 'Host' : 'Failed'}`)
    .replace('{issuer}', issuer ?? '');
  const fix = t(`mcp.check${kind === 'notApi' ? 'NotApi' : kind === 'scheme' ? 'Scheme' : kind === 'host' ? 'Host' : 'Failed'}Fix`)
    .replace('{url}', url)
    .replace('{origin}', origin);

  return (
    <div className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5">
      <TriangleAlert size={13} className="mt-px shrink-0 text-warning" />
      <div className="min-w-0">
        <div className="text-[12px] font-medium">{title}</div>
        <div className="mt-0.5 break-words text-[11px] text-muted-foreground">{fix}</div>
      </div>
    </div>
  );
}

function ClientSetup({ mcpUrl }: { mcpUrl: string }) {
  const t = useT();
  const [client, setClient] = useState<McpClient>('claude-code');

  const snippet =
    client === 'claude-code' ? `claude mcp add --transport http ordi ${mcpUrl}`
    : client === 'cursor' ? JSON.stringify({ mcpServers: { ordi: { url: mcpUrl } } }, null, 2)
    : client === 'codex' ? `[mcp_servers.ordi]\nurl = "${mcpUrl}"`
    : null; // Claude Desktop is clicks, not config

  const hint =
    client === 'claude-desktop' ? t('mcp.desktopSteps')
    : client === 'codex' ? t('mcp.codexHint')
    : client === 'cursor' ? t('mcp.cursorHint')
    : null;

  return (
    <div className="mt-3">
      <SegmentedControl<McpClient>
        value={client}
        onChange={setClient}
        className="h-7 text-xs"
        options={[
          { key: 'claude-code', label: 'Claude Code' },
          { key: 'claude-desktop', label: 'Claude Desktop' },
          { key: 'cursor', label: 'Cursor' },
          { key: 'codex', label: 'Codex CLI' },
        ]}
      />
      {snippet && (
        <div className="mt-2 flex items-start gap-2">
          <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-surface px-2.5 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">{snippet}</pre>
          <CopyButton value={snippet} label={t('common.copy')} />
        </div>
      )}
      {hint && <p className="mt-2 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/* ────────────────────────────── Config snippets ────────────────────────────── */

function ConfigSnippets({ tokenValue }: { tokenValue: string }) {
  const t = useT();
  const origin = appOrigin();

  const { desktopJson, codeCmd, cursorJson, codexToml } = useMemo(() => {
    const serverEntry = {
      command: 'npx',
      args: ['tsx', 'packages/mcp/src/index.ts'],
      env: { ORDI_API_URL: origin, ORDI_API_TOKEN: tokenValue },
    };
    return {
      desktopJson: JSON.stringify({ mcpServers: { ordi: serverEntry } }, null, 2),
      codeCmd: `claude mcp add ordi -e ORDI_API_URL=${origin} -e ORDI_API_TOKEN=${tokenValue} -- npx tsx packages/mcp/src/index.ts`,
      cursorJson: JSON.stringify({ mcpServers: { ordi: serverEntry } }, null, 2),
      codexToml: `[mcp_servers.ordi]\ncommand = "npx"\nargs = ["tsx", "packages/mcp/src/index.ts"]\nenv = { ORDI_API_URL = "${origin}", ORDI_API_TOKEN = "${tokenValue}" }`,
    };
  }, [origin, tokenValue]);

  return (
    <div className="space-y-3">
      <CodeBlock title={t('mcp.snippetClaudeDesktop')} code={desktopJson} />
      <CodeBlock title={t('mcp.snippetClaudeCode')} code={codeCmd} />
      <CodeBlock title={t('mcp.snippetCursor')} code={cursorJson} />
      <CodeBlock title="Codex CLI · ~/.codex/config.toml" code={codexToml} />
    </div>
  );
}

function CodeBlock({ title, code }: { title: string; code: string }) {
  const t = useT();
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex h-8 items-center justify-between border-b border-border pl-3 pr-1.5">
        <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><Bot size={13} /> {title}</span>
        <CopyButton value={code} label={t('common.copy')} />
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">{code}</pre>
    </div>
  );
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="xs"
      variant="ghost"
      className="shrink-0"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        toast(t('mcp.copied'));
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />} {label}
    </Button>
  );
}

/* ────────────────────────────── Tool chips ────────────────────────────── */

function ToolGroup({ icon, label, tools }: { icon: React.ReactNode; label: string; tools: string[] }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {icon} {label} <span className="tabular-nums text-faint">· {tools.length}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {tools.map((name) => (
          <span key={name} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {name}
          </span>
        ))}
      </div>
    </div>
  );
}
