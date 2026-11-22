// Every app command gets an "allow-<command>" permission; capabilities decide who may call it
// (src-tauri/permissions/default.toml): the Finance Chat site only gets the "site" set.
const COMMANDS: &[&str] = &[
    "quick_ready",
    "quick_hide",
    "quick_resize",
    "open_main",
    "open_settings",
    "voice_toggle",
    "desktop_info",
    "loader_target",
    "check_server",
    "get_settings",
    "save_settings",
];

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("failed to run tauri-build");
}
