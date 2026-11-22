//! App settings, stored as JSON in the app config directory. They hold no secret:
//! the session lives in the webview's cookies, like in a browser.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Global shortcuts offered in the settings (a fixed list keeps them valid on every OS).
pub const SHORTCUTS: &[&str] = &["Alt+Space", "Control+Shift+Space", "Control+Alt+Space", "Super+Shift+Space"];
pub const DEFAULT_SHORTCUT: &str = "Alt+Space";
/// Whisper models offered for download (multilingual ggml files of whisper.cpp).
pub const MODELS: &[&str] = &["base", "small"];
pub const DEFAULT_MODEL: &str = "small";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Origin of the Finance Chat server ("https://finance.example.com"), or None before the first setup.
    pub server_url: Option<String>,
    pub shortcut: String,
    pub voice_model: String,
    /// Sound cues when voice capture starts and stops.
    pub sounds: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { server_url: None, shortcut: DEFAULT_SHORTCUT.into(), voice_model: DEFAULT_MODEL.into(), sounds: true }
    }
}

impl Settings {
    /// Anything unknown in the file falls back to the defaults (never fails to start the app).
    pub fn sanitized(mut self) -> Self {
        self.server_url = self.server_url.as_deref().and_then(|value| normalize_server_url(value).ok());
        if !SHORTCUTS.contains(&self.shortcut.as_str()) {
            self.shortcut = DEFAULT_SHORTCUT.into();
        }
        if !MODELS.contains(&self.voice_model.as_str()) {
            self.voice_model = DEFAULT_MODEL.into();
        }
        self
    }
}

/// "finance.example.com/" → "https://finance.example.com"; only http(s), no credentials, no path.
pub fn normalize_server_url(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("Informe o endereço do Finance Chat.".into());
    }
    let candidate = if trimmed.contains("://") { trimmed.to_string() } else { format!("https://{trimmed}") };
    let invalid = || "Endereço inválido. Use, por exemplo, https://finance.seudominio.com.".to_string();
    let url = url::Url::parse(&candidate).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err(invalid());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("O endereço não pode conter usuário ou senha.".into());
    }
    Ok(url.origin().ascii_serialization())
}

fn settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    settings_path(app)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .unwrap_or_default()
        .sanitized()
}

/// Written to a temporary file first, so a crash never leaves a half-written file.
pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app).ok_or("Pasta de configuração indisponível.")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|error| format!("Não foi possível criar a pasta de configuração: {error}"))?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, text).map_err(|error| format!("Não foi possível salvar as configurações: {error}"))?;
    fs::rename(&temporary, &path).map_err(|error| format!("Não foi possível salvar as configurações: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_urls_are_reduced_to_their_origin() {
        assert_eq!(normalize_server_url("finance.example.com/").unwrap(), "https://finance.example.com");
        assert_eq!(normalize_server_url(" https://Finance.Example.com/chat?x=1 ").unwrap(), "https://finance.example.com");
        assert_eq!(normalize_server_url("http://192.168.0.10:3000").unwrap(), "http://192.168.0.10:3000");
        assert_eq!(normalize_server_url("https://finance.example.com:443").unwrap(), "https://finance.example.com");
        assert!(normalize_server_url("").is_err());
        assert!(normalize_server_url("ftp://example.com").is_err());
        assert!(normalize_server_url("https://user:pass@example.com").is_err());
        assert!(normalize_server_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn unknown_values_fall_back_to_defaults() {
        let settings = Settings { server_url: Some("not a url ::".into()), shortcut: "F13".into(), voice_model: "huge".into(), sounds: false }.sanitized();
        assert_eq!(settings, Settings { sounds: false, ..Settings::default() });
        let parsed: Settings = serde_json::from_str(r#"{"serverUrl":"finance.example.com"}"#).unwrap();
        assert_eq!(parsed.sanitized().server_url.as_deref(), Some("https://finance.example.com"));
    }
}
