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
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { getInstanceUrl, getSessionToken } from './api';
import { isTauri, notifyDesktop } from './desktop';
import { useMe } from './auth';
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

/** Events worth an OS notification on desktop (PRD §18). */
const OS_NOTIFY: Record<string, string> = {
  'task.assigned': 'Task assigned to you',
  'comment.mentioned': 'You were mentioned',
  'quote.accepted': 'Quote accepted',
  'invoice.paid': 'Invoice paid',
  'leave.requested': 'Leave request pending',
  'leave.decided': 'Leave request decided',
  'git.pr_merged': 'PR merged in your task',
};

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
  } else if (type === 'role.updated') {
    inv(['me']);
  }
  // notifications are produced by most events
  inv(['notifications']);
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

/** Events addressed directly to me → in-app toast + chirp (web equivalent of the desktop notification). */
function personalPing(type: string, data: any, meId: string, locale: string): void {
  const targets: string[] = type === 'task.assigned' ? (data?.assigneeIds ?? [])
    : type === 'comment.mentioned' || type === 'page.mentioned' ? (data?.mentions ?? [])
    : [];
  if (!targets.includes(meId)) return;
  if (data?.actorId === meId || data?.createdBy === meId) return; // not my own action
  const uk = locale === 'uk';
  const label = type === 'task.assigned'
    ? (uk ? 'Вам призначено задачу' : 'Task assigned to you')
    : (uk ? 'Вас згадали' : 'You were mentioned');
  toast.info(data?.ref ? `${label}: ${data.ref}` : label);
  chirp();
}

export function useRealtime(): void {
  const qc = useQueryClient();
  const me = useMe();
  const meId = me.user.id;
  const meLocale = me.user.locale;
  useEffect(() => {
    const controller = new AbortController();
    let stopped = false;
    let retryMs = 2000;

    const handled = new Set([
        'deal.stage_changed', 'deal.won', 'deal.lost', 'project.created', 'project.completed',
        'task.created', 'task.status_changed', 'task.assigned', 'comment.mentioned',
        'cycle.completed', 'page.published', 'page.mentioned', 'time.entry_created',
        'quote.accepted', 'quote.declined', 'invoice.created', 'invoice.sent', 'invoice.viewed',
        'invoice.overdue', 'invoice.paid', 'payment.recorded',
        'git.branch_created', 'git.pr_opened', 'git.pr_merged', 'git.pr_closed',
        'employee.onboarded', 'employee.exited', 'leave.requested', 'leave.decided',
        'applicant.hired', 'role.updated',
    ]);

    const onEvent = (type: string, raw: string) => {
      retryMs = 2000; // any frame proves the connection is healthy
      if (!handled.has(type)) return;
      let data: any = {};
      try { data = JSON.parse(raw); } catch { /* ignore */ }
      invalidateFor(qc, type, data);
      if (!isTauri) personalPing(type, data, meId, meLocale);
      if (isTauri && OS_NOTIFY[type]) {
        notifyDesktop('ordi', data?.ref ? `${OS_NOTIFY[type]}: ${data.ref}` : OS_NOTIFY[type]!);
      }
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
  }, [qc, meId, meLocale]);
}
