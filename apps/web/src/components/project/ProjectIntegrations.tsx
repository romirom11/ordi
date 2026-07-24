import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown, GitBranch, Github, Gitlab, Hash, Link2, Plus, Search, Slack, X,
} from 'lucide-react';
import { api, qs, ApiError } from '../../lib/api';
import { Link } from '../../lib/router';
import {
  Badge, Button, Input, Spinner, cn,
} from '../ui';
import { Dialog, DropdownMenu, MenuItem, MenuLabel, toast } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'projects.integrations': 'Integrations',
    'projects.git': 'Git',
    'projects.gitDesc': 'Bind repositories to see branches and PRs on tasks.',
    'projects.connectRepo': 'Connect repository',
    'projects.noRepos': 'No repositories linked',
    'projects.noReposHint': 'Bind a repository to see branches and PRs on tasks.',
    'projects.connectionsHint': 'Git connections are managed in Settings → Integrations.',
    'projects.pickConnection': 'Connection',
    'projects.pickRepo': 'Repository',
    'projects.searchRepos': 'Search repositories…',
    'projects.noConnections': 'No git connections yet',
    'projects.noConnectionsHint': 'Add a git connection first in Settings → Integrations.',
    'projects.noConnRepos': 'No repositories available on this connection.',
    'projects.reposLoadFailed': 'Could not load repositories.',
    'projects.unbindRepo': 'Unbind',
    'projects.repoBound': 'Repository linked',
    'projects.repoUnbound': 'Repository unlinked',
    'projects.slack': 'Slack',
    'projects.slackUrl': 'Slack webhook URL',
    'projects.slackDesc': 'Project events (tasks, status changes) are posted to this channel. Create an Incoming Webhook in Slack and paste the URL here.',
    'projects.slackSaved': 'Slack webhook saved',
    'projects.openSettings': 'Open Integrations',
    'projects.slackChannel': 'Channel',
    'projects.slackChannelDesc': 'Project events (tasks, status changes) are posted to this Slack channel.',
    'projects.slackPickChannel': 'Select a channel…',
    'projects.slackChannelSaved': 'Slack channel updated',
    'projects.slackChannelCleared': 'Slack channel cleared',
    'projects.slackClear': 'No channel',
    'projects.slackSearchChannels': 'Search channels…',
    'projects.slackLoadFailed': 'Could not load channels.',
    'projects.slackNotConnected': 'Connect Slack in',
    'projects.settingsIntegrations': 'Settings → Integrations',
    'projects.advanced': 'Advanced',
    'projects.slackWebhookAdvanced': 'Post to an Incoming Webhook URL instead of a workspace channel.',
  },
  uk: {
    'projects.integrations': 'Інтеграції',
    'projects.git': 'Git',
    'projects.gitDesc': 'Привʼяжіть репозиторії, щоб бачити гілки та PR-и у задачах.',
    'projects.connectRepo': 'Привʼязати репозиторій',
    'projects.noRepos': 'Репозиторії не привʼязані',
    'projects.noReposHint': 'Привʼяжіть репозиторій, щоб бачити гілки та PR-и у задачах.',
    'projects.connectionsHint': 'Git-зʼєднання налаштовуються в Налаштування → Інтеграції.',
    'projects.pickConnection': 'Зʼєднання',
    'projects.pickRepo': 'Репозиторій',
    'projects.searchRepos': 'Пошук репозиторіїв…',
    'projects.noConnections': 'Ще немає git-зʼєднань',
    'projects.noConnectionsHint': 'Спершу додайте git-зʼєднання в Налаштування → Інтеграції.',
    'projects.noConnRepos': 'На цьому зʼєднанні немає доступних репозиторіїв.',
    'projects.reposLoadFailed': 'Не вдалося завантажити репозиторії.',
    'projects.unbindRepo': 'Відвʼязати',
    'projects.repoBound': 'Репозиторій привʼязано',
    'projects.repoUnbound': 'Репозиторій відвʼязано',
    'projects.slack': 'Slack',
    'projects.slackUrl': 'URL вебхука Slack',
    'projects.slackDesc': 'Події проєкту (задачі, статуси) поститимуться в цей канал. Створіть Incoming Webhook у Slack і вставте URL сюди.',
    'projects.slackSaved': 'Вебхук Slack збережено',
    'projects.openSettings': 'Відкрити Інтеграції',
    'projects.slackChannel': 'Канал',
    'projects.slackChannelDesc': 'Події проєкту (задачі, статуси) поститимуться в цей канал Slack.',
    'projects.slackPickChannel': 'Обрати канал…',
    'projects.slackChannelSaved': 'Канал Slack оновлено',
    'projects.slackChannelCleared': 'Канал Slack очищено',
    'projects.slackClear': 'Без каналу',
    'projects.slackSearchChannels': 'Пошук каналів…',
    'projects.slackLoadFailed': 'Не вдалося завантажити канали.',
    'projects.slackNotConnected': 'Підключіть Slack у',
    'projects.settingsIntegrations': 'Settings → Integrations',
    'projects.advanced': 'Додатково',
    'projects.slackWebhookAdvanced': 'Постити на URL Incoming Webhook замість каналу робочого простору.',
  },
});

interface Connection { id: string; provider: string; status?: string; instanceUrl?: string | null }
interface Repo { id?: string; connectionId?: string; externalId: string; fullName?: string; defaultBranch?: string }
interface BoundRepo {
  id?: string; repositoryId?: string; connectionId?: string;
  externalId?: string; fullName?: string; defaultBranch?: string;
}

function ProviderIcon({ provider, className }: { provider?: string; className?: string }) {
  if (provider === 'gitlab') return <Gitlab size={14} className={className} />;
  if (provider === 'github') return <Github size={14} className={className} />;
  return <GitBranch size={14} className={className} />;
}

/**
 * Fetch repositories for a connection, tolerating either endpoint contract.
 * The brief's provider-backed endpoint may not exist yet; if it is missing or
 * errors, fall back to the registered-repositories list for the connection.
 */
async function fetchConnectionRepos(connId: string): Promise<Repo[]> {
  try {
    const r = await api.get<{ data: Repo[] }>(`/integrations/git/connections/${connId}/repos`);
    return r.data ?? [];
  } catch {
    // Endpoint not available (404/5xx) – use the registered repositories.
    const r = await api.get<{ data: Repo[] }>(`/integrations/git/repositories${qs({ connectionId: connId })}`);
    return r.data ?? [];
  }
}

/* ───────────────────────────── Git ───────────────────────────── */

function GitSection({ projectId, canManage }: { projectId: string; canManage: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);

  const boundQ = useQuery<BoundRepo[]>({
    queryKey: ['project-repos', projectId],
    queryFn: () => api.get<{ data: BoundRepo[] }>(`/projects/${projectId}/repositories`).then((r) => r.data),
  });
  // Registry used to enrich bare join rows ({projectId, repositoryId}) with names.
  const registryQ = useQuery<Repo[]>({
    queryKey: ['git-repos-registry'],
    queryFn: () => api.get<{ data: Repo[] }>('/integrations/git/repositories').then((r) => r.data),
    enabled: canManage,
    staleTime: 60_000,
  });
  const registry = useMemo(() => {
    const m = new Map<string, Repo>();
    for (const r of registryQ.data ?? []) if (r.id) m.set(r.id, r);
    return m;
  }, [registryQ.data]);

  const bound = boundQ.data ?? [];
  const view = bound.map((r) => {
    const rid = r.repositoryId ?? r.id ?? r.externalId ?? '';
    const meta = registry.get(rid);
    return {
      key: rid,
      deleteId: r.repositoryId ?? r.id ?? r.externalId ?? '',
      fullName: r.fullName ?? meta?.fullName ?? rid,
      defaultBranch: r.defaultBranch ?? meta?.defaultBranch,
    };
  });
  const boundIds = new Set(view.map((v) => v.key));

  const unbind = useMutation({
    mutationFn: (deleteId: string) => api.del(`/projects/${projectId}/repositories/${deleteId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['project-repos', projectId] }); toast(t('projects.repoUnbound')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  if (!canManage && bound.length === 0) return null;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <GitBranch size={15} className="text-muted-foreground" />
          <h3 className="text-[13px] font-semibold">{t('projects.git')}</h3>
        </div>
        {canManage && (
          <Button size="xs" variant="outline" onClick={() => setDialogOpen(true)}>
            <Plus size={13} /> {t('projects.connectRepo')}
          </Button>
        )}
      </div>

      {boundQ.isLoading ? (
        <div className="h-9 animate-pulse rounded-lg border border-border bg-muted/40" />
      ) : view.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card px-4 py-6 text-center">
          <GitBranch size={18} className="mx-auto text-faint" />
          <p className="mt-1.5 text-[13px] font-medium">{t('projects.noRepos')}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('projects.noReposHint')}</p>
          <p className="mt-1 text-xs text-faint">
            {t('projects.connectionsHint')}{' '}
            <Link to="/settings/integrations" className="text-primary hover:underline">{t('projects.openSettings')}</Link>
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {view.map((r, i) => (
            <div key={r.key} className={cn('group flex items-center gap-2.5 px-3 py-2', i > 0 && 'border-t border-border')}>
              <GitBranch size={15} className="shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate font-mono text-[12px]">{r.fullName}</span>
              {r.defaultBranch && (
                <Badge className="bg-muted font-mono text-[10px] text-muted-foreground">{r.defaultBranch}</Badge>
              )}
              {canManage && (
                <button
                  onClick={() => unbind.mutate(r.deleteId)}
                  aria-label={t('projects.unbindRepo')}
                  className="shrink-0 rounded p-1 text-faint opacity-0 transition-colors duration-150 hover:bg-muted hover:text-destructive group-hover:opacity-100"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canManage && (
        <ConnectRepoDialog
          projectId={projectId}
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          boundIds={boundIds}
        />
      )}
    </div>
  );
}

function ConnectRepoDialog({ projectId, open, onClose, boundIds }: {
  projectId: string; open: boolean; onClose: () => void; boundIds: Set<string>;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [connId, setConnId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const connectionsQ = useQuery<Connection[]>({
    queryKey: ['git-connections'],
    queryFn: () => api.get<{ data: Connection[] }>('/integrations/git/connections').then((r) => r.data),
    enabled: open,
  });
  const connections = connectionsQ.data ?? [];
  const activeConn = connId ?? connections[0]?.id ?? null;
  const selectedConn = connections.find((c) => c.id === activeConn);

  const reposQ = useQuery<Repo[]>({
    queryKey: ['conn-repos', activeConn],
    queryFn: () => fetchConnectionRepos(activeConn!),
    enabled: open && !!activeConn,
  });
  const repos = (reposQ.data ?? []).filter((r) => {
    const rid = r.id ?? r.externalId;
    if (boundIds.has(rid)) return false;
    if (!search.trim()) return true;
    return (r.fullName ?? '').toLowerCase().includes(search.trim().toLowerCase());
  });

  const bind = useMutation({
    mutationFn: (repo: Repo) => api.post(`/projects/${projectId}/repositories`, {
      repositoryId: repo.id ?? repo.externalId,
      connectionId: activeConn,
      externalId: repo.externalId,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch ?? 'main',
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project-repos', projectId] });
      toast(t('projects.repoBound'));
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  return (
    <Dialog open={open} onClose={onClose} title={t('projects.connectRepo')} width={460}>
      <div className="space-y-3 px-4 pb-4 pt-1">
        {connectionsQ.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-[13px] text-muted-foreground"><Spinner /> {t('common.loading')}</div>
        ) : connections.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
            <Link2 size={18} className="mx-auto text-faint" />
            <p className="mt-1.5 text-[13px] font-medium">{t('projects.noConnections')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('projects.noConnectionsHint')}</p>
            <Link to="/settings/integrations" className="mt-2 inline-block text-xs text-primary hover:underline">
              {t('projects.openSettings')}
            </Link>
          </div>
        ) : (
          <>
            {/* Connection selector */}
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{t('projects.pickConnection')}</label>
              <DropdownMenu
                align="start"
                width={412}
                className="w-full"
                trigger={
                  <span className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border border-input px-2.5 text-[13px] transition-colors hover:border-border-strong">
                    <ProviderIcon provider={selectedConn?.provider} className="text-muted-foreground" />
                    <span className="flex-1 truncate">{selectedConn ? (selectedConn.instanceUrl || selectedConn.provider) : '–'}</span>
                  </span>
                }
              >
                <MenuLabel>{t('projects.pickConnection')}</MenuLabel>
                {connections.map((c) => (
                  <MenuItem key={c.id} icon={<ProviderIcon provider={c.provider} />} checked={c.id === activeConn}
                    onSelect={() => { setConnId(c.id); setSearch(''); }}>
                    {c.instanceUrl || c.provider}
                  </MenuItem>
                ))}
              </DropdownMenu>
            </div>

            {/* Repo search + list */}
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">{t('projects.pickRepo')}</label>
              <div className="relative">
                <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('projects.searchRepos')} className="pl-8" />
              </div>
              <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-border">
                {reposQ.isLoading ? (
                  <div className="flex items-center gap-2 px-3 py-6 text-[13px] text-muted-foreground"><Spinner /> {t('common.loading')}</div>
                ) : reposQ.isError ? (
                  <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">{t('projects.reposLoadFailed')}</p>
                ) : repos.length === 0 ? (
                  <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">{t('projects.noConnRepos')}</p>
                ) : (
                  repos.map((r, i) => (
                    <button
                      key={r.id ?? r.externalId}
                      onClick={() => bind.mutate(r)}
                      disabled={bind.isPending}
                      className={cn('flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors duration-150 hover:bg-muted disabled:opacity-60',
                        i > 0 && 'border-t border-border')}
                    >
                      <GitBranch size={14} className="shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate font-mono text-[12px]">{r.fullName ?? r.externalId}</span>
                      {r.defaultBranch && <Badge className="bg-muted font-mono text-[10px] text-muted-foreground">{r.defaultBranch}</Badge>}
                    </button>
                  ))
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/* ───────────────────────────── Slack ───────────────────────────── */

interface SlackStatus { configured?: boolean; connected?: boolean; teamName?: string | null }
interface SlackChannel { id: string; name: string; isPrivate?: boolean }

function ChannelPicker({ channels, currentId, onSelect, onClear }: {
  channels: SlackChannel[]; currentId: string;
  onSelect: (id: string) => void; onClear: () => void;
}) {
  const t = useT();
  const [search, setSearch] = useState('');
  const showSearch = channels.length > 15;
  const current = channels.find((c) => c.id === currentId);
  const filtered = search.trim()
    ? channels.filter((c) => c.name.toLowerCase().includes(search.trim().toLowerCase()))
    : channels;

  return (
    <DropdownMenu
      align="start"
      width={300}
      className="w-full"
      trigger={
        <span className="flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-md border border-input px-2.5 text-[13px] transition-colors hover:border-border-strong">
          {current ? (
            <>
              <Hash size={14} className="shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{current.name}</span>
            </>
          ) : (
            <span className="flex-1 truncate text-faint">{t('projects.slackPickChannel')}</span>
          )}
          <ChevronDown size={14} className="shrink-0 text-faint" />
        </span>
      }
    >
      {showSearch && (
        <div className="p-1">
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
            <Input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('projects.slackSearchChannels')} className="h-7 pl-7 text-[13px]" />
          </div>
        </div>
      )}
      <div className="max-h-64 overflow-y-auto">
        {filtered.map((c) => (
          <MenuItem key={c.id} icon={<Hash size={14} />} checked={c.id === currentId} onSelect={() => onSelect(c.id)}>
            {c.name}
          </MenuItem>
        ))}
      </div>
      {current && (
        <>
          <div className="mx-1 my-1 h-px bg-border" />
          <MenuItem icon={<X size={14} />} danger onSelect={onClear}>{t('projects.slackClear')}</MenuItem>
        </>
      )}
    </DropdownMenu>
  );
}

function AdvancedWebhook({ projectId, settings, version }: {
  projectId: string; settings: Record<string, unknown>; version?: number;
}) {
  const t = useT();
  const qc = useQueryClient();
  const initial = typeof settings.slackWebhookUrl === 'string' ? settings.slackWebhookUrl : '';
  const [open, setOpen] = useState(!!initial);
  const [url, setUrl] = useState(initial);

  const save = useMutation({
    mutationFn: () => api.patch(`/projects/${projectId}`, {
      settings: { ...settings, slackWebhookUrl: url.trim() || undefined },
      version,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['project', projectId] }); toast(t('projects.slackSaved')); },
    onError: (e) => {
      if (e instanceof ApiError && (e.status === 409 || e.code === 'conflict')) {
        qc.invalidateQueries({ queryKey: ['project', projectId] }); toast.error(t('projects.conflict'));
      } else toast.error(e instanceof ApiError ? e.message : t('common.saveFailed'));
    },
  });
  const dirty = url.trim() !== initial;

  return (
    <div className="mt-2 border-t border-border pt-2">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDown size={13} className={cn('transition-transform duration-150', open ? 'rotate-0' : '-rotate-90')} />
        {t('projects.advanced')}
      </button>
      {open && (
        <div className="mt-2">
          <label className="mb-1 block text-xs text-muted-foreground">{t('projects.slackUrl')}</label>
          <div className="flex gap-2">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.slack.com/services/…" className="font-mono text-[12px]" />
            <Button size="sm" variant="outline" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? <Spinner /> : t('common.save')}
            </Button>
          </div>
          <p className="mt-2 text-xs text-faint">{t('projects.slackWebhookAdvanced')}</p>
        </div>
      )}
    </div>
  );
}

function SlackSection({ projectId, settings, version, canManage }: {
  projectId: string; settings: Record<string, unknown>; version?: number; canManage: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const currentId = typeof settings.slackChannelId === 'string' ? settings.slackChannelId : '';

  const statusQ = useQuery<SlackStatus>({
    queryKey: ['slack-status'],
    queryFn: () => api.get<SlackStatus>('/integrations/slack/status'),
    enabled: canManage,
    staleTime: 60_000,
    retry: false,
  });
  const connected = statusQ.data?.connected ?? false;

  const channelsQ = useQuery<SlackChannel[]>({
    queryKey: ['slack-channels'],
    queryFn: () => api.get<{ data: SlackChannel[] }>('/integrations/slack/channels').then((r) => r.data),
    enabled: canManage && connected,
    staleTime: 60_000,
    retry: false,
  });
  const channels = channelsQ.data ?? [];

  const save = useMutation({
    mutationFn: (channelId: string | undefined) => api.patch(`/projects/${projectId}`, {
      settings: { ...settings, slackChannelId: channelId },
      version,
    }),
    onSuccess: (_d, channelId) => {
      qc.invalidateQueries({ queryKey: ['project', projectId] });
      toast(channelId ? t('projects.slackChannelSaved') : t('projects.slackChannelCleared'));
    },
    onError: (e) => {
      if (e instanceof ApiError && (e.status === 409 || e.code === 'conflict')) {
        qc.invalidateQueries({ queryKey: ['project', projectId] }); toast.error(t('projects.conflict'));
      } else toast.error(e instanceof ApiError ? e.message : t('common.saveFailed'));
    },
  });

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <Slack size={15} className="text-muted-foreground" />
        <h3 className="text-[13px] font-semibold">{t('projects.slack')}</h3>
      </div>
      <div className="rounded-lg border border-border bg-card p-3">
        {statusQ.isLoading ? (
          <div className="h-8 animate-pulse rounded-md bg-muted/40" />
        ) : connected ? (
          <>
            <label className="mb-1 block text-xs text-muted-foreground">{t('projects.slackChannel')}</label>
            {channelsQ.isLoading ? (
              <div className="h-8 animate-pulse rounded-md bg-muted/40" />
            ) : channelsQ.isError ? (
              <p className="text-[13px] text-muted-foreground">{t('projects.slackLoadFailed')}</p>
            ) : (
              <ChannelPicker
                channels={channels}
                currentId={currentId}
                onSelect={(id) => save.mutate(id)}
                onClear={() => save.mutate(undefined)}
              />
            )}
            <p className="mt-2 text-xs text-faint">
              {t('projects.slackChannelDesc')}
              {statusQ.data?.teamName ? ` · ${statusQ.data.teamName}` : ''}
            </p>
          </>
        ) : (
          <p className="text-xs text-faint">
            {t('projects.slackNotConnected')}{' '}
            <Link to="/settings/integrations" className="text-primary hover:underline">{t('projects.settingsIntegrations')}</Link>
          </p>
        )}

        <AdvancedWebhook projectId={projectId} settings={settings} version={version} />
      </div>
    </div>
  );
}

/* ───────────────────────────── Section wrapper ───────────────────────────── */

export function ProjectIntegrations({ projectId, settings, version, canManage }: {
  projectId: string; settings?: Record<string, unknown>; version?: number; canManage: boolean;
}) {
  const t = useT();
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('projects.integrations')}</h2>
      <div className="space-y-6">
        <GitSection projectId={projectId} canManage={canManage} />
        {canManage && (
          <SlackSection projectId={projectId} settings={settings ?? {}} version={version} canManage={canManage} />
        )}
      </div>
    </section>
  );
}
