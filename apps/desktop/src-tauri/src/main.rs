// ordi desktop (Tauri 2) — wraps apps/web unchanged (PRD §18).
// Native features: tray with notification badge, OS notifications from SSE,
// global quick-add shortcut, autostart, deep links (ordi://task/KEY-42),
// signed updater. Built in CI; not compiled in the headless build environment.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .run(tauri::generate_context!())
        .expect("error while running ordi desktop");
}
