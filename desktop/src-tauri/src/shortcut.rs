//! The global shortcut (Alt+Espaço by default): a quick tap opens the quick window to
//! type; holding it records the voice until it is released (push to talk).
//!
//! Tap or hold is decided by a small state machine ([`Hold`]), kept free of timers and
//! of Tauri so it can be unit tested. Keyboard auto-repeat is absorbed: some systems
//! (X11) send release+press pairs while a key is held, so a release only counts after a
//! short quiet period without a new press.

use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::{tray, voice, windows, AppState};

/// Held longer than this, the shortcut means "speak".
pub const HOLD_AFTER: Duration = Duration::from_millis(280);
/// A release followed by a press within this time is keyboard auto-repeat, not a new gesture.
pub const RELEASE_DEBOUNCE: Duration = Duration::from_millis(60);

#[derive(Debug, PartialEq, Eq)]
pub enum Press {
    /// Auto-repeat or a key already down.
    Ignored,
    /// A new press: check again after [`HOLD_AFTER`] with this generation.
    StartTimer(u64),
    /// An auto-repeat continuation that is already past [`HOLD_AFTER`].
    StartVoice,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Gesture {
    Tap,
    VoiceEnd,
}

#[derive(Debug, Default)]
pub struct Hold {
    down: bool,
    generation: u64,
    presses: u64,
    voice: bool,
    pressed_at: Option<Instant>,
    released_at: Option<Instant>,
}

impl Hold {
    pub fn press(&mut self, now: Instant) -> Press {
        self.presses += 1;
        if self.down {
            return Press::Ignored;
        }
        if let Some(released) = self.released_at {
            if now.duration_since(released) < RELEASE_DEBOUNCE {
                // Auto-repeat: the key never really went up.
                self.down = true;
                self.released_at = None;
                let held = self.pressed_at.map(|pressed| now.duration_since(pressed) >= HOLD_AFTER).unwrap_or(false);
                if held && !self.voice {
                    self.voice = true;
                    return Press::StartVoice;
                }
                return Press::Ignored;
            }
        }
        self.down = true;
        self.released_at = None;
        self.pressed_at = Some(now);
        self.generation += 1;
        self.voice = false;
        Press::StartTimer(self.generation)
    }

    /// Called [`HOLD_AFTER`] after a press: true when the key is still down (start the voice capture).
    pub fn hold_elapsed(&mut self, generation: u64) -> bool {
        if self.down && self.generation == generation && !self.voice {
            self.voice = true;
            return true;
        }
        false
    }

    /// Returns a snapshot to settle after [`RELEASE_DEBOUNCE`], or None if the key was not down.
    pub fn release(&mut self, now: Instant) -> Option<u64> {
        if !self.down {
            return None;
        }
        self.down = false;
        self.released_at = Some(now);
        Some(self.presses)
    }

    /// The release is final unless a press arrived since the snapshot.
    pub fn settle(&mut self, snapshot: u64) -> Option<Gesture> {
        if self.presses != snapshot || self.down {
            return None;
        }
        self.released_at = None;
        self.pressed_at = None;
        if std::mem::take(&mut self.voice) {
            Some(Gesture::VoiceEnd)
        } else {
            Some(Gesture::Tap)
        }
    }
}

/// "Control+Shift+Space" → "Ctrl+Shift+Espaço" (menus, hints and screen readers).
pub fn label(accelerator: &str) -> String {
    accelerator
        .split('+')
        .map(|part| match part {
            "Space" => "Espaço",
            "Control" | "CommandOrControl" => "Ctrl",
            "Super" => {
                if cfg!(target_os = "macos") {
                    "⌘"
                } else {
                    "Win"
                }
            }
            other => other,
        })
        .collect::<Vec<_>>()
        .join("+")
}

/// (Re)registers the configured shortcut, or none while paused. The error, if any,
/// is kept for the settings window and the tray menu.
pub fn apply(app: &AppHandle) {
    let state = app.state::<AppState>();
    let accelerator = state.settings.lock().map(|settings| settings.shortcut.clone()).unwrap_or_default();
    let manager = app.global_shortcut();
    let _ = manager.unregister_all();
    let error = if state.shortcut_paused() { None } else { register(app, &accelerator).err() };
    if let Ok(mut slot) = state.shortcut_error.lock() {
        *slot = error;
    }
    tray::refresh(app);
}

fn register(app: &AppHandle, accelerator: &str) -> Result<(), String> {
    let shortcut: Shortcut = accelerator.parse().map_err(|_| format!("Atalho inválido: {}.", label(accelerator)))?;
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| match event.state {
            ShortcutState::Pressed => on_press(app),
            ShortcutState::Released => on_release(app),
        })
        .map_err(|_| {
            format!(
                "O atalho {} não está disponível: outro programa pode estar usando. Escolha outro nas configurações do app.",
                label(accelerator)
            )
        })
}

fn with_hold<T>(app: &AppHandle, action: impl FnOnce(&mut Hold) -> T) -> Option<T> {
    app.state::<AppState>().hold.lock().ok().map(|mut hold| action(&mut hold))
}

fn on_press(app: &AppHandle) {
    match with_hold(app, |hold| hold.press(Instant::now())) {
        Some(Press::StartTimer(generation)) => {
            let app = app.clone();
            thread::spawn(move || {
                thread::sleep(HOLD_AFTER);
                if with_hold(&app, |hold| hold.hold_elapsed(generation)) == Some(true) {
                    voice::hold_start(&app);
                }
            });
        }
        Some(Press::StartVoice) => voice::hold_start(app),
        _ => {}
    }
}

fn on_release(app: &AppHandle) {
    let Some(Some(snapshot)) = with_hold(app, |hold| hold.release(Instant::now())) else { return };
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(RELEASE_DEBOUNCE);
        match with_hold(&app, |hold| hold.settle(snapshot)).flatten() {
            Some(Gesture::Tap) => {
                if windows::quick_is_active(&app) {
                    windows::hide_quick(&app);
                } else {
                    windows::show_quick(&app, "text");
                }
            }
            Some(Gesture::VoiceEnd) => voice::hold_end(&app),
            None => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(start: Instant, millis: u64) -> Instant {
        start + Duration::from_millis(millis)
    }

    #[test]
    fn a_quick_tap_is_a_tap() {
        let start = Instant::now();
        let mut hold = Hold::default();
        assert_eq!(hold.press(start), Press::StartTimer(1));
        let snapshot = hold.release(at(start, 120)).unwrap();
        assert!(!hold.hold_elapsed(1), "released before the hold time");
        assert_eq!(hold.settle(snapshot), Some(Gesture::Tap));
    }

    #[test]
    fn holding_starts_and_releasing_ends_the_voice() {
        let start = Instant::now();
        let mut hold = Hold::default();
        assert_eq!(hold.press(start), Press::StartTimer(1));
        assert!(hold.hold_elapsed(1));
        assert!(!hold.hold_elapsed(1), "only once");
        let snapshot = hold.release(at(start, 2_000)).unwrap();
        assert_eq!(hold.settle(snapshot), Some(Gesture::VoiceEnd));
    }

    #[test]
    fn auto_repeat_release_press_pairs_do_not_end_the_hold() {
        let start = Instant::now();
        let mut hold = Hold::default();
        hold.press(start);
        assert!(hold.hold_elapsed(1));
        let snapshot = hold.release(at(start, 600)).unwrap();
        assert_eq!(hold.press(at(start, 602)), Press::Ignored);
        assert_eq!(hold.settle(snapshot), None, "the press cancelled that release");
        assert_eq!(hold.press(at(start, 640)), Press::Ignored, "still down");
        let last = hold.release(at(start, 1_500)).unwrap();
        assert_eq!(hold.settle(last), Some(Gesture::VoiceEnd));
    }

    #[test]
    fn auto_repeat_past_the_hold_time_starts_the_voice_once() {
        let start = Instant::now();
        let mut hold = Hold::default();
        hold.press(start);
        // The timer check happened during a repeat gap (key reported up): no voice yet.
        let snapshot = hold.release(at(start, 270)).unwrap();
        assert!(!hold.hold_elapsed(1));
        assert_eq!(hold.press(at(start, 300)), Press::StartVoice);
        assert_eq!(hold.settle(snapshot), None);
        let last = hold.release(at(start, 900)).unwrap();
        assert_eq!(hold.settle(last), Some(Gesture::VoiceEnd));
    }

    #[test]
    fn a_new_press_after_the_debounce_is_a_new_gesture() {
        let start = Instant::now();
        let mut hold = Hold::default();
        hold.press(start);
        let snapshot = hold.release(at(start, 100)).unwrap();
        assert_eq!(hold.settle(snapshot), Some(Gesture::Tap));
        assert_eq!(hold.press(at(start, 400)), Press::StartTimer(2));
        let second = hold.release(at(start, 500)).unwrap();
        assert_eq!(hold.settle(second), Some(Gesture::Tap));
    }

    #[test]
    fn labels_are_readable() {
        assert_eq!(label("Alt+Space"), "Alt+Espaço");
        assert_eq!(label("Control+Shift+Space"), "Ctrl+Shift+Espaço");
    }
}
