// ordi desktop (Tauri 2) – wraps apps/web unchanged (PRD §18).
// Native features: tray (config), OS notifications (invoked from the web layer
// via the notification plugin), global quick-add shortcut (below), autostart,
// deep links (ordi://…, handled by the web layer via plugin events), updater.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
// Only the runtime scheme registration below needs this trait, and that is
// Windows/Linux-only – importing it unconditionally warns on macOS.
#[cfg(any(windows, target_os = "linux"))]
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{ShortcutState, GlobalShortcutExt};
use std::sync::Mutex;
use tauri_plugin_updater::{Update, UpdaterExt};

/// How often a running app looks for a new desktop build. The web layer also
/// asks right away when it sees the server move ahead, so this is the backstop.
const UPDATE_CHECK_EVERY: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// A desktop build that is downloaded and verified but not installed yet.
/// Installing is deferred to the person's click (or quitting on macOS): on
/// Windows the installer exits the app and a .deb asks for a password, neither
/// of which may happen out of the blue in the background.
#[derive(Default)]
struct PendingUpdate(Mutex<Option<(Update, Vec<u8>)>>);

/// Check for a newer build and download it, reporting what happened:
/// "ready:<version>", "none" (nothing newer published yet) or "error". A build
/// already downloaded is reported as ready without touching the network.
/// Every successful download is announced to the web layer, which shows the
/// quiet "Update" row in the sidebar.
async fn check_and_download(app: tauri::AppHandle) -> String {
    if let Some(version) = pending_version(&app) {
        return format!("ready:{version}");
    }
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(_) => return "error".into(),
    };
    match updater.check().await {
        Ok(Some(update)) => match update.download(|_, _| {}, || {}).await {
            Ok(bytes) => {
                let version = update.version.clone();
                if let Ok(mut slot) = app.state::<PendingUpdate>().0.lock() {
                    *slot = Some((update, bytes));
                }
                let _ = app.emit("ordi://update-ready", version.clone());
                format!("ready:{version}")
            }
            Err(_) => "error".into(),
        },
        Ok(None) => "none".into(),
        Err(_) => "error".into(),
    }
}

fn pending_version(app: &tauri::AppHandle) -> Option<String> {
    let slot = app.state::<PendingUpdate>();
    let guard = slot.0.lock().ok()?;
    guard.as_ref().map(|(update, _)| update.version.clone())
}

/// Install the downloaded build, if any. Taking it out of the slot makes a
/// second call (the click, then the exit hook) a no-op.
fn install_pending(app: &tauri::AppHandle) -> Result<bool, String> {
    let pending = app
        .state::<PendingUpdate>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .take();
    match pending {
        Some((update, bytes)) => update.install(bytes).map(|_| true).map_err(|e| e.to_string()),
        None => Ok(false),
    }
}

/// On-demand check for the web layer, called when it sees the server run a
/// newer version than this build.
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> String {
    check_and_download(app).await
}

/// The version downloaded and waiting for a restart, for a webview that
/// loaded after the "update-ready" event went out.
#[tauri::command]
fn update_status(app: tauri::AppHandle) -> Option<String> {
    pending_version(&app)
}

/// The sidebar's "Update" row: install and start the new build. On Windows
/// the installer quits the app itself and relaunches it when done.
#[tauri::command]
fn install_update(app: tauri::AppHandle) -> Result<(), String> {
    install_pending(&app)?;
    app.restart();
}

fn main() {
    tauri::Builder::default()
        // MUST be first (Tauri requirement). On Windows and Linux a deep link
        // starts a NEW process; without this the running window never hears
        // about ordi://auth and a browser sign-in can never finish.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // The second launch carries the URL in argv; hand it to the web
            // layer under the same event name the plugin uses.
            let urls: Vec<String> = argv
                .into_iter()
                .filter(|arg| arg.starts_with("ordi://"))
                .collect();
            if !urls.is_empty() {
                let _ = app.emit("deep-link://new-url", urls);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Opens links in the user's browser. The capability must grant
        // `opener:allow-default-urls` next to `opener:allow-open-url`: the
        // command permission alone leaves the URL scope EMPTY, and open_url
        // rejects every address it is handed, so nothing ever opens.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // Quick-add (PRD §18): bring the window up and let the web
                    // layer open its task quick-create modal.
                    if event.state() == ShortcutState::Pressed {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                            let _ = window.emit("ordi://quick-add", ());
                        }
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(PendingUpdate::default())
        .invoke_handler(tauri::generate_handler![check_update, update_status, install_update])
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(command) = id.strip_prefix("ordi-") {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("ordi://menu", command);
                }
            }
        })
        .setup(|app| {
            // Preserve the native Edit / Window commands and expose the web
            // workspace's actions in the macOS menu bar.
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem, Submenu};
                let menu = Menu::default(app.handle())?;
                let task = MenuItem::with_id(app, "ordi-new-task", "New Task", true, Some("CmdOrCtrl+N"))?;
                let search = MenuItem::with_id(app, "ordi-search", "Search", true, Some("CmdOrCtrl+K"))?;
                let sidebar = MenuItem::with_id(app, "ordi-sidebar", "Toggle Sidebar", true, Some("CmdOrCtrl+\\"))?;
                let preferences = MenuItem::with_id(app, "ordi-preferences", "Settings…", true, Some("CmdOrCtrl+,"))?;
                let shortcuts = MenuItem::with_id(app, "ordi-shortcuts", "Keyboard Shortcuts", true, Some("CmdOrCtrl+/"))?;
                let workspace = Submenu::with_items(app, "Workspace", true, &[&task, &search, &sidebar, &preferences, &shortcuts])?;
                menu.append(&workspace)?;
                app.set_menu(menu)?;
            }
            // Best-effort: a failed registration (e.g. shortcut taken) must not
            // prevent the app from starting.
            let _ = app
                .global_shortcut()
                .register("CommandOrControl+Shift+O");
            // Windows and Linux only register the ordi:// scheme at install
            // time; doing it at runtime too makes dev builds and portable
            // installs handle deep links as well.
            #[cfg(any(windows, target_os = "linux"))]
            let _ = app.deep_link().register_all();
            // Look for a new build at launch and then every half hour. Failures
            // (offline, GitHub unreachable, nothing published yet) stay silent;
            // the next round simply tries again.
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                let _ = tauri::async_runtime::block_on(check_and_download(handle.clone()));
                std::thread::sleep(UPDATE_CHECK_EVERY);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building ordi desktop")
        .run(|_app, _event| {
            // Quitting with a build downloaded applies it, so the next launch
            // is already up to date. macOS only: replacing the bundle there is
            // silent, while Windows would show its installer and a .deb would
            // ask for a password on the way out.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Exit = _event {
                let _ = install_pending(_app);
            }
        });
}
