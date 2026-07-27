/**
 * The ordi MCP tool catalog, transport-agnostic. The stdio entry (index.ts)
 * serves it to local clients with an env token; the API serves the same
 * catalog over Streamable HTTP with per-request OAuth bearer tokens.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { COMPANY_STATUSES, CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES } from '@ordi/shared';
import { OrdiClient } from './client';

/**
 * Keys stripped from every tool response before it reaches the model.
 * Optimistic-locking counters and soft-delete markers carry nothing a model
 * can act on, and portalToken is a capability URL secret that must never end
 * up in an agent's context window.
 */
const NOISE_KEYS = new Set([
  'version', 'deletedAt', 'deleted_at', 'templateSourceId', 'template_source_id',
  'portalToken', 'portal_token', 'searchVector', 'search_vector',
]);

export function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !NOISE_KEYS.has(k))
      .map(([k, v]) => [k, scrub(v)]));
  }
  return value;
}

export function buildServer(client: OrdiClient): McpServer {
  const server = new McpServer({ name: 'ordi', version: '1.0.0' });

  function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(scrub(data), null, 2) }] };
}
  function wrap<T>(fn: () => Promise<T>) {
  return fn().then(text).catch((e: Error) => ({ isError: true, content: [{ type: 'text' as const, text: e.message }] }));
}

// ── Read tools ──
  server.tool('search', 'Search companies, projects, tasks, invoices and KB pages by name/title/number. Matches titles and indexed text, not arbitrary fields; use list_projects / list_companies to enumerate instead of guessing names.', { query: z.string() },
  ({ query }) => wrap(() => client.get(`/search?q=${encodeURIComponent(query)}`)));

  server.tool('list_projects', 'List projects the token owner can access – the way to obtain projectId for the other project tools', {
  status: z.string().optional().describe('Filter by status, e.g. active'), companyId: z.string().optional(),
}, ({ status, companyId }) => wrap(async () => {
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (companyId) qs.set('companyId', companyId);
  const res = await client.get<{ data: Record<string, unknown>[] }>(`/projects${qs.toString() ? `?${qs}` : ''}`);
  return { data: res.data.map((p) => ({
    id: p.id, key: p.key, name: p.name, status: p.status, priority: p.priority,
    companyId: p.companyId, leadId: p.leadId, startDate: p.startDate, targetDate: p.targetDate,
  })) };
}));

  server.tool('list_companies', 'List CRM companies – the way to obtain companyId for company/finance tools', {
  q: z.string().optional().describe('Substring of the company name'),
  status: z.string().optional().describe('e.g. lead | client'), limit: z.number().optional(),
}, ({ q, status, limit }) => wrap(async () => {
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (status) qs.set('status', status);
  if (limit) qs.set('limit', String(limit));
  const res = await client.get<{ data: Record<string, unknown>[]; nextCursor: string | null }>(`/companies${qs.toString() ? `?${qs}` : ''}`);
  return { data: res.data.map((co) => ({
    id: co.id, name: co.name, domain: co.domain, status: co.status,
    ownerId: co.ownerId, defaultCurrency: co.defaultCurrency, paymentTermsDays: co.paymentTermsDays,
  })), nextCursor: res.nextCursor };
}));

  server.tool('get_company_overview', 'Company metrics: projects, tasks, and (if permitted) receivables', { companyId: z.string() },
  ({ companyId }) => wrap(() => client.get(`/companies/${companyId}/overview`)));

  server.tool('list_contacts', 'List contacts of a CRM company – the way to obtain contactId', { companyId: z.string() },
  ({ companyId }) => wrap(async () => {
  const res = await client.get<{ data: Record<string, unknown>[] }>(`/contacts?companyId=${encodeURIComponent(companyId)}`);
  return { data: res.data.map((ct) => ({
    id: ct.id, companyId: ct.companyId, firstName: ct.firstName, lastName: ct.lastName,
    email: ct.email, phone: ct.phone, position: ct.position, isPrimary: ct.isPrimary,
  })) };
}));

  server.tool('list_deals', 'List deals, optionally for one company – the way to obtain dealId for move_deal', {
  companyId: z.string().optional(),
}, ({ companyId }) => wrap(async () => {
  const res = await client.get<{ data: Record<string, unknown>[] }>(`/deals${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ''}`);
  return { data: res.data.map((d) => ({
    id: d.id, title: d.title, companyId: d.companyId, stageId: d.stageId,
    amount: d.amount, currency: d.currency, expectedCloseDate: d.expectedCloseDate, ownerId: d.ownerId,
  })) };
}));

  server.tool('list_deal_stages', 'List pipeline stages – the way to obtain stageId for create_deal / move_deal', {},
  () => wrap(async () => {
  const res = await client.get<{ data: Record<string, unknown>[] }>('/deal-stages');
  return { data: res.data.map((s) => ({
    id: s.id, name: s.name, position: s.position, probability: s.probability, isWon: s.isWon, isLost: s.isLost,
  })) };
}));

  server.tool('list_custom_fields', 'List custom field definitions – the keys usable in the customFields argument of create tools', {
  entityType: z.enum(CUSTOM_FIELD_ENTITIES).optional().describe('Filter by entity, e.g. companies | deals | tasks'),
}, ({ entityType }) => wrap(async () => {
  const res = await client.get<{ data: Record<string, unknown>[] }>(`/custom-fields${entityType ? `?entityType=${entityType}` : ''}`);
  return { data: res.data.map((f) => ({
    id: f.id, entityType: f.entityType, key: f.key, label: f.label, type: f.type,
    options: f.options, required: f.required, deprecated: f.deprecated,
  })) };
}));

  server.tool('list_my_tasks', 'The token owner’s assigned/created tasks grouped by due date', {},
  () => wrap(() => client.get('/me/tasks')));

  server.tool('get_project_status', 'Project details and task summary', { projectId: z.string() },
  ({ projectId }) => wrap(() => client.get(`/projects/${projectId}`)));

  server.tool('get_cycle_progress', 'Cycle progress and burndown snapshots', { cycleId: z.string() },
  ({ cycleId }) => wrap(() => client.get(`/cycles/${cycleId}`)));

  server.tool('list_overdue_invoices', 'Overdue invoices with outstanding amounts', {},
  () => wrap(() => client.get('/finance/dashboard')));

  server.tool('get_receivables_aging', 'Receivables aging (0-30/31-60/61-90/90+)', {},
  () => wrap(() => client.get('/finance/dashboard')));

  server.tool('list_unbilled_time', 'Unbilled billable time entries for a client', { companyId: z.string() },
  ({ companyId }) => wrap(() => client.get(`/time/unbilled?companyId=${companyId}`)));

  server.tool('find_kb_page', 'Search knowledge base pages', { query: z.string() },
  ({ query }) => wrap(() => client.get(`/search?q=${encodeURIComponent(query)}`)));

  server.tool('get_project_profitability', 'Project profitability (requires finance.read_costs scope)', { projectId: z.string() },
  ({ projectId }) => wrap(() => client.get(`/finance/profitability?scope=project&projectId=${projectId}`)));

  server.tool('get_labor_cost', 'Labor cost report (requires finance.read_costs scope)', { from: z.string().optional(), to: z.string().optional() },
  ({ from, to }) => wrap(() => client.get(`/finance/profitability?scope=labor${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}`)));

  server.tool('get_team_availability', 'Team allocations/availability', {},
  () => wrap(() => client.get('/allocations')));

  server.tool('list_pending_leave', 'Pending leave requests', {},
  () => wrap(() => client.get('/leave-requests?status=pending')));

  server.tool('get_recruitment_pipeline', 'Recruitment pipeline overview', {},
  () => wrap(() => client.get('/people/dashboard')));

// ── Action tools (no delete/cancel) ──
  server.tool('create_task', 'Create a task in a project', {
  projectId: z.string(), title: z.string(), priority: z.enum(['none', 'low', 'medium', 'high', 'urgent']).optional(),
  customFields: z.record(z.string(), z.unknown()).optional().describe('Keyed by custom field key (see list_custom_fields)'),
}, ({ projectId, title, priority, customFields }) => wrap(() => client.post('/tasks', {
  projectId, title, priority: priority ?? 'none', assigneeIds: [], labelIds: [],
  ...(customFields ? { customFields } : {}),
})));

  server.tool('update_task_status', 'Change a task status', { taskId: z.string(), statusId: z.string() },
  ({ taskId, statusId }) => wrap(() => client.patch(`/tasks/${taskId}`, { statusId })));

  server.tool('assign_task', 'Assign users to a task', { taskId: z.string(), assigneeIds: z.array(z.string()) },
  ({ taskId, assigneeIds }) => wrap(() => client.patch(`/tasks/${taskId}`, { assigneeIds })));

  server.tool('comment_on_task', 'Comment on a task', { taskId: z.string(), text: z.string() },
  ({ taskId, text: body }) => wrap(() => client.post(`/tasks/${taskId}/comments`, { body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] }, mentions: [] })));

  server.tool('log_time', 'Log time on a task', { taskId: z.string(), durationSeconds: z.number(), note: z.string().optional(), startedAt: z.string().optional() },
  ({ taskId, durationSeconds, note, startedAt }) => wrap(() => client.post('/time/entries', { taskId, durationSeconds, note: note ?? '', startedAt: startedAt ?? new Date().toISOString() })));

  server.tool('create_invoice_from_time', 'Create a draft invoice from unbilled time', {
  companyId: z.string(), from: z.string(), to: z.string(), projectIds: z.array(z.string()), grouping: z.enum(['task', 'user', 'single']).optional(),
}, (args) => wrap(() => client.post('/invoices/from-time', { ...args, grouping: args.grouping ?? 'task' })));

  server.tool('create_invoice_from_project', 'Create a draft invoice pre-filled from a client project', {
  projectId: z.string(), issueDate: z.string(), dueDate: z.string(),
  items: z.array(z.object({ description: z.string(), quantity: z.number(), unitPrice: z.number() })).optional(),
}, ({ projectId, issueDate, dueDate, items }) => wrap(async () => {
  const project = await client.get<{ companyId: string | null }>(`/projects/${projectId}`);
  if (!project.companyId) throw new Error('Project has no client company – only projects whose type bills a client can be invoiced');
  return client.post('/invoices', { companyId: project.companyId, projectId, issueDate, dueDate, items: items ?? [] });
}));

  server.tool('send_invoice', 'Send an invoice by email', { invoiceId: z.string() },
  ({ invoiceId }) => wrap(() => client.post(`/invoices/${invoiceId}/send`, {})));

  server.tool('record_payment', 'Record a payment on an invoice', {
  invoiceId: z.string(), amount: z.number(), currency: z.string(), date: z.string(), method: z.enum(['bank', 'card', 'cash', 'other']).optional(),
}, ({ invoiceId, amount, currency, date, method }) => wrap(() => client.post(`/invoices/${invoiceId}/payments`, { amount, currency, date, method: method ?? 'bank' })));

  server.tool('send_payment_reminder', 'Trigger the finance dashboard refresh (reminders run via workers)', { invoiceId: z.string() },
  ({ invoiceId }) => wrap(() => client.get(`/invoices/${invoiceId}`)));

  server.tool('create_quote', 'Create a quote', {
  companyId: z.string(), issueDate: z.string(), items: z.array(z.object({ description: z.string(), quantity: z.number(), unitPrice: z.number() })),
}, ({ companyId, issueDate, items }) => wrap(() => client.post('/quotes', { companyId, issueDate, items })));

  server.tool('create_note', 'Create a CRM note', { companyId: z.string(), text: z.string() },
  ({ companyId, text: body }) => wrap(() => client.post('/notes', { companyId, body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: body }] }] } })));

  server.tool('create_company', 'Create a CRM company', {
  name: z.string(), domain: z.string().optional(), status: z.enum(COMPANY_STATUSES).optional().describe('Defaults to lead'),
  billingEmail: z.string().optional(), defaultCurrency: z.string().length(3).optional(), paymentTermsDays: z.number().int().optional(),
  customFields: z.record(z.string(), z.unknown()).optional().describe('Keyed by custom field key (see list_custom_fields)'),
}, (args) => wrap(() => client.post('/companies', args)));

  server.tool('create_contact', 'Create a contact in a CRM company', {
  companyId: z.string(), firstName: z.string(), lastName: z.string().optional(),
  email: z.string().optional(), phone: z.string().optional(), position: z.string().optional(),
  isPrimary: z.boolean().optional().describe('Make this the company’s primary contact'),
  customFields: z.record(z.string(), z.unknown()).optional().describe('Keyed by custom field key (see list_custom_fields)'),
}, (args) => wrap(() => client.post('/contacts', args)));

  server.tool('create_deal', 'Create a deal in a pipeline stage (use list_deal_stages for stageId)', {
  companyId: z.string(), title: z.string(), stageId: z.string(),
  amount: z.number().min(0).optional(), currency: z.string().length(3).optional().describe('Defaults to USD'),
  expectedCloseDate: z.string().optional().describe('YYYY-MM-DD'),
  customFields: z.record(z.string(), z.unknown()).optional().describe('Keyed by custom field key (see list_custom_fields)'),
}, (args) => wrap(() => client.post('/deals', args)));

  server.tool('create_custom_field', 'Define a custom field on an entity (requires settings.manage scope)', {
  entityType: z.enum(CUSTOM_FIELD_ENTITIES), key: z.string().describe('lowercase snake_case, immutable'),
  label: z.string(), type: z.enum(CUSTOM_FIELD_TYPES),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional().describe('For select / multiselect types'),
  required: z.boolean().optional(), showInList: z.boolean().optional().describe('Show as a column in list views'),
}, (args) => wrap(() => client.post('/custom-fields', args)));

  server.tool('move_deal', 'Move a deal to a stage (use list_deal_stages for stageId)', { dealId: z.string(), stageId: z.string(), lostReason: z.string().optional() },
  ({ dealId, stageId, lostReason }) => wrap(() => client.post(`/deals/${dealId}/move`, { stageId, lostReason })));

  server.tool('create_kb_page', 'Create a knowledge base page', { spaceId: z.string(), title: z.string(), text: z.string().optional() },
  ({ spaceId, title, text: body }) => wrap(() => client.post('/pages', { spaceId, title, body: { type: 'doc', content: [{ type: 'paragraph', content: body ? [{ type: 'text', text: body }] : [] }] } })));

  server.tool('request_leave', 'Request leave for an employee', {
  employeeId: z.string(), leaveTypeId: z.string(), fromDate: z.string(), toDate: z.string(), reason: z.string().optional(),
}, (args) => wrap(() => client.post('/leave-requests', { ...args, reason: args.reason ?? '' })));

  server.tool('approve_leave', 'Approve a leave request', { requestId: z.string() },
  ({ requestId }) => wrap(() => client.post(`/leave-requests/${requestId}/approve`, { decision: 'approve' })));

  server.tool('create_job_opening', 'Create a job opening', { title: z.string(), description: z.string().optional() },
  ({ title, description }) => wrap(() => client.post('/job-openings', { title, description: description ?? '' })));

  server.tool('move_applicant', 'Move an applicant to a stage', { applicantId: z.string(), stageId: z.string(), rejectedReason: z.string().optional() },
  ({ applicantId, stageId, rejectedReason }) => wrap(() => client.post(`/applicants/${applicantId}/move`, { stageId, rejectedReason })));

  return server;
}
