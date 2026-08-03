/**
 * Shared CRM primitives: types, status meta and data hooks used by the Work
 * queue, the Leads table, the Pipeline kanban and the detail pages. The strings
 * live in ./i18n.
 */
import { useQuery } from '@tanstack/react-query';
import { WRITABLE_LEAD_STATUSES } from '@ordi/shared';
import { api, qs } from '../../lib/api';
import { useT } from '../../lib/i18n';
import './i18n';
import { cn } from '../ui';

/**
 * Enums the API validates against come from @ordi/shared, so a status added
 * there shows up in the dropdowns instead of being silently missing. CURRENCIES
 * is the only local list: it is a picker shortcut, not a contract – the API
 * accepts any ISO 4217 code.
 */
export {
  COMPANY_STATUSES,
  LEAD_STATUSES,
  WRITABLE_LEAD_STATUSES,
  LEAD_ACTIVITY_OUTCOME_STATUSES,
  SALES_ACTIVITY_TYPES,
} from '@ordi/shared';

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'UAH', 'PLN'];

/**
 * Statuses offered when creating a lead. `nurture` needs a return date the
 * create form has no field for (the API rejects it without one), and the two
 * terminal outcomes are recorded by completing an activity, not at creation.
 */
export const NEW_LEAD_STATUSES = WRITABLE_LEAD_STATUSES
  .filter((status) => !['nurture', 'disqualified', 'no_response'].includes(status));

export function salesActivityTypeLabel(t: (key: string, fallback?: string) => string, value: string): string {
  return t(`crm.activityType.${value}`, value.replaceAll('_', ' '));
}

export function salesActivityStatusLabel(t: (key: string, fallback?: string) => string, value: string): string {
  return t(`crm.activityStatus.${value}`, value.replaceAll('_', ' '));
}

/**
 * Pill tones. Written as literal class pairs because Tailwind scans source for
 * whole class names – a `text-${tone}` template would never be generated.
 */
const TONES = {
  action: { text: 'text-primary', dot: 'bg-primary' },
  attention: { text: 'text-warning', dot: 'bg-warning' },
  live: { text: 'text-success', dot: 'bg-success' },
  lost: { text: 'text-destructive', dot: 'bg-destructive' },
  waiting: { text: 'text-muted-foreground', dot: 'bg-muted-foreground' },
  quiet: { text: 'text-faint', dot: 'bg-faint' },
} as const;

/**
 * Company and lead statuses share one map: the two vocabularies do not overlap
 * and both render through StatusPill.
 *
 * Leads are toned by whose move it is rather than by funnel depth, so a glance
 * down the table says what to pick up: indigo means we owe the lead an action,
 * amber that it needs a human decision, green that the conversation is live or
 * won. Everything settled or out of our hands greys out so the rows worth
 * acting on carry the colour.
 */
const STATUS_TONE: Record<string, keyof typeof TONES> = {
  // Companies.
  lead: 'attention',
  active: 'live',
  paused: 'quiet',
  archived: 'quiet',
  // Leads we owe an action.
  new: 'action',
  ready: 'action',
  needs_review: 'attention',
  // Leads in a live conversation, or through it.
  engaged: 'live',
  converted: 'live',
  // Leads waiting on someone else, then the closed ones.
  waiting_reply: 'waiting',
  nurture: 'waiting',
  no_response: 'quiet',
  disqualified: 'lost',
};

export interface Company {
  id: string;
  name: string;
  domain?: string | null;
  status: string;
  ownerId?: string | null;
  billingEmail?: string | null;
  defaultCurrency?: string | null;
  paymentTermsDays?: number | null;
  createdAt?: string | null;
  version?: number;
}
export interface Stage {
  id: string; name: string; position: number; probability: number; isWon: boolean; isLost: boolean;
}
export interface Deal {
  id: string; companyId?: string | null; projectId?: string | null; sourceLeadId?: string | null; title: string; stageId: string;
  amount?: string | number | null; currency?: string | null; expectedCloseDate?: string | null;
  ownerId?: string | null; lostReason?: string | null; version?: number;
  nextActivity?: SalesActivity | null;
}

export interface Lead {
  id: string;
  companyId: string;
  companyName?: string;
  contactId?: string | null;
  contact?: Contact | null;
  title: string;
  product?: string | null;
  status: string;
  score?: number | null;
  signal?: string | null;
  painSignal?: string | null;
  evidence?: string | null;
  whyFit?: string | null;
  whyNow?: string | null;
  sourceTitle?: string | null;
  sourceUrl?: string | null;
  sourceType?: string | null;
  signalDate?: string | null;
  sourceCheckedAt?: string | null;
  suggestedChannel?: string | null;
  opener?: string | null;
  caution?: string | null;
  nurtureUntil?: string | null;
  disqualifiedReason?: string | null;
  ownerId?: string | null;
  convertedDealId?: string | null;
  nextActivity?: SalesActivity | null;
  createdAt?: string | null;
  version?: number;
}

export interface SalesActivity {
  id: string;
  leadId?: string | null;
  dealId?: string | null;
  companyId: string;
  contactId?: string | null;
  type: string;
  status: 'planned' | 'completed' | 'cancelled';
  channel?: string | null;
  subject?: string | null;
  context?: string | null;
  outcome?: string | null;
  dueAt?: string | null;
  completedAt?: string | null;
  ownerId?: string | null;
  messageTemplateId?: string | null;
  sequenceEnrollmentId?: string | null;
  sequenceStepId?: string | null;
  createdAt?: string;
  version?: number;
}

export interface SalesMessageTemplate {
  id: string;
  name: string;
  activityType: string;
  channel?: string | null;
  subject?: string | null;
  body: string;
  active: boolean;
  version: number;
}

export interface SalesSequenceStep {
  id: string;
  sequenceId: string;
  templateId?: string | null;
  position: number;
  delayDays: number;
  activityType: string;
  channel?: string | null;
  subject?: string | null;
  context?: string | null;
}

export interface SalesSequence {
  id: string;
  name: string;
  description: string;
  active: boolean;
  activeEnrollments: number;
  enrollmentCount: number;
  steps: SalesSequenceStep[];
  version: number;
}

export interface SalesSequenceEnrollment {
  id: string;
  sequenceId: string;
  sequenceName: string;
  leadId?: string | null;
  dealId?: string | null;
  status: 'active' | 'completed' | 'stopped';
  currentStepPosition: number;
  ownerId?: string | null;
  version: number;
}

export interface SalesWorkItem {
  entityType: 'lead' | 'deal';
  id: string;
  title: string;
  companyId: string;
  companyName: string;
  status: string;
  nurtureUntil?: string | null;
  nextActivity?: SalesActivity | null;
}

export type SalesWorkBucket =
  | 'overdue'
  | 'dueToday'
  | 'upcoming'
  | 'waitingReply'
  | 'nurtureDue'
  | 'noNextAction';

export type SalesWork = Record<SalesWorkBucket, { rows: SalesWorkItem[]; total: number }>;

export interface ProjectLite { id: string; name: string; key?: string | null }

/** Projects for deal linking – the "which offering is this lead for" dimension. */
export function useProjectsLookup() {
  return useQuery<ProjectLite[]>({
    queryKey: ['projects', 'lookup'],
    queryFn: () => api.get<{ data: ProjectLite[] }>('/projects').then((r) => r.data.map((p: any) => ({ id: p.id, name: p.name, key: p.key }))),
    staleTime: 5 * 60_000,
  });
}
export interface Contact {
  id: string; firstName?: string | null; lastName?: string | null; email?: string | null;
  phone?: string | null; position?: string | null; isPrimary?: boolean;
}
export interface UserLite { id: string; name: string; avatar?: string | null }

export function useDealStages() {
  return useQuery<Stage[]>({
    queryKey: ['deal-stages'],
    queryFn: () => api.get<{ data: Stage[] }>('/deal-stages').then((r) => r.data),
    select: (rows) => [...rows].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    staleTime: 5 * 60_000,
  });
}

/**
 * The kanban's deals. `/deals` is bounded (200 max), and the client has no
 * page-following, so `truncated` says out loud when there are more rather than
 * letting the board look complete while it is not.
 */
export function useAllDeals() {
  return useQuery<{ deals: Deal[]; truncated: boolean }>({
    queryKey: ['deals'],
    queryFn: () => api.get<{ data: Deal[]; nextCursor: string | null }>('/deals?limit=200')
      .then((r) => ({ deals: r.data, truncated: !!r.nextCursor })),
  });
}

/**
 * Like useAllDeals: the list is bounded (200 max) and `truncated` says out loud
 * when there are more leads than the table shows.
 */
export function useLeads(params: { q?: string; status?: string; companyId?: string } = {}) {
  return useQuery<{ leads: Lead[]; truncated: boolean }>({
    queryKey: ['leads', params],
    queryFn: () => api.get<{ data: Lead[]; truncated?: boolean }>(`/leads${qs({ ...params, limit: 200 })}`)
      .then((r) => ({ leads: r.data, truncated: !!r.truncated })),
  });
}

export function useLead(id?: string | null, enabled = true) {
  return useQuery<Lead>({
    queryKey: ['lead', id],
    queryFn: () => api.get<Lead>(`/leads/${id!}`),
    enabled: !!id && enabled,
  });
}

export function useContacts(companyId?: string | null) {
  return useQuery<Contact[]>({
    queryKey: ['contacts', companyId],
    queryFn: () => api.get<{ data: Contact[] }>(`/contacts${qs({ companyId })}`).then((r) => r.data),
    enabled: !!companyId,
  });
}

export function useSalesActivities(params: {
  leadId?: string;
  dealId?: string;
  companyId?: string;
  ownerId?: string;
  status?: string;
  limit?: number;
}) {
  return useQuery<SalesActivity[]>({
    queryKey: ['sales-activities', params],
    queryFn: () => api.get<{ data: SalesActivity[] }>(`/sales-activities${qs(params)}`).then((r) => r.data),
  });
}

export function useSalesMessageTemplates(activeOnly = false) {
  return useQuery<SalesMessageTemplate[]>({
    queryKey: ['sales-message-templates', { activeOnly }],
    queryFn: () => api.get<{ data: SalesMessageTemplate[] }>(
      `/sales-message-templates${qs({ active: activeOnly || undefined })}`,
    ).then((response) => response.data),
  });
}

export function useSalesSequences(activeOnly = false) {
  return useQuery<SalesSequence[]>({
    queryKey: ['sales-sequences', { activeOnly }],
    queryFn: () => api.get<{ data: SalesSequence[] }>(
      `/sales-sequences${qs({ active: activeOnly || undefined })}`,
    ).then((response) => response.data),
  });
}

export function useSalesSequenceEnrollments(params: { leadId?: string; dealId?: string }) {
  return useQuery<SalesSequenceEnrollment[]>({
    queryKey: ['sales-sequence-enrollments', params],
    queryFn: () => api.get<{ data: SalesSequenceEnrollment[] }>(
      `/sales-sequence-enrollments${qs(params)}`,
    ).then((response) => response.data),
    enabled: !!params.leadId || !!params.dealId,
  });
}

export interface CurrencyTotal { currency: string; amount: number }

export interface SalesAnalytics {
  leads: {
    total: number;
    byStatus: Record<string, number>;
    new30d: number;
    prev30d: number;
    resolved: { converted: number; disqualified: number; noResponse: number };
    conversionRate: number | null;
  };
  deals: {
    stages: Array<{
      id: string; name: string; position: number; probability: number;
      isWon: boolean; isLost: boolean; count: number; totals: CurrencyTotal[];
    }>;
    openCount: number;
    wonCount: number;
    lostCount: number;
    winRate: number | null;
    openTotals: CurrencyTotal[];
    weightedOpenTotals: CurrencyTotal[];
    wonTotals: CurrencyTotal[];
    lostReasons: Array<{ reason: string | null; count: number }>;
  } | null;
}

export function useSalesAnalytics() {
  return useQuery<SalesAnalytics>({
    queryKey: ['sales-analytics'],
    queryFn: () => api.get<SalesAnalytics>('/sales-analytics'),
  });
}

export function useSalesWork(scope: 'mine' | 'all' = 'mine') {
  return useQuery<SalesWork>({
    queryKey: ['sales-work', scope],
    queryFn: () => api.get<SalesWork>(`/sales-work${qs({ scope, limit: 50 })}`),
  });
}

export function useCompanies(q = '', status = '') {
  return useQuery<Company[]>({
    queryKey: ['companies', q, status],
    queryFn: () => api.get<{ data: Company[] }>(`/companies${qs({ q, status, limit: 200 })}`).then((r) => r.data),
  });
}

export { useUsersLookup, useUserMap } from '../../lib/queries';

export function StatusPill({ status, className }: { status: string; className?: string }) {
  const t = useT();
  const label = t(`crm.status.${status}`, status);
  const tone = TONES[STATUS_TONE[status] ?? 'quiet'];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', tone.text, className)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', tone.dot)} />
      {label}
    </span>
  );
}
