/**
 * The ordi MCP tool catalog, transport-agnostic. The stdio entry (index.ts)
 * serves it to local clients with an env token; the API serves the same
 * catalog over Streamable HTTP with per-request OAuth bearer tokens.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { COMPANY_STATUSES, CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES, docToText, textToDoc } from '@ordi/shared';
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

/**
 * Agents frequently paste HTML-escaped text ("Co-founder &amp; CEO") scraped
 * from web pages. Stored verbatim it renders escaped in the UI, so every
 * string argument of the write tools is decoded once at this boundary.
 * Applied recursively to plain objects/arrays; non-strings pass through.
 */
export function decodeEntities<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(/&(amp|lt|gt|quot|#0?39|apos|nbsp);/g, (m) => (
        { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#039;': "'", '&apos;': "'", '&nbsp;': ' ' }[m] ?? m
      )) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(decodeEntities) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, decodeEntities(v)])) as unknown as T;
  }
  return value;
}

/**
 * Plain text ⇄ tiptap doc, shared with the API so an agent writes and reads
 * back the same thing: multi-line text keeps its breaks in the web renderer,
 * and a stored body comes back as text instead of a node tree.
 */
export { textToDoc, docToText };

export function buildServer(client: OrdiClient): McpServer {
  const server = new McpServer({ name: 'ordi', version: '1.0.0' });

  // Every write goes through one decode pass: whatever tool the text arrives
  // from, escaped entities never reach the database.
  const rawPost = client.post.bind(client);
  const rawPatch = client.patch.bind(client);
  client.post = (path, body) => rawPost(path, decodeEntities(body));
  client.patch = (path, body) => rawPatch(path, decodeEntities(body));

  function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(scrub(data), null, 2) }] };
}
  function wrap<T>(fn: () => Promise<T>) {
  return fn().then(text).catch((e: Error) => ({ isError: true, content: [{ type: 'text' as const, text: e.message }] }));
}

// ── Read tools ──
  server.tool('search', 'Search companies, projects, tasks, CRM notes, invoices and KB pages by name/title/number. Matches titles, note bodies and indexed text, not arbitrary fields; use list_projects / list_companies / list_notes to enumerate instead of guessing names.', { query: z.string() },
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
    customFields: p.customFields ?? {},
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
    customFields: co.customFields ?? {},
  })), nextCursor: res.nextCursor };
}));

  server.tool('get_company', 'One company with every field, including customFields – read back what a write stored', { companyId: z.string() },
  ({ companyId }) => wrap(() => client.get(`/companies/${companyId}`)));

  server.tool('get_company_overview', 'Company metrics: projects, tasks, and (if permitted) receivables', { companyId: z.string() },
  ({ companyId }) => wrap(() => client.get(`/companies/${companyId}/overview`)));

  server.tool('list_contacts', 'List contacts of a CRM company – the way to obtain contactId', { companyId: z.string() },
  ({ companyId }) => wrap(async () => {
  const res = await client.get<{ data: Record<string, unknown>[] }>(`/contacts?companyId=${encodeURIComponent(companyId)}`);
  return { data: res.data.map((ct) => ({
    id: ct.id, companyId: ct.companyId, firstName: ct.firstName, lastName: ct.lastName,
    email: ct.email, phone: ct.phone, position: ct.position, isPrimary: ct.isPrimary,
    customFields: ct.customFields ?? {},
  })) };
}));

  server.tool('get_contact', 'One contact with every field, including customFields', { contactId: z.string(), companyId: z.string().describe('The contact’s company (contacts are listed per company)') },
  ({ contactId, companyId }) => wrap(async () => {
  const res = await client.get<{ data: Record<string, unknown>[] }>(`/contacts?companyId=${encodeURIComponent(companyId)}`);
  const found = res.data.find((ct) => ct.id === contactId);
  if (!found) throw new Error(`No contact ${contactId} in company ${companyId}`);
  return found;
}));

  server.tool('list_deals', 'List deals, filterable by company and by linked project – the way to obtain dealId for move_deal', {
  companyId: z.string().optional(),
  projectId: z.string().optional().describe('Filter by linked project id, or the literal "none" for unlinked deals'),
}, ({ companyId, projectId }) => wrap(async () => {
  const qs = new URLSearchParams();
  if (companyId) qs.set('companyId', companyId);
  if (projectId) qs.set('projectId', projectId);
  const res = await client.get<{ data: Record<string, unknown>[] }>(`/deals${qs.toString() ? `?${qs}` : ''}`);
  return { data: res.data.map((d) => ({
    id: d.id, title: d.title, companyId: d.companyId, projectId: d.projectId, stageId: d.stageId,
    amount: d.amount, currency: d.currency, expectedCloseDate: d.expectedCloseDate, ownerId: d.ownerId,
    lostReason: d.lostReason, customFields: d.customFields ?? {},
  })) };
}));

  server.tool('get_deal', 'One deal with every field, including customFields – reading a deal never needs a write', { dealId: z.string() },
  ({ dealId }) => wrap(() => client.get(`/deals/${dealId}`)));

  server.tool('list_notes', 'CRM notes on a company, contact or deal, newest first, bodies rendered as plain text', {
  companyId: z.string().optional(), contactId: z.string().optional(), dealId: z.string().optional(),
  limit: z.number().optional().describe('Defaults to 20'),
}, ({ companyId, contactId, dealId, limit }) => wrap(async () => {
  if (!companyId && !contactId && !dealId) throw new Error('One of companyId, contactId or dealId is required');
  const qs = new URLSearchParams();
  if (companyId) qs.set('companyId', companyId);
  if (contactId) qs.set('contactId', contactId);
  if (dealId) qs.set('dealId', dealId);
  const res = await client.get<{ data: Record<string, unknown>[] }>(`/notes?${qs}`);
  return { data: res.data.slice(0, limit ?? 20).map((n) => ({
    id: n.id, companyId: n.companyId, contactId: n.contactId, dealId: n.dealId,
    pinned: n.pinned, createdAt: n.createdAt, createdBy: n.createdBy, text: docToText(n.body),
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

  server.tool('comment_on_task', 'Comment on a task (line breaks are preserved)', { taskId: z.string(), text: z.string() },
  ({ taskId, text: body }) => wrap(() => client.post(`/tasks/${taskId}/comments`, { body: textToDoc(body), mentions: [] })));

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

  server.tool('create_note', 'Create a CRM note on a company, contact or deal (line breaks are preserved; blank line = new paragraph)', {
  companyId: z.string().optional(), contactId: z.string().optional(), dealId: z.string().optional(), text: z.string(),
}, ({ companyId, contactId, dealId, text: body }) => wrap(async () => {
  if (!companyId && !contactId && !dealId) throw new Error('One of companyId, contactId or dealId is required');
  return client.post('/notes', { companyId, contactId, dealId, body: textToDoc(body) });
}));

  server.tool('create_company', 'Create a CRM company. Refuses a name or domain that already exists – update the existing record instead of doubling it.', {
  name: z.string(), domain: z.string().optional(), status: z.enum(COMPANY_STATUSES).optional().describe('Defaults to lead'),
  billingEmail: z.string().optional(), defaultCurrency: z.string().length(3).optional(), paymentTermsDays: z.number().int().optional(),
  customFields: z.record(z.string(), z.unknown()).optional().describe('Keyed by custom field key (see list_custom_fields)'),
  allowDuplicate: z.boolean().optional().describe('Create anyway when a same-named company legitimately exists'),
}, ({ allowDuplicate, ...args }) => wrap(async () => {
  // A re-run of the same import is the normal way this tool gets called twice;
  // without this check the second pass silently doubles the CRM. A token that
  // may write but not read cannot look first – then the create proceeds, since
  // refusing to create because the check is unavailable is the worse failure.
  if (!allowDuplicate) {
    const hit = await client
      .get<{ data: Record<string, unknown>[] }>(`/companies?q=${encodeURIComponent(args.name)}&limit=50`)
      .then((existing) => {
        const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
        const host = (v: unknown) => norm(v).replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
        return existing.data.find((co) => norm(co.name) === norm(args.name)
          || (!!args.domain && !!host(co.domain) && host(co.domain) === host(args.domain))) ?? null;
      })
      .catch(() => null);
    if (hit) {
      throw new Error(`Company already exists: ${hit.name} (id ${hit.id}). Use update_company to change it, or pass allowDuplicate: true.`);
    }
  }
  return client.post('/companies', args);
}));

  server.tool('update_company', 'Update a CRM company. customFields merge by key: send only the fields you are changing, the rest keep their values.', {
  companyId: z.string(),
  name: z.string().optional(), domain: z.string().optional(), status: z.enum(COMPANY_STATUSES).optional(),
  billingEmail: z.string().optional(), defaultCurrency: z.string().length(3).optional(), paymentTermsDays: z.number().int().optional(),
  customFields: z.record(z.string(), z.unknown()).optional().describe('Keyed by custom field key (see list_custom_fields); null clears one'),
}, ({ companyId, ...patch }) => wrap(() => client.patch(`/companies/${companyId}`, patch)));

  server.tool('update_contact', 'Update a contact. customFields merge by key.', {
  contactId: z.string(),
  firstName: z.string().optional(), lastName: z.string().optional(), email: z.string().optional(),
  phone: z.string().optional(), position: z.string().optional(), isPrimary: z.boolean().optional(),
  customFields: z.record(z.string(), z.unknown()).optional().describe('Keyed by custom field key; null clears one'),
}, ({ contactId, ...patch }) => wrap(() => client.patch(`/contacts/${contactId}`, patch)));

  server.tool('update_deal', 'Update a deal – amount, dates, owner, linked project, custom fields. customFields merge by key. Use move_deal to change the stage.', {
  dealId: z.string(),
  title: z.string().optional(), amount: z.number().min(0).optional(), currency: z.string().length(3).optional(),
  expectedCloseDate: z.string().optional().describe('YYYY-MM-DD'), ownerId: z.string().optional(),
  projectId: z.string().optional().describe('Project this deal sells into'),
  customFields: z.record(z.string(), z.unknown()).optional().describe('Keyed by custom field key; null clears one'),
}, ({ dealId, ...patch }) => wrap(() => client.patch(`/deals/${dealId}`, patch)));

  server.tool('create_contact', 'Create a contact in a CRM company', {
  companyId: z.string(), firstName: z.string(), lastName: z.string().optional(),
  email: z.string().optional(), phone: z.string().optional(), position: z.string().optional(),
  isPrimary: z.boolean().optional().describe('Make this the company’s primary contact'),
  customFields: z.record(z.string(), z.unknown()).optional().describe('Keyed by custom field key (see list_custom_fields)'),
}, (args) => wrap(() => client.post('/contacts', args)));

  server.tool('create_deal', 'Create a deal in a pipeline stage (use list_deal_stages for stageId). Link it to the product/delivery project it sells into via projectId (use list_projects) so leads for different offerings stay separable.', {
  companyId: z.string(), title: z.string(), stageId: z.string(),
  projectId: z.string().optional().describe('Project this deal sells into, e.g. the SaaS product project for a product lead'),
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

  server.tool('update_custom_field', 'Edit a custom field definition: label, select options, flags, or retire it with deprecated (key and type are immutable, and deprecating keeps the stored values). Requires settings.manage scope.', {
  fieldId: z.string().describe('From list_custom_fields'),
  label: z.string().optional(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).optional().describe('For select / multiselect types'),
  required: z.boolean().optional(), showInList: z.boolean().optional(),
  deprecated: z.boolean().optional().describe('Retire the field: hidden from editors, existing values kept'),
}, ({ fieldId, ...patch }) => wrap(() => client.patch(`/custom-fields/${fieldId}`, patch)));

  server.tool('move_deal', 'Move a deal to a stage (use list_deal_stages for stageId). `lostReason` is the free-text detail a lost stage requires; when the workspace also has a structured reason field, set it in the same call through customFields so the two never disagree.', {
  dealId: z.string(), stageId: z.string(),
  lostReason: z.string().optional().describe('Required by stages marked lost'),
  customFields: z.record(z.string(), z.unknown()).optional().describe('Merged by key, e.g. a lost_reason_code select (see list_custom_fields)'),
}, ({ dealId, stageId, lostReason, customFields }) => wrap(async () => {
  if (customFields) await client.patch(`/deals/${dealId}`, { customFields });
  return client.post(`/deals/${dealId}/move`, { stageId, lostReason });
}));

  server.tool('create_kb_page', 'Create a knowledge base page (line breaks are preserved; blank line = new paragraph)', { spaceId: z.string(), title: z.string(), text: z.string().optional() },
  ({ spaceId, title, text: body }) => wrap(() => client.post('/pages', { spaceId, title, body: textToDoc(body ?? '') })));

  server.tool('request_leave', 'Request leave – for the token owner by default, or for another employee with the HR scopes', {
  leaveTypeId: z.string(), fromDate: z.string(), toDate: z.string(),
  employeeId: z.string().optional().describe('Defaults to the token owner’s own employee record'),
  reason: z.string().optional(),
}, (args) => wrap(() => client.post('/leave-requests', { ...args, reason: args.reason ?? '' })));

  server.tool('approve_leave', 'Approve a leave request', { requestId: z.string() },
  ({ requestId }) => wrap(() => client.post(`/leave-requests/${requestId}/approve`, { decision: 'approve' })));

  server.tool('create_job_opening', 'Create a job opening', { title: z.string(), description: z.string().optional() },
  ({ title, description }) => wrap(() => client.post('/job-openings', { title, description: description ?? '' })));

  server.tool('move_applicant', 'Move an applicant to a stage', { applicantId: z.string(), stageId: z.string(), rejectedReason: z.string().optional() },
  ({ applicantId, stageId, rejectedReason }) => wrap(() => client.post(`/applicants/${applicantId}/move`, { stageId, rejectedReason })));

  return server;
}
