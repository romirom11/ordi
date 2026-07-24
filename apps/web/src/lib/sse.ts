/**
 * SSE realtime (PRD §3.4): subscribes to /api/v1/stream and invalidates
 * TanStack Query caches per event type. Reconnects with backoff.
 */
import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

/** Map event families to the query keys they invalidate. */
function invalidateFor(qc: QueryClient, type: string, data: any): void {
  const inv = (key: unknown[]) => qc.invalidateQueries({ queryKey: key });
  if (type.startsWith('task.') || type.startsWith('cycle.') || type.startsWith('git.')) {
    inv(['tasks']);
    if (data?.projectId) inv(['tasks', data.projectId]);
    inv(['me-tasks']);
    inv(['cycles']);
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

export function useRealtime(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let es: EventSource | null = null;
    let stopped = false;
    let retryMs = 2000;

    const connect = () => {
      if (stopped) return;
      es = new EventSource('/api/v1/stream', { withCredentials: true });
      es.onopen = () => { retryMs = 2000; };
      es.onerror = () => {
        es?.close();
        if (!stopped) {
          setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 2, 30_000);
        }
      };
      // Listen to every catalog event type generically via onmessage won't fire
      // for named events, so attach a shared handler per known family prefix.
      const types = [
        'deal.stage_changed', 'deal.won', 'deal.lost', 'project.created', 'project.completed',
        'task.created', 'task.status_changed', 'task.assigned', 'comment.mentioned',
        'cycle.completed', 'page.published', 'page.mentioned', 'time.entry_created',
        'quote.accepted', 'quote.declined', 'invoice.created', 'invoice.sent', 'invoice.viewed',
        'invoice.overdue', 'invoice.paid', 'payment.recorded',
        'git.branch_created', 'git.pr_opened', 'git.pr_merged', 'git.pr_closed',
        'employee.onboarded', 'employee.exited', 'leave.requested', 'leave.decided',
        'applicant.hired', 'role.updated',
      ];
      for (const t of types) {
        es.addEventListener(t, (ev) => {
          let data: any = {};
          try { data = JSON.parse((ev as MessageEvent).data); } catch { /* ignore */ }
          invalidateFor(qc, t, data);
        });
      }
    };

    connect();
    return () => { stopped = true; es?.close(); };
  }, [qc]);
}
