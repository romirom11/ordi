/**
 * SSE realtime (PRD §3.4): subscribes to /api/v1/stream and invalidates
 * TanStack Query caches per event type. Reconnects with backoff.
 *
 * Deliberately NOT EventSource. EventSource cannot send an Authorization
 * header and only takes a URL relative to the window origin – on the desktop
 * that origin is tauri://localhost and the credential is a bearer token, so
 * realtime simply never connected there. A fetch-based reader handles both
 * worlds with the same code path the rest of the API client uses.
 */
import { useEffect, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getInstanceUrl, getSessionToken } from './api';
import { isTauri, notifyDesktop } from './desktop';
import { useT } from './i18n';
import { notifText } from './notifications';
import { toast } from '../components/overlays';

/** Read one text/event-stream response, emitting (event, data) pairs. */
async function readSseStream(
  url: string,
  headers: Record<string, string>,
  onEvent: (event: string, data: string) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream', ...headers },
    credentials: 'include',
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        // ':' comments and 'id:'/'retry:' fields are irrelevant here.
      }
      if (event !== 'message' || data.length) onEvent(event, data.join('\n'));
    }
  }
}

/** One row of the run log, exactly as ['agent-run-events', runId] stores it (see RunLog). */
interface CachedRunEvent {
  id: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

/**
 * Append one streamed event to the open log instead of invalidating it: a run
 * emits hundreds of frames and each invalidation refetched the whole log.
 * A cache that is not loaded (or still empty) is left alone – the log's own
 * fetch fills it. The frame carries no row id, so the sequence stands in for
 * one; a refetch later replaces it with the stored row.
 */
function appendRunEvent(qc: QueryClient, data: any): void {
  const key = ['agent-run-events', data.runId];
  const current = qc.getQueryData<CachedRunEvent[]>(key);
  if (!current || current.length === 0) return;
  const seq = Number(data.seq);
  if (!Number.isFinite(seq) || current.some((e) => e.seq === seq)) return;
  const event: CachedRunEvent = {
    id: `sse-${data.runId}-${seq}`,
    seq,
    type: String(data.eventType ?? 'log'),
    payload: (data.payload ?? {}) as Record<string, unknown>,
    createdAt: String(data.createdAt ?? new Date().toISOString()),
  };
  qc.setQueryData(key, [...current, event].sort((a, b) => a.seq - b.seq));
}

/** Map event families to the query keys they invalidate. */
function invalidateFor(qc: QueryClient, type: string, data: any): void {
  const inv = (key: unknown[]) => qc.invalidateQueries({ queryKey: key });
  if (type.startsWith('task.') || type.startsWith('cycle.') || type.startsWith('git.')) {
    inv(['tasks']);
    if (data?.projectId) inv(['tasks', data.projectId]);
    inv(['me-tasks']);
    inv(['cycles']);
  } else if (type.startsWith('comment.')) {
    // comments ride along with the task detail query
    if (data?.taskId) inv(['task', data.taskId]);
    inv(['task-audit']);
  } else if (type.startsWith('project.')) {
    inv(['projects']);
    inv(['project']); // prefix-matches every ['project', id] detail
  } else if (type.startsWith('deal.')) {
    inv(['deals']);
  } else if (type.startsWith('invoice.') || type.startsWith('payment.') || type.startsWith('quote.')) {
    inv(['invoices']);
    inv(['quotes']);
    inv(['finance']);
  } else if (type.startsWith('page.')) {
    inv(['pages']);
    inv(['spaces']);
  } else if (type.startsWith('leave.') || type.startsWith('employee.') || type.startsWith('applicant.')) {
    inv(['employees']);
    inv(['leave-requests']);
    inv(['people']);
  } else if (type.startsWith('time.')) {
    inv(['time']);
    inv(['timer']);
  } else if (type === 'agent.run_event') {
    // One frame per streamed SDK message: appended to the open log rather than
    // refetching it. The run row itself changes with the frames that carry the
    // status, the result or an error (badge, summary, PR), so those – and only
    // those – refresh the list.
    if (data?.runId) appendRunEvent(qc, data);
    if (data?.eventType === 'status' || data?.eventType === 'result' || data?.eventType === 'error') {
      inv(['agent-runs']); // prefix-matches ['agent-runs', taskId]
    }
    return; // a log line is never a notification – skip the refetch below
  } else if (type.startsWith('agent.')) {
    // Run lifecycle – the runs list on the task, and the task itself, because
    // the agent comments and moves the status as it works.
    inv(['agent-runs']); // prefix-matches ['agent-runs', taskId]
    if (data?.taskId) inv(['task', data.taskId]);
    inv(['tasks']);
    inv(['me-tasks']);
  } else if (type === 'role.updated') {
    inv(['me']);
  }
}

/** Soft two-tone chirp for events addressed to the current user. */
function chirp(): void {
  try {
    type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext; __ordiAudio?: AudioContext };
    const w = window as AudioWindow;
    const Ctx = window.AudioContext ?? w.webkitAudioContext;
    if (!Ctx) return;
    const ctx = (w.__ordiAudio ??= new Ctx());
    if (ctx.state === 'suspended') void ctx.resume();
    const now = ctx.currentTime;
    for (const [freq, at] of [[880, 0], [1174.66, 0.09]] as const) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.06, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.22);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.25);
    }
  } catch { /* audio blocked until first interaction – fine */ }
}

/**
 * A notification the server wrote for me: an in-app toast and a chirp on the
 * web, an OS notification on the desktop (PRD §18).
 *
 * The frame is user-scoped, so this fires for the addressed person and nobody
 * else. It used to be guessed from the business event, and because a task
 * event streams to every member of the project, "a task was assigned to you"
 * went to the whole team for a task assigned to one of them.
 */
function personalPing(data: any, t: (key: string, fallback?: string) => string): void {
  if (!data?.type) return;
  const text = notifText({ type: String(data.type), entityRef: data.entityRef ?? null, payload: data.payload }, t);
  if (isTauri) {
    notifyDesktop('ordi', text);
    return;
  }
  toast.info(text);
  chirp();
}

export function useRealtime(): void {
  const qc = useQueryClient();
  // Read through a ref: the stream must not reconnect when the language does.
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let retryMs = 2000;

    const handled = new Set([
        'notification.created',
        'deal.stage_changed', 'deal.won', 'deal.lost', 'project.created', 'project.completed',
        'task.created', 'task.status_changed', 'task.assigned',
        'comment.created', 'comment.mentioned',
        'cycle.completed', 'page.published', 'page.mentioned', 'time.entry_created',
        'quote.accepted', 'quote.declined', 'invoice.created', 'invoice.sent', 'invoice.viewed',
        'invoice.overdue', 'invoice.paid', 'payment.recorded',
        'git.branch_created', 'git.pr_opened', 'git.pr_merged', 'git.pr_closed',
        'employee.onboarded', 'employee.exited', 'leave.requested', 'leave.decided',
        'applicant.hired', 'role.updated',
        'agent.run_queued', 'agent.run_started', 'agent.run_finished', 'agent.needs_input',
        'agent.run_event',
    ]);

    const onEvent = (type: string, raw: string) => {
      retryMs = 2000; // any frame proves the connection is healthy
      if (!handled.has(type)) return;
      let data: any = {};
      try { data = JSON.parse(raw); } catch { /* ignore */ }
      if (type === 'notification.created') {
        qc.invalidateQueries({ queryKey: ['notifications'] });
        personalPing(data, tRef.current);
        return;
      }
      invalidateFor(qc, type, data);
    };

    const connect = async (): Promise<void> => {
      while (!stopped) {
        try {
          const token = getSessionToken();
          await readSseStream(
            `${getInstanceUrl()}/api/v1/stream`,
            token ? { Authorization: `Bearer ${token}` } : {},
            onEvent,
            controller.signal,
          );
        } catch { /* dropped or refused – retry below */ }
        if (stopped) return;
        await new Promise((r) => setTimeout(r, retryMs));
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    };

    void connect();
    return () => { stopped = true; controller.abort(); };
  }, [qc]);
}
