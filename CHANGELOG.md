# Changelog

Release notes for each version live in [`docs/releases`](docs/releases) and are
published to [GitHub Releases](https://github.com/romirom11/ordi/releases).

## Unreleased

- Removed the structured research import. It froze one external research
  tool's JSON shape into the database schema and the public API, and
  carried a hardcoded list of job-board and company-registry hostnames in
  the service layer. Gone with it: `POST /leads/import`,
  `POST /leads/import/preview`, the `import_research` and
  `preview_research_import` MCP tools, the "Import research" dialog, the
  `research_batches` table, and the `leads` columns that only ever held
  import payloads (`research_batch_id`, `dimensions`, `secondary_sources`,
  `raw_research`).
- Leads themselves are unchanged. They are created through `POST /leads`,
  the MCP `create_lead` tool or the New lead dialog, and keep their
  qualification notes (score, signal, pain signal, evidence, why it fits,
  why now, source, suggested channel, opener, caution), which stay
  editable by hand.
- A stale edit to a client, contact or deal now answers 409 instead of
  reporting success and discarding the change. The version filter alone
  matched zero rows without anyone noticing, and PATCH returned 200 with
  the other writer's data. Each update also commits with its audit entry
  in one transaction, so a rejected contact edit can no longer demote the
  previous primary contact on its way out.
- Deleting a lead cancels its planned activities and stops its active
  sequence, like every other way a lead stops being worked. The
  enrollment used to stay `active` forever on a lead nothing could reach,
  and kept counting toward the sequence's active total.
- A pipeline stage may be named anything again, "Lead" included. The ban
  was a guard for the one-off 0020 migration that got promoted into
  permanent validation across the shared schema, the API and the UI. The
  `leads.legacy_deal_id` marker that migration used is dropped too.
- Web CRM reads its status and activity-type enums from `@ordi/shared`
  instead of keeping copies, so an enum added on the server reaches the
  dropdowns. Fixes a side effect of the drift: the New lead dialog
  offered "nurture", which the API always rejected because the form has
  no return-date field.
- `GET /deals` is bounded and paged (`limit`, `cursor`, default 100, max
  200). It used to return every deal in the workspace on every request.
- `GET /companies` honours the `nextCursor` it already returned. Nothing
  consumed it before, so passing it back replayed the first page - and
  the MCP `list_companies` tool hands that cursor to the model. Both
  lists page on the ULID primary key: ids sort by creation time and
  compare as exact text, where a `createdAt` cursor silently lost the
  microseconds Postgres keeps and matched no row.
- `POST /companies/:id/portal` verifies the company exists before minting
  a token and records the rotation in the company's history. It used to
  update by id and report a fresh token for a deleted or invented id, with
  nothing in the audit trail. The token never enters the audit diff.
- Opening a CRM URL directly without the permission for it shows a plain
  "no access" page instead of a screen whose every request 403s. The
  sidebar already hid those sections; the direct URL, a restored tab and
  a bookmark went straight through. The Pipeline tab is hidden without
  `deals.read`.
- CRM internals split up, no behaviour change: `service.ts` was a
  1100-line pile of companies, contacts, deals, leads, activities and
  conversion, and is now a re-export surface over `companies.ts`,
  `deals.ts`, `leads.ts`, `activities.ts` and `common.ts`. Web
  `crm/shared.tsx` lost its ~470 lines of dictionary to `crm/i18n.ts`.
  Every `input: any` in the CRM service is typed from its Zod schema.

## v1.16.0

- CRM is a sales workspace. `/crm` opens on Work: overdue, due today,
  waiting for reply, nurture due and no next action, built from planned
  activities and lead state, owner-aware, with exact totals and
  unassigned records included.
- Leads are separate from the pipeline - an unqualified pursuit with its
  own lifecycle (new → needs review → ready → waiting for reply → engaged
  → nurture → converted, plus disqualified and no response) and its
  structured research. The pipeline holds qualified deals only.
  Converting keeps company, contact, research, notes, files, history,
  owner and next action. The legacy Lead deal stage is removed; existing
  unqualified rows migrate into Leads for review without losing context.
- Sales activities are first-class: planned, completed or cancelled, with
  type, owner, due date, outcome and context. Completing one records the
  outcome, moves the lead and schedules the follow-up in one step. Every
  transition commits with its audit record in a single transaction.
- Structured research imports with a preview: companies matched by
  domain, leads deduplicated, exclusions retained with their reason
  instead of becoming active company records.
- CRM → Playbooks: reusable message templates with `{{companyName}}`,
  `{{contactFirstName}}`, `{{contactName}}`, `{{ownerName}}`,
  `{{leadTitle}}`, and sequences of manual steps that plan the next
  action. They never send email or LinkedIn messages.
- Due today means due today where the seller is: the user's timezone
  travels in the actor context and day boundaries are local and
  DST-safe.
- A sales work digest once per local working morning, toggleable in
  Profile → Notifications, with a run ledger so a quiet morning does not
  produce a second digest that afternoon.
- Notification email is durable: consumers enqueue in the same
  transaction as the change and return, a worker sends with a 1m/5m/30m/
  2h/12h backoff, an idempotency key collapses a double enqueue, an
  abandoned claim is reclaimed after five minutes, and notifications
  carry a dedupe key.
- MCP can plan a content calendar: `get_project_schema`, `list_tasks`
  over a due-date window, `get_task` with body, comments and version,
  `create_task` / `update_task` / `upsert_task` / `add_task_link`.
  Writes carry the version they read (409 rather than a silent
  overwrite) and `upsert_task` refuses to replace a post edited by hand
  unless forced. The API gained `dueFrom`/`dueTo` and a `label` filter
  that narrows.
- MCP reaches sales work too: leads, activities, research import,
  conversion and playbooks, through the same permissions as the UI.
- A deleted deal no longer blocks deleting the client; the guard counted
  soft-deleted rows. It names what blocks with counts.
- Editing a note saves once, not twice. Long KB titles wrap instead of
  being clipped. Mixed-currency totals no longer sum into one number.
  Text written through MCP keeps its paragraphs.

## v1.15.0

- New project is a composed sheet rather than a form with chips bolted on:
  workspace trail, the project icon beside a borderless title, a summary,
  one chip row for key, type, client, visibility, priority, lead, members,
  start, target and labels, and a description in the same sheet.

## v1.14.0

- Changing a project's visibility no longer crashes the page: a spinner
  rendered as a block element inside a paragraph, which WebKit (the
  desktop app) turns into a NotFoundError when it unmounts. Spinners are
  inline elements now, so the class of bug is closed.
- New projects choose visibility, lead, members and dates in the create
  dialog, and default to private.
- My tasks separates Assigned from Created; a task filed for someone else
  is no longer listed as work to do. `/me/tasks` returns `created` in
  place of `createdUnassigned`.
- Clicking a notification marks it read.
- Profile photo upload, and a timezone picker instead of a typed string.
- MCP: update_note, list_kb_spaces / list_kb_pages / get_kb_page /
  update_kb_page, list_users, and ownerId on create_company and
  create_deal. Everything an agent writes it can now read back and
  correct.

## v1.13.0

- Workspace projects and KB spaces answer to the role, not only to
  membership: `projects.read` views a workspace project and
  `projects.write` works and administers it, `kb.read` views a workspace
  space and `kb.write` edits it. Private resources stay members-only.
  A role with kb.read + kb.write could previously not create a page
  anywhere, and every refused write surfaced as "not found".
- A level the actor lacks on a resource it can see is a 403 naming what is
  missing; 404 stays for resources outside visibility.
- Resource access reaches the places that read project-owned rows
  directly: the home activity feed and "my tasks", the per-entity audit
  trail (which had no check at all), Resourcing allocations, and KB pages
  in search.
- Requesting leave works. The form never sent an employeeId and the API
  required one, so every submission failed; it is optional now and means
  the requester. Leave writes authorize per request (own / manager /
  approver) instead of requiring people.read, and the list finally names
  the person and the type instead of rendering "–".
- Settings → Leave types: the absence vocabulary and each type's
  behaviour - paid, approval, balance and quota, half days,
  carry-forward. The API had the CRUD; nothing in the app reached it.
- MCP: single-record reads for companies, contacts and deals, customFields
  in every list, update tools for all three, list_notes plus notes in
  search, a duplicate guard on create_company, a structured reason with
  move_deal, and update_custom_field for retiring a definition.
- customFields merge by key on PATCH for every entity that has them -
  setting one field no longer erases the rest.

## v1.12.0

- CRM record pages took the shape of the project and task records: a
  one-line identity header, content at full width, and a properties rail
  pinned to the right edge that carries every field plus files. The
  toolbars and property chips left the header, since each duplicated a
  section's action or repeated the rail.
- Empty sections collapse to one line instead of a full-height empty
  state, so a fresh client is no longer three screens of nothing.
- The client card gets an activity trail, sharing one component with the
  project feed instead of a second implementation.
- The project overview lists the leads sold into it, with the open
  pipeline total. Aimed at product projects, which collect leads from
  many companies at once. Gated independently on deals.read (the section)
  and crm.read (naming the client), so project membership alone never
  exposes another client's deals.
- Task and project labels became two vocabularies; the write paths reject
  a label from the wrong side instead of dropping it silently, and one
  picker with search and inline creation replaced the two that existed.
- Repository bindings store the repository rather than GitHub's own id,
  which also fixes webhook delivery failing to link branches and pull
  requests to tasks.
- GitHub App and OAuth callbacks stopped doubling /api, so creating the
  app from the manifest now exchanges its one-time code.
- A project's client and type edits persist; PATCH used to drop both keys
  and return 200.

## v1.11.0

- CRM record pages became fully workable: company properties (domain,
  billing email, currency, payment terms) edit inline; contacts get
  edit/delete and a click-to-toggle primary star; notes edit in place
  Notion-style (click the text, click away to save) and delete with
  confirm.
- Files on companies and deals: upload, download and delete through the
  standard presigned-S3 path, with per-entity permissions and activity
  records.
- Custom fields on the deal page are editable, each type with its own
  control (select/multiselect menus, checkbox toggle, DateField dates,
  user picker, click-to-edit text/number/url).
- A company's Projects card can create a project in place (client
  preselected) or link an existing one; modal state never lives in the
  URL, so the back button no longer resurrects dialogs.
- Detail tabs show the record they hold (client name, deal title,
  invoice number) instead of a generic module name.
- Tooltips render through a portal clamped to the viewport; property
  values wrap instead of truncating; the deal page uses the app's
  DateField (the last raw date input is gone).
- MCP write tools decode HTML entities, so agent-scraped text like
  "Co-founder &amp; CEO" stores clean.

## v1.10.0

- GitHub App integration: create the app with one click via a manifest
  (webhook URL, permissions and events pre-registered, credentials
  delivered through the one-time conversion code), pick repositories on
  GitHub's own install screen, and the installation webhooks create the
  git connection and keep its repo list in sync. RS256 app JWT with
  cached installation tokens, GHE supported. Uninstall revokes but keeps
  bindings, so a reinstall revives the connection.
- Webhook signature verification is a real HMAC now. It used to be
  sha256(secret+body), so GitHub's X-Hub-Signature-256 could never
  verify and standard receivers could not verify ordi's outbound
  webhooks.
- Branch names link to tasks case-insensitively: ordi's own "Copy branch
  name" lowercases the task key, and such branches never linked before.
  Free-form text stays uppercase-only, so "utf-8" is not a task ref.

## v1.9.0

- Deals link to the project they sell into: `deals.project_id` is a real
  FK (not a custom-field string), so a SaaS lead and a services lead are
  separable. Pipeline board grows project filter chips, kanban cards show
  the linked project, the deal page and new-deal dialog get a project
  picker, and MCP `create_deal` / `list_deals` carry the link.
- Multi-select in lists: the CRM client table and project task lists get
  row checkboxes (shift-click for ranges), with bulk status/priority
  changes and deletes. Partial failures are reported honestly.
- Tabs reorder by dragging; the order persists.
- Drag & drop works in the desktop app again: Tauri's default file-drop
  interception (`dragDropEnabled`) was swallowing HTML5 drag events,
  which had silently broken the pipeline board, the task board, sidebar
  nav reordering - everything draggable.
- CRM breadcrumbs follow the app-wide pattern (parent trail only, no
  title echo) and long deal titles truncate instead of wrapping.
- New living feature registry in `docs/features.md`: backlog, in flight,
  shipped.

## v1.8.0

- Deals get a detail page (`/deals/:id`): editable title, stage dropdown,
  company link, owner, amount/currency/expected close, custom field values,
  deal-scoped notes and an activity trail. Kanban cards and the company's
  deal list open the deal now; CRM breadcrumbs become full clickable trails.
- MCP gains the full CRM surface: `create_company`, `create_contact`,
  `create_deal` plus `list_contacts`, `list_deals`, `list_deal_stages` -
  agents no longer need ids they cannot discover, and stage ids for
  `move_deal` are finally obtainable.
- MCP agents can define custom fields (`create_custom_field`,
  `list_custom_fields`; requires `settings.manage` in the token scope) and
  set their values via `customFields` on the create tools.
- Agent-authored notes, task comments and KB pages keep their line
  structure: blank lines become paragraphs, single newlines become hard
  breaks - no more single-paragraph walls of text.
- The home dashboard's activity feed filters by domain permissions: each
  entity type maps to the permission required to see it, own actions stay
  visible. A Member without `finance.read` no longer sees that payments
  were recorded.
- Audit gaps closed: CRM notes and custom-field definitions now write
  activity records (fact-only for note bodies) from every client, web and
  MCP alike.

## v1.7.0

- New MCP tools `list_projects` and `list_companies`: the entry point for
  obtaining ids. Until now every project/company tool demanded an id that no
  tool could produce - an agent could work with a project only if it already
  knew the project. Both return compact rows and pass through the same
  permission filters as the web app.
- Global search covers projects: name or key match ("Solovei" or "SOL"),
  ranked key-first, limited to projects the actor can access. The `search`
  tool description now states what it matches and points to the list tools
  for enumeration.
- Every MCP tool response is scrubbed before it reaches the model: lock
  counters, soft-delete markers - and `portalToken`, the client-portal
  secret the raw company row used to expose into an agent's context.

## v1.6.1

- Every OAuth step logs its outcome: registrations, issued tokens, and every
  rejection with the exact failing check (unknown client, redirect_uri not
  registered, expired code, PKCE mismatch, malformed exchange). "Authorization
  failed" in an MCP client is now diagnosable from the API logs instead of
  being a silent 400.
- The OAuth state parameter accepts up to 4096 characters. It is the client's
  opaque blob echoed back verbatim; the old 512 cap could reject legitimate
  clients whose state is a signed payload.
- CI walks the full MCP OAuth flow against the booted image on every build:
  register with Claude's exact registration body, approve as a signed-in
  user, exchange the code with PKCE, then initialize and tools/list over
  Streamable HTTP. A release cannot ship if connecting a client is broken
  anywhere along that path.

## v1.6.0

- One container is the whole application: the API serves the built web app
  itself (SPA fallback, immutable cache on hashed assets, build-time gzip,
  API paths never swallowed by the HTML fallback). nginx is gone from the
  deployment story - point the domain at api:3000 and that is all. This
  removes the routing boundary that kept breaking real deployments, most
  visibly MCP clients failing to connect because /.well-known/ never reached
  the API. The nginx web image remains for one more release (deprecated,
  upstream configurable via API_UPSTREAM).
- APP_URL decides the scheme for its own host, ahead of X-Forwarded-Proto: a
  Cloudflare tunnel reaching a router over plain http made the API advertise
  http:// URLs for an https site.
- Settings - MCP checks the discovery document from the instance's own root
  and says what is wrong: the proxy answering /.well-known/ with the web app,
  a mismatched scheme or host, or an unreachable document.
- docker-compose.prod.yml for PaaS or compose-behind-a-router deployments: no
  published ports, required env values enforced.

## v1.5.6

- MCP connectors (Claude, Cursor) could not register: OAuth discovery built
  every endpoint from APP_URL, so a stale or default APP_URL advertised a
  registration endpoint on localhost. Discovery now reports the host the
  request actually arrived on, and the bundled nginx passes Host and
  X-Forwarded-Proto through on the discovery routes (it did not, so it
  advertised the internal api:3000).

## v1.5.5

- The sidebar has one identity row instead of two. The row at the foot that
  showed your own name and avatar is gone; the workspace row at the top now
  carries the account menu (email, profile, invite, theme, sign out) and
  shares its row with the search and new-task icons.
- The workspace name moved below the macOS window buttons instead of being
  indented beside them: the sidebar opens with a short strip that belongs to
  the traffic lights, and the name is flush with the sidebar's left edge on
  every platform. The strip still drags the window.
- Notifications is a navigation row with the unread count right-aligned,
  instead of a badged icon – at two digits the badge covered the bell.
- Settings is a navigation row at the foot of the nav (gear icon, active
  state, permission-gated) instead of an item inside a dropdown.

## v1.5.4

- macOS: fixed the v1.5.3 title bar. The window is draggable again (the
  capability was missing core:window:allow-start-dragging) and the traffic
  lights no longer cover the workspace switcher: they are positioned via
  trafficLightPosition onto the sidebar's first row, with the switcher beside
  them, so window buttons, switcher, nav arrows and tabs share one row.
- A long workspace name no longer escapes the sidebar and runs under the tab
  strip; it truncates with an ellipsis (affected the web build too).

## v1.5.3

- The desktop version banner's update button actually updates: it runs the
  updater on demand, offers a restart only once a build is staged, says when
  the build is not published yet, and reports failures instead of silently
  doing nothing.
- Links shown or copied inside the desktop app (MCP connect URL, copy-link
  everywhere, OAuth redirect URLs) use the instance address instead of
  tauri://localhost.
- Realtime works on the desktop: the stream is read over fetch with bearer
  auth against the instance URL, instead of EventSource, which could send
  neither. Project events now refresh the projects list on every platform,
  and the invoice PDF button opens in the real browser on desktop.
- CI checks for browser idioms that break inside the desktop shell
  (check:desktop-safe), so this class of bug fails the build.
- Settings follow progressive disclosure: MCP leads with per-client connect
  snippets (incl. Codex CLI), integrations show status chips with forms on
  demand, invoice branding gets a large interactive preview. On macOS the tab
  strip moves into the title bar.

## v1.5.2

- The API Docker image includes packages/mcp, fixing a crash on boot
  (ERR_MODULE_NOT_FOUND '@ordi/mcp') introduced with the hosted MCP server.
  CI now builds both images and boots the API one against Postgres, so a
  workspace package missing from an image fails the build instead of the
  deploy.

## v1.5.1

- Desktop "Sign in with browser" works again: PKCE hashing no longer needs
  crypto.subtle (absent on the tauri:// origin), deep links reach the running
  app instead of starting a second one, the verifier survives a relaunch, and
  the code can be pasted by hand. Failures now name the step that failed.

## v1.5.0

- MCP over OAuth: add <instance>/api/v1/mcp as a remote MCP server in Claude or
  Cursor, sign in through the browser and approve – no token copying. Grants
  appear in Settings → MCP and are revocable like any token; the stdio server
  with ORDI_API_TOKEN remains for clients without OAuth.

## v1.4.1

- The server reports its version in /healthz; the app compares it with its own
  build – browser tabs get a reload prompt after a deploy, the desktop app
  warns when its server is behind, and Settings shows the running version plus
  a link when a newer release exists.

## v1.4.0

- One calendar across the whole app, replacing every native browser date input,
  with keyboard navigation and a Today shortcut.
- Date format is a personal preference (Profile → Preferences) and applies
  everywhere a date is written.
- Pending invites appear in the members list with copy link, resend and revoke.
- Each in-app tab keeps its own back/forward history, driven by arrows in the
  tab strip or Alt+←/→.
- Project members and labels are managed from the properties rail: members in a
  popover, labels with search and inline creation.
- The product mark is now the same artwork as the desktop app icon.

## v1.1.0

- Desktop auto-update over GitHub releases: updates are signed, staged in the
  background on launch, and applied on restart from an in-app prompt.
- Desktop capabilities are declared explicitly, which fixes native notifications,
  the taskbar badge, the global quick-add shortcut and `ordi://` deep links in
  packaged builds.
- The demo seed now creates a full agency workspace – a live project with a
  sprint, labels, milestones and burn-up history, two clients with a deal
  pipeline, invoices with ledger entries and payments, logged time with rates,
  and a knowledge base.
- Open-source release: AGPL-3.0, rewritten README, contributing and security
  policies.

## v1.0.2

- Fixed a crash on the project page caused by two components storing different
  shapes under the same query cache key, and added a CI guard for that class of
  bug.
- Project keys are suggested for Cyrillic names.

## v1.0.1

- Fixed the desktop app failing to connect to instances behind the standard
  nginx deployment.

## v1.0.0

First release.
