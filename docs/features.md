# Features

A working register of features: what we're planning, what's in flight and
what has already shipped. The details of what shipped are in the
[CHANGELOG](../CHANGELOG.md) and [docs/releases](releases/); here is the
picture at a glance.

How to use it: a new idea → a row in "Backlog". Picked up → move it to
"In flight" with a link to the PR. Merged → into "Shipped" with the release
version.

## Backlog

| Feature | Why | Notes |
|---|---|---|
| Server-side bulk endpoints | Bulk actions currently go out as one request per row from the client; at hundreds of records we need transactionality and a single request | Leads already have a server-side `POST /leads/bulk` (v1.18.0); clients and tasks remain (clients ≤200, tasks within a project) |
| Relation custom field type | Arbitrary links between entities without changing the schema ("task → client" and so on) | Deliberately deferred: values in jsonb have no FK integrity, so key relations (deal → project) live as columns in the schema. Relation is for the long tail |
| Kanban filter by select fields | Pipeline slices by any custom dimension, not just by project | `GET /deals` already handles cf filters on companies – carry the pattern over |
| Won deal → project in one click | Turning a sale into delivery without creating the project by hand | Carry over companyId, the name, the amount as the budget; the deal link stays |
| Report: pipeline by project | How many leads/how much money is in the funnel for each product (Solovei vs services), conversion by line of business | The groundwork is already there: `deals.project_id` + `deal_stages` |
| Several clients per project (m2m) | Joint projects for two customers with split billing | Open question: a rare case that drags a change to the financial model along with it |
| One "Resources" block for a project | Links and files are both "the project's materials", but live in two blocks; secrets and KB pages belong there too | One list with a type per row (link, file, KB page, secret), sharing rename, order and removal. Files stay attachments (tasks use them); `project.links` migrates into it |
| Project secrets | Test API keys and platform logins handed over by a client need a place that is safe and still easy | AES-GCM at rest (`lib/crypto`), reveal/copy written to the audit log, project-member access. MCP sees names and which fields exist, never values; ordi's own agents get values as env vars at run time. External providers behind the same interface: Doppler first, then 1Password, Infisical, Vault and others. Prerequisite: refuse to start in production without a real `ENCRYPTION_KEY` |
| Project updates, round two | Updates are hand-written status posts and it is not obvious what goes there or how they differ from Activity | Draft pre-filled from what happened since the last update, MCP `post_project_update`, a reminder after N days without one, a hint on the block |
| Native file drop on desktop | Dragging files from the OS into tasks/notes | Needs care: `dragDropEnabled` is off for the sake of internal DnD; HTML5 drop via DOM events works anyway |

## In flight

| Feature | PR |
|---|---|
| Milestone side panel (tasks, rename, quick add) and renaming files | `feature/milestone-panel-and-file-rename` |

## Shipped

### v1.42.0

- Deleted projects can be restored ("Deleted projects" on the Projects
  page); the key goes back to the pool (migration `0043`), deleting saves
  running timers and stops agent runs, and workers, time, finance, CRM and
  KB views skip deleted projects ([PR #143](https://github.com/romirom11/ordi/pull/143)).
- Project settings open as a side panel over the project list and gain a
  Danger zone with Delete project ([PR #143](https://github.com/romirom11/ordi/pull/143)).
- CSV round trip: rows with an `id` / task ref update instead of
  duplicating, full lead fields, shared task columns, semicolon files, a
  period for the time export, formula-safe cells ([PR #143](https://github.com/romirom11/ordi/pull/143)).
- Desktop: updates download in the background and wait in a single sidebar
  row ([PR #138](https://github.com/romirom11/ordi/pull/138)); the swipe no
  longer slides the whole window and follows the active tab's history
  ([PR #142](https://github.com/romirom11/ordi/pull/142)).

### v1.41.0

- Bitbucket Cloud integration: a workspace connects with a token (an
  Atlassian API token + email, or an access token), the webhook is registered
  on the repository when it's linked to a project, branches/commits/PRs are
  linked to tasks, AI agents push and open PRs ([PR #130](https://github.com/romirom11/ordi/pull/130)).
- A KB page / task description no longer hangs on "Saving…" when Save is
  rejected after realtime has already brought in someone else's version.
- Desktop: sign-in for the GitHub App, GitHub OAuth, Slack and MCP connectors
  opens in the system browser (`startExternalFlow`) rather than in the app
  window; the MCP connector finally authorises from the desktop. Two-finger
  swipe back/forward on macOS and Linux.
- New installs start on Glass Dark; the sidebar and side panels slide in
  rather than popping into place; the Intake settings show only what's
  relevant.

### v1.40.0

- A "Plan" tab instead of "Cycles": milestones with progress, due dates and
  "Pull open tasks into cycle", the current cycle broken down by milestone.
  Cycles are switched on per project; tasks have a "Cycle" field, the list
  filters and groups by it, and the bulk panel sets a milestone or a cycle.
- Project page: settings in a side panel, the overview starts with the
  description and no empty blocks, the Intake tab appears only when intake is
  enabled, the project list flags *At risk* / *Off track*.
- Multiple email senders (Settings → Email): each with its own From, Reply-To
  and SMTP login; a system sender and one for invoices; choosing the From when
  sending an invoice (migration `0042_email_delivery_sender`).
- Integrations as a list, with each one's settings in a side panel.
- Glass: Urbanist Cyrillic, floating task view controls, a single fill for
  the selection.
- MCP: `create_milestone`, `update_milestone`, `create_cycle`,
  `complete_cycle`; `milestone` in the task tools.

### v1.39.0

- A second interface style – Glass (workspace menu → Style), in light and
  dark themes; Classic stays.
- Credit notes count towards the invoice balance everywhere; monthly schedules
  on the 31st stay in their own month.
- Security: API tokens can't manage tokens, read-only tokens don't write,
  turning off 2FA requires a code, cost rates require the expenses permission,
  MCP `upload_attachment` fetches only public URLs.

### v1.38.0

- MCP creates subtasks and puts tasks into cycles (`parentId`, `cycle`);
  `get_project_schema` returns cycles.
- Task status can be changed straight from the row in "My tasks".

### v1.37.0

- A Codex runtime for AI agents alongside Claude Code: an OpenAI API key (with
  any OpenAI-compatible Base URL) or a ChatGPT subscription (migration
  `0041_codex_base_url`).

### v1.36.2

- MCP `upload_attachment`: images inside the task text, or a file in the
  record's Files section.

### v1.36.1

- The invoice totals block without repetition: the subtotal only alongside a
  discount or tax, "Total" only alongside a payment, otherwise a single
  "Amount due" line ("Paid in full" once the invoice is closed). The same in
  the PDF, on the public pages and on the invoice page in the app.

### v1.36.0

- Invoices are editable: one form (create and edit, an "Edit" button on the
  invoice page) with the issue date, an optional due date, currency, document
  language, a tax rate for all line items, a discount and line items; line
  items lock once the invoice is sent, everything else can always be edited.
  The due date is optional (`invoices.due_date` nullable, migration 0040): an
  invoice without a due date is open but never overdue, gets no reminders and
  stays out of the expected-payments calendar. Dates in the document are
  written out in words in the document's language ("28 вересня 2026 р.", i.e.
  28 September 2026), the internal status has been removed from the PDF, the
  tax line appears only when there is tax, with the rate's name
  ("Tax (VAT 20%)"), plus a discount line.

### v1.35.1

- Built-in file storage no longer depends on the MinIO images, which stopped
  being served anonymously (first on Docker Hub, now on quay.io too, which
  made deploys with the `minio` profile fail on `minio/mc: unauthorized`): the
  `minio` and `minio-init` services have been replaced by a single `s3`
  service running RustFS (Apache-2.0, S3-compatible API, published on Docker
  Hub). The API now creates the bucket itself at startup, waiting while the
  storage container comes up; the old `COMPOSE_PROFILES=minio` and
  `http://ordi-minio:9000` keep working. MinIO data is moved over with a
  one-off `rclone sync` (docs/deployment.md §4).

### v1.35.0

- Invoices and quotes: the PDF is rendered by the API itself via pdfkit
  instead of the optional Typst binary, which wasn't in any image (so every
  invoice came out as a monospace fallback with no logo, colour or payment
  details, and with broken Cyrillic). A branded document: an accent stripe and
  colour, the logo, both parties' details, a table with line wrapping and page
  breaks, totals with an "Amount due" block, payment details, notes, terms,
  a footer, page numbers; the Liberation Sans font (OFL) in
  `apps/api/assets/fonts`, labels in the document's language (uk/en).
- The public invoice page opens: the link from the email and the PDF
  (`/i/<token>`) returned raw JSON because the public API at the root shadowed
  the built SPA; browser navigation to `/i/`, `/q/`, `/portal/`, `/intake/`,
  `/careers/` now gets the page, fetch gets JSON. The public
  `/i/:token/pdf` serves the document instead of a 501, and `/q/:token/pdf`
  has been added. The public quote page read a structure the API didn't
  return and was empty – fixed; it shows the branding, the parties and a PDF
  button.
- Details are set once: your own in Settings → Invoices (legal name,
  EDRPOU/IPN tax ID, address, email, phone → `legal_details`), the client's on
  the company page (legal name, code, address → a fixed-shape
  `companies.address`). The same places hold the default notes and terms that
  every new invoice and quote starts from; notes and terms are edited on the
  invoice page, which also shows the "From" and "Bill to" blocks. The logo is
  stored as PNG (pdfkit doesn't embed WebP); the panel prompts you to
  re-upload an old WebP logo.
- Sending an invoice either really sends it or says why not: previously "Send"
  set the status to sent and showed success even when the email didn't go out
  (without SMTP the API only wrote a line to the log; without a company email
  it skipped sending). The button is disabled with an explanation until email
  is set up; the confirmation dialog shows the sender, the recipient (editable,
  pre-filled with the company email), the subject, body and attachments; the
  API refuses without a recipient or a mail server, returns a transport error
  as is, and the invoice stays a draft; every send is recorded with the
  address and visible in the timeline.
  `GET /invoices/:id/send-preview`; quotes get the same refusals.

### v1.34.0

- Agent runs execute in a separate container out of the box: the
  `agent-worker` service is no longer a commented-out block in
  `docker-compose.prod.yml` but part of both compose files, and the API's
  built-in worker is switched off there (`AGENT_WORKER_ENABLED=0`). The
  container that runs model-written code never holds `DATABASE_URL`,
  `ENCRYPTION_KEY` or `AUTH_SECRET`, on a fresh install too.
  `AGENT_WORKER_SECRET` is now required in `docker-compose.prod.yml` (the
  quick-start file has a placeholder), the `agent_work` volume is mounted only
  on the worker, `api` gained a healthcheck on `/healthz` that the worker
  waits for, and is reachable from the worker as `ordi-api`. Settings → Agents
  warns about a missing worker only when none is online.
- A question from an agent no longer loses work: a run in the `needs_input`
  status pushed nothing, and the checkout with the commits made before the
  question was deleted at the end of the run, so the follow-up after the
  answer resumed a session with files that were no longer on disk and created
  a branch with a different name. Now the work done goes as a WIP commit to
  the task branch, just as on a stop for a limit, a timeout or a cancellation,
  and the follow-up continues on it.
- `CLAUDE.md` at the repository root with the branch naming rule
  (`feature/`, `fix/`, `docs/`, `release/`).

### v1.33.1

- The agent worker stays online: every heartbeat after the first failed with
  `operator does not exist: text + integer`, because the
  `agent_workers.version` column stored the ordi version string, and the
  optimistic locking trigger, which attaches to every column with that name,
  tried to add one to it. 35 seconds after startup Settings → Agents showed
  the worker as offline, and a separate worker logged
  `agent worker heartbeat failed` every 15 seconds. The column is now
  `app_version` (migration `0039_agent_workers_app_version`, which also drops
  the trigger from the table), and `triggers.sql` attaches the trigger only to
  integer `version` columns.

### v1.33.0

- The agent worker runs without the database: the process that runs
  model-written code no longer needs `DATABASE_URL`, `ENCRYPTION_KEY`,
  `AUTH_SECRET`, S3 or SMTP. Moved out into its own container, it talks to the
  API only through `/api/v1/agent-worker/*` with the shared secret
  `AGENT_WORKER_SECRET` and holds only what the current run needs: Claude
  access, the repository token and the run's own token, which is revoked at
  the end. Claiming a run, the brief, the event log and the effects of
  completion on the task moved to the API side (`run-service.ts`); the worker
  inside `api` calls the same functions directly, so `docker compose up`
  hasn't changed. A ready-made `agent-worker` service in
  `docker-compose.prod.yml`; the working copies volume now sits on it.
- A run survives its own log and a push to a branch that has moved on: NUL
  bytes are stripped from events, a failed event write only warns, and before
  the push local commits are replayed on top of origin instead of a
  non-fast-forward refusal; `commit --amend`, `rebase`, `reset` and
  `branch -f` are forbidden to the agent.
- One closing comment per run, in the thread's language, addressed to a
  person: the platform duplicates the summary only when the agent wrote
  nothing itself; the brief names whom to reply to, `comment_on_task` accepts
  `mentionUserIds`, and `@Name` becomes a real mention.

### v1.32.0

- Git links: a single write path via the forge webhook (the same for an agent
  as for a person; the duplicate PR in `task_links`, which was never rendered
  anywhere, is gone), a unique index (task, type, ref) with migration 0038,
  one event per state transition (Redeliver doesn't open a PR twice). The
  webhook logs the reason when a delivery linked nothing, and Settings →
  Integrations shows the Webhook URL this instance expects – to check against
  GitHub, where a different URL means a 404 on every delivery.
- The image is published on every release: `ghcr.io/romirom11/ordi` (the API,
  the workers and the built web app in one container, `linux/amd64`) with the
  tags `1.32.0`, `1.32`, `1`, `latest`, `sha-<commit>`. The server no longer
  builds anything – `pnpm install` and the web build stay in CI. A green
  workflow means exactly "pull works": after the push the job logs out, pulls
  the tag anonymously, checks the digest, brings the image up with Postgres
  and requires `/healthz` to report this version and the web app to be served
  from the same port.
- The web Nginx image is gone (breaking for anyone pinned to it):
  `docker/Dockerfile.web` and `docker/nginx.conf.template` have been deleted –
  deprecated since v1.6.0, when the API image started serving the SPA,
  `/assets/*`, SSE and OAuth discovery itself. If you still run `ordi-web`:
  point the domain at the `api` service, port 3000, path `/`.
- The README describes what the product really does: the Features section
  was selling roughly two thirds of ordi (Slack, GitHub App, intake, CRM
  analytics and playbooks, receivables aging, the team calendar, field groups
  and the questionnaire, files, reactions and the wizard were missing) – now
  it mirrors the landing page, with every line checked against the API and the
  schema.

### v1.31.0

- Notifications reach the people they concern: each row is streamed
  personally to its recipient as `notification.created` instead of riding on
  the whole project's event – "you've been assigned a task" no longer reaches
  the whole team (nor raises an OS notification on every desktop). The event's
  author, deactivated accounts and agents are dropped; a comment reaches the
  task's author, its assignees and everyone who has already replied, not just
  those mentioned; a paid invoice, a recorded payment and an
  accepted/declined quote finally have recipients; a mention on a page reads
  as a mention on a page and opens the page. Comments, page mentions, merged
  PRs, payments and declined quotes have their own toggles in the email
  settings ([PR #81](https://github.com/romirom11/ordi/pull/81)).
- Lead export with every field: `/export/leads.csv` writes one row per lead
  with all the columns, related names (company, contact, owner, labels, next
  action, deal) and lead custom fields; the Export button next to the filters
  returns exactly what's on screen, without the 200-row limit; a UTF-8 BOM so
  that Excel doesn't mangle Cyrillic ([PR #84](https://github.com/romirom11/ordi/pull/84)).
- Markdown files in the preview are shown as a document rather than raw text:
  the `markdownToDoc` converter in `@ordi/shared` parses a subset of
  CommonMark/GFM (headings, code blocks, quotes, lists, tables, inline marks)
  into a tiptap document, which is rendered by the same read-only renderer as
  notes and the KB. Raw HTML never reaches the page, links are
  http/https/mailto only, images become links
  ([PR #86](https://github.com/romirom11/ordi/pull/86)).
- "My leave" shows only your own requests: the card called the unscoped
  `GET /leave-requests`, which with `people.read` returns the whole workspace –
  in HR, other people's absences sat on your own page with a cancel button;
  `?scope=mine` has been added. Balances are untouched
  ([PR #85](https://github.com/romirom11/ordi/pull/85)).
- MinIO images from Quay: anonymous pulls of `minio/mc` and `minio/minio` on
  Docker Hub now return 401, which broke deploys with the `minio` profile;
  both are pinned to `quay.io/minio/…` releases ([PR #83](https://github.com/romirom11/ordi/pull/83)).
- The landing page caught up with v1.30: agents as team members, desktop
  sign-in via the browser, and "timesheet approval", which the product doesn't
  have, removed ([PR #82](https://github.com/romirom11/ordi/pull/82)).

### v1.30.0

- The leave balance is visible and can't be overspent: `GET /leave-entitlements`
  computes allocated/carried/used/pending/remaining per type, and before
  accrual it uses the type's annual quota; a request longer than the balance
  is rejected on submission (pending ones already counted) and again on
  approval, under a per-employee lock; the card shows the balance on your own
  page and on someone else's with `people.read`, and the request dialog shows
  the working days in the range and blocks overspending
  ([PR #75](https://github.com/romirom11/ordi/pull/75)).
- Editing comments on a task: the pencil on your own comment – and only on
  your own, nobody edits someone else's, a project admin moderates by deleting –
  opens the same editor in place, and an edited comment is marked
  "(edited)"; `PATCH /comments/:id` requires a non-empty body, notifies only
  new mentions and writes to the activity log
  ([PR #77](https://github.com/romirom11/ordi/pull/77)).
- Currency in Finance: the pickers offer USD/EUR/UAH from a single shared
  list, and a different stored code stays in the picker; income, subscriptions,
  a new company and a deal start in the workspace currency rather than USD
  ([PR #78](https://github.com/romirom11/ordi/pull/78)).
- PRs from agents follow the repository's template: the description is built
  from the agent's report (change, verification, risks) with a link to the
  task, and commits carry the task key where the convention allows, otherwise
  as a `Refs:` trailer
  ([PR #79](https://github.com/romirom11/ordi/pull/79)).

### v1.29.4

- English branch names for tasks in any language: before cloning, the worker
  asks haiku (one turn, no tools, via the Agent SDK, so it works with a
  subscription) for a 3–6-word slug from the task's title and description;
  with no answer, transliteration remains; Retry renames a branch that never
  made it to origin
  ([PR #76](https://github.com/romirom11/ordi/pull/76)).

### v1.29.3

- Branch names for Cyrillic task titles: the slug transliterates Cyrillic and
  strips diacritics instead of throwing away every non-ASCII letter, so a task
  with a Ukrainian title no longer gets a `feature/ord-26-` branch with no
  tail; no trailing hyphen when nothing is left of the title
  ([PR #74](https://github.com/romirom11/ordi/pull/74)).

### v1.29.2

- Sessions live on between runs: the Claude Code home lives in
  `tasks/<taskId>/harness` on the `agent_work` volume, so follow-up and Retry
  really do continue the conversation; if there's no session, the run starts
  afresh from the task branch rather than failing; task directories with no
  runs for 30 days are cleaned up.
- An early stop loses nothing: a rate limit pushes the work and continues the
  same session, the sessionId and branch are written straight away, an error
  during finalisation pushes before failed, the push uses a fresh installation
  token, a failed `rev-list` doesn't mean "nothing to push"; only real work
  goes into the commit (no `node_modules`, `dist`, `.env*`, logs).
- Runs and tasks: one active run per task and agent (migration 0037),
  follow-up/Retry carry the branch, a comment made while queued isn't lost,
  closed tasks don't start an agent and stay closed, other agents' comments
  don't trigger runs, a run token can't cancel/retry.
- Runtime: the repository's `CLAUDE.md` is loaded, the `ordi` tools are in the
  prompt from the first turn, `BashOutput`/`KillShell`/`Skill` are allowed.
- Task page: the log shows the last 500 events and appends the stream, runs
  are polled while active, Retry only on the newest one, translations and
  links in agent notifications, a profile form allowing up to 2000 turns, with
  hints.

### v1.29.1

- An agent's unfinished work isn't lost: a run that hits the step limit, a
  timeout or a cancellation pushes what it has committed to the task branch
  without a PR, records the branch on the run and names the limit in its
  comment; Retry continues the same session from the same branch. The
  `max_turns` default goes from 60 → 200, migration 0036
  ([PR #71](https://github.com/romirom11/ordi/pull/71)).

### v1.29.0

- AI agents as team members: an agent is added to the team and assigned a
  task like a person, a worker inside `api` clones the repository, runs Claude
  Code via the Agent SDK with the ordi MCP and the allowed connectors, streams
  the log to the task page and takes the work through to a pull request;
  Claude is connected once per workspace (a subscription token or an API key),
  connectors are a library with a per-agent allowlist via the ordi gateway, a
  new `agents.manage` permission, an `Agent` role, migration 0035
  ([PR #69](https://github.com/romirom11/ordi/pull/69)).
- Deactivation hands work over: the dialog asks whom to give the open tasks
  to, or leaves them unassigned; closed ones aren't touched
  ([PR #70](https://github.com/romirom11/ordi/pull/70)).
- A deactivated assignee can be removed from a task: the picker keeps them in
  the list with a marker ([PR #70](https://github.com/romirom11/ordi/pull/70)).
- Moving a task to another project from the row's context menu: a new number
  with a redirect, status matched by name, custom fields by the target
  project's definitions, only for admins of both projects
  ([PR #70](https://github.com/romirom11/ordi/pull/70)).
- Quick task creation pre-fills the open project
  ([PR #70](https://github.com/romirom11/ordi/pull/70)).
- The expense currency is a list that defaults to the workspace's currency
  ([PR #70](https://github.com/romirom11/ordi/pull/70)).

### v1.28.0

- One person = one name: the lookup returns the name from the linked HR card,
  writing the card and renaming in the profile keep both sides in sync,
  migration 0034 backfills existing links; an invite links/creates a card, a
  card with an existing account's email links itself, and gaps show up in a
  banner in Employees ([PR #68](https://github.com/romirom11/ordi/pull/68)).
- The profile slims down: the questionnaire and leave moved to the employee's
  own card, and the profile links to it via "My HR card"
  ([PR #68](https://github.com/romirom11/ordi/pull/68)).
- MCP sees images in descriptions: image nodes travel as text, as
  `![title](url)` with signed links, and survive read-edit-write
  ([PR #68](https://github.com/romirom11/ordi/pull/68)).
- Labels can be edited from the picker: name, colour, deletion
  ([PR #68](https://github.com/romirom11/ordi/pull/68)).
- Task status changes straight from the list with a click on the icon
  ([PR #68](https://github.com/romirom11/ordi/pull/68)).
- Emoji reactions on task comments, as in Slack
  ([PR #68](https://github.com/romirom11/ordi/pull/68)).
- HR calendar: holiday names on two lines + a day popup with the full list of
  events ([PR #68](https://github.com/romirom11/ordi/pull/68)).

### v1.27.0

- Avatars everywhere a person is shown: historical records (comments, audit,
  activity feeds) don't lose the name and photo of deactivated users, the APIs
  return the photo along with the name, resourcing works for non-admins
  ([PR #63](https://github.com/romirom11/ordi/pull/63)).
- The recruiting tab can create a job opening and add a candidate from the UI
  ([PR #63](https://github.com/romirom11/ordi/pull/63)).
- One-click Slack integration: the app is created via the Manifest API from a
  configuration token + a guide with a ready-made manifest for the manual route
  ([PR #64](https://github.com/romirom11/ordi/pull/64)).
- Slack channel picker: alphabetical order, a padlock on private channels, a
  hint about `/invite @ordi` ([PR #65](https://github.com/romirom11/ordi/pull/65)).
- Company pickers are sorted alphabetically and searchable; a fetch limit of
  200 instead of the 50 newest ([PR #66](https://github.com/romirom11/ordi/pull/66)).

### v1.26.0

- Intake requests: a mailbox UI in the project settings, attachments from
  emails (shown on the request card and carried over into the created task), a
  `/ordi` slash command in Slack ([PR #62](https://github.com/romirom11/ordi/pull/62)).
- People opened up: the directory and a public slice of the card for everyone
  signed in, self-service leave in the profile + an approvals block for the
  manager, a holidays panel in settings + holidays don't use up leave days, a
  separate permission for documents, working write grants for field groups
  ([PR #62](https://github.com/romirom11/ordi/pull/62)).
- Project-level custom fields (managed by the project admin in the project
  settings); the task's custom fields block collapses
  ([PR #62](https://github.com/romirom11/ordi/pull/62)).
- Resizable right panel on task/project/CRM cards with the width remembered;
  a "Location" field on the employee card; avatars on desktop and in histories
  ([PR #62](https://github.com/romirom11/ordi/pull/62)).
- A release is published only after all the desktop bundles have been built
  ([PR #62](https://github.com/romirom11/ordi/pull/62)).

### v1.25.0

- A unified dashboard for every role: personal work tiles + a "Team, next two
  weeks" card (absences, holidays, birthdays) with a deep link into the HR
  calendar; the finance/pipeline widgets moved to Finance and custom
  dashboards ([PR #61](https://github.com/romirom11/ordi/pull/61)).
- An employee's personal contacts – via custom fields instead of hard-coded
  card rows; icons for fields and field groups
  ([PR #61](https://github.com/romirom11/ordi/pull/61)).
- Date picker: year/month grids on a click on the header; author avatars in
  comments; the people directory takes the full name from the HR card
  ([PR #61](https://github.com/romirom11/ordi/pull/61)).

### v1.24.0

- The knowledge base accepts PDFs: a page type (article/PDF) in the create
  dialog, the file goes through the existing attachments pipeline, a built-in
  viewer, file replacement, export as a link ([PR #59](https://github.com/romirom11/ordi/pull/59)).
- List state survives navigation: sorting, filters, search and tabs in
  CRM/projects/finance/time/HR via localStorage with validation
  ([PR #59](https://github.com/romirom11/ordi/pull/59)).
- Notification emails are no longer empty (task name, status, actor from the
  current DB state), the logo in emails via a public route
  ([PR #59](https://github.com/romirom11/ordi/pull/59)).
- People → HR with a "Calendar" tab: absences, holidays, birthdays (a new
  card field, a yearly event)
  ([PR #60](https://github.com/romirom11/ordi/pull/60)).
- Field groups as units of access: a "groups × roles + the employee
  themselves" matrix in Settings → Roles, server-side enforcement, self-filled
  groups = an HR questionnaire in the profile with a completion status
  ([PR #60](https://github.com/romirom11/ordi/pull/60)).
- Extended employee card: work/personal email, phone, Telegram, documents
  with a built-in PDF viewer; custom fields are visible on every entity with a
  detail card
  ([PR #60](https://github.com/romirom11/ordi/pull/60)).
- The first e2e suite (Playwright: KB PDF, HR calendar, questionnaire) with a
  separate CI job ([PR #60](https://github.com/romirom11/ordi/pull/60)).

### v1.23.0

- Custom field management in settings: editing (label, flags, deprecation),
  deletion with confirmation and an options editor for
  select/multiselect – the API has been able to do this for a long time, the
  UI could only create them
  ([PR #58](https://github.com/romirom11/ordi/pull/58)).
- Lead labels: a third label vocabulary (scope `lead`) in the shared table,
  `lead_labels`, a picker in the lead's rail as for tasks, chips in the leads
  table, `labelIds` in the API with an entry in the activity log
  ([PR #58](https://github.com/romirom11/ordi/pull/58)).
- A company filter on the leads tab; the "Work" queue spans the full page width
  ([PR #58](https://github.com/romirom11/ordi/pull/58)).

### v1.22.1

- CRM dropdown menus take their field's width instead of a fixed 240px –
  long names (of sequences, for example) no longer break onto two lines next
  to empty space ([PR #57](https://github.com/romirom11/ordi/pull/57)).
- Opening the next select closes the previous one: the click-outside listener
  moved to the capture phase, which the dialog's `stopPropagation` used to swallow
  ([PR #57](https://github.com/romirom11/ordi/pull/57)).

### v1.22.0

- Every native browser select in the CRM has been replaced with the
  SearchSelect component: an app-styled dropdown with search from 8 options
  up, keyboard navigation and actions in the menu (the lead's contact picker
  can create a contact on the spot); the company and contact rows in the
  lead's rail lead to the company record
  ([PR #54](https://github.com/romirom11/ordi/pull/54)).
- Column sorting: the leads and clients tables (statuses in funnel order,
  empty values last), the invoice/quote lists got a header that doubles as the
  sort controls, and so did profitability and the time reports; leads got a
  filter by owner
  ([PR #54](https://github.com/romirom11/ordi/pull/54)).
- Lead, deal and company cards on a single layout: content at full width, a
  flexible 280–400px rail, values wrap instead of being truncated, empty
  fields are hidden on read-only records, sales history – 8 rows with
  "Show all", the next action card offers Complete/Schedule
  ([PR #54](https://github.com/romirom11/ordi/pull/54)).
- MCP `update_lead`/`create_lead` no longer lose suggestedChannel and the
  other research fields; custom fields are open for leads end to end – API,
  MCP, settings and the lead card
  ([PR #54](https://github.com/romirom11/ordi/pull/54)).

### v1.21.0

- The lead's text fields (product, signal, source, channel, score) moved from
  the narrow sidebar to a "Details" card in the main column: values wrap
  instead of being truncated, labels no longer break onto two lines, the
  source link is shown as a domain with the check date beneath it
  ([PR #53](https://github.com/romirom11/ordi/pull/53)).
- Deal custom fields – likewise as a card in the main column; the sidebar on
  both pages keeps the short facts: status/stage, client, contact, project,
  owner, money, dates, files
  ([PR #53](https://github.com/romirom11/ordi/pull/53)).

### v1.20.0

- A created KB page is a visible KB page: new pages are born published (a
  draft is a deliberate choice at creation or via "unpublish"), existing
  pages were published by a migration, the page shows a Draft badge with a
  Publish button, and the tree shows a draft icon instead of a green dot on
  everything ([PR #52](https://github.com/romirom11/ordi/pull/52)).
- The page visibility rule (draft → editors; private → author and editors)
  applies everywhere a page surfaces, not just in the tree: search, the
  activity feed and audit trail, version history, backlinks, duplication and
  SSE events no longer give away the titles and bodies of pages the actor
  can't open ([PR #52](https://github.com/romirom11/ordi/pull/52)).

### v1.19.0

- Files go through the API: `POST /attachments` accepts the file itself
  (multipart) and generates the key on the server, `GET /files/:id/:token`
  streams the bytes instead of redirecting to the storage. A presigned URL no
  longer reaches the browser, so a self-hosted install doesn't need public
  access to MinIO, CORS or a port exposed to the outside ([PR #47](https://github.com/romirom11/ordi/pull/47)).
- In-app file previews: images, PDF, video, audio and text types; scriptable
  types (html, svg, xml) are served with `Content-Security-Policy:
  sandbox` ([PR #47](https://github.com/romirom11/ordi/pull/47)).
- Uploading several files at once; storage failures respond with a 422 naming
  the environment variable instead of a 500
  ([PR #48](https://github.com/romirom11/ordi/pull/48)).
- Built-in MinIO in the prod stack behind `COMPOSE_PROFILES=minio`: the same
  credentials as the api, and a one-off bucket initialisation
  ([PR #48](https://github.com/romirom11/ordi/pull/48)).
- Unique network aliases `ordi-db` / `ordi-minio` – on a shared PaaS network,
  generic names resolved to other people's containers
  ([PR #49](https://github.com/romirom11/ordi/pull/49)).
- A context menu on lead rows (new tab, copy link, company, status, owner,
  delete)
  ([PR #47](https://github.com/romirom11/ordi/pull/47)).
- Lead status colours: the tone follows whose move it is now, not how deep
  into the funnel the lead is; finished and postponed leads stay grey
  ([PR #50](https://github.com/romirom11/ordi/pull/50)).

### v1.18.0

- Working with leads in batches: checkboxes and a bulk panel in the leads
  table (reassign the owner / change the status of up to 200 leads at once,
  with the single-lead rules and a per-lead error report), CSV import of leads
  with automatic company creation and a dry run, CSV export, an honest warning
  about a truncated list ([PR #45](https://github.com/romirom11/ordi/pull/45)).
- An "Analytics" tab in the CRM: the lead funnel, a 30-day trend, lead → deal
  conversion, the pipeline by stage (raw and weighted), win rate and loss
  reasons; the deals part is hidden without `deals.read`
  ([PR #45](https://github.com/romirom11/ordi/pull/45)).
- Intake request triage: a "Requests" tab with a counter, accept as a task /
  reject with a reason and an email to the author; in the project settings –
  switching on the public form and a link to it
  ([PR #45](https://github.com/romirom11/ordi/pull/45)).
- Cycles can be completed: cycle details with progress and a burndown from
  daily snapshots, open tasks move to the backlog or the next cycle
  ([PR #45](https://github.com/romirom11/ordi/pull/45)).
- Moving a task between projects brings along the whole subtree, comments,
  relations, links, attachments, logged time and a running timer
  ([PR #45](https://github.com/romirom11/ordi/pull/45)).
- Task templates and recurrence rules got a UI in the project settings; task
  lists show a blocked indicator; the project list counts progress with a
  single aggregate query
  ([PR #45](https://github.com/romirom11/ordi/pull/45)).
- Milestones hold tasks: a milestone on the task, grouping and a filter in the
  task views, real completed counts in the overview; project files with
  membership-based access; pagination of the full task list and stable
  sorting ([PR #44](https://github.com/romirom11/ordi/pull/44)).

### v1.17.0

- The CRM through a new salesperson's eyes: a lead can be filled in by hand
  again (all the qualification fields are editable in place, the owner can be
  chosen), the Work queue gained a "scheduled ahead" bucket, and the row's
  action depends on the bucket; a company and a contact can be created
  straight from the lead; the conversion button is always visible and explains
  what it's waiting for; the dashboard counts sales alongside tasks
  ([PR #43](https://github.com/romirom11/ordi/pull/43)).
- The research JSON import is gone: it froze one external tool's output
  format into the DB schema and the public API (snake_case fields, a blocklist
  of job board hosts in the code). Along with it went `research_batches`, four
  `leads` columns, `POST /leads/import*` and the MCP tools
  `import_research` / `preview_research_import`. Leads stayed
  ([PR #43](https://github.com/romirom11/ordi/pull/43)).
- A new Sales preset role: the whole CRM plus read access to projects and
  finance. Playbooks are seeded with a starter set – three templates and a
  three-step sequence
  ([PR #43](https://github.com/romirom11/ordi/pull/43)).
- Lost writes in the CRM: a stale PATCH of a client/contact/deal responds
  with 409 instead of a silent 200 with someone else's data; deleting a lead
  removes its scheduled activities and stops its sequence; `GET /deals` and
  `GET /companies` are capped and paginated by ULID; a direct URL without the
  permission shows a "no access" page
  ([PR #43](https://github.com/romirom11/ordi/pull/43)).
- The rich text editor brought to completion: underline, colour and
  highlight, alignment, tables, callouts in four tones, collapsible blocks,
  code with highlighting for 17 languages, images, a block handle with
  drag-reorder. Blocks are declared once, so the slash menu, the toolbar and
  the handle menu no longer drift apart.
- Images in documents: paste, drop and a dialog. The document stores a signed
  non-expiring `/api/v1/files/<id>/<token>` path instead of a presigned URL
  that goes stale within an hour. `/attachments/presign` signs the key it
  issues, and `/register` won't accept it without the signature.
- Modifier clicks on list rows (Cmd/Ctrl and the middle button), a single
  shortcut scheme with a help sheet on `Shift+?`, and external links that
  finally open on desktop.
- The landing page at [romirom11.github.io/ordi](https://romirom11.github.io/ordi)
  ([PR #42](https://github.com/romirom11/ordi/pull/42)). The site has since
  moved to [ordi.one](https://ordi.one) (the `ordi-cloud` repository); it's no
  longer in this repository.

### v1.16.0

- CRM sales workspace: the Work queue (overdue / today / awaiting reply /
  nurture / no next action), separate leads until qualification, sales
  activities as first-class records, research JSON preview and import, lead →
  deal conversion that keeps the history
  ([PR #37](https://github.com/romirom11/ordi/pull/37)).
- Playbooks: message templates with variables and sequences of manual steps –
  they schedule the next action but send nothing; a morning work digest in the
  salesperson's time zone; reliable email delivery through a queue with
  retries ([PR #40](https://github.com/romirom11/ordi/pull/40)).
- MCP: a content calendar from ordi – `get_project_schema`, `list_tasks` by
  date window, `get_task` with the body and comments, `create_task` /
  `update_task` / `upsert_task` / `add_task_link`, optimistic locking by
  version and `externalKey` instead of duplicates
  ([PR #39](https://github.com/romirom11/ordi/pull/39)).

### v1.11.0

- The CRM module, a complete rework in two rounds
  ([PR #24](https://github.com/romirom11/ordi/pull/24),
  [PR #25](https://github.com/romirom11/ordi/pull/25)): inline editing of
  everything on the company and deal cards, files (S3), editable custom
  fields, Notion-style notes, creating/linking projects from the client card,
  honest tab titles, tooltips without truncation, DateField instead of
  native date inputs, decoding of HTML entities from agents.

### v1.10.0

- GitHub App: one-click app creation via a manifest, automatic webhook
  registration, repository sync on installation, JWT authorisation without an
  SDK ([PR #23](https://github.com/romirom11/ordi/pull/23), recovered
  from a forgotten branch).
- Fix: webhook signature verification is now real HMAC-SHA256 (it used to be
  sha256(secret+body) – GitHub signatures would never have passed).
- Fix: branches with a lowercase task key (as "Copy branch name" generates
  them) now link to tasks.

### v1.9.0

- Deal → project relation (`deals.project_id`, a real FK): filter chips on the
  kanban, a picker on the deal card, support in MCP
  ([PR #22](https://github.com/romirom11/ordi/pull/22)).
- Bulk selection in the client and task lists (shift ranges, bulk
  status/priority/delete) + tab dragging + a DnD fix on desktop
  ([PR #21](https://github.com/romirom11/ordi/pull/21)).
- CRM breadcrumbs following the app's pattern (no echo of the title),
  truncation of long names.
- This feature register.

### v1.8.0

- Deal page `/deals/:id`: stage, amounts, custom fields, notes, activity;
  full breadcrumbs in the CRM.
- MCP: the full CRM set – `create_company` / `create_contact` / `create_deal`,
  `list_contacts` / `list_deals` / `list_deal_stages`.
- MCP: custom fields – `create_custom_field` / `list_custom_fields` +
  `customFields` in the create tools.
- Multi-line text from agents keeps its structure (notes, comments,
  KB pages); `create_note` attaches to a contact or a deal.
- The dashboard activity feed is filtered by domain permissions; your own
  actions are always visible.
- Audit: notes and custom field definitions write activity records.

### v1.7.0

- MCP: `list_projects` / `list_companies` – agents can look up ids.
- Global search covers projects.
- MCP tool responses are scrubbed (secrets and internal fields don't reach
  the model's context).

### Earlier

See the [CHANGELOG](../CHANGELOG.md) – from v1.0.0 to v1.6.1: the all-in-one
container, OAuth for MCP clients, desktop (Tauri), finance with a ledger,
People/HR, KB, cycles, automations on the event bus.
