//! The three windows: the main chat, the quick entry window (frameless, always on top,
//! summoned by the global shortcut) and the app settings. Main and quick start on a
//! bundled loader page that checks the server and then opens the Finance Chat site.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent};

use crate::AppState;

pub const MAIN: &str = "main";
pub const QUICK: &str = "quick";
pub const SETTINGS: &str = "settings";

pub const QUICK_WIDTH: f64 = 640.0;
pub const QUICK_MIN_HEIGHT: f64 = 120.0;
pub const QUICK_MAX_HEIGHT: f64 = 640.0;

/// Focus of the quick window flaps right after it appears (WebKitGTK focus moving into the web view):
/// it only hides when it is still unfocused after a short pause, and never right after being shown.
const BLUR_SETTLE: Duration = Duration::from_millis(250);
const SHOW_GRACE: Duration = Duration::from_millis(600);
static QUICK_FOCUSED: AtomicBool = AtomicBool::new(false);
static QUICK_FOCUS_EVENTS: AtomicU64 = AtomicU64::new(0);
static QUICK_SHOWN_AT: Mutex<Option<Instant>> = Mutex::new(None);

pub fn create_main(app: &AppHandle, visible: bool) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Finance Chat")
        .inner_size(1200.0, 800.0)
        .min_inner_size(380.0, 520.0)
        .visible(visible)
        .build()
}

pub fn create_quick(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, QUICK, WebviewUrl::App("quick.html".into()))
        // The window title is what screen readers announce when it appears.
        .title("Registro rápido — Finance Chat")
        .inner_size(QUICK_WIDTH, 168.0)
        // Resizable so the height can follow the content (GTK ignores set_size on fixed-size windows);
        // without decorations there is nothing for the user to drag.
        .resizable(true)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .center()
        .build()
}

fn create_settings(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, SETTINGS, WebviewUrl::App("settings.html".into()))
        .title("Configurações do app — Finance Chat")
        .inner_size(600.0, 760.0)
        .min_inner_size(420.0, 480.0)
        .center()
        .build()
}

fn reveal(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN).or_else(|| create_main(app, true).ok()) {
        reveal(&window);
    }
}

pub fn show_settings(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(SETTINGS).or_else(|| create_settings(app).ok()) {
        reveal(&window);
    }
}

/// Shows the quick window and tells the page why ("text": a tap, "voice": a hold).
/// Before the first setup there is no server yet, so the main window (setup) opens instead.
pub fn show_quick(app: &AppHandle, mode: &str) {
    let configured = app.state::<AppState>().settings.lock().map(|settings| settings.server_url.is_some()).unwrap_or(false);
    if !configured {
        show_main(app);
        return;
    }
    if let Some(window) = app.get_webview_window(QUICK).or_else(|| create_quick(app).ok()) {
        if let Ok(mut shown) = QUICK_SHOWN_AT.lock() {
            *shown = Some(Instant::now());
        }
        let _ = window.show();
        let _ = window.set_focus();
        // Some window managers ignore a focus request made before the window is mapped: ask again shortly after.
        let again = window.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(120));
            if again.is_visible().unwrap_or(false) {
                let _ = again.set_focus();
            }
        });
        let _ = app.emit_to(QUICK, "quick://shown", json!({ "mode": mode }));
    }
}

pub fn hide_quick(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(QUICK) {
        let _ = window.hide();
    }
}

pub fn quick_is_active(app: &AppHandle) -> bool {
    app.get_webview_window(QUICK)
        .map(|window| window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false))
        .unwrap_or(false)
}

/// The quick page reports its content height; the window follows it within limits.
pub fn resize_quick(app: &AppHandle, height: f64) {
    if let Some(window) = app.get_webview_window(QUICK) {
        let height = if height.is_finite() { height.clamp(QUICK_MIN_HEIGHT, QUICK_MAX_HEIGHT) } else { QUICK_MIN_HEIGHT };
        let _ = window.set_size(LogicalSize::new(QUICK_WIDTH, height));
    }
}

/// Closing hides (the app keeps running in the tray); the quick window also hides when it loses focus,
/// except while voice is being captured or transcribed.
pub fn on_window_event(window: &Window, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } if window.label() == QUICK => {
            api.prevent_close();
            let _ = window.hide();
        }
        WindowEvent::CloseRequested { api, .. } if window.label() == MAIN => {
            if window.app_handle().state::<AppState>().has_tray() {
                api.prevent_close();
                let _ = window.hide();
            } else {
                window.app_handle().exit(0);
            }
        }
        WindowEvent::Focused(focused) if window.label() == QUICK => {
            QUICK_FOCUSED.store(*focused, Ordering::SeqCst);
            let event = QUICK_FOCUS_EVENTS.fetch_add(1, Ordering::SeqCst) + 1;
            if *focused {
                return;
            }
            let app = window.app_handle().clone();
            thread::spawn(move || {
                thread::sleep(BLUR_SETTLE);
                let unchanged = QUICK_FOCUS_EVENTS.load(Ordering::SeqCst) == event && !QUICK_FOCUSED.load(Ordering::SeqCst);
                let settled = QUICK_SHOWN_AT.lock().ok().and_then(|shown| *shown).map(|shown| shown.elapsed() >= SHOW_GRACE).unwrap_or(true);
                if unchanged && settled && !app.state::<AppState>().voice_busy() {
                    hide_quick(&app);
                }
            });
        }
        _ => {}
    }
}
