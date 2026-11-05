# Product requirements document: ordi

Agency operations platform: CRM, projects and tasks, knowledge base, time tracking, finance. References per module: Twenty (CRM, data customisation), Plane (projects, cycles, pages, integrations), Invoice Ninja (invoices, quotes, payments, reminders). The product is built production-ready from the start, with no intermediate MVP scope: every module described here is part of the 1.0 release.

Document version: 3.2. Product name: ordi. Sections based on research into the references are summarised in Appendix A (coverage map of Plane / Twenty / Invoice Ninja / Frappe HR / Productive). Changes in 3.2: CRM split into research leads and qualified deals; Work became the main working surface; sales activities, manual playbooks, the morning digest and durable email delivery are fixed as a product and operational contract. Changes in 3.1: resolved the contradiction around Resourcing; internal projects via nullable company_id + kind (no fictitious client); full custom field mechanics (5.5); redaction and a retention policy for sensitive audit records (14.4); optimistic locking via version (not updated_at); formal RPO/RTO and PITR (19.2); full specification of outbox event delivery (3.3).

---

## 1. Goal and purpose

### 1.1. Problem

The agency's operational data is scattered across unconnected tools: clients in a CRM, tasks in a tracker, documentation in a wiki, time in a timer, invoices in billing. Consequences: context switching, duplicated data, no end-to-end picture of "client → deal → project → tasks → time → invoice → payment", brittle glue code between third-party APIs, and no way to control access end to end (who sees finance, who sees a specific project).

### 1.2. Solution

One application with one database covering six domains:

1. **CRM**: leads, companies, contacts, the Work queue, sales activities, playbooks, deals, notes, history.
2. **Projects**: projects, tasks, cycles, relations, workflows, intake.
3. **Knowledge Base**: spaces, pages, versions, linking to projects.
4. **Time**: time tracking against tasks, rates, time billing.
5. **Finance**: quotes, invoices, payments, recurring invoices, reminders, expenses, cost and profitability.
6. **People (HR)**: employees, lifecycle, leave/absences, hiring, compensation as a cost rate.

Plus cross-cutting concerns: RBAC, git integrations, automations on the event bus, search, notifications, audit, MCP agent.

### 1.3. Key principles

- **One API as the single contract.** The web app, the desktop app (Tauri) and the MCP agent are equal clients of one REST API. Business logic lives only in domain services.
- **Modular domains.** Each domain is self-contained: its own slice of the schema, service, endpoints, events. Cross-module interaction: FKs in the DB, the event bus, shared contracts. A new domain does not modify existing ones.
- **RBAC as a cross-cutting layer.** Permissions are checked on the backend for every request; the UI only hides what is unavailable. Access is controlled at two levels: capabilities (permissions via roles) and resources (membership in projects/spaces).
- **Agent-first.** Every action available to a human is available to an agent via the API/MCP, within the permissions of its token.
- **Customisation without migrations.** Statuses, task types, project types, deal stages, custom fields, roles, templates: everything is configured through data, not code.
- **Minimalist UX.** Dense, keyboard-driven, command palette, peek panels, no visual noise.
- **Self-hosted** on Dokploy; the only external dependencies are SMTP and S3-compatible storage.

### 1.4. Scale

Single-tenant, up to 50 users (including guest access), up to ~1,000 clients, ~500 projects, ~50,000 tasks, ~10,000 invoices in total. The architecture is deliberately not optimised for more: the priority is ease of maintenance.

---

## 2. Technology stack

| Layer | Technology | Rationale |
|---|---|---|
| DB | PostgreSQL 16+ | JSONB, FTS, triggers, reliability |
| ORM / migrations | Drizzle ORM + drizzle-kit | Type safety, additive migrations |
| API | Hono (Node.js 22 LTS, TS) | Lightweight, typed routes, OpenAPI |
| Validation | Zod (shared schemas in packages/shared) | A single source of truth for the API, UI and MCP |
| Auth | Better Auth | Sessions, 2FA, Drizzle integration |
| Web | React 19 + Vite + TanStack Router/Query | Standard SPA |
| UI | shadcn/ui + Tailwind | Minimalism, full control |
| Rich text | Tiptap (JSON in the DB) | Tasks, notes, KB pages, comments |
| Desktop | Tauri 2 | The same frontend, native builds |
| MCP | TypeScript MCP SDK | Agent on top of the API |
| PDF | Typst (server-side rendering) | Invoices, quotes |
| Email | Nodemailer + SMTP | Sending documents and reminders |
| Files | S3-compatible (MinIO / R2) | Attachments, PDF artefacts |
| Queue | pg-boss on top of Postgres | Reminders, recurring jobs, webhooks, email; no Redis |
| Monorepo | pnpm workspaces + Turborepo | Shared packages, one CI |
| Deployment | Docker (api, web) on Dokploy | Existing infrastructure |

**Architectural boundaries.** The technologies below are left out not because they are bad, but because at the target scale and with solo maintenance their operational cost outweighs the benefit. For each one, a review trigger and a migration path that does not break the domain modules are recorded:

| Technology | Why not now | Review trigger | Migration path |
|---|---|---|---|
| Redis | pg-boss covers queues; a hot cache is not needed at these volumes; one fewer stateful service to look after (backups, versions, monitoring) | Horizontal scaling of the API: SSE fan-out across replicas, or a need for a cache | Redis pub/sub plugs in behind the EventBroadcaster interface; the queue stays on pg-boss or migrates to BullMQ |
| Microservices | The benefit of microservices: independent release cycles for several teams; the cost: distributed debugging, contract versioning, network failure modes. A solo operator pays the full cost with none of the benefit | Several teams with independent release cycles | The modular monolith already holds the domain boundaries: a module is extracted into a service along the existing contracts |
| GraphQL | REST+OpenAPI gives a typed client through code generation; a per-route guard is simpler than field-level authz (our RBAC is centralised); MCP, webhooks and public pages are naturally RESTful | Third parties needing flexible client-side queries | A GraphQL layer on top of the same domain services |
| Separate realtime server | SSE from the API is enough for cache invalidation and notifications; a separate WS process is one more deployment and one more authorisation layer | Co-editing/presence (CRDT) or thousands of concurrent connections | A WS service on top of the event bus |
| Kubernetes | Dokploy+Docker covers a single host; k8s is an orchestration tax with no need for orchestration | Multi-host / HA requirements | Compose services map to Helm 1:1 |

### 2.1. Monorepo

```
agency-os/
├── apps/
│   ├── api/          # Hono API, domain modules, pg-boss workers
│   ├── web/          # React SPA
│   └── desktop/      # Tauri wrapper for apps/web
├── packages/
│   ├── db/           # Drizzle schema, migrations
│   ├── shared/       # Zod schemas, types, permissions catalogue, constants
│   └── mcp/          # MCP server (API client)
├── docker/
└── turbo.json
```

---

## 3. Overall architecture

### 3.1. Layers

```
┌──────────┐ ┌───────────────┐ ┌───────────┐ ┌─────────────────┐
│ Web SPA  │ │ Desktop(Tauri)│ │ MCP agent │ │ Git providers   │
└────┬─────┘ └──────┬────────┘ └─────┬─────┘ │ (inbound hooks) │
     └──────────────┼────────────────┘       └───────┬─────────┘
                    ▼                                ▼
          ┌───────────────────────────────────────────────┐
          │              REST API (Hono)                  │
          │  auth → RBAC guard → validation → route       │
          └──────────────────────┬────────────────────────┘
                                 ▼
     ┌────────────────────────────────────────────────────┐
     │                 Domain modules                     │
     │ core │ crm │ projects │ kb │ time │ finance │ integ│
     └──────────────────────┬─────────────────────────────┘
                            ▼
                 ┌─────────────────────┐        ┌─────────┐
                 │ Drizzle → Postgres  │◄──────►│ pg-boss │
                 └─────────────────────┘        │ workers │
                                                └─────────┘
```

Layer rules (mandatory):

1. Clients contain no business logic and are not a source of permissions: RBAC lives on the backend, the UI only displays.
2. A domain module does not import another module's service directly: interaction goes through FKs, the event bus or read contracts in shared.
3. SQL only in domain services, via Drizzle.
4. Every route declares a required permission; every service method that works with a restricted-access resource calls a resource check (see section 4).

### 3.2. Domain module structure

```
projects/
├── schema.ts        # domain tables
├── service.ts       # business logic
├── access.ts        # domain resource checks (canAccessProject etc.)
├── routes.ts        # thin routes: guard → validation → service
├── events.ts        # published/subscribed events
├── automations.ts   # event handlers (e.g. git → status)
└── *.test.ts
```

### 3.3. Event bus (outbox)

An event is published in the same transaction as the data change (the `events` table): the event and the change are committed atomically, so an event cannot be lost when the data write succeeds. A separate worker (relay) reads unpublished events and hands them to handlers via pg-boss. A typed event catalogue lives in shared: each event carries `type`, `aggregate_type`, `aggregate_id` (e.g. project:KLD), `payload`, `occurred_at`.

**Delivery guarantee: at-least-once, not exactly-once.** The consequence is mandatory: all handlers are idempotent. Deduplication via the `processed_events (consumer, event_id)` table: before processing, a consumer checks whether it has already processed this event_id; a repeated delivery becomes a no-op. This is the baseline protection against reprocessing, rather than relying on "exactly once".

**Retry and dead-letter:** a failed handling attempt is retried with exponential backoff (e.g. 5 attempts: ~10s, 1min, 5min, 30min, 2h). Once the attempts are exhausted, the event moves to a dead-letter state (it is not lost), the error is logged and an alert is raised in monitoring. A poison event does not block the queue for others.

**Manual replay:** the admin area (audit.read + settings.manage) shows the dead-letter queue with error details; the replay action returns the event to processing (after the code/data has been fixed). An already processed event can also be re-run (e.g. after a handler bug fix): this is done by resetting the corresponding record in processed_events, a deliberate admin operation.

**Event ordering:** there is no global total order (it is expensive and not needed). Per-aggregate ordering is guaranteed: events with the same `aggregate_id` are processed strictly sequentially (serialised by aggregate key), different aggregates in parallel. Handlers do NOT rely on ordering across different aggregates. At agency scale, serialisation within an aggregate has no effect on throughput. (A cross-aggregate global order is deliberately not guaranteed; recorded in the trade-offs, 22.)

Key events: `deal.stage_changed`, `deal.won`, `project.completed`, `task.created`, `task.status_changed`, `task.assigned`, `comment.mentioned`, `cycle.completed`, `page.published`, `time.entry_created`, `quote.accepted`, `invoice.sent`, `invoice.viewed`, `invoice.overdue`, `payment.recorded`, `git.pr_opened`, `git.pr_merged`, `employee.onboarded`, `employee.exited`, `leave.requested`, `leave.decided`, `applicant.hired`.

Consumers: notifications, activity log, automations (section 13.3), external webhooks (the same retry/DLQ mechanics), SSE.

### 3.4. Realtime

SSE endpoint `/api/v1/stream`: the server pushes events filtered by the user's permissions (an event about a private project goes only to its members). The frontend invalidates the TanStack Query cache. Edit conflicts: optimistic locking via a separate monotonic numeric `version` field (int, starts at 1, incremented by a DB trigger on every UPDATE, independent of the clock). The client sends the version it knows with the mutation; a mismatch → 409 with the entity's current state for reloading. `updated_at` remains purely for display and sorting, never for concurrency control. Collaborative cursors/CRDT are not implemented: simultaneous editing of the same rich-text field is resolved by a "someone is editing" lock (an advisory lock for 60 s with a heartbeat) for KB pages and task descriptions.

---

## 4. RBAC: access model

A cross-cutting layer. It is designed before the domains, because all domains depend on it.

### 4.1. Two-level model

**Level 1: Permissions (what a user can do).** The permissions catalogue is fixed in code (shared); roles are configurable sets of permissions. A user has exactly one global role.

**Level 2: Resource access (which objects they can access).** Certain resources have their own access lists: projects (private/workspace) and KB spaces (private/workspace). Access to child entities is inherited from the resource: tasks, comments, time and pages are visible only to those who have access to the project/space.

The final authorisation rule for a request:

```
allowed = hasPermission(user.role, required_permission)
       AND (resource is unrestricted OR isResourceMember(user, resource))
```

### 4.2. Permissions catalogue

Format `domain.action`. The full catalogue (versioned in shared; the role editor UI is rendered from it):

| Domain | Permissions |
|---|---|
| crm | `crm.read`, `crm.write`, `crm.delete`, `crm.export` |
| deals | `deals.read`, `deals.write`, `deals.delete` |
| projects | `projects.read` (see workspace projects), `projects.create`, `projects.write` (settings of projects where the user is a member with the admin role), `projects.delete`, `projects.export` |
| kb | `kb.read`, `kb.write`, `kb.manage_spaces` |
| time | `time.track` (track your own time), `time.read_all` (see other people's time), `time.manage` (edit other people's entries, rates) |
| finance | `finance.read`, `finance.write` (creating/editing documents), `finance.send`, `finance.payments` (recording payments), `finance.delete`, `finance.settings` (tax rates, numbering, reminders), `finance.export`, `finance.read_costs` (cost, profitability, payroll costs) |
| people | `people.read`, `people.read_sensitive`, `people.read_compensation`, `people.write`, `people.manage_leave`, `people.approve_leave`, `people.recruit` |
| integrations | `integrations.manage` |
| settings | `settings.manage` (business details, templates, custom fields, types), `users.manage`, `roles.manage`, `audit.read` |

Security rule: an unknown permission = denied. Read is not implied by write: the sets are explicit.

### 4.3. Roles

Tables `roles` (id, name, description, is_system) and `role_permissions` (role_id, permission). System roles (not editable, is_system=true):

- **Owner**: all permissions; the last Owner cannot be removed.
- **Admin**: everything except managing Owners.

Preconfigured editable roles (seeded; an admin can change them or create their own through the role editor UI: a domain × action matrix):

- **Manager**: everything in crm/deals/projects/kb/time, including read_all; finance read+write+send without settings/delete.
- **Member**: crm.read, deals.read/write, projects.read/create, kb.read/write, time.track. Does not see finance at all: the section is absent from navigation, the endpoints return 403, financial fields (the deal amount is visible, but the "Invoices" tab in a project/client is hidden).
- **Finance**: crm.read, finance.* in full (including read_costs), projects.read, time.read_all (for time billing and cost), people.read_compensation granted selectively.
- **HR**: people.* in full, except read_compensation (granted separately and selectively); projects.read for onboarding tasks.
- **Guest** (external: a contractor or a client): no global permissions apart from implicit ones; sees only the projects and KB spaces they have been added to as a member, and within them: tasks read/write (configured on the membership), comments, their own time entries. CRM, deals, finance, people and settings are entirely unavailable.

### 4.4. Resource access

**Projects.** `projects.visibility`: `workspace` (everyone with projects.read) or `private` (members only). Table `project_members` (project_id, user_id, role: admin | member | viewer, can_write_tasks bool for the guest nuance). Membership roles:

- **admin**: project settings (workflow, types, members, git linking), everything to do with tasks.
- **member**: creating/editing tasks, comments, time.
- **viewer**: read-only.

A guest always interacts only through membership. The project creator automatically becomes an admin.

`workspace` is exactly the "unrestricted" case from rule 4.1, so on such a project the level is set by the role's permissions themselves: `projects.read` → viewer, `projects.write` → admin (and therefore everything a member can do). Membership is needed for `private` and for granting access narrower than the role. `projects.read` remains the floor: without it the project does not get into `accessibleProjectIds` and therefore does not open – what is visible in the list and what opens always match.

**KB spaces.** `kb_spaces.visibility`: workspace | private; `space_members` (space_id, user_id, role: editor | viewer). A space linked to a project inherits the effective role on the project (project admin → editor, member → editor, viewer → viewer) plus its own additional members. As with projects, on a `workspace` space the level comes from permissions: `kb.read` → viewer, `kb.write` → editor.

A level that is missing on a resource the user can see is a 403 with an explanation, not a 404: 404 is reserved for resources outside the user's visibility (no leaking of existence).

Resource access applies everywhere a row belongs to a project or space, not only in the project lists themselves: the home activity feed and a specific entity's trail (`/audit/entity/:type/:id`), "my tasks", Resourcing allocations and KB page search are filtered through `accessibleProjectIds` / `accessibleSpaceIds`. A domain permission answers the question "can this role see task activity at all", but not "for which tasks" – so both checks are mandatory. The exception is `audit.read`: seeing everything is its purpose.

**Finance.** There are no resource lists: access is controlled solely by permissions (finance.*). Rationale: finance is either trusted entirely or hidden entirely; per-client financial access is not implemented (trade-off in section 22).

**CRM.** Likewise: permission level, without per-record ACLs. The owner field on a company/deal is organisational, not restrictive.

### 4.5. Enforcement mechanics

1. Auth middleware resolves the user (session or API token) → `ctx.user`.
2. RBAC middleware loads the role's permission set (in-process memory cache, invalidated by the `role.updated` event).
3. Routes declare the permission declaratively: `guard('finance.read')`. A missing declaration fails a CI test (lint rule: every route has a guard or an explicit `public()`).
4. For resource entities the service calls `access.assertProject(user, projectId, minRole)`; lists are built via `accessibleProjectIds(user)` (one cached query per request).
5. API tokens have their own scope: a subset of the token owner's permissions (you cannot issue a token wider than your own role) plus a read_only flag.
6. The UI receives the permission set and memberships in `/api/v1/me` and hides unavailable sections/actions; the server remains the source of truth.
7. Every 403 denial is written to the audit log with the required permission: this makes debugging roles easier.

### 4.6. Management UI

Settings → Roles: list of roles, permissions matrix editor, user count per role. Settings → Users: invite with a role, change role, deactivate. Project → Settings → Access: visibility, members, membership roles. KB space → Access: likewise.

---

## 5. Data model

### 5.1. Relationship core

```
                        users ──< project_members >── projects >── companies <── contacts
                          │              │               │  │          │
roles ──< role_permissions│              │      cycles ──┘  │          ├─< deals >── deal_stages
                          │              │        │         │          ├─< notes
   task_assignees >───────┤            tasks ─────┴─────────┤          └─< invoices ──< invoice_items
        │                 │             │ │ │               │               │   ▲
      tasks ──────────────┼─────────────┘ │ └< task_relations              │   └── quotes ──< quote_items
        │                 │               └──< comments     │              └─< payments
        ├─< time_entries ─┘                                 │
        ├─< git_links                    kb_spaces ─────────┘ (project_id nullable)
        └─< task_labels >── labels          └──< kb_pages (tree) ──< kb_page_versions
```

### 5.2. Cross-cutting conventions

- PK: ULID. All tables: `created_at`, `updated_at`, `created_by` (nullable for system records).
- **Concurrency:** all editable business entities have a `version INTEGER NOT NULL DEFAULT 1` field, incremented by a DB trigger on every UPDATE. This is the source of optimistic locking (3.4), not `updated_at`.
- Soft delete: `deleted_at` on business entities; a trash bin in settings; hard delete only by Owner/Admin.
- Custom fields: `custom_fields JSONB` on companies, contacts, deals, projects, tasks, invoices, quotes, employees, applicants + the `custom_field_definitions` registry. Full mechanics (indexing, filtering, sorting, type changes, dashboards): subsection 5.5.
- Money: NUMERIC(14,2); currency as an ISO code on the document.
- Ordering: `position` NUMERIC, fractional indexing.
- FTS: tsvector columns with triggers on companies, contacts, projects, tasks, kb_pages, invoices(number), quotes(number); trigram indexes on numbers.

### 5.3. Tables by domain

**core:** users (email, name, role_id, avatar, timezone, locale, is_active), sessions/accounts/verifications (Better Auth), api_tokens (user_id, name, hash, scopes JSONB, read_only, last_used_at, revoked_at), roles, role_permissions, custom_field_definitions (entity_type, key, label, type: text/number/date/select/multiselect/checkbox/url/user, options, required, position, show_in_list, is_sortable, indexed), activity_log (entity_type, entity_id, actor_id, actor_type: user|agent|system|integration, action, diff JSONB – with redaction of sensitive fields, see 14.4, sensitivity: normal|sensitive for the retention policy), notifications (user_id, type, dedupe_key, entity_ref, payload, read_at, emailed_at), email_deliveries (idempotency_key, to, subject, body/html, status: pending|sending|sent|dead, attempts, next_attempt_at, sent_at, last_error), events (outbox: type, aggregate_type, aggregate_id, payload, occurred_at, published_at), processed_events (consumer, event_id – processing deduplication), attachments (entity_type, entity_id, file_key, filename, size, mime), saved_views (user_id nullable for shared views, entity_type, name, filters JSONB, sort, layout, is_shared), webhook_subscriptions (url, secret, event_types[], active), webhook_deliveries (log with retry status, attempt, next_retry_at, status: pending/delivered/failed/dead), dashboards (owner_id, name, visibility: private|workspace), dashboard_widgets (dashboard_id, widget_type, source, config JSONB: filters/groupby/metric, layout: x/y/w/h).

**crm:** companies (name, domain, status: lead/active/paused/archived, owner_id, billing_email, address JSONB, default_currency, payment_terms_days, portal_token, custom_fields), contacts (company_id, first/last name, email, phone, position, is_primary, custom_fields), leads (company_id, contact_id?, title, product, status, score, signal/evidence/fit/timing, sources, suggested_channel, opener, caution, nurture_until, owner_id, source links), deal_stages (name, position, probability, is_won, is_lost), deals (company_id, source_lead_id?, title, stage_id, amount nullable, currency, expected_close_date, owner_id, lost_reason, custom_fields), sales_activities (exactly one lead_id/deal_id, company_id, contact_id?, type, status, channel, subject, context, outcome, due_at, owner_id, message_template_id?, sequence links), sales_message_templates, sales_sequences, sales_sequence_steps, sales_sequence_enrollments, sales_digest_runs (user_id + local_date), notes (company_id, contact_id?, lead_id?, deal_id?, body JSON, pinned).

**projects:** project_types (name, icon, color), project_templates (name, definition JSONB: statuses, task types, default labels, KB space, saved views), projects (company_id nullable, kind: client|internal, name, key, project_type_id?, template_source_id?, status: active/paused/completed/archived, visibility, lead_id, start_date, target_date, description, settings JSONB: estimate_unit hours|points, custom_fields, version), project_members, task_statuses (project_id, name, category: backlog/todo/in_progress/done/canceled, color, position, is_default), task_types (project_id nullable = workspace level, name, icon, color, position), tasks (project_id, number, title, description JSON, status_id, type_id?, priority: none/low/medium/high/urgent, parent_id, due_date, start_date, estimate NUMERIC, cycle_id?, position, custom_fields), task_assignees, task_relations (task_id, related_task_id, type: blocks/duplicates/relates; blocked_by is stored as the inverse of blocks), labels (workspace level: name, color, scope: task|project – separate vocabularies for tasks and projects), task_labels, project_labels, comments (task_id, author_id, body JSON, edited_at), cycles (project_id, name, start_date, end_date, status: upcoming/active/completed, goal), cycle_snapshots (cycle_id, date, open_count, open_estimate), task_drafts (user_id, project_id?, payload JSONB), task_links (task_id, url, title), task_templates (project_id nullable = workspace, name, definition JSONB: fields + subtasks), recurring_tasks (project_id, template_id, frequency/cron, next_run, active), intake_items (project_id, source: form/email, requester_name, requester_email, title, description, attachments, status: pending/accepted/declined, decline_reason, created_task_id), intake_settings (project_id, form_token, form_enabled, mailbox JSONB encrypted).

**kb:** kb_spaces (name, icon, project_id nullable, visibility, position), space_members, kb_pages (space_id, parent_id, title, body JSON, icon, position, is_template, published bool, visibility: public|private, locked_by/locked_at), kb_page_comments (page_id, author_id, body JSON), kb_page_versions (page_id, body JSON, title, version_no, author_id, created_at), kb_page_links (page_id, target_type: page/task/company, target_id) for backlinks.

**time:** time_entries (task_id, user_id, project_id denormalised, started_at, duration_seconds, note, billable bool, hourly_rate NUMERIC snapshot of the client rate, cost_rate NUMERIC snapshot of the hourly cost from compensation+overhead at the time of the entry, invoice_item_id nullable = what it was billed on), project_rates (project_id, user_id nullable = project default, hourly_rate, currency).

**finance:** number_sequences (doc_type, period_key, last_value; atomically, FOR UPDATE), tax_rates (name, rate_percent), quotes (company_id, project_id?, number, status: draft/sent/viewed/accepted/declined/expired, currency, issue_date, valid_until, subtotal, tax_total, total, public_token, accepted_at, converted_invoice_id, custom_fields), quote_items, invoices (company_id, project_id?, quote_id?, number, status: draft/sent/viewed/partially_paid/paid/canceled, is_overdue computed, currency, issue_date, due_date, discount_type/value, subtotal, tax_total, total, amount_paid, notes, terms, public_token, sent_at, reminders_paused bool, language uk|en, custom_fields), invoice_items (description, quantity, unit_price, tax_rate_id?, amount, position, source: manual|time|quote), payments (invoice_id, amount, currency, date, method, reference, notes), recurring_invoices (company_id, project_id?, frequency, next_issue_date, items_template JSONB, auto_send, status), credit_notes (invoice_id, amount, reason, date), expenses (company_id?, project_id?, category_id, amount, currency, date, description, attachment_id), expense_categories, reminder_rules (offset_days signed, template_id, active), email_templates (type, subject, body with placeholders), reminder_log (invoice_id, rule_id, sent_at).

**integrations:** git_connections (provider: github/gitlab/gitea, installation/credentials JSONB encrypted, webhook_secret, installation_id + account_login for the GitHub App, status: connected/revoked/suspended), git_repositories (connection_id, external_id, full_name, default_branch), project_repositories (project_id, repository_id), git_links (task_id, repository_id, type: branch/commit/pr/mr, external_ref, title, url, state: open/merged/closed, author, updated_at), git_automation_rules (project_id, trigger: pr_opened/pr_merged/pr_closed/branch_created, target_status_id).

### 5.4. Fixed cardinalities (the most expensive decisions)

- **project N–1 company, nullable + `kind: client | internal`.** A client project has a company_id and kind=client. An internal project has company_id=NULL and kind=internal (no fictitious client). `kind` (not the presence of company_id) is the canonical flag for filters, permissions and reports; a NULL company_id simply reflects the absence of a client. Consequences, stated explicitly: CRM lists, aging and profitability revenue operate only on kind=client (internal never leaks into client reports); cost analytics (11.10) counts kind=internal projects as pure cost with no revenue (exactly what overhead accounting needs: internal time is non-billable cost). An invoice cannot be linked to an internal project (validation: invoice.project_id must point to kind=client).
- **project 1–N tasks; there are no project-less tasks.** Day-to-day operations and tasks not tied to client work live in an internal project (e.g. "Inbox" or "Operations"), which is an ordinary kind=internal project without a company_id, not a special-case exception.
- task parent_id: subtask tree, at most 5 levels (checked by the service).
- task N–N users (assignees); task N–N labels; task N–N tasks (relations).
- invoice N–1 company, N–1 project (nullable), N–1 quote (nullable); there is no payment N–N: payment N–1 invoice, partial payments as a list of payments.
- contact N–1 company (a person at two clients = two records; trade-off in 22).
- kb_space N–1 project (nullable: workspace spaces exist without a project).

### 5.5. Custom fields: mechanics

Custom fields are stored in `custom_fields JSONB` on the entity, and their schema (type, options, flags) in the `custom_field_definitions` registry. JSONB was chosen for flexibility without migrations, but it requires explicit rules for indexing, querying, type changes and aggregation; otherwise "dynamic fields" become a neglected hole in performance and correctness.

**Indexing.** Two levels. (1) A base GIN index on the `custom_fields` column of each entity: it covers existence and containment filters (`custom_fields ? 'key'`, `custom_fields @> '{"key":val}'`), which is enough for infrequent filters. (2) For fields that really are filtered/sorted on often (the definition has the `indexed` flag), a targeted B-tree expression index is created on the extracted and typed value, e.g. `CREATE INDEX ON tasks (((custom_fields->>'budget')::numeric))`. Creating/dropping such an index is controlled by the flag in the registry and performed asynchronously by the migration worker (CONCURRENTLY), not within the user's request.

**Sorting.** Untyped JSONB values sort as text, which breaks numbers and dates. So for fields with the `is_sortable` flag the value is projected into a typed expression at query level (`(custom_fields->>'key')::numeric | ::date | ::text` according to the type in the registry), and ORDER BY uses that expression; the expression index (above) makes it cheap. Sorting is allowed only for the number/date/select/text types; multiselect/checkbox/url/user are not available as a sort key (validated at API level).

**Filtering.** The client never sends raw SQL. The API accepts a structured filter `{ field_key, op, value }`; the service checks field_key against the registry, takes the type, validates op for that type (number: eq/gt/lt/between; select: in; text: contains; date: before/after/between; checkbox: eq) and builds a parameterised predicate over the JSONB. An unknown key or an op that is invalid for the type → 400. This addresses both performance (via indexed fields) and injection.

**Changing a field's type.** Destructively changing a type's semantics on the fly is forbidden (there is no "ALTER field text→number" over existing data). Allowed: (a) editing the label, select options (adding; removing an option that is in use is blocked or goes through a value migration), order, required, showing in the list, the indexed/sortable flags; (b) for an actual type change, a NEW field of the required type is created, the data is moved by a managed migration (with validation and a report on values that cannot be transferred), and the old field is deprecated and hidden. In other words, the same principle as everywhere else in this PRD: additive, not surgery on semantics. `required` can be enabled only once existing records have been filled in (otherwise validation retroactively breaks old entities): the wizard shows how many records are empty.

**Dashboards and aggregation.** A widget can group/aggregate only by custom fields of aggregatable types: number (sum/average/min/max), select/multiselect (count by value), date (count by period), checkbox (count of true/false). Text/url/user are not available as a metric (only as a filter). Values for aggregation are taken through the same typed cast; a widget over a field without the indexed flag on a large volume warns about the possible cost. Permissions: a custom field of an entity the user cannot access (e.g. a field on employees without people.read) is not offered in the widget builder.

**Registry (addendum to 5.3):** besides entity_type/key/label/type/options/required/position/show_in_list, `custom_field_definitions` also carries `is_sortable` and `indexed` (they control the behaviour above). The key is immutable after creation (renaming = a new key + migration), because JSONB access and the indexes rely on it.

---

## 6. Auth and users

- Sign-in with email + password; users are created by an Admin (invite link by email, password setup). Optional TOTP 2FA. No self-signup.
- Cookie-based sessions (web/desktop); API tokens for MCP/integrations: created in the profile, scope ⊆ the owner's permissions, read_only flag, the secret is shown once, revocation, last_used_at.
- Profile: name, avatar, time zone, language (uk/en), email notification settings by type, active sessions with the option to end them, changing your own password (with confirmation of the current one; it ends all other sessions, invalidates an unused reset link and is unavailable to API tokens – otherwise a read-only token would give full access to the account).
- Password recovery: "Forgot password?" on the sign-in screen and a "Reset password" button in Settings → Users (users.manage). Both paths issue the same one-time link valid for an hour – the token is stored as a hash, a new link invalidates the previous one, and the admin neither sees nor sets the password. Using the link resets the failure counter and ends all of the user's sessions; the link is also returned in the API response, so that an installation without SMTP can pass it on manually. The response to a request is the same for an existing and a non-existent address (no enumeration).
- Rate limit on auth: 10 attempts/min/IP; account lockout after 20 failures, unlocked by an admin or after a timeout. Password recovery requests: 10/15 min/IP and 5/15 min per address.
- User deactivation: sessions and tokens are revoked, historical records remain (FKs do not break), and the deactivation wizard offers to reassign tasks.

---

## 7. CRM module (reference: Twenty)

### 7.1. Purpose

The source of truth for the path from a discovered prospect to a client. The company remains the stable hub for contacts, leads, deals, projects, documents and invoices; a lead describes a not-yet-qualified sales pursuit, and a deal a confirmed commercial opportunity. By default CRM opens Work and answers not only "what is there" but also "what to do next".

### 7.2. Companies

- CRUD; statuses lead → active → paused → archived (transitions are unrestricted and written to activity).
- Card: header (name, domain with favicon, status, owner, tag labels), tabs: Overview / Contacts / Leads / Deals / Projects / Invoices and Quotes (visible only with finance.read) / Notes / Files / Activity.
- Overview: metrics computed by the backend: invoiced/paid/receivables (per currency), active projects and open tasks, unbilled time (from time, for finance.read), recent events; for a user without finance.read the financial tiles are absent from the API response (not hidden on the frontend, but never sent).
- Billing details: billing_email, address, currency, payment terms (days), portal_token (section 11.8).
- Custom fields from the registry; configurable list columns, including custom ones.

### 7.3. Contacts

CRUD within a company; is_primary (the default recipient of documents); quick creation from the card; contact search in the global palette.

### 7.4. Leads and Work

- A lead belongs to a company, can have a suggested contact and an owner, and stores the product/service pursuit and qualification notes: signal, evidence, fit, timing, score, sources and the date they were checked, suggested channel, opener and caution. Leads are created manually via the UI, REST or MCP.
- Lead statuses: `new`, `needs_review`, `ready`, `waiting_reply`, `engaged`, `nurture`, `converted`, `disqualified`, `no_response`. `nurture` requires a valid return date `YYYY-MM-DD`; scheduling a new activity atomically returns the lead to `ready`.
- A sales activity belongs to exactly one lead or deal and has a type, status `planned|completed|cancelled`, channel, subject/context, owner, a mandatory `due_at`, outcome and links to a template/sequence. Completing it can change the lead status and create the next activity in a single transaction.
- `/crm` opens Work: `overdue`, `dueToday`, `upcoming`, `waitingReply`, `nurtureDue`, `noNextAction` – in exactly this order, because it is the order of the working day. `upcoming` holds records whose next action is scheduled after today: without it, a fully scheduled week showed an empty queue. The action on a row is determined by its bucket: complete overdue and today's items, schedule unscheduled ones, the rest are read-only. The morning digest sends only what needs action (`overdue + dueToday + nurtureDue + noNextAction`). The boundaries of "today" are calculated in the user's time zone. The default scope is the user's own records plus unassigned ones; team scope is explicit. Each bucket returns an exact total regardless of the row limit.
- Lead → deal conversion and the reverse demotion of a legacy Lead-stage deal are transactional and carry over notes, files, activities, the active sequence and source links without losing history.

### 7.5. Deals (pipeline)

- deal_stages are configurable: name, order, probability %, won/lost flags (at least one won and one lost).
- The Kanban contains only qualified opportunities and has drag-and-drop, a list with filters, and totals and weighted totals (amount × probability) per stage. `amount` may be unknown; mixed currencies are not summed into a single number.
- Deal: title, company, amount+currency, expected date, owner, custom fields, notes, files, activity.
- Moving to lost: a reason is mandatory. Moving to won: the `deal.won` event → an automation offers to create a project (client/name pre-filled) and/or a quote.
- Conversion: "Create project from deal" and "Create quote from deal" buttons (with the amount as a single line item).

### 7.6. Playbooks

- Message templates store the activity type, channel, subject and body. Available variables: `{{companyName}}`, `{{contactFirstName}}`, `{{contactName}}`, `{{ownerName}}`, `{{leadTitle}}`.
- A sequence is an ordered list of manual steps with a delay in days and an optional template. An enrollment is allowed for only one lead or deal and creates the first planned activity; completing the current step schedules the next one, and a terminal/nurture state or closing the deal stops the enrollment.
- A sequence never sends an email or a LinkedIn message automatically. It only creates a controlled next action for a person.
- After first use, steps are immutable; the name, description and active flag can be changed with optimistic locking.

### 7.7. Notes and activity

Rich-text notes on a company/contact/lead/deal, which can be pinned. Activity: an automatic feed from activity_log: status and stage changes, sales activity lifecycle, sequence enrollment, conversions, project creation, documents, payments, notes. The audit diff contains only the fields that actually changed and does not duplicate message context unnecessarily.

---

## 8. Projects module (reference: Plane)

### 8.1. Projects

- Mandatory: name, key (2-5 letters, unique), kind (client|internal). For kind=client a client is mandatory; for kind=internal there is no client (company_id NULL). Optional: project type (project_types: a configurable list with an icon/colour: Website, Retainer…), template.
- Creation from a template (project_templates): the template sets up the status workflow, task types, labels, a linked KB space with starter pages, and default saved views. Templates are created from scratch or via "save the current project as a template".
- Project statuses: active/paused/completed/archived. `project.completed` → automations: a prompt "there is unbilled time / no invoice → create an invoice?", an offer to close the active cycle.
- Visibility: workspace | private (section 4.4). Page: header (client, lead, type, dates, progress), tabs: Tasks / Cycles / Overview / Pages (the project's KB space) / Time (with time.read_all, or your own) / Invoices (finance.read) / Files / Settings (project admin).

### 8.2. Task status workflow

- task_statuses per project: create/rename/colour/order/delete (with tasks migrated to a specified status). Each status belongs to a category backlog/todo/in_progress/done/canceled: the categories give the system its semantics (progress, "open" filters, automations), while the status names and their number are arbitrary.
- Default workflow for a new project: from a template or the workspace default (Settings → Projects → Default workflow).

### 8.3. Tasks

- Number `KEY-42` (DB trigger, per-project sequence). Fields: title, description (rich text), status, type (task_types: configurable, workspace level + per-project overrides: Task/Bug/Feature/Request…), priority (none/low/medium/high/urgent: a fixed set), assignees (multiple), start/due dates, estimate (unit from the project settings: hours or points), cycle, labels, subtasks (a tree up to 5 levels; the parent's progress is calculated from its children), relations, attachments, custom fields.
- **Relations and dependencies (task_relations):** separated by semantics, as in Plane. Scheduling dependencies: blocks / blocked by: they affect the order of work and are rendered as connectors in Timeline, and violated dependencies (the blocker finishes later than the dependent task) are highlighted; a blocked task is marked in lists, and closing it with unresolved blockers gives a warning (not a prohibition). Context relations: relates to / duplicates: navigational context in the panel only. Custom relation types are not implemented (trade-off, 22).
- **External links:** arbitrary URLs on a task (title + url): specifications, designs, client tickets.
- **Views:** List (grouping by status/priority/assignee/type/label, an inline quick-add row: title + Enter creates a task with defaults), Board (kanban by status or assignee, drag-and-drop), Calendar (by due date), Timeline (Gantt: start→due bars, drag to change dates, dependency connectors), Spreadsheet (a grid with inline editing of fields in cells, bulk editing of a column). View + filters + grouping are saved in saved_views: personal, shared and workspace-level (cross-project, for projects.read).
- **Drafts:** an unfinished task (the modal was closed, the connection dropped) is autosaved to the user's drafts (without a number); a Drafts section in the sidebar lets you continue editing or discard. The number is assigned on publishing.
- **Task activity:** tabs All / Comments / History (system field changes with the actor) / Worklogs (time entries from the Time module).
- Filters: status (and category), type, priority, assignee, labels, cycle, dates (overdue, this week…), text. In the API, the date window for `GET /tasks` is `dueFrom`/`dueTo` on due_date (a task without a date does not fall into it, as it should be for a calendar slice), and `label` accepts a comma-separated list and narrows the result: a task must carry all the listed labels. Bulk actions: status, assignee, labels, cycle, priority.
- A peek panel on the right + a full page `/projects/KEY/tasks/42`. Rich-text comments with @user mentions (notification), emoji reactions, an "edited" marker.
- Quick creation: global hotkey C, parsing of quick syntax in the title (`!high`, `#label`, `@user`, `%type`), creation directly in a board column, converting a comment into a task.
- Duplicating a task; moving a task between projects (a new number is assigned, the old one remains as a redirect); task archive (a separate filter).

### 8.4. Cycles

- Per-project timeboxes: name, start/end, goal. One active cycle per project at a time; upcoming → active automatically by date (worker) or manually.
- A task belongs to at most one cycle. The board/list can be filtered by cycle; the cycle page: progress (done/all, by estimate if estimates are tracked), a burndown chart (a daily snapshot of the open scope: the cycle_snapshots table, a midnight worker), a breakdown by assignee.
- Completing a cycle: a summary + a wizard to carry over unfinished tasks (to the next cycle / to the backlog). The `cycle.completed` event.

### 8.5. Cross-project screens

- **My tasks:** all projects, grouped into overdue/today/this week/later + tasks you created that have no assignee.
- **All tasks** (for projects.read): a global list with a project filter, saved views.

### 8.6. Intake (incoming requests)

Reference: Plane Intake. A channel for the structured intake of requests from clients and team members who have no direct access to the project:

- **Sources:** a public form `/intake/{form_token}` (a per-project token, enabled in the project settings, branding from the workspace business details), an optional mailbox (IMAP polling by a worker: email → intake request, attachments carried over) and the `/ordi` Slack command.
- **Form config** (`intake_settings.form_config`, editor with a live preview in the project settings): heading, introduction, button label, message after sending, accent colour; the built-in fields (name, email, title → task title, details → task description) can be relabelled, reordered, made required or hidden (the title is always shown and required); up to 30 custom fields of the types short text, long text, email, phone, link, number, date, choice and checkbox. Custom answers are stored on the request (`intake_items.answers`, with the label they were asked under), shown on the triage card and written into the task description on accept. File uploads are optional per form (up to 10 files, the upload size cap each, only when object storage is configured).
- **Embedding:** a loader script `/api/v1/embed/intake.js` turns `<div data-ordi-intake="{form_token}">` on any site into an iframe of `/intake/{form_token}?embed=1` that resizes to the form's height via postMessage (options: `data-theme` light/dark/auto, `data-lang` en/uk; a bubbling `ordi:intake-submitted` event on success); a plain iframe works too. Embedded, the page drops its backdrop and branding row and defaults to the light theme.
- **Triage:** the Intake queue in the project (visible to project admins/members): pending requests with a preview; actions: Accept (opens a pre-filled task creation modal: type, status, assignee; the request gets created_task_id) or Decline (with a reason; if the requester's email is known: an optional reply email from a template).
- A requester with an email receives an acknowledgement of receipt (queued, switchable per form, at most 3 per address per hour) and a notification of acceptance (without details of the internal task).
- Anti-abuse: a rate limit counted on stored requests per submitter (an HMAC of the IP, 5 a minute and 30 an hour, so it survives restarts and holds across instances), a honeypot field, token regeneration (the old link and every embed stop at once).

### 8.7. Task templates and recurring tasks

- **Task templates** (workspace + per-project): pre-filled title pattern, description, type, priority, labels, estimate, a set of subtasks. Used from the creation modal, from intake accept, and from recurring tasks.
- **Recurring tasks:** a rule: project + template + frequency (daily/weekly/monthly/custom cron) + next run + active flag. A daily worker creates a task from the template (idempotently) and shifts next_run. Use cases: regular support checklists, monthly client reports.

---

## 9. Knowledge Base module (reference: Plane Pages)

### 9.1. Purpose

Agency and project documentation: briefs, processes, onboarding guides, specifications. It lives next to the tasks, is linked to projects, and has access control.

### 9.2. Spaces

- kb_spaces: workspace-level (e.g. "Agency processes", "HR") and project-level (created automatically together with the project via a template flag, or manually; project_id is set).
- Access: workspace spaces by visibility+space_members; project spaces inherit project membership (4.4). kb.manage_spaces: creating/deleting workspace-level spaces.

### 9.3. Pages

- A page tree within a space (nesting without a hard limit, drag-to-move within the tree, moving between spaces with a permission check).
- Tiptap editor: headings, lists, checkboxes, tables, code blocks with syntax highlighting, callouts, images (S3), file embeds, dividers, toggle blocks.
- **Mentions:** `@user` (notification), `#KEY-42` (link to a task with its live status), `[[page title]]` (link to a page). All mentions are written to kb_page_links → a Backlinks section on the task and the page ("where this is mentioned").
- **Versions:** every save (30 s debounce) creates a kb_page_versions row; version history with a diff view and restore. Redo-safe: a restore creates a new version.
- **Locking:** opening in edit mode sets a soft lock (locked_by, heartbeat); another user sees "X is editing", and can open it read-only or take over (if the lock is older than 2 min).
- Page templates (is_template): "Create from template"; templates scoped to a space and global ones.
- Publishing: a draft/published flag: drafts are visible to the space's editors, published pages to everyone with access to the space. A new page is created as published; draft is a deliberate state (unpublish / create as draft), otherwise the knowledge base would sit empty for viewer roles.
- **Page-level visibility** (the Plane model): public (everyone with access to the space) or private (the author + space admins). Visibility is not inherited automatically: a private child page is invisible to readers of its public parent; the tree is rendered with permission filtering.
- **Page comments:** a comment thread below the page (rich text, mentions), for discussion without editing the body.
- **Convert to task:** a selected block of the page → "Create task" (a modal with a pre-filled description and a backlink to the page): meeting notes become tasks without leaving the document.
- Page export to Markdown; full-text search over the body (tsvector from the JSON body) integrated into the global palette with ranking.

---

## 10. Time module (time tracking)

### 10.1. Purpose

Tracking time against tasks for two goals: an internal picture of workload, and billing clients on an hourly model.

### 10.2. Functionality

- **Timer:** start/stop on a task (one active timer per user; starting a new one stops the previous one); an active timer indicator in the top bar everywhere; a note on the entry.
- **Manual entries:** date, duration, task, note; editing your own entries; time.manage: editing other people's.
- **Billable:** a flag (default from the project settings); hourly_rate is snapshotted into the entry at creation time from project_rates (personal rate → project default → 0).
- **Rates:** project_rates in the project settings (currency = the client's currency): the project's default rate + per-user overrides. Edited by a project admin with finance.settings or time.manage.
- **Reports (time.read_all):** a summary for a period: by project / person / client; billable vs non-billable; unbilled billable time (invoice_item_id IS NULL) as a separate slice. CSV export.
- **My time:** a weekly grid of your own entries, with inline editing.

### 10.3. Link to finance

Generating an invoice from time (finance.write): the "Bill time" wizard: client → period → choice of projects → review of unbilled entries (grouping: by task / by user / as a single line) → a draft invoice is created, invoice_items with source=time, and the entries get invoice_item_id. Cancelling the invoice or deleting a line item unlinks the entries (they become unbilled again). Entries linked to a line item are locked against duration edits.

---

## 11. Finance module (reference: Invoice Ninja)

### 11.1. Scope

Operational finance: quotes, invoices, payments, receivables, reminders, expenses. Not accounting: double-entry bookkeeping, tax reporting and legal e-invoicing compliance are outside the system (external tools); if needed, a legal integration is added as a separate module via the event bus without changing the model.

### 11.2. Quotes (commercial proposals)

- Lifecycle: draft → sent → viewed → accepted | declined | expired (expired: a worker based on valid_until).
- The structure is identical to an invoice (line items, taxes, discount, PDF, public page `/q/{token}`).
- On the public page the client clicks Accept/Decline (with a comment): a `quote.accepted` event → a notification to the owner + an automation offers to convert it.
- Conversion to an invoice: copies the line items, sets quote_id, and the quote gets converted_invoice_id. A quote cannot be edited after sent: only duplicated as a new version.

### 11.3. Invoices

- Creation: from scratch / from a project (pre-filled) / from a quote / from time (10.3) / by duplication / from a recurring template.
- Numbering: a configurable pattern `INV-{YYYY}-{seq:4}` (separate sequences for invoices/quotes, atomic, reset period none/year).
- Line items: description, quantity, price, tax rate from the reference list; totals are calculated only by the server. Invoice discount: a percentage or a fixed amount, before or after tax (a setting). Document language uk/en (the PDF template is localised).
- **Lifecycle:** draft → sent → viewed → partially_paid → paid; canceled from any unpaid state; is_overdue: a computed flag (due_date < today and not paid/canceled). All transitions go through a service that validates the transition matrix; after sent, line items are immutable: corrections via cancel + duplicate (the link is recorded).
- **PDF:** a Typst template, one minimalist design: logo, agency details (from settings), client details, line items, totals, terms/notes, a QR code linking to the public page. The artefact of every send is stored immutably in S3.
- **Sending:** email (a template from email_templates) to billing_email/the chosen contact, the PDF attached + a public link. Re-sending is possible.
- **Public page** `/i/{public_token}`: view, PDF download; the first open → viewed + an event. Space for an online payment button is reserved (payment provider: a separate future module).

### 11.4. Payments and credit notes

- Recording a payment: amount, date, method (bank/card/cash/other), reference. Partial payments: a list of payments; amount_paid and the status are recalculated. Overpayment is forbidden (Σ payments + Σ credit_notes ≤ total).
- Credit note: reduces the amount owed on an invoice (amount, reason); counted in the invoice balance and receivables.
- Deleting a payment (finance.payments + confirmation): status rollback, activity with a diff.

### 11.5. Recurring invoices

Template: client, project, line items, frequency (weekly/monthly/quarterly/yearly), next_issue_date, auto_send, end (date/count/indefinite). A daily worker: creates a draft or sends it right away, advances next_issue_date, emits `invoice.created(source=recurring)`. Pause/resume.

### 11.6. Reminders

reminder_rules: offsets from due_date (e.g. -3, +1, +7, +14 days), each with its own email template (placeholders: {client}, {number}, {total}, {due_date}, {link}). A daily worker: idempotent via reminder_log; reminders_paused on an invoice turns them off. Manual sending of a reminder from the invoice. Late fees are not implemented (trade-off, 22).

### 11.7. Expenses

A log: amount, currency, date, category (reference list), optionally client/project, a receipt attachment, description. In the project overview (finance.read): expenses against invoiced. Not accounting: no VAT accounting for expenses.

### 11.8. Client portal (lightweight)

The page `/portal/{company.portal_token}` without authentication (unguessable token, regenerable): a list of the client's documents: invoices (statuses, amounts, links to the public pages) and quotes. Gives the client one permanent address instead of a scatter of links. Can be disabled per client. A full portal with login is not implemented (trade-off, 22).

### 11.9. Finance dashboard and lists

Dashboard (finance.read): total receivables and aging 0-30/31-60/61-90/90+ (by currency), invoiced/paid for the period, a list of overdue invoices, expected payments by due_date, top debtors, unbilled billable time (the bridge in 10.3). Invoice/quote lists: filters for status/client/project/period, totals for the filter, bulk reminders, CSV export.

### 11.10. Cost and profitability

Reference: Productive.io (agency management: cost rates, overhead, project/client profit). This is the answer to "seeing salary costs and the like" at the business level: not how much to pay a person (payroll, which does not exist here), but how much the work costs us and how much we earn on it. Access: `finance.read_costs` (separate from finance.read: you can see invoices and receivables but not cost and salaries).

- **Cost of an hour of labour:** takes the employee's cost rate (12.5) + overhead per hour (12.5, if enabled) as a snapshot at the moment time is logged; so every time entry has not only a billable amount (the client rate) but also a cost amount. Versioned compensation history guarantees correctness for past periods.
- **Project profitability:** revenue (invoiced, or billable time at client rates) minus costs (the cost of hours worked + the project's non-billable expenses from expenses + billable expenses without markup) = the project margin (amount and %). Shown on the project card (Overview tab, with finance.read_costs) and in the report.
- **Client profitability:** the same model aggregated across all of the client's projects: shows who brings in profit and who is in the red (the key value of the Productive class of tools).
- **Labour cost:** an aggregated report: labour cost for a period, broken down by employee / team / project / client; billable vs non-billable hours in money (what non-billable time costs). This is what "salary costs" means in the operational sense.
- **Utilisation:** % of billable hours out of available hours (taking absences from 12.2 into account) per person/team: shows how well workload converts into invoiced work.
- **Report builder:** profit grouped by client/project/period with filters, as in Productive; CSV export; the same metrics are available as custom dashboard widgets (source "profitability", only with finance.read_costs).

Boundary: this is management analytics based on cost rate and hours, not an accounting P&L and not payroll. Exact salary calculations, taxes, payroll statements – outside ordi (an external tool), as is the legal part of Finance (11.1).

---

## 12. People module (HR)

Reference: Frappe HR (open-source HRMS: lifecycle, leaves, attendance, recruitment). The model and terminology are taken over, adapted to agency scale. Deliberately NOT taken over: a payroll engine with formula-based components and regional tax compliance (generating payroll statements, payslips, tax slips) – this is the accounting and legal zone that ordi does not cover (the same boundary as in Finance, section 11.1). Salary is present in ordi as an attribute of an employee's cost for analytics (12.5 + 11.x), not as a payroll calculation engine.

Access to the module is controlled by a separate permission domain `people.*` (below), because HR data is sensitive and must not be visible to everyone with access to projects.

### 12.1. Employees (employee records, lifecycle)

- **Employee card:** link to a user (nullable: a contractor can be kept without an account), name, contacts, job title, department/team, employment type (full-time/part-time/contractor), manager (self-reference), join/probation-end/exit dates, status (active/on_leave/terminated), emergency contact, custom fields, documents (attachments: contract, scans). Personal fields (date of birth, address, etc.) are visible only with `people.read_sensitive`.
- **Lifecycle:** status transitions with events (`employee.onboarded`, `employee.exited`). Onboarding/offboarding as checklists: on hiring, an onboarding template (a set of tasks) automatically creates tasks in the internal HR project (kind=internal) and assigns the people responsible (a bridge into Projects via the bus, as in Frappe HR, where boarding auto-creates tasks).
- **Reference lists of departments/teams and positions** (configurable); org structure via the manager field (a tree).

### 12.2. Leave and absences (leaves)

- **Absence types** (configurable): annual leave, sick leave, time off in lieu, unpaid leave, compensatory leave, custom. Type parameters: paid or not, whether it needs approval, whether it reduces the balance, whether half-day is allowed, annual quota, carry-forward of the remainder with a limit and an expiry period.
- **Balances:** quota accrual for a period (annual, monthly-earned), a leave_balances table per employee per type; the employee can view their balance. **Remaining** (leave-entitlements) = allocated + carried − used − days of requests in pending status, per type per period; until the period has been accrued, allocated is taken from the type's annual quota, so the remainder is visible even before the first accrual. A quota of 0 and types that do not deduct from the balance have no remainder and are not limited by anything.
- **Requests (request → approval):** the employee submits a request (type, date range or half-day, comment, optional attachment, e.g. a medical certificate); approval route: the employee's manager, falling back to the `people.approve_leave` role. States: pending → approved | rejected | canceled. Approval deducts from the balance; cancellation returns it. A conflict (overlap with an existing request) is blocked. A request longer than the remainder is rejected – both on submission (taking already submitted pending requests into account) and again on approval (the quota may have been reduced after submission).
- **Absence calendar:** a team calendar of who is away when (subject to permissions); integrated into workload resolution (Resourcing, 12.4) and a warning when assigning a task to a person on leave.
- **Holiday calendars:** configurable public holiday calendars (per region/office), assigned to employees; they affect working days in calculations and in the calendar.
- Notifications: request submitted → to the manager; decision → to the employee; upcoming leave → to the team (optional).

### 12.3. Hiring (recruitment)

- **Job openings:** title, department, employment type, description, status (draft/open/on_hold/closed), number of positions, hiring manager, optionally a salary band (a range, visible only with `people.read_sensitive`).
- **Public job opening page** `/careers/{token}` (optionally enabled): description + application form (name, email, résumé attachment, cover text). Anti-abuse as in intake (rate limit, honeypot).
- **Applicants and pipeline:** a kanban by stage (configurable: Applied → Screening → Interview → Offer → Hired / Rejected), an applicant card (contacts, résumé, link to the job opening, interviewer ratings, notes, history). Dragging between stages; rejected with a reason. Duplicate detection by email.
- **Interviews:** an interview record (applicant, interviewers, date/time, type, summary/scorecard). Reminders to interviewers.
- **Hiring:** the Hired stage on an applicant → a "Create employee" action (an employee card pre-filled from the applicant's data; the onboarding checklist from 12.1 is started). Event `applicant.hired`.

### 12.4. Resourcing (team workload)

A workload planning layer (an analogue of Resourcing in Productive, simplified: we do not build full capacity planning with forecast placeholders, see the trade-off in 22). A weekly view of who is allocated to which projects, taking absences (12.2) into account. Allocation sources: task assignments with deadlines + explicit allocations (allocation: user, project, hours/week, period). Goal: to see overload and free windows, and to feed the utilisation analytics (11.10). It is part of 1.0 as a full module; only forecast placeholders (allocating a not-yet-hired person) and scenario forecasting remain out of scope, which is recorded in the trade-offs.

### 12.5. Employee compensation (cost rate) – a bridging subsection between People and Finance

This is where your "seeing salaries and salary costs" lives. This is deliberately NOT payroll (calculations/payslips/taxes), but a person's cost rate for calculating cost and profitability. The model comes from Productive (cost rate + overhead), not from Frappe payroll:

- **compensation** per employee: type (monthly salary / hourly rate / contractor rate), amount, currency, validity period (versioned: a history of salary changes with dates, so the cost of past periods is calculated correctly). Visible only with `people.read_compensation` (the narrowest permission, separate from the rest of HR).
- **Cost rate (hourly cost):** calculated from compensation and the standard hours (working hours/week from settings). For a contractor – the direct rate. The cost rate is what gets multiplied by the hours worked from the Time module to get cost.
- **Overhead (optional):** company overhead per hour (facilities + internal/non-billable expenses), as in Productive: a configurable monthly overhead base is spread across working hours and added on top of the cost rate. Gives the "true" cost of an hour.

This data is consumed by the finance analytics (below) and the project cost. The salary amounts themselves are shown nowhere except on cards with the `people.read_compensation` permission and in aggregated reports with the `finance.read_costs` permission.

### 12.6. HR dashboard and reports

Subject to permissions: headcount (active/on leave/new/exits for the period), upcoming absences (calendar), open job openings and the state of the applicant pipeline, upcoming probation end dates. Reports: leave balances by team, attendance summary (if tracked), recruitment funnel. Compensation/cost reports – separately, with `finance.read_costs` (12.5 + section 11.x).

### 12.7. Data model (People)

departments (name, parent_id), positions (title), employees (user_id?, first/last name, contacts, position_id, department_id, employment_type, manager_id, join_date, probation_end, exit_date, status, emergency_contact JSONB, sensitive JSONB, custom_fields), employee_documents (employee_id, attachment_id, type), leave_types (name, is_paid, needs_approval, affects_balance, allow_half_day, annual_quota, carry_forward_limit, carry_forward_expiry), leave_balances (employee_id, leave_type_id, period, allocated, used, carried), leave_requests (employee_id, leave_type_id, from_date, to_date, half_day bool, reason, attachment_id?, status, approver_id, decided_at), holiday_calendars (name), holidays (calendar_id, date, name), employee_holiday_calendar (employee_id, calendar_id), job_openings (title, department_id, employment_type, description, status, positions_count, hiring_manager_id, salary_range JSONB, public_token, public_enabled), applicants (job_opening_id, name, email, phone, resume_attachment_id, cover_text, stage, rejected_reason, source, created_from: form/manual), applicant_stages (name, position, is_hired, is_rejected), interviews (applicant_id, scheduled_at, type, interviewers JSONB, scorecard JSONB, summary), allocations (user_id, project_id, hours_per_week, from_date, to_date) [12.4], compensation (employee_id, comp_type, amount, currency, effective_from, effective_to), overhead_settings (monthly_base, currency, working_hours_per_week, effective_from).

### 12.8. Permissions (People) and sensitivity

A separate domain, because HR data must not leak:

| Permission | Grants |
|---|---|
| `people.read` | The basic employee directory, org structure, public fields |
| `people.read_sensitive` | Personal fields (date of birth, address, documents), salary bands in job openings |
| `people.read_compensation` | Employee compensation (salaries, rates) – the narrowest |
| `people.write` | Editing cards, lifecycle |
| `people.manage_leave` | Configuring types/quotas/calendars |
| `people.approve_leave` | Approving requests outside the manager line |
| `people.recruit` | Job openings, applicants, interviews, hiring |
| `finance.read_costs` | Aggregated cost/salary reports and cost (in the finance domain, because it is money) |

System roles are updated: Owner/Admin – everything. The preset **Sales** role covers the sales workspace: `crm.*`, `deals.read/write`, plus read-only on projects and finance (a salesperson needs to see what is being delivered and what has been paid, but not change either). A new preset **HR** role (all of people.* except read_compensation, which is granted selectively). The **Finance** role gets `finance.read_costs` (sees aggregated salary costs, but not necessarily individual rates: read_compensation is granted separately). Member/guest – no people.* at all: the People section is absent from the navigation.

Every access to compensation and read_sensitive is additionally written to the audit (who looked at salaries).

---

## 13. Integrations

### 13.1. Git (GitHub, GitLab, Gitea)

**Purpose:** tasks are linked to real code: branches, commits, PRs/MRs are visible from the task, and statuses move automatically.

**Connection (integrations.manage):**
- GitHub: a GitHub App via the manifest flow – ordi creates the App in one click
  (POST the manifest → GitHub returns the credentials via a one-time code);
  the webhook and permissions are registered centrally, and installation webhooks
  create the connection themselves and sync the repo list. The App credentials
  (app id, private key, webhook secret) are stored in
  workspace_settings.integrations (secrets AES-GCM). The legacy path (OAuth
  app / PAT) keeps working.
- GitLab / Gitea (including self-hosted): instance URL + access token; a webhook on the repo/group with a secret.
- Credentials are encrypted (AES-GCM, key in env). Settings → Integrations: connection status, list of repositories, health of recent webhooks.

**Binding:** project_repositories: in the project settings a project admin binds one or more of the connection's repositories.

**Auto-linking (incoming webhooks `/api/v1/integrations/git/{provider}/webhook`, signature verification):**
- Parsing the `KEY-\d+` pattern in the branch name, commit messages, PR/MR title/description.
- A match found in a repository bound to the project → git_links (branch/commit/pr) on the task; the PR state is updated by events (open/merge/close).
- Task panel: a Git section: branches, recent commits, PRs with status and link.

**From the task side:** a "Copy branch name" button: generates `{type-prefix}/{key-42}-{slug}` (the pattern is configured on the project).

**Status automations (git_automation_rules, per project):** a configurable map: branch_created → In Progress; pr_opened → In Review (if the status exists); pr_merged → Done; pr_closed without merge → nothing/configurable. Executed via the bus (`git.pr_merged` → a handler in projects/automations.ts); the status change is written to activity with actor_type=integration.

**Reliability:** webhooks are put into pg-boss and processed idempotently (dedup by delivery id); manual resync of a task's links.

### 13.2. Outgoing webhooks

webhook_subscriptions (settings): URL + secret + a list of events from the catalogue in 3.3. Delivery by a worker: HMAC-SHA256 signature, retry with backoff (5 attempts), a delivery log with the response. This is the path for external systems (a Telegram bot, n8n) without polling.

### 13.3. Internal automations (built-in rules)

Not an automation builder (trade-off, 22), but a fixed set of configurable rules, each toggled on/off in settings:
- deal.won → suggestion to create a project/quote.
- project.completed → invoice suggestion when there is unbilled time.
- quote.accepted → conversion suggestion.
- git rules (13.1).
- invoice.overdue → reminder (11.6).
- cycle end date reached → suggestion to complete the cycle.
- applicant.hired → create an employee + start the onboarding checklist (12.3).
- leave_request submitted → notification to the manager; decision → to the employee (12.2).

---

## 14. Cross-cutting subsystems

### 14.1. Dashboard (home screen)

Widgets subject to permissions: My tasks today/overdue; the active cycle of my main project; receivables and overdue invoices (finance.read); deals by stage (deals.read); a feed of recent events (filtered by access). A single response from `/api/v1/dashboard`.

**Custom dashboards** (reference: Plane Dashboards). Besides the home dashboard: user dashboards with widgets on a grid (drag/resize). Widget: a configurable query of the form "for these entities, grouped by X, show metric Y": types bar / line / pie / number / table; sources: tasks (filters as in lists), invoices, deals, time; group by: status/type/priority/assignee/project/client/period; metric: count / sum (amount, estimate, duration). Dashboard visibility: private | workspace. Widget data is computed by the backend in a single endpoint with permissions enforced (accessibleProjectIds + the permission of the source's domain: a widget over invoices is not rendered without finance.read).

### 14.2. Command palette and search

`Cmd/Ctrl+K`: entities (companies, contacts, deals, projects, tasks by number/text, KB pages, invoices/quotes by number), actions ("Create…", "Go to…", "Start timer…"), recent items. Results are filtered by permissions (the search service accepts accessibleProjectIds/space ids). Backend: FTS + trigram, ranking: exact number > title > body.

### 14.3. Notifications

In-app (bell, read/unread, jump to the entity) + email duplication per type, set in the profile. Types: mention, assignment, comment on my task, status change of my task, quote accepted, payment, overdue, deadline today, git PR merged on my task, sales work digest.

The sales work digest runs hourly, but for each active human user with `crm.read` it is created at most once per their local date, and only within the local 08:00–18:00 window. The summary includes overdue, due today, waiting reply, nurture due and no next action; deal work is added only with `deals.read`. The ledger `sales_digest_runs(user_id, local_date)` also records an empty morning, so that later activity does not produce a second "morning" digest. The email copy is controlled by a separate preference `sales.work_digest`.

Background notification/reminder emails do not perform SMTP I/O inside the outbox consumer. The consumer atomically writes the notification and an idempotent `email_deliveries` row, and a separate worker sends it with retry and stale-claim recovery. Interactive document sends, where the user needs an immediate result, remain synchronous.

### 14.4. Activity log and sensitive data

Every service mutation writes a record: actor (user/agent/system/integration), action, diff (old/new values of the changed fields). An Activity tab on the company/deal/project/task/invoice; a global feed (audit.read) with filters by actor/type/period. Records are immutable.

A full diff is dangerous: without restrictions it would duplicate salaries, personal data and secrets into a permanent immutable table. Therefore:

- **Redaction registry.** For fields marked as sensitive (compensation.amount, employees.sensitive, salary_range in job openings, any fields under people.read_compensation/read_sensitive), the diff does NOT record values. Only the fact of the change is recorded: `field: "compensation.amount", action: "changed"`, without the old/new value. A reader of the history sees that the salary was changed, when and by whom, but not the amounts.
- **Tokens and secrets – never.** api_tokens.hash, webhook.secret, git credentials and passwords never get into the diff under any circumstances (excluded at the serialiser level, not just redacted): for them even the fact record contains no material.
- **Record sensitivity flag.** Records concerning HR/compensation entities have `sensitivity: sensitive`. This controls (a) visibility (such records in the general feed are visible only with people.read_sensitive/compensation, not to anyone with audit.read) and (b) the retention policy.
- **Retention policy.** Regular audit is kept indefinitely (an audit of business actions is valuable). Sensitive audit has a separate, shorter retention window (configurable, e.g. 24 months), after which the fact values beyond the term are cleaned up: minimisation of the sensitive trail. The very fact of access to compensation/sensitive fields (viewing, not only changing) is also written to the sensitive audit (who looked at salaries), as stated in 12.8.

Redaction is applied centrally in the layer that builds the diff (a single serialiser with a registry of sensitive keys), so a new sensitive attribute is covered by adding it to the registry rather than by edits across all services.

### 14.5. Files

Presigned upload to S3, attachment registration, a 25 MB limit, image/PDF previews, antivirus scanning is not implemented (trade-off), executable file extensions are blocked.

`/presign` returns `fileKey` together with a `keyToken` signature; `/register` refuses without this
signature. Otherwise registration would be a way to obtain a link to
any object in the bucket, not just the one that was just uploaded.

**Files inside rich text** (images in tasks, KB, descriptions) cannot
rely on the session: `<img>` does not send `Authorization`, and the desktop app works with a
bearer token from the origin `tauri://localhost` and has no cookie at all. Storing a presigned
S3 URL in the document is not an option either – it expires, and the document breaks
within an hour. So the same model applies as for invoices and client portals:
an unguessable token in the link. `GET /api/v1/files/{id}/{token}`, where the token is
an HMAC of the attachment id under `AUTH_SECRET`, never expires, and redirects to a fresh
presigned URL. The trade-off is explicit: whoever has the link sees the file without signing in
(just like a public invoice link). Rotating `AUTH_SECRET` invalidates all
links ever issued.

The document stores a **root-relative path**, not an absolute URL: the web app
resolves it against its own origin, the desktop app against the configured instance, so
moving to another domain does not break every image ever inserted.

### 14.6. Import/export

CSV import: companies, contacts, tasks (column mapping, dry run with an error report, transactional apply). CSV export: any list in its filtered state (the export permission of the corresponding domain). KB export: a Markdown archive of a space. Full backup (DB PITR + attachment replication) and RPO/RTO targets: section 19.2.

### 14.7. Settings (map of sections)

| Section | Contents | Permission |
|---|---|---|
| Workspace | Name, logo, details for PDFs, working days | settings.manage |
| Users | Invites, roles, deactivation | users.manage |
| Roles | Permissions matrix editor | roles.manage |
| Projects | Project types, templates, default workflow, task types (workspace), labels | settings.manage |
| CRM | Deal stages, company statuses (labels) | settings.manage |
| Custom fields | Registry by entity | settings.manage |
| Finance | Numbering, tax rates, expense categories, reminder rules, email templates, default currency | finance.settings |
| Time | Billable default, estimate units | settings.manage |
| People (HR) | Departments, positions, absence types and quotas, holiday calendars, recruitment stages, onboarding templates | people.manage_leave / people.recruit |
| Compensation and overhead | Overhead base, working hours/week, rates | finance.settings + people.read_compensation |
| Integrations | Git connections, outgoing webhooks | integrations.manage |
| API tokens | Your own tokens | anyone (their own) |
| Audit | Global feed | audit.read |
| Trash | Soft-deleted items, restore/hard delete | settings.manage |

### 14.8. Customisation (summary of capabilities)

Everything below is data, not code: task statuses per project (+ workspace default), task types (workspace + per project), project types, project templates (a full blueprint), task templates, recurring tasks, intake forms per project, KB page templates, page visibility, pipeline stages with probability, absence types and quotas, holiday calendars, recruitment pipeline stages, onboarding templates, custom fields of 8 types on entities (including employees/applicants), custom roles with a permissions matrix, saved views personal/shared/workspace, custom dashboards with widgets, document numbering format, email templates, reminder rules, git automations per project, branch name pattern, time rates per project/per user, overhead, PDF language per document.

---

## 15. REST API

### 15.1. Conventions

- Base `/api/v1`, JSON; auth: cookie or a Bearer token. Every route: guard(permission) or public().
- Resource CRUD + verb operations: `POST /invoices/:id/send`, `POST /quotes/:id/convert`, `POST /tasks/:id/move`, `POST /cycles/:id/complete`, `POST /time/timer/start|stop`.
- Cursor-based pagination; filters as flat query parameters; an `include=` parameter for loading relations selectively (task?include=assignees,labels,git_links).
- Errors `{error:{code,message,details}}`: 400 (Zod details), 401, 403 (with the code of the required permission), 404 (also for resources outside your access: no leaking of existence), 409 (version conflict: a mutation carries the known `version`, a mismatch returns the current state), 422 (domain rules).
- OpenAPI is generated from Zod (hono-openapi) and published at `/api/docs`: the contract for MCP and external integrations.
- SSE `/api/v1/stream` with permissions; public: `/i/:token`, `/q/:token`, `/portal/:token`, git webhooks.

### 15.2. Endpoints by domain (full list: OpenAPI)

core: auth/*, me (profile+permissions+memberships+notification preferences), users, roles, search, dashboard, dashboards (+widgets, +widget-data), notifications, attachments (presign/register), custom-fields, saved-views, webhooks, audit, stream.
crm: companies (+overview), contacts, leads (+convert), sales-work, sales-activities (+complete/+cancel), sales-message-templates, sales-sequences (+enroll/+stop), deals (+move), deal-stages, notes.
projects: projects (+members, +repositories, +templates apply/save), task-statuses, task-types, project-types, tasks (+move, +relations, +links, +duplicate, +transfer), drafts, task-templates, recurring-tasks, intake (+accept, +decline, settings; public form `/intake/:token`), comments, labels, cycles (+complete, +snapshots), me/tasks.
kb: spaces (+members), pages (tree, +versions, +restore, +lock, +export), templates.
time: entries CRUD, timer start/stop, rates, reports, unbilled.
finance: quotes (+send/accept-internal/convert/pdf), invoices (+send/cancel/duplicate/pdf/from-time), payments, credit-notes, recurring, expenses (+categories), tax-rates, reminder-rules, email-templates, finance/dashboard, finance/profitability (project/client/labor, only finance.read_costs).
people: employees (+lifecycle, +documents), departments, positions, leave-types, leave-requests (+approve/reject), leave-balances, leave-entitlements, holiday-calendars, job-openings (+public `/careers/:token`), applicants (+move/hire), interviews, allocations, compensation (finance.read_costs/people.read_compensation), overhead-settings, people/dashboard.
integrations: git connections/repositories, project bindings, automation rules, resync.

---

## 16. MCP server

The packages/mcp package: authentication with an API token, all calls go through REST (no direct database access at all); the agent's permissions = the token's scope, so "the agent can see finance" is decided the same way as for a person: by the token owner's role and the scope.

Tools (wrappers around 1-2 calls with concise descriptions and Zod schemas from shared):
- Reading: search (including the bodies of CRM notes), list_projects (a `key` filter – a project is found by its short code, e.g. CONTENT), get_project_schema (the project's statuses, task types, task labels, cycles and custom fields – the vocabulary the write tools accept), list_tasks (a date window by dueDate, status, labels, type, parent task, cycle, title substring and custom fields; the response is in calendar order), get_task (the full card: text, date, status, labels, custom fields, assignees, external links, comments and the current version), list_companies, list_contacts, list_deals, list_deal_stages, list_notes, list_custom_fields, list_users, list_kb_spaces, list_kb_pages, get_kb_page, get_company, get_contact, get_deal, get_company_overview, list_my_tasks, get_project_status, get_cycle_progress, list_overdue_invoices, get_receivables_aging, list_unbilled_time, find_kb_page. Each record can be read individually, and lists return customFields: whatever the agent has written, it must be able to read back without changing the record just to read it. list_* is the entry point for getting ids: the other tools accept projectId/companyId/dealId/stageId, which the agent no longer has to guess; statuses, types, task labels and cycles are also accepted by name, and an unknown name returns the list of existing ones. The responses of all tools are scrubbed: internal fields (version, deletedAt, templateSourceId) and secrets (portalToken) never reach the model's context – except `version` in the task tools, because that is exactly what the agent passes back in a write.
- Actions: create_project (name, key, type by name – the workspace default when omitted – client, lead, members, dates, summary, description; the caller becomes the project admin), create_task (the whole card in one call: title, text, date, status, type, labels, custom fields, links; parentId makes it a subtask, cycle puts it into a cycle), update_task (rewrites the card, including the parent task and cycle – null unlinks; the parent task must be from the same project and cannot be the task itself or one of its subtasks; expectedVersion from get_task – and someone else's edit is not overwritten, but a 409 with the current version is returned), upsert_task (create-or-update by the caller's own unique key: the key lives in a custom field, so re-running the same generation updates the same task instead of creating a second one; if the title, text, date or status was changed in Ordi after the last write – a refusal instead of overwriting, until force is passed), add_task_link (the trend source before publication, the permalink of the published post after; the same url a second time is a no-op), update_task_status, assign_task, comment_on_task, log_time, create_invoice_from_time, create_invoice_from_project, send_invoice, record_payment, send_payment_reminder, create_quote, create_note, update_note, create_company (refuses on a duplicate name/domain), update_company, create_contact, update_contact, create_deal, update_deal (ownerId – in both create and update, ids come from list_users), move_deal (together with a structured reason via customFields), create_custom_field and update_custom_field (require settings.manage in the scope; deprecated instead of deletion), create_kb_page, update_kb_page, request_leave, approve_leave, create_job_opening, move_applicant. In all update tools customFields are merged by key: editing one field does not erase the rest. Every write tool has a matching tool for reading and for rewriting (note, KB page, task): whatever the agent can write, it can read and correct, otherwise there would be no way to clean up duplicates and stale records.
- CRM sales loop: `list_leads`, `get_lead`, `create_lead`, `update_lead`, `get_sales_work`, `list_sales_activities`, `schedule_sales_activity`, `update_sales_activity`, `complete_sales_activity`, `cancel_sales_activity`, `convert_lead`, `list_sales_playbooks`, `save_sales_message_template`, `save_sales_sequence`, `manage_sales_sequence`. `schedule_sales_activity` accepts `templateId` and renders placeholders in the API; sequence enrollment schedules manual actions but does not send messages.
- Tool errors carry the API code (not_found, forbidden, version_conflict, validation_error) and the action that fixes it: a version conflict says to re-read the task via get_task and apply the change on top of the current version, a duplicate gives the name and ref of the existing record, missing access says exactly what the token's scope lacks.
- Reading (People/costs, only within the token's permissions): list_pending_leave, get_team_availability, get_recruitment_pipeline, get_project_profitability, get_labor_cost (the last two require finance.read_costs in the token's scope; without it the tool is unavailable).

Generic delete and irreversible administrative operations are not exposed via MCP. `cancel_sales_activity` is an explicit, audited lifecycle command for a planned activity, not a generic delete. All actions are written to activity with actor_type=agent (the Agent service user): the UI always shows what the agent did, with a diff.

### 16.1. Agent employees

Plan: `docs/plans/2026-09-05-001-feature-ai-agent-employees-plan.md`.

The MCP server gives an agent access; §16.1 gives it a workplace. An agent is a user with `actor_type = 'agent'`, a role, a runtime (Claude Code; Codex is registered as coming soon) and a list of allowed MCP connectors. It is added through the same "Add member" dialog as a person, added to projects through the same memberships, and assigned to tasks with the same assignee picker. The intelligence stays external – it is Claude Code via the Agent SDK, on the workspace's subscription or API key; ordi has no model of its own and does not become an AI product. What is new here is the loop: assigning a task becomes a run, and a run becomes a pull request.

- **Execution inside the deployment.** A worker in the API process (`AGENT_WORKER_ENABLED`, `AGENT_WORKER_CONCURRENCY`) picks up runs via `FOR UPDATE SKIP LOCKED`, clones the project's repository into `/data/agent-work/<runId>` with the GitHub App installation token, starts Claude Code and streams events into the task log. For production, moving the worker into a separate container from the same image is documented.
- **Claude access is a workspace resource.** One access (plus a fallback) for all agents, connected by a holder of the `agents.manage` permission in Settings → Agents: a subscription token from `claude setup-token` or an Anthropic API key – equally valid options. The secret is encrypted with AES-GCM, and the card shows who connected it: someone's personal plan is being spent, and that has to be visible.
- **Connectors go through a gateway.** The workspace keeps a library of MCP servers (a curated catalogue or a custom URL), and the ones an agent needs are switched on with checkboxes. In a run the agent gets only `ordi` and one entry per allowed connector, and all of them lead into the ordi gateway; upstream addresses, headers and tokens stay in the API process. OAuth 2.1 for connectors is performed by ordi itself (discovery, dynamic registration, PKCE, token refresh).
- **Permissions.** A new `agents.manage` permission (Claude access, agents, limits, agent connectors, cancelling runs), a preset `Agent` role (projects.read, projects.write, kb.read), project membership as the resource boundary, and an assignment policy per agent (`project_members` / `project_admins` / `agents_managers`), so that assigning work to an agent is a deliberate permission rather than a side effect of a dropdown.
- **Task loop.** The agent reports through comments, attaches the PR via `add_task_link` and moves the task to the `in_review` category – it never moves it to `done`. The task is closed by the existing `pr_merged` automation after a person has merged the PR. A person's comment on the task continues the same Claude session in the next run.
- **Security.** The child process gets a rebuilt environment (PATH, HOME, one credential, MCP timeouts) – without `DATABASE_URL`, `ENCRYPTION_KEY`, `AUTH_SECRET`, S3 and SMTP; the run token is minted at start and revoked at finish, with scope = the agent role's permissions; allowlists and denylists of tools; stored log events are scrubbed for known secrets. The blast radius is named plainly: the container, the agent's role in ordi, and write access to the repository via the installation token.

---

## 17. UX specification

### 17.1. Principles

1. Density without crowding: list row ~40px, Inter, one accent colour, semantic colours only for statuses/priorities.
2. Keyboard as a first-class citizen: Cmd+K palette; C new task; T start/stop timer; G then D/P/C/F/K navigation (dashboard/projects/clients/finance/KB); J/K through a list, Enter to open, E status, A assign, L labels. Hotkeys shown in tooltips and the palette.
3. Peek panels instead of page transitions (task, invoice, contact, time entry); a direct URL always exists.
4. Optimistic updates with rollback and a toast.
5. Empty states teach: a sentence + the primary action + a hotkey.
6. Modals only for quick creation and confirmations; editing inline/in a panel.
7. Permissions shape the interface: sections and actions without access are absent (not disabled), so that a member without finance.read does not see money anywhere in the navigation, tabs or widgets.

### 17.2. Navigation

```
┌───────────┬─────────────────────────────────────────┐
│ Dashboard │  Title + filters + view switcher        │
│ My        │  ┌───────────────────────────┬────────┐ │
│  tasks    │  │ List/Board/Calendar/      │ Peek   │ │
│ Clients   │  │ Timeline / cards / KB     │ panel  │ │
│ Deals     │  │                           │        │ │
│ Projects  │  └───────────────────────────┴────────┘ │
│  ├ KLD    │   [⏱ active timer: KLD-42 00:47]        │
│  └ APR    │                                         │
│ KB        │                                         │
│ Time      │                                         │
│ Finance   │  ← hidden without finance.read          │
│ People    │  ← hidden without people.read           │
│ ───────   │                                         │
│ Search ⌘K │                                         │
│ Settings  │                                         │
└───────────┴─────────────────────────────────────────┘
```

The sidebar collapses; active projects are pinned; a guest sees only their own projects and spaces. Mobile: the same screens, responsive, with bottom navigation; a separate mobile app is not developed.

### 17.3. Key screens

Dashboard; My tasks; Clients (list, card with tabs); Deals (kanban, list); Projects (list; project: tasks in 4 views + peek, cycles with burndown, a page tree with the editor, time, settings with the workflow editor, access, git); KB (spaces, tree, editor with versions); Time (my week, reports); Finance (dashboard, lists, invoice/quote editor: form on the left + live PDF preview on the right, project/client profitability with finance.read_costs); People (employees with a list and a lifecycle card, absence calendar and requests, recruitment kanban with applicant cards, HR dashboard); public pages (invoice, quote with Accept/Decline, portal, intake form, careers form); Settings (14.7); Profile.

### 17.4. States

Every list: loading (skeletons) / empty (instructive) / error (retry) / data. Long operations (PDF, import, export): server-side, with progress and the option to leave. Destructive actions: confirmation with the entity's name. A 403 inside a session (the role was changed): a "no access" screen with an explanation, not a blank white screen.

---

## 18. Desktop (Tauri)

Tauri 2 wraps the apps/web build; there is no separate UI code. Native features: a tray icon with a notification counter; OS notifications from SSE; a global quick-add hotkey (a small always-on-top window: a task or a timer); autostart; deep links `ordi://task/KLD-42`; an updater with signed releases from CI. Builds: macOS universal, Windows msi, Linux AppImage/deb. First launch: the API instance URL.

---

## 19. Non-functional requirements

### 19.1. Security

HTTPS everywhere (Dokploy proxy); passwords via Better Auth; API tokens stored as SHA-256 hashes; git credentials encrypted with AES-GCM. Zod at the boundary; parameterised queries; rich-text sanitisation at render time; CSP. CSRF protection for cookies; CORS allowlist (web domain, tauri://). Public tokens are 128-bit, rate limited and non-enumerable; 404 instead of 403 for other people's resources. Secrets only in env. RBAC invariants are covered by tests (section 20).

### 19.2. Reliability, backup and recovery

**Formal targets (mandatory requirements, not wishes):**
- **RPO ≤ 5 minutes** (maximum acceptable data loss). A plain nightly dump is not enough for this (loss of up to a day). Mechanism: continuous archiving / point-in-time recovery: WAL segments are streamed continuously to S3-compatible storage, plus a periodic base backup. This makes it possible to restore to any point in time with a loss of no more than a few minutes.
- **RTO ≤ 1 hour** (maximum time until work is restored). Mechanism: a documented and rehearsed runbook procedure: bring up a new Postgres instance, restore from the latest base backup + replay WAL up to the target point, restore attachments from the S3 bucket (it is replicated separately), switch the application over. The procedure is rehearsed quarterly with the actual RTO measured; if the measurement exceeds the target, it is a blocker.

**Attachment backups (S3):** separate from the DB, with object versioning and cross-region bucket replication; the RPO for attachments is determined by replication lag (close to zero).

**Queue/events:** the `events`, `processed_events` and dead-letter tables are inside the same DB PITR perimeter, so an event committed before a failure survives the restore (it is neither lost nor duplicated, thanks to processed_events).

**Other:** migrations are additive, run as a separate deployment step before traffic is switched; idempotent workers (reminder_log, webhook dedup, processed_events); `/healthz` (liveness), `/readyz` (DB reachable); integration with the existing monitoring (OneUptime) with alerts on dead-letter queue depth, WAL archiving lag and failed health checks.

### 19.3. Performance

List P95 ≤ 300 ms at target volumes (indexes on filters, accessibleProjectIds in a single query); first SPA load ≤ 2 s, route-based code splitting; PDF ≤ 3 s; search ≤ 200 ms.

### 19.4. Observability

pino JSON logs with request_id and actor; metrics: per-route latency, queue depth, worker errors, webhook delivery; Sentry for the frontend and backend.

### 19.5. Localisation

UI in uk/en (i18n keys from day one); Intl for dates/numbers/currencies; per-document language for PDFs.

---

## 20. Testing

- **Unit (Vitest):** status matrices (invoice, quote, tasks, leave_request, applicant), money (totals, taxes, discounts, partial payments, credit notes, overpayment), cost (cost_rate snapshot, overhead per hour, project/client margin, internal project as pure cost without revenue), number sequences, aging, burndown snapshots, leave balances (accrual, carry-forward, deduction/refund), git mention parser, RBAC resolver, building custom-field filters/sorting from the registry (validating op against the type), diff redaction serialiser (sensitive fields without values, tokens excluded entirely).
- **API integration (testcontainers + Postgres):** route contracts; **permission matrix**: for each seeded role, key endpoints are run for 200/403/404 (generated from the permissions catalogue: a new permission without a test fails CI); **sensitive-data isolation**: member/guest do not see people.* anywhere (navigation, search, API, dashboard widgets); compensation is unavailable without people.read_compensation, cost reports without finance.read_costs; the sensitive audit is invisible without the corresponding permission; every access to compensation writes an audit entry; **version locking** (a concurrent UPDATE with a stale version → 409); **internal projects** (kind=internal without company_id does not leak into CRM/aging/profitability revenue; an invoice for an internal project is rejected); resource access (a private project is invisible to a non-member, including in search, SSE and the dashboard); webhooks with signatures.
- **Event processing (outbox):** idempotency (redelivery of the same event_id does not duplicate the effect), retry→dead-letter once retries are exhausted, per-aggregate ordering (events of one aggregate_id are processed sequentially), replay from the DLQ.
- **E2E (Playwright):** login; client → deal → won → project from a template → tasks across the board → cycle; time → invoice from time → sending → partial and final payment; quote → accept on the public page → conversion; KB: page, version, restore, task mention; job opening → applicant → hire → creating an employee with onboarding; leave request → approval → balance deducted; a member does not see the People and Finance sections; a git webhook (mock) moves the status.
- **DR rehearsal (during hardening):** a restore run from PITR + attachments, measuring the actual RPO/RTO against the targets in 19.2.
- CI: lint, tsc, tests, image and Tauri builds; deployment of tagged releases to Dokploy; demo data seed.

---

## 21. Delivery plan

No MVP: everything goes into 1.0. Ordered by dependencies; each stage is a working increment on staging:

1. **Foundation:** monorepo, CI, core schema, auth, **full RBAC** (catalogue, roles, guards, matrix test), API and SPA skeleton (navigation, command palette, design system), deployment.
2. **CRM:** companies, contacts, notes, activity, lists/record card, saved views, search.
3. **Projects, core:** projects, workflows, types, tasks (List/Board/Calendar/Spreadsheet), drafts, inline quick-add, subtasks, comments, labels, links, My tasks, notifications, members/visibility.
4. **Projects, extensions:** cycles with burndown, relations/dependencies, Timeline, project and task templates, recurring tasks, intake (form + IMAP), move/duplicate.
5. **KB:** spaces, tree, editor, versions, mentions/backlinks, templates, export.
6. **Time:** timer, entries, rates, reports.
7. **Finance:** full invoice cycle, PDF, public pages, payments, credit notes, quotes with accept, recurring, reminders, expenses, invoice from time, portal, finance dashboard.
8. **People (HR):** employees and lifecycle, leave/absences with approvals and balances, holiday calendars, recruitment (job openings, applicants, interviews, hiring), onboarding checklists, HR dashboard, the people.* permissions domain.
9. **Costs & profitability:** compensation and overhead, cost_rate on the time entry, project/client cost and profitability, labor-cost and utilization reports, finance.read_costs.
10. **Deals + starter dashboard + custom dashboards + import/export.**
11. **Integrations:** git (all three providers), automations, outgoing webhooks, SSE realtime.
12. **MCP server.**
13. **Desktop:** tray, notifications, quick-add, updater.
14. **Hardening:** e2e completeness, backup/restore run, security audit (including RBAC fuzzing and verification of HR/costs data isolation), i18n completeness, documentation (operator: deployment/env/backups; user: a short guide).

1.0 criterion: the agency runs its clients, deals, all projects, documentation, time, staff (headcount, leave, hiring), cost and profitability, and 100% of invoicing in the system; the external tracker/CRM/wiki/timer/billing/HR spreadsheets are retired.

---

## 22. Deliberate trade-offs (residual)

| Decision | Trade-off | Why it is acceptable |
|---|---|---|
| No online payment on public pages | Payment by bank transfer outside the system, recorded manually | The payments model is ready; a payment provider = a future module with no schema change |
| No accounting and no legal e-invoicing | Compliance lives in external tools | A deliberate boundary; integration via events/webhooks if needed |
| Finance without per-record ACLs | Access to a single client's finances cannot be granted | Finance role or nothing; per-client financial access sharply complicates the model for the sake of a rare case |
| Lightweight token-based portal, no client logins | The client has no authenticated personal account | The portal token covers 90% of the value; a full client login = a separate large module |
| Built-in rules instead of an automation builder | Arbitrary scenarios cannot be drawn in the UI | A builder = the most expensive feature in its class; arbitrary scenarios are built externally via webhooks + API (n8n/agent) |
| Contact N–1 company | A person at two clients = two records | A rare case; many-to-many everywhere is more expensive |
| Optimistic locking (version) + soft-lock instead of CRDT | No simultaneous co-editing of the same text | Team ≤ 50; a version conflict (409) + soft-lock on KB/descriptions cover the real risk of lost work |
| One PDF template | No template builder | A brand template is enough; Invoice Ninja's builder = the least valuable feature here |
| No late fees | Late fees are not charged automatically | Reminders cover the case; late fees are rare in our contracts |
| pg-boss instead of Redis | The queue shares resources with the DB | Volumes are tiny; one less infrastructure component |
| No Epics / Initiatives / Modules / Milestones / Teamspaces (Plane) | No grouping levels above project and cycle | At agency scale, project + cycle are enough; if needed, an epic can be added as a grouping table on top of tasks without changing the core |
| No approval workflows or transition scripts (Plane Business) | A status transition is not blocked by rules and does not run arbitrary scripts | A governance feature of large organisations; our automations cover the typical post-actions; review trigger: approval roles appear |
| Fixed task relation types | No custom relation types (Mitigates, Supersedes…) | blocks/duplicates/relates cover agency cases; the type is an enum, extended by a migration |
| No payroll engine (People) | ordi does not calculate salaries, generate payslips or compute taxes | Accounting and legal territory (the same boundary as Finance 11.1); salary is present as a cost rate for analytics; trigger: a decision to run payroll in-house → a separate payroll module or an integration |
| Attendance/shifts/geo check-in (Frappe HR) not in 1.0 | No working-time tracking via check-ins or shift schedules | The agency tracks time through time tracking (the Time module), not a clock-in/clock-out timesheet; attendance can be added as a separate People submodule without changing the core |
| Performance/appraisals (Frappe HR) not in 1.0 | No appraisal cycles or KPIs | Outside the initial need; added as tables in People |
| Cost/profitability is management analytics, not accounting | No double-entry bookkeeping, P&L or bank reconciliation | A Productive-class model based on cost rate + hours; accounting is external |
| No per-record access to salaries | Access to the compensation of selected people cannot be granted selectively | people.read_compensation = all or nothing; selective access complicates the model for the sake of a rare case |
| A global total order of events is not guaranteed | No strict cross-aggregate processing order (per-aggregate only) | A global order is expensive and not needed; events of one project/client are serialised relative to each other, and handlers do not rely on cross-aggregate order (3.3) |
| No predictive capacity planning (Resourcing) | No placeholders for not-yet-hired people and no scenario forecasting | Actual workload and utilisation are available (12.4, 11.10); predictive planning can be added with tables without changing the core |

Every row of the table has an extension path that does not break the data model: that is the criterion by which a trade-off is allowed.

---

## 23. Glossary

- **Permission**: an atomic right of the form domain.action; **role**: a configurable set of permissions; **membership**: access to a specific resource (project, space).
- **Peek panel**: a side panel with details shown over a list, without navigating away.
- **Outbox**: an event is written to the DB in the same transaction as the data and processed asynchronously by a separate relay.
- **At-least-once**: a guarantee that an event is delivered at least once (a repeat is possible), which is why handlers are idempotent.
- **Dead-letter**: the state of an event that failed to process after all retries: set aside separately, not lost, with manual replay.
- **Per-aggregate ordering**: events with the same aggregate_id are processed sequentially; different aggregates in parallel; there is no global order.
- **Optimistic locking**: control of concurrent editing through a version field (not row locking): a stale version → 409.
- **PITR (point-in-time recovery)**: restoring the DB to any point in time from a base backup + WAL.
- **RPO / RTO**: max. acceptable data loss / time to recovery (here 5 min / 1 h).
- **Redaction**: hiding the values of sensitive fields (salary, personal data) in the audit log: the fact of the change is recorded without the value itself.
- **Fractional indexing**: fractional positions for inserting between neighbours without renumbering.
- **Aging**: a breakdown of receivables by age (0-30/31-60/61-90/90+).
- **Burndown**: a chart of a cycle's remaining scope by day (daily snapshots).
- **Backlink**: a reverse link: where an entity is mentioned (pages, tasks).

---

## Appendix A. Reference coverage map

Sources studied: docs.plane.so (core concepts, work items, nested pages, dashboards, analytics), plane.so (work-items, work-item-types, wiki, pro, changelog 2025-2026), twenty.com and reviews of Twenty 2.x, invoiceninja.com and feature reviews, frappe.io/hr and frappe/hrms (leaves/attendance/recruitment/payroll modules), productive.io (cost rates, overhead, profitability, agency management). Marks: ✅ included, 🔧 adapted to ordi's scope, ❌ deliberately excluded (rationale in section 22 or here).

### A.1. Plane → ordi (Projects, KB)

| Plane feature | ordi | Comment |
|---|---|---|
| Work items: title+state minimum, multiple assignees, priorities, labels, dates, estimates | ✅ | 8.3 |
| Custom states with categories (backlog/unstarted/started/completed/cancelled) | ✅ | categories backlog/todo/in_progress/done/canceled, 8.2 |
| Work item types with icons/colours | 🔧 | types exist; we do not do per-type property sets or per-type workflows: custom fields are shared per entity |
| 5 layouts: List, Board, Calendar, Spreadsheet, Gantt | ✅ | 8.3 |
| Views (saved) at project and workspace level | ✅ | saved_views personal/shared/workspace |
| Sub-work items | ✅ | tree up to 5 levels deep |
| Relations vs dependencies, connectors in Timeline, broken dependencies | ✅ | 8.3 |
| Custom relation types | ❌ | section 22 |
| Drafts (autosave of unfinished items) | ✅ | 8.3 |
| Links, attachments, linked pages | ✅ | links 8.3, attachments 14.5, linking pages through mentions 9.3 |
| Activity tabs (All/Comments/History/Worklogs) | ✅ | 8.3 |
| Quick-add inline row, peek side/modal/full | ✅ | 8.3, 17.1 |
| Copy branch name | ✅ | 13.1 |
| Cycles: burndown, carrying over unfinished items, active cycle | ✅ | 8.4 |
| Cycle velocity comparison | ❌ | agency cycles are irregular; snapshots exist, the metric can be added as a dashboard widget |
| Modules / Epics / Initiatives / Milestones / Releases / Teamspaces | ❌ | section 22: levels above project+cycle |
| Intake: configurable form, embedding, email capture, accept/decline triage | ✅ | 8.6 |
| Work item templates, recurring work items | ✅ | 8.7 |
| Pages/Wiki: nested pages, versions with diff, locks, page-level visibility | ✅ | 9.3 |
| Inline comments in the page text | 🔧 | comments as a thread below the page; we do not do inline anchors |
| Real-time co-editing of pages | ❌ | soft-lock + versions, section 22 |
| Embeds (Figma/Loom/Draw.io), LaTeX | 🔧 | images, files, code; iframe embeds and LaTeX are not in 1.0: they can be added as Tiptap extensions without changing the model |
| Converting notes into tasks | ✅ | 9.3 |
| Custom dashboards with widgets | ✅ | 14.1, simplified widget model |
| Analytics section | 🔧 | covered by custom dashboards and the finance dashboard |
| Workflows/approvals, pre-validation and post-action scripts | ❌ | section 22; typical post-actions: built-in automations 13.3 |
| Publishing pages/views externally | 🔧 | invoices/quotes/the portal/the intake form are published externally; KB pages are not published externally |
| Plane AI features (Pi, agents) | 🔧 | there is no built-in model: an MCP server (16) plus agent employees hosted by the platform, while the intelligence stays external – Claude Code via the Agent SDK on your subscription or key (16.1) |
| Importers (Jira etc.) | ❌ | CSV import is enough: migration from other systems is a one-off, done with a script through the API |

### A.2. Twenty → ordi (CRM)

| Twenty feature | ordi | Comment |
|---|---|---|
| Companies / People / Opportunities | ✅ | companies / contacts / deals |
| Custom objects (new entities at runtime) | ❌ | the hardest rejection decision: a metamodel = a different class of complexity; custom fields on 7 entities cover agency cases; a new entity = a migration (cheap in a monostack) |
| Custom fields via the UI | ✅ | 8 types, registry, 5.2 |
| Views: filters, sorting, kanban/table | ✅ | saved_views, lists, deals kanban |
| Workflows (trigger-action) | 🔧 | built-in rules 13.3 + outgoing webhooks instead of a builder |
| GraphQL/REST API + webhooks | 🔧 | REST + webhooks; GraphQL: a trigger in the 2.x table |
| Native MCP | ✅ | 16 |
| Email sync and calendar | ❌ | deep email integration is outside the 1.0 scope; communication with the client is tracked through notes and activity; review trigger: a real need for correspondence in the record card |
| Row-level permissions (Enterprise) | 🔧 | resource access on projects/spaces; per-record ACL in CRM/finance: section 22 |

### A.3. Invoice Ninja → ordi (Finance)

| Invoice Ninja feature | ordi | Comment |
|---|---|---|
| Invoices: line items, taxes, discounts, statuses | ✅ | 11.3 |
| Quotes with accept/decline and conversion | ✅ | 11.2 |
| Partial payments, credit notes | ✅ | 11.4 |
| Recurring invoices with auto-send | ✅ | 11.5 |
| Scheduled reminders, email templates | ✅ | 11.6 |
| Late fees | ❌ | section 22 |
| Client portal with login | 🔧 | token portal 11.8 without authentication; full portal: section 22 |
| Online payments (Stripe and 40+ gateways) | ❌ | space reserved on the public page; a separate future module |
| Expenses, categories | ✅ | 11.7 |
| Vendors, purchase orders | ❌ | the procurement cycle is outside the agency's needs |
| PDF template builder | ❌ | section 22: one brand template |
| Time tracking → invoice | ✅ | Time module, 10.3 |
| Multi-currency | 🔧 | per-document currency without conversion, 11.3 |
| Tax reporting / e-invoicing | ❌ | scope boundary 11.1 |

### A.4. Frappe HR → ordi (People) and Productive → ordi (costs/profitability)

| Frappe HR feature | ordi | Comment |
|---|---|---|
| Employee lifecycle (onboarding → promotions/transfers → exit) | ✅ | 12.1, onboarding checklists auto-create tasks (as in Frappe) |
| Leave types and policies (carry-forward, earned, LWP, half-day, encashment) | 🔧 | types/quotas/carry-forward/half-day exist (12.2); encashment (cash compensation for unused leave) – no, because that is payroll |
| Leave requests with approvals, balances, calendar | ✅ | 12.2 |
| Regional holiday calendars | ✅ | 12.2 |
| Recruitment: job openings, applicants, interviews, hiring | ✅ | 12.3, public careers form |
| Attendance, shifts, roster, geo check-in | ❌ | section 22: the agency tracks time through Time, not a timesheet |
| Payroll: salary structures, components, slips, taxes, regional compliance | ❌ | section 22: accounting and legal territory; salary is present as a cost rate (12.5) |
| Performance/appraisals, KPI | ❌ | section 22 |
| Employee expense claims | 🔧 | covered by expenses in Finance (11.7) linked to an employee |
| Employee self-service (mobile PWA) | 🔧 | self-service through the same SPA/desktop app (balances, requests); there is no separate mobile app |
| Fleet/training/loans modules | ❌ | outside the agency's needs |

| Productive feature | ordi | Comment |
|---|---|---|
| Employee cost rate (from salary and standard hours) | ✅ | 12.5, versioned |
| Overhead per hour (facilities + internal expenses) | ✅ | 12.5, optional |
| Project profitability (revenue − cost, margin %) | ✅ | 11.10 |
| Client profitability | ✅ | 11.10 |
| Labor cost reports (by person/team/project/client) | ✅ | 11.10 – this is exactly the "payroll costs" |
| Utilization (billable %) accounting for absences | ✅ | 11.10 + 12.2 |
| Custom rate cards (rates by service/client) | 🔧 | per-project/per-user rates (Time); we do not do full service-based rate cards |
| Budgets and budget burn with alerts | 🔧 | project estimates and profitability exist; there are no separate budgets with burn alerts in 1.0 – trigger: a need for fixed-budget control |
| Resource scheduling / forecasting with placeholders | 🔧 | lightweight Resourcing (12.4) without forecast placeholders |
| Native MCP server | ✅ | 16 |
| Xero/QuickBooks accounting sync | ❌ | accounting is external; connected through export/webhooks |
