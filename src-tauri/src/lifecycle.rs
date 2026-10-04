use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
use tauri::{
    menu::{CheckMenuItem, CheckMenuItemBuilder, MenuBuilder, MenuItem, MenuItemBuilder},
    tray::{TrayIcon, TrayIconBuilder},
    ActivationPolicy, Emitter, Manager,
};
#[cfg(target_os = "macos")]
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;

#[cfg(target_os = "macos")]
const OPEN_STATION_MENU_ID: &str = "lifecycle_open_station";
#[cfg(target_os = "macos")]
const OPEN_OVERLAY_MENU_ID: &str = "lifecycle_open_overlay";
#[cfg(target_os = "macos")]
const LAUNCH_AT_LOGIN_MENU_ID: &str = "lifecycle_launch_at_login";
#[cfg(target_os = "macos")]
const QUIT_STATION_MENU_ID: &str = "lifecycle_quit_station";
#[cfg(target_os = "macos")]
const LIFECYCLE_SETTINGS_CHANGED_EVENT: &str = "lifecycle-settings-changed";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleSettings {
    launch_at_login: bool,
    supported: bool,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleSettingsInput {
    launch_at_login: bool,
}

fn settings(launch_at_login: bool, supported: bool) -> LifecycleSettings {
    LifecycleSettings {
        launch_at_login: supported && launch_at_login,
        supported,
    }
}

pub fn is_background_launch<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    args.into_iter()
        .any(|argument| argument.as_ref() == "--background")
}

pub fn should_hide_for_exit_request(code: Option<i32>) -> bool {
    code.is_none()
}

#[cfg(target_os = "macos")]
struct LifecycleMenuState {
    launch_at_login: CheckMenuItem<tauri::Wry>,
    open_overlay: MenuItem<tauri::Wry>,
    _tray: TrayIcon<tauri::Wry>,
}

#[cfg(target_os = "macos")]
fn autostart_error(error: impl std::fmt::Display) -> String {
    format!("Could not update Launch at Login: {error}")
}

#[cfg(target_os = "macos")]
fn current_launch_at_login(app: &tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(autostart_error)
}

#[cfg(target_os = "macos")]
fn apply_launch_at_login(app: &tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    if enabled {
        app.autolaunch().enable().map_err(autostart_error)?;
    } else {
        app.autolaunch().disable().map_err(autostart_error)?;
    }
    current_launch_at_login(app)
}

#[cfg(target_os = "macos")]
fn sync_launch_at_login_menu(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if let Some(state) = app.try_state::<LifecycleMenuState>() {
        state
            .launch_at_login
            .set_checked(enabled)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn publish_launch_at_login(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    sync_launch_at_login_menu(app, enabled)?;
    app.emit(LIFECYCLE_SETTINGS_CHANGED_EVENT, settings(enabled, true))
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub fn set_quick_capture_available(app: &tauri::AppHandle, available: bool) -> Result<(), String> {
    if let Some(state) = app.try_state::<LifecycleMenuState>() {
        state
            .open_overlay
            .set_enabled(available)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn set_quick_capture_available(
    _app: &tauri::AppHandle,
    _available: bool,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn show_workspace(app: &tauri::AppHandle) -> Result<(), String> {
    app.set_activation_policy(ActivationPolicy::Regular)
        .map_err(|error| error.to_string())?;
    app.set_dock_visibility(true)
        .map_err(|error| error.to_string())?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "The main window is unavailable.".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
pub fn hide_workspace(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window("main") {
        window.hide().map_err(|error| error.to_string())?;
    }
    app.set_activation_policy(ActivationPolicy::Accessory)
        .map_err(|error| error.to_string())?;
    app.set_dock_visibility(false)
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn hide_workspace(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn setup(
    app: &mut tauri::App,
    background_launch: bool,
    quick_capture_available: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if background_launch {
        app.set_activation_policy(ActivationPolicy::Accessory);
        app.set_dock_visibility(false);
    }

    let launch_at_login_enabled = current_launch_at_login(app.handle()).unwrap_or_else(|error| {
        eprintln!("{error}");
        false
    });
    let open_station =
        MenuItemBuilder::with_id(OPEN_STATION_MENU_ID, "Open Station").build(app.handle())?;
    let open_overlay = MenuItemBuilder::with_id(OPEN_OVERLAY_MENU_ID, "Open Overlay")
        .enabled(quick_capture_available)
        .build(app.handle())?;
    let launch_at_login = CheckMenuItemBuilder::with_id(LAUNCH_AT_LOGIN_MENU_ID, "Launch at Login")
        .checked(launch_at_login_enabled)
        .build(app.handle())?;
    let quit_station =
        MenuItemBuilder::with_id(QUIT_STATION_MENU_ID, "Quit Station").build(app.handle())?;
    let menu = MenuBuilder::new(app.handle())
        .item(&open_station)
        .item(&open_overlay)
        .separator()
        .item(&launch_at_login)
        .separator()
        .item(&quit_station)
        .build()?;

    let mut tray_builder = TrayIconBuilder::with_id("station-menu-bar")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Station by DevCrashFlash")
        .icon_as_template(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            OPEN_STATION_MENU_ID => {
                if let Err(error) = show_workspace(app) {
                    eprintln!("Could not open Station: {error}");
                }
            }
            OPEN_OVERLAY_MENU_ID => {
                if let Err(error) = super::toggle_quick_capture(app) {
                    eprintln!("Could not open Quick Capture: {error}");
                }
            }
            LAUNCH_AT_LOGIN_MENU_ID => {
                let result = current_launch_at_login(app)
                    .and_then(|enabled| apply_launch_at_login(app, !enabled));
                match result {
                    Ok(enabled) => {
                        if let Err(error) = publish_launch_at_login(app, enabled) {
                            eprintln!("Could not update the Launch at Login menu: {error}");
                        }
                    }
                    Err(error) => {
                        eprintln!("{error}");
                        if let Ok(enabled) = current_launch_at_login(app) {
                            let _ = sync_launch_at_login_menu(app, enabled);
                        }
                    }
                }
            }
            QUIT_STATION_MENU_ID => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray_builder = tray_builder.icon(icon);
    }
    let tray = tray_builder.build(app.handle())?;

    app.manage(LifecycleMenuState {
        launch_at_login,
        open_overlay,
        _tray: tray,
    });
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn setup(
    _app: &mut tauri::App,
    _background_launch: bool,
    _quick_capture_available: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

pub fn handle_run_event(app: &tauri::AppHandle, event: &tauri::RunEvent) {
    #[cfg(target_os = "macos")]
    match event {
        tauri::RunEvent::Reopen { .. } => {
            if let Err(error) = show_workspace(app) {
                eprintln!("Could not reopen Station: {error}");
            }
        }
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            if should_hide_for_exit_request(*code) {
                api.prevent_exit();
                if let Err(error) = hide_workspace(app) {
                    eprintln!("Could not hide Station: {error}");
                }
            }
        }
        _ => {}
    }

    #[cfg(not(target_os = "macos"))]
    let _ = (app, event);
}

#[tauri::command]
pub fn lifecycle_settings(app: tauri::AppHandle) -> Result<LifecycleSettings, String> {
    #[cfg(target_os = "macos")]
    return current_launch_at_login(&app).map(|enabled| settings(enabled, true));

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Ok(settings(false, false))
    }
}

#[tauri::command]
pub fn save_lifecycle_settings(
    app: tauri::AppHandle,
    input: LifecycleSettingsInput,
) -> Result<LifecycleSettings, String> {
    #[cfg(target_os = "macos")]
    {
        let enabled = apply_launch_at_login(&app, input.launch_at_login)?;
        publish_launch_at_login(&app, enabled)?;
        return Ok(settings(enabled, true));
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, input);
        Ok(settings(false, false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn background_launch_requires_the_exact_argument() {
        assert!(is_background_launch(["station", "--background"]));
        assert!(!is_background_launch(["station", "--background-task"]));
        assert!(!is_background_launch(["station", "background"]));
    }

    #[test]
    fn only_user_exit_requests_hide_the_application() {
        assert!(should_hide_for_exit_request(None));
        assert!(!should_hide_for_exit_request(Some(0)));
        assert!(!should_hide_for_exit_request(Some(i32::MAX)));
    }

    #[test]
    fn unsupported_lifecycle_settings_cannot_report_autostart() {
        assert_eq!(
            settings(true, false),
            LifecycleSettings {
                launch_at_login: false,
                supported: false,
            }
        );
        assert_eq!(
            settings(true, true),
            LifecycleSettings {
                launch_at_login: true,
                supported: true,
            }
        );
    }
}
