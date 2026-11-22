//! Finance Chat desktop app (Tauri 2): it runs in the system tray, opens the Finance
//! Chat site in its main window and a quick entry window with a global shortcut
//! (tap to type, hold to speak), and transcribes the voice locally with Whisper.
//!
//! The site is the same one the browser uses (sessions, previews, confirmations and
//! history do not change); the app adds only the window, shortcut and voice glue. The
//! site may call a small set of commands (permissions/default.toml), granted at runtime
//! to the configured server origin only.

mod audio;
mod commands;
mod model;
mod settings;
mod shortcut;
mod sound;
mod tray;
mod voice;
mod windows;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, RunEvent};

#[derive(Default)]
pub struct AppState {
    pub settings: Mutex<settings::Settings>,
    pub hold: Mutex<shortcut::Hold>,
    pub shortcut_error: Mutex<Option<String>>,
    pub tray: Mutex<Option<tray::TrayItems>>,
    pub voice: voice::Voice,
    shortcut_paused: AtomicBool,
    quick_ready: AtomicBool,
}

impl AppState {
    pub fn shortcut_paused(&self) -> bool {
        self.shortcut_paused.load(Ordering::SeqCst)
    }

    pub fn set_shortcut_paused(&self, paused: bool) {
        self.shortcut_paused.store(paused, Ordering::SeqCst);
    }

    pub fn quick_ready(&self) -> bool {
        self.quick_ready.load(Ordering::SeqCst)
    }

    pub fn set_quick_ready(&self, ready: bool) {
        self.quick_ready.store(ready, Ordering::SeqCst);
    }

    /// Voice capture or transcription in progress (the quick window must stay open).
    pub fn voice_busy(&self) -> bool {
        self.voice.busy()
    }
}

/// The Finance Chat site may call the "site" commands and listen to app events, nothing else.
fn grant_site(app: &AppHandle, origin: &str) -> tauri::Result<()> {
    app.add_capability(
        CapabilityBuilder::new("site")
            .remote(format!("{origin}/*"))
            .window(windows::MAIN)
            .window(windows::QUICK)
            .permission("site")
            .permission("core:event:allow-listen")
            .permission("core:event:allow-unlisten"),
    )
}

fn setup(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let current = settings::load(app);
    if let Ok(mut slot) = app.state::<AppState>().settings.lock() {
        *slot = current.clone();
    }
    if let Some(origin) = &current.server_url {
        grant_site(app, origin)?;
    }
    // Started with the system (autostart): stay in the tray.
    let hidden = std::env::args().any(|argument| argument == "--hidden");
    windows::create_main(app, !hidden)?;
    if current.server_url.is_some() {
        windows::create_quick(app)?;
    }
    tray::create(app)?;
    shortcut::apply(app);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        // A second launch (or "--quick" from a system shortcut on Wayland) reuses this instance.
        .plugin(tauri_plugin_single_instance::init(|app, arguments, _cwd| {
            if arguments.iter().any(|argument| argument == "--quick") {
                windows::show_quick(app, "text");
            } else {
                windows::show_main(app);
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::quick_ready,
            commands::quick_hide,
            commands::quick_resize,
            commands::open_main,
            commands::open_settings,
            commands::voice_toggle,
            commands::desktop_info,
            commands::loader_target,
            commands::check_server,
            commands::get_settings,
            commands::save_settings,
            commands::download_model,
            commands::delete_model,
        ])
        .on_window_event(windows::on_window_event)
        .setup(|app| setup(app.handle()))
        .build(tauri::generate_context!())
        .expect("failed to start the Finance Chat desktop app")
        .run(|_app, event| {
            // Closing windows only hides them; the app quits from the tray menu.
            if let RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
