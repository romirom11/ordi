/**
 * Profile → MCP & API → Your agent: one agent of your own for Claude Code,
 * Codex and the like. It works your tasks under its own name – it asks you
 * instead of writing as you – and can do only what you can, as a member at
 * most: tasks and the knowledge base, never finance, people, settings or
 * secrets. Its clients are connected above and listed under Connections, so
 * this section is only the agent itself: its name, its switch, what it can do.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Bot, Zap } from 'lucide-react';
import { mcpToolsOfKind } from '@ordi/shared';
import { api, ApiError } from '../../lib/api';
import { Avatar, Button, Input, Skeleton, Spinner, Switch } from '../ui';
import { ConfirmDialog, toast } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';
import { myAgentView } from './myAgentView';
import { Disclosure, RowList, SubHead } from './primitives';
import type { AgentToken } from './connections';

extendDict({
  en: {
    'myAgent.title': 'Your agent',
    'myAgent.summary': 'Works your tasks under its own name, and asks you when it is unsure instead of writing as you.',
    'myAgent.summaryOff': 'Switched off: no client can work as it until you switch it back on.',
    'myAgent.details': 'What it can do',
    'myAgent.desc': 'It can only do what you can with tasks and the knowledge base – never finance, people, settings or secrets – and no more than a member. A client connected as you instead works with everything your role allows.',
    'myAgent.toolsHint': 'The tools ordi offers a connected client; each one still checks what it works as may do.',
    'myAgent.readTools': 'Read',
    'myAgent.actionTools': 'Actions',
    'myAgent.name': 'Agent name',
    'myAgent.none': 'No agent yet',
    'myAgent.noneHint': 'Create one to run Claude Code, Codex or another client on your tasks under a name of its own, instead of as you.',
    'myAgent.namePh': 'e.g. Jarvis',
    'myAgent.create': 'Create agent',
    'myAgent.on': 'Switched on',
    'myAgent.offTitle': 'Switch your agent off?',
    'myAgent.offBody': 'Every client connected as it is disconnected for good: switching it back on needs each one connected again.',
    'myAgent.off': 'Switch off',
  },
  uk: {
    'myAgent.title': 'Ваш агент',
    'myAgent.summary': 'Працює над вашими задачами під власним іменем і питає вас, коли не впевнений, а не пише від вашого імені.',
    'myAgent.summaryOff': 'Вимкнений: жоден клієнт не може працювати як він, доки ви його не ввімкнете.',
    'myAgent.details': 'Що він уміє',
    'myAgent.desc': 'Він може лише те, що й ви, із задачами та базою знань – ніколи фінанси, людей, налаштування чи секрети – і не більше, ніж учасник. Клієнт, підключений як ви, натомість працює з усім, що дозволяє ваша роль.',
    'myAgent.toolsHint': 'Інструменти, які ordi надає підключеному клієнту; кожен із них перевіряє, що дозволено тому, як він працює.',
    'myAgent.readTools': 'Читання',
    'myAgent.actionTools': 'Дії',
    'myAgent.name': 'Ім’я агента',
    'myAgent.none': 'Агента ще немає',
    'myAgent.noneHint': 'Створіть його, щоб запускати Claude Code, Codex чи інший клієнт на своїх задачах під окремим іменем, а не від вашого.',
    'myAgent.namePh': 'напр. Jarvis',
    'myAgent.create': 'Створити агента',
    'myAgent.on': 'Увімкнено',
    'myAgent.offTitle': 'Вимкнути вашого агента?',
    'myAgent.offBody': 'Усі клієнти, підключені як він, буде відключено назавжди: після ввімкнення кожен доведеться підключити знову.',
    'myAgent.off': 'Вимкнути',
  },
});

export interface MyAgent { id: string; name: string; avatar: string | null; isActive: boolean; tokens: AgentToken[] }

const KEY = ['my-agent'];

/** The person's own agent, or null when they have none yet. */
export function useMyAgent() {
  return useQuery({ queryKey: KEY, queryFn: () => api.get<{ agent: MyAgent | null }>('/my-agent').then((r) => r.agent) });
}

/** The catalog the MCP server serves, split by whether a tool changes anything. */
const READ_TOOLS = mcpToolsOfKind('read');
const ACTION_TOOLS = mcpToolsOfKind('write', 'destructive');

export function MyAgentSection() {
  const t = useT();
  const qc = useQueryClient();
  const q = useMyAgent();
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
    <section className="mb-10" aria-labelledby="my-agent">
      <SubHead title={<span id="my-agent">{t('myAgent.title')}</span>} />
      <RowList className="px-3 py-3">
        {view === 'loading' ? (
          <Skeleton className="h-10 w-full" />
        ) : view === 'error' ? (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            {t('common.loadFailed')}
            <Button size="xs" variant="ghost" onClick={() => q.refetch()}>{t('common.retry')}</Button>
          </div>
        ) : view === 'none' || !q.data ? (
          <div className="flex items-start gap-3">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><Bot size={15} aria-hidden /></div>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">{t('myAgent.none')}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('myAgent.noneHint')}</p>
              <form className="mt-2.5 flex flex-wrap gap-2" onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) create.mutate(); }}>
                <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={t('myAgent.namePh')} aria-label={t('myAgent.name')} className="h-8 max-w-xs" />
                <Button type="submit" size="sm" variant="outline" className="h-8" disabled={!name.trim() || create.isPending}>
                  {create.isPending && <Spinner />} {t('myAgent.create')}
                </Button>
              </form>
            </div>
          </div>
        ) : (
          <AgentDetails agent={q.data} onChanged={refresh} onError={apiError} />
        )}
        <Disclosure label={t('myAgent.details')} className="mt-2">
          <div className="space-y-3 pb-1 pl-5 pt-2">
            <p className="text-xs text-muted-foreground">{t('myAgent.desc')}</p>
            <p className="text-xs text-muted-foreground">{t('myAgent.toolsHint')}</p>
            <ToolGroup icon={<BookOpen size={13} aria-hidden />} label={t('myAgent.readTools')} tools={READ_TOOLS} />
            <ToolGroup icon={<Zap size={13} aria-hidden />} label={t('myAgent.actionTools')} tools={ACTION_TOOLS} />
          </div>
        </Disclosure>
      </RowList>
    </section>
  );
}

function AgentDetails({ agent, onChanged, onError }: { agent: MyAgent; onChanged: () => void; onError: (e: unknown) => void }) {
  const t = useT();
  const [name, setName] = useState(agent.name);
  const [confirmOff, setConfirmOff] = useState(false);
  // Renamed elsewhere (another tab) or put back after a failed rename.
  useEffect(() => { setName(agent.name); }, [agent.name]);

  const rename = useMutation({
    mutationFn: (n: string) => api.patch('/my-agent', { name: n }),
    onSuccess: onChanged,
    onError: (e) => { setName(agent.name); onError(e); },
  });
  const toggle = useMutation({
    mutationFn: (on: boolean) => api.post(`/my-agent/${on ? 'enable' : 'disable'}`),
    onSuccess: () => { setConfirmOff(false); onChanged(); },
    onError: (e) => { setConfirmOff(false); onError(e); },
  });

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3">
        <Avatar name={agent.name} src={agent.avatar} size={32} agent className={agent.isActive ? undefined : 'opacity-50'} />
        <Input
          value={name}
          maxLength={60}
          aria-label={t('myAgent.name')}
          className="h-8 max-w-xs flex-1"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const next = name.trim();
            if (!next) setName(agent.name);
            else if (next !== agent.name) rename.mutate(next);
          }}
        />
        {/* The words are part of the control: the switch alone is a small target. */}
        <label className="ml-auto flex min-h-7 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          {t('myAgent.on')}
          <Switch checked={agent.isActive} disabled={toggle.isPending} onChange={(v) => (v ? toggle.mutate(true) : setConfirmOff(true))} />
        </label>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{agent.isActive ? t('myAgent.summary') : t('myAgent.summaryOff')}</p>

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
    </div>
  );
}

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
