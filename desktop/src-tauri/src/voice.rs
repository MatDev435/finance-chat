//! Voice capture (push to talk). First step: holding the shortcut only opens the quick
//! window; local transcription arrives in the next step.

use tauri::AppHandle;

use crate::windows;

pub fn hold_start(app: &AppHandle) {
    windows::show_quick(app, "text");
}

pub fn hold_end(_app: &AppHandle) {}

/// Whether this build includes local speech recognition.
pub const AVAILABLE: bool = false;

#[derive(Default)]
pub struct Voice;

impl Voice {
    pub fn busy(&self) -> bool {
        false
    }
}

#[derive(serde::Serialize)]
pub struct ModelInfo;

pub fn models(_app: &AppHandle) -> Vec<ModelInfo> {
    Vec::new()
}

pub fn ready(_app: &AppHandle) -> bool {
    false
}
