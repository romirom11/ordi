/**
 * Profile → Connections → Your agent, the first thing on the page: one agent
 * of your own for Claude Code, Codex and the like. It works your tasks under
 * its own name – it asks you instead of writing as you – and can do only what
 * you can, as a member at most: tasks and the knowledge base, never finance,
 * people, settings or secrets. Its clients are connected below and listed
 * under Connected clients, so this card is only the agent itself: its name,
 * its switch, one line on what it does, and what it can do behind a disclosure.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Bot, Pencil, Zap } from 'lucide-react';
import { mcpToolsOfKind } from '@ordi/shared';
import { api, ApiError } from '../../lib/api';
import { Avatar, Button, IconButton, Input, Skeleton, Spinner, Switch, cn } from '../ui';
import { ConfirmDialog, toast } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';
import { myAgentView, renameOutcome } from './myAgentView';
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
    'myAgent.rename': 'Rename agent',
    'myAgent.renamed': 'Agent renamed.',
    'myAgent.none': 'No agent yet',
    'myAgent.noneHint': 'Create one to run Claude Code, Codex or another client on your tasks under a name of its own, instead of as you.',
    'myAgent.namePh': 'e.g. Jarvis',
    'myAgent.create': 'Create agent',
    'myAgent.on': 'Switched on',
    'myAgent.offState': 'Switched off',
    'myAgent.switch': 'Agent switched on',
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
    'myAgent.rename': 'Перейменувати агента',
    'myAgent.renamed': 'Агента перейменовано.',
    'myAgent.none': 'Агента ще немає',
    'myAgent.noneHint': 'Створіть його, щоб запускати Claude Code, Codex чи інший клієнт на своїх задачах під окремим іменем, а не від вашого.',
    'myAgent.namePh': 'напр. Jarvis',
    'myAgent.create': 'Створити агента',
    'myAgent.on': 'Увімкнено',
    'myAgent.offState': 'Вимкнено',
    'myAgent.switch': 'Агент увімкнений',
    'myAgent.offTitle': 'Вимкнути вашого агента?',
    'myAgent.offBody': 'Усі клієнти, підключені як він, буде відключено назавжди: після ввімкнення кожен доведеться підключити знову.',
    'myAgent.off': 'Вимкнути',
  },
});

export interface MyAgent { id: string; name: string; avatar: string | null; isActive: boolean; tokens: AgentToken[] }

const KEY = ['my-agent'];

/** The person's own agent, or null when they have none yet. */
export function useMyAgent() {
  // Back from signing a client in as the agent through another tab: it shows up.
  return useQuery({ queryKey: KEY, queryFn: () => api.get<{ agent: MyAgent | null }>('/my-agent').then((r) => r.agent), refetchOnWindowFocus: true });
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
      <RowList className="px-4 py-3.5">
        {view === 'loading' ? (
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-full max-w-sm" />
            </div>
          </div>
        ) : view === 'error' ? (
          <div className="flex min-h-9 items-center gap-2 text-[13px] text-muted-foreground">
            {t('common.loadFailed')}
            <Button size="xs" variant="ghost" onClick={() => q.refetch()}>{t('common.retry')}</Button>
          </div>
        ) : view === 'none' || !q.data ? (
          <div className="flex items-start gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground"><Bot size={16} aria-hidden /></div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-5">{t('myAgent.none')}</p>
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
        {/* Lined up under the text, past the avatar. */}
        <Disclosure label={t('myAgent.details')} className="mt-1.5 pl-12">
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
  const [editing, setEditing] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const pencil = useRef<HTMLButtonElement>(null);
  // Focus goes back to the pencil once editing closes – only then, not on the
  // first render, so opening the page does not jump to it.
  const refocus = useRef(false);
  useEffect(() => {
    if (!editing && refocus.current) { refocus.current = false; pencil.current?.focus(); }
  }, [editing]);
  const close = () => { refocus.current = true; setEditing(false); };

  const toggle = useMutation({
    mutationFn: (on: boolean) => api.post(`/my-agent/${on ? 'enable' : 'disable'}`),
    onSuccess: () => { setConfirmOff(false); onChanged(); },
    onError: (e) => { setConfirmOff(false); onError(e); },
  });

  return (
    <div>
      <div className="flex items-start gap-3">
        <Avatar name={agent.name} src={agent.avatar} size={36} agent className={agent.isActive ? undefined : 'opacity-50'} />
        <div className="min-w-0 flex-1">
          <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
            {editing ? (
              <RenameForm agent={agent} onDone={(saved) => { close(); if (saved) onChanged(); }} onError={onError} />
            ) : (
              <div className="flex min-w-0 items-center gap-0.5">
                <span className="truncate text-sm font-semibold">{agent.name}</span>
                <IconButton ref={pencil} aria-label={t('myAgent.rename')} title={t('myAgent.rename')} onClick={() => setEditing(true)}>
                  <Pencil size={13} aria-hidden />
                </IconButton>
              </div>
            )}
            {/* The words are part of the control: the switch alone is a small target. */}
            <label className="ml-auto flex min-h-7 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <span aria-hidden>{agent.isActive ? t('myAgent.on') : t('myAgent.offState')}</span>
              <Switch checked={agent.isActive} disabled={toggle.isPending} onChange={(v) => (v ? toggle.mutate(true) : setConfirmOff(true))} label={t('myAgent.switch')} />
            </label>
          </div>
          <p className={cn('text-xs text-muted-foreground', editing && 'mt-1.5')}>{agent.isActive ? t('myAgent.summary') : t('myAgent.summaryOff')}</p>
        </div>
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
    </div>
  );
}

/**
 * The name, being edited in place: Enter or Save keeps it, Escape or Cancel
 * puts it back. Nothing is saved by just leaving the field, so tabbing on to
 * Save or Cancel never decides for you.
 */
function RenameForm({ agent, onDone, onError }: { agent: MyAgent; onDone: (saved: boolean) => void; onError: (e: unknown) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [draft, setDraft] = useState(agent.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.select(); }, []);

  const rename = useMutation({
    mutationFn: (n: string) => api.patch('/my-agent', { name: n }),
    onSuccess: (_r, n) => {
      // The new name shows the moment editing closes, not after the refetch.
      qc.setQueryData<MyAgent | null>(KEY, (a) => (a ? { ...a, name: n } : a));
      toast(t('myAgent.renamed'));
      onDone(true);
    },
    // The draft stays, so a failed save can be retried or cancelled.
    onError: (e) => { onError(e); input.current?.focus(); },
  });
  const outcome = renameOutcome(draft, agent.name);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (rename.isPending) return;
    if (outcome.kind === 'save') rename.mutate(outcome.name);
    else if (outcome.kind === 'close') onDone(false);
    else input.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || rename.isPending) return;
    // Escape belongs to this field here, not to whatever else listens for it.
    e.preventDefault();
    e.stopPropagation();
    onDone(false);
  };

  return (
    <form className="flex min-w-0 flex-1 flex-wrap items-center gap-2" onSubmit={submit} onKeyDown={onKeyDown}>
      <Input
        ref={input}
        autoFocus
        value={draft}
        maxLength={60}
        aria-label={t('myAgent.name')}
        disabled={rename.isPending}
        className="h-8 w-auto min-w-0 max-w-xs flex-1 basis-40"
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="flex items-center gap-1">
        <Button type="submit" size="sm" className="h-8" disabled={outcome.kind === 'invalid' || rename.isPending}>
          {rename.isPending && <Spinner />} {t('common.save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" className="h-8" disabled={rename.isPending} onClick={() => onDone(false)}>{t('common.cancel')}</Button>
      </div>
    </form>
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
