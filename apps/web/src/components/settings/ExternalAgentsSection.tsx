/**
 * Settings → Agents → External agents: agents that run outside ordi (Claude
 * Code, Codex, a script on a server) and connect over MCP under a name of
 * their own instead of a person's token. Each gets an owner – the person
 * behind it – and tokens that are shown once and revoked one by one. Which
 * projects it reaches is its project memberships, set in each project's
 * Access settings like anyone else's.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Plug, Plus, TriangleAlert } from 'lucide-react';
import { EXTERNAL_AGENT_TOKEN_DAYS } from '@ordi/shared';
import { api, ApiError, appOrigin } from '../../lib/api';
import { activeUsers, useUsersLookup } from '../../lib/queries';
import { useMe } from '../../lib/auth';
import { Avatar, Badge, Button, EmptyState, Input, Select, Skeleton, Spinner, Switch, cn, fmtDate, fmtRelative } from '../ui';
import { ConfirmDialog, Dialog, toast } from '../overlays';
import { AnimatedRow, Field, RowList } from './primitives';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'extAgents.title': 'External agents',
    'extAgents.desc': 'Agents that run elsewhere – Claude Code, Codex, a script on a server – and connect over MCP under their own name. They work only in the projects they are added to.',
    'extAgents.new': 'New external agent',
    'extAgents.none': 'No external agents yet',
    'extAgents.noneHint': 'Create one for each agent that works on its own, so its comments and changes carry its name instead of yours.',
    'extAgents.owner': 'Owner',
    'extAgents.ownerHint': 'The person behind the agent – who it works for.',
    'extAgents.noProjects': 'No projects yet – add it under a project\'s Settings → Access',
    'extAgents.projects': 'Projects',
    'extAgents.tokens': 'Tokens',
    'extAgents.noTokens': 'No live tokens',
    'extAgents.issue': 'New token',
    'extAgents.expires': 'Expires',
    'extAgents.expiresIn': 'Valid for',
    'extAgents.days': '{n} days',
    'extAgents.never': 'Never expires',
    'extAgents.lastUsed': 'last used {when}',
    'extAgents.neverUsed': 'not used yet',
    'extAgents.revoke': 'Revoke',
    'extAgents.revokeTitle': 'Revoke this token?',
    'extAgents.revokeBody': 'An agent using it is disconnected at its next request.',
    'extAgents.revoked': 'Token revoked',
    'extAgents.active': 'Switched on',
    'extAgents.activeHint': 'Switching it off revokes all its tokens.',
    'extAgents.off': 'Off',
    'extAgents.tokenOnce': 'Copy the token now – it is not shown again.',
    'extAgents.connect': 'Connect',
    'extAgents.claudeCode': 'Claude Code',
    'extAgents.otherClients': 'Other MCP clients (JSON)',
    'extAgents.manage': 'Manage',
    'extAgents.copied': 'Copied',
    'extAgents.hidden': '{n} more you cannot open',
    'extAgents.ownerChangeHint': 'A new owner revokes its tokens – issue a fresh one after.',
  },
  uk: {
    'extAgents.title': 'Зовнішні агенти',
    'extAgents.desc': 'Агенти, які працюють деінде – Claude Code, Codex, скрипт на сервері – і підключаються через MCP під власним іменем. Вони працюють лише в проєктах, куди їх додано.',
    'extAgents.new': 'Новий зовнішній агент',
    'extAgents.none': 'Зовнішніх агентів ще немає',
    'extAgents.noneHint': 'Створіть по одному на кожного агента, що працює сам, – тоді його коментарі й зміни будуть під його іменем, а не вашим.',
    'extAgents.owner': 'Власник',
    'extAgents.ownerHint': 'Людина, яка стоїть за агентом, – на кого він працює.',
    'extAgents.noProjects': 'Ще немає проєктів – додайте його в Налаштуваннях проєкту → Доступ',
    'extAgents.projects': 'Проєкти',
    'extAgents.tokens': 'Токени',
    'extAgents.noTokens': 'Немає дійсних токенів',
    'extAgents.issue': 'Новий токен',
    'extAgents.expires': 'Діє до',
    'extAgents.expiresIn': 'Термін дії',
    'extAgents.days': '{n} днів',
    'extAgents.never': 'Безстроковий',
    'extAgents.lastUsed': 'востаннє {when}',
    'extAgents.neverUsed': 'ще не використовувався',
    'extAgents.revoke': 'Відкликати',
    'extAgents.revokeTitle': 'Відкликати цей токен?',
    'extAgents.revokeBody': 'Агента, який ним користується, буде відключено на наступному запиті.',
    'extAgents.revoked': 'Токен відкликано',
    'extAgents.active': 'Увімкнено',
    'extAgents.activeHint': 'Вимкнення відкликає всі його токени.',
    'extAgents.off': 'Вимкнено',
    'extAgents.tokenOnce': 'Скопіюйте токен зараз – більше його не покажуть.',
    'extAgents.connect': 'Підключення',
    'extAgents.claudeCode': 'Claude Code',
    'extAgents.otherClients': 'Інші MCP-клієнти (JSON)',
    'extAgents.manage': 'Керувати',
    'extAgents.copied': 'Скопійовано',
    'extAgents.hidden': 'ще {n}, недоступних вам',
    'extAgents.ownerChangeHint': 'Новий власник – і його токени відкликаються, випустіть новий.',
  },
});

interface ExternalAgentToken { id: string; name: string; prefix: string; lastUsedAt: string | null; expiresAt: string | null; createdAt: string }
interface ExternalAgent {
  id: string; name: string; avatar: string | null; isActive: boolean; roleName: string;
  ownerUserId: string; ownerName: string | null;
  projects: { id: string; key: string; name: string }[];
  hiddenProjects: number;
  tokens: ExternalAgentToken[];
}

const KEY = ['external-agents'];

export function ExternalAgentsSection() {
  const t = useT();
  const agentsQ = useQuery<ExternalAgent[]>({
    queryKey: KEY,
    queryFn: () => api.get<{ data: ExternalAgent[] }>('/external-agents').then((r) => r.data),
  });
  const agents = agentsQ.data ?? [];
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const open = agents.find((a) => a.id === openId) ?? null;

  return (
    <div>
      <div className="mb-2 mt-8 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">{t('extAgents.title')}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('extAgents.desc')}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus size={14} /> {t('extAgents.new')}</Button>
      </div>

      {agentsQ.isLoading ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : agents.length === 0 ? (
        <RowList><EmptyState icon={<Plug size={18} />} title={t('extAgents.none')} hint={t('extAgents.noneHint')} /></RowList>
      ) : (
        <RowList>
          {agents.map((a, i) => (
            <AnimatedRow key={a.id} index={i} className="border-b border-border last:border-0">
              <button type="button" onClick={() => setOpenId(a.id)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
                <Avatar name={a.name} src={a.avatar} size={28} agent className={a.isActive ? undefined : 'opacity-50'} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium">{a.name}</span>
                    {!a.isActive && <Badge>{t('extAgents.off')}</Badge>}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-faint">
                    <span>{t('extAgents.owner')}: {a.ownerName ?? '–'}</span>
                    <span>· {a.roleName || '–'}</span>
                    <span>· {a.projects.length || a.hiddenProjects ? [...a.projects.map((p) => p.key), ...(a.hiddenProjects ? [t('extAgents.hidden').replace('{n}', String(a.hiddenProjects))] : [])].join(', ') : t('extAgents.noProjects')}</span>
                    <span>· {t('extAgents.tokens')}: {a.tokens.length}</span>
                  </div>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{t('extAgents.manage')}</span>
              </button>
            </AnimatedRow>
          ))}
        </RowList>
      )}

      <CreateDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); setOpenId(id); }} />
      {open && <ManageDialog agent={open} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function OwnerSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const t = useT();
  const usersQ = useUsersLookup();
  const people = activeUsers(usersQ.data ?? []).filter((u) => u.actorType !== 'agent');
  // An owner who has since been deactivated still shows as the value, so the
  // select does not silently claim the first person in the list is the owner.
  const current = value && !people.some((u) => u.id === value) ? (usersQ.data ?? []).find((u) => u.id === value) : undefined;
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)}>
      {current && <option value={current.id} disabled>{current.name} · {t('task.deactivatedUser', 'deactivated')}</option>}
      {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
    </Select>
  );
}

function CreateDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe();
  const [name, setName] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  useEffect(() => {
    if (!open) return;
    setName('');
    setOwnerUserId(me.user.id);
  }, [open, me.user.id]);

  const create = useMutation({
    mutationFn: () => api.post<ExternalAgent>('/external-agents', { name: name.trim(), ...(ownerUserId ? { ownerUserId } : {}) }),
    onSuccess: (agent) => { qc.invalidateQueries({ queryKey: KEY }); qc.invalidateQueries({ queryKey: ['users-lookup'] }); onCreated(agent.id); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  return (
    <Dialog open={open} onClose={onClose} title={t('extAgents.new')} width={440}>
      <form className="space-y-3.5 px-4 pb-4 pt-1" onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
        <Field label={t('common.name')}>
          <Input autoFocus value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Claude Code – content" />
        </Field>
        <Field label={t('extAgents.owner')}>
          <OwnerSelect value={ownerUserId} onChange={setOwnerUserId} />
          <span className="mt-1 block text-xs text-muted-foreground">{t('extAgents.ownerHint')}</span>
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={!name.trim() || create.isPending}>
            {create.isPending ? <Spinner /> : null} {t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ManageDialog({ agent, onClose }: { agent: ExternalAgent; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });
  const apiError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed'));
  const [name, setName] = useState(agent.name);
  const [days, setDays] = useState<string>('90');
  const [issued, setIssued] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ExternalAgentToken | null>(null);
  useEffect(() => { setName(agent.name); setIssued(null); }, [agent.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/external-agents/${agent.id}`, body),
    onSuccess: () => { refresh(); qc.invalidateQueries({ queryKey: ['users-lookup'] }); },
    onError: apiError,
  });
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.post(`/external-agents/${agent.id}/${on ? 'enable' : 'disable'}`),
    // Switching off revokes every token, the one just shown included.
    onSuccess: (_r, on) => { if (!on) setIssued(null); refresh(); qc.invalidateQueries({ queryKey: ['users-lookup'] }); },
    onError: apiError,
  });
  const issue = useMutation({
    mutationFn: () => api.post<{ token: string }>(`/external-agents/${agent.id}/tokens`, {
      name: 'MCP token', expiresInDays: days === 'never' ? null : Number(days),
    }),
    onSuccess: (r) => { setIssued(r.token); refresh(); },
    onError: apiError,
  });
  const revoke = useMutation({
    mutationFn: (tokenId: string) => api.del(`/external-agents/${agent.id}/tokens/${tokenId}`),
    onSuccess: () => { setRevoking(null); refresh(); toast(t('extAgents.revoked')); },
    onError: (e) => { setRevoking(null); apiError(e); },
  });

  return (
    <Dialog open onClose={onClose} title={agent.name} width={560}>
      <div className="space-y-5 px-4 pb-4 pt-1">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('common.name')}>
            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)}
              onBlur={() => { if (name.trim() && name.trim() !== agent.name) patch.mutate({ name: name.trim() }); }} />
          </Field>
          <Field label={t('extAgents.owner')}>
            <OwnerSelect value={agent.ownerUserId} onChange={(id) => { if (id !== agent.ownerUserId) { setIssued(null); patch.mutate({ ownerUserId: id }); } }} />
            <span className="mt-1 block text-xs text-muted-foreground">{t('extAgents.ownerChangeHint')}</span>
          </Field>
        </div>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">{t('extAgents.active')}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{t('extAgents.activeHint')}</div>
          </div>
          <Switch checked={agent.isActive} disabled={toggle.isPending} onChange={(v) => toggle.mutate(v)} label={t('extAgents.active')} />
        </div>

        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">{t('extAgents.projects')}</div>
          <p className="text-[13px]">
            {agent.projects.length ? agent.projects.map((p) => `${p.key} · ${p.name}`).join(', ') : !agent.hiddenProjects && <span className="text-muted-foreground">{t('extAgents.noProjects')}</span>}
            {agent.hiddenProjects > 0 && <span className="text-muted-foreground">{agent.projects.length ? ' · ' : ''}{t('extAgents.hidden').replace('{n}', String(agent.hiddenProjects))}</span>}
          </p>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="text-xs font-medium text-muted-foreground">{t('extAgents.tokens')}</div>
            <div className="flex items-center gap-2">
              <Select value={days} onChange={(e) => setDays(e.target.value)} className="h-7 w-36 text-xs" aria-label={t('extAgents.expiresIn')}>
                {EXTERNAL_AGENT_TOKEN_DAYS.map((d) => <option key={d} value={String(d)}>{t('extAgents.days').replace('{n}', String(d))}</option>)}
                <option value="never">{t('extAgents.never')}</option>
              </Select>
              <Button size="xs" disabled={!agent.isActive || issue.isPending} onClick={() => issue.mutate()}>
                {issue.isPending ? <Spinner /> : <KeyRound size={13} />} {t('extAgents.issue')}
              </Button>
            </div>
          </div>

          {issued && <IssuedToken token={issued} />}

          <div className="rounded-lg border border-border">
            {agent.tokens.length === 0 ? (
              <p className="px-3 py-2.5 text-[13px] text-muted-foreground">{t('extAgents.noTokens')}</p>
            ) : agent.tokens.map((tok, i) => (
              <div key={tok.id} className={cn('flex items-center gap-3 px-3 py-2', i > 0 && 'border-t border-border')}>
                <code className="font-mono text-[12px]">{tok.prefix}…</code>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {tok.lastUsedAt ? t('extAgents.lastUsed').replace('{when}', fmtRelative(tok.lastUsedAt)) : t('extAgents.neverUsed')}
                  {' · '}
                  {tok.expiresAt ? `${t('extAgents.expires')} ${fmtDate(tok.expiresAt)}` : t('extAgents.never')}
                </span>
                <Button size="xs" variant="ghost" className="text-destructive" onClick={() => setRevoking(tok)}>{t('extAgents.revoke')}</Button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={() => { if (revoking) revoke.mutate(revoking.id); }}
        title={t('extAgents.revokeTitle')}
        body={t('extAgents.revokeBody')}
        confirmLabel={t('extAgents.revoke')}
        danger
        pending={revoke.isPending}
      />
    </Dialog>
  );
}

/** The token once, with the two ways to plug it in. */
function IssuedToken({ token }: { token: string }) {
  const t = useT();
  const url = `${appOrigin()}/api/v1/mcp`;
  const claudeCode = `claude mcp add --transport http ordi ${url} --header "Authorization: Bearer ${token}"`;
  const json = JSON.stringify({ mcpServers: { ordi: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  return (
    <div className="anim-pop-in mb-3 space-y-2.5 rounded-lg border border-warning/40 bg-warning/5 p-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-warning"><TriangleAlert size={13} /> {t('extAgents.tokenOnce')}</div>
      <Snippet value={token} mono />
      <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">{t('extAgents.connect')}</div>
      <div>
        <div className="mb-1 text-xs text-muted-foreground">{t('extAgents.claudeCode')}</div>
        <Snippet value={claudeCode} mono />
      </div>
      <div>
        <div className="mb-1 text-xs text-muted-foreground">{t('extAgents.otherClients')}</div>
        <Snippet value={json} mono block />
      </div>
    </div>
  );
}

function Snippet({ value, mono, block }: { value: string; mono?: boolean; block?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2">
      {block ? (
        <pre className={cn('min-w-0 flex-1 overflow-x-auto rounded-md bg-muted/60 px-2 py-1.5 text-[11px]', mono && 'font-mono')}>{value}</pre>
      ) : (
        <span className={cn('min-w-0 flex-1 truncate rounded-md bg-muted/60 px-2 py-1.5 text-[11px]', mono && 'font-mono')}>{value}</span>
      )}
      <Button
        size="xs"
        variant="outline"
        aria-label={t('common.copy')}
        onClick={() => { navigator.clipboard?.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); toast(t('extAgents.copied')); }}
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </Button>
    </div>
  );
}
