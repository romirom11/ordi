/**
 * Agent runs on a task (plan 2026-09-05-001, R31, R33, R50).
 *
 * Visibility follows the task: anyone who can open it sees the runs and the
 * live log. Cancel and retry need task write or `agents.manage`, exactly as
 * the API enforces. Events arrive over SSE (see lib/sse.ts, which appends each
 * frame to ['agent-run-events', runId] and refreshes ['agent-runs'] on the
 * frames that change the row); while any run is active both the list and the
 * open log poll every 5s, which is the fallback for a dropped stream.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AGENT_RUN_ACTIVE_STATUSES } from '@ordi/shared';
import {
  Bot, ChevronRight, CircleStop, ExternalLink, GitBranch, GitPullRequest, RotateCcw, Wrench,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { Badge, Button, Spinner, cn, fmtMoney, fmtRelative } from '../ui';
import { toast } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'runs.title': 'Agent runs',
    'runs.none': 'No runs yet – assign the task to an agent to start one.',
    'runs.status.queued': 'Queued',
    'runs.status.claimed': 'Claimed',
    'runs.status.running': 'Running',
    'runs.status.waiting_quota': 'Waiting for quota',
    'runs.status.needs_input': 'Needs input',
    'runs.status.succeeded': 'Succeeded',
    'runs.status.failed': 'Failed',
    'runs.status.cancelled': 'Cancelled',
    'runs.trigger.assigned': 'assignment',
    'runs.trigger.comment': 'comment',
    'runs.trigger.retry': 'retry',
    'runs.trigger.manual': 'manual start',
    'runs.startedBy': 'Started by {trigger}',
    'runs.queuedAt': 'Queued {when}',
    'runs.startedAt': 'Started {when}',
    'runs.finishedAt': 'Finished {when}',
    'runs.duration': 'Duration {value}',
    'runs.turns': '{n} turns',
    'runs.cancel': 'Cancel',
    'runs.cancelled': 'Cancel requested',
    'runs.retry': 'Retry',
    'runs.retryBlocked': 'This task already has a run going – wait for it to finish or cancel it.',
    'runs.retried': 'A new run is queued',
    'runs.actionFailed': 'Could not do that',
    'runs.noEvents': 'Nothing logged yet.',
    'runs.logFailed': 'Could not load the log.',
    'runs.toolUse': 'Tool',
    'runs.toolResult': 'Result',
    'runs.connectorCall': 'Connector',
    'runs.rateLimit': 'Rate limit until {when}',
    'runs.model': 'Model {model}',
    'runs.pr': 'Pull request',
  },
  uk: {
    'runs.title': 'Запуски агента',
    'runs.none': 'Запусків ще не було – призначте задачу агентові, щоб почати.',
    'runs.status.queued': 'У черзі',
    'runs.status.claimed': 'Взято в роботу',
    'runs.status.running': 'Виконується',
    'runs.status.waiting_quota': 'Чекає на квоту',
    'runs.status.needs_input': 'Потрібна відповідь',
    'runs.status.succeeded': 'Успішно',
    'runs.status.failed': 'Помилка',
    'runs.status.cancelled': 'Скасовано',
    'runs.trigger.assigned': 'призначенням',
    'runs.trigger.comment': 'коментарем',
    'runs.trigger.retry': 'повтором',
    'runs.trigger.manual': 'вручну',
    'runs.startedBy': 'Запущено {trigger}',
    'runs.queuedAt': 'У черзі {when}',
    'runs.startedAt': 'Початок {when}',
    'runs.finishedAt': 'Завершено {when}',
    'runs.duration': 'Тривалість {value}',
    'runs.turns': 'кроків: {n}',
    'runs.cancel': 'Скасувати',
    'runs.cancelled': 'Скасування надіслано',
    'runs.retry': 'Повторити',
    'runs.retryBlocked': 'Для цієї задачі вже є активний запуск – дочекайтеся його завершення або скасуйте його.',
    'runs.retried': 'Новий запуск у черзі',
    'runs.actionFailed': 'Не вдалося виконати дію',
    'runs.noEvents': 'Поки що порожньо.',
    'runs.logFailed': 'Не вдалося завантажити журнал.',
    'runs.toolUse': 'Інструмент',
    'runs.toolResult': 'Результат',
    'runs.connectorCall': 'Конектор',
    'runs.rateLimit': 'Ліміт до {when}',
    'runs.model': 'Модель {model}',
    'runs.pr': 'Пулреквест',
  },
});

export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  turns?: number;
  durationMs?: number;
  credentialId?: string;
}

export interface AgentRun {
  id: string;
  agentUserId: string;
  agentName: string;
  taskId: string;
  projectId: string;
  trigger: string;
  status: string;
  runtime: string;
  sessionId: string | null;
  parentRunId: string | null;
  requestedBy: string | null;
  commentId: string | null;
  attempts: number;
  nextAttemptAt: string | null;
  branch: string | null;
  prUrl: string | null;
  summary: string | null;
  error: string | null;
  usage: RunUsage;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

interface RunEvent {
  id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

const ACTIVE: readonly string[] = AGENT_RUN_ACTIVE_STATUSES;

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), template);
}

function statusClass(status: string): string {
  if (status === 'succeeded') return 'bg-success/10 text-success';
  if (status === 'failed') return 'bg-destructive/10 text-destructive';
  if (status === 'needs_input' || status === 'waiting_quota') return 'bg-warning/10 text-warning';
  if (status === 'cancelled') return 'bg-muted text-faint';
  return 'bg-primary/10 text-primary';
}

/** mm:ss for anything short, then hours – a run that lasted 3h reads badly in minutes. */
function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function runDuration(run: AgentRun): string | null {
  if (typeof run.usage.durationMs === 'number') return fmtDuration(run.usage.durationMs);
  if (!run.startedAt) return null;
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
  return fmtDuration(end - new Date(run.startedAt).getTime());
}

function str(value: unknown): string {
  if (value == null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** One stored SDK message, rendered as the line a human wants to read. */
function EventLine({ event }: { event: RunEvent }) {
  const t = useT();
  const p = event.payload ?? {};
  const time = <span className="shrink-0 font-mono text-[10px] text-faint">{new Date(event.createdAt).toLocaleTimeString()}</span>;

  const shell = (icon: ReactNode, body: ReactNode) => (
    <div className="flex items-start gap-2 py-0.5">
      {time}
      <span className="mt-0.5 shrink-0 text-faint">{icon}</span>
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  );

  switch (event.type) {
    case 'assistant':
      return shell(<Bot size={11} />, <p className="whitespace-pre-wrap text-[12px] text-foreground">{str(p.text)}</p>);
    case 'tool_use':
      return shell(<Wrench size={11} />, (
        <details>
          <summary className="cursor-pointer list-none text-[12px] text-muted-foreground">
            {t('runs.toolUse')}: <span className="font-mono">{str(p.name)}</span>
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-2 font-mono text-[10px] text-muted-foreground">{str(p.input)}</pre>
        </details>
      ));
    case 'tool_result':
      return shell(<Wrench size={11} />, (
        <details>
          <summary className={cn('cursor-pointer list-none text-[12px]', p.isError ? 'text-destructive' : 'text-muted-foreground')}>
            {t('runs.toolResult')}
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/60 p-2 font-mono text-[10px] text-muted-foreground">{str(p.text)}</pre>
        </details>
      ));
    case 'connector_call':
      return shell(<ExternalLink size={11} />, (
        <p className={cn('text-[12px]', p.ok === false ? 'text-destructive' : 'text-muted-foreground')}>
          {t('runs.connectorCall')}: <span className="font-mono">{str(p.connector)}.{str(p.tool)}</span>
          {typeof p.ms === 'number' ? ` · ${p.ms}ms` : ''}
          {p.error ? ` · ${str(p.error)}` : ''}
        </p>
      ));
    case 'init':
      return shell(<Bot size={11} />, (
        <p className="text-[12px] text-muted-foreground">
          {p.model ? fill(t('runs.model'), { model: str(p.model) }) : ''}
          {Array.isArray(p.mcpServers) && p.mcpServers.length > 0
            ? ` · ${(p.mcpServers as { name?: string }[]).map((s) => s.name).filter(Boolean).join(', ')}`
            : ''}
        </p>
      ));
    case 'rate_limit':
      return shell(<CircleStop size={11} />, (
        <p className="text-[12px] text-warning">{fill(t('runs.rateLimit'), { when: fmtRelative(str(p.resetsAt)) })}</p>
      ));
    case 'status':
      return shell(<ChevronRight size={11} />, (
        <p className="text-[12px] text-muted-foreground">
          {t(`runs.status.${str(p.status)}`, str(p.status))}
          {p.reason ? ` · ${str(p.reason)}` : ''}
        </p>
      ));
    case 'error':
      return shell(<CircleStop size={11} />, <p className="text-[12px] text-destructive">{str(p.message)}</p>);
    case 'result': {
      const report = p.report as { summary?: string; question?: string } | null | undefined;
      const text = report?.summary || report?.question || str(p.message) || str(p.error);
      return shell(<ChevronRight size={11} />, <p className="whitespace-pre-wrap text-[12px] text-foreground">{text}</p>);
    }
    default:
      return shell(<ChevronRight size={11} />, <p className="text-[12px] text-muted-foreground">{str(p.message) || event.type}</p>);
  }
}

function RunLog({ run }: { run: AgentRun }) {
  const t = useT();
  const active = ACTIVE.includes(run.status);
  const eventsQ = useQuery({
    queryKey: ['agent-run-events', run.id],
    queryFn: () => api.get<{ data: RunEvent[] }>(`/agent-runs/${run.id}/events`).then((r) => r.data),
    refetchInterval: active ? 5000 : false,
  });
  const events = eventsQ.data ?? [];
  const boxRef = useRef<HTMLDivElement>(null);

  // Follow the tail while the run writes – a log that stays at the top is a
  // log nobody reads.
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length]);

  if (eventsQ.isLoading) return <div className="px-3 py-2"><Spinner /></div>;
  if (eventsQ.isError) return <p className="px-3 py-2 text-xs text-destructive">{t('runs.logFailed')}</p>;
  if (events.length === 0) return <p className="px-3 py-2 text-xs text-muted-foreground">{t('runs.noEvents')}</p>;

  return (
    <div ref={boxRef} className="max-h-80 overflow-y-auto rounded-md border border-border bg-surface px-2.5 py-2">
      {events.map((e) => <EventLine key={e.id} event={e} />)}
    </div>
  );
}

function RunRow({ run, canAct, canRetry, hasActive }: {
  run: AgentRun;
  canAct: boolean;
  /** Only the newest run offers Retry – retrying an old one queues the same task twice. */
  canRetry: boolean;
  /** Some run of this task is still going, so the API would refuse a retry. */
  hasActive: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [open, setOpen] = useState(ACTIVE.includes(run.status));
  const active = ACTIVE.includes(run.status);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['agent-runs', run.taskId] });
    qc.invalidateQueries({ queryKey: ['agent-run-events', run.id] });
  };

  const cancel = useMutation({
    mutationFn: () => api.post(`/agent-runs/${run.id}/cancel`, {}),
    onSuccess: () => { invalidate(); toast(t('runs.cancelled')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('runs.actionFailed')),
  });
  const retry = useMutation({
    mutationFn: () => api.post(`/agent-runs/${run.id}/retry`, {}),
    onSuccess: () => { invalidate(); toast(t('runs.retried')); },
    onError: (e) => {
      // The API refuses a second active run with a domain rule; say it in the
      // reader's language instead of echoing the English sentence.
      if (e instanceof ApiError && e.code === 'domain_rule') { invalidate(); toast.error(t('runs.retryBlocked')); return; }
      toast.error(e instanceof ApiError ? e.message : t('runs.actionFailed'));
    },
  });

  const duration = runDuration(run);

  return (
    <div className="border-b border-border py-2 last:border-0">
      <div className="flex items-start gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="mt-0.5 shrink-0 text-faint transition-colors duration-150 hover:text-foreground"
        >
          <ChevronRight size={14} className={cn('transition-transform duration-[250ms] ease-smooth-out', open && 'rotate-90')} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={statusClass(run.status)}>{t(`runs.status.${run.status}`, run.status)}</Badge>
            <span className="truncate text-[13px] font-medium">{run.agentName}</span>
            {active && <Spinner className="h-3 w-3" />}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-faint">
            <span>{fill(t('runs.startedBy'), { trigger: t(`runs.trigger.${run.trigger}`, run.trigger) })}</span>
            <span>· {fill(t(run.finishedAt ? 'runs.finishedAt' : run.startedAt ? 'runs.startedAt' : 'runs.queuedAt'), {
              when: fmtRelative(run.finishedAt ?? run.startedAt ?? run.createdAt),
            })}</span>
            {duration && <span>· {fill(t('runs.duration'), { value: duration })}</span>}
            {/* Usage is zero-filled, so a run that failed before its first turn
                would read "0 turns · $0.00" – say nothing instead. */}
            {typeof run.usage.turns === 'number' && run.usage.turns > 0 && <span>· {fill(t('runs.turns'), { n: run.usage.turns })}</span>}
            {typeof run.usage.costUsd === 'number' && run.usage.costUsd > 0 && <span>· {fmtMoney(run.usage.costUsd, 'USD')}</span>}
          </div>
          {/* An active row can carry a note like "cancel requested"; that is not
              a failure, so it must not paint the row red. */}
          {(run.summary || (run.error && !active)) && (
            <p className={cn('mt-1 whitespace-pre-wrap text-[12px]', run.error && !active ? 'text-destructive' : 'text-muted-foreground')}>
              {(!active && run.error) || run.summary}
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-3">
            {run.branch && (
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <GitBranch size={11} /> <span className="font-mono">{run.branch}</span>
              </span>
            )}
            {run.prUrl && (
              <a
                href={run.prUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="flex items-center gap-1 text-[11px] text-primary hover:underline"
              >
                <GitPullRequest size={11} /> {t('runs.pr')} <ExternalLink size={10} />
              </a>
            )}
          </div>
        </div>
        {canAct && (active ? (
          <Button size="xs" variant="ghost" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
            {cancel.isPending ? <Spinner className="h-3 w-3" /> : <CircleStop size={13} />} {t('runs.cancel')}
          </Button>
        ) : canRetry && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => retry.mutate()}
            disabled={retry.isPending || hasActive}
            title={hasActive ? t('runs.retryBlocked') : undefined}
          >
            {retry.isPending ? <Spinner className="h-3 w-3" /> : <RotateCcw size={13} />} {t('runs.retry')}
          </Button>
        ))}
      </div>

      {open && <div className="mt-2 pl-6"><RunLog run={run} /></div>}
    </div>
  );
}

/**
 * The runs of one task, newest first. Rendered next to the git information on
 * the task page; hidden entirely for a task no agent has ever touched.
 */
export function AgentRunsBlock({ taskId, canWrite, showWhenEmpty }: {
  taskId: string;
  /** Task write on the project – cancel and retry also accept `agents.manage`. */
  canWrite: boolean;
  /** Keep the block visible with no runs yet (the task has an agent assignee). */
  showWhenEmpty?: boolean;
}) {
  const t = useT();
  const can = useCan();
  const runsQ = useQuery({
    queryKey: ['agent-runs', taskId],
    queryFn: () => api.get<{ data: AgentRun[] }>(`/agent-runs?taskId=${taskId}&limit=20`).then((r) => r.data),
    // Without this the row only ever moved on an SSE frame: poll while a run
    // is going, stop the moment none is.
    refetchInterval: (query) => ((query.state.data ?? []).some((r) => ACTIVE.includes(r.status)) ? 5000 : false),
  });
  const runs = useMemo(
    () => [...(runsQ.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [runsQ.data],
  );
  const hasActive = runs.some((r) => ACTIVE.includes(r.status));

  if (runs.length === 0 && !showWhenEmpty) return null;
  const canAct = canWrite || can('agents.manage');

  return (
    <>
      <section>
        <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">
          <Bot size={13} /> {t('runs.title')}
        </h2>
        {runs.length === 0 ? (
          <p className="text-[13px] text-faint">{t('runs.none')}</p>
        ) : (
          <div className="rounded-lg border border-border bg-card px-3">
            {runs.map((run, i) => (
              <RunRow key={run.id} run={run} canAct={canAct} canRetry={i === 0} hasActive={hasActive} />
            ))}
          </div>
        )}
      </section>
      {/* The block owns its separator: it renders only for tasks agents touch. */}
      <div className="my-6 h-px bg-border" />
    </>
  );
}
