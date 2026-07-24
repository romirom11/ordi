// ordi desktop (Tauri 2) – wraps apps/web unchanged (PRD §18).
// Native features: tray (config), OS notifications (invoked from the web layer
// via the notification plugin), global quick-add shortcut (below), autostart,
// deep links (ordi://…, handled by the web layer via plugin events), updater.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{ShortcutState, GlobalShortcutExt};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
        .setup(|app| {
            // Best-effort: a failed registration (e.g. shortcut taken) must not
            // prevent the app from starting.
            let _ = app
                .global_shortcut()
                .register("CommandOrControl+Shift+O");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running ordi desktop");
}
