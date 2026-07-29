/**
 * The ordi MCP tool catalog, transport-agnostic. The stdio entry (index.ts)
 * serves it to local clients with an env token; the API serves the same
 * catalog over Streamable HTTP with per-request OAuth bearer tokens.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  COMPANY_STATUSES, CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_TYPES, LEAD_STATUSES,
  LEAD_ACTIVITY_OUTCOME_STATUSES, SALES_ACTIVITY_TYPES, WRITABLE_LEAD_STATUSES,
  dateOnlySchema, docToText, textToDoc,
} from '@ordi/shared';
import { OrdiClient } from './client';
import { decodeEntities, scrub, text, wrap } from './format';
import { registerTaskTools } from './tasks';

export { decodeEntities, scrub };

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

// ── Read tools ──
  server.tool('search', 'Search companies, projects, tasks, CRM notes, invoices and KB pages by name/title/number. Matches titles, note bodies and indexed text, not arbitrary fields; use list_projects / list_companies / list_notes to enumerate instead of guessing names.', { query: z.string() },
  ({ query }) => wrap(() => client.get(`/search?q=${encodeURIComponent(query)}`)));

  server.tool('list_projects', 'List projects the token owner can access – the way to obtain projectId for the other project tools. Filter by key to look one up by its short code, e.g. CONTENT.', {
  status: z.string().optional().describe('Filter by status, e.g. active'), companyId: z.string().optional(),
  key: z.string().optional().describe('Exact project key, case-insensitive, e.g. CONTENT'),
}, ({ status, companyId, key }) => wrap(async () => {
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  if (companyId) qs.set('companyId', companyId);
  const res = await client.get<{ data: Record<string, unknown>[] }>(`/projects${qs.toString() ? `?${qs}` : ''}`);
  if (key) res.data = res.data.filter((p) => String(p.key ?? '').toUpperCase() === key.trim().toUpperCase());
  return { data: res.data.map((p) => ({
    id: p.id, key: p.key, name: p.name, status: p.status, priority: p.priority,
    companyId: p.companyId, leadId: p.leadId, startDate: p.startDate, targetDate: p.targetDate,
    customFields: p.customFields ?? {},
  })) };
}));

  server.tool('list_companies', 'List CRM companies – the way to obtain companyId for company/finance tools. Paged: pass the returned nextCursor to continue.', {
  q: z.string().optional().describe('Substring of the company name'),
  status: z.string().optional().describe('e.g. lead | client'), limit: z.number().optional(),
  cursor: z.string().optional().describe('nextCursor from a previous call'),
}, ({ q, status, limit, cursor }) => wrap(async () => {
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (status) qs.set('status', status);
  if (limit) qs.set('limit', String(limit));
  if (cursor) qs.set('cursor', cursor);
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

  server.tool('get_contact', 'One contact with every field, including customFields', { contactId: z.string() },
  ({ contactId }) => wrap(() => client.get(`/contacts/${contactId}`)));

  server.tool('list_leads', 'List unqualified sales leads. Filter by status or company; use get_sales_work for due work.', {
  q: z.string().optional(), status: z.enum(LEAD_STATUSES).optional(), companyId: z.string().optional(),
}, ({ q, status, companyId }) => wrap(async () => {
  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (status) qs.set('status', status);
  if (companyId) qs.set('companyId', companyId);
  const res = await client.get<{ data: Record<string, unknown>[] }>(`/leads${qs.toString() ? `?${qs}` : ''}`);
  return { data: res.data.map((lead) => ({
    id: lead.id, companyId: lead.companyId, companyName: lead.companyName, contactId: lead.contactId,
    title: lead.title, product: lead.product, status: lead.status, score: lead.score,
    signal: lead.signal, painSignal: lead.painSignal, whyFit: lead.whyFit, whyNow: lead.whyNow,
    sourceUrl: lead.sourceUrl, sourceCheckedAt: lead.sourceCheckedAt, suggestedChannel: lead.suggestedChannel,
    ownerId: lead.ownerId,
  })) };
}));

  server.tool('get_lead', 'One lead with its qualification notes, conversion link and custom fields', { leadId: z.string() },
  ({ leadId }) => wrap(() => client.get(`/leads/${leadId}`)));

  server.tool('get_sales_work', 'Due sales work grouped into overdue, today, waiting for reply, nurture due and no-next-action queues', {
  scope: z.enum(['mine', 'all']).optional().describe('Defaults to mine; use all for the whole sales team'),
}, ({ scope }) => wrap(() => client.get(`/sales-work?scope=${scope ?? 'mine'}`)));

  server.tool('list_sales_activities', 'List planned and completed sales activities for a lead, deal or company', {
  leadId: z.string().optional(), dealId: z.string().optional(), companyId: z.string().optional(),
  ownerId: z.string().optional(), status: z.enum(['planned', 'completed', 'cancelled']).optional(),
  limit: z.number().int().min(1).max(200).optional().describe('Defaults to 100'),
}, ({ leadId, dealId, companyId, ownerId, status, limit }) => wrap(async () => {
  const qs = new URLSearchParams();
  if (leadId) qs.set('leadId', leadId);
  if (dealId) qs.set('dealId', dealId);
  if (companyId) qs.set('companyId', companyId);
  if (ownerId) qs.set('ownerId', ownerId);
  if (status) qs.set('status', status);
  if (limit) qs.set('limit', String(limit));
  return client.get(`/sales-activities${qs.toString() ? `?${qs}` : ''}`);
}));

  server.tool('list_sales_playbooks', 'List reusable sales message templates and manual-action sequences, including ordered steps and active enrollment counts', {},
  () => wrap(async () => {
    const [templates, sequences] = await Promise.all([
      client.get('/sales-message-templates'),
      client.get('/sales-sequences'),
    ]);
    return { templates, sequences };
  }));

  server.tool('list_deals', 'List deals, filterable by company and by linked project – the way to obtain dealId for move_deal. Paged: pass the returned nextCursor to continue.', {
  companyId: z.string().optional(),
  projectId: z.string().optional().describe('Filter by linked project id, or the literal "none" for unlinked deals'),
  limit: z.number().optional().describe('Rows per page, 1-200, default 100'),
  cursor: z.string().optional().describe('nextCursor from a previous call'),
}, ({ companyId, projectId, limit, cursor }) => wrap(async () => {
  const qs = new URLSearchParams();
  if (companyId) qs.set('companyId', companyId);
  if (projectId) qs.set('projectId', projectId);
  if (limit) qs.set('limit', String(limit));
  if (cursor) qs.set('cursor', cursor);
  const res = await client.get<{ data: Record<string, unknown>[]; nextCursor?: string | null }>(
    `/deals${qs.toString() ? `?${qs}` : ''}`);
  return {
    data: res.data.map((d) => ({
      id: d.id, title: d.title, companyId: d.companyId, projectId: d.projectId, stageId: d.stageId,
      amount: d.amount, currency: d.currency, expectedCloseDate: d.expectedCloseDate, ownerId: d.ownerId,
      lostReason: d.lostReason, customFields: d.customFields ?? {},
    })),
    // Surfaced rather than dropped: a truncated list that looks complete is worse
    // than a longer answer.
    nextCursor: res.nextCursor ?? null,
  };
}));

  server.tool('get_deal', 'One deal with every field, including customFields – reading a deal never needs a write', { dealId: z.string() },
  ({ dealId }) => wrap(() => client.get(`/deals/${dealId}`)));

  server.tool('list_users', 'Workspace users – the way to obtain a userId for ownerId on a company or deal', {},
  () => wrap(async () => {
  const res = await client.get<{ data: Record<string, unknown>[] }>('/users/lookup');
  return { data: res.data.map((u) => ({ id: u.id, name: u.name })) };
}));

  server.tool('list_notes', 'CRM notes on a company, contact, lead or deal, newest first, bodies rendered as plain text', {
  companyId: z.string().optional(), contactId: z.string().optional(), leadId: z.string().optional(), dealId: z.string().optional(),
  limit: z.number().optional().describe('Defaults to 20'),
}, ({ companyId, contactId, leadId, dealId, limit }) => wrap(async () => {
  if (!companyId && !contactId && !leadId && !dealId) throw new Error('One of companyId, contactId, leadId or dealId is required');
  const qs = new URLSearchParams();
  if (companyId) qs.set('companyId', companyId);
  if (contactId) qs.set('contactId', contactId);
  if (leadId) qs.set('leadId', leadId);
  if (dealId) qs.set('dealId', dealId);
  const res = await client.get<{ data: Record<string, unknown>[] }>(`/notes?${qs}`);
  return { data: res.data.slice(0, limit ?? 20).map((n) => ({
    id: n.id, companyId: n.companyId, contactId: n.contactId, leadId: n.leadId, dealId: n.dealId,
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

  server.tool('list_kb_spaces', 'Knowledge base spaces the token owner can read – the way to obtain spaceId for create_kb_page', {},
  () => wrap(async () => {
  const res = await client.get<{ data: Record<string, unknown>[] }>('/spaces');
  return { data: res.data.map((s) => ({
    id: s.id, name: s.name, projectId: s.projectId, visibility: s.visibility,
  })) };
}));

  server.tool('list_kb_pages', 'Pages of one space (see list_kb_spaces) – titles and ids, without the bodies', { spaceId: z.string() },
  ({ spaceId }) => wrap(async () => {
  const res = await client.get<{ data: Record<string, unknown>[] }>(`/spaces/${spaceId}/pages`);
  return { data: res.data.map((p) => ({
    id: p.id, spaceId: p.spaceId, parentId: p.parentId, title: p.title,
    published: p.published, isTemplate: p.isTemplate, updatedAt: p.updatedAt,
  })) };
}));

  server.tool('get_kb_page', 'One knowledge base page with its body as plain text', { pageId: z.string() },
  ({ pageId }) => wrap(async () => {
  const page = await client.get<Record<string, unknown>>(`/pages/${pageId}`);
  return { ...page, body: undefined, text: docToText(page.body) };
}));

  server.tool('update_kb_page', 'Rewrite a knowledge base page. The text replaces the body, so send the whole page – read it with get_kb_page first.', {
  pageId: z.string(), title: z.string().optional(), text: z.string().optional(),
}, ({ pageId, title, text: body }) => wrap(() => client.patch(`/pages/${pageId}`, {
  ...(title === undefined ? {} : { title }),
  ...(body === undefined ? {} : { body: textToDoc(body) }),
})));

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
// create_task, update_task, upsert_task and add_task_link live in tasks.ts.
  server.tool('update_task_status', 'Change a task status (statusId from get_project_schema); update_task changes the status together with the rest of the card', { taskId: z.string(), statusId: z.string() },
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

  server.tool('create_note', 'Create a CRM note on a company, contact, lead or deal (line breaks are preserved; blank line = new paragraph)', {
  companyId: z.string().optional(), contactId: z.string().optional(), leadId: z.string().optional(), dealId: z.string().optional(), text: z.string(),
}, ({ companyId, contactId, leadId, dealId, text: body }) => wrap(async () => {
  if (!companyId && !contactId && !leadId && !dealId) throw new Error('One of companyId, contactId, leadId or dealId is required');
  return client.post('/notes', { companyId, contactId, leadId, dealId, body: textToDoc(body) });
}));

  server.tool('update_note', 'Rewrite a note (see list_notes for noteId). The text replaces the body, so send the whole note, not a fragment – this is how a card whose facts moved into fields gets trimmed, or a stale one superseded.', {
  noteId: z.string(), text: z.string(),
  pinned: z.boolean().optional().describe('Keep it at the top of the record'),
}, ({ noteId, text: body, pinned }) => wrap(() => client.patch(`/notes/${noteId}`, {
  body: textToDoc(body), ...(pinned === undefined ? {} : { pinned }),
})));

  server.tool('create_company', 'Create a CRM company. Refuses a name or domain that already exists – update the existing record instead of doubling it.', {
  name: z.string(), domain: z.string().optional(), status: z.enum(COMPANY_STATUSES).optional().describe('Defaults to lead'),
  ownerId: z.string().optional().describe('Who owns the relationship (see list_users)'),
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
  ownerId: z.string().optional().describe('Who owns the relationship (see list_users)'),
  billingEmail: z.string().optional(), defaultCurrency: z.string().length(3).optional(), paymentTermsDays: z.number().int().optional(),
  customFields: z.record(z.string(), z.unknown()).optional().describe('Keyed by custom field key (see list_custom_fields); null clears one'),
}, ({ companyId, ...patch }) => wrap(() => client.patch(`/companies/${companyId}`, patch)));

  server.tool('update_contact', 'Update a contact. customFields merge by key.', {
  contactId: z.string(),
  firstName: z.string().optional(), lastName: z.string().optional(), email: z.string().optional(),
  phone: z.string().optional(), position: z.string().optional(), isPrimary: z.boolean().optional(),
  customFields: z.record(z.string(), z.unknown()).optional().describe('Keyed by custom field key; null clears one'),
}, ({ contactId, ...patch }) => wrap(() => client.patch(`/contacts/${contactId}`, patch)));

  server.tool('create_lead', 'Create an unqualified sales lead linked to an existing company', {
  companyId: z.string(), title: z.string(), product: z.string().optional(),
  contactId: z.string().optional(), status: z.enum(WRITABLE_LEAD_STATUSES).optional(),
  score: z.number().int().min(0).max(100).optional(), signal: z.string().optional(),
  painSignal: z.string().optional(), whyFit: z.string().optional(), whyNow: z.string().optional(),
  evidence: z.string().optional(), sourceUrl: z.string().optional(), opener: z.string().optional(),
  caution: z.string().optional(), ownerId: z.string().optional(),
}, (args) => wrap(() => client.post('/leads', args)));

  server.tool('update_lead', 'Update a lead lifecycle or its qualification notes', {
  leadId: z.string(), status: z.enum(WRITABLE_LEAD_STATUSES).optional(), contactId: z.string().nullable().optional(),
  title: z.string().optional(), product: z.string().optional(), score: z.number().int().min(0).max(100).optional(),
  signal: z.string().optional(), painSignal: z.string().optional(), evidence: z.string().optional(),
  whyFit: z.string().optional(), whyNow: z.string().optional(), sourceUrl: z.string().optional(),
  opener: z.string().optional(), caution: z.string().optional(), nurtureUntil: dateOnlySchema.nullable().optional(),
  disqualifiedReason: z.string().optional(), ownerId: z.string().optional(),
}, ({ leadId, ...patch }) => wrap(() => {
  if (patch.status === 'nurture' && !patch.nurtureUntil) {
    throw new Error('nurtureUntil is required when status is nurture');
  }
  return client.patch(`/leads/${leadId}`, patch);
}));

  server.tool('schedule_sales_activity', 'Schedule the next sales action for exactly one lead or deal', {
  leadId: z.string().optional(), dealId: z.string().optional(), type: z.enum(SALES_ACTIVITY_TYPES),
  dueAt: z.string().describe('ISO date-time'), channel: z.string().optional(),
  subject: z.string().optional(), context: z.string().optional(), ownerId: z.string().optional(),
  templateId: z.string().optional().describe('Optional reusable message template; placeholders are rendered by the API'),
}, (args) => wrap(async () => {
  if ((args.leadId ? 1 : 0) + (args.dealId ? 1 : 0) !== 1) throw new Error('Exactly one of leadId or dealId is required');
  return client.post('/sales-activities', args);
}));

  server.tool('save_sales_message_template', 'Create or update reusable sales copy. Supported variables: {{companyName}}, {{contactFirstName}}, {{contactName}}, {{ownerName}}, {{leadTitle}}.', {
  templateId: z.string().optional().describe('Omit to create; provide to update'),
  name: z.string().optional(), activityType: z.enum(SALES_ACTIVITY_TYPES).optional(),
  channel: z.string().nullable().optional(), subject: z.string().nullable().optional(),
  body: z.string().optional(), active: z.boolean().optional(),
}, ({ templateId, ...body }) => wrap(() => {
  if (!templateId && (!body.name || !body.activityType || !body.body)) {
    throw new Error('name, activityType and body are required when creating a template');
  }
  return templateId
    ? client.patch(`/sales-message-templates/${templateId}`, body)
    : client.post('/sales-message-templates', body);
}));

  const sequenceStep = z.object({
    delayDays: z.number().int().min(0).max(3650).optional(),
    templateId: z.string().nullable().optional(),
    activityType: z.enum(SALES_ACTIVITY_TYPES).optional(),
    channel: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
    context: z.string().nullable().optional(),
  });
  server.tool('save_sales_sequence', 'Create or update a sequence of manual sales actions. It schedules work but never sends email or LinkedIn messages.', {
  sequenceId: z.string().optional().describe('Omit to create; provide to update'),
  name: z.string().optional(), description: z.string().optional(), active: z.boolean().optional(),
  steps: z.array(sequenceStep).min(1).max(50).optional(),
}, ({ sequenceId, ...body }) => wrap(() => {
  if (!sequenceId && (!body.name || !body.steps?.length)) {
    throw new Error('name and steps are required when creating a sequence');
  }
  return sequenceId
    ? client.patch(`/sales-sequences/${sequenceId}`, body)
    : client.post('/sales-sequences', body);
}));

  server.tool('manage_sales_sequence', 'Enroll one lead/deal in a sequence or stop an active enrollment. Enrolling creates the first planned manual action.', {
  action: z.enum(['enroll', 'stop']),
  sequenceId: z.string().optional(),
  enrollmentId: z.string().optional(),
  leadId: z.string().optional(),
  dealId: z.string().optional(),
  contactId: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
  startAt: z.string().optional().describe('Optional ISO date-time used as the sequence start'),
}, ({ action, sequenceId, enrollmentId, ...body }) => wrap(() => {
  if (action === 'stop') {
    if (!enrollmentId) throw new Error('enrollmentId is required to stop a sequence');
    return client.post(`/sales-sequence-enrollments/${enrollmentId}/stop`, {});
  }
  if (!sequenceId) throw new Error('sequenceId is required to enroll');
  if ((body.leadId ? 1 : 0) + (body.dealId ? 1 : 0) !== 1) {
    throw new Error('Exactly one of leadId or dealId is required');
  }
  return client.post(`/sales-sequences/${sequenceId}/enroll`, body);
}));

  server.tool('update_sales_activity', 'Edit a planned sales activity before it is completed or cancelled', {
  activityId: z.string(), type: z.enum(SALES_ACTIVITY_TYPES).optional(),
  dueAt: z.string().describe('ISO date-time').optional(), channel: z.string().nullable().optional(),
  subject: z.string().nullable().optional(), context: z.string().nullable().optional(),
  ownerId: z.string().nullable().optional(),
}, ({ activityId, ...patch }) => wrap(() => client.patch(`/sales-activities/${activityId}`, patch)));

  server.tool('complete_sales_activity', 'Complete a planned sales activity and optionally schedule its follow-up in the same action', {
  activityId: z.string(), outcome: z.string().optional(), leadStatus: z.enum(LEAD_ACTIVITY_OUTCOME_STATUSES).optional(),
  nurtureUntil: dateOnlySchema.optional().describe('Required when leadStatus is nurture; independent of follow-up timing'),
  nextActivity: z.object({
    type: z.enum(SALES_ACTIVITY_TYPES), dueAt: z.string(), channel: z.string().optional(),
    subject: z.string().optional(), context: z.string().optional(),
  }).optional(),
}, ({ activityId, ...body }) => wrap(async () => {
  if (body.nextActivity && (
    body.leadStatus === 'nurture'
    || body.leadStatus === 'disqualified'
    || body.leadStatus === 'no_response'
  )) {
    throw new Error('Nurture and terminal lead statuses cannot have a follow-up activity');
  }
  if (body.leadStatus === 'nurture' && !body.nurtureUntil) {
    throw new Error('nurtureUntil is required when leadStatus is nurture');
  }
  return client.post(`/sales-activities/${activityId}/complete`, body);
}));

  server.tool('cancel_sales_activity', 'Cancel a planned sales activity that is no longer needed', {
  activityId: z.string(),
}, ({ activityId }) => wrap(() => client.post(`/sales-activities/${activityId}/cancel`, {})));

  server.tool('convert_lead', 'Convert an engaged lead into a qualified deal while preserving its history and next action', {
  leadId: z.string(), stageId: z.string().optional(), title: z.string().optional(),
  amount: z.number().min(0).optional(), currency: z.string().length(3).optional(),
  expectedCloseDate: z.string().optional(),
}, ({ leadId, ...body }) => wrap(() => client.post(`/leads/${leadId}/convert`, body)));

  server.tool('update_deal', 'Update a deal – amount, dates, owner, linked project, custom fields. customFields merge by key. Use move_deal to change the stage.', {
  dealId: z.string(),
  title: z.string().optional(), amount: z.number().min(0).nullable().optional(), currency: z.string().length(3).optional(),
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
  ownerId: z.string().optional().describe('Who is responsible for the deal (see list_users)'),
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

  // Project structure, task cards and the repeatable key-based write, which
  // need enough of their own machinery (name resolution, fingerprints) to live
  // beside the catalog rather than in it.
  registerTaskTools(server, client);

  return server;
}
