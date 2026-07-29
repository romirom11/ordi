/**
 * OpenAPI 3.1 document for the ordi REST API (PRD §15.1). Built statically at
 * module load from the shared Zod input schemas. Served publicly at
 * /api/docs/openapi.json with a self-contained HTML browser at /api/docs.
 * Responses are deliberately loosely typed: the source of truth for response
 * shapes is the handlers; this doc is the contract surface for MCP/integrations.
 */
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  companyInputSchema, contactInputSchema, dealInputSchema, projectInputSchema,
  leadInputSchema, salesActivityInputSchema, salesActivityUpdateSchema,
  salesActivityCompleteSchema, salesActivityCancelSchema, researchImportSchema,
  salesMessageTemplateInputSchema, salesMessageTemplateUpdateSchema,
  salesSequenceInputSchema, salesSequenceUpdateSchema, salesSequenceEnrollSchema, salesSequenceStopSchema,
  taskInputSchema, commentInputSchema, cycleInputSchema, spaceInputSchema,
  pageInputSchema, timeEntryInputSchema, invoiceInputSchema, quoteInputSchema,
  paymentInputSchema, expenseInputSchema, employeeInputSchema, leaveRequestInputSchema,
  jobOpeningInputSchema, applicantInputSchema, webhookSubscriptionInputSchema, loginSchema,
} from '@ordi/shared';

const SCHEMAS = {
  CompanyInput: companyInputSchema,
  ContactInput: contactInputSchema,
  DealInput: dealInputSchema,
  LeadInput: leadInputSchema,
  SalesActivityInput: salesActivityInputSchema,
  SalesActivityUpdate: salesActivityUpdateSchema,
  SalesActivityComplete: salesActivityCompleteSchema,
  SalesActivityCancel: salesActivityCancelSchema,
  ResearchImportInput: researchImportSchema,
  SalesMessageTemplateInput: salesMessageTemplateInputSchema,
  SalesMessageTemplateUpdate: salesMessageTemplateUpdateSchema,
  SalesSequenceInput: salesSequenceInputSchema,
  SalesSequenceUpdate: salesSequenceUpdateSchema,
  SalesSequenceEnrollInput: salesSequenceEnrollSchema,
  SalesSequenceStopInput: salesSequenceStopSchema,
  ProjectInput: projectInputSchema,
  TaskInput: taskInputSchema,
  CommentInput: commentInputSchema,
  CycleInput: cycleInputSchema,
  SpaceInput: spaceInputSchema,
  PageInput: pageInputSchema,
  TimeEntryInput: timeEntryInputSchema,
  InvoiceInput: invoiceInputSchema,
  QuoteInput: quoteInputSchema,
  PaymentInput: paymentInputSchema,
  ExpenseInput: expenseInputSchema,
  EmployeeInput: employeeInputSchema,
  LeaveRequestInput: leaveRequestInputSchema,
  JobOpeningInput: jobOpeningInputSchema,
  ApplicantInput: applicantInputSchema,
  WebhookSubscriptionInput: webhookSubscriptionInputSchema,
  LoginInput: loginSchema,
} as const;

type SchemaName = keyof typeof SCHEMAS;

interface OpSpec {
  summary: string;
  /** required permission; null = public / session-only. */
  permission?: string | null;
  /** components schema name for the request body. */
  body?: SchemaName | 'free';
  tag: string;
}

const ENVELOPE = {
  type: 'object',
  description: 'Generic response envelope. Lists return {data, nextCursor}; single resources return the entity; errors return {error:{code,message,details}}.',
} as const;

function idParams(path: string): object[] {
  const params: object[] = [];
  for (const m of path.matchAll(/\{([^}]+)\}/g)) {
    params.push({
      name: m[1], in: 'path', required: true, schema: { type: 'string' },
    });
  }
  return params;
}

function op(spec: OpSpec): Record<string, unknown> {
  const o: Record<string, unknown> = {
    summary: spec.summary,
    tags: [spec.tag],
    responses: {
      '200': { description: 'Success', content: { 'application/json': { schema: ENVELOPE } } },
      '400': { description: 'Validation error' },
      '401': { description: 'Not authenticated' },
      '403': { description: 'Missing permission' },
      '404': { description: 'Not found (also returned for resources outside access scope)' },
      '409': { description: 'Version conflict' },
      '422': { description: 'Domain rule violation' },
    },
  };
  if (spec.permission !== undefined) {
    o['x-permission'] = spec.permission;
    o.security = spec.permission === null ? [] : [{ cookieAuth: [] }, { bearerAuth: [] }];
  } else {
    o.security = [{ cookieAuth: [] }, { bearerAuth: [] }];
  }
  if (spec.body) {
    o.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: spec.body === 'free' ? { type: 'object' } : { $ref: `#/components/schemas/${spec.body}` },
        },
      },
    };
  }
  return o;
}

/** [path, method, summary, permission, body?, tag] */
type Row = [string, 'get' | 'post' | 'patch' | 'delete', string, string | null, (SchemaName | 'free' | undefined)?, string?];

function crud(base: string, tag: string, domain: string, input?: SchemaName, opts?: { create?: string; del?: string }): Row[] {
  const read = `${domain}.read`;
  const write = `${domain}.write`;
  return [
    [`/${base}`, 'get', `List ${base}`, read, undefined, tag],
    [`/${base}`, 'post', `Create ${base.replace(/s$/, '')}`, opts?.create ?? write, input, tag],
    [`/${base}/{id}`, 'get', `Get ${base.replace(/s$/, '')}`, read, undefined, tag],
    [`/${base}/{id}`, 'patch', `Update ${base.replace(/s$/, '')}`, write, input, tag],
    [`/${base}/{id}`, 'delete', `Delete ${base.replace(/s$/, '')}`, opts?.del ?? `${domain}.delete`, undefined, tag],
  ];
}

const ROWS: Row[] = [
  // core / auth
  ['/auth/login', 'post', 'Log in (session cookie; TOTP when enabled)', null, 'LoginInput', 'core'],
  ['/auth/logout', 'post', 'Log out', null, undefined, 'core'],
  ['/auth/tokens', 'get', 'List my API tokens', null, undefined, 'core'],
  ['/auth/tokens', 'post', 'Create API token (shown once)', null, 'free', 'core'],
  ['/auth/tokens/{id}', 'delete', 'Revoke API token', null, undefined, 'core'],
  ['/auth/totp', 'get', 'TOTP status for the current user', null, undefined, 'core'],
  ['/auth/totp/setup', 'post', 'Generate a new TOTP secret (pending confirmation)', null, undefined, 'core'],
  ['/auth/totp/enable', 'post', 'Confirm code and enable TOTP', null, 'free', 'core'],
  ['/auth/totp/disable', 'post', 'Confirm code and disable TOTP', null, 'free', 'core'],
  ['/me', 'get', 'Current profile, permissions and memberships', null, undefined, 'core'],
  ['/users', 'get', 'List users', 'users.manage', undefined, 'core'],
  ['/roles', 'get', 'List roles and permissions', 'roles.manage', undefined, 'core'],
  ['/search', 'get', 'Global search', null, undefined, 'core'],
  ['/notifications', 'get', 'List notifications', null, undefined, 'core'],
  ['/audit', 'get', 'Global audit feed', 'audit.read', undefined, 'core'],
  ['/saved-views', 'get', 'List saved views', null, undefined, 'core'],
  ['/custom-fields', 'get', 'List custom field definitions', null, undefined, 'core'],
  ['/attachments/presign', 'post', 'Presign an attachment upload', null, 'free', 'core'],
  ['/attachments/register', 'post', 'Register an uploaded file (returns a signed embeddable src)', null, 'free', 'core'],
  ['/files/{id}/{token}', 'get', 'Fetch a file by its signed link (no session required)', null, undefined, 'core'],
  ['/dashboard', 'get', 'Personal dashboard', null, undefined, 'core'],
  ['/webhooks', 'get', 'List webhook subscriptions', 'integrations.manage', undefined, 'integrations'],
  ['/webhooks', 'post', 'Create webhook subscription', 'integrations.manage', 'WebhookSubscriptionInput', 'integrations'],
  ['/webhooks/{id}', 'delete', 'Delete webhook subscription', 'integrations.manage', undefined, 'integrations'],
  ['/dlq', 'get', 'List dead-lettered events', 'audit.read + settings.manage', undefined, 'core'],
  ['/dlq/{id}/replay', 'post', 'Replay a dead-lettered event', 'audit.read + settings.manage', undefined, 'core'],
  ['/dlq/reprocess', 'post', 'Re-run an already processed event for one consumer', 'audit.read + settings.manage', 'free', 'core'],

  // crm
  ...crud('companies', 'crm', 'crm', 'CompanyInput'),
  ['/companies/{id}/overview', 'get', 'Company 360 overview', 'crm.read', undefined, 'crm'],
  ...crud('contacts', 'crm', 'crm', 'ContactInput'),
  ...crud('leads', 'crm', 'crm', 'LeadInput'),
  ['/leads/import/preview', 'post', 'Preview structured prospect research import', 'crm.read', 'ResearchImportInput', 'crm'],
  ['/leads/import', 'post', 'Import structured prospect research', 'crm.write', 'ResearchImportInput', 'crm'],
  ['/leads/{id}/convert', 'post', 'Convert engaged lead to deal', 'crm.write + deals.write', 'free', 'crm'],
  ...crud('deals', 'crm', 'deals', 'DealInput', { create: 'deals.write' }),
  ['/deals/{id}/move', 'post', 'Move deal to another stage', 'deals.write', 'free', 'crm'],
  ['/deal-stages', 'get', 'List deal stages', 'deals.read', undefined, 'crm'],
  ['/sales-work', 'get', 'Due sales work queues', 'crm.read', undefined, 'crm'],
  ['/sales-activities', 'get', 'List sales activities', 'crm.read or deals.read', undefined, 'crm'],
  ['/sales-activities', 'post', 'Schedule sales activity', 'crm.write or deals.write', 'SalesActivityInput', 'crm'],
  ['/sales-activities/{id}', 'patch', 'Edit a planned sales activity', 'crm.write or deals.write', 'SalesActivityUpdate', 'crm'],
  ['/sales-activities/{id}/complete', 'post', 'Complete activity and optionally schedule next', 'crm.write or deals.write', 'SalesActivityComplete', 'crm'],
  ['/sales-activities/{id}/cancel', 'post', 'Cancel a planned sales activity', 'crm.write or deals.write', 'SalesActivityCancel', 'crm'],
  ['/sales-message-templates', 'get', 'List sales message templates', 'crm.read', undefined, 'crm'],
  ['/sales-message-templates', 'post', 'Create sales message template', 'crm.write', 'SalesMessageTemplateInput', 'crm'],
  ['/sales-message-templates/{id}', 'patch', 'Update sales message template', 'crm.write', 'SalesMessageTemplateUpdate', 'crm'],
  ['/sales-sequences', 'get', 'List sales sequences', 'crm.read', undefined, 'crm'],
  ['/sales-sequences', 'post', 'Create sales sequence', 'crm.write', 'SalesSequenceInput', 'crm'],
  ['/sales-sequences/{id}', 'patch', 'Update sales sequence', 'crm.write', 'SalesSequenceUpdate', 'crm'],
  ['/sales-sequences/{id}/enroll', 'post', 'Enroll a lead or deal in a manual-action sequence', 'crm.write or deals.write', 'SalesSequenceEnrollInput', 'crm'],
  ['/sales-sequence-enrollments', 'get', 'List sequence history for a lead or deal', 'crm.read or deals.read', undefined, 'crm'],
  ['/sales-sequence-enrollments/{id}/stop', 'post', 'Stop an active sales sequence', 'crm.write or deals.write', 'SalesSequenceStopInput', 'crm'],
  ['/notes', 'post', 'Create CRM note', 'crm.write', 'free', 'crm'],
  ['/export/companies.csv', 'get', 'Export companies as CSV', 'crm.export', undefined, 'crm'],
  ['/export/contacts.csv', 'get', 'Export contacts as CSV', 'crm.export', undefined, 'crm'],
  ['/import/companies', 'post', 'Import companies from CSV (supports dryRun)', 'crm.write', 'free', 'crm'],
  ['/import/contacts', 'post', 'Import contacts from CSV (supports dryRun)', 'crm.write', 'free', 'crm'],

  // projects & tasks
  ...crud('projects', 'projects', 'projects', 'ProjectInput', { create: 'projects.create' }),
  ['/projects/{id}/members', 'get', 'List project members', 'projects.read', undefined, 'projects'],
  ['/project-types', 'get', 'List project types', 'projects.read', undefined, 'projects'],
  ['/task-statuses', 'get', 'List task statuses for a project', 'projects.read', undefined, 'projects'],
  ...crud('tasks', 'projects', 'projects', 'TaskInput', { create: 'projects.write', del: 'projects.write' }),
  ['/tasks/{id}/move', 'post', 'Move task (status/position)', 'projects.write', 'free', 'projects'],
  ['/tasks/{id}/comments', 'get', 'List task comments', 'projects.read', undefined, 'projects'],
  ['/tasks/{id}/comments', 'post', 'Add task comment', 'projects.write', 'CommentInput', 'projects'],
  ['/me/tasks', 'get', 'My assigned tasks', null, undefined, 'projects'],
  ['/cycles', 'get', 'List cycles for a project', 'projects.read', undefined, 'projects'],
  ['/cycles', 'post', 'Create cycle', 'projects.write', 'CycleInput', 'projects'],
  ['/cycles/{id}/complete', 'post', 'Complete a cycle (roll open tasks over)', 'projects.write', 'free', 'projects'],
  ['/labels', 'get', 'List labels (?scope=task|project)', 'projects.read', undefined, 'projects'],
  ['/intake', 'get', 'List intake items', 'projects.read', undefined, 'projects'],
  ['/intake/{id}/accept', 'post', 'Accept intake item into a task', 'projects.write', 'free', 'projects'],
  ['/intake/{id}/decline', 'post', 'Decline intake item', 'projects.write', 'free', 'projects'],
  ['/export/tasks.csv', 'get', 'Export tasks as CSV', 'projects.export', undefined, 'projects'],
  ['/import/tasks', 'post', 'Import tasks from CSV (supports dryRun)', 'projects.create', 'free', 'projects'],

  // kb
  ['/spaces', 'get', 'List spaces', 'kb.read', undefined, 'kb'],
  ['/spaces', 'post', 'Create space', 'kb.manage_spaces', 'SpaceInput', 'kb'],
  ['/pages', 'get', 'Page tree for a space', 'kb.read', undefined, 'kb'],
  ['/pages', 'post', 'Create page', 'kb.write', 'PageInput', 'kb'],
  ['/pages/{id}', 'get', 'Get page', 'kb.read', undefined, 'kb'],
  ['/pages/{id}', 'patch', 'Update page (versioned)', 'kb.write', 'free', 'kb'],
  ['/pages/{id}/versions', 'get', 'Page version history', 'kb.read', undefined, 'kb'],

  // time
  ['/time', 'get', 'List time entries', 'time.track', undefined, 'time'],
  ['/time', 'post', 'Create time entry', 'time.track', 'TimeEntryInput', 'time'],
  ['/time/{id}', 'patch', 'Update time entry', 'time.track', 'free', 'time'],
  ['/time/{id}', 'delete', 'Delete time entry', 'time.track', undefined, 'time'],
  ['/time/timer/start', 'post', 'Start the running timer', 'time.track', 'free', 'time'],
  ['/time/timer/stop', 'post', 'Stop the running timer into an entry', 'time.track', undefined, 'time'],
  ['/time/reports', 'get', 'Time reports', 'time.read_all', undefined, 'time'],
  ['/export/time.csv', 'get', 'Export time entries as CSV', 'time.read_all', undefined, 'time'],

  // finance
  ...crud('invoices', 'finance', 'finance', 'InvoiceInput'),
  ['/invoices/{id}/send', 'post', 'Send invoice by email', 'finance.send', 'free', 'finance'],
  ['/invoices/from-time', 'post', 'Create invoice from unbilled time', 'finance.write', 'free', 'finance'],
  ...crud('quotes', 'finance', 'finance', 'QuoteInput'),
  ['/quotes/{id}/send', 'post', 'Send quote by email', 'finance.send', 'free', 'finance'],
  ['/quotes/{id}/convert', 'post', 'Convert accepted quote to invoice', 'finance.write', undefined, 'finance'],
  ['/invoices/{id}/payments', 'post', 'Record payment', 'finance.payments', 'PaymentInput', 'finance'],
  ['/expenses', 'get', 'List expenses', 'finance.read', undefined, 'finance'],
  ['/expenses', 'post', 'Create expense', 'finance.write', 'ExpenseInput', 'finance'],
  ['/finance/dashboard', 'get', 'Finance dashboard', 'finance.read', undefined, 'finance'],
  ['/finance/profitability', 'get', 'Profitability (project/client/labor)', 'finance.read_costs', undefined, 'finance'],
  ['/export/invoices.csv', 'get', 'Export invoices as CSV', 'finance.export', undefined, 'finance'],

  // people
  ...crud('employees', 'people', 'people', 'EmployeeInput'),
  ['/leave-requests', 'get', 'List leave requests', 'people.read', undefined, 'people'],
  ['/leave-requests', 'post', 'Create leave request', null, 'LeaveRequestInput', 'people'],
  ['/leave-requests/{id}/approve', 'post', 'Approve leave request', 'people.approve_leave', 'free', 'people'],
  ['/leave-requests/{id}/reject', 'post', 'Reject leave request', 'people.approve_leave', 'free', 'people'],
  ['/job-openings', 'get', 'List job openings', 'people.recruit', undefined, 'people'],
  ['/job-openings', 'post', 'Create job opening', 'people.recruit', 'JobOpeningInput', 'people'],
  ['/applicants', 'get', 'List applicants', 'people.recruit', undefined, 'people'],
  ['/applicants', 'post', 'Create applicant', 'people.recruit', 'ApplicantInput', 'people'],
  ['/applicants/{id}/move', 'post', 'Move applicant between stages', 'people.recruit', 'free', 'people'],

  // integrations
  ['/integrations/git/connections', 'get', 'List git connections', 'integrations.manage', undefined, 'integrations'],
  ['/integrations/git/repositories', 'get', 'List git repositories', 'integrations.manage', undefined, 'integrations'],
];

/** `people.delete` etc. don't all exist; fix up rows whose delete permission has no dedicated `<domain>.delete`. */
const PERMISSION_FIXUPS: Record<string, string> = {
  'projects.delete': 'projects.delete',
  'people.delete': 'people.write',
  'time.delete': 'time.track',
};

export function buildOpenApiDoc(): object {
  const components: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    components[name] = zodToJsonSchema(schema as never, { target: 'openApi3', $refStrategy: 'none' });
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const row of ROWS) {
    const [path, method, summary, permRaw, body, tag] = row;
    const permission = permRaw && PERMISSION_FIXUPS[permRaw] ? PERMISSION_FIXUPS[permRaw]! : permRaw;
    const entry = paths[path] ?? (paths[path] = {});
    const built = op({ summary, permission, body, tag: tag ?? 'core' });
    const params = idParams(path);
    if (params.length) built.parameters = params;
    entry[method] = built;
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'ordi API',
      version: '1.0.0',
      description: 'REST API for the ordi workspace (PRD §15). Base path /api/v1. '
        + 'Auth: session cookie or Bearer API token. Every route is guarded by a permission '
        + '(x-permission) or is public. List endpoints use cursor pagination ({data, nextCursor}). '
        + 'Errors: {error:{code,message,details}}. Mutations carry an optional version for optimistic locking.',
    },
    servers: [{ url: '/api/v1' }],
    tags: [
      { name: 'core' }, { name: 'crm' }, { name: 'projects' }, { name: 'kb' },
      { name: 'time' }, { name: 'finance' }, { name: 'people' }, { name: 'integrations' },
    ],
    components: {
      schemas: components,
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'ordi_session' },
        bearerAuth: { type: 'http', scheme: 'bearer' },
      },
    },
    paths,
  };
}

/** Built once at module load; the doc is static. */
export const openApiDoc = buildOpenApiDoc();

/** Self-contained docs page (no CDN): fetches openapi.json and renders grouped endpoints. */
export const docsHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ordi API docs</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0 auto; max-width: 960px; padding: 24px; line-height: 1.5; }
  h1 { font-size: 22px; } h2 { font-size: 17px; margin-top: 28px; text-transform: uppercase; letter-spacing: .04em; }
  .ep { display: flex; gap: 10px; align-items: baseline; padding: 6px 8px; border-radius: 6px; flex-wrap: wrap; }
  .ep:nth-child(odd) { background: rgba(127,127,127,.07); }
  .method { font-weight: 700; font-family: ui-monospace, monospace; width: 58px; flex: none; }
  .m-get { color: #16a34a; } .m-post { color: #2563eb; } .m-patch { color: #d97706; } .m-delete { color: #dc2626; }
  .path { font-family: ui-monospace, monospace; flex: none; }
  .summary { opacity: .8; }
  .perm { font-family: ui-monospace, monospace; font-size: 12px; opacity: .65; margin-left: auto; }
  input { width: 100%; padding: 8px 10px; margin: 12px 0; border-radius: 6px; border: 1px solid rgba(127,127,127,.4); font: inherit; background: transparent; color: inherit; }
  a { color: inherit; }
</style>
</head>
<body>
<h1>ordi API</h1>
<p>Base path <code>/api/v1</code>. Raw spec: <a href="/api/docs/openapi.json">openapi.json</a></p>
<input id="filter" placeholder="Filter endpoints..." autocomplete="off">
<div id="root">Loading…</div>
<script>
(function () {
  var root = document.getElementById('root');
  var filter = document.getElementById('filter');
  var groups = {};
  function render(q) {
    q = (q || '').toLowerCase();
    root.textContent = '';
    Object.keys(groups).forEach(function (tag) {
      var eps = groups[tag].filter(function (e) {
        return !q || (e.method + ' ' + e.path + ' ' + e.summary + ' ' + (e.permission || '')).toLowerCase().indexOf(q) !== -1;
      });
      if (!eps.length) return;
      var h = document.createElement('h2'); h.textContent = tag; root.appendChild(h);
      eps.forEach(function (e) {
        var row = document.createElement('div'); row.className = 'ep';
        var m = document.createElement('span'); m.className = 'method m-' + e.method; m.textContent = e.method.toUpperCase();
        var p = document.createElement('span'); p.className = 'path'; p.textContent = e.path;
        var s = document.createElement('span'); s.className = 'summary'; s.textContent = e.summary || '';
        var perm = document.createElement('span'); perm.className = 'perm'; perm.textContent = e.permission ? e.permission : 'public/session';
        row.appendChild(m); row.appendChild(p); row.appendChild(s); row.appendChild(perm);
        root.appendChild(row);
      });
    });
    if (!root.children.length) root.textContent = 'No endpoints match.';
  }
  fetch('/api/docs/openapi.json').then(function (r) { return r.json(); }).then(function (doc) {
    Object.keys(doc.paths).forEach(function (path) {
      Object.keys(doc.paths[path]).forEach(function (method) {
        var o = doc.paths[path][method];
        if (!o || !o.summary) return;
        var tag = (o.tags && o.tags[0]) || 'other';
        (groups[tag] = groups[tag] || []).push({
          path: path, method: method, summary: o.summary, permission: o['x-permission'],
        });
      });
    });
    render('');
  }).catch(function () { root.textContent = 'Failed to load openapi.json'; });
  filter.addEventListener('input', function () { render(filter.value); });
})();
</script>
</body>
</html>`;
