/**
 * The Inbox's data (GET /inbox, GET /inbox/count) and where each row leads.
 * Kept apart from the page so the links – the part that must not drift from
 * the bell's – are tested on their own.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { notifLink } from './notifications';

export interface InboxTaskRef { id: string; projectId: string; ref: string; title: string }

export interface InboxQuestion {
  id: string;
  question: string;
  askedAt: string;
  askedBy: { id: string; name: string; actorType: string };
  task: InboxTaskRef;
}

export interface InboxStoppedRun {
  id: string;
  status: 'failed' | 'waiting_quota';
  error: string | null;
  at: string;
  retryAt: string | null;
  agent: { id: string; name: string };
  task: InboxTaskRef;
}

export interface InboxMention {
  id: string;
  type: string;
  at: string;
  readAt: string | null;
  ref: string | null;
  title: string | null;
  actorName: string | null;
  payload: { taskId: string | null; projectId: string | null; pageId: string | null; spaceId: string | null };
}

export interface InboxApproval {
  kind: 'leave';
  id: string;
  at: string;
  employeeName: string;
  leaveTypeName: string | null;
  fromDate: string;
  toDate: string;
  halfDay: boolean;
}

export interface InboxData {
  waitingOnYou: InboxQuestion[];
  agentStopped: InboxStoppedRun[];
  mentions: InboxMention[];
  approvals: InboxApproval[];
}

export interface InboxCount { waitingOnYou: number; approvals: number; total: number }

export const taskLink = (task: InboxTaskRef): string => `/projects/${task.projectId}/tasks/${task.id}`;

/** A mention opens where its bell row does: the task, or the KB page. */
export function mentionLink(m: InboxMention): string {
  const payload = Object.fromEntries(Object.entries(m.payload).filter(([, v]) => v != null));
  return notifLink({ type: m.type, entityRef: m.ref, payload }) ?? '/';
}

/** Leave decisions are made on the People page, as the leave notification has it. */
export const approvalLink = (_a: InboxApproval): string => '/people';

export function useInbox() {
  return useQuery({
    queryKey: ['inbox', 'items'],
    queryFn: () => api.get<InboxData>('/inbox'),
  });
}

/** The nav badge. Refreshed by the live stream (lib/sse.ts) and once a minute. */
export function useInboxCount(enabled = true) {
  return useQuery({
    queryKey: ['inbox', 'count'],
    queryFn: () => api.get<InboxCount>('/inbox/count'),
    enabled,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
}
