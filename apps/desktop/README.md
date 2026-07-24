# ordi desktop (Tauri 2)

Wraps `apps/web` with no separate UI code (PRD §18). Native additions, all wired
through `apps/web/src/lib/desktop.ts` (via `withGlobalTauri`, no extra npm deps):

- **First launch** asks for the instance URL (validated against `/healthz`);
  the SPA then talks to that origin and authenticates with a **bearer session
  token** (the `tauri://` origin can't share same-site cookies).
- **OS notifications** driven by the SSE stream (assignments, mentions,
  payments, leave decisions…).
- **Dock/taskbar unread badge** mirrored from the in-app notification count;
  tray icon + tooltip from config.
- **Global quick-add shortcut** `Cmd/Ctrl+Shift+O` (registered in Rust): brings
  the window up and opens the task quick-create modal.
- **Deep links** `ordi://task/KLD-42` → resolved via search → opens the task.
- **Autostart** plugin and a **signed auto-updater** fed by CI releases.

## Develop
```bash
pnpm --filter @ordi/web dev        # start the web dev server
pnpm --filter @ordi/desktop tauri dev
```

## Build
Requires the Rust toolchain and platform build deps. Produces macOS universal,
Windows `.msi`, and Linux AppImage/deb bundles.
```bash
pnpm --filter @ordi/desktop tauri build
```

On first launch the app asks for the API instance URL.

> The Rust crate and bundle config live in `src-tauri/`. This package is
> config-only in the headless CI build here; binaries are produced by the
> desktop release pipeline.
