/**
 * What each MCP tool is, for the people and clients deciding whether to let
 * it run: a human title and whether it only reads, writes, or can destroy.
 *
 * The MCP server turns this into tool annotations (packages/mcp/src/annotations.ts)
 * and Settings → MCP lists the tools from it, so both stay in step with the
 * catalog. A test fails when a tool is registered without an entry here or an
 * entry outlives its tool.
 *
 * kind:
 * - read – changes nothing.
 * - write – creates records or edits fields; the next call can set them back.
 * - destructive – deletes something, replaces a whole text body, or sends
 *   something out of ordi that cannot be called back.
 *
 * idempotent: calling it twice with the same arguments leaves the same state
 * as calling it once. openWorld: it reaches past this ordi workspace (sends
 * email, fetches a url).
 */
export type McpToolKind = 'read' | 'write' | 'destructive';

export interface McpToolMeta {
  title: string;
  kind: McpToolKind;
  idempotent?: true;
  openWorld?: true;
}

export const MCP_TOOLS = {
  // ── Search and workspace ──
  search: { title: 'Search the workspace', kind: 'read' },
  list_users: { title: 'List workspace users', kind: 'read' },
  list_custom_fields: { title: 'List custom fields', kind: 'read' },
  create_custom_field: { title: 'Create a custom field', kind: 'write' },
  update_custom_field: { title: 'Edit a custom field', kind: 'write', idempotent: true },

  // ── Projects ──
  list_projects: { title: 'List projects', kind: 'read' },
  get_project_schema: { title: 'Get a project\'s statuses, types and fields', kind: 'read' },
  get_project_status: { title: 'Get a project\'s status', kind: 'read' },
  create_project: { title: 'Create a project', kind: 'write' },
  update_project: { title: 'Edit a project', kind: 'destructive', idempotent: true },
  create_workflow_status: { title: 'Add a task status', kind: 'write' },
  update_workflow_status: { title: 'Edit a task status', kind: 'write', idempotent: true },
  delete_workflow_status: { title: 'Delete a task status', kind: 'destructive' },
  create_milestone: { title: 'Create a milestone', kind: 'write' },
  update_milestone: { title: 'Edit a milestone', kind: 'write', idempotent: true },
  create_cycle: { title: 'Start a cycle', kind: 'write' },
  complete_cycle: { title: 'Complete a cycle', kind: 'write' },
  get_cycle_progress: { title: 'Get cycle progress', kind: 'read' },
  list_project_resources: { title: 'List project resources', kind: 'read' },
  add_project_resource: { title: 'Add a project resource', kind: 'write' },
  update_project_link: { title: 'Edit a project link', kind: 'write', idempotent: true },
  remove_project_resource: { title: 'Remove a project resource', kind: 'destructive' },
  list_project_secrets: { title: 'List project secrets', kind: 'read' },
  check_project_secret: { title: 'Check a project secret', kind: 'read' },

  // ── Tasks ──
  list_tasks: { title: 'List tasks', kind: 'read' },
  list_my_tasks: { title: 'List my tasks', kind: 'read' },
  get_task: { title: 'Get a task', kind: 'read' },
  create_task: { title: 'Create a task', kind: 'write' },
  update_task: { title: 'Rewrite a task', kind: 'destructive', idempotent: true },
  upsert_task: { title: 'Create or update a task by key', kind: 'write', idempotent: true },
  update_task_status: { title: 'Change a task\'s status', kind: 'write', idempotent: true },
  assign_task: { title: 'Set a task\'s assignees', kind: 'write', idempotent: true },
  add_task_link: { title: 'Add a link to a task', kind: 'write', idempotent: true },
  comment_on_task: { title: 'Comment on a task', kind: 'write' },
  ask_for_input: { title: 'Ask a person for input on a task', kind: 'write' },
  list_answered: { title: 'List answers to my questions', kind: 'read' },
  log_time: { title: 'Log time', kind: 'write' },
  upload_attachment: { title: 'Upload a file', kind: 'write', openWorld: true },
  rename_attachment: { title: 'Rename a file', kind: 'write', idempotent: true },

  // ── CRM ──
  list_companies: { title: 'List companies', kind: 'read' },
  get_company: { title: 'Get a company', kind: 'read' },
  get_company_overview: { title: 'Get a company overview', kind: 'read' },
  create_company: { title: 'Create a company', kind: 'write' },
  update_company: { title: 'Edit a company', kind: 'write', idempotent: true },
  list_contacts: { title: 'List contacts', kind: 'read' },
  get_contact: { title: 'Get a contact', kind: 'read' },
  create_contact: { title: 'Create a contact', kind: 'write' },
  update_contact: { title: 'Edit a contact', kind: 'write', idempotent: true },
  list_notes: { title: 'List CRM notes', kind: 'read' },
  create_note: { title: 'Create a CRM note', kind: 'write' },
  update_note: { title: 'Rewrite a CRM note', kind: 'destructive', idempotent: true },
  list_leads: { title: 'List leads', kind: 'read' },
  get_lead: { title: 'Get a lead', kind: 'read' },
  create_lead: { title: 'Create a lead', kind: 'write' },
  update_lead: { title: 'Edit a lead', kind: 'write', idempotent: true },
  convert_lead: { title: 'Convert a lead into a deal', kind: 'write' },
  list_deals: { title: 'List deals', kind: 'read' },
  get_deal: { title: 'Get a deal', kind: 'read' },
  list_deal_stages: { title: 'List pipeline stages', kind: 'read' },
  create_deal: { title: 'Create a deal', kind: 'write' },
  update_deal: { title: 'Edit a deal', kind: 'write', idempotent: true },
  move_deal: { title: 'Move a deal to a stage', kind: 'write', idempotent: true },
  get_sales_work: { title: 'Get the sales work queue', kind: 'read' },
  list_sales_activities: { title: 'List sales activities', kind: 'read' },
  schedule_sales_activity: { title: 'Schedule a sales activity', kind: 'write' },
  update_sales_activity: { title: 'Edit a sales activity', kind: 'write', idempotent: true },
  complete_sales_activity: { title: 'Complete a sales activity', kind: 'write' },
  cancel_sales_activity: { title: 'Cancel a sales activity', kind: 'write', idempotent: true },
  list_sales_playbooks: { title: 'List sales templates and sequences', kind: 'read' },
  save_sales_message_template: { title: 'Save a sales message template', kind: 'write' },
  save_sales_sequence: { title: 'Save a sales sequence', kind: 'write' },
  manage_sales_sequence: { title: 'Enroll in or stop a sales sequence', kind: 'write' },

  // ── Knowledge base ──
  list_kb_spaces: { title: 'List knowledge base spaces', kind: 'read' },
  list_kb_pages: { title: 'List knowledge base pages', kind: 'read' },
  find_kb_page: { title: 'Find a knowledge base page', kind: 'read' },
  get_kb_page: { title: 'Get a knowledge base page', kind: 'read' },
  create_kb_page: { title: 'Create a knowledge base page', kind: 'write' },
  update_kb_page: { title: 'Rewrite a knowledge base page', kind: 'destructive', idempotent: true },

  // ── Finance ──
  list_overdue_invoices: { title: 'List overdue invoices', kind: 'read' },
  get_receivables_aging: { title: 'Get receivables aging', kind: 'read' },
  list_unbilled_time: { title: 'List unbilled time', kind: 'read' },
  get_project_profitability: { title: 'Get project profitability', kind: 'read' },
  get_labor_cost: { title: 'Get labor cost', kind: 'read' },
  create_invoice_from_time: { title: 'Draft an invoice from unbilled time', kind: 'write' },
  create_invoice_from_project: { title: 'Draft an invoice from a project', kind: 'write' },
  send_invoice: { title: 'Email an invoice to the client', kind: 'destructive', openWorld: true },
  record_payment: { title: 'Record a received payment', kind: 'write' },
  create_quote: { title: 'Create a quote', kind: 'write' },

  // ── People ──
  get_team_availability: { title: 'Get team availability', kind: 'read' },
  list_pending_leave: { title: 'List pending leave requests', kind: 'read' },
  request_leave: { title: 'Request leave', kind: 'write' },
  approve_leave: { title: 'Approve a leave request', kind: 'write', idempotent: true },
  get_recruitment_pipeline: { title: 'Get the recruitment pipeline', kind: 'read' },
  create_job_opening: { title: 'Create a job opening', kind: 'write' },
  move_applicant: { title: 'Move an applicant to a stage', kind: 'write', idempotent: true },
} as const satisfies Record<string, McpToolMeta>;

export type McpToolName = keyof typeof MCP_TOOLS;

/** Tool names of one kind, in catalog order – what Settings → MCP lists. */
export function mcpToolsOfKind(...kinds: McpToolKind[]): McpToolName[] {
  return (Object.keys(MCP_TOOLS) as McpToolName[]).filter((name) => kinds.includes(MCP_TOOLS[name].kind));
}
