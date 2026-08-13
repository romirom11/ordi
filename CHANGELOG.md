# Changelog

Release notes for each version live in [`docs/releases`](docs/releases) and are
published to [GitHub Releases](https://github.com/romirom11/ordi/releases).

## v1.24.0

- **The knowledge base hosts PDFs**: a page is an article or a PDF document,
  chosen at creation; PDF pages upload through the existing attachments
  pipeline and render inline via the browser's native viewer, with file
  replacement and open-in-new-tab. Markdown export links the document.
- **People becomes HR** with a new **team calendar** tab: a month grid of
  approved/pending absences, public holidays and birthdays – a new employee
  field that recurs yearly off the card.
- **Field groups** turn employee custom fields into access units: role
  grants live in a matrix under Settings → Roles beside a dynamic **Self**
  principal; `people.write` roles keep full access; enforcement is
  server-side. Self-writable groups form the **HR questionnaire** on the
  profile page, with a fill-status badge and a last-updated stamp on the card.
- The **employee card** gains the work email, birthday and a documents
  section with inline PDF preview; personal contacts live in custom fields.
  Fields and groups can carry **icons** from a curated set.
- **Custom fields render everywhere** – employee card, companies, projects,
  tasks, invoices, and contacts via their dialog (previously leads and deals
  only).
- **One dashboard for everyone**: personal work tiles plus a two-week team
  card (absences, holidays, birthdays) that deep-links the HR calendar;
  finance/pipeline tiles moved out to Finance and custom dashboards.
- **List views remember their state**: sorting, filters, search and tabs
  survive navigation across CRM, projects, finance, time, people and
  per-project task filters.
- Notification emails stop arriving half-empty (task title/status/actor
  filled from current state) and the workspace logo renders in mail clients
  via a new public route.
- First **Playwright e2e suite** (KB PDF, HR calendar, questionnaire) with
  its own CI job; 9 new API tests pin the field-group access rules.

## v1.23.0

- **Custom fields become manageable.** The settings panel could only list and
  create definitions – a select field created there had no way to receive its
  choices, and nothing could be renamed or removed. It now edits (label,
  required, show-in-list, sortable, indexed, deprecate), deletes with a
  confirmation that explains stored values survive on records, and carries an
  options editor for select/multiselect with values auto-derived from labels.
  Key and type stay immutable per the PRD's non-destructive-edit rule.
- **Leads get first-class labels**: a third label vocabulary (scope `lead`,
  same table and endpoints as task and project labels) with a `lead_labels`
  join table. The lead rail gets the same picker tasks use – search,
  multi-select, inline create – and the leads table shows the chips next to
  the title. `labelIds` rides the lead create/update API and lands in the
  activity trail.
- The leads tab gains a **company filter** beside status and owner (the API
  always accepted `companyId`; the UI never sent it).
- The CRM **work queue uses the full page width** instead of a centered
  5xl column.

## v1.22.1

- CRM dropdowns take the width of the field they belong to instead of a fixed
  240px, so options in a full-width dialog select stop wrapping into two lines
  beside empty space.
- Opening one picker closes the one before it: the outside-click listener now
  runs in the capture phase, which a dialog panel's `stopPropagation` used to
  swallow, leaving the previous menu open on top of the field you clicked.

## v1.22.0

- Every native browser dropdown in the CRM is replaced by an app-styled
  **SearchSelect** – a dropdown with a search box from 8 options, keyboard
  navigation and inline actions (the lead's contact picker can create a
  contact without leaving the flow). Company and contact rows in the lead
  rail link out to the company record.
- Tables sort: leads and clients by any column (statuses in funnel order,
  empty values last), the invoice/quote lists gain a header row that doubles
  as the sort controls, profitability and time reports sort too. Leads gain
  an owner filter.
- The lead, deal and company pages share one layout: full-width content
  beside a rail that flexes 280–400px with the viewport. Rail values wrap
  instead of truncating, empty fields hide on read-only records, sales
  history shows 8 rows with "Show all N", and the lead's next-action card
  offers Complete / Schedule in place.
- MCP's `update_lead`/`create_lead` stop silently dropping `suggestedChannel`
  and the other research fields, and custom fields open up to leads across
  the API, MCP, settings and the lead page.

## v1.21.0

- Prose-length CRM fields read fully instead of truncating. The lead's
  product, signal, source and suggested channel lived in the 320px properties
  rail, which cut every value to one ellipsised line and wrapped the labels
  onto two – the only way to read a field was to click into it and edit. They
  now sit in a Details card in the wide main column, where values wrap. The
  source link shows its hostname (the full URL stays behind the edit and the
  Open source button) with the source-checked date as a footnote under it.
- Deal custom fields moved the same way: workspace-defined fields render as a
  Custom fields card in the main column instead of the rail, and a read-only
  URL value wraps instead of overflowing the card. The rail on both pages
  keeps the short relational facts – status/stage, company, contact, project,
  owner, money, dates and files.

## v1.20.0

- A created KB page is a visible KB page. Pages were born as drafts by a
  silent default while the only publish control hid in a context menu, so a
  role holding kb.read opened the knowledge base to empty spaces – every page
  anyone had written was a draft nobody meant to keep hidden. Pages are now
  born published, existing pages are marked published by migration (a page
  meant as a draft can be unpublished again), and draft became the marked
  state: an explicit choice on create, a Draft badge with a Publish button on
  the page, an icon in the tree instead of the green dot on everything.
- The draft/private page rule now holds everywhere a page surfaces, not only
  in the tree: search stops matching drafts and other people's private pages,
  the home feed and per-entity activity trail stop narrating their titles,
  version history answers 404 to those who cannot open the page (it carries
  full bodies), backlinks name only pages the viewer could follow, and
  duplication refuses to copy a page out of a space where the actor cannot
  read it. KB page events on the live stream are scoped to the space's
  audience instead of broadcasting workspace-wide.

## v1.19.0

- Files work where ordi is actually run. Uploads used to hand the browser a
  presigned URL to `http://minio:9000`, a hostname that exists only on the
  docker network, so every upload from the UI failed on a self-hosted install
  and failed twice behind https as mixed content. All bytes now travel through
  the API: `POST /attachments` takes the file as multipart and generates the
  storage key server-side (replacing `/attachments/presign` and
  `/attachments/register`, and with them the register-a-foreign-key hole
  `keyToken` defended against), and `GET /files/:id/:token` streams the object
  instead of redirecting to storage. One flow serves bundled MinIO and external
  S3/R2 alike, with no CORS, no public storage endpoint, and MinIO's port no
  longer published to the host.
- Files preview in place: images, the built-in PDF viewer, video, audio and
  text-ish files as monospaced text, all on what the browser renders natively;
  unpreviewable types say so and offer the download. Scriptable uploads (html,
  svg, xml) are served with `Content-Security-Policy: sandbox`, closing the
  stored-XSS vector that serving them from the app's own origin opened.
- Uploads take several files at once, with one summary toast and the first
  failure named per file. Storage refusals stop reporting an operator's
  misconfiguration as a server crash: `InvalidAccessKeyId`,
  `SignatureDoesNotMatch`, `NoSuchBucket` and `AccessDenied` map to a 422 that
  names the environment variable to check, a missing object to a 404.
- The prod stack bundles MinIO behind `COMPOSE_PROFILES=minio`, sharing the
  `S3_ACCESS_KEY`/`S3_SECRET_KEY` pair the api uses so credentials cannot
  drift, with a one-shot init that creates the bucket on first boot. The
  deployment docs had promised a bundled MinIO the prod compose never had.
- In-stack addresses use unique aliases (`ordi-db`, `ordi-minio`) that exist
  only on the stack's private network. On a PaaS a container sits on two
  networks and resolves generic names against both, which had a real
  deployment talking to another project's MinIO and Postgres – reported as bad
  credentials, indistinguishable from it.
- Lead rows answer a right-click like every other list: open in a new tab, copy
  link, open company, status and owner submenus, delete behind a confirm; a
  converted lead offers navigation only.
- Lead statuses have colour. All nine rendered in the same grey, so
  Disqualified looked exactly like Ready to contact. They are toned by whose
  move it is rather than by funnel depth, and the settled ones stay grey so the
  rows worth acting on carry the colour.

## v1.18.0

- Leads are workable in volume. The lead table grows a select column and a
  bulk bar: reassign the owner or move the status of up to 200 leads in one
  action, each still passing the single-lead rules (terminal statuses cancel
  planned activities and stop sequences, nurture demands a return date,
  converted leads stay frozen), with failures reported per lead. Lead lists
  import and export as CSV; the importer creates unknown companies as
  prospects on the fly, validates line by line with a dry run, and hands
  ownership to the importer. The table says when it is cut at its 200-row
  bound instead of looking complete.
- A CRM Analytics tab: lead funnel by status, 30-day intake trend,
  lead-to-deal conversion, pipeline value by stage (raw and probability
  weighted), win rate and ranked lost reasons. Live snapshots of the base
  tables; the deals half is withheld from roles without `deals.read`.
- Intake requests reach the team. A project Intake tab (pending count on the
  tab) triages each public-form request into a task or a decline with a
  reason, mailing the requester either way; project settings gain the form
  toggle and its shareable link. Requests used to land in a table no screen
  read.
- A cycle can end. The cycle card opens details with live progress and a
  burndown drawn from the daily snapshots the worker was already collecting;
  completing the cycle rolls open tasks to the backlog or the next cycle.
- Moving a task between projects moves the work: the whole subtree, comments,
  relations, external and git links, attachments, logged time and a running
  timer follow to the new tasks. Comments used to stay on the soft-deleted
  original and subtasks were orphaned.
- Task templates and recurring rules get settings sections, feeding the
  scheduler that has been running all along.
- Milestones hold tasks: a task carries one of its project's milestones, the
  tasks view groups and filters by them, and the overview shows real
  done-vs-total counts per milestone. Projects keep files, gated by
  membership. The task list pages through the whole project instead of
  showing its newest 50, and tied orderings resolve by the tasks' own
  sequence.
- Task lists and boards mark tasks blocked by an open "blocks" relation, and
  the projects list reads its completion rings from one grouped
  `GET /projects/task-counts` query instead of per-row full task fetches.

## v1.17.0

- The rich text editor is finished. Task bodies, KB pages and project
  descriptions had bold, italic, strike, code, three heading levels and a
  ten-item slash menu; they now have underline, text colour and highlight,
  alignment, tables with row and column tools, callouts in four tones,
  collapsible toggles, code blocks with syntax highlighting across 17
  languages, and images. A hover gutter inserts a block below, drags to
  reorder, and opens turn into / move / duplicate / delete. Blocks are
  declared once in `richtext/blocks.ts`, so the slash menu, the bubble
  toolbar and the block handle can no longer drift apart the way they had.
  `RichBody` was a second renderer with its own switch statement that had
  never learned tables, colour or highlighting; it is a pass-through to
  `RichText` now.
- Images can be pasted, dropped or picked, not only linked by url. A
  document stores a signed, non-expiring path
  (`/api/v1/files/<id>/<token>`, an HMAC under `AUTH_SECRET`) rather than a
  presigned storage url that expires within the hour and rots the document
  holding it - the model invoices, quotes and client portals already use.
  The path is stored root-relative, so moving the instance to another
  domain does not break every image ever embedded. Whoever holds such a
  link can fetch the file, and rotating `AUTH_SECRET` invalidates every
  issued one. `/attachments/presign` now signs the key it issues and
  `/attachments/register` refuses a key without a matching signature:
  registering an arbitrary key was a way to mint a public link to any
  object in the bucket, an invoice PDF included.
- Cmd/Ctrl-click and middle-click open a list row in a second tab. Project,
  task, lead, deal, client, invoice, employee, dashboard and subtask rows
  were plain click handlers calling `navigate()`, which swallows the
  modifier, so the context menu was the only way to open anything beside
  what you were already reading.
- The keyboard scheme is one table with a help sheet on `Shift+?`, instead
  of three scattered listeners nothing documented. New: `Cmd+T`,
  `Cmd+Shift+T` to reopen the last closed tab, `Cmd+1`…`9`, and `Cmd+[` /
  `Cmd+]` for history. The G chord reaches 11 destinations.
- Page entrances replay on every navigation and reset their own scroll.
  They only ever keyed off the first path segment, so opening a project
  from the project list animated nothing and kept the previous scroll
  position.
- External links work in the desktop app. Two independent silent failures:
  the capability granted `opener:allow-open-url` with no url scope, which
  rejects every call, and nothing routed links to the opener anyway - all
  three webviews drop a new-window request instead of handing it to the
  OS. A delegated handler now covers links the SPA renders later too;
  http(s), mailto and tel go to the browser, while `ordi://`, `blob:` and
  in-app router links stay put.
- Sales activity dates go through the shared date picker and its separate
  time control, so they honour the user's date preferences. Completing a
  research review readies the lead and schedules the first outreach,
  instead of recording that a reply is already pending.
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
- Unqualified prospects live in the Leads workspace only. The pipeline's
  legacy "Lead" stage is migrated away without losing sales context, and
  the demotion flow that stage needed is gone from the UI, the API and
  MCP. A stage may still be *named* "Lead": the ban that shipped beside
  that migration was a one-off guard promoted into permanent validation
  across the shared schema, the API and the UI. The `leads.legacy_deal_id`
  marker the migration used is dropped too.
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
- Planned work no longer reads "now". `fmtRelative` measured
  `now - timestamp`, so every future instant went negative, matched the
  under-a-minute branch and rendered as "now" - in the Work queue, the
  Leads table, the lead page's next-action card and the sales history. A
  follow-up due next week and one due this minute looked identical, which
  is the one distinction that queue exists to make. Future instants read
  "in 5d" now; past ones are unchanged.
- The Pipeline tab is behind `deals.read` on the URL as well as in the tab
  bar. `/crm/deals` matches the `/crm/:tab` route, so it passed the
  route's `crm.read` check and rendered the pipeline shell - subtitle
  included - to a role that cannot read a deal. It shows the no-access
  notice instead. The New deal dialog is only mounted with `deals.write`,
  since its queries ran whether or not it was open and 403'd on every CRM
  visit for such a role.
- A lead is fillable again. Pain signal, why it fits, why now, evidence,
  caution, the opening message, product, score, signal, source, source
  link, suggested channel and the title are all editable in place on the
  lead page, and the owner is pickable. Those fields only ever had an
  importer to fill them, so after it was removed the page showed a dozen
  boxes a seller could read and never write.
- The Work queue keeps what is booked ahead. A lead whose next step was
  planned for tomorrow matched no bucket and disappeared from the page,
  while `waiting for reply` - the one state that needs nothing from you -
  was always shown, with a button offering to complete work days early.
  There is a `Booked ahead` bucket now, and the row's action follows its
  bucket: finish overdue and due-today work, plan the unplanned, leave
  the rest to read. The morning digest fires on the actionable part only,
  so a fully-planned week no longer produces a daily email.
- A new lead can be logged in one pass. The company picker offers
  "+ New company…", so the usual case - a prospect that is not in the
  workspace yet - no longer means cancelling out to the Companies tab and
  starting over.
- New preset role: Sales. The whole CRM plus read-only sight of projects
  and finance. Until now the only preset that covered the sales workspace
  was Manager, which also grants project write and the right to issue and
  send invoices.
- Playbooks ship with a starter: three message templates and a
  three-step outreach sequence, seeded like deal stages and editable like
  any other record. The tab used to open empty on a feature about
  reusable copy.
- Scheduling an activity defaults to Outreach on a record with no history
  instead of Follow-up, and can be assigned to a specific owner.
- Whoever creates a company owns it, the way creating a lead already
  worked.
- Naming: the Companies tab says "company" throughout - the list holds
  prospects as well as clients. The company status `lead` is labelled
  "Prospect", so the word no longer names both a company status and the
  separate Leads workspace beside it.
- The Work tab printed the same sentence three times at once - page
  subtitle, section subtitle and empty-state hint.
- A contact can be created from the lead that needs it. The picker
  offers "+ New contact…" and attaches whoever you add - previously a
  prospect whose company had no contacts yet was unreachable without a
  detour to the company page.
- Convert to deal is visible throughout a lead's life and says what it is
  waiting for, instead of silently not being there until the lead reaches
  Engaged.
- The Work queue's empty state offers a way on to Leads. It is the CRM's
  landing tab, so on day one it was the first thing a new seller met, and
  it led nowhere.
- The dashboard counts sales work: overdue and due-today from the CRM
  queue, next to the task counters. `My open tasks` counts project work,
  so a seller with a full outreach queue was told they were all caught
  up.
- Start sequence says why it is unavailable over a record that already
  has a planned action, rather than letting the click fail against the
  API rule.
- The Leads table shows the owner, so a team can see whose pipeline is
  whose without opening every record.
- Last of the importer's language is gone from the UI: a deal is
  "Qualified from a lead", its link reads "Open the lead", and a
  company is a company on the deal rail too.
- Fixed a test that was set to start failing on a calendar date: the
  email retry-backoff case stepped forward from a hard-coded
  `2026-07-29`, so it stopped claiming on the first tick once the wall
  clock passed it.
- ordi has a landing page at
  [romirom11.github.io/ordi](https://romirom11.github.io/ordi). The README
  was the only place the project explained itself, and it only reaches
  people who already found the repository. Hand-written HTML and CSS with
  the design tokens copied from the app, so the site and the product look
  like the same thing.

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
