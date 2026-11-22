//! Commands called from the pages. Which page may call which command is decided by the
//! capabilities: the Finance Chat site only gets the "site" set (permissions/default.toml).

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;

use crate::settings::{self, Settings, SHORTCUTS};
use crate::{shortcut, windows, AppState};

/* ---------- Site (remote) and local pages ---------- */

#[tauri::command]
pub fn quick_ready(app: AppHandle) {
    app.state::<AppState>().set_quick_ready(true);
}

#[tauri::command]
pub fn quick_hide(app: AppHandle) {
    windows::hide_quick(&app);
}

#[tauri::command]
pub fn quick_resize(app: AppHandle, height: f64) {
    windows::resize_quick(&app, height);
}

/// Shows the main window; with an account id, the chat of that account opens there.
#[tauri::command]
pub fn open_main(app: AppHandle, account_id: Option<String>) {
    windows::hide_quick(&app);
    windows::show_main(&app);
    if let Some(account_id) = account_id.filter(|id| !id.is_empty() && id.len() <= 64) {
        let _ = app.emit_to(windows::MAIN, "desktop://open-account", json!({ "accountId": account_id }));
    }
}

#[tauri::command]
pub fn open_settings(app: AppHandle) {
    windows::hide_quick(&app);
    windows::show_settings(&app);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    version: String,
    shortcut: String,
    shortcut_label: String,
    shortcut_error: Option<String>,
    shortcut_paused: bool,
    voice_ready: bool,
}

/// A summary for the site: version, shortcut and whether voice is ready (no settings values beyond that).
#[tauri::command]
pub fn desktop_info(app: AppHandle) -> DesktopInfo {
    let state = app.state::<AppState>();
    let current = state.settings.lock().map(|settings| settings.clone()).unwrap_or_default();
    DesktopInfo {
        version: app.package_info().version.to_string(),
        shortcut_label: shortcut::label(&current.shortcut),
        shortcut: current.shortcut,
        shortcut_error: state.shortcut_error.lock().ok().and_then(|error| error.clone()),
        shortcut_paused: state.shortcut_paused(),
        voice_ready: crate::voice::ready(&app),
    }
}

/* ---------- Local pages only (loader, setup, settings) ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoaderTarget {
    server_url: Option<String>,
    /// Where the window goes once the server answers.
    url: Option<String>,
}

#[tauri::command]
pub fn loader_target(app: AppHandle, window: String) -> LoaderTarget {
    let server_url = app.state::<AppState>().settings.lock().ok().and_then(|settings| settings.server_url.clone());
    let path = if window == windows::QUICK { "/quick" } else { "/" };
    LoaderTarget { url: server_url.as_ref().map(|origin| format!("{origin}{path}")), server_url }
}

/// Checks that the address answers like a Finance Chat server (GET /health → {"ok":true}).
#[tauri::command]
pub async fn check_server(url: String) -> Result<String, String> {
    let origin = settings::normalize_server_url(&url)?;
    let client = reqwest::Client::builder().timeout(Duration::from_secs(8)).build().map_err(|error| error.to_string())?;
    let response = client
        .get(format!("{origin}/health"))
        .send()
        .await
        .map_err(|_| format!("Não foi possível conectar a {origin}. Verifique o endereço e a sua conexão."))?;
    let not_finance_chat = || format!("{origin} respondeu, mas não parece ser um servidor do Finance Chat.");
    if !response.status().is_success() {
        return Err(not_finance_chat());
    }
    let body = response.text().await.map_err(|_| not_finance_chat())?;
    let value: serde_json::Value = serde_json::from_str(&body).map_err(|_| not_finance_chat())?;
    if value.get("ok") != Some(&serde_json::Value::Bool(true)) {
        return Err(not_finance_chat());
    }
    Ok(origin)
}

#[derive(Serialize)]
pub struct Choice {
    value: String,
    label: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    server_url: Option<String>,
    shortcut: String,
    shortcuts: Vec<Choice>,
    shortcut_error: Option<String>,
    voice_model: String,
    models: Vec<crate::voice::ModelInfo>,
    voice_available: bool,
    sounds: bool,
    autostart: bool,
    version: String,
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> SettingsView {
    let state = app.state::<AppState>();
    let current = state.settings.lock().map(|settings| settings.clone()).unwrap_or_default();
    SettingsView {
        shortcuts: SHORTCUTS.iter().map(|value| Choice { value: (*value).into(), label: shortcut::label(value) }).collect(),
        shortcut_error: state.shortcut_error.lock().ok().and_then(|error| error.clone()),
        models: crate::voice::models(&app),
        voice_available: crate::voice::AVAILABLE,
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        version: app.package_info().version.to_string(),
        server_url: current.server_url,
        shortcut: current.shortcut,
        voice_model: current.voice_model,
        sounds: current.sounds,
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsInput {
    server_url: String,
    shortcut: String,
    voice_model: String,
    sounds: bool,
    autostart: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    /// The server changed: the app restarts so the new site gets its permissions.
    restarting: bool,
    shortcut_error: Option<String>,
}

#[tauri::command]
pub fn save_settings(app: AppHandle, input: SettingsInput) -> Result<SaveResult, String> {
    let server_url = settings::normalize_server_url(&input.server_url)?;
    if !SHORTCUTS.contains(&input.shortcut.as_str()) {
        return Err("Escolha um dos atalhos da lista.".into());
    }
    if !settings::MODELS.contains(&input.voice_model.as_str()) {
        return Err("Escolha um dos modelos de voz da lista.".into());
    }
    let state = app.state::<AppState>();
    let previous = state.settings.lock().map(|settings| settings.clone()).unwrap_or_default();
    let next = Settings { server_url: Some(server_url), shortcut: input.shortcut, voice_model: input.voice_model, sounds: input.sounds };
    settings::save(&app, &next)?;
    if let Ok(mut current) = state.settings.lock() {
        *current = next.clone();
    }
    let autostart = app.autolaunch();
    let result = if input.autostart { autostart.enable() } else { autostart.disable() };
    if result.is_err() {
        return Err("As configurações foram salvas, mas não foi possível alterar o início automático.".into());
    }
    if next.shortcut != previous.shortcut {
        shortcut::apply(&app);
    }
    let restarting = next.server_url != previous.server_url;
    if restarting {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            app.restart();
        });
    }
    Ok(SaveResult { restarting, shortcut_error: state.shortcut_error.lock().ok().and_then(|error| error.clone()) })
}
