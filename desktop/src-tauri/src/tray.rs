//! System tray icon and menu (native menus, read by screen readers).

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::{shortcut, windows, AppState};

/// Menu items whose text or state changes at runtime.
pub struct TrayItems {
    quick: MenuItem<Wry>,
    pause: CheckMenuItem<Wry>,
}

fn quick_text(app: &AppHandle) -> String {
    let state = app.state::<AppState>();
    let accelerator = state.settings.lock().map(|settings| settings.shortcut.clone()).unwrap_or_default();
    let unavailable = state.shortcut_error.lock().map(|error| error.is_some()).unwrap_or(false);
    if state.shortcut_paused() {
        "Registro rápido (atalho pausado)".into()
    } else if unavailable {
        "Registro rápido (atalho indisponível)".into()
    } else {
        format!("Registro rápido ({})", shortcut::label(&accelerator))
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let quick = MenuItem::with_id(app, "quick", quick_text(app), true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Abrir o Finance Chat", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Configurações do app…", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(app, "pause", "Pausar o atalho global", true, false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Sair do Finance Chat", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&quick, &open, &PredefinedMenuItem::separator(app)?, &settings, &pause, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

    let mut builder = TrayIconBuilder::with_id("tray")
        .tooltip("Finance Chat")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "quick" => windows::show_quick(app, "text"),
            "open" => windows::show_main(app),
            "settings" => windows::show_settings(app),
            "pause" => {
                let state = app.state::<AppState>();
                state.set_shortcut_paused(!state.shortcut_paused());
                shortcut::apply(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                windows::show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;

    if let Ok(mut items) = app.state::<AppState>().tray.lock() {
        *items = Some(TrayItems { quick, pause });
    }
    Ok(())
}

/// Updates the texts after the shortcut changes, is paused or fails to register.
pub fn refresh(app: &AppHandle) {
    let state = app.state::<AppState>();
    let Ok(items) = state.tray.lock() else { return };
    if let Some(items) = items.as_ref() {
        let _ = items.quick.set_text(quick_text(app));
        let _ = items.pause.set_checked(state.shortcut_paused());
    }
}
