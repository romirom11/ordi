import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { EVENT_TYPES, GIT_PROVIDERS } from '@ordi/shared';
import {
  Github, Slack, GitBranch, Plus, Trash2, ChevronRight, ExternalLink, Webhook as WebhookIcon,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useCan } from '../../lib/auth';
import {
  Button, IconButton, Input, Select, Card, Badge, Skeleton, Spinner, fmtDate, cn,
} from '../ui';
import { Dialog, ConfirmDialog, toast } from '../overlays';
import { SectionHead, Field, RowList, Disclosure, StatusChip } from './primitives';
import { EmailCard, OAuthCredentials } from './integrationsConfig';
import { Hint } from '../Hint';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'settings.integrationsDesc': 'Connect GitHub and Slack, and send outgoing webhooks.',
    // GitHub
    'settings.stateConnected': 'Connected',
    'settings.stateReady': 'OAuth app ready',
    'settings.stateNone': 'Not configured',
    'settings.setupOauth': 'Set up the OAuth app',
    'settings.githubTitle': 'GitHub',
    'settings.githubDesc': 'Link repositories to projects – branches and PRs show up on tasks.',
    'settings.connectGithub': 'Connect GitHub',
    'settings.advancedToken': 'Advanced: connect with a token',
    'settings.connectedGithub': 'GitHub is connected.',
    'settings.repoLinkHint': 'Link repositories to a project in that project’s settings.',
    'settings.connect': 'Connect',
    'settings.tokenPlaceholder': 'ghp_…',
    'settings.instancePlaceholder': 'https://git.company.com',
    'settings.githubConnected': 'GitHub connected',
    'settings.githubConnectError': 'Could not connect GitHub – please try again.',
    'settings.deleteConnection': 'Remove connection',
    'settings.deleteConnectionBody': 'Remove this git connection? Linked repositories will stop syncing.',
    // Slack
    'settings.slackTitle': 'Slack',
    'settings.slackDesc': 'Get notified about events (tasks, deals, invoices) in Slack.',
    'settings.connectSlack': 'Connect Slack',
    'settings.slackConnectedTo': 'Connected to {team}',
    'settings.slackChannelHint': 'The notification channel is chosen in each project’s settings.',
    'settings.slackDisconnect': 'Disconnect',
    'settings.slackDisconnectTitle': 'Disconnect Slack',
    'settings.slackDisconnectBody': 'Disconnect Slack? Projects will stop sending notifications until you reconnect.',
    'settings.slackConnected': 'Slack connected',
    'settings.slackConnectError': 'Could not connect Slack – please try again.',
    'settings.slackDisconnected': 'Slack disconnected',
    'settings.slackAdvanced': 'Advanced (legacy webhook)',
    'settings.slackWebhook': 'Default webhook URL',
    'settings.slackPlaceholder': 'https://hooks.slack.com/services/…',
    'settings.slackNeedsManage': 'Requires the “Manage settings” permission to edit.',
    'settings.slackSaved': 'Slack webhook saved',
    'settings.slackRemoved': 'Slack webhook removed',
    // Webhooks
    'settings.webhooksDesc': 'Send a signed POST to your endpoint when events happen.',
    'settings.addWebhook': 'Add webhook',
    'settings.webhookSecret': 'Signing secret',
    'settings.webhookSecretHint': 'Sent as a signature header; store it to verify payloads.',
    'settings.webhookEvents': 'Events',
    'settings.selectEvents': 'Select at least one event.',
    'settings.deleteWebhook': 'Delete webhook',
    'settings.deleteWebhookBody': 'Delete this webhook? Deliveries will stop immediately.',
  },
  uk: {
    'settings.integrationsDesc': 'Підключіть GitHub і Slack та надсилайте вихідні вебхуки.',
    // GitHub
    'settings.stateConnected': 'Підключено',
    'settings.stateReady': 'OAuth-застосунок готовий',
    'settings.stateNone': 'Не налаштовано',
    'settings.setupOauth': 'Налаштувати OAuth-застосунок',
    'settings.githubTitle': 'GitHub',
    'settings.githubDesc': 'Звʼяжіть репозиторії з проєктами – гілки та PR-и зʼявляться в задачах.',
    'settings.connectGithub': 'Підключити GitHub',
    'settings.advancedToken': 'Розширено: підключення через токен',
    'settings.connectedGithub': 'GitHub підключено.',
    'settings.repoLinkHint': 'Привʼязка репозиторіїв до проєкту – у налаштуваннях конкретного проєкту.',
    'settings.connect': 'Підключити',
    'settings.tokenPlaceholder': 'ghp_…',
    'settings.instancePlaceholder': 'https://git.company.com',
    'settings.githubConnected': 'GitHub підключено',
    'settings.githubConnectError': 'Не вдалося підключити GitHub – спробуйте ще раз.',
    'settings.deleteConnection': 'Видалити підключення',
    'settings.deleteConnectionBody': 'Видалити це git-підключення? Повʼязані репозиторії перестануть синхронізуватися.',
    // Slack
    'settings.slackTitle': 'Slack',
    'settings.slackDesc': 'Отримуйте сповіщення про події (задачі, угоди, інвойси) у Slack.',
    'settings.connectSlack': 'Підключити Slack',
    'settings.slackConnectedTo': 'Підключено до {team}',
    'settings.slackChannelHint': 'Канал для сповіщень обирається в налаштуваннях кожного проєкту.',
    'settings.slackDisconnect': 'Відключити',
    'settings.slackDisconnectTitle': 'Відключити Slack',
    'settings.slackDisconnectBody': 'Відключити Slack? Проєкти перестануть надсилати сповіщення, доки ви не підключите знову.',
    'settings.slackConnected': 'Slack підключено',
    'settings.slackConnectError': 'Не вдалося підключити Slack – спробуйте ще раз.',
    'settings.slackDisconnected': 'Slack відключено',
    'settings.slackAdvanced': 'Розширено (застарілий webhook)',
    'settings.slackWebhook': 'Типовий webhook URL',
    'settings.slackPlaceholder': 'https://hooks.slack.com/services/…',
    'settings.slackNeedsManage': 'Для редагування потрібен дозвіл «Керування налаштуваннями».',
    'settings.slackSaved': 'Slack webhook збережено',
    'settings.slackRemoved': 'Slack webhook видалено',
    // Webhooks
    'settings.webhooksDesc': 'Надсилаємо підписаний POST на ваш ендпоінт, коли стаються події.',
    'settings.addWebhook': 'Додати вебхук',
    'settings.webhookSecret': 'Секрет підпису',
    'settings.webhookSecretHint': 'Надсилається як заголовок підпису; збережіть, щоб перевіряти запити.',
    'settings.webhookEvents': 'Події',
    'settings.selectEvents': 'Оберіть щонайменше одну подію.',
    'settings.deleteWebhook': 'Видалити вебхук',
    'settings.deleteWebhookBody': 'Видалити цей вебхук? Доставки зупиняться негайно.',
  },
});

interface GitConnection { id: string; provider?: string | null; status?: string | null; instanceUrl?: string | null; createdAt?: string }
interface Webhook { id: string; url?: string | null; active?: boolean; eventTypes?: string[] }
interface WorkspaceFull { integrations?: { slackWebhookUrl?: string | null } }

function providerIcon(provider?: string | null) {
  if (provider === 'github') return <Github size={15} />;
  return <GitBranch size={15} />;
}

/* ─────────────── GitHub ─────────────── */

function GitHubCard() {
  const t = useT();
  const qc = useQueryClient();
  const oauth = useQuery({ queryKey: ['gitOAuthStatus'], queryFn: () => api.get<{ configured: boolean }>('/integrations/git/oauth/status') });
  const connections = useQuery({ queryKey: ['gitConnections'], queryFn: () => api.get<{ data: GitConnection[] }>('/integrations/git/connections') });
  const conns = connections.data?.data ?? [];
  const configured = oauth.data?.configured;
  const githubConnected = conns.some((c) => c.provider === 'github');

  const [connecting, setConnecting] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [conn, setConn] = useState({ provider: 'github', instanceUrl: '', token: '' });
  const [toDelete, setToDelete] = useState<GitConnection | null>(null);

  const connect = async () => {
    setConnecting(true);
    try {
      const { url } = await api.get<{ url: string }>('/integrations/git/oauth/start');
      window.location.href = url;
    } catch {
      setConnecting(false);
      toast.error(t('settings.githubConnectError'));
    }
  };

  const addConn = useMutation({
    mutationFn: () => api.post('/integrations/git/connections', {
      provider: conn.provider,
      instanceUrl: conn.instanceUrl || undefined,
      credentials: { token: conn.token },
    }),
    onSuccess: () => {
      setConn({ provider: 'github', instanceUrl: '', token: '' });
      setTokenOpen(false);
      qc.invalidateQueries({ queryKey: ['gitConnections'] });
      toast(t('common.saved'));
    },
    onError: () => toast.error(t('settings.saveFailed')),
  });

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/integrations/git/connections/${id}`),
    onSuccess: () => { setToDelete(null); qc.invalidateQueries({ queryKey: ['gitConnections'] }); toast(t('settings.remove')); },
    onError: () => { setToDelete(null); toast.error(t('settings.saveFailed')); },
  });

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
          <Github size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{t('settings.githubTitle')}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('settings.githubDesc')}</p>
        </div>
        {oauth.isSuccess && (
          <StatusChip tone={githubConnected ? 'ok' : configured ? 'muted' : 'off'}>
            {githubConnected ? t('settings.stateConnected') : configured ? t('settings.stateReady') : t('settings.stateNone')}
          </StatusChip>
        )}
        {configured && !githubConnected && (
          <Button size="sm" onClick={connect} disabled={connecting}>
            {connecting ? <Spinner /> : <Github size={14} />} {t('settings.connectGithub')}
          </Button>
        )}
      </div>

      {/* Credentials live here rather than in the server .env, so a workspace
          owner can set up the OAuth app without shell access. The form only
          appears on demand – it is a one-time task, not daily reading. */}
      {oauth.isSuccess && !configured && (
        <Disclosure label={t('settings.setupOauth')} className="mt-3 border-t border-border pt-3">
          <OAuthCredentials provider="github" callbackPath="/api/v1/integrations/git/oauth/callback" />
        </Disclosure>
      )}

      {/* Existing connections */}
      {conns.length > 0 && (
        <RowList className="mt-3">
          {conns.map((c) => (
            <div key={c.id} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
              <span className="text-muted-foreground">{providerIcon(c.provider)}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px]">
                  {c.provider ?? 'git'} · <span className="text-muted-foreground">{c.instanceUrl ?? 'github.com'}</span>
                </div>
                {c.createdAt && <div className="text-[11px] text-faint">{fmtDate(c.createdAt)}</div>}
              </div>
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className={cn('h-1.5 w-1.5 rounded-full', c.status === 'connected' ? 'bg-success' : 'bg-faint')} />
                {c.status ?? 'connected'}
              </span>
              <IconButton size="sm" onClick={() => setToDelete(c)} title={t('settings.deleteConnection')}>
                <Trash2 size={14} />
              </IconButton>
            </div>
          ))}
        </RowList>
      )}
      {conns.length > 0 && (
        <p className="mt-2 text-[11px] text-faint">{t('settings.repoLinkHint')}</p>
      )}

      {/* Advanced: token accordion */}
      <div className="mt-3 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => setTokenOpen((o) => !o)}
          aria-expanded={tokenOpen}
          className="flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight size={14} className={cn('transition-transform duration-[250ms] ease-smooth-out', tokenOpen && 'rotate-90')} />
          {t('settings.advancedToken')}
        </button>
        <div className={cn('grid transition-[grid-template-rows] duration-[250ms] ease-smooth-out', tokenOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
          <div className="overflow-hidden">
            <form
              className="flex flex-wrap items-end gap-2 pt-3"
              onSubmit={(e) => { e.preventDefault(); if (conn.token) addConn.mutate(); }}
            >
              <Field label={t('settings.provider')} className="w-28">
                <Select value={conn.provider} onChange={(e) => setConn((c) => ({ ...c, provider: e.target.value }))} className="w-full">
                  {GIT_PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
                </Select>
              </Field>
              <Field label={t('settings.instanceUrl')} className="w-44">
                <Input value={conn.instanceUrl} onChange={(e) => setConn((c) => ({ ...c, instanceUrl: e.target.value }))} placeholder={t('settings.instancePlaceholder')} />
              </Field>
              <Field label={t('settings.token')} className="w-40">
                <Input value={conn.token} onChange={(e) => setConn((c) => ({ ...c, token: e.target.value }))} type="password" placeholder={t('settings.tokenPlaceholder')} />
              </Field>
              <Button type="submit" size="sm" disabled={!conn.token || addConn.isPending}>
                {addConn.isPending ? <Spinner /> : <Plus size={14} />} {t('settings.connect')}
              </Button>
            </form>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
        title={t('settings.deleteConnection')}
        body={t('settings.deleteConnectionBody')}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </Card>
  );
}

/* ─────────────── Slack ─────────────── */

interface SlackStatus { configured: boolean; connected: boolean; teamName?: string | null }

function SlackCard() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const canManage = can('integrations.manage') || can('settings.manage');

  const status = useQuery({ queryKey: ['slackStatus'], queryFn: () => api.get<SlackStatus>('/integrations/slack/status') });
  const configured = status.data?.configured;
  const connected = status.data?.connected;
  const teamName = status.data?.teamName;

  const [connecting, setConnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const connect = async () => {
    setConnecting(true);
    try {
      const { url } = await api.get<{ url: string }>('/integrations/slack/oauth/start');
      window.location.href = url;
    } catch {
      setConnecting(false);
      toast.error(t('settings.slackConnectError'));
    }
  };

  const disconnect = useMutation({
    mutationFn: () => api.del('/integrations/slack'),
    onSuccess: () => {
      setConfirmDisconnect(false);
      qc.invalidateQueries({ queryKey: ['slackStatus'] });
      toast(t('settings.slackDisconnected'));
    },
    onError: () => { setConfirmDisconnect(false); toast.error(t('settings.saveFailed')); },
  });

  // Legacy webhook (advanced accordion)
  const ws = useQuery({
    queryKey: ['workspace-settings-full'],
    queryFn: () => api.get<WorkspaceFull>('/settings/workspace?full=1'),
  });
  const stored = ws.data?.integrations?.slackWebhookUrl ?? '';
  const [value, setValue] = useState('');
  useEffect(() => { setValue(stored); }, [stored]);
  const saveWebhook = useMutation({
    mutationFn: (url: string | null) => api.patch('/settings/workspace', { integrations: { slackWebhookUrl: url } }),
    onSuccess: (_r, url) => {
      qc.invalidateQueries({ queryKey: ['workspace-settings-full'] });
      qc.invalidateQueries({ queryKey: ['workspace-settings'] });
      toast(url ? t('settings.slackSaved') : t('settings.slackRemoved'));
    },
    onError: () => toast.error(t('settings.saveFailed')),
  });
  const webhookDirty = value.trim() !== (stored ?? '');

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
          <Slack size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">{t('settings.slackTitle')}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('settings.slackDesc')}</p>
        </div>
        {status.isSuccess && (
          <StatusChip tone={connected ? 'ok' : configured ? 'muted' : 'off'}>
            {connected ? t('settings.stateConnected') : configured ? t('settings.stateReady') : t('settings.stateNone')}
          </StatusChip>
        )}
        {canManage && configured && !connected && (
          <Button size="sm" onClick={connect} disabled={connecting}>
            {connecting ? <Spinner /> : <Slack size={14} />} {t('settings.connectSlack')}
          </Button>
        )}
      </div>

      {status.isSuccess && !configured && (
        <Disclosure label={t('settings.setupOauth')} className="mt-3 border-t border-border pt-3">
          <OAuthCredentials provider="slack" callbackPath="/api/v1/integrations/slack/oauth/callback" />
        </Disclosure>
      )}

      {/* Connected state */}
      {connected && (
        <div className="mt-3">
          <div className="flex items-center gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5">
            <span className="flex items-center gap-2 text-[13px] font-medium">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              {t('settings.slackConnectedTo').replace('{team}', teamName || 'Slack')}
            </span>
            {canManage && (
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setConfirmDisconnect(true)}>
                <Trash2 size={14} /> {t('settings.slackDisconnect')}
              </Button>
            )}
          </div>
          <p className="mt-2 text-[11px] text-faint">{t('settings.slackChannelHint')}</p>
        </div>
      )}

      {/* Advanced: legacy webhook accordion */}
      <div className="mt-3 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => setAdvancedOpen((o) => !o)}
          aria-expanded={advancedOpen}
          className="flex items-center gap-1 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronRight size={14} className={cn('transition-transform duration-[250ms] ease-smooth-out', advancedOpen && 'rotate-90')} />
          {t('settings.slackAdvanced')}
        </button>
        <div className={cn('grid transition-[grid-template-rows] duration-[250ms] ease-smooth-out', advancedOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
          <div className="overflow-hidden">
            <div className="pt-3">
              <Field label={t('settings.slackWebhook')}>
                <div className="flex items-center gap-2">
                  <Input
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={t('settings.slackPlaceholder')}
                    disabled={!canManage || ws.isLoading}
                    className="flex-1 font-mono text-[11px]"
                  />
                  {canManage && webhookDirty && (
                    <Button size="sm" onClick={() => saveWebhook.mutate(value.trim() || null)} disabled={saveWebhook.isPending}>
                      {saveWebhook.isPending ? <Spinner /> : null} {t('common.save')}
                    </Button>
                  )}
                  {canManage && !webhookDirty && stored && (
                    <Button size="sm" variant="ghost" onClick={() => saveWebhook.mutate(null)} disabled={saveWebhook.isPending}>
                      <Trash2 size={14} /> {t('settings.remove')}
                    </Button>
                  )}
                </div>
              </Field>
              {!canManage && <p className="mt-1.5 text-[11px] text-faint">{t('settings.slackNeedsManage')}</p>}
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        onConfirm={() => disconnect.mutate()}
        title={t('settings.slackDisconnectTitle')}
        body={t('settings.slackDisconnectBody')}
        confirmLabel={t('settings.slackDisconnect')}
        danger
        pending={disconnect.isPending}
      />
    </Card>
  );
}

/* ─────────────── Outgoing webhooks ─────────────── */

function WebhooksSection() {
  const t = useT();
  const qc = useQueryClient();
  const webhooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api.get<{ data: Webhook[] }>('/webhooks') });
  const hooks = webhooks.data?.data ?? [];
  const [addOpen, setAddOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Webhook | null>(null);

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/webhooks/${id}`),
    onSuccess: () => { setToDelete(null); qc.invalidateQueries({ queryKey: ['webhooks'] }); toast(t('settings.remove')); },
    onError: () => { setToDelete(null); toast.error(t('settings.saveFailed')); },
  });

  return (
    <div>
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[13px] font-semibold"><WebhookIcon size={15} /> {t('settings.webhooks')}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('settings.webhooksDesc')}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}><Plus size={14} /> {t('settings.addWebhook')}</Button>
      </div>

      {webhooks.isLoading ? (
        <Skeleton className="h-14 w-full" />
      ) : hooks.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t('settings.noWebhooks')}</p>
      ) : (
        <RowList>
          {hooks.map((h) => (
            <div key={h.id} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{h.url}</span>
              {h.eventTypes && h.eventTypes.length > 0 && (
                <Badge>{h.eventTypes.length}</Badge>
              )}
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className={cn('h-1.5 w-1.5 rounded-full', h.active === false ? 'bg-faint' : 'bg-success')} />
                {h.active === false ? t('settings.off') : t('settings.active')}
              </span>
              <IconButton size="sm" onClick={() => setToDelete(h)} title={t('settings.deleteWebhook')}><Trash2 size={14} /></IconButton>
            </div>
          ))}
        </RowList>
      )}

      <AddWebhookDialog open={addOpen} onClose={() => setAddOpen(false)} />
      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
        title={t('settings.deleteWebhook')}
        body={t('settings.deleteWebhookBody')}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </div>
  );
}

function AddWebhookDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [events, setEvents] = useState<Set<string>>(new Set());
  const firstRun = useRef(true);

  useEffect(() => {
    if (open) { setUrl(''); setSecret(''); setEvents(new Set()); firstRun.current = false; }
  }, [open]);

  const add = useMutation({
    mutationFn: () => api.post('/webhooks', { url: url.trim(), secret: secret.trim(), eventTypes: Array.from(events), active: true }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['webhooks'] }); toast(t('common.saved')); onClose(); },
    onError: () => toast.error(t('settings.saveFailed')),
  });

  const toggle = (e: string) => setEvents((prev) => { const n = new Set(prev); n.has(e) ? n.delete(e) : n.add(e); return n; });
  const valid = url.trim() && secret.trim() && events.size > 0;

  return (
    <Dialog open={open} onClose={onClose} title={t('settings.addWebhook')} width={520}>
      <div className="space-y-3 p-4">
        <Field label="URL"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/ordi" autoFocus /></Field>
        <Field label={t('settings.webhookSecret')}>
          <Input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="whsec_…" />
          <span className="mt-1 block text-[11px] text-faint">{t('settings.webhookSecretHint')}</span>
        </Field>
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">{t('settings.webhookEvents')}</span>
            {events.size === 0 && <span className="text-[11px] text-faint">{t('settings.selectEvents')}</span>}
          </div>
          <div className="grid max-h-52 grid-cols-2 gap-x-3 gap-y-1 overflow-y-auto rounded-md border border-border bg-card p-2">
            {EVENT_TYPES.map((e) => (
              <label key={e} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs transition-colors hover:bg-muted/60">
                <input type="checkbox" checked={events.has(e)} onChange={() => toggle(e)} className="accent-[hsl(var(--primary))]" />
                <span className="truncate font-mono text-[11px]">{e}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button size="sm" onClick={() => add.mutate()} disabled={!valid || add.isPending}>
            {add.isPending ? <Spinner /> : <Plus size={14} />} {t('common.add')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/* ─────────────── Panel ─────────────── */

export function IntegrationsPanel() {
  const t = useT();

  // Handle the OAuth return redirect (?git=connected|error). Read from the raw
  // URL on mount, toast, then strip the param via history.replaceState.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const git = params.get('git');
    const slack = params.get('slack');
    if (git === 'connected') toast(t('settings.githubConnected'));
    else if (git === 'error') toast.error(t('settings.githubConnectError'));
    if (slack === 'connected') toast(t('settings.slackConnected'));
    else if (slack === 'error') toast.error(t('settings.slackConnectError'));
    if (git || slack) {
      params.delete('git');
      params.delete('slack');
      const q = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (q ? `?${q}` : '') + window.location.hash);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6">
      <SectionHead title={t('settings.integrations')} desc={t('settings.integrationsDesc')} />
      <EmailCard />
      <GitHubCard />
      <SlackCard />
      <WebhooksSection />
    </div>
  );
}
