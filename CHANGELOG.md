# Changelog

Release notes for each version live in [`docs/releases`](docs/releases) and are
published to [GitHub Releases](https://github.com/romirom11/ordi/releases).

## v1.5.4

- macOS: fixed the v1.5.3 title bar. The window is draggable again (the
  capability was missing core:window:allow-start-dragging) and the traffic
  lights no longer cover the workspace switcher - the clearance moved to the
  sidebar, where they actually are.

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
