# ordi desktop (Tauri 2)

Wraps `apps/web` with no separate UI code (PRD §18). Native additions: system
tray with unread-notification badge, OS notifications driven by the SSE stream, a
global quick-add shortcut (small always-on-top window), autostart, deep links
(`ordi://task/KLD-42`), and a signed auto-updater fed by CI releases.

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
