# Changelog

Release notes for each version live in [`docs/releases`](docs/releases) and are
published to [GitHub Releases](https://github.com/romirom11/ordi/releases).

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
