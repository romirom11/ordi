#!/usr/bin/env node
/**
 * ordi MCP server (PRD §16). Exposes read + action tools over the ordi REST API.
 * The agent authenticates with an API token; its permissions equal the token's
 * scope, so "the agent sees finance" is resolved exactly like a human: by the
 * owning user's role and the token scope. Destructive ops (delete/cancel) are
 * intentionally NOT exposed. All actions are recorded in activity as actor=agent.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { OrdiClient } from './client';

const baseUrl = process.env.ORDI_API_URL ?? 'http://localhost:3000';
const token = process.env.ORDI_API_TOKEN ?? '';
if (!token) {
  console.error('ORDI_API_TOKEN is required');
  process.exit(1);
}
const client = new OrdiClient({ baseUrl, token });

const server = new McpServer({ name: 'ordi', version: '1.0.0' });

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
function wrap<T>(fn: () => Promise<T>) {
  return fn().then(text).catch((e: Error) => ({ isError: true, content: [{ type: 'text' as const, text: e.message }] }));
}

// ── Read tools ──
server.tool('search', 'Search companies, tasks, invoices and KB pages', { query: z.string() },
  ({ query }) => wrap(() => client.get(`/search?q=${encodeURIComponent(query)}`)));

server.tool('get_company_overview', 'Company metrics: projects, tasks, and (if permitted) receivables', { companyId: z.string() },
  ({ companyId }) => wrap(() => client.get(`/companies/${companyId}/overview`)));

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
}, ({ projectId, title, priority }) => wrap(() => client.post('/tasks', { projectId, title, priority: priority ?? 'none', assigneeIds: [], labelIds: [] })));

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

server.tool('move_deal', 'Move a deal to a stage', { dealId: z.string(), stageId: z.string(), lostReason: z.string().optional() },
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ordi MCP server running on stdio');
}
main().catch((e) => { console.error(e); process.exit(1); });
