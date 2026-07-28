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
use tauri_plugin_updater::UpdaterExt;

/// Look for a newer release and stage it in the background. The web layer is
/// told once the update is installed so it can offer a restart; a failure here
/// (offline, GitHub unreachable, no release yet) must stay silent.
async fn stage_update(app: tauri::AppHandle) {
    let _ = check_and_stage(app).await;
}

/// Check + stage, reporting what happened: "staged:<version>", "none" (no
/// newer release published yet) or "error". Shared by the silent launch check
/// and the on-demand command the web layer calls from the version banner.
async fn check_and_stage(app: tauri::AppHandle) -> String {
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(_) => return "error".into(),
    };
    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            if update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                let _ = app.emit("ordi://update-ready", version.clone());
                format!("staged:{version}")
            } else {
                "error".into()
            }
        }
        Ok(None) => "none".into(),
        Err(_) => "error".into(),
    }
}

/// On-demand update check for the web layer: the version banner shows
/// "server is newer" and this answers whether a matching desktop build is
/// actually published and staged, or not out yet.
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> String {
    check_and_stage(app).await
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
        .invoke_handler(tauri::generate_handler![check_update])
        .setup(|app| {
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
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(stage_update(handle));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ordi desktop");
}
