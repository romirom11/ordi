/**
 * Typed event catalog (PRD §3.3). Every event carries type, aggregate_type,
 * aggregate_id, payload, occurred_at. Delivery is at-least-once; handlers are
 * idempotent (dedup via processed_events).
 */
import { z } from 'zod';

export const EVENT_TYPES = [
  'deal.stage_changed',
  'deal.won',
  'deal.lost',
  'project.created',
  'project.completed',
  'task.created',
  'task.status_changed',
  'task.assigned',
  'comment.mentioned',
  'cycle.completed',
  'page.published',
  'page.mentioned',
  'time.entry_created',
  'quote.accepted',
  'quote.declined',
  'invoice.created',
  'invoice.sent',
  'invoice.viewed',
  'invoice.overdue',
  'invoice.paid',
  'payment.recorded',
  'git.branch_created',
  'git.pr_opened',
  'git.pr_merged',
  'git.pr_closed',
  'employee.onboarded',
  'employee.exited',
  'leave.requested',
  'leave.decided',
  'applicant.hired',
  'role.updated',
  'sales.work_digest_due',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const AGGREGATE_TYPES = [
  'deal',
  'project',
  'task',
  'cycle',
  'page',
  'time_entry',
  'quote',
  'invoice',
  'payment',
  'employee',
  'leave_request',
  'applicant',
  'role',
  'comment',
  'user',
] as const;

export type AggregateType = (typeof AGGREGATE_TYPES)[number];

export interface DomainEvent<T = Record<string, unknown>> {
  id: string;
  type: EventType;
  aggregateType: AggregateType;
  aggregateId: string;
  payload: T;
  occurredAt: string;
  actorId?: string | null;
  actorType?: 'user' | 'agent' | 'system' | 'integration';
}

export const eventEnvelopeSchema = z.object({
  id: z.string(),
  type: z.enum(EVENT_TYPES),
  aggregateType: z.enum(AGGREGATE_TYPES),
  aggregateId: z.string(),
  payload: z.record(z.unknown()),
  occurredAt: z.string(),
  actorId: z.string().nullable().optional(),
  actorType: z.enum(['user', 'agent', 'system', 'integration']).optional(),
});
