# ordi desktop – how it works (internal documentation)

The desktop app (Tauri 2, PRD §18) is **the same web SPA with no separate
UI code at all**. Tauri only wraps the `apps/web/dist` build in a native window
and adds system capabilities. Everything "desktop" in the web code is isolated in a single
module – `apps/web/src/lib/desktop.ts` – and only switches on when the app is
actually running inside Tauri.

## 1. How the SPA knows it is on the desktop

`tauri.conf.json` enables `app.withGlobalTauri: true` – Tauri injects
`window.__TAURI__` (core invoke, events, window API) straight into the page, so
**there are no Tauri npm dependencies in the web package**. Detection:

```ts
// apps/web/src/lib/desktop.ts
export const isTauri = '__TAURI__' in window || '__TAURI_INTERNALS__' in window;
```

Every native call is best-effort inside a `try/catch`: a missing plugin or an old
runtime version never breaks the app (let alone affects the web).

## 2. First launch: the instance URL

In the browser the SPA talks to the same-origin `/api/v1` (the same container serves
both the SPA and the API). In Tauri there is no same-origin API, so:

1. `main.tsx`, when `isTauri && !getInstanceUrl()`, renders **InstanceGate** –
   the "Connect to your ordi instance" screen (localised uk/en).
2. The URL entered is validated with a `GET {url}/healthz` request (8 s timeout).
3. Success → the URL is saved to `localStorage['ordi:apiUrl']` → reload.
4. The API client (`apps/web/src/lib/api.ts`) builds the base as
   `{saved URL}/api/v1`; in the browser the value is empty and everything works
   same-origin, as before.

Changing the instance = clearing `ordi:apiUrl` in localStorage (or the app data).

## 3. Authentication: why Bearer and not a cookie

The session cookie is `SameSite=Lax` – from the `tauri://localhost` (macOS) or
`http://tauri.localhost` (Windows/Linux) origin it is cross-site and **will not be
sent**. Therefore:

- `POST /auth/login` returns `sessionToken` in the body (the same token that goes into
  the cookie). The web ignores it; the desktop (Login.tsx, only when `isTauri`) stores it in
  `localStorage['ordi:sessionToken']`.
- The API client adds `Authorization: Bearer <token>` to every request when
  a token is stored.
- Backend (`apps/api/src/core/auth.ts`): the Bearer is first looked up among
  API tokens (SHA-256 hash), and if not found – among **sessions** (that is the
  desktop case). Permissions are the role's full scope, as with a cookie session.
- `POST /auth/logout` revokes the session from both the cookie and the Bearer header;
  on sign-out the Shell clears `ordi:sessionToken`.

CORS: the desktop origin is already in the default allowlist (`tauri://localhost`); for
Windows/Linux add `http://tauri.localhost` to the instance's `CORS_ORIGINS`.

## 4. Native features: where everything lives

| Feature (PRD §18) | Implementation | Flow |
|---|---|---|
| OS notifications | `lib/sse.ts` → `notifyDesktop()` | SSE event from the catalogue (assignment, mention, payment, quote accepted, leave decision, PR merged) → `plugin:notification\|notify` |
| Unread badge | `NotificationsBell.tsx` → `setBadge()` | `unread` change → `Window.setBadgeCount` (dock/taskbar; tray icon and tooltip come from the config) |
| Global quick-add hotkey | Rust `main.rs` + `Shell.tsx` | `Cmd/Ctrl+Shift+O` registered in Rust (`setup`, best-effort) → show/focus the window + emit `ordi://quick-add` → Shell opens the quick task creation modal |
| Deep links `ordi://task/KLD-42` | `deep-link` config + `lib/desktop.ts` | the plugin emits `deep-link://new-url` → parse `KEY-N` → `GET /search?q=KEY-N` → navigate to the task |
| External links | `lib/desktop.ts` → `installExternalLinkHandler()` | delegated click on `document` → `plugin:opener\|open_url` in the system browser; the webview ignores `target="_blank"`, so without this handler links are simply dead |
| Autostart | `autostart` plugin (Rust) | initialised; enabling it is a standard plugin call |
| Auto-update | `updater` plugin + CI | signed artefacts from releases; endpoint and pubkey are in `tauri.conf.json → plugins.updater` |
| Signing in to third-party services (GitHub App, GitHub OAuth, Slack, MCP connectors) | `lib/desktop.ts` → `startExternalFlow()` | on the web the tab itself goes to the provider; on the desktop the flow opens in the system browser, the window shows "Continue in your browser" and re-fetches what changed when focus returns (15 min). Provider callbacks are public and authenticated with a signed `state`, because the redirect does not carry the desktop bearer token. The browser gets the GitHub App manifest from the `GET /integrations/github-app/manifest/launch` page, which posts the form itself |
| Two-finger swipe back/forward | web `components/tabs/SwipeNavigation.tsx` + `lib/swipeNav.ts` | read from plain wheel events and steps the **active tab's** history (`tabs.go`). The page stays still; an arrow slides in from the window edge as the swipe builds up. A gesture that opens vertically stays a scroll, content that can still scroll sideways (kanban, wide tables) keeps the swipe until its edge, and an open dialog blocks it. The webview's own gesture (`WKWebView.allowsBackForwardNavigationGestures` / WebKitGTK) is deliberately left off: it slides a snapshot of the whole window, sidebar included, the snapshot of an SPA page is often missing (a black half-window mid-swipe), and it walks the webview's global history rather than the tab's. Desktop app only – browsers answer the swipe themselves |
| "Workspace" menu (macOS) | Rust `main.rs` | New Task `⌘N`, Search `⌘K`, Toggle Sidebar `⌘\`, Settings… `⌘,`, Keyboard Shortcuts `⌘/` – the items emit `ordi://menu` with the command id, and the web layer does the rest |

The Rust code (`apps/desktop/src-tauri/src/main.rs`) is deliberately minimal: plugin
initialisation, hotkey registration with its handler, the macOS menu and enabling swipe. All the logic is in the web layer, so that
diffs do not require recompiling the native part.

## 5. Icons

`apps/desktop/src-tauri/icons/` (32/128/128@2x/512 PNG, `icon.ico`,
`icon.icns`) – generated and **committed**; the bundler does not need to
fetch anything. Regeneration (plain Node, no dependencies):

```bash
node scripts/gen-desktop-icons.mjs
```

## 6. Build and releases

- **Dev** (requires Rust + the system GTK/WebKit dependencies):
  `pnpm --filter @ordi/desktop tauri dev` (starts the vite dev server itself).
- **Release builds**: pushing a `v*` tag → `.github/workflows/desktop.yml` →
  tauri-action builds **macOS universal / Windows msi / Linux AppImage+deb**
  and puts them in a draft GitHub release.
## 5a. Signing in through the browser

Instead of entering the email and password a second time, the app opens the browser, where
the user is already signed in. The scheme is PKCE, so that another app that
intercepts `ordi://` cannot exchange the code for a session:

1. The desktop generates a `verifier` (keeps it to itself) and a `state`, sends only
   `sha256(verifier)` to `POST /auth/desktop/start`, then opens
   `{instance}/desktop-auth?state=…` in the system browser.
2. The `/desktop-auth` page requires sign-in (if not signed in, it sends the user to
   `/login?next=…` and back again), shows the device name and the account, and
   asks for confirmation.
3. `POST /auth/desktop/approve` (with the browser cookie) creates a one-time code.
4. The browser hands the code over via `ordi://auth?code=…&state=…`; the code is also shown
   on screen, because deep links do not fire on every Linux desktop.
5. The desktop sends `POST /auth/desktop/exchange` with the code and the `verifier`; the server
   checks the hash, creates a session and **deletes** the request – the code is single-use.

Requests live for 10 minutes; expired ones are cleaned up on every new start.
The deep link listener for this flow lives in `pages/Login.tsx`, not in `Shell`,
because on the sign-in screen the shell is not mounted yet.

Four things without which sign-in fails with "Browser sign-in did not complete":

- **The PKCE hash does not depend on `crypto.subtle`.** It only exists in a secure
  context, and the desktop runs on the `tauri://localhost` origin, which some
  platforms do not consider secure – then the very first step failed and the browser did not even
  open. There is our own SHA-256 implementation (`lib/sha256.ts`) as a fallback.

- **`tauri-plugin-single-instance` is registered first.** On Windows and Linux
  `ordi://…` launches a *new* process; the plugin intercepts it, hands the argv to
  the running instance, and that instance emits `deep-link://new-url`. Without it the window
  waiting for the code would never find out about it.
- **The `verifier` is kept in `localStorage`, not in `sessionStorage`.** A deep link
  may restart the app, and a new webview would not see the previous one's
  `sessionStorage` – and would have nothing to redeem the code with.
- **A cold start reads the launch URL** (`plugin:deep-link|get_current`):
  if the app was closed, the link arrives as an argument, not as an event.

On top of that, the sign-in screen has a "paste the code" field – the last line of defence if
the deep link still did not work (typical for some Linux desktops).

## 5c. Custom title bar (macOS)

`titleBarStyle: "Overlay"` hides the native bar, and the "traffic lights" sit
**on top of the top-left corner of the window** – that is the sidebar, not the tab strip in the
right column.

The buttons are drawn by the system, so you cannot "put them in a div" – but their position
is set by `trafficLightPosition` in `tauri.conf.json` (requires `titleBarStyle:
Overlay` and `decorations: true`). Ours are at `{x:16, y:12}` – centred in the
empty `h-9` strip the sidebar starts with **on macOS only**
(`isMacDesktop`). The workspace name goes below it, from the left edge of the sidebar, the same on
all platforms. The tab strip, meanwhile, is in the right column, so the
tabs are still on the same row as the window buttons.

The attempt to shift the name to the right instead of the strip (`pl-[84px]`, as in v1.5.4)
looks more compact, but eats a third of the narrow sidebar and only makes sense
on macOS – dropped in v1.5.5.

The main thing: **`data-tauri-drag-region` does not work without the
`core:window:allow-start-dragging` permission** in `capabilities/default.json`. It is not
part of `core:default`, and without it the window simply cannot be dragged –
silently, with no error at all. You can check that the permission is in place in the
generated `src-tauri/gen/schemas/capabilities.json`.

A quick check of title bar changes without a release: `pnpm --filter @ordi/desktop dev`
(requires Rust) – a build takes seconds, not a full CI release.

## 5b. Downloading the app from the web

`GET /api/v1/desktop/latest` returns the version and the installer links,
taking them from GitHub Releases and caching them for an hour. The `/download` page
(the "Download desktop app" item in the workspace menu at the top of the sidebar, hidden
in the desktop app itself) detects the platform and puts the right button first.

The repository is configured via `DESKTOP_RELEASES_REPO` – a fork points to its own.
If the instance has no outbound network, the endpoint returns an empty list and the page
shows a link to the releases page.

## 6a. Auto-update

Enabled and working through GitHub releases:

- `bundle.createUpdaterArtifacts: true` – tauri-action puts signed
  update artefacts into the release along with `latest.json`.
- **`app` must be in `bundle.targets`**: on macOS the update package
  is built from the `.app` bundle specifically. Without it the build produces only a `.dmg` for manual
  installation, and `latest.json` will have no `darwin-*` platforms – and Mac clients
  will silently never see an update. Check after a release:
  `curl -sSL .../releases/latest/download/latest.json | jq '.platforms | keys'`
  must contain `darwin-aarch64` and `darwin-x86_64`.
- `plugins.updater.endpoints` points to
  `https://github.com/romirom11/ordi/releases/latest/download/latest.json`
  (works because the repository is public).
- `plugins.updater.pubkey` – the public key; the private one is in the repository secret
  `TAURI_SIGNING_PRIVATE_KEY` (no password, so
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is empty). The app rejects updates without a valid
  signature.
- Flow: Rust (`check_and_download` in `src/main.rs`) quietly checks for an
  update at startup, then every 30 minutes, and also right away when the web
  layer sees that the server is newer (the `check_update` command). It only
  **downloads** the new build and keeps it in memory, then emits
  `ordi://update-ready`. Until a build is ready, the user sees nothing.
- Once the build is ready, an "Update to vX" row appears in the sidebar
  footer above Settings (`UpdateIndicator.tsx`). Clicking it calls
  `install_update`: install and relaunch. Installing deliberately does not
  happen in the background: on Windows the installer closes the app, and
  the `.deb` asks for a password. On macOS the downloaded build is also
  installed when the app quits.
- If the server is older than the app, the same spot shows a yellow
  "Server needs an update" row with a link to the instructions; it can be
  dismissed for a specific pair of versions. On the web, a new bundle is
  picked up by a full reload on the next page navigation.

Key rotation: `pnpm --filter @ordi/desktop exec tauri signer generate`,
the new public key goes into `tauri.conf.json`, the new private one – into the secret.
Clients with the old key will stop accepting updates, so the new version
will have to be installed manually.

## 6b. Permissions (capabilities)

Tauri 2 gives the web layer nothing without a capability file, so
`src-tauri/capabilities/default.json` explicitly allows: `core:default` (events),
`core:window:allow-set-badge-count` (badge), `notification:default`,
`updater:default`, `process:allow-restart`, `deep-link:default`. Without this
file native notifications, the badge and deep links silently do not work.

Opening links requires **two** entries: `opener:allow-open-url` enables
the command itself, and `opener:allow-default-urls` gives it a scope (`http://*`,
`https://*`, `mailto:*`, `tel:*`). `allow-open-url` on its own leaves the scope
empty, and `open_url` rejects **any** address with `ForbiddenUrl` – the button
can be clicked, but the browser does not open.

## 7. Verification status

Verified live in this repository (without compiling Rust):
- bearer cycle: login → `/me` 200 → logout → 401 (curl);
- full simulation of the Tauri runtime in headless Chromium (injecting
  `window.__TAURI__` before load): InstanceGate → validation → login →
  token saved → the app works cross-origin, 0 console errors.

**Not verified here** (no GTK/WebKit toolchain): compiling Rust and the
binaries themselves – CI does that on a tag. If the first workflow run
stumbles somewhere, the fixes are expected to be targeted (plugin versions/signatures), not
architectural.
