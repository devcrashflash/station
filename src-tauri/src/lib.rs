use rusqlite::{params, Connection as SqliteConnection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha1::{Digest as Sha1Digest, Sha1};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg(target_os = "macos")]
use objc2_app_kit::NSScreen;
#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, ManagerExt as PanelManagerExt, StyleMask, WebviewWindowExt};

mod calendar;
mod terminal_tabs;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static GOOGLE_OAUTH_ACTIVE: AtomicBool = AtomicBool::new(false);
static GOOGLE_OAUTH_CANCELLED: AtomicBool = AtomicBool::new(false);
const DEFAULT_PROJECT_COLOR: &str = "#2563eb";
const BROWSER_BUNDLE_ID_SETTING_KEY: &str = "browser_bundle_id";
const DEFAULT_QUICK_CAPTURE_SHORTCUT: &str = "CommandOrControl+Shift+Space";
const QUICK_CAPTURE_SHORTCUT_SETTING_KEY: &str = "quick_capture_shortcut";
#[cfg(not(target_os = "macos"))]
const BLANK_BROWSER_TAB_URL: &str = "about:blank";
const OCR_DETECTION_MODEL_URL: &str =
    "https://ocrs-models.s3-accelerate.amazonaws.com/text-detection.rten";
const OCR_RECOGNITION_MODEL_URL: &str =
    "https://ocrs-models.s3-accelerate.amazonaws.com/text-recognition.rten";

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(QuickCapturePanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false,
            is_floating_panel: true
        }
    })

    panel_event!(QuickCapturePanelEventHandler {
        window_did_become_key(notification: &NSNotification) -> (),
        window_did_resign_key(notification: &NSNotification) -> ()
    })
}

#[cfg(target_os = "macos")]
fn macos_extract_launch_services_bundle_id(entry: &str) -> Option<String> {
    entry.lines().find_map(|line| {
        let value = line
            .trim()
            .strip_prefix("LSHandlerRoleAll = ")?
            .trim_end_matches(';')
            .trim_matches('"');

        if value.is_empty() || value == "-" {
            None
        } else {
            Some(value.to_string())
        }
    })
}

#[cfg(target_os = "macos")]
fn macos_default_browser_bundle_id() -> Option<String> {
    let output = Command::new("defaults")
        .args([
            "read",
            "com.apple.LaunchServices/com.apple.launchservices.secure",
            "LSHandlers",
        ])
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let handlers = String::from_utf8_lossy(&output.stdout);
    [
        "LSHandlerURLScheme = https;",
        "LSHandlerURLScheme = http;",
        "LSHandlerContentType = \"com.apple.default-app.web-browser\";",
    ]
    .iter()
    .find_map(|marker| {
        handlers
            .split("},")
            .find(|entry| entry.contains(marker))
            .and_then(macos_extract_launch_services_bundle_id)
    })
}

#[cfg(target_os = "macos")]
fn configured_browser_bundle_id(state: &AppState) -> Result<Option<String>, String> {
    let db = state.db.lock().map_err(db_error)?;
    get_app_setting(&db, BROWSER_BUNDLE_ID_SETTING_KEY).map_err(db_error)
}

#[cfg(target_os = "macos")]
fn browser_bundle_id_for_open(state: Option<&AppState>) -> Result<String, String> {
    if let Some(state) = state {
        if let Some(configured) = configured_browser_bundle_id(state)? {
            if !configured.trim().is_empty() {
                return Ok(configured);
            }
        }
    }

    Ok(macos_default_browser_bundle_id().unwrap_or_else(|| "com.apple.Safari".to_string()))
}

#[cfg(target_os = "macos")]
fn open_blank_browser_tab_with_handle(
    _app: &tauri::AppHandle,
    state: Option<&AppState>,
) -> Result<(), String> {
    let browser_bundle_id = browser_bundle_id_for_open(state)?;
    let status = Command::new("open")
        .args(["-b", browser_bundle_id.as_str(), "about:blank"])
        .status()
        .map_err(|error| error.to_string())?;

    if status.success() {
        return Ok(());
    }

    Err(format!(
        "Could not open about:blank in default browser bundle {browser_bundle_id}: {status}"
    ))
}

#[cfg(not(target_os = "macos"))]
fn open_blank_browser_tab_with_handle(
    app: &tauri::AppHandle,
    _state: Option<&AppState>,
) -> Result<(), String> {
    app.opener()
        .open_url(BLANK_BROWSER_TAB_URL, None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_blank_browser_tab(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    open_blank_browser_tab_with_handle(&app, Some(state.inner()))
}

struct AppState {
    db: Mutex<SqliteConnection>,
    db_path: PathBuf,
    ocr_engine: Mutex<Option<ocrs::OcrEngine>>,
    quick_capture_shortcut: Mutex<QuickCaptureShortcutRuntime>,
}

#[derive(Debug, Clone)]
struct QuickCaptureShortcutRuntime {
    shortcut: String,
    registered: bool,
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuickCaptureShortcutSettings {
    shortcut: String,
    default_shortcut: String,
    supported: bool,
    registered: bool,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuickCaptureShortcutInput {
    shortcut: Option<String>,
}

fn quick_capture_shortcut_settings_from_runtime(
    runtime: &QuickCaptureShortcutRuntime,
) -> QuickCaptureShortcutSettings {
    QuickCaptureShortcutSettings {
        shortcut: runtime.shortcut.clone(),
        default_shortcut: DEFAULT_QUICK_CAPTURE_SHORTCUT.to_string(),
        supported: cfg!(any(target_os = "macos", windows, target_os = "linux")),
        registered: runtime.registered,
        error: runtime.error.clone(),
    }
}

#[tauri::command]
fn quick_capture_shortcut_settings(
    state: tauri::State<'_, AppState>,
) -> Result<QuickCaptureShortcutSettings, String> {
    let runtime = state.quick_capture_shortcut.lock().map_err(db_error)?;
    Ok(quick_capture_shortcut_settings_from_runtime(&runtime))
}

fn centered_origin(
    work_x: f64,
    work_y: f64,
    work_width: f64,
    work_height: f64,
    window_width: f64,
    window_height: f64,
) -> (f64, f64) {
    (
        work_x + (work_width - window_width).max(0.0) / 2.0,
        work_y + (work_height - window_height).max(0.0) / 2.0,
    )
}

#[cfg(all(any(windows, target_os = "linux"), not(target_os = "macos")))]
fn center_quick_capture_on_cursor_monitor(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
) -> Result<(), String> {
    let cursor = app.cursor_position().map_err(|error| error.to_string())?;
    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .map_err(|error| error.to_string())?
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Ok(());
    };

    let window_size = window.outer_size().map_err(|error| error.to_string())?;
    let work_area = monitor.work_area();
    let (x, y) = centered_origin(
        f64::from(work_area.position.x),
        f64::from(work_area.position.y),
        f64::from(work_area.size.width),
        f64::from(work_area.size.height),
        f64::from(window_size.width),
        f64::from(window_size.height),
    );
    window
        .set_position(tauri::PhysicalPosition::new(
            x.round() as i32,
            y.round() as i32,
        ))
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn center_quick_capture_on_focused_monitor(
    panel: &tauri_nspanel::PanelHandle<tauri::Wry>,
) -> Result<(), String> {
    let mtm = objc2::MainThreadMarker::new()
        .ok_or_else(|| "Quick capture must be positioned on the main thread.".to_string())?;
    let Some(screen) = NSScreen::mainScreen(mtm) else {
        return Ok(());
    };
    let work_area = screen.visibleFrame();
    let window_frame = panel.as_panel().frame();
    let (x, y) = centered_origin(
        work_area.origin.x,
        work_area.origin.y,
        work_area.size.width,
        work_area.size.height,
        window_frame.size.width,
        window_frame.size.height,
    );
    panel
        .as_panel()
        .setFrameOrigin(objc2_foundation::NSPoint::new(x, y));
    Ok(())
}

fn hide_quick_capture_window(app: &tauri::AppHandle, restore_focus: bool) -> Result<(), String> {
    // A non-activating NSPanel leaves the previous application active, so macOS
    // restores keyboard input naturally when the panel is hidden.
    let _ = restore_focus;

    #[cfg(target_os = "macos")]
    {
        let panel = app
            .get_webview_panel("quick-capture")
            .map_err(|_| "Quick capture panel is unavailable.".to_string())?;
        panel.hide();
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    let window = app
        .get_webview_window("quick-capture")
        .ok_or_else(|| "Quick capture window is unavailable.".to_string())?;
    #[cfg(not(target_os = "macos"))]
    return window.hide().map_err(|error| error.to_string());
}

#[tauri::command]
fn hide_quick_capture(app: tauri::AppHandle, restore_focus: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = restore_focus;
        let panel = app
            .get_webview_panel("quick-capture")
            .map_err(|_| "Quick capture panel is unavailable.".to_string())?;
        return app
            .run_on_main_thread(move || panel.hide())
            .map_err(|error| error.to_string());
    }

    #[cfg(not(target_os = "macos"))]
    hide_quick_capture_window(&app, restore_focus)
}

#[cfg(target_os = "macos")]
fn toggle_quick_capture(app: &tauri::AppHandle) -> Result<(), String> {
    let panel = app
        .get_webview_panel("quick-capture")
        .map_err(|_| "Quick capture panel is unavailable.".to_string())?;

    if panel.is_visible() {
        return hide_quick_capture_window(app, true);
    }

    center_quick_capture_on_focused_monitor(&panel)?;
    panel.show_and_make_key();
    app.get_webview("quick-capture")
        .ok_or_else(|| "Quick capture webview is unavailable.".to_string())?
        .set_focus()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(any(windows, target_os = "linux"))]
fn toggle_quick_capture(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("quick-capture")
        .ok_or_else(|| "Quick capture window is unavailable.".to_string())?;

    if window.is_visible().map_err(|error| error.to_string())? {
        return hide_quick_capture_window(app, true);
    }

    center_quick_capture_on_cursor_monitor(app, &window)?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn setup_quick_capture_panel(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("quick-capture")
        .ok_or_else(|| std::io::Error::other("Quick capture window is unavailable."))?;
    let panel = window.to_panel::<QuickCapturePanel>()?;
    panel.set_style_mask(StyleMask::empty().nonactivating_panel().value());
    panel.set_floating_panel(true);
    panel.set_becomes_key_only_if_needed(false);
    panel.set_hides_on_deactivate(false);

    let handler = QuickCapturePanelEventHandler::new();
    let focus_app_handle = app.handle().clone();
    handler.window_did_become_key(move |_| {
        if let Some(webview) = focus_app_handle.get_webview("quick-capture") {
            if let Err(error) = webview.set_focus() {
                eprintln!("Could not focus quick capture webview: {error}");
            }
        }
        if let Err(error) =
            focus_app_handle.emit_to("quick-capture", "quick-capture-focus-changed", true)
        {
            eprintln!("Could not notify quick capture about focus: {error}");
        }
    });
    let blur_app_handle = app.handle().clone();
    handler.window_did_resign_key(move |_| {
        if let Err(error) =
            blur_app_handle.emit_to("quick-capture", "quick-capture-focus-changed", false)
        {
            eprintln!("Could not notify quick capture about focus loss: {error}");
        }
        if let Ok(panel) = blur_app_handle.get_webview_panel("quick-capture") {
            panel.hide();
        }
    });
    panel.set_event_handler(Some(handler.as_ref()));
    Ok(())
}

#[cfg(any(windows, target_os = "linux"))]
fn setup_quick_capture_focus_handler(
    app: &mut tauri::App,
) -> Result<(), Box<dyn std::error::Error>> {
    let window = app
        .get_webview_window("quick-capture")
        .ok_or_else(|| std::io::Error::other("Quick capture window is unavailable."))?;
    let hide_window = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Focused(false)) {
            if let Err(error) = hide_window.hide() {
                eprintln!("Could not hide quick capture after focus loss: {error}");
            }
        }
    });
    Ok(())
}

#[derive(Debug, Clone)]
struct GitRemote {
    name: String,
    normalized_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    icon: String,
    color: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionRecord {
    id: String,
    provider: String,
    name: String,
    base_url: String,
    api_key: Option<String>,
    token: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct AiPromptRecord {
    id: String,
    agent_type: String,
    name: String,
    icon: String,
    prompt_text: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryRecord {
    id: String,
    path: String,
    name: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentDirectoryFile {
    path: String,
    name: String,
    directory_id: String,
    directory_name: String,
    relative_path: String,
    modified_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityRecord {
    id: String,
    provider: String,
    connection_id: String,
    connection_name: Option<String>,
    external_id: String,
    event_type: String,
    action_label: String,
    actor: Option<String>,
    title: String,
    target_url: Option<String>,
    occurred_at: i64,
    fetched_at: i64,
    raw_json: String,
    subject_json: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivitySyncRun {
    connection_id: String,
    connection_name: Option<String>,
    provider: String,
    date: String,
    status: String,
    warning: Option<String>,
    synced_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityResult {
    activities: Vec<ActivityRecord>,
    sync_runs: Vec<ActivitySyncRun>,
}

#[derive(Debug, Clone)]
struct ActivityInput {
    provider: String,
    connection_id: String,
    external_id: String,
    event_type: String,
    action_label: String,
    actor: Option<String>,
    title: String,
    target_url: Option<String>,
    occurred_at: i64,
    raw_json: String,
    subject_json: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveTrelloTicketsInput {
    urls: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolvedTrelloTicket {
    external_id: String,
    title: String,
    url: String,
    board_external_id: Option<String>,
    board_name: Option<String>,
    connection_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ResolveTrelloTicketsResult {
    tickets: Vec<ResolvedTrelloTicket>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Resource {
    id: String,
    project_id: String,
    provider: String,
    kind: String,
    external_id: String,
    url: String,
    name: String,
    icon_url: Option<String>,
    connection_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalResource {
    id: String,
    project_id: String,
    provider: String,
    repo_url: String,
    path: String,
    name: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    project_id: Option<String>,
    title: String,
    body: String,
    status: String,
    source_url: Option<String>,
    source_provider: Option<String>,
    source_kind: Option<String>,
    status_color: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmartInboxTodo {
    id: String,
    kind: String,
    title: String,
    raw_text: Option<String>,
    file_path: Option<String>,
    file_name: Option<String>,
    mime_type: Option<String>,
    file_missing: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskLink {
    task_id: String,
    provider: String,
    kind: String,
    external_id: String,
    url: String,
    connection_id: Option<String>,
    external_title: Option<String>,
    external_body: Option<String>,
    external_state: Option<String>,
    external_state_color: Option<String>,
    target_branch: Option<String>,
    fetched_at: Option<i64>,
    files: Vec<TaskFile>,
    comments: Vec<TaskComment>,
    labels: Vec<ExternalLabel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ExternalLabel {
    name: String,
    color: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TrelloTicketTemplate {
    id: String,
    name: String,
    description: String,
    list_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TrelloBoardList {
    id: String,
    name: String,
    color: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrelloBoardTemplates {
    templates: Vec<TrelloTicketTemplate>,
    lists: Vec<TrelloBoardList>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrelloTicketConversionResult {
    task: Task,
    link: TaskLink,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TaskFile {
    id: String,
    name: String,
    url: String,
    source: String,
    content_type: Option<String>,
    bytes: Option<i64>,
    created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TaskComment {
    id: String,
    kind: String,
    author: String,
    body: String,
    created_at: Option<String>,
    updated_at: Option<String>,
    url: Option<String>,
    discussion_id: Option<String>,
    reply_to_id: Option<String>,
    code_context: Option<TaskCommentCodeContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TaskCommentCodeContext {
    path: String,
    old_start_line: Option<i64>,
    old_line: Option<i64>,
    new_start_line: Option<i64>,
    new_line: Option<i64>,
    outdated: bool,
    lines: Vec<TaskCommentDiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TaskCommentDiffLine {
    kind: String,
    old_line: Option<i64>,
    new_line: Option<i64>,
    content: String,
    highlighted: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskRelationView {
    id: String,
    source_task_id: String,
    target_task_id: String,
    relation_type: String,
    created_at: i64,
    related_task: Task,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestRecord {
    id: String,
    project_id: String,
    provider: String,
    repo_url: String,
    pr_url: String,
    title: String,
    status: String,
    review_notes: String,
    test_state: String,
    connection_id: Option<String>,
    external_title: Option<String>,
    external_body: Option<String>,
    external_state: Option<String>,
    target_branch: Option<String>,
    fetched_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ParsedInputResponse {
    kind: String,
    provider: Option<String>,
    external_id: Option<String>,
    url: Option<String>,
    title: String,
    repo_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmartTaskResult {
    task: Option<Task>,
    resource: Option<Resource>,
    parsed: ParsedInputResponse,
    project_required: bool,
    created: bool,
    notice: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmartInboxReviewRequest {
    provider: String,
    connection_id: String,
    connection_name: String,
    source_id: String,
    source_name: String,
    external_id: String,
    title: String,
    url: String,
    context_path: Option<String>,
    context_detail: Option<String>,
    number: Option<String>,
    author: Option<String>,
    review_requested_at: Option<i64>,
    updated_at: Option<i64>,
    created_at: Option<i64>,
    sort_at: Option<i64>,
    sort_source: String,
    state: String,
    linked_task: Option<Task>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmartInboxReviewRequestWarning {
    provider: String,
    connection_id: String,
    connection_name: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmartInboxProviderSyncRun {
    provider: String,
    connection_id: String,
    connection_name: String,
    status: String,
    synced_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmartInboxReviewRequestResult {
    items: Vec<SmartInboxReviewRequest>,
    warnings: Vec<SmartInboxReviewRequestWarning>,
    sync_runs: Vec<SmartInboxProviderSyncRun>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmartInboxProviderSource {
    provider: String,
    connection_id: String,
    connection_name: String,
    source_id: String,
    source_name: String,
    enabled: bool,
    discovered_at: i64,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OcrImageResult {
    text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OcrBackend {
    MacosVision,
    Ocrs,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EmailFileResult {
    subject: String,
    body: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestSaveResult {
    pull_request: PullRequestRecord,
    notice: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestCheckoutResult {
    path: String,
    branch: String,
    remote_ref: String,
    base_ref: Option<String>,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewDiffFile {
    path: String,
    old_path: String,
    new_path: String,
    diff: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewDiffResult {
    path: String,
    branch: String,
    base_ref: String,
    head_sha: String,
    files: Vec<String>,
    current_file: Option<ReviewDiffFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewCommentDraft {
    id: String,
    task_id: String,
    kind: String,
    body: String,
    path: Option<String>,
    old_path: Option<String>,
    new_path: Option<String>,
    start_old_line: Option<i64>,
    start_new_line: Option<i64>,
    start_side: Option<String>,
    old_line: Option<i64>,
    new_line: Option<i64>,
    side: Option<String>,
    head_sha: Option<String>,
    last_error: Option<String>,
    created_at: i64,
    updated_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReviewCommentDraftInput {
    id: Option<String>,
    task_id: String,
    kind: String,
    body: String,
    path: Option<String>,
    old_path: Option<String>,
    new_path: Option<String>,
    start_old_line: Option<i64>,
    start_new_line: Option<i64>,
    start_side: Option<String>,
    old_line: Option<i64>,
    new_line: Option<i64>,
    side: Option<String>,
    head_sha: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewCommentFailure {
    draft_id: String,
    message: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewCommentSubmissionResult {
    published_draft_ids: Vec<String>,
    published_count: usize,
    remaining_drafts: Vec<ReviewCommentDraft>,
    failures: Vec<ReviewCommentFailure>,
    link: Option<TaskLink>,
    notice: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshTaskExternalDetailsResult {
    task: Task,
    links: Vec<TaskLink>,
    notice: Option<String>,
    connection_required: bool,
}

enum TaskExternalRefreshPreparation {
    Ready(RefreshTaskExternalDetailsResult),
    Fetch {
        task: Task,
        links: Vec<TaskLink>,
        link: TaskLink,
        connection: ConnectionRecord,
        parsed: ParsedInputPayload,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestConnectionResult {
    ok: bool,
    message: String,
    account_name: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSettings {
    detected_browser_bundle_id: Option<String>,
    browser_bundle_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserSettingsInput {
    browser_bundle_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResourceInput {
    project_id: String,
    provider: String,
    kind: String,
    external_id: String,
    url: String,
    name: String,
    icon_url: Option<String>,
    connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalResourceInput {
    project_id: String,
    path: String,
    expected_provider: Option<String>,
    expected_repo_url: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryInput {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskRelationInput {
    id: Option<String>,
    source_task_id: String,
    target_task_id: String,
    relation_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionInput {
    id: Option<String>,
    provider: String,
    name: String,
    base_url: String,
    api_key: Option<String>,
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AiPromptInput {
    id: Option<String>,
    agent_type: String,
    name: String,
    icon: String,
    prompt_text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenAiPromptThreadInput {
    ai_prompt_id: String,
    task_id: String,
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequestInput {
    id: Option<String>,
    project_id: String,
    provider: String,
    repo_url: String,
    pr_url: String,
    title: String,
    status: String,
    review_notes: String,
    test_state: String,
    connection_id: Option<String>,
    external_title: Option<String>,
    external_body: Option<String>,
    external_state: Option<String>,
    target_branch: Option<String>,
    fetched_at: Option<i64>,
    parsed: Option<ParsedInputPayload>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParsedInputPayload {
    kind: String,
    provider: Option<String>,
    external_id: Option<String>,
    url: Option<String>,
    title: String,
    repo_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SmartInboxTodoInput {
    kind: String,
    title: Option<String>,
    raw_text: Option<String>,
    file_path: Option<String>,
    file_name: Option<String>,
    mime_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SmartInboxTodoUpdateInput {
    id: String,
    title: Option<String>,
    raw_text: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SmartInboxProviderSourceChange {
    connection_id: String,
    source_id: String,
    enabled: bool,
}

#[derive(Debug, Clone)]
struct ProviderMetadata {
    connection_id: Option<String>,
    title: Option<String>,
    body: Option<String>,
    state: Option<String>,
    state_color: Option<String>,
    target_branch: Option<String>,
    url: Option<String>,
    fetched_at: Option<i64>,
    files: Vec<TaskFile>,
    comments: Vec<TaskComment>,
    labels: Vec<ExternalLabel>,
    parent_resource: Option<ProviderResourceMetadata>,
    notice: Option<String>,
}

#[derive(Debug, Clone)]
struct ProviderResourceMetadata {
    provider: String,
    kind: String,
    external_id: String,
    url: String,
    name: String,
    icon_url: Option<String>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, _shortcut, event| {
                        if event.state() == ShortcutState::Pressed {
                            #[cfg(target_os = "macos")]
                            {
                                let app_handle = app.clone();
                                if let Err(error) = app.run_on_main_thread(move || {
                                    if let Err(error) = toggle_quick_capture(&app_handle) {
                                        eprintln!("Could not toggle quick capture: {error}");
                                    }
                                }) {
                                    eprintln!("Could not schedule quick capture toggle: {error}");
                                }
                            }
                            #[cfg(any(windows, target_os = "linux"))]
                            if let Err(error) = toggle_quick_capture(app) {
                                eprintln!("Could not toggle quick capture: {error}");
                            }
                        }
                    })
                    .build(),
            )?;

            let app_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_dir)?;
            let db_path = app_dir.join("studio.sqlite");
            let db = SqliteConnection::open(&db_path)?;
            init_database(&db)?;
            terminal_tabs::init_terminal_schema(&db)?;
            let terminal_tabs_state =
                terminal_tabs::initialize_state(&db).map_err(std::io::Error::other)?;

            #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
            let quick_capture_shortcut = {
                let shortcut = load_quick_capture_shortcut(&db)?;
                let error = app
                    .global_shortcut()
                    .register(shortcut.as_str())
                    .err()
                    .map(|error| format!("Could not register shortcut {shortcut}: {error}"));
                QuickCaptureShortcutRuntime {
                    shortcut,
                    registered: error.is_none(),
                    error,
                }
            };
            #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
            let quick_capture_shortcut = QuickCaptureShortcutRuntime {
                shortcut: DEFAULT_QUICK_CAPTURE_SHORTCUT.to_string(),
                registered: false,
                error: Some(
                    "Quick capture shortcuts are available in the desktop app only.".to_string(),
                ),
            };

            app.manage(AppState {
                db: Mutex::new(db),
                db_path,
                ocr_engine: Mutex::new(None),
                quick_capture_shortcut: Mutex::new(quick_capture_shortcut),
            });
            app.manage(terminal_tabs_state);
            #[cfg(target_os = "macos")]
            setup_quick_capture_panel(app)?;
            #[cfg(any(windows, target_os = "linux"))]
            setup_quick_capture_focus_handler(app)?;
            #[cfg(target_os = "macos")]
            install_workspace_menu(app)?;
            terminal_tabs::setup_workspace_window(app)?;
            #[cfg(not(target_os = "macos"))]
            let app_handle = app.handle().clone();
            #[cfg(not(target_os = "macos"))]
            tauri::async_runtime::spawn_blocking(move || {
                let state = app_handle.state::<AppState>();
                if let Err(error) = ensure_cached_ocr_engine(&app_handle, &state) {
                    eprintln!("Could not preload OCR engine: {error}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_blank_browser_tab,
            quick_capture_shortcut_settings,
            save_quick_capture_shortcut,
            hide_quick_capture,
            terminal_tabs::list_workspace_tabs,
            terminal_tabs::list_terminal_settings,
            terminal_tabs::save_terminal_settings,
            terminal_tabs::get_terminal_layout,
            terminal_tabs::create_terminal_tab,
            terminal_tabs::activate_tab,
            terminal_tabs::reorder_tabs,
            terminal_tabs::close_terminal_tab,
            terminal_tabs::close_terminal_pane,
            terminal_tabs::close_active_terminal_pane,
            terminal_tabs::split_active_terminal,
            terminal_tabs::focus_terminal_pane,
            terminal_tabs::resize_terminal_split,
            terminal_tabs::restart_terminal,
            terminal_tabs::terminal_attach,
            terminal_tabs::terminal_write,
            terminal_tabs::terminal_resize,
            terminal_tabs::terminal_set_title,
            terminal_tabs::terminal_set_cwd,
            list_projects,
            create_project,
            update_project,
            delete_project,
            list_project_resources,
            connect_resource,
            disconnect_resource,
            list_local_resources,
            save_local_resource,
            delete_local_resource,
            checkout_pull_request_for_review,
            load_review_diff,
            load_review_diff_file,
            list_review_comment_drafts,
            save_review_comment_draft,
            delete_review_comment_draft,
            submit_review_comments,
            create_task_from_input,
            list_smart_inbox_provider_items,
            sync_smart_inbox_provider_items,
            list_smart_inbox_provider_sources,
            update_smart_inbox_provider_sources,
            list_smart_inbox_todos,
            create_smart_inbox_todo,
            update_smart_inbox_todo,
            delete_smart_inbox_todo,
            ocr_image_file,
            ocr_image_bytes,
            read_email_file,
            read_email_bytes,
            read_apple_mail_message,
            list_tasks,
            update_task,
            delete_task,
            list_task_trello_boards,
            list_trello_board_templates,
            convert_task_to_trello_ticket,
            link_task_resource,
            list_task_links,
            refresh_task_external_details,
            list_task_relations,
            save_task_relation,
            delete_task_relation,
            list_connections,
            save_connection,
            delete_connection,
            list_ai_prompts,
            save_ai_prompt,
            delete_ai_prompt,
            open_ai_prompt_thread,
            list_browser_settings,
            save_browser_settings,
            test_connection,
            list_directories,
            save_directory,
            delete_directory,
            list_recent_directory_files,
            list_project_connections,
            set_project_connections,
            list_calendar_accounts,
            connect_google_account,
            cancel_google_account_connection,
            update_calendar_service,
            save_calendar_subscription,
            save_caldav_account,
            refresh_calendar_collections,
            update_calendar_collections,
            test_calendar_account,
            delete_calendar_account,
            list_calendar_events,
            sync_calendar_events,
            list_activities,
            sync_activities,
            resolve_trello_tickets,
            list_pull_requests,
            save_pull_request,
            update_pull_request_review_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(target_os = "macos")]
const CLOSE_TAB_MENU_ID: &str = "workspace_close_tab";

#[cfg(target_os = "macos")]
fn install_workspace_menu(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItemBuilder, MenuItemKind};

    let menu = Menu::default(app.handle())?;
    let close_tab = MenuItemBuilder::with_id(CLOSE_TAB_MENU_ID, "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app.handle())?;

    for item in menu.items()? {
        let MenuItemKind::Submenu(submenu) = item else {
            continue;
        };
        let is_file_menu = submenu.text()?.replace('&', "") == "File";
        let items = submenu.items()?;
        let mut first_close_position = None;
        for (position, child) in items.iter().enumerate().rev() {
            let MenuItemKind::Predefined(predefined) = child else {
                continue;
            };
            if predefined.text()?.replace('&', "") == "Close Window" {
                first_close_position = Some(position);
                submenu.remove_at(position)?;
            }
        }
        if is_file_menu {
            submenu.insert(&close_tab, first_close_position.unwrap_or(0))?;
        }
    }

    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id() == CLOSE_TAB_MENU_ID {
            let workspace_is_focused = app
                .get_window("main")
                .and_then(|window| window.is_focused().ok())
                .unwrap_or(false);
            if workspace_is_focused {
                if let Err(error) = terminal_tabs::close_active_terminal(app) {
                    eprintln!("Could not close active terminal tab: {error}");
                }
                return;
            }

            for window in app.windows().into_values() {
                if window.is_focused().unwrap_or(false) {
                    if let Err(error) = window.close() {
                        eprintln!("Could not close focused window: {error}");
                    }
                    break;
                }
            }
        }
    });
    Ok(())
}

fn db_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn new_id(prefix: &str) -> String {
    let millis = now_millis();
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}_{millis}_{sequence}")
}

fn normalize_project_color(color: Option<String>) -> String {
    let trimmed = color.as_deref().unwrap_or("").trim();
    let is_hex_color = trimmed.len() == 7
        && trimmed.starts_with('#')
        && trimmed
            .chars()
            .skip(1)
            .all(|character| character.is_ascii_hexdigit());

    if is_hex_color {
        trimmed.to_ascii_lowercase()
    } else {
        DEFAULT_PROJECT_COLOR.to_string()
    }
}

fn init_database(db: &SqliteConnection) -> rusqlite::Result<()> {
    db.execute_batch(
        "
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#2563eb',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS connections (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            api_key TEXT,
            token TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_prompts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            agent_type TEXT NOT NULL,
            icon TEXT NOT NULL DEFAULT 'sparkles',
            prompt_text TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS project_connections (
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
            enabled_at INTEGER NOT NULL,
            PRIMARY KEY(project_id, connection_id)
        );

        CREATE TABLE IF NOT EXISTS directories (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS activities (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
            external_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            action_label TEXT NOT NULL,
            actor TEXT,
            title TEXT NOT NULL,
            target_url TEXT,
            occurred_at INTEGER NOT NULL,
            fetched_at INTEGER NOT NULL,
            raw_json TEXT NOT NULL,
            subject_json TEXT
        );

        CREATE TABLE IF NOT EXISTS activity_sync_runs (
            connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
            date TEXT NOT NULL,
            status TEXT NOT NULL,
            warning TEXT,
            synced_at INTEGER NOT NULL,
            PRIMARY KEY(connection_id, date)
        );

        CREATE TABLE IF NOT EXISTS resources (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            kind TEXT NOT NULL,
            external_id TEXT NOT NULL,
            url TEXT NOT NULL,
            name TEXT NOT NULL,
            icon_url TEXT,
            connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
            UNIQUE(project_id, provider, kind, external_id)
        );

        CREATE TABLE IF NOT EXISTS local_resources (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            repo_url TEXT NOT NULL,
            normalized_repo_url TEXT NOT NULL,
            path TEXT NOT NULL,
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(project_id, path)
        );

        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            status TEXT NOT NULL,
            source_url TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS smart_inbox_todos (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            raw_text TEXT,
            file_path TEXT,
            file_name TEXT,
            mime_type TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS smart_inbox_provider_items (
            connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            source_id TEXT NOT NULL,
            source_name TEXT NOT NULL,
            external_id TEXT NOT NULL,
            title TEXT NOT NULL,
            url TEXT NOT NULL,
            context_path TEXT,
            context_detail TEXT,
            number TEXT,
            author TEXT,
            review_requested_at INTEGER,
            updated_at INTEGER,
            created_at INTEGER,
            sort_at INTEGER,
            sort_source TEXT NOT NULL,
            state TEXT NOT NULL,
            fetched_at INTEGER NOT NULL,
            PRIMARY KEY(connection_id, provider, external_id)
        );

        CREATE TABLE IF NOT EXISTS smart_inbox_provider_sync_runs (
            connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            status TEXT NOT NULL,
            warning TEXT,
            synced_at INTEGER NOT NULL,
            PRIMARY KEY(connection_id, provider)
        );

        CREATE TABLE IF NOT EXISTS smart_inbox_provider_sources (
            connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            source_id TEXT NOT NULL,
            source_name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            discovered_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY(connection_id, provider, source_id)
        );

        CREATE TABLE IF NOT EXISTS task_links (
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            kind TEXT NOT NULL,
            external_id TEXT NOT NULL,
            url TEXT NOT NULL,
            connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
            external_title TEXT,
            external_body TEXT,
            external_state TEXT,
            external_state_color TEXT,
            target_branch TEXT,
            fetched_at INTEGER,
            files_json TEXT NOT NULL DEFAULT '[]',
            comments_json TEXT NOT NULL DEFAULT '[]',
            labels_json TEXT NOT NULL DEFAULT '[]',
            PRIMARY KEY(task_id, provider, kind, external_id)
        );

        CREATE TABLE IF NOT EXISTS task_relations (
            id TEXT PRIMARY KEY,
            source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            relation_type TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(source_task_id, target_task_id, relation_type)
        );

        CREATE TABLE IF NOT EXISTS review_comment_drafts (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK(kind IN ('overall', 'inline')),
            body TEXT NOT NULL,
            path TEXT,
            old_path TEXT,
            new_path TEXT,
            start_old_line INTEGER,
            start_new_line INTEGER,
            start_side TEXT CHECK(start_side IS NULL OR start_side IN ('LEFT', 'RIGHT')),
            old_line INTEGER,
            new_line INTEGER,
            side TEXT CHECK(side IS NULL OR side IN ('LEFT', 'RIGHT')),
            head_sha TEXT,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_review_comment_drafts_overall
        ON review_comment_drafts(task_id, kind) WHERE kind = 'overall';

        CREATE TABLE IF NOT EXISTS pull_requests (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            repo_url TEXT NOT NULL,
            pr_url TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            review_notes TEXT NOT NULL,
            test_state TEXT NOT NULL,
            connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
            external_title TEXT,
            external_body TEXT,
            external_state TEXT,
            target_branch TEXT,
            fetched_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        ",
    )?;
    calendar::init_database(db)?;
    migrate_ai_agents_to_prompts(db)?;
    add_column_if_missing(db, "ai_prompts", "icon", "TEXT NOT NULL DEFAULT 'sparkles'")?;
    add_column_if_missing(db, "projects", "color", "TEXT NOT NULL DEFAULT '#2563eb'")?;
    add_column_if_missing(db, "connections", "api_key", "TEXT")?;
    add_column_if_missing(db, "smart_inbox_provider_items", "source_id", "TEXT")?;
    add_column_if_missing(db, "smart_inbox_provider_items", "source_name", "TEXT")?;
    db.execute(
        "UPDATE smart_inbox_provider_items
         SET source_id = context_path, source_name = context_path
         WHERE provider IN ('github', 'gitlab')
           AND (source_id IS NULL OR trim(source_id) = '')
           AND context_path IS NOT NULL",
        [],
    )?;
    db.execute(
        "INSERT OR IGNORE INTO smart_inbox_provider_sources
         (connection_id, provider, source_id, source_name, enabled, discovered_at, updated_at)
         SELECT connection_id, provider, source_id, COALESCE(source_name, source_id), 1,
                MIN(fetched_at), MAX(fetched_at)
         FROM smart_inbox_provider_items
         WHERE source_id IS NOT NULL AND trim(source_id) != ''
         GROUP BY connection_id, provider, source_id",
        [],
    )?;
    migrate_resources_to_project_scoped_identity(db)?;
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_activities_occurred_at ON activities(occurred_at DESC)",
        [],
    )?;
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_smart_inbox_provider_items_sort
         ON smart_inbox_provider_items(provider, sort_at DESC)",
        [],
    )?;
    add_column_if_missing(
        db,
        "task_links",
        "connection_id",
        "TEXT REFERENCES connections(id) ON DELETE SET NULL",
    )?;
    add_column_if_missing(db, "task_links", "external_title", "TEXT")?;
    add_column_if_missing(db, "task_links", "external_body", "TEXT")?;
    add_column_if_missing(db, "task_links", "external_state", "TEXT")?;
    add_column_if_missing(db, "task_links", "external_state_color", "TEXT")?;
    add_column_if_missing(db, "task_links", "target_branch", "TEXT")?;
    add_column_if_missing(db, "task_links", "fetched_at", "INTEGER")?;
    add_column_if_missing(db, "task_links", "files_json", "TEXT NOT NULL DEFAULT '[]'")?;
    add_column_if_missing(
        db,
        "task_links",
        "comments_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(
        db,
        "task_links",
        "labels_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    keep_one_file_smart_inbox_todo_per_path(db)?;
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_smart_inbox_file_path
         ON smart_inbox_todos(file_path)
         WHERE kind = 'file' AND file_path IS NOT NULL AND trim(file_path) != ''",
        [],
    )?;
    keep_one_task_link_per_task(db)?;
    db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_task_links_single_task ON task_links(task_id)",
        [],
    )?;
    add_column_if_missing(
        db,
        "pull_requests",
        "connection_id",
        "TEXT REFERENCES connections(id) ON DELETE SET NULL",
    )?;
    add_column_if_missing(db, "pull_requests", "external_title", "TEXT")?;
    add_column_if_missing(db, "pull_requests", "external_body", "TEXT")?;
    add_column_if_missing(db, "pull_requests", "external_state", "TEXT")?;
    add_column_if_missing(db, "pull_requests", "target_branch", "TEXT")?;
    add_column_if_missing(db, "pull_requests", "fetched_at", "INTEGER")?;
    add_column_if_missing(db, "activities", "subject_json", "TEXT")?;
    add_column_if_missing(db, "review_comment_drafts", "start_old_line", "INTEGER")?;
    add_column_if_missing(db, "review_comment_drafts", "start_new_line", "INTEGER")?;
    add_column_if_missing(
        db,
        "review_comment_drafts",
        "start_side",
        "TEXT CHECK(start_side IS NULL OR start_side IN ('LEFT', 'RIGHT'))",
    )?;
    migrate_pull_requests_into_tasks(db)?;
    Ok(())
}

fn migrate_ai_agents_to_prompts(db: &SqliteConnection) -> rusqlite::Result<()> {
    let legacy_table_exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_agents')",
        [],
        |row| row.get(0),
    )?;
    if !legacy_table_exists {
        return Ok(());
    }

    db.execute_batch(
        "
        BEGIN IMMEDIATE;
        INSERT OR IGNORE INTO ai_prompts
            (id, name, agent_type, prompt_text, created_at, updated_at)
        SELECT id, name, type, '', created_at, updated_at
        FROM ai_agents;
        DROP TABLE ai_agents;
        COMMIT;
        ",
    )?;
    Ok(())
}

fn keep_one_file_smart_inbox_todo_per_path(db: &SqliteConnection) -> rusqlite::Result<()> {
    db.execute(
        "DELETE FROM smart_inbox_todos
         WHERE kind = 'file'
           AND file_path IS NOT NULL
           AND trim(file_path) != ''
           AND rowid NOT IN (
               SELECT keep_rowid
               FROM (
                   SELECT candidate.rowid AS keep_rowid
                   FROM smart_inbox_todos candidate
                   WHERE candidate.kind = 'file'
                     AND candidate.file_path = smart_inbox_todos.file_path
                   ORDER BY candidate.updated_at DESC, candidate.created_at DESC, candidate.rowid DESC
                   LIMIT 1
               )
           )",
        [],
    )?;
    Ok(())
}

fn keep_one_task_link_per_task(db: &SqliteConnection) -> rusqlite::Result<()> {
    db.execute(
        "DELETE FROM task_links
         WHERE rowid NOT IN (
             SELECT keep_rowid
             FROM (
                 SELECT candidate.rowid AS keep_rowid
                 FROM task_links candidate
                 LEFT JOIN tasks t ON t.id = candidate.task_id
                 WHERE candidate.task_id = task_links.task_id
                 ORDER BY
                     CASE WHEN t.source_url IS NOT NULL AND candidate.url = t.source_url THEN 0 ELSE 1 END,
                     CASE WHEN candidate.fetched_at IS NULL THEN 1 ELSE 0 END,
                     candidate.fetched_at DESC,
                     candidate.rowid DESC
                 LIMIT 1
             )
         )",
        [],
    )?;
    Ok(())
}

fn migrate_resources_to_project_scoped_identity(db: &SqliteConnection) -> rusqlite::Result<()> {
    if !resources_have_global_unique_identity(db)? {
        return Ok(());
    }

    db.execute_batch(
        "
        DROP TABLE IF EXISTS resources_legacy_global_identity;
        ALTER TABLE resources RENAME TO resources_legacy_global_identity;
        CREATE TABLE resources (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            kind TEXT NOT NULL,
            external_id TEXT NOT NULL,
            url TEXT NOT NULL,
            name TEXT NOT NULL,
            icon_url TEXT,
            connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
            UNIQUE(project_id, provider, kind, external_id)
        );
        INSERT OR IGNORE INTO resources
            (id, project_id, provider, kind, external_id, url, name, icon_url, connection_id)
        SELECT id, project_id, provider, kind, external_id, url, name, icon_url, connection_id
        FROM resources_legacy_global_identity;
        DROP TABLE resources_legacy_global_identity;
        ",
    )?;

    Ok(())
}

fn resources_have_global_unique_identity(db: &SqliteConnection) -> rusqlite::Result<bool> {
    let mut statement = db.prepare("PRAGMA index_list(resources)")?;
    let indexes = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    for (index_name, unique) in indexes {
        if unique != 1 {
            continue;
        }
        let columns = index_columns(db, &index_name)?;
        if columns == ["provider", "kind", "external_id"] {
            return Ok(true);
        }
    }

    Ok(false)
}

fn index_columns(db: &SqliteConnection, index_name: &str) -> rusqlite::Result<Vec<String>> {
    let escaped = index_name.replace('"', "\"\"");
    let mut statement = db.prepare(&format!("PRAGMA index_info(\"{escaped}\")"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(2))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(columns)
}

fn add_column_if_missing(
    db: &SqliteConnection,
    table: &str,
    column: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    let mut statement = db.prepare(&format!("PRAGMA table_info({table})"))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<HashSet<_>, _>>()?;
    if !columns.contains(column) {
        db.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
            [],
        )?;
    }
    Ok(())
}

fn get_app_setting(db: &SqliteConnection, key: &str) -> rusqlite::Result<Option<String>> {
    db.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
}

fn set_app_setting(db: &SqliteConnection, key: &str, value: Option<&str>) -> rusqlite::Result<()> {
    let value = value.map(str::trim).filter(|value| !value.is_empty());
    if let Some(value) = value {
        db.execute(
            "INSERT INTO app_settings (key, value, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, now_millis()],
        )?;
    } else {
        db.execute("DELETE FROM app_settings WHERE key = ?1", params![key])?;
    }
    Ok(())
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn normalize_quick_capture_shortcut(value: &str) -> Result<String, String> {
    let shortcut = value
        .trim()
        .parse::<Shortcut>()
        .map_err(|error| format!("Invalid shortcut: {error}"))?;
    let required_modifiers = Modifiers::CONTROL | Modifiers::ALT | Modifiers::SUPER;
    if !shortcut.mods.intersects(required_modifiers) {
        return Err(
            "Shortcut must include Command, Control, Option, or Alt with another key.".to_string(),
        );
    }
    Ok(shortcut.to_string())
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn load_quick_capture_shortcut(db: &SqliteConnection) -> Result<String, String> {
    let default_shortcut = normalize_quick_capture_shortcut(DEFAULT_QUICK_CAPTURE_SHORTCUT)?;
    let Some(stored_shortcut) =
        get_app_setting(db, QUICK_CAPTURE_SHORTCUT_SETTING_KEY).map_err(db_error)?
    else {
        return Ok(default_shortcut);
    };

    match normalize_quick_capture_shortcut(&stored_shortcut) {
        Ok(shortcut) => Ok(shortcut),
        Err(_) => {
            set_app_setting(db, QUICK_CAPTURE_SHORTCUT_SETTING_KEY, None).map_err(db_error)?;
            Ok(default_shortcut)
        }
    }
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn persist_quick_capture_shortcut(db: &SqliteConnection, shortcut: &str) -> Result<(), String> {
    let default_shortcut = normalize_quick_capture_shortcut(DEFAULT_QUICK_CAPTURE_SHORTCUT)?;
    let stored_value = (shortcut != default_shortcut).then_some(shortcut);
    set_app_setting(db, QUICK_CAPTURE_SHORTCUT_SETTING_KEY, stored_value).map_err(db_error)
}

#[tauri::command]
fn save_quick_capture_shortcut(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    input: QuickCaptureShortcutInput,
) -> Result<QuickCaptureShortcutSettings, String> {
    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    {
        let requested = input
            .shortcut
            .as_deref()
            .unwrap_or(DEFAULT_QUICK_CAPTURE_SHORTCUT);
        let next_shortcut = normalize_quick_capture_shortcut(requested)?;
        let mut runtime = state.quick_capture_shortcut.lock().map_err(db_error)?;
        let previous = runtime.clone();

        if next_shortcut == previous.shortcut {
            if !previous.registered {
                if let Err(error) = app.global_shortcut().register(next_shortcut.as_str()) {
                    let message = format!("Could not register shortcut: {error}");
                    runtime.error = Some(message.clone());
                    return Err(message);
                }
            }

            let persist_result = {
                let db = state.db.lock().map_err(db_error)?;
                persist_quick_capture_shortcut(&db, &next_shortcut)
            };
            if let Err(error) = persist_result {
                if !previous.registered {
                    let _ = app.global_shortcut().unregister(next_shortcut.as_str());
                }
                *runtime = previous;
                return Err(format!("Could not save shortcut: {error}"));
            }

            runtime.registered = true;
            runtime.error = None;
            return Ok(quick_capture_shortcut_settings_from_runtime(&runtime));
        }

        app.global_shortcut()
            .register(next_shortcut.as_str())
            .map_err(|error| {
                format!(
                    "Could not register shortcut: {error}. The previous shortcut remains active."
                )
            })?;

        if previous.registered {
            if let Err(error) = app.global_shortcut().unregister(previous.shortcut.as_str()) {
                let _ = app.global_shortcut().unregister(next_shortcut.as_str());
                return Err(format!(
                    "Could not replace the shortcut: {error}. The previous shortcut remains active."
                ));
            }
        }

        let persist_result = {
            let db = state.db.lock().map_err(db_error)?;
            persist_quick_capture_shortcut(&db, &next_shortcut)
        };
        if let Err(error) = persist_result {
            let cleanup_error = app
                .global_shortcut()
                .unregister(next_shortcut.as_str())
                .err();
            let restore_error = if previous.registered {
                app.global_shortcut()
                    .register(previous.shortcut.as_str())
                    .err()
            } else {
                None
            };

            *runtime = previous;
            if let Some(restore_error) = restore_error {
                runtime.registered = false;
                runtime.error = Some(format!(
                    "Could not restore the previous shortcut: {restore_error}"
                ));
            }
            let cleanup_note = cleanup_error
                .map(|cleanup_error| format!(" Cleanup also failed: {cleanup_error}."))
                .unwrap_or_default();
            return Err(format!("Could not save shortcut: {error}.{cleanup_note}"));
        }

        *runtime = QuickCaptureShortcutRuntime {
            shortcut: next_shortcut,
            registered: true,
            error: None,
        };
        Ok(quick_capture_shortcut_settings_from_runtime(&runtime))
    }

    #[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
    {
        let _ = (app, state, input);
        Err("Global shortcuts are available in the desktop app only.".to_string())
    }
}

fn row_to_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        icon: row.get(2)?,
        color: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn row_to_connection(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionRecord> {
    Ok(ConnectionRecord {
        id: row.get(0)?,
        provider: row.get(1)?,
        name: row.get(2)?,
        base_url: row.get(3)?,
        api_key: row.get(4)?,
        token: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn row_to_ai_prompt(row: &rusqlite::Row<'_>) -> rusqlite::Result<AiPromptRecord> {
    Ok(AiPromptRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        icon: row.get(2)?,
        agent_type: row.get(3)?,
        prompt_text: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn row_to_activity(row: &rusqlite::Row<'_>) -> rusqlite::Result<ActivityRecord> {
    Ok(ActivityRecord {
        id: row.get(0)?,
        provider: row.get(1)?,
        connection_id: row.get(2)?,
        connection_name: row.get(3)?,
        external_id: row.get(4)?,
        event_type: row.get(5)?,
        action_label: row.get(6)?,
        actor: row.get(7)?,
        title: row.get(8)?,
        target_url: row.get(9)?,
        occurred_at: row.get(10)?,
        fetched_at: row.get(11)?,
        raw_json: row.get(12)?,
        subject_json: row.get(13)?,
    })
}

fn row_to_activity_sync_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<ActivitySyncRun> {
    Ok(ActivitySyncRun {
        connection_id: row.get(0)?,
        connection_name: row.get(1)?,
        provider: row.get(2)?,
        date: row.get(3)?,
        status: row.get(4)?,
        warning: row.get(5)?,
        synced_at: row.get(6)?,
    })
}

fn row_to_directory(row: &rusqlite::Row<'_>) -> rusqlite::Result<DirectoryRecord> {
    Ok(DirectoryRecord {
        id: row.get(0)?,
        path: row.get(1)?,
        name: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn row_to_resource(row: &rusqlite::Row<'_>) -> rusqlite::Result<Resource> {
    Ok(Resource {
        id: row.get(0)?,
        project_id: row.get(1)?,
        provider: row.get(2)?,
        kind: row.get(3)?,
        external_id: row.get(4)?,
        url: row.get(5)?,
        name: row.get(6)?,
        icon_url: row.get(7)?,
        connection_id: row.get(8)?,
    })
}

fn row_to_local_resource(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalResource> {
    Ok(LocalResource {
        id: row.get(0)?,
        project_id: row.get(1)?,
        provider: row.get(2)?,
        repo_url: row.get(3)?,
        path: row.get(4)?,
        name: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn row_to_task_with_source(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        body: row.get(3)?,
        status: row.get(4)?,
        source_url: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        source_provider: row.get(8)?,
        source_kind: row.get(9)?,
        status_color: row.get(10)?,
    })
}

fn row_to_smart_inbox_todo(row: &rusqlite::Row<'_>) -> rusqlite::Result<SmartInboxTodo> {
    Ok(SmartInboxTodo {
        id: row.get(0)?,
        kind: row.get(1)?,
        title: row.get(2)?,
        raw_text: row.get(3)?,
        file_path: row.get(4)?,
        file_name: row.get(5)?,
        mime_type: row.get(6)?,
        file_missing: false,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn row_to_task_link(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskLink> {
    let files_json = row.get::<_, Option<String>>(12)?;
    let comments_json = row.get::<_, Option<String>>(13)?;
    let labels_json = row.get::<_, Option<String>>(14)?;
    Ok(TaskLink {
        task_id: row.get(0)?,
        provider: row.get(1)?,
        kind: row.get(2)?,
        external_id: row.get(3)?,
        url: row.get(4)?,
        connection_id: row.get(5)?,
        external_title: row.get(6)?,
        external_body: row.get(7)?,
        external_state: row.get(8)?,
        external_state_color: row.get(9)?,
        target_branch: row.get(10)?,
        fetched_at: row.get(11)?,
        files: task_files_from_json(files_json.as_deref()),
        comments: task_comments_from_json(comments_json.as_deref()),
        labels: external_labels_from_json(labels_json.as_deref()),
    })
}

fn task_files_from_json(value: Option<&str>) -> Vec<TaskFile> {
    value
        .and_then(|json| serde_json::from_str::<Vec<TaskFile>>(json).ok())
        .unwrap_or_default()
}

fn task_files_to_json(files: &[TaskFile]) -> String {
    serde_json::to_string(files).unwrap_or_else(|_| "[]".to_string())
}

fn task_comments_from_json(value: Option<&str>) -> Vec<TaskComment> {
    value
        .and_then(|json| serde_json::from_str::<Vec<TaskComment>>(json).ok())
        .unwrap_or_default()
}

fn task_comments_to_json(comments: &[TaskComment]) -> String {
    serde_json::to_string(comments).unwrap_or_else(|_| "[]".to_string())
}

fn external_labels_from_json(value: Option<&str>) -> Vec<ExternalLabel> {
    value
        .and_then(|json| serde_json::from_str::<Vec<ExternalLabel>>(json).ok())
        .map(normalize_external_labels)
        .unwrap_or_default()
}

fn external_labels_to_json(labels: &[ExternalLabel]) -> String {
    serde_json::to_string(labels).unwrap_or_else(|_| "[]".to_string())
}

fn row_to_pull_request(row: &rusqlite::Row<'_>) -> rusqlite::Result<PullRequestRecord> {
    Ok(PullRequestRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        provider: row.get(2)?,
        repo_url: row.get(3)?,
        pr_url: row.get(4)?,
        title: row.get(5)?,
        status: row.get(6)?,
        review_notes: row.get(7)?,
        test_state: row.get(8)?,
        connection_id: row.get(9)?,
        external_title: row.get(10)?,
        external_body: row.get(11)?,
        external_state: row.get(12)?,
        target_branch: row.get(13)?,
        fetched_at: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

fn create_project_in_db(
    db: &SqliteConnection,
    name: String,
    icon: Option<String>,
    color: Option<String>,
) -> rusqlite::Result<Project> {
    let trimmed_name = name.trim();
    let id = new_id("project");
    let timestamp = now_millis();
    let project = Project {
        id,
        name: if trimmed_name.is_empty() {
            "Untitled project".to_string()
        } else {
            trimmed_name.to_string()
        },
        icon: icon
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "FolderKanban".to_string()),
        color: normalize_project_color(color),
        created_at: timestamp,
        updated_at: timestamp,
    };

    db.execute(
        "INSERT INTO projects (id, name, icon, color, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            project.id,
            project.name,
            project.icon,
            project.color,
            project.created_at,
            project.updated_at
        ],
    )?;

    Ok(project)
}

fn get_project(db: &SqliteConnection, id: &str) -> rusqlite::Result<Option<Project>> {
    db.query_row(
        "SELECT id, name, icon, color, created_at, updated_at FROM projects WHERE id = ?1",
        params![id],
        row_to_project,
    )
    .optional()
}

fn get_resource_by_id(db: &SqliteConnection, id: &str) -> rusqlite::Result<Option<Resource>> {
    db.query_row(
        "SELECT id, project_id, provider, kind, external_id, url, name, icon_url, connection_id FROM resources WHERE id = ?1",
        params![id],
        row_to_resource,
    )
    .optional()
}

fn get_resource_by_identity(
    db: &SqliteConnection,
    project_id: &str,
    provider: &str,
    kind: &str,
    external_id: &str,
) -> rusqlite::Result<Option<Resource>> {
    db.query_row(
        "SELECT id, project_id, provider, kind, external_id, url, name, icon_url, connection_id
         FROM resources WHERE project_id = ?1 AND provider = ?2 AND kind = ?3 AND external_id = ?4",
        params![project_id, provider, kind, external_id],
        row_to_resource,
    )
    .optional()
}

fn connect_resource_in_db(
    db: &SqliteConnection,
    input: ResourceInput,
) -> rusqlite::Result<Resource> {
    let external_id = if input.external_id.trim().is_empty() {
        input.url.trim().to_string()
    } else {
        input.external_id.trim().to_string()
    };

    if let Some(resource) = get_resource_by_identity(
        db,
        &input.project_id,
        &input.provider,
        &input.kind,
        &external_id,
    )? {
        return Ok(resource);
    }

    let id = new_id("resource");
    db.execute(
        "INSERT INTO resources (id, project_id, provider, kind, external_id, url, name, icon_url, connection_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            input.project_id,
            input.provider,
            input.kind,
            external_id,
            input.url,
            input.name,
            input.icon_url,
            input.connection_id
        ],
    )?;

    get_resource_by_id(db, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

fn normalize_repository_url(value: &str) -> Option<String> {
    let mut input = value.trim().trim_end_matches('/').to_string();
    if input.is_empty() {
        return None;
    }

    if input.starts_with("git@")
        || (input.contains('@') && input.contains(':') && !input.contains("://"))
    {
        let (_, rest) = input.split_once('@')?;
        let (host, path) = rest.split_once(':')?;
        input = format!("{host}/{path}");
    } else if let Some(rest) = input.strip_prefix("ssh://") {
        let rest = rest.split_once('@').map(|(_, value)| value).unwrap_or(rest);
        input = rest.to_string();
    } else if let Some(rest) = input
        .strip_prefix("https://")
        .or_else(|| input.strip_prefix("http://"))
    {
        input = rest.to_string();
    }

    input = input
        .split(['?', '#'])
        .next()?
        .trim_end_matches('/')
        .to_string();
    if let Some(without_git) = input.strip_suffix(".git") {
        input = without_git.to_string();
    }

    let normalized = input
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/")
        .to_lowercase();
    if normalized.split('/').count() < 3 {
        return None;
    }

    Some(normalized)
}

fn provider_from_normalized_repo(normalized_repo_url: &str) -> String {
    let host = normalized_repo_url.split('/').next().unwrap_or_default();
    if host == "github.com" || host.ends_with(".github.com") {
        "github".to_string()
    } else {
        "gitlab".to_string()
    }
}

fn display_repo_url(normalized_repo_url: &str) -> String {
    format!("https://{normalized_repo_url}")
}

fn default_local_resource_name(path: &str, normalized_repo_url: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            normalized_repo_url
                .split('/')
                .last()
                .filter(|value| !value.trim().is_empty())
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| path.to_string())
}

fn git_output_error(args: &[&str], output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    if detail.is_empty() {
        format!("git {} failed", args.join(" "))
    } else {
        detail
    }
}

fn run_git(path: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(path)
        .output()
        .map_err(|error| format!("Could not run git: {error}"))?;

    if !output.status.success() {
        return Err(git_output_error(args, &output));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn verify_ref(path: &Path, ref_name: &str) -> bool {
    run_git(path, &["rev-parse", "--verify", "--quiet", ref_name]).is_ok()
}

fn list_git_remotes(path: &Path) -> Result<Vec<GitRemote>, String> {
    let remote_names = run_git(path, &["remote"])?;
    let mut remotes = Vec::new();
    for name in remote_names
        .lines()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        let url = run_git(path, &["remote", "get-url", name])?;
        if let Some(normalized_url) = normalize_repository_url(&url) {
            remotes.push(GitRemote {
                name: name.to_string(),
                normalized_url,
            });
        }
    }
    Ok(remotes)
}

fn select_git_remote(
    path: &Path,
    expected_normalized_repo_url: Option<&str>,
) -> Result<GitRemote, String> {
    let remotes = list_git_remotes(path)?;
    if remotes.is_empty() {
        return Err("Local resource repository must have at least one Git remote.".to_string());
    }

    if let Some(expected_normalized_repo_url) = expected_normalized_repo_url {
        return remotes
            .iter()
            .find(|remote| {
                remote.name == "origin" && remote.normalized_url == expected_normalized_repo_url
            })
            .or_else(|| {
                remotes
                    .iter()
                    .find(|remote| remote.normalized_url == expected_normalized_repo_url)
            })
            .cloned()
            .ok_or_else(|| {
                "No Git remote in this directory matches the PR/MR repository.".to_string()
            });
    }

    remotes
        .iter()
        .find(|remote| remote.name == "origin")
        .or_else(|| remotes.first())
        .cloned()
        .ok_or_else(|| "Local resource repository must have at least one Git remote.".to_string())
}

fn local_resource_from_directory(
    input_path: &str,
    expected_provider: Option<&str>,
    expected_repo_url: Option<&str>,
) -> Result<(String, String, String), String> {
    let path = PathBuf::from(input_path);
    if !path.exists() {
        return Err("Local resource directory does not exist.".to_string());
    }
    if !path.is_dir() {
        return Err("Local resource path must be a directory.".to_string());
    }

    let top_level = run_git(&path, &["rev-parse", "--show-toplevel"])
        .map_err(|_| "Local resource directory must be inside a Git worktree.".to_string())?;
    let top_level_path = PathBuf::from(top_level);
    let expected_normalized_repo_url = expected_repo_url
        .filter(|value| !value.trim().is_empty())
        .map(|value| {
            normalize_repository_url(value)
                .ok_or_else(|| "Could not normalize the expected repository URL.".to_string())
        })
        .transpose()?;
    let remote = select_git_remote(&top_level_path, expected_normalized_repo_url.as_deref())?;
    let normalized_repo_url = remote.normalized_url;
    let provider = provider_from_normalized_repo(&normalized_repo_url);

    if let Some(expected_provider) = expected_provider.filter(|value| !value.trim().is_empty()) {
        if provider != expected_provider {
            return Err(format!(
                "Selected repository is a {provider} repository, but this review expects {expected_provider}."
            ));
        }
    }

    Ok((
        top_level_path.to_string_lossy().to_string(),
        provider,
        normalized_repo_url,
    ))
}

fn save_local_resource_in_db(
    db: &SqliteConnection,
    input: LocalResourceInput,
) -> Result<LocalResource, String> {
    get_project(db, &input.project_id)
        .map_err(db_error)?
        .ok_or_else(|| "Project not found".to_string())?;
    let (path, provider, normalized_repo_url) = local_resource_from_directory(
        &input.path,
        input.expected_provider.as_deref(),
        input.expected_repo_url.as_deref(),
    )?;
    let timestamp = now_millis();
    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| default_local_resource_name(&path, &normalized_repo_url));
    let repo_url = display_repo_url(&normalized_repo_url);
    let existing_id = db
        .query_row(
            "SELECT id FROM local_resources WHERE project_id = ?1 AND path = ?2",
            params![&input.project_id, &path],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    let id = existing_id.unwrap_or_else(|| new_id("local_resource"));

    let row_exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM local_resources WHERE id = ?1)",
            params![&id],
            |row| row.get(0),
        )
        .map_err(db_error)?;

    if row_exists {
        db.execute(
            "UPDATE local_resources
             SET provider = ?1, repo_url = ?2, normalized_repo_url = ?3, name = ?4, updated_at = ?5
             WHERE id = ?6",
            params![provider, repo_url, normalized_repo_url, name, timestamp, id],
        )
        .map_err(db_error)?;
    } else {
        db.execute(
            "INSERT INTO local_resources
             (id, project_id, provider, repo_url, normalized_repo_url, path, name, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                id,
                input.project_id,
                provider,
                repo_url,
                normalized_repo_url,
                path,
                name,
                timestamp,
                timestamp
            ],
        )
        .map_err(db_error)?;
    }

    get_local_resource(db, &id)?.ok_or_else(|| "Local resource not found after save.".to_string())
}

fn get_local_resource(db: &SqliteConnection, id: &str) -> Result<Option<LocalResource>, String> {
    db.query_row(
        "SELECT id, project_id, provider, repo_url, path, name, created_at, updated_at
         FROM local_resources WHERE id = ?1",
        params![id],
        row_to_local_resource,
    )
    .optional()
    .map_err(db_error)
}

fn checkout_target(provider: &str, pr_url: &str) -> Result<(String, String, String), String> {
    let without_query = pr_url.split(['?', '#']).next().unwrap_or(pr_url);
    let parts = without_query.split('/').collect::<Vec<_>>();
    let number = if provider == "github" {
        parts
            .windows(2)
            .find_map(|window| (window[0] == "pull").then_some(window[1]))
            .filter(|value| value.chars().all(|character| character.is_ascii_digit()))
            .ok_or_else(|| "Could not parse the GitHub pull request number.".to_string())?
    } else if provider == "gitlab" {
        parts
            .windows(2)
            .find_map(|window| (window[0] == "merge_requests").then_some(window[1]))
            .filter(|value| value.chars().all(|character| character.is_ascii_digit()))
            .ok_or_else(|| "Could not parse the GitLab merge request number.".to_string())?
    } else {
        return Err(
            "Only GitHub pull requests and GitLab merge requests can be reviewed.".to_string(),
        );
    };

    if provider == "github" {
        Ok((
            format!("pull/{number}/head"),
            format!("review/github-pr-{number}"),
            format!("review/github-pr-{number}"),
        ))
    } else {
        Ok((
            format!("merge-requests/{number}/head"),
            format!("review/gitlab-mr-{number}"),
            format!("review/gitlab-mr-{number}"),
        ))
    }
}

fn set_checkout_test_state_if_present(db: &SqliteConnection, pr_url: &str) -> Result<(), String> {
    let Some((id, test_state)) = db
        .query_row(
            "SELECT id, test_state FROM pull_requests WHERE pr_url = ?1",
            params![pr_url],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(db_error)?
    else {
        return Ok(());
    };

    let mut value = serde_json::from_str::<Value>(&test_state)
        .unwrap_or_else(|_| Value::Object(Default::default()));
    if !value.is_object() {
        value = Value::Object(Default::default());
    }
    if let Some(object) = value.as_object_mut() {
        object.insert("checkout".to_string(), Value::Bool(true));
    }
    db.execute(
        "UPDATE pull_requests SET test_state = ?1, updated_at = ?2 WHERE id = ?3",
        params![value.to_string(), now_millis(), id],
    )
    .map_err(db_error)?;
    Ok(())
}

fn review_target_branch_for_url(
    db: &SqliteConnection,
    pr_url: &str,
) -> Result<Option<String>, String> {
    let task_link_branch = db
        .query_row(
            "SELECT target_branch FROM task_links
             WHERE url = ?1 AND target_branch IS NOT NULL AND TRIM(target_branch) != ''
             LIMIT 1",
            params![pr_url],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    if task_link_branch.is_some() {
        return Ok(task_link_branch);
    }

    db.query_row(
        "SELECT target_branch FROM pull_requests
         WHERE pr_url = ?1 AND target_branch IS NOT NULL AND TRIM(target_branch) != ''
         LIMIT 1",
        params![pr_url],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(db_error)
}

fn review_request_state_for_url(
    db: &SqliteConnection,
    pr_url: &str,
) -> Result<Option<String>, String> {
    let task_link_state = db
        .query_row(
            "SELECT external_state FROM task_links
             WHERE url = ?1 AND external_state IS NOT NULL AND TRIM(external_state) != ''
             LIMIT 1",
            params![pr_url],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    if task_link_state.is_some() {
        return Ok(task_link_state);
    }

    db.query_row(
        "SELECT external_state FROM pull_requests
         WHERE pr_url = ?1 AND external_state IS NOT NULL AND TRIM(external_state) != ''
         LIMIT 1",
        params![pr_url],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(db_error)
}

fn review_request_is_closed(state: Option<&str>) -> bool {
    matches!(
        state.map(str::trim).map(str::to_ascii_lowercase).as_deref(),
        Some("closed" | "merged")
    )
}

fn fetch_review_base_ref(
    path: &Path,
    remote: &str,
    target_branch: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(target_branch) = target_branch
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let target_ref = format!("refs/heads/{target_branch}:refs/remotes/{remote}/{target_branch}");
    run_git(path, &["fetch", remote, &target_ref])
        .map_err(|error| format!("Could not fetch target branch from {remote}: {error}"))?;
    Ok(Some(format!("{remote}/{target_branch}")))
}

fn checkout_pull_request_for_review_in_db(
    db: &SqliteConnection,
    local_resource_id: String,
    provider: String,
    pr_url: String,
) -> Result<PullRequestCheckoutResult, String> {
    let resource = get_local_resource(db, &local_resource_id)?
        .ok_or_else(|| "Local resource not found".to_string())?;
    if resource.provider != provider {
        return Err("Selected local resource does not match this PR/MR provider.".to_string());
    }

    let review_state = review_request_state_for_url(db, &pr_url)?;
    if review_request_is_closed(review_state.as_deref()) {
        let request_name = if provider == "github" {
            "pull request"
        } else {
            "merge request"
        };
        return Err(format!(
            "This {request_name} is {} and can no longer be reviewed.",
            review_state
                .unwrap_or_else(|| "closed".to_string())
                .to_ascii_lowercase()
        ));
    }

    let path = PathBuf::from(&resource.path);
    let normalized_resource = normalize_repository_url(&resource.repo_url)
        .ok_or_else(|| "Could not normalize the saved local resource URL.".to_string())?;
    let remote = select_git_remote(&path, Some(&normalized_resource))?;

    let status = run_git(
        &path,
        &["status", "--porcelain=v1", "--untracked-files=normal"],
    )?;
    if !status.trim().is_empty() {
        return Err("Local resource has uncommitted or untracked changes. Commit, stash, or clean it before reviewing.".to_string());
    }

    let (remote_head, branch, remote_review_branch) = checkout_target(&provider, &pr_url)?;
    let remote_ref = format!("refs/remotes/{}/{}", remote.name, remote_review_branch);
    let target_branch = review_target_branch_for_url(db, &pr_url)?;
    let base_ref = fetch_review_base_ref(&path, &remote.name, target_branch.as_deref())?;
    let remote_head_ref = format!("refs/{remote_head}");
    let remote_head_sha = run_git(&path, &["ls-remote", &remote.name, &remote_head_ref])
        .map_err(|error| format!("Could not check the remote review branch: {error}"))?;
    if remote_head_sha.trim().is_empty() {
        return Err(
            "Remote review branch not found. The pull or merge request may be closed, merged, or removed."
                .to_string(),
        );
    }

    let fetch_refspec = format!("+{remote_head}:{remote_ref}");
    run_git(&path, &["fetch", &remote.name, &fetch_refspec]).map_err(|error| {
        format!(
            "Could not fetch review branch from {}: {error}",
            remote.name
        )
    })?;

    let local_ref = format!("refs/heads/{branch}");
    if verify_ref(&path, &local_ref) {
        run_git(&path, &["switch", &branch])
            .map_err(|error| format!("Could not switch to existing review branch: {error}"))?;
        run_git(&path, &["merge", "--ff-only", &remote_ref])
            .map_err(|_| {
                "The pull or merge request changed since it was last reviewed here, and the saved local review copy cannot be updated safely. Your local files were left unchanged. Choose another repository directory or remove the old review branch, then try again."
                    .to_string()
            })?;
    } else {
        run_git(&path, &["switch", "-c", &branch, &remote_ref])
            .map_err(|error| format!("Could not create review branch: {error}"))?;
    }

    set_checkout_test_state_if_present(db, &pr_url)?;

    Ok(PullRequestCheckoutResult {
        path: resource.path,
        branch: branch.clone(),
        remote_ref,
        base_ref,
        message: format!("Checked out {branch}."),
    })
}

fn local_resource_for_review(
    db: &SqliteConnection,
    local_resource_id: &str,
) -> Result<LocalResource, String> {
    get_local_resource(db, local_resource_id)?.ok_or_else(|| "Local resource not found".to_string())
}

fn current_git_branch(path: &Path) -> Result<String, String> {
    let branch = run_git(path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if branch == "HEAD" || branch.trim().is_empty() {
        return Err("Local resource is not on a branch.".to_string());
    }
    Ok(branch)
}

fn review_diff_base_ref(
    path: &Path,
    remote: &str,
    preferred_base_ref: Option<&str>,
) -> Result<String, String> {
    if let Some(preferred_base_ref) = preferred_base_ref
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if verify_ref(path, preferred_base_ref) {
            return Ok(preferred_base_ref.to_string());
        }
        return Err(format!(
            "Review target branch ref {preferred_base_ref} was not found in the local resource."
        ));
    }

    [
        format!("{remote}/HEAD"),
        format!("{remote}/main"),
        format!("{remote}/master"),
    ]
    .into_iter()
        .find(|candidate| verify_ref(path, candidate))
        .ok_or_else(|| {
            format!(
                "Could not find a base ref. Fetch {remote}/HEAD, {remote}/main, or {remote}/master first."
            )
        })
}

fn review_diff_files(path: &Path, base_ref: &str, branch: &str) -> Result<Vec<String>, String> {
    let range = format!("{base_ref}...{branch}");
    let output = run_git(path, &["diff", "--name-only", &range])?;
    Ok(output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect())
}

fn review_diff_file(
    path: &Path,
    base_ref: &str,
    branch: &str,
    file_path: &str,
) -> Result<ReviewDiffFile, String> {
    let range = format!("{base_ref}...{branch}");
    let diff = run_git(path, &["diff", &range, "--", file_path])?;
    let (old_path, new_path) = review_diff_paths(&diff, file_path);
    Ok(ReviewDiffFile {
        path: file_path.to_string(),
        old_path,
        new_path,
        diff,
    })
}

fn review_diff_paths(diff: &str, fallback: &str) -> (String, String) {
    fn header_path(line: &str, prefix: &str) -> Option<String> {
        let value = line.strip_prefix(prefix)?.split('\t').next()?.trim();
        if value.is_empty() || value == "/dev/null" {
            return None;
        }
        Some(
            value
                .strip_prefix("a/")
                .or_else(|| value.strip_prefix("b/"))
                .unwrap_or(value)
                .to_string(),
        )
    }

    let old = diff.lines().find_map(|line| header_path(line, "--- "));
    let new = diff.lines().find_map(|line| header_path(line, "+++ "));
    (
        old.clone()
            .or_else(|| new.clone())
            .unwrap_or_else(|| fallback.to_string()),
        new.or(old).unwrap_or_else(|| fallback.to_string()),
    )
}

fn load_review_diff_in_db(
    db: &SqliteConnection,
    local_resource_id: String,
    branch: Option<String>,
    base_ref: Option<String>,
) -> Result<ReviewDiffResult, String> {
    let resource = local_resource_for_review(db, &local_resource_id)?;
    let path = PathBuf::from(&resource.path);
    let normalized_resource = normalize_repository_url(&resource.repo_url)
        .ok_or_else(|| "Could not normalize the saved local resource URL.".to_string())?;
    let remote = select_git_remote(&path, Some(&normalized_resource))?;
    let branch = branch
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(Ok)
        .unwrap_or_else(|| current_git_branch(&path))?;
    if !verify_ref(&path, &branch) {
        return Err("Review branch was not found in the local resource.".to_string());
    }

    let base_ref = review_diff_base_ref(&path, &remote.name, base_ref.as_deref())?;
    let head_sha = run_git(&path, &["rev-parse", &branch])?;
    let files = review_diff_files(&path, &base_ref, &branch)?;
    let current_file = files
        .first()
        .map(|file_path| review_diff_file(&path, &base_ref, &branch, file_path))
        .transpose()?;

    Ok(ReviewDiffResult {
        path: resource.path,
        branch,
        base_ref,
        head_sha,
        files,
        current_file,
    })
}

fn load_review_diff_file_in_db(
    db: &SqliteConnection,
    local_resource_id: String,
    base_ref: String,
    branch: String,
    path: String,
) -> Result<ReviewDiffFile, String> {
    let resource = local_resource_for_review(db, &local_resource_id)?;
    let resource_path = PathBuf::from(resource.path);
    if !verify_ref(&resource_path, &base_ref) {
        return Err("Review base ref was not found in the local resource.".to_string());
    }
    if !verify_ref(&resource_path, &branch) {
        return Err("Review branch was not found in the local resource.".to_string());
    }
    if path.trim().is_empty() {
        return Err("Review file path is required.".to_string());
    }

    review_diff_file(&resource_path, &base_ref, &branch, &path)
}

fn row_to_review_comment_draft(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReviewCommentDraft> {
    Ok(ReviewCommentDraft {
        id: row.get(0)?,
        task_id: row.get(1)?,
        kind: row.get(2)?,
        body: row.get(3)?,
        path: row.get(4)?,
        old_path: row.get(5)?,
        new_path: row.get(6)?,
        start_old_line: row.get(7)?,
        start_new_line: row.get(8)?,
        start_side: row.get(9)?,
        old_line: row.get(10)?,
        new_line: row.get(11)?,
        side: row.get(12)?,
        head_sha: row.get(13)?,
        last_error: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

const REVIEW_DRAFT_SELECT: &str = "SELECT id, task_id, kind, body, path, old_path, new_path, start_old_line, start_new_line, start_side, old_line, new_line, side, head_sha, last_error, created_at, updated_at FROM review_comment_drafts";

fn list_review_comment_drafts_in_db(
    db: &SqliteConnection,
    task_id: &str,
) -> Result<Vec<ReviewCommentDraft>, String> {
    let mut statement = db
        .prepare(&format!(
            "{REVIEW_DRAFT_SELECT} WHERE task_id = ?1 ORDER BY created_at ASC"
        ))
        .map_err(db_error)?;
    let drafts = statement
        .query_map(params![task_id], row_to_review_comment_draft)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(drafts)
}

fn validate_review_comment_draft(input: &ReviewCommentDraftInput) -> Result<(), String> {
    if input.task_id.trim().is_empty() {
        return Err("Task is required.".to_string());
    }
    if input.body.trim().is_empty() {
        return Err("Review comment cannot be blank.".to_string());
    }
    if !matches!(input.kind.as_str(), "overall" | "inline") {
        return Err("Review draft kind is invalid.".to_string());
    }
    if input.kind == "inline" {
        if input
            .path
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
            || !matches!(input.side.as_deref(), Some("LEFT" | "RIGHT"))
            || input
                .head_sha
                .as_deref()
                .is_none_or(|value| value.trim().is_empty())
        {
            return Err("Inline review draft position is invalid.".to_string());
        }
        match input.side.as_deref() {
            Some("LEFT") if input.old_line.is_none() => {
                return Err("A left-side review comment requires an old line.".to_string())
            }
            Some("RIGHT") if input.new_line.is_none() => {
                return Err("A right-side review comment requires a new line.".to_string())
            }
            _ => {}
        }
        let start_side = input.start_side.as_deref().or(input.side.as_deref());
        let start_old_line = input.start_old_line.or(input.old_line);
        let start_new_line = input.start_new_line.or(input.new_line);
        match start_side {
            Some("LEFT") if start_old_line.is_none() => {
                return Err("A left-side review range requires an old start line.".to_string())
            }
            Some("RIGHT") if start_new_line.is_none() => {
                return Err("A right-side review range requires a new start line.".to_string())
            }
            Some("LEFT" | "RIGHT") => {}
            _ => return Err("Inline review draft start side is invalid.".to_string()),
        }
    }
    Ok(())
}

fn save_review_comment_draft_in_db(
    db: &SqliteConnection,
    input: ReviewCommentDraftInput,
) -> Result<ReviewCommentDraft, String> {
    validate_review_comment_draft(&input)?;
    if get_task(db, &input.task_id).map_err(db_error)?.is_none() {
        return Err("Task not found.".to_string());
    }
    let timestamp = now_millis();
    let id = if let Some(id) = input.id.clone() {
        id
    } else if input.kind == "overall" {
        db.query_row(
            "SELECT id FROM review_comment_drafts WHERE task_id = ?1 AND kind = 'overall'",
            params![&input.task_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?
        .unwrap_or_else(|| new_id("review_draft"))
    } else {
        new_id("review_draft")
    };
    let created_at = db
        .query_row(
            "SELECT created_at FROM review_comment_drafts WHERE id = ?1",
            params![&id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(db_error)?
        .unwrap_or(timestamp);
    let inline = input.kind == "inline";
    db.execute(
        "INSERT INTO review_comment_drafts
         (id, task_id, kind, body, path, old_path, new_path, start_old_line, start_new_line, start_side, old_line, new_line, side, head_sha, last_error, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, ?15, ?16)
         ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, kind = excluded.kind,
         body = excluded.body, path = excluded.path, old_path = excluded.old_path,
         new_path = excluded.new_path, start_old_line = excluded.start_old_line,
         start_new_line = excluded.start_new_line, start_side = excluded.start_side,
         old_line = excluded.old_line, new_line = excluded.new_line,
         side = excluded.side, head_sha = excluded.head_sha, last_error = NULL,
         updated_at = excluded.updated_at",
        params![
            &id,
            &input.task_id,
            &input.kind,
            input.body.trim(),
            if inline { input.path.as_deref() } else { None },
            if inline { input.old_path.as_deref().or(input.path.as_deref()) } else { None },
            if inline { input.new_path.as_deref().or(input.path.as_deref()) } else { None },
            if inline { input.start_old_line.or(input.old_line) } else { None },
            if inline { input.start_new_line.or(input.new_line) } else { None },
            if inline { input.start_side.as_deref().or(input.side.as_deref()) } else { None },
            if inline { input.old_line } else { None },
            if inline { input.new_line } else { None },
            if inline { input.side.as_deref() } else { None },
            if inline { input.head_sha.as_deref() } else { None },
            created_at,
            timestamp,
        ],
    )
    .map_err(db_error)?;
    db.query_row(
        &format!("{REVIEW_DRAFT_SELECT} WHERE id = ?1"),
        params![id],
        row_to_review_comment_draft,
    )
    .map_err(db_error)
}

fn set_review_draft_error(
    db: &SqliteConnection,
    draft_id: &str,
    message: &str,
) -> Result<(), String> {
    db.execute(
        "UPDATE review_comment_drafts SET last_error = ?1, updated_at = ?2 WHERE id = ?3",
        params![message, now_millis(), draft_id],
    )
    .map_err(db_error)?;
    Ok(())
}

fn delete_review_draft_in_db(db: &SqliteConnection, draft_id: &str) -> Result<(), String> {
    db.execute(
        "DELETE FROM review_comment_drafts WHERE id = ?1",
        params![draft_id],
    )
    .map_err(db_error)?;
    Ok(())
}

fn github_review_headers(connection: &ConnectionRecord) -> Vec<(&'static str, String)> {
    vec![
        ("Accept", "application/vnd.github+json".to_string()),
        ("Authorization", format!("Bearer {}", connection.token)),
        ("X-GitHub-Api-Version", "2022-11-28".to_string()),
        ("User-Agent", "dev-crash-flash-ai-studio".to_string()),
    ]
}

fn refresh_published_review_comments(
    db: &SqliteConnection,
    link: &TaskLink,
    connection: &ConnectionRecord,
    repo_path: &str,
    number: &str,
) -> Result<TaskLink, String> {
    let comments = match link.provider.as_str() {
        "github" => fetch_github_pull_request_comments(connection, repo_path, number)?,
        "gitlab" => {
            fetch_gitlab_merge_request_comments(connection, repo_path, number, Some(&link.url))?
        }
        _ => return Err("Unsupported review provider.".to_string()),
    };
    let comments_json = serde_json::to_string(&comments).map_err(db_error)?;
    db.execute(
        "UPDATE task_links SET comments_json = ?1, fetched_at = ?2 WHERE task_id = ?3",
        params![comments_json, now_millis(), &link.task_id],
    )
    .map_err(db_error)?;
    list_task_links_in_db(db, &link.task_id)
        .map_err(db_error)?
        .into_iter()
        .next()
        .ok_or_else(|| "Task link not found after publishing review comments.".to_string())
}

fn gitlab_line_code(path: &str, old_line: Option<i64>, new_line: Option<i64>) -> String {
    let mut hasher = Sha1::new();
    hasher.update(path.as_bytes());
    format!(
        "{:x}_{}_{}",
        hasher.finalize(),
        old_line.unwrap_or(0),
        new_line.unwrap_or(0)
    )
}

fn gitlab_range_point(path: &str, old_line: Option<i64>, new_line: Option<i64>) -> Value {
    serde_json::json!({
        "line_code": gitlab_line_code(path, old_line, new_line),
        "type": if old_line.is_none() { "new" } else { "old" },
        "old_line": old_line,
        "new_line": new_line,
    })
}

fn github_review_comment_payload(draft: &ReviewCommentDraft) -> Value {
    let mut comment = serde_json::json!({
        "path": draft.path,
        "line": if draft.side.as_deref() == Some("LEFT") { draft.old_line } else { draft.new_line },
        "side": draft.side,
        "body": draft.body,
    });
    let start_side = draft.start_side.as_deref().or(draft.side.as_deref());
    let start_line = if start_side == Some("LEFT") {
        draft.start_old_line.or(draft.old_line)
    } else {
        draft.start_new_line.or(draft.new_line)
    };
    let end_line = if draft.side.as_deref() == Some("LEFT") {
        draft.old_line
    } else {
        draft.new_line
    };
    if start_side != draft.side.as_deref() || start_line != end_line {
        comment["start_line"] = serde_json::json!(start_line);
        comment["start_side"] = serde_json::json!(start_side);
    }
    comment
}

fn gitlab_review_position(
    draft: &ReviewCommentDraft,
    base_sha: &str,
    start_sha: &str,
    head_sha: &str,
) -> Value {
    let mut position = serde_json::json!({
        "position_type": "text",
        "base_sha": base_sha,
        "start_sha": start_sha,
        "head_sha": head_sha,
        "old_path": draft.old_path.as_ref().or(draft.path.as_ref()),
        "new_path": draft.new_path.as_ref().or(draft.path.as_ref()),
    });
    if draft.side.as_deref() == Some("LEFT") {
        position["old_line"] = serde_json::json!(draft.old_line);
    } else {
        position["new_line"] = serde_json::json!(draft.new_line);
    }
    let start_old_line = draft.start_old_line.or(draft.old_line);
    let start_new_line = draft.start_new_line.or(draft.new_line);
    if start_old_line != draft.old_line || start_new_line != draft.new_line {
        let line_code_path = draft
            .new_path
            .as_deref()
            .or(draft.old_path.as_deref())
            .or(draft.path.as_deref())
            .unwrap_or_default();
        position["line_range"] = serde_json::json!({
            "start": gitlab_range_point(line_code_path, start_old_line, start_new_line),
            "end": gitlab_range_point(line_code_path, draft.old_line, draft.new_line),
        });
    }
    position
}

fn submit_review_comments_in_db(
    db: &SqliteConnection,
    task_id: &str,
    overall_body: Option<String>,
) -> Result<ReviewCommentSubmissionResult, String> {
    let task = get_task(db, task_id)
        .map_err(db_error)?
        .ok_or_else(|| "Task not found.".to_string())?;
    let link = list_task_links_in_db(db, task_id)
        .map_err(db_error)?
        .into_iter()
        .next()
        .ok_or_else(|| "This task has no pull or merge request.".to_string())?;
    if !matches!(
        (link.provider.as_str(), link.kind.as_str()),
        ("github", "pull_request") | ("gitlab", "merge_request")
    ) {
        return Err("Review comments are only supported for GitHub pull requests and GitLab merge requests.".to_string());
    }
    let connection_id = link.connection_id.as_deref().ok_or_else(|| {
        "Connect this pull or merge request before publishing comments.".to_string()
    })?;
    let connection = get_connection(db, connection_id)
        .map_err(db_error)?
        .ok_or_else(|| {
            "The connection used by this pull or merge request no longer exists.".to_string()
        })?;
    let drafts = list_review_comment_drafts_in_db(db, task_id)?;
    if drafts.is_empty() {
        if overall_body
            .as_deref()
            .is_none_or(|body| body.trim().is_empty())
        {
            return Err("Add an inline or overall review comment before submitting.".to_string());
        }
    }
    let legacy_summary = drafts.iter().find(|draft| draft.kind == "overall");
    let summary_was_cleared = overall_body
        .as_deref()
        .is_some_and(|body| body.trim().is_empty());
    let summary_body = match overall_body {
        Some(body) => (!body.trim().is_empty()).then(|| body.trim().to_string()),
        None => legacy_summary.map(|draft| draft.body.trim().to_string()),
    };
    let inline = drafts
        .iter()
        .filter(|draft| draft.kind == "inline")
        .collect::<Vec<_>>();
    if inline.is_empty() && summary_body.is_none() {
        return Err("Add an inline or overall review comment before submitting.".to_string());
    }
    let parsed = parsed_payload_from_task_link(&task, &link);
    let (repo_path, number) = if link.provider == "github" {
        split_github_external_id(&parsed)?
    } else {
        split_gitlab_external_id(&parsed)?
    };

    let (head_sha, base_sha, start_sha) = if link.provider == "github" {
        let json = fetch_json(
            &format!("https://api.github.com/repos/{repo_path}/pulls/{number}"),
            github_review_headers(&connection),
        )?;
        if json_string(&json, "state").as_deref() != Some("open")
            || json_bool(&json, "merged") == Some(true)
        {
            return Err("This GitHub pull request is no longer open.".to_string());
        }
        (
            json_path_string(&json, &["head", "sha"])
                .ok_or_else(|| "GitHub did not return the pull request head SHA.".to_string())?,
            None,
            None,
        )
    } else {
        let base_url = normalize_base_url(&connection.base_url);
        let json = fetch_json(
            &format!(
                "{base_url}/api/v4/projects/{}/merge_requests/{}",
                percent_encode(&repo_path),
                percent_encode(&number)
            ),
            vec![("PRIVATE-TOKEN", connection.token.clone())],
        )?;
        if json_string(&json, "state").as_deref() != Some("opened") {
            return Err("This GitLab merge request is no longer open.".to_string());
        }
        (
            json_path_string(&json, &["diff_refs", "head_sha"])
                .ok_or_else(|| "GitLab did not return the merge request head SHA.".to_string())?,
            Some(
                json_path_string(&json, &["diff_refs", "base_sha"]).ok_or_else(|| {
                    "GitLab did not return the merge request base SHA.".to_string()
                })?,
            ),
            Some(
                json_path_string(&json, &["diff_refs", "start_sha"]).ok_or_else(|| {
                    "GitLab did not return the merge request start SHA.".to_string()
                })?,
            ),
        )
    };

    if inline
        .iter()
        .any(|draft| draft.head_sha.as_deref() != Some(head_sha.as_str()))
    {
        return Err("The pull or merge request changed after these comments were drafted. Refresh the review branch and re-anchor the inline drafts before submitting.".to_string());
    }

    let mut published_draft_ids = Vec::new();
    let mut failures = Vec::new();
    let mut published_any = false;
    let mut published_transient_overall = false;
    if link.provider == "github" {
        let comments = inline
            .iter()
            .map(|draft| github_review_comment_payload(draft))
            .collect::<Vec<_>>();
        let mut payload = serde_json::json!({
            "commit_id": head_sha,
            "comments": comments,
        });
        let url = format!("https://api.github.com/repos/{repo_path}/pulls/{number}/reviews");
        let publish_result = if let Some(body) = summary_body.as_deref() {
            payload["body"] = serde_json::json!(body);
            payload["event"] = serde_json::json!("COMMENT");
            post_json(&url, github_review_headers(&connection), &payload).map(|_| ())
        } else {
            post_json(&url, github_review_headers(&connection), &payload).and_then(|pending| {
                let review_id = json_id_string(&pending, "id")
                    .ok_or_else(|| "GitHub did not return the pending review ID.".to_string())?;
                let submit_url = format!("{url}/{review_id}/events");
                post_json(
                    &submit_url,
                    github_review_headers(&connection),
                    &serde_json::json!({ "event": "COMMENT" }),
                )
                .map(|_| ())
                .map_err(|message| {
                    let delete_url = format!("{url}/{review_id}");
                    match delete_json(&delete_url, github_review_headers(&connection)) {
                        Ok(_) => message,
                        Err(cleanup) => format!(
                            "{message} The pending GitHub review also could not be removed: {cleanup}"
                        ),
                    }
                })
            })
        };
        match publish_result {
            Ok(_) => {
                published_any = true;
                published_transient_overall = summary_body.is_some() && legacy_summary.is_none();
                for draft in &drafts {
                    delete_review_draft_in_db(db, &draft.id)?;
                    published_draft_ids.push(draft.id.clone());
                }
            }
            Err(message) => {
                for draft in &drafts {
                    set_review_draft_error(db, &draft.id, &message)?;
                    failures.push(ReviewCommentFailure {
                        draft_id: draft.id.clone(),
                        message: message.clone(),
                    });
                }
                if drafts.is_empty() {
                    failures.push(ReviewCommentFailure {
                        draft_id: "overall".to_string(),
                        message,
                    });
                }
            }
        }
    } else {
        let base_url = normalize_base_url(&connection.base_url);
        let url = format!(
            "{base_url}/api/v4/projects/{}/merge_requests/{}/discussions",
            percent_encode(&repo_path),
            percent_encode(&number)
        );
        for draft in &inline {
            let position = gitlab_review_position(
                draft,
                base_sha.as_deref().unwrap_or_default(),
                start_sha.as_deref().unwrap_or_default(),
                &head_sha,
            );
            let payload = serde_json::json!({ "body": draft.body, "position": position });
            match post_json(
                &url,
                vec![("PRIVATE-TOKEN", connection.token.clone())],
                &payload,
            ) {
                Ok(_) => {
                    published_any = true;
                    delete_review_draft_in_db(db, &draft.id)?;
                    published_draft_ids.push(draft.id.clone());
                }
                Err(message) => {
                    set_review_draft_error(db, &draft.id, &message)?;
                    failures.push(ReviewCommentFailure {
                        draft_id: draft.id.clone(),
                        message,
                    });
                }
            }
        }
        if failures.is_empty() {
            if let Some(body) = summary_body.as_deref() {
                let payload = serde_json::json!({ "body": body });
                match post_json(
                    &url,
                    vec![("PRIVATE-TOKEN", connection.token.clone())],
                    &payload,
                ) {
                    Ok(_) => {
                        published_any = true;
                        if let Some(summary) = legacy_summary {
                            delete_review_draft_in_db(db, &summary.id)?;
                            published_draft_ids.push(summary.id.clone());
                        } else {
                            published_transient_overall = true;
                        }
                    }
                    Err(message) => {
                        if let Some(summary) = legacy_summary {
                            set_review_draft_error(db, &summary.id, &message)?;
                            failures.push(ReviewCommentFailure {
                                draft_id: summary.id.clone(),
                                message,
                            });
                        } else {
                            failures.push(ReviewCommentFailure {
                                draft_id: "overall".to_string(),
                                message,
                            });
                        }
                    }
                }
            }
            if summary_was_cleared {
                if let Some(summary) = legacy_summary {
                    delete_review_draft_in_db(db, &summary.id)?;
                }
            }
        }
    }

    let mut notice = if failures.is_empty() {
        "Review comments published.".to_string()
    } else if published_draft_ids.is_empty() {
        "Review comments could not be published. The drafts were kept for retry.".to_string()
    } else {
        "Some review comments were published. Failed drafts were kept for retry.".to_string()
    };
    let refreshed_link = if !published_any {
        Some(link)
    } else {
        match refresh_published_review_comments(db, &link, &connection, &repo_path, &number) {
            Ok(link) => Some(link),
            Err(_) => {
                notice.push_str(" Published comments could not be refreshed locally yet.");
                Some(link)
            }
        }
    };
    let remaining_drafts = list_review_comment_drafts_in_db(db, task_id)?;
    Ok(ReviewCommentSubmissionResult {
        published_count: published_draft_ids.len() + usize::from(published_transient_overall),
        published_draft_ids,
        remaining_drafts,
        failures,
        link: refreshed_link,
        notice,
    })
}

fn is_supported_ocr_mime_type(mime_type: &str) -> bool {
    matches!(
        mime_type.trim().to_ascii_lowercase().as_str(),
        "image/png" | "image/jpeg" | "image/webp"
    )
}

fn is_supported_ocr_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp")
    )
}

fn validate_ocr_image_path(path: &str, mime_type: Option<&str>) -> Result<PathBuf, String> {
    let image_path = PathBuf::from(path);
    if !image_path.exists() {
        return Err("Dropped file does not exist.".to_string());
    }
    if !image_path.is_file() {
        return Err("Dropped path must be a file.".to_string());
    }

    let mime_type = mime_type.map(str::trim).filter(|value| !value.is_empty());
    let supported = mime_type
        .map(is_supported_ocr_mime_type)
        .unwrap_or_else(|| is_supported_ocr_extension(&image_path));
    if !supported {
        return Err("Unsupported file type. Drop a PNG, JPEG, or WebP image.".to_string());
    }

    Ok(image_path)
}

fn validate_ocr_image_name(name: &str, mime_type: Option<&str>) -> Result<(), String> {
    let supported = mime_type
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(is_supported_ocr_mime_type)
        .unwrap_or_else(|| is_supported_ocr_extension(Path::new(name)));
    if !supported {
        return Err("Unsupported file type. Drop a PNG, JPEG, or WebP image.".to_string());
    }

    Ok(())
}

fn is_supported_email_mime_type(mime_type: &str) -> bool {
    matches!(
        mime_type.trim().to_ascii_lowercase().as_str(),
        "message/rfc822"
    )
}

fn is_supported_email_extension(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .map(|extension| extension.to_ascii_lowercase())
            .as_deref(),
        Some("eml")
    )
}

fn validate_email_file_path(path: &str, mime_type: Option<&str>) -> Result<PathBuf, String> {
    let email_path = PathBuf::from(path);
    if !email_path.exists() {
        return Err("Dropped file does not exist.".to_string());
    }
    if !email_path.is_file() {
        return Err("Dropped path must be a file.".to_string());
    }

    let mime_type = mime_type.map(str::trim).filter(|value| !value.is_empty());
    let supported = mime_type.map(is_supported_email_mime_type).unwrap_or(false)
        || is_supported_email_extension(&email_path);
    if !supported {
        return Err(
            "Unsupported file type. Drop a PNG, JPEG, WebP image, or .eml email.".to_string(),
        );
    }

    Ok(email_path)
}

fn read_email_file_in_app(
    path: String,
    mime_type: Option<String>,
) -> Result<EmailFileResult, String> {
    let email_path = validate_email_file_path(&path, mime_type.as_deref())?;
    let bytes =
        fs::read(&email_path).map_err(|error| format!("Could not read email file: {error}"))?;
    read_email_bytes_in_app(&bytes)
}

fn read_email_bytes_in_app(bytes: &[u8]) -> Result<EmailFileResult, String> {
    let message = mail_parser::MessageParser::default()
        .parse(bytes)
        .ok_or_else(|| "Could not parse email file.".to_string())?;
    let subject = message
        .subject()
        .map(ToString::to_string)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Email task".to_string());
    let body = email_body_as_markdown(&message);

    Ok(EmailFileResult { subject, body })
}

fn read_apple_mail_message_in_app(message_uri: String) -> Result<EmailFileResult, String> {
    let message_id = apple_mail_message_id_from_uri(&message_uri)?;
    let bytes = find_apple_mail_message_bytes(&message_id)?.ok_or_else(|| {
        format!("Could not find Apple Mail message with Message-ID <{message_id}>.")
    })?;
    read_email_bytes_in_app(&bytes)
}

fn apple_mail_message_id_from_uri(message_uri: &str) -> Result<String, String> {
    let value = message_uri.trim();
    let encoded = value
        .strip_prefix("message:")
        .ok_or_else(|| "Dropped Apple Mail item did not include a message: URI.".to_string())?;
    let decoded = percent_decode(encoded)?;
    let message_id = decoded.trim().trim_start_matches('<').trim_end_matches('>');
    if message_id.is_empty() || !message_id.contains('@') {
        return Err("Dropped Apple Mail item did not include a valid Message-ID.".to_string());
    }

    Ok(message_id.to_string())
}

fn percent_decode(value: &str) -> Result<String, String> {
    let mut output = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(
                    "Dropped Apple Mail message URI was not valid percent-encoding.".to_string(),
                );
            }
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3])
                .map_err(|_| "Dropped Apple Mail message URI was not valid UTF-8.".to_string())?;
            let byte = u8::from_str_radix(hex, 16).map_err(|_| {
                "Dropped Apple Mail message URI was not valid percent-encoding.".to_string()
            })?;
            output.push(byte);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }

    String::from_utf8(output)
        .map_err(|_| "Dropped Apple Mail message URI was not valid UTF-8.".to_string())
}

fn find_apple_mail_message_bytes(message_id: &str) -> Result<Option<Vec<u8>>, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Could not locate the home directory to search Apple Mail.".to_string())?;
    let mail_dir = home.join("Library").join("Mail");
    if !mail_dir.exists() {
        return Ok(None);
    }

    find_apple_mail_message_bytes_in_dir(&mail_dir, message_id)
}

fn find_apple_mail_message_bytes_in_dir(
    directory: &Path,
    message_id: &str,
) -> Result<Option<Vec<u8>>, String> {
    let mut stack = vec![directory.to_path_buf()];
    let needle = message_id.as_bytes();

    while let Some(path) = stack.pop() {
        let entries = match fs::read_dir(&path) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };

            if file_type.is_dir() {
                stack.push(path);
                continue;
            }

            if !file_type.is_file()
                || path.extension().and_then(|value| value.to_str()) != Some("emlx")
            {
                continue;
            }

            let bytes = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => continue,
            };
            let message_bytes = emlx_message_bytes(&bytes);
            if contains_bytes(&message_bytes, needle) {
                return Ok(Some(message_bytes));
            }
        }
    }

    Ok(None)
}

fn emlx_message_bytes(bytes: &[u8]) -> Vec<u8> {
    let Some(line_end) = bytes.iter().position(|byte| *byte == b'\n') else {
        return bytes.to_vec();
    };
    let Ok(length_text) = std::str::from_utf8(&bytes[..line_end]) else {
        return bytes.to_vec();
    };
    let Ok(length) = length_text.trim().parse::<usize>() else {
        return bytes.to_vec();
    };
    let start = line_end + 1;
    let end = start.saturating_add(length).min(bytes.len());
    bytes[start..end].to_vec()
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

fn email_body_as_markdown(message: &mail_parser::Message<'_>) -> String {
    let plain_text = message
        .body_text(0)
        .map(|body| body.to_string())
        .map(|body| body.trim().to_string())
        .filter(|body| !body.is_empty())
        .filter(|body| !is_html_only_mail_placeholder(body));
    if let Some(plain_text) = plain_text {
        return plain_text;
    }

    message
        .body_html(0)
        .map(|html| html_to_markdown(html.as_ref()))
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn is_html_only_mail_placeholder(body: &str) -> bool {
    body.trim()
        .trim_end_matches('.')
        .eq_ignore_ascii_case("This mail can only be viewed in HTML")
}

fn html_to_markdown(html: &str) -> String {
    let mut markdown = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut tag = String::new();
    let mut link_stack: Vec<String> = Vec::new();

    for character in html.chars() {
        match character {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' if in_tag => {
                in_tag = false;
                apply_html_tag_as_markdown(&mut markdown, &tag, &mut link_stack);
            }
            _ if in_tag => tag.push(character),
            '\r' | '\n' => markdown.push(' '),
            _ => markdown.push(character),
        }
    }

    normalize_markdown(&decode_basic_html_entities(&markdown))
}

fn apply_html_tag_as_markdown(markdown: &mut String, tag: &str, link_stack: &mut Vec<String>) {
    let trimmed = tag.trim();
    if trimmed.starts_with("!") {
        return;
    }

    let is_closing = trimmed.starts_with('/');
    let normalized = trimmed.trim_start_matches('/').trim();
    let tag_name = normalized
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .trim_end_matches('/')
        .to_ascii_lowercase();

    match (is_closing, tag_name.as_str()) {
        (false, "br") => push_hard_line_break(markdown),
        (false, "p" | "div" | "section" | "article" | "tr") => push_line_break(markdown),
        (true, "p" | "div" | "section" | "article" | "tr") => push_blank_line(markdown),
        (false, "h1") => push_heading(markdown, 1),
        (false, "h2") => push_heading(markdown, 2),
        (false, "h3") => push_heading(markdown, 3),
        (false, "h4") => push_heading(markdown, 4),
        (false, "h5") => push_heading(markdown, 5),
        (false, "h6") => push_heading(markdown, 6),
        (true, "h1" | "h2" | "h3" | "h4" | "h5" | "h6") => push_blank_line(markdown),
        (false, "strong" | "b") | (true, "strong" | "b") => markdown.push_str("**"),
        (false, "em" | "i") | (true, "em" | "i") => markdown.push('*'),
        (false, "ul" | "ol") | (true, "ul" | "ol") => push_blank_line(markdown),
        (false, "li") => {
            push_line_break(markdown);
            markdown.push_str("- ");
        }
        (true, "li") => push_line_break(markdown),
        (false, "blockquote") => {
            push_blank_line(markdown);
            markdown.push_str("> ");
        }
        (true, "blockquote") => push_blank_line(markdown),
        (false, "a") => {
            link_stack.push(html_attribute(normalized, "href").unwrap_or_default());
            markdown.push('[');
        }
        (true, "a") => {
            let href = link_stack.pop().unwrap_or_default();
            if href.trim().is_empty() {
                markdown.push(']');
            } else {
                markdown.push_str("](");
                markdown.push_str(href.trim());
                markdown.push(')');
            }
        }
        _ => markdown.push(' '),
    }
}

fn push_heading(markdown: &mut String, level: usize) {
    push_blank_line(markdown);
    markdown.push_str(&"#".repeat(level));
    markdown.push(' ');
}

fn push_hard_line_break(markdown: &mut String) {
    let trimmed_len = markdown.trim_end_matches([' ', '\t']).len();
    markdown.truncate(trimmed_len);
    if markdown.ends_with("  \n") {
        let new_len = markdown.len() - 3;
        markdown.truncate(new_len);
        push_blank_line(markdown);
        return;
    }
    if !markdown.ends_with('\n') {
        markdown.push_str("  \n");
    } else {
        push_blank_line(markdown);
    }
}

fn push_line_break(markdown: &mut String) {
    let trimmed_len = markdown.trim_end_matches([' ', '\t']).len();
    markdown.truncate(trimmed_len);
    if !markdown.ends_with('\n') {
        markdown.push('\n');
    }
}

fn push_blank_line(markdown: &mut String) {
    let trimmed_len = markdown.trim_end_matches([' ', '\t']).len();
    markdown.truncate(trimmed_len);
    let trailing_newlines = markdown
        .chars()
        .rev()
        .take_while(|character| *character == '\n')
        .count();
    if trailing_newlines < 2 {
        markdown.push_str(&"\n".repeat(2 - trailing_newlines));
    }
}

fn html_attribute(tag: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=");
    let start = tag.find(&needle)? + needle.len();
    let rest = &tag[start..];
    let mut chars = rest.chars();
    let quote = chars.next()?;

    if quote == '"' || quote == '\'' {
        let value = chars.as_str();
        let end = value.find(quote).unwrap_or(value.len());
        return Some(decode_basic_html_entities(&value[..end]));
    }

    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    Some(decode_basic_html_entities(&rest[..end]))
}

fn normalize_markdown(input: &str) -> String {
    let mut lines: Vec<String> = Vec::new();

    for raw_line in input.lines() {
        let without_tabs = raw_line.trim_end_matches('\t');
        let has_hard_break = without_tabs.ends_with("  ");
        let content = if has_hard_break {
            format!("{}  ", without_tabs.trim_end().trim_start())
        } else {
            without_tabs.trim().to_string()
        };

        if content.is_empty() {
            if !lines.is_empty() && lines.last().is_some_and(|line| !line.is_empty()) {
                lines.push(String::new());
            }
            continue;
        }

        lines.push(content);
    }

    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    if let Some(last_line) = lines.last_mut() {
        if last_line.ends_with("  ") {
            last_line.truncate(last_line.len() - 2);
        }
    }

    separate_long_form_fields(lines).join("\n")
}

fn separate_long_form_fields(lines: Vec<String>) -> Vec<String> {
    let mut output: Vec<String> = Vec::with_capacity(lines.len());

    for line in lines {
        if is_long_form_field_line(&line)
            && output
                .last()
                .is_some_and(|previous| is_form_field_line(previous))
        {
            output.push(String::new());
        }
        output.push(line);
    }

    output
}

fn is_form_field_line(line: &str) -> bool {
    let trimmed = line.trim_end();
    trimmed.starts_with("**") && trimmed.contains("**:")
}

fn is_long_form_field_line(line: &str) -> bool {
    let trimmed = line.trim_end_matches(' ').trim();
    is_form_field_line(trimmed) && trimmed.chars().count() > 120
}

fn decode_basic_html_entities(input: &str) -> String {
    input
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

fn ensure_ocr_model(
    app_handle: &tauri::AppHandle,
    url: &str,
    filename: &str,
) -> Result<PathBuf, String> {
    let models_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?
        .join("ocrs");
    fs::create_dir_all(&models_dir)
        .map_err(|error| format!("Could not create OCR model cache: {error}"))?;
    let model_path = models_dir.join(filename);
    if model_path.exists() {
        return Ok(model_path);
    }

    let bytes = reqwest::blocking::get(url)
        .map_err(|error| format!("Could not download OCR model: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Could not download OCR model: {error}"))?
        .bytes()
        .map_err(|error| format!("Could not read OCR model download: {error}"))?;
    fs::write(&model_path, bytes).map_err(|error| format!("Could not cache OCR model: {error}"))?;
    Ok(model_path)
}

fn load_ocr_model(
    app_handle: &tauri::AppHandle,
    url: &str,
    filename: &str,
) -> Result<rten::Model, String> {
    let model_path = ensure_ocr_model(app_handle, url, filename)?;
    rten::Model::load_file(&model_path)
        .map_err(|error| format!("Could not load OCR model {}: {error}", model_path.display()))
}

fn image_to_tensor(image: image::DynamicImage) -> rten_tensor::NdTensor<u8, 3> {
    let image = image.into_rgb8();
    let (width, height) = image.dimensions();
    rten_tensor::NdTensor::from_data([height as usize, width as usize, 3], image.into_vec())
}

#[cfg(target_os = "macos")]
fn preferred_ocr_backends() -> &'static [OcrBackend] {
    &[OcrBackend::MacosVision, OcrBackend::Ocrs]
}

#[cfg(not(target_os = "macos"))]
fn preferred_ocr_backends() -> &'static [OcrBackend] {
    &[OcrBackend::Ocrs]
}

fn build_ocr_engine(app_handle: &tauri::AppHandle) -> Result<ocrs::OcrEngine, String> {
    use ocrs::{DecodeMethod, OcrEngine, OcrEngineParams};

    let detection_model =
        load_ocr_model(app_handle, OCR_DETECTION_MODEL_URL, "text-detection.rten")?;
    let recognition_model = load_ocr_model(
        app_handle,
        OCR_RECOGNITION_MODEL_URL,
        "text-recognition.rten",
    )?;

    OcrEngine::new(OcrEngineParams {
        detection_model: Some(detection_model),
        recognition_model: Some(recognition_model),
        decode_method: DecodeMethod::Greedy,
        ..Default::default()
    })
    .map_err(|error| format!("Could not initialize OCR engine: {error}"))
}

fn ensure_cached_ocr_engine(
    app_handle: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
) -> Result<(), String> {
    let mut cached_engine = state
        .ocr_engine
        .lock()
        .map_err(|error| format!("Could not lock OCR engine cache: {error}"))?;
    if cached_engine.is_none() {
        *cached_engine = Some(build_ocr_engine(app_handle)?);
    }

    Ok(())
}

fn ocr_image_file_in_app(
    app_handle: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    path: String,
    mime_type: Option<String>,
) -> Result<OcrImageResult, String> {
    let image_path = validate_ocr_image_path(&path, mime_type.as_deref())?;
    let bytes =
        fs::read(&image_path).map_err(|error| format!("Could not read image for OCR: {error}"))?;
    run_ocr_image_bytes(app_handle, state, &bytes)
}

fn ocr_image_bytes_in_app(
    app_handle: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    bytes: Vec<u8>,
    name: Option<String>,
    mime_type: Option<String>,
) -> Result<OcrImageResult, String> {
    validate_ocr_image_name(name.as_deref().unwrap_or(""), mime_type.as_deref())?;
    run_ocr_image_bytes(app_handle, state, &bytes)
}

fn run_ocr_image_bytes(
    app_handle: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    bytes: &[u8],
) -> Result<OcrImageResult, String> {
    let mut last_error = None;

    for backend in preferred_ocr_backends() {
        let result = match backend {
            OcrBackend::MacosVision => macos_vision_ocr_image_bytes(bytes),
            OcrBackend::Ocrs => ocr_image_bytes_with_ocrs(app_handle, state, bytes),
        };

        match result {
            Ok(result) => return Ok(result),
            Err(error) => last_error = Some(error),
        }
    }

    Err(last_error.unwrap_or_else(|| "No OCR backend is available.".to_string()))
}

#[cfg(target_os = "macos")]
fn macos_vision_ocr_image_bytes(bytes: &[u8]) -> Result<OcrImageResult, String> {
    use objc2::{runtime::AnyObject, AnyThread};
    use objc2_foundation::{ns_string, NSArray, NSData, NSDictionary, NSString};
    use objc2_vision::{
        VNImageOption, VNImageRequestHandler, VNRecognizeTextRequest, VNRequest,
        VNRequestTextRecognitionLevel,
    };

    let image_data = NSData::with_bytes(bytes);
    let request = VNRecognizeTextRequest::new();
    let languages = NSArray::from_slice(&[ns_string!("de-DE"), ns_string!("en-US")]);
    request.setRecognitionLanguages(&languages);
    request.setUsesLanguageCorrection(true);
    request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);

    let options = NSDictionary::<VNImageOption, AnyObject>::new();
    let handler = VNImageRequestHandler::initWithData_options(
        VNImageRequestHandler::alloc(),
        &image_data,
        &options,
    );
    let request_ref: &VNRequest = request.as_ref();
    let requests = NSArray::from_slice(&[request_ref]);
    handler
        .performRequests_error(&requests)
        .map_err(|error| format!("Could not run Apple Vision OCR: {error}"))?;

    let Some(results) = request.results() else {
        return Ok(OcrImageResult {
            text: String::new(),
        });
    };

    let mut lines = Vec::new();
    for observation in results.iter() {
        let candidates = observation.topCandidates(1);
        let Some(candidate) = candidates.firstObject() else {
            continue;
        };
        let string: objc2::rc::Retained<NSString> = candidate.string();
        let line = string.to_string();
        if !line.trim().is_empty() {
            lines.push(line);
        }
    }

    Ok(OcrImageResult {
        text: lines.join("\n"),
    })
}

#[cfg(not(target_os = "macos"))]
fn macos_vision_ocr_image_bytes(_bytes: &[u8]) -> Result<OcrImageResult, String> {
    Err("Apple Vision OCR is only available on macOS.".to_string())
}

fn ocr_image_bytes_with_ocrs(
    app_handle: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    bytes: &[u8],
) -> Result<OcrImageResult, String> {
    let image = image::load_from_memory(bytes)
        .map_err(|error| format!("Could not decode image for OCR: {error}"))?;
    ocr_dynamic_image_in_app(app_handle, state, image)
}

fn ocr_dynamic_image_in_app(
    app_handle: &tauri::AppHandle,
    state: &tauri::State<'_, AppState>,
    image: image::DynamicImage,
) -> Result<OcrImageResult, String> {
    use ocrs::{DimOrder, ImageSource};
    use rten_tensor::prelude::*;

    ensure_cached_ocr_engine(app_handle, state)?;

    let image = image_to_tensor(image);
    let cached_engine = state
        .ocr_engine
        .lock()
        .map_err(|error| format!("Could not lock OCR engine cache: {error}"))?;
    let engine = cached_engine
        .as_ref()
        .ok_or_else(|| "OCR engine was not initialized.".to_string())?;
    let image_source = ImageSource::from_tensor(image.view(), DimOrder::Hwc)
        .map_err(|error| format!("Could not prepare image for OCR: {error}"))?;
    let input = engine
        .prepare_input(image_source)
        .map_err(|error| format!("Could not prepare OCR input: {error}"))?;
    let word_rects = engine
        .detect_words(&input)
        .map_err(|error| format!("Could not detect text in image: {error}"))?;
    let line_rects = engine.find_text_lines(&input, &word_rects);
    let line_texts = engine
        .recognize_text(&input, &line_rects)
        .map_err(|error| format!("Could not recognize text in image: {error}"))?;
    let text = line_texts
        .iter()
        .flatten()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n");

    Ok(OcrImageResult { text })
}

fn save_connection_in_db(
    db: &SqliteConnection,
    input: ConnectionInput,
) -> rusqlite::Result<ConnectionRecord> {
    let timestamp = now_millis();
    let id = input.id.unwrap_or_else(|| new_id("connection"));
    let provider = input.provider.trim().to_string();
    let name = input.name.trim().to_string();
    let token = input.token.trim().to_string();
    let api_key = input.api_key.map(|value| value.trim().to_string());
    let base_url = if provider == "trello" {
        "https://api.trello.com".to_string()
    } else {
        normalize_base_url(&input.base_url)
    };
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM connections WHERE id = ?1)",
        params![id],
        |row| row.get(0),
    )?;

    if exists {
        db.execute(
            "UPDATE connections SET provider = ?1, name = ?2, base_url = ?3, api_key = ?4, token = ?5, updated_at = ?6 WHERE id = ?7",
            params![
                provider,
                name,
                base_url,
                api_key,
                token,
                timestamp,
                id
            ],
        )?;
    } else {
        db.execute(
            "INSERT INTO connections (id, provider, name, base_url, api_key, token, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                id,
                provider,
                name,
                base_url,
                api_key,
                token,
                timestamp,
                timestamp
            ],
        )?;
    }

    db.query_row(
        "SELECT id, provider, name, base_url, api_key, token, created_at, updated_at FROM connections WHERE id = ?1",
        params![id],
        row_to_connection,
    )
}

fn list_ai_prompts_in_db(db: &SqliteConnection) -> Result<Vec<AiPromptRecord>, String> {
    let mut statement = db
        .prepare(
            "SELECT id, name, icon, agent_type, prompt_text, created_at, updated_at
             FROM ai_prompts ORDER BY name COLLATE NOCASE ASC, id ASC",
        )
        .map_err(db_error)?;
    let prompts = statement
        .query_map([], row_to_ai_prompt)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(prompts)
}

fn get_ai_prompt_in_db(db: &SqliteConnection, id: &str) -> Result<Option<AiPromptRecord>, String> {
    db.query_row(
        "SELECT id, name, icon, agent_type, prompt_text, created_at, updated_at FROM ai_prompts WHERE id = ?1",
        params![id],
        row_to_ai_prompt,
    )
    .optional()
    .map_err(db_error)
}

fn save_ai_prompt_in_db(
    db: &SqliteConnection,
    input: AiPromptInput,
) -> Result<AiPromptRecord, String> {
    let agent_type = input.agent_type.trim().to_string();
    if !matches!(agent_type.as_str(), "codex" | "claude") {
        return Err("AI Prompt agent must be Codex or Claude.".to_string());
    }
    let icon = input.icon.trim().to_string();
    if !matches!(
        icon.as_str(),
        "target"
            | "clock"
            | "hammer"
            | "review"
            | "testing"
            | "bug"
            | "planning"
            | "documentation"
            | "research"
            | "sparkles"
    ) {
        return Err("AI Prompt icon is not supported.".to_string());
    }

    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("AI Prompt name is required.".to_string());
    }
    let prompt_text = input.prompt_text.trim().to_string();

    let id = input.id.unwrap_or_else(|| new_id("ai_prompt"));
    let duplicate_exists: bool = db
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM ai_prompts
                WHERE name = ?1 COLLATE NOCASE AND id != ?2
             )",
            params![name, id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if duplicate_exists {
        return Err("An AI Prompt with this name already exists.".to_string());
    }

    let timestamp = now_millis();
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM ai_prompts WHERE id = ?1)",
            params![id],
            |row| row.get(0),
        )
        .map_err(db_error)?;

    if exists {
        db.execute(
            "UPDATE ai_prompts SET name = ?1, icon = ?2, agent_type = ?3, prompt_text = ?4, updated_at = ?5 WHERE id = ?6",
            params![name, icon, agent_type, prompt_text, timestamp, id],
        )
        .map_err(db_error)?;
    } else {
        db.execute(
            "INSERT INTO ai_prompts (id, name, icon, agent_type, prompt_text, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, name, icon, agent_type, prompt_text, timestamp, timestamp],
        )
        .map_err(db_error)?;
    }

    db.query_row(
        "SELECT id, name, icon, agent_type, prompt_text, created_at, updated_at FROM ai_prompts WHERE id = ?1",
        params![id],
        row_to_ai_prompt,
    )
    .map_err(db_error)
}

fn delete_ai_prompt_in_db(db: &SqliteConnection, id: &str) -> Result<(), String> {
    db.execute("DELETE FROM ai_prompts WHERE id = ?1", params![id])
        .map_err(db_error)?;
    Ok(())
}

fn ai_prompt_with_task_context(prompt_text: &str, task: &Task) -> String {
    let title = task.title.trim();
    let body = task.body.trim();
    let body_duplicates_title = title.split_whitespace().eq(body.split_whitespace());

    let mut context = vec![
        prompt_text,
        task.source_url.as_deref().unwrap_or_default(),
        title,
    ];
    if !body_duplicates_title {
        context.push(body);
    }

    context
        .into_iter()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn ai_prompt_deep_link(agent_type: &str, prompt: &str, path: &str) -> Result<String, String> {
    let base_url = match agent_type {
        "codex" => "codex://threads/new",
        "claude" => "claude://code/new",
        _ => return Err("Unsupported AI Agent type.".to_string()),
    };
    let mut url = reqwest::Url::parse(base_url).map_err(db_error)?;
    {
        let mut query = url.query_pairs_mut();
        match agent_type {
            "codex" => {
                query.append_pair("prompt", prompt);
                query.append_pair("path", path);
            }
            "claude" => {
                query.append_pair("q", prompt);
                query.append_pair("folder", path);
            }
            _ => unreachable!(),
        }
    }
    Ok(url.to_string())
}

fn prepare_ai_prompt_thread_in_db(
    db: &SqliteConnection,
    input: &OpenAiPromptThreadInput,
) -> Result<String, String> {
    let prompt = get_ai_prompt_in_db(db, &input.ai_prompt_id)?
        .ok_or_else(|| "AI Prompt not found.".to_string())?;
    let task = get_task(db, &input.task_id)
        .map_err(db_error)?
        .ok_or_else(|| "Task not found.".to_string())?;

    let trimmed_path = input.path.trim();
    if trimmed_path.is_empty() {
        return Err("Repository or directory is required.".to_string());
    }
    let canonical_path = fs::canonicalize(trimmed_path)
        .map_err(|_| "The selected repository or directory no longer exists.".to_string())?;
    if !canonical_path.is_dir() {
        return Err("The selected workspace must be a directory.".to_string());
    }
    let canonical_path = canonical_path.to_string_lossy().to_string();
    let path_is_available: bool = db
        .query_row(
            "SELECT
                EXISTS(SELECT 1 FROM directories WHERE path = ?1)
                OR EXISTS(
                    SELECT 1 FROM local_resources
                    WHERE path = ?1 AND project_id = ?2
                )",
            params![canonical_path, task.project_id],
            |row| row.get(0),
        )
        .map_err(db_error)?;
    if !path_is_available {
        return Err("The selected workspace is not configured for this task.".to_string());
    }

    ai_prompt_deep_link(
        &prompt.agent_type,
        &ai_prompt_with_task_context(&prompt.prompt_text, &task),
        &canonical_path,
    )
}

fn directory_name_from_path(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn save_directory_in_db(
    db: &SqliteConnection,
    input: DirectoryInput,
) -> Result<DirectoryRecord, String> {
    let trimmed_path = input.path.trim();
    if trimmed_path.is_empty() {
        return Err("Directory path is required.".to_string());
    }

    let path = PathBuf::from(trimmed_path);
    if !path.exists() {
        return Err("Directory does not exist.".to_string());
    }
    if !path.is_dir() {
        return Err("Path must be a directory.".to_string());
    }

    let path = fs::canonicalize(&path)
        .map_err(|error| format!("Could not resolve directory path: {error}"))?;
    let path_string = path.to_string_lossy().to_string();
    let name = directory_name_from_path(&path);
    let timestamp = now_millis();
    let existing_id = db
        .query_row(
            "SELECT id FROM directories WHERE path = ?1",
            params![&path_string],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    let id = existing_id.unwrap_or_else(|| new_id("directory"));

    let row_exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM directories WHERE id = ?1)",
            params![&id],
            |row| row.get(0),
        )
        .map_err(db_error)?;

    if row_exists {
        db.execute(
            "UPDATE directories SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, timestamp, id],
        )
        .map_err(db_error)?;
    } else {
        db.execute(
            "INSERT INTO directories (id, path, name, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, path_string, name, timestamp, timestamp],
        )
        .map_err(db_error)?;
    }

    db.query_row(
        "SELECT id, path, name, created_at, updated_at FROM directories WHERE id = ?1",
        params![id],
        row_to_directory,
    )
    .map_err(db_error)
}

fn list_recent_directory_files_in_db(
    db: &SqliteConnection,
    limit: usize,
) -> Result<Vec<RecentDirectoryFile>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }

    let mut statement = db
        .prepare("SELECT id, path, name, created_at, updated_at FROM directories")
        .map_err(db_error)?;
    let directories = statement
        .query_map([], row_to_directory)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;

    let mut files = Vec::new();
    for directory in directories {
        collect_recent_directory_files(&directory, &mut files);
    }

    files.sort_by(|left, right| {
        right
            .modified_at
            .cmp(&left.modified_at)
            .then_with(|| left.name.cmp(&right.name))
    });
    files.truncate(limit);
    Ok(files)
}

fn collect_recent_directory_files(
    directory: &DirectoryRecord,
    files: &mut Vec<RecentDirectoryFile>,
) {
    let root = PathBuf::from(&directory.path);
    if !root.is_dir() {
        return;
    }

    let mut stack = vec![root.clone()];
    while let Some(path) = stack.pop() {
        let Ok(entries) = fs::read_dir(&path) else {
            continue;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if is_hidden_path_entry(&path) {
                continue;
            }

            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if file_type.is_dir() {
                stack.push(path);
                continue;
            }

            if !file_type.is_file() {
                continue;
            }

            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            let modified_at = metadata
                .modified()
                .ok()
                .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or_default();
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .filter(|name| !name.is_empty())
                .map(ToString::to_string)
                .unwrap_or_else(|| path.to_string_lossy().to_string());
            let relative_path = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string();

            files.push(RecentDirectoryFile {
                path: path.to_string_lossy().to_string(),
                name,
                directory_id: directory.id.clone(),
                directory_name: directory.name.clone(),
                relative_path,
                modified_at,
            });
        }
    }
}

fn is_hidden_path_entry(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with('.'))
}

fn get_connection(db: &SqliteConnection, id: &str) -> rusqlite::Result<Option<ConnectionRecord>> {
    db.query_row(
        "SELECT id, provider, name, base_url, api_key, token, created_at, updated_at FROM connections WHERE id = ?1",
        params![id],
        row_to_connection,
    )
    .optional()
}

fn list_connections_in_db(db: &SqliteConnection) -> rusqlite::Result<Vec<ConnectionRecord>> {
    let mut statement = db.prepare(
        "SELECT id, provider, name, base_url, api_key, token, created_at, updated_at
         FROM connections ORDER BY provider ASC, name ASC",
    )?;
    let connections = statement
        .query_map([], row_to_connection)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(connections)
}

fn deterministic_activity_id(provider: &str, connection_id: &str, external_id: &str) -> String {
    format!("{provider}:{connection_id}:{external_id}")
}

fn list_activities_in_db(
    db: &SqliteConnection,
    date: &str,
    start_at: i64,
    end_at: i64,
) -> Result<ActivityResult, String> {
    let mut activity_statement = db
        .prepare(
            "SELECT a.id, a.provider, a.connection_id, c.name, a.external_id, a.event_type,
                    a.action_label, a.actor, a.title, a.target_url, a.occurred_at, a.fetched_at, a.raw_json,
                    a.subject_json
             FROM activities a
             LEFT JOIN connections c ON c.id = a.connection_id
             WHERE a.occurred_at >= ?1 AND a.occurred_at < ?2
             ORDER BY a.occurred_at DESC, a.id DESC",
        )
        .map_err(db_error)?;
    let activities = activity_statement
        .query_map(params![start_at, end_at], row_to_activity)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;

    let mut sync_statement = db
        .prepare(
            "SELECT r.connection_id, c.name, c.provider, r.date, r.status, r.warning, r.synced_at
             FROM activity_sync_runs r
             LEFT JOIN connections c ON c.id = r.connection_id
             WHERE r.date = ?1
             ORDER BY c.provider ASC, c.name ASC",
        )
        .map_err(db_error)?;
    let sync_runs = sync_statement
        .query_map(params![date], row_to_activity_sync_run)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;

    Ok(ActivityResult {
        activities,
        sync_runs,
    })
}

fn upsert_activity_in_db(
    db: &SqliteConnection,
    activity: &ActivityInput,
    fetched_at: i64,
) -> rusqlite::Result<()> {
    let id = deterministic_activity_id(
        &activity.provider,
        &activity.connection_id,
        &activity.external_id,
    );
    db.execute(
        "INSERT INTO activities (
            id, provider, connection_id, external_id, event_type, action_label, actor,
            title, target_url, occurred_at, fetched_at, raw_json, subject_json
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(id) DO UPDATE SET
            event_type = excluded.event_type,
            action_label = excluded.action_label,
            actor = excluded.actor,
            title = excluded.title,
            target_url = excluded.target_url,
            occurred_at = excluded.occurred_at,
            fetched_at = excluded.fetched_at,
            raw_json = excluded.raw_json,
            subject_json = excluded.subject_json",
        params![
            id,
            &activity.provider,
            &activity.connection_id,
            &activity.external_id,
            &activity.event_type,
            &activity.action_label,
            &activity.actor,
            &activity.title,
            &activity.target_url,
            activity.occurred_at,
            fetched_at,
            &activity.raw_json,
            &activity.subject_json,
        ],
    )?;
    Ok(())
}

fn save_activity_sync_run_in_db(
    db: &SqliteConnection,
    connection_id: &str,
    date: &str,
    status: &str,
    warning: Option<&str>,
    synced_at: i64,
) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO activity_sync_runs (connection_id, date, status, warning, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(connection_id, date) DO UPDATE SET
            status = excluded.status,
            warning = excluded.warning,
            synced_at = excluded.synced_at",
        params![connection_id, date, status, warning, synced_at],
    )?;
    Ok(())
}

fn replace_gitlab_activity_sync_in_db(
    db: &mut SqliteConnection,
    connection_id: &str,
    date: &str,
    start_at: i64,
    end_at: i64,
    activities: &[ActivityInput],
    fetched_at: i64,
) -> rusqlite::Result<()> {
    let transaction = db.transaction()?;
    transaction.execute(
        "DELETE FROM activities
         WHERE provider = 'gitlab' AND connection_id = ?1
           AND occurred_at >= ?2 AND occurred_at < ?3",
        params![connection_id, start_at, end_at],
    )?;
    for activity in activities {
        upsert_activity_in_db(&transaction, activity, fetched_at)?;
    }
    save_activity_sync_run_in_db(
        &transaction,
        connection_id,
        date,
        "success",
        None,
        fetched_at,
    )?;
    transaction.commit()
}

fn smart_inbox_todo_title(input: &SmartInboxTodoInput) -> String {
    let title = input.title.as_deref().unwrap_or("").trim();
    if !title.is_empty() {
        return title.to_string();
    }

    if input.kind == "file" {
        if let Some(file_name) = input
            .file_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return file_name.to_string();
        }
        if let Some(file_path) = input
            .file_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return directory_name_from_path(Path::new(file_path));
        }
        return "File".to_string();
    }

    let raw_text = input.raw_text.as_deref().unwrap_or("");
    let title = first_non_empty_line(raw_text);
    if title.is_empty() {
        "Untitled todo".to_string()
    } else {
        title
    }
}

fn create_smart_inbox_todo_in_db(
    db: &SqliteConnection,
    input: SmartInboxTodoInput,
) -> Result<SmartInboxTodo, String> {
    if input.kind != "text" && input.kind != "file" {
        return Err("Unsupported smart inbox todo kind.".to_string());
    }

    let timestamp = now_millis();
    let file_path = input
        .file_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if input.kind == "file" {
        if let Some(file_path) = file_path {
            if let Some(existing) = get_smart_inbox_todo_by_file_path(db, file_path)? {
                let title = smart_inbox_todo_title(&input);
                db.execute(
                    "UPDATE smart_inbox_todos
                     SET title = ?1, file_name = ?2, mime_type = ?3, updated_at = ?4
                     WHERE id = ?5",
                    params![
                        title,
                        input.file_name.as_deref(),
                        input.mime_type.as_deref(),
                        timestamp,
                        &existing.id
                    ],
                )
                .map_err(db_error)?;
                return get_smart_inbox_todo(db, &existing.id)?
                    .map(mark_smart_inbox_todo_file_missing)
                    .ok_or_else(|| "Smart inbox todo not found".to_string());
            }
        }
    }

    let id = new_id("smart_inbox_todo");
    let title = smart_inbox_todo_title(&input);
    db.execute(
        "INSERT INTO smart_inbox_todos
            (id, kind, title, raw_text, file_path, file_name, mime_type, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            &id,
            &input.kind,
            title,
            input.raw_text.as_deref(),
            file_path,
            input.file_name.as_deref(),
            input.mime_type.as_deref(),
            timestamp,
            timestamp
        ],
    )
    .map_err(db_error)?;

    get_smart_inbox_todo(db, &id)?
        .map(mark_smart_inbox_todo_file_missing)
        .ok_or_else(|| "Smart inbox todo not found".to_string())
}

fn update_smart_inbox_todo_in_db(
    db: &SqliteConnection,
    input: SmartInboxTodoUpdateInput,
) -> Result<SmartInboxTodo, String> {
    let todo = get_smart_inbox_todo(db, &input.id)?
        .ok_or_else(|| "Smart inbox todo not found.".to_string())?;
    let timestamp = now_millis();

    match todo.kind.as_str() {
        "text" => {
            if input.title.is_some() {
                return Err("Text todos can only update rawText.".to_string());
            }
            let raw_text = input
                .raw_text
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Todo content cannot be blank.".to_string())?;
            let title = first_non_empty_line(raw_text);
            db.execute(
                "UPDATE smart_inbox_todos
                 SET title = ?1, raw_text = ?2, updated_at = ?3
                 WHERE id = ?4",
                params![title, raw_text, timestamp, &input.id],
            )
            .map_err(db_error)?;
        }
        "file" => {
            if input.raw_text.is_some() {
                return Err("File todos can only update title.".to_string());
            }
            let title = input
                .title
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| "Todo title cannot be blank.".to_string())?;
            db.execute(
                "UPDATE smart_inbox_todos SET title = ?1, updated_at = ?2 WHERE id = ?3",
                params![title, timestamp, &input.id],
            )
            .map_err(db_error)?;
        }
        _ => return Err("Unsupported smart inbox todo kind.".to_string()),
    }

    get_smart_inbox_todo(db, &input.id)?
        .map(mark_smart_inbox_todo_file_missing)
        .ok_or_else(|| "Smart inbox todo not found.".to_string())
}

fn mark_smart_inbox_todo_file_missing(mut todo: SmartInboxTodo) -> SmartInboxTodo {
    todo.file_missing = smart_inbox_todo_file_missing(&todo);
    todo
}

fn smart_inbox_todo_file_missing(todo: &SmartInboxTodo) -> bool {
    if todo.kind != "file" {
        return false;
    }

    let Some(file_path) = todo
        .file_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return true;
    };

    if file_path.starts_with("message:") {
        return false;
    }

    !Path::new(file_path).is_file()
}

fn get_smart_inbox_todo(db: &SqliteConnection, id: &str) -> Result<Option<SmartInboxTodo>, String> {
    db.query_row(
        "SELECT id, kind, title, raw_text, file_path, file_name, mime_type, created_at, updated_at
         FROM smart_inbox_todos WHERE id = ?1",
        params![id],
        row_to_smart_inbox_todo,
    )
    .optional()
    .map_err(db_error)
}

fn get_smart_inbox_todo_by_file_path(
    db: &SqliteConnection,
    file_path: &str,
) -> Result<Option<SmartInboxTodo>, String> {
    db.query_row(
        "SELECT id, kind, title, raw_text, file_path, file_name, mime_type, created_at, updated_at
         FROM smart_inbox_todos
         WHERE kind = 'file' AND file_path = ?1
         ORDER BY updated_at DESC, created_at DESC, rowid DESC
         LIMIT 1",
        params![file_path],
        row_to_smart_inbox_todo,
    )
    .optional()
    .map_err(db_error)
}

fn list_smart_inbox_todos_in_db(db: &SqliteConnection) -> Result<Vec<SmartInboxTodo>, String> {
    let mut statement = db
        .prepare(
            "SELECT id, kind, title, raw_text, file_path, file_name, mime_type, created_at, updated_at
             FROM smart_inbox_todos ORDER BY updated_at DESC, created_at DESC",
        )
        .map_err(db_error)?;
    let todos = statement
        .query_map([], row_to_smart_inbox_todo)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(todos
        .into_iter()
        .map(mark_smart_inbox_todo_file_missing)
        .collect())
}

fn delete_smart_inbox_todo_in_db(db: &SqliteConnection, id: &str) -> Result<(), String> {
    db.execute("DELETE FROM smart_inbox_todos WHERE id = ?1", params![id])
        .map_err(db_error)?;
    Ok(())
}

fn create_task_in_db(
    db: &SqliteConnection,
    project_id: Option<String>,
    title: String,
    body: String,
    source_url: Option<String>,
) -> rusqlite::Result<Task> {
    let id = new_id("task");
    let timestamp = now_millis();
    db.execute(
        "INSERT INTO tasks (id, project_id, title, body, status, source_url, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?6, ?7)",
        params![id, project_id, title, body, source_url, timestamp, timestamp],
    )?;

    get_task(db, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

fn get_task(db: &SqliteConnection, id: &str) -> rusqlite::Result<Option<Task>> {
    db.query_row(
        "SELECT t.id, t.project_id, t.title, t.body, t.status, t.source_url, t.created_at, t.updated_at,
                l.provider, l.kind, l.external_state_color
         FROM tasks t
         LEFT JOIN task_links l ON l.task_id = t.id
         WHERE t.id = ?1",
        params![id],
        row_to_task_with_source,
    )
    .optional()
}

fn get_task_by_source_url(
    db: &SqliteConnection,
    source_url: &str,
) -> rusqlite::Result<Option<Task>> {
    db.query_row(
        "SELECT t.id, t.project_id, t.title, t.body, t.status, t.source_url, t.created_at, t.updated_at,
                l.provider, l.kind, l.external_state_color
         FROM tasks t
         LEFT JOIN task_links l ON l.task_id = t.id
         WHERE t.source_url = ?1 LIMIT 1",
        params![source_url],
        row_to_task_with_source,
    )
    .optional()
}

fn get_task_by_link(
    db: &SqliteConnection,
    provider: &str,
    kind: &str,
    external_id: &str,
) -> rusqlite::Result<Option<Task>> {
    db.query_row(
        "SELECT t.id, t.project_id, t.title, t.body, t.status, t.source_url, t.created_at, t.updated_at,
                l.provider, l.kind, l.external_state_color
         FROM tasks t
         INNER JOIN task_links l ON l.task_id = t.id
         WHERE l.provider = ?1 AND l.kind = ?2 AND l.external_id = ?3
         LIMIT 1",
        params![provider, kind, external_id],
        row_to_task_with_source,
    )
    .optional()
}

fn get_latest_project_task_by_link(
    db: &SqliteConnection,
    provider: &str,
    kind: &str,
    external_id: &str,
) -> rusqlite::Result<Option<Task>> {
    db.query_row(
        "SELECT t.id, t.project_id, t.title, t.body, t.status, t.source_url, t.created_at, t.updated_at,
                l.provider, l.kind, l.external_state_color
         FROM tasks t
         INNER JOIN task_links l ON l.task_id = t.id
         WHERE l.provider = ?1 AND l.kind = ?2 AND l.external_id = ?3
           AND t.project_id IS NOT NULL
         ORDER BY t.updated_at DESC, t.id ASC
         LIMIT 1",
        params![provider, kind, external_id],
        row_to_task_with_source,
    )
    .optional()
}

fn delete_task_in_db(db: &SqliteConnection, id: &str) -> Result<(), String> {
    let deleted = db
        .execute("DELETE FROM tasks WHERE id = ?1", params![id])
        .map_err(db_error)?;
    if deleted == 0 {
        return Err("Task not found".to_string());
    }

    Ok(())
}

fn validate_relation_type(relation_type: &str) -> Result<(), String> {
    match relation_type {
        "related" | "sub_task" => Ok(()),
        _ => Err("Unsupported task relation type".to_string()),
    }
}

fn get_task_relation_view(
    db: &SqliteConnection,
    relation_id: &str,
    current_task_id: &str,
) -> rusqlite::Result<Option<TaskRelationView>> {
    db.query_row(
        "SELECT r.id, r.source_task_id, r.target_task_id, r.relation_type, r.created_at,
                t.id, t.project_id, t.title, t.body, t.status, t.source_url, t.created_at, t.updated_at,
                l.provider, l.kind, l.external_state_color
         FROM task_relations r
         INNER JOIN tasks t ON t.id = CASE WHEN r.source_task_id = ?2 THEN r.target_task_id ELSE r.source_task_id END
         LEFT JOIN task_links l ON l.task_id = t.id
         WHERE r.id = ?1",
        params![relation_id, current_task_id],
        row_to_task_relation_view,
    )
    .optional()
}

fn row_to_task_relation_view(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskRelationView> {
    Ok(TaskRelationView {
        id: row.get(0)?,
        source_task_id: row.get(1)?,
        target_task_id: row.get(2)?,
        relation_type: row.get(3)?,
        created_at: row.get(4)?,
        related_task: Task {
            id: row.get(5)?,
            project_id: row.get(6)?,
            title: row.get(7)?,
            body: row.get(8)?,
            status: row.get(9)?,
            source_url: row.get(10)?,
            source_provider: row.get(13)?,
            source_kind: row.get(14)?,
            status_color: row.get(15)?,
            created_at: row.get(11)?,
            updated_at: row.get(12)?,
        },
    })
}

fn save_task_relation_in_db(
    db: &SqliteConnection,
    input: TaskRelationInput,
) -> Result<TaskRelationView, String> {
    validate_relation_type(&input.relation_type)?;
    if input.source_task_id == input.target_task_id {
        return Err("A task cannot be related to itself".to_string());
    }
    get_task(db, &input.source_task_id)
        .map_err(db_error)?
        .ok_or_else(|| "Source task not found".to_string())?;
    get_task(db, &input.target_task_id)
        .map_err(db_error)?
        .ok_or_else(|| "Target task not found".to_string())?;

    if let Some(existing_id) = input.id.as_deref() {
        get_task_relation_view(db, existing_id, &input.source_task_id)
            .map_err(db_error)?
            .ok_or_else(|| "Task relation not found".to_string())?;

        let duplicate_id = db
            .query_row(
                "SELECT id FROM task_relations
                 WHERE source_task_id = ?1 AND target_task_id = ?2 AND relation_type = ?3 AND id != ?4",
                params![
                    &input.source_task_id,
                    &input.target_task_id,
                    &input.relation_type,
                    existing_id
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_error)?;

        if let Some(duplicate_id) = duplicate_id {
            db.execute(
                "DELETE FROM task_relations WHERE id = ?1",
                params![existing_id],
            )
            .map_err(db_error)?;
            return get_task_relation_view(db, &duplicate_id, &input.source_task_id)
                .map_err(db_error)?
                .ok_or_else(|| "Task relation not found".to_string());
        }

        db.execute(
            "UPDATE task_relations SET source_task_id = ?1, target_task_id = ?2, relation_type = ?3 WHERE id = ?4",
            params![
                &input.source_task_id,
                &input.target_task_id,
                &input.relation_type,
                existing_id
            ],
        )
        .map_err(db_error)?;

        return get_task_relation_view(db, existing_id, &input.source_task_id)
            .map_err(db_error)?
            .ok_or_else(|| "Task relation not found".to_string());
    }

    let id = new_id("relation");
    let timestamp = now_millis();
    db.execute(
        "INSERT OR IGNORE INTO task_relations (id, source_task_id, target_task_id, relation_type, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            id,
            &input.source_task_id,
            &input.target_task_id,
            &input.relation_type,
            timestamp
        ],
    )
    .map_err(db_error)?;

    let relation_id = db
        .query_row(
            "SELECT id FROM task_relations
             WHERE source_task_id = ?1 AND target_task_id = ?2 AND relation_type = ?3",
            params![
                &input.source_task_id,
                &input.target_task_id,
                &input.relation_type
            ],
            |row| row.get::<_, String>(0),
        )
        .map_err(db_error)?;

    get_task_relation_view(db, &relation_id, &input.source_task_id)
        .map_err(db_error)?
        .ok_or_else(|| "Task relation not found".to_string())
}

fn link_task_resource_in_db(
    db: &SqliteConnection,
    task_id: String,
    provider: String,
    kind: String,
    external_id: String,
    url: String,
    metadata: &ProviderMetadata,
) -> rusqlite::Result<()> {
    let files_json = task_files_to_json(&metadata.files);
    let comments_json = task_comments_to_json(&metadata.comments);
    let labels_json = external_labels_to_json(&metadata.labels);
    db.execute(
        "INSERT INTO task_links
            (task_id, provider, kind, external_id, url, connection_id, external_title, external_body, external_state, external_state_color, target_branch, fetched_at, files_json, comments_json, labels_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(task_id) DO UPDATE SET
            provider = excluded.provider,
            kind = excluded.kind,
            external_id = excluded.external_id,
            url = excluded.url,
            connection_id = excluded.connection_id,
            external_title = excluded.external_title,
            external_body = excluded.external_body,
            external_state = excluded.external_state,
            external_state_color = excluded.external_state_color,
            target_branch = excluded.target_branch,
            fetched_at = excluded.fetched_at,
            files_json = excluded.files_json,
            comments_json = excluded.comments_json,
            labels_json = excluded.labels_json",
        params![
            &task_id,
            &provider,
            &kind,
            &external_id,
            &url,
            &metadata.connection_id,
            &metadata.title,
            &metadata.body,
            &metadata.state,
            &metadata.state_color,
            &metadata.target_branch,
            &metadata.fetched_at,
            &files_json,
            &comments_json,
            &labels_json
        ],
    )?;
    db.execute(
        "UPDATE tasks SET source_url = ?1, updated_at = ?2 WHERE id = ?3",
        params![&url, now_millis(), &task_id],
    )?;
    Ok(())
}

fn list_task_links_in_db(db: &SqliteConnection, task_id: &str) -> rusqlite::Result<Vec<TaskLink>> {
    let mut statement = db.prepare(
        "SELECT task_id, provider, kind, external_id, url, connection_id, external_title, external_body, external_state, external_state_color, target_branch, fetched_at, files_json, comments_json, labels_json
         FROM task_links WHERE task_id = ?1 ORDER BY provider ASC, kind ASC",
    )?;
    let links = statement
        .query_map(params![task_id], row_to_task_link)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(links)
}

fn parsed_payload_from_task_link(task: &Task, link: &TaskLink) -> ParsedInputPayload {
    ParsedInputPayload {
        kind: link.kind.clone(),
        provider: Some(link.provider.clone()),
        external_id: Some(link.external_id.clone()),
        url: Some(link.url.clone()),
        title: task.title.clone(),
        repo_url: None,
    }
}

fn apply_provider_metadata_to_task(
    db: &SqliteConnection,
    task: &Task,
    link: &TaskLink,
    metadata: &ProviderMetadata,
) -> rusqlite::Result<Task> {
    let refreshed_url = metadata.url.clone().unwrap_or_else(|| link.url.clone());
    link_task_resource_in_db(
        db,
        task.id.clone(),
        link.provider.clone(),
        link.kind.clone(),
        link.external_id.clone(),
        refreshed_url,
        metadata,
    )?;

    let refreshed_title = metadata
        .title
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| task.title.clone());
    let refreshed_body = metadata.body.clone().unwrap_or_default();
    let refreshed_status = metadata
        .state
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| task.status.clone());
    db.execute(
        "UPDATE tasks SET title = ?1, body = ?2, status = ?3, updated_at = ?4 WHERE id = ?5",
        params![
            refreshed_title,
            refreshed_body,
            refreshed_status,
            now_millis(),
            &task.id
        ],
    )?;

    get_task(db, &task.id)?.ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)
}

fn task_link_supports_external_refresh(link: &TaskLink) -> bool {
    matches!(
        (link.provider.as_str(), link.kind.as_str()),
        ("trello", "trello_card")
            | ("github", "github_issue")
            | ("github", "pull_request")
            | ("gitlab", "gitlab_issue")
            | ("gitlab", "merge_request")
    )
}

fn provider_connection_required_notice(provider: &str) -> String {
    let label = match provider {
        "github" => "GitHub",
        "gitlab" => "GitLab",
        "trello" => "Trello",
        _ => provider,
    };
    format!("Please add a {label} connection to this project.")
}

fn provider_external_sync_failed_notice(provider: &str) -> String {
    let label = match provider {
        "github" => "GitHub",
        "gitlab" => "GitLab",
        "trello" => "Trello",
        _ => provider,
    };
    format!("Could not sync external details from {label}. Check the connection and try again.")
}

fn prepare_task_external_refresh(
    db: &SqliteConnection,
    task_id: &str,
) -> Result<TaskExternalRefreshPreparation, String> {
    let task = get_task(db, task_id)
        .map_err(db_error)?
        .ok_or_else(|| "Task not found".to_string())?;
    let links = list_task_links_in_db(db, &task.id).map_err(db_error)?;
    let Some(link) = links.first().cloned() else {
        return Ok(TaskExternalRefreshPreparation::Ready(
            RefreshTaskExternalDetailsResult {
                task,
                links,
                notice: None,
                connection_required: false,
            },
        ));
    };

    if !task_link_supports_external_refresh(&link) {
        return Ok(TaskExternalRefreshPreparation::Ready(
            RefreshTaskExternalDetailsResult {
                task,
                links,
                notice: None,
                connection_required: false,
            },
        ));
    }

    let Some(project_id) = task.project_id.as_deref() else {
        let notice = provider_connection_required_notice(&link.provider);
        return Ok(TaskExternalRefreshPreparation::Ready(
            RefreshTaskExternalDetailsResult {
                task,
                links,
                notice: Some(notice),
                connection_required: true,
            },
        ));
    };

    let parsed = parsed_payload_from_task_link(&task, &link);
    let connection = select_best_connection(db, project_id, &parsed).map_err(db_error)?;
    let Some(connection) = connection else {
        let notice = provider_connection_required_notice(&link.provider);
        return Ok(TaskExternalRefreshPreparation::Ready(
            RefreshTaskExternalDetailsResult {
                task,
                links,
                notice: Some(notice),
                connection_required: true,
            },
        ));
    };

    Ok(TaskExternalRefreshPreparation::Fetch {
        task,
        links,
        link,
        connection,
        parsed,
    })
}

fn apply_refreshed_task_external_metadata(
    db: &SqliteConnection,
    original_task: &Task,
    original_link: &TaskLink,
    metadata: &ProviderMetadata,
) -> Result<RefreshTaskExternalDetailsResult, String> {
    let Some(current_task) = get_task(db, &original_task.id).map_err(db_error)? else {
        return Ok(RefreshTaskExternalDetailsResult {
            task: original_task.clone(),
            links: Vec::new(),
            notice: Some("Task was removed before external refresh finished.".to_string()),
            connection_required: false,
        });
    };
    let current_links = list_task_links_in_db(db, &current_task.id).map_err(db_error)?;
    let Some(current_link) = current_links.iter().find(|link| {
        link.provider == original_link.provider
            && link.kind == original_link.kind
            && link.external_id == original_link.external_id
    }) else {
        return Ok(RefreshTaskExternalDetailsResult {
            task: current_task,
            links: current_links,
            notice: Some("External link changed before refresh finished.".to_string()),
            connection_required: false,
        });
    };

    let refreshed_task = apply_provider_metadata_to_task(db, &current_task, current_link, metadata)
        .map_err(db_error)?;
    Ok(RefreshTaskExternalDetailsResult {
        links: list_task_links_in_db(db, &refreshed_task.id).map_err(db_error)?,
        task: refreshed_task,
        notice: metadata.notice.clone(),
        connection_required: false,
    })
}

fn complete_task_external_refresh(
    db: &SqliteConnection,
    task: &Task,
    link: &TaskLink,
    links: Vec<TaskLink>,
    connection: ConnectionRecord,
    parsed: &ParsedInputPayload,
) -> Result<RefreshTaskExternalDetailsResult, String> {
    match fetch_provider_metadata_with_connection(&connection, parsed) {
        Ok(mut metadata) => {
            metadata.connection_id = Some(connection.id);
            metadata.fetched_at = Some(now_millis());
            let cached = link
                .comments
                .iter()
                .map(|comment| (comment.id.as_str(), comment))
                .collect::<HashMap<_, _>>();
            for comment in &mut metadata.comments {
                let needs_context = comment
                    .code_context
                    .as_ref()
                    .is_none_or(|context| context.lines.is_empty());
                if needs_context {
                    if let Some(context) = cached
                        .get(comment.id.as_str())
                        .and_then(|old| old.code_context.clone())
                    {
                        comment.code_context = Some(context);
                    }
                }
            }
            apply_refreshed_task_external_metadata(db, task, link, &metadata)
        }
        Err(_) => Ok(RefreshTaskExternalDetailsResult {
            task: task.clone(),
            links,
            notice: Some(provider_external_sync_failed_notice(&connection.provider)),
            connection_required: false,
        }),
    }
}

fn refresh_task_external_details_in_db(
    db: &SqliteConnection,
    task_id: String,
) -> Result<RefreshTaskExternalDetailsResult, String> {
    match prepare_task_external_refresh(db, &task_id)? {
        TaskExternalRefreshPreparation::Ready(result) => Ok(result),
        TaskExternalRefreshPreparation::Fetch {
            task,
            links,
            link,
            connection,
            parsed,
        } => complete_task_external_refresh(db, &task, &link, links, connection, &parsed),
    }
}

fn migrate_pull_requests_into_tasks(db: &SqliteConnection) -> rusqlite::Result<()> {
    let mut statement = db.prepare(
        "SELECT id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, connection_id, external_title, external_body, external_state, target_branch, fetched_at, created_at, updated_at
         FROM pull_requests ORDER BY created_at ASC",
    )?;
    let pull_requests = statement
        .query_map([], row_to_pull_request)?
        .collect::<Result<Vec<_>, _>>()?;

    for pull_request in pull_requests {
        let Some((kind, external_id)) = external_identity_from_pull_request(&pull_request) else {
            continue;
        };
        let task = if let Some(existing) = get_task_by_source_url(db, &pull_request.pr_url)? {
            existing
        } else {
            let body = if pull_request.review_notes.trim().is_empty() {
                pull_request.pr_url.clone()
            } else {
                pull_request.review_notes.clone()
            };
            create_task_in_db(
                db,
                Some(pull_request.project_id.clone()),
                pull_request
                    .external_title
                    .clone()
                    .unwrap_or_else(|| pull_request.title.clone()),
                body,
                Some(pull_request.pr_url.clone()),
            )?
        };

        let metadata = ProviderMetadata {
            connection_id: pull_request.connection_id.clone(),
            title: pull_request
                .external_title
                .clone()
                .or_else(|| Some(pull_request.title.clone())),
            body: pull_request.external_body.clone(),
            state: pull_request.external_state.clone(),
            state_color: None,
            target_branch: pull_request.target_branch.clone(),
            url: Some(pull_request.pr_url.clone()),
            fetched_at: pull_request.fetched_at,
            files: Vec::new(),
            comments: Vec::new(),
            labels: Vec::new(),
            parent_resource: None,
            notice: None,
        };
        link_task_resource_in_db(
            db,
            task.id.clone(),
            pull_request.provider.clone(),
            kind.clone(),
            external_id.clone(),
            pull_request.pr_url.clone(),
            &metadata,
        )?;

        let mut linked_statement = db.prepare(
            "SELECT DISTINCT task_id FROM task_links
             WHERE provider = ?1 AND kind = ?2 AND external_id = ?3 AND task_id != ?4",
        )?;
        let linked_task_ids = linked_statement
            .query_map(
                params![&pull_request.provider, &kind, &external_id, &task.id],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        for linked_task_id in linked_task_ids {
            db.execute(
                "INSERT OR IGNORE INTO task_relations (id, source_task_id, target_task_id, relation_type, created_at)
                 VALUES (?1, ?2, ?3, 'related', ?4)",
                params![new_id("relation"), linked_task_id, &task.id, now_millis()],
            )?;
        }
    }

    Ok(())
}

fn external_identity_from_pull_request(
    pull_request: &PullRequestRecord,
) -> Option<(String, String)> {
    if pull_request.provider == "github" {
        github_external_id_from_url(&pull_request.pr_url, "pull")
            .map(|id| ("pull_request".to_string(), id))
    } else if pull_request.provider == "gitlab" {
        gitlab_external_id_from_url(&pull_request.pr_url, "merge_requests")
            .map(|id| ("merge_request".to_string(), id))
    } else {
        None
    }
}

fn github_external_id_from_url(url: &str, marker: &str) -> Option<String> {
    let (_, path) = url.split_once("github.com/")?;
    let parts = path
        .split(['?', '#'])
        .next()?
        .split('/')
        .collect::<Vec<_>>();
    if parts.len() < 4 || parts[2] != marker {
        return None;
    }
    Some(format!("{}/{}#{}", parts[0], parts[1], parts[3]))
}

fn gitlab_external_id_from_url(url: &str, marker: &str) -> Option<String> {
    let without_scheme = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let path = without_scheme.split_once('/')?.1;
    let marker_path = format!("/-/{marker}/");
    let (repo_path, rest) = path.split_once(&marker_path)?;
    let number = rest.split(['/', '?', '#']).next()?;
    if repo_path.is_empty() || number.is_empty() {
        return None;
    }
    Some(format!("{repo_path}!{number}"))
}

fn repo_resource_name(normalized_repo_url: &str) -> String {
    let parts = normalized_repo_url
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() >= 3 {
        return parts[1..].join("/");
    }
    normalized_repo_url.to_string()
}

fn parent_resource_from_parsed(
    parsed: &ParsedInputPayload,
    metadata: Option<&ProviderMetadata>,
) -> Option<ProviderResourceMetadata> {
    if parsed.kind == "trello_card" {
        return metadata.and_then(|metadata| metadata.parent_resource.clone());
    }

    if parsed.kind == "trello_board" {
        return Some(ProviderResourceMetadata {
            provider: "trello".to_string(),
            kind: "trello_board".to_string(),
            external_id: parsed.external_id.clone()?,
            url: parsed.url.clone()?,
            name: parsed.title.clone(),
            icon_url: None,
        });
    }

    if parsed.provider.as_deref() == Some("github")
        && matches!(parsed.kind.as_str(), "github_issue" | "pull_request")
    {
        let normalized = normalize_repository_url(parsed.repo_url.as_deref()?)?;
        return Some(ProviderResourceMetadata {
            provider: "github".to_string(),
            kind: "github_repo".to_string(),
            external_id: normalized.clone(),
            url: display_repo_url(&normalized),
            name: repo_resource_name(&normalized),
            icon_url: None,
        });
    }

    if parsed.provider.as_deref() == Some("gitlab")
        && matches!(parsed.kind.as_str(), "gitlab_issue" | "merge_request")
    {
        let normalized = normalize_repository_url(parsed.repo_url.as_deref()?)?;
        return Some(ProviderResourceMetadata {
            provider: "gitlab".to_string(),
            kind: "gitlab_repo".to_string(),
            external_id: normalized.clone(),
            url: display_repo_url(&normalized),
            name: repo_resource_name(&normalized),
            icon_url: None,
        });
    }

    None
}

fn upsert_parent_resource_in_db(
    db: &SqliteConnection,
    project_id: &str,
    parsed: &ParsedInputPayload,
    metadata: Option<&ProviderMetadata>,
) -> rusqlite::Result<Option<Resource>> {
    let Some(parent) = parent_resource_from_parsed(parsed, metadata) else {
        return Ok(None);
    };

    connect_resource_in_db(
        db,
        ResourceInput {
            project_id: project_id.to_string(),
            provider: parent.provider,
            kind: parent.kind,
            external_id: parent.external_id,
            url: parent.url,
            name: parent.name,
            icon_url: parent.icon_url,
            connection_id: metadata.and_then(|metadata| metadata.connection_id.clone()),
        },
    )
    .map(Some)
}

fn create_smart_task_in_db(
    db: &SqliteConnection,
    input: String,
    parsed: ParsedInputPayload,
    project_id: Option<String>,
) -> Result<SmartTaskResult, String> {
    let response = parsed_response(&parsed);

    if parsed.kind == "text" {
        let Some(target_project_id) = project_id else {
            return Ok(SmartTaskResult {
                task: None,
                resource: None,
                parsed: response,
                project_required: true,
                created: false,
                notice: None,
            });
        };

        let task = create_task_in_db(
            db,
            Some(target_project_id),
            response.title.clone(),
            input.trim().to_string(),
            None,
        )
        .map_err(db_error)?;
        return Ok(SmartTaskResult {
            task: Some(task),
            resource: None,
            parsed: response,
            project_required: false,
            created: true,
            notice: None,
        });
    }

    let provider = parsed
        .provider
        .clone()
        .unwrap_or_else(|| "external".to_string());
    let external_id = parsed.external_id.clone().unwrap_or_default();
    let source_url = parsed
        .url
        .clone()
        .unwrap_or_else(|| input.trim().to_string());

    if let Some(task) =
        get_task_by_link(db, &provider, &parsed.kind, &external_id).map_err(db_error)?
    {
        let resource = if let Some(project_id) = task.project_id.as_deref() {
            upsert_parent_resource_in_db(db, project_id, &parsed, None).map_err(db_error)?
        } else {
            None
        };
        return Ok(SmartTaskResult {
            task: Some(task),
            resource,
            parsed: response,
            project_required: false,
            created: false,
            notice: None,
        });
    }

    let mut resource = None;
    let target_project_id = if parsed.kind == "trello_board" {
        if let Some(project_id) = project_id.clone() {
            resource =
                get_resource_by_identity(db, &project_id, &provider, "trello_board", &external_id)
                    .map_err(db_error)?;
            Some(project_id)
        } else {
            None
        }
    } else {
        project_id.clone()
    };

    let Some(target_project_id) = target_project_id else {
        return Ok(SmartTaskResult {
            task: None,
            resource: None,
            parsed: response,
            project_required: true,
            created: false,
            notice: None,
        });
    };

    if parsed.kind == "trello_board" {
        resource = resource.or(
            upsert_parent_resource_in_db(db, &target_project_id, &parsed, None)
                .map_err(db_error)?,
        );

        return Ok(SmartTaskResult {
            task: None,
            resource,
            parsed: response,
            project_required: false,
            created: false,
            notice: Some("Resource connected.".to_string()),
        });
    }

    let metadata = fetch_provider_metadata(db, &target_project_id, &parsed);
    let enriched_title = metadata
        .title
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| response.title.clone());
    let enriched_body = metadata
        .body
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| input.trim().to_string());
    let enriched_url = metadata.url.clone().unwrap_or_else(|| source_url.clone());
    resource = upsert_parent_resource_in_db(db, &target_project_id, &parsed, Some(&metadata))
        .map_err(db_error)?;

    let task = create_task_in_db(
        db,
        Some(target_project_id),
        enriched_title,
        enriched_body,
        Some(enriched_url.clone()),
    )
    .map_err(db_error)?;
    link_task_resource_in_db(
        db,
        task.id.clone(),
        provider.clone(),
        parsed.kind.clone(),
        external_id,
        enriched_url,
        &metadata,
    )
    .map_err(db_error)?;
    if let Some(status) = metadata
        .state
        .clone()
        .filter(|value| !value.trim().is_empty())
    {
        db.execute(
            "UPDATE tasks SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, now_millis(), &task.id],
        )
        .map_err(db_error)?;
    }
    let task = get_task(db, &task.id)
        .map_err(db_error)?
        .ok_or_else(|| "Task not found".to_string())?;

    Ok(SmartTaskResult {
        task: Some(task),
        resource,
        parsed: response,
        project_required: false,
        created: true,
        notice: metadata.notice,
    })
}

fn parsed_response(parsed: &ParsedInputPayload) -> ParsedInputResponse {
    ParsedInputResponse {
        kind: parsed.kind.clone(),
        provider: parsed.provider.clone(),
        external_id: parsed.external_id.clone(),
        url: parsed.url.clone(),
        title: parsed.title.clone(),
        repo_url: parsed.repo_url.clone(),
    }
}

fn list_enabled_connections(
    db: &SqliteConnection,
    project_id: &str,
) -> rusqlite::Result<Vec<(ConnectionRecord, i64)>> {
    let mut statement = db.prepare(
        "SELECT c.id, c.provider, c.name, c.base_url, c.api_key, c.token, c.created_at, c.updated_at, pc.enabled_at
         FROM project_connections pc
         INNER JOIN connections c ON c.id = pc.connection_id
         WHERE pc.project_id = ?1
         ORDER BY pc.enabled_at DESC",
    )?;
    let connections = statement
        .query_map(params![project_id], |row| {
            Ok((
                ConnectionRecord {
                    id: row.get(0)?,
                    provider: row.get(1)?,
                    name: row.get(2)?,
                    base_url: row.get(3)?,
                    api_key: row.get(4)?,
                    token: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                },
                row.get(8)?,
            ))
        })?
        .collect();
    connections
}

fn select_best_connection(
    db: &SqliteConnection,
    project_id: &str,
    parsed: &ParsedInputPayload,
) -> rusqlite::Result<Option<ConnectionRecord>> {
    let Some(provider) = parsed.provider.as_deref() else {
        return Ok(None);
    };
    let parsed_host = parsed
        .url
        .as_deref()
        .and_then(host_from_url)
        .or_else(|| parsed.repo_url.as_deref().and_then(host_from_url));
    let mut matches = list_enabled_connections(db, project_id)?
        .into_iter()
        .filter(|(connection, _)| connection.provider == provider)
        .collect::<Vec<_>>();

    matches.sort_by(|(left, left_enabled_at), (right, right_enabled_at)| {
        let left_score = connection_match_score(left, parsed_host.as_deref());
        let right_score = connection_match_score(right, parsed_host.as_deref());
        right_score
            .cmp(&left_score)
            .then_with(|| right_enabled_at.cmp(left_enabled_at))
    });

    Ok(matches.into_iter().next().map(|(connection, _)| connection))
}

fn connection_match_score(connection: &ConnectionRecord, parsed_host: Option<&str>) -> i32 {
    let connection_host = host_from_url(&connection.base_url);
    if let (Some(parsed_host), Some(connection_host)) = (parsed_host, connection_host.as_deref()) {
        if parsed_host == connection_host {
            return 3;
        }
    }
    if connection.provider == "github" && parsed_host == Some("github.com") {
        return 2;
    }
    if connection.provider == "trello" && parsed_host == Some("trello.com") {
        return 2;
    }
    1
}

fn host_from_url(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let without_scheme = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("http://"))
        .unwrap_or(trimmed);
    without_scheme
        .split(['/', '?', '#', ':'])
        .next()
        .map(|host| host.trim().to_lowercase())
        .filter(|host| !host.is_empty())
}

fn normalize_base_url(value: &str) -> String {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() || trimmed.starts_with("https://") || trimmed.starts_with("http://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

fn fetch_provider_metadata(
    db: &SqliteConnection,
    project_id: &str,
    parsed: &ParsedInputPayload,
) -> ProviderMetadata {
    if parsed.provider.is_none() {
        return ProviderMetadata::empty();
    }

    let Ok(connection) = select_best_connection(db, project_id, parsed) else {
        return ProviderMetadata::notice("Could not select a connection for this external link.");
    };
    let Some(connection) = connection else {
        return ProviderMetadata::notice("No enabled connection matched this external link.");
    };

    match fetch_provider_metadata_with_connection(&connection, parsed) {
        Ok(mut metadata) => {
            metadata.connection_id = Some(connection.id);
            metadata.fetched_at = Some(now_millis());
            metadata
        }
        Err(error) => ProviderMetadata {
            connection_id: Some(connection.id),
            notice: Some(format!("Could not fetch external details: {error}")),
            ..ProviderMetadata::empty()
        },
    }
}

impl ProviderMetadata {
    fn empty() -> Self {
        Self {
            connection_id: None,
            title: None,
            body: None,
            state: None,
            state_color: None,
            target_branch: None,
            url: None,
            fetched_at: None,
            files: Vec::new(),
            comments: Vec::new(),
            labels: Vec::new(),
            parent_resource: None,
            notice: None,
        }
    }

    fn notice(message: &str) -> Self {
        Self {
            notice: Some(message.to_string()),
            ..Self::empty()
        }
    }
}

fn fetch_provider_metadata_with_connection(
    connection: &ConnectionRecord,
    parsed: &ParsedInputPayload,
) -> Result<ProviderMetadata, String> {
    match connection.provider.as_str() {
        "trello" if parsed.kind == "trello_card" => fetch_trello_card(connection, parsed),
        "github" if parsed.kind == "pull_request" => fetch_github_pull_request(connection, parsed),
        "github" if parsed.kind == "github_issue" => fetch_github_issue(connection, parsed),
        "gitlab" if parsed.kind == "merge_request" => {
            fetch_gitlab_merge_request(connection, parsed)
        }
        "gitlab" if parsed.kind == "gitlab_issue" => fetch_gitlab_issue(connection, parsed),
        _ => Ok(ProviderMetadata::empty()),
    }
}

fn fetch_json(url: &str, headers: Vec<(&str, String)>) -> Result<Value, String> {
    let client = reqwest::blocking::Client::new();
    let mut request = client.get(url).header("Accept", "application/json");
    for (key, value) in headers {
        if !value.trim().is_empty() {
            request = request.header(key, value);
        }
    }
    let response = request.send().map_err(db_error)?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        let detail = body.trim();
        if detail.is_empty() {
            return Err(format!("provider returned {status}"));
        }
        return Err(format!("provider returned {status}: {detail}"));
    }
    response.json::<Value>().map_err(db_error)
}

fn post_json(url: &str, headers: Vec<(&str, String)>, payload: &Value) -> Result<Value, String> {
    let client = reqwest::blocking::Client::new();
    let mut request = client
        .post(url)
        .header("Accept", "application/json")
        .json(payload);
    for (key, value) in headers {
        if !value.trim().is_empty() {
            request = request.header(key, value);
        }
    }
    let response = request.send().map_err(db_error)?;
    let status = response.status();
    let body = response.text().unwrap_or_default();
    if !status.is_success() {
        let detail = body.trim();
        return Err(if detail.is_empty() {
            format!("provider returned {status}")
        } else {
            format!("provider returned {status}: {detail}")
        });
    }
    if body.trim().is_empty() {
        Ok(Value::Null)
    } else {
        serde_json::from_str(&body).map_err(db_error)
    }
}

fn delete_json(url: &str, headers: Vec<(&str, String)>) -> Result<(), String> {
    let client = reqwest::blocking::Client::new();
    let mut request = client.delete(url).header("Accept", "application/json");
    for (key, value) in headers {
        if !value.trim().is_empty() {
            request = request.header(key, value);
        }
    }
    let response = request.send().map_err(db_error)?;
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        let body = response.text().unwrap_or_default();
        Err(if body.trim().is_empty() {
            format!("provider returned {status}")
        } else {
            format!("provider returned {status}: {}", body.trim())
        })
    }
}

fn fetch_paginated_json(url: &str, headers: Vec<(&str, String)>) -> Result<Vec<Value>, String> {
    let mut items = Vec::new();
    let separator = if url.contains('?') { '&' } else { '?' };
    let mut page = 1;

    loop {
        let page_json = fetch_json(
            &format!("{url}{separator}per_page=100&page={page}"),
            headers.clone(),
        )?;
        let page_items = page_json
            .as_array()
            .ok_or_else(|| "provider returned an invalid paginated response".to_string())?;
        let page_len = page_items.len();
        items.extend(page_items.iter().cloned());
        if page_len < 100 {
            break;
        }
        page += 1;
    }

    Ok(items)
}

fn json_id_string(json: &Value, key: &str) -> Option<String> {
    json.get(key).and_then(|value| match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    })
}

fn json_i64(json: &Value, key: &str) -> Option<i64> {
    json.get(key).and_then(Value::as_i64)
}

fn diff_context(
    path: String,
    diff: &str,
    old_target: Option<i64>,
    new_target: Option<i64>,
    outdated: bool,
) -> TaskCommentCodeContext {
    let mut old_line = 0_i64;
    let mut new_line = 0_i64;
    let mut parsed = Vec::new();
    for raw in diff.lines() {
        if let Some(header) = raw.strip_prefix("@@ -") {
            let Some((old, rest)) = header.split_once(" +") else {
                continue;
            };
            let Some((new, _)) = rest.split_once(" @@") else {
                continue;
            };
            old_line = old
                .split(',')
                .next()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            new_line = new
                .split(',')
                .next()
                .and_then(|v| v.parse().ok())
                .unwrap_or(0);
            continue;
        }
        let (kind, old, new, content) = if let Some(content) = raw.strip_prefix('+') {
            let line = new_line;
            new_line += 1;
            ("addition", None, Some(line), content)
        } else if let Some(content) = raw.strip_prefix('-') {
            let line = old_line;
            old_line += 1;
            ("deletion", Some(line), None, content)
        } else {
            let content = raw.strip_prefix(' ').unwrap_or(raw);
            let old = old_line;
            let new = new_line;
            old_line += 1;
            new_line += 1;
            ("context", Some(old), Some(new), content)
        };
        let highlighted = old_target.is_some_and(|target| old == Some(target))
            || new_target.is_some_and(|target| new == Some(target));
        parsed.push(TaskCommentDiffLine {
            kind: kind.to_string(),
            old_line: old,
            new_line: new,
            content: content.to_string(),
            highlighted,
        });
    }
    let target = parsed
        .iter()
        .position(|line| line.highlighted)
        .unwrap_or_else(|| parsed.len().saturating_sub(1));
    let start = target.saturating_sub(3);
    let end = (target + 4).min(parsed.len());
    TaskCommentCodeContext {
        path,
        old_start_line: old_target,
        old_line: old_target,
        new_start_line: new_target,
        new_line: new_target,
        outdated,
        lines: parsed[start..end].to_vec(),
    }
}

fn github_inline_comments_from_json(items: &[Value]) -> Vec<TaskComment> {
    let mut comments = github_comments_from_json(items, "inline");
    for (comment, item) in comments.iter_mut().zip(items.iter().filter(|item| {
        item.get("user").is_some_and(|user| !is_bot_user(user))
            && json_string(item, "body").is_some_and(|body| !body.trim().is_empty())
    })) {
        let raw_id = json_id_string(item, "id").unwrap_or_default();
        comment.reply_to_id =
            json_id_string(item, "in_reply_to_id").map(|id| format!("github:inline:{id}"));
        comment.discussion_id = Some(
            comment
                .reply_to_id
                .clone()
                .unwrap_or_else(|| format!("github:inline:{raw_id}")),
        );
        let current_line = json_i64(item, "line");
        let old = if json_string(item, "side").as_deref() == Some("LEFT") {
            current_line.or_else(|| json_i64(item, "original_line"))
        } else {
            None
        };
        let new = if json_string(item, "side").as_deref() != Some("LEFT") {
            current_line.or_else(|| json_i64(item, "original_line"))
        } else {
            None
        };
        if let (Some(path), Some(hunk)) =
            (json_string(item, "path"), json_string(item, "diff_hunk"))
        {
            comment.code_context =
                Some(diff_context(path, &hunk, old, new, current_line.is_none()));
        }
    }
    let parents = comments
        .iter()
        .map(|comment| (comment.id.clone(), comment.reply_to_id.clone()))
        .collect::<HashMap<_, _>>();
    for comment in &mut comments {
        let mut root = comment.reply_to_id.clone();
        let mut seen = HashSet::new();
        while let Some(parent) = root.clone() {
            if !seen.insert(parent.clone()) {
                break;
            }
            match parents.get(&parent).cloned().flatten() {
                Some(next) => root = Some(next),
                None => {
                    comment.discussion_id = Some(parent);
                    break;
                }
            }
        }
    }
    comments
}

fn is_bot_user(json: &Value) -> bool {
    json_bool(json, "bot") == Some(true)
        || json_string(json, "type").is_some_and(|value| value.eq_ignore_ascii_case("bot"))
        || json_string(json, "login").is_some_and(|value| value.ends_with("[bot]"))
}

fn normalize_task_comments(comments: Vec<TaskComment>) -> Vec<TaskComment> {
    let mut by_id = HashMap::new();
    for comment in comments {
        if !comment.body.trim().is_empty() {
            by_id.insert(comment.id.clone(), comment);
        }
    }
    let mut comments = by_id.into_values().collect::<Vec<_>>();
    comments.sort_by(|left, right| {
        left.created_at
            .as_deref()
            .unwrap_or("9999")
            .cmp(right.created_at.as_deref().unwrap_or("9999"))
            .then_with(|| left.updated_at.cmp(&right.updated_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    comments
}

fn github_comments_from_json(items: &[Value], kind: &str) -> Vec<TaskComment> {
    items
        .iter()
        .filter_map(|item| {
            let user = item.get("user")?;
            if is_bot_user(user) {
                return None;
            }
            let body = json_string(item, "body")?;
            if body.trim().is_empty() {
                return None;
            }
            let id = json_id_string(item, "id")?;
            Some(TaskComment {
                id: format!("github:{kind}:{id}"),
                kind: kind.to_string(),
                author: json_string(user, "login").unwrap_or_else(|| "Unknown author".to_string()),
                body,
                created_at: json_string(item, "submitted_at")
                    .or_else(|| json_string(item, "created_at")),
                updated_at: json_string(item, "updated_at"),
                url: json_string(item, "html_url"),
                discussion_id: None,
                reply_to_id: None,
                code_context: None,
            })
        })
        .collect()
}

fn fetch_github_pull_request_comments(
    connection: &ConnectionRecord,
    repo_path: &str,
    number: &str,
) -> Result<Vec<TaskComment>, String> {
    let headers = vec![
        ("Authorization", format!("Bearer {}", connection.token)),
        ("X-GitHub-Api-Version", "2022-11-28".to_string()),
        ("User-Agent", "dev-crash-flash-ai-studio".to_string()),
    ];
    let conversation = fetch_paginated_json(
        &format!("https://api.github.com/repos/{repo_path}/issues/{number}/comments"),
        headers.clone(),
    )?;
    let reviews = fetch_paginated_json(
        &format!("https://api.github.com/repos/{repo_path}/pulls/{number}/reviews"),
        headers.clone(),
    )?;
    let inline = fetch_paginated_json(
        &format!("https://api.github.com/repos/{repo_path}/pulls/{number}/comments"),
        headers,
    )?;

    let mut comments = github_comments_from_json(&conversation, "comment");
    comments.extend(github_comments_from_json(&reviews, "review"));
    comments.extend(github_inline_comments_from_json(&inline));
    Ok(normalize_task_comments(comments))
}

fn trello_comments_from_json(items: &[Value], card_url: Option<&str>) -> Vec<TaskComment> {
    let comments = items.iter().filter_map(|item| {
        if item.get("appCreator").is_some_and(|value| !value.is_null()) {
            return None;
        }
        let id = json_id_string(item, "id")?;
        let body = item
            .get("data")
            .and_then(|data| json_string(data, "text"))?;
        let author = item.get("memberCreator").and_then(|member| {
            json_string(member, "fullName").or_else(|| json_string(member, "username"))
        })?;
        Some(TaskComment {
            id: format!("trello:{id}"),
            kind: "comment".to_string(),
            author,
            body,
            created_at: json_string(item, "date"),
            updated_at: None,
            url: card_url.map(|url| format!("{url}#comment-{id}")),
            discussion_id: None,
            reply_to_id: None,
            code_context: None,
        })
    });
    normalize_task_comments(comments.collect())
}

fn fetch_trello_card_comments(
    id: &str,
    card_url: Option<&str>,
    api_key: &str,
    token: &str,
) -> Result<Vec<TaskComment>, String> {
    let mut actions = Vec::new();
    let mut before: Option<String> = None;
    loop {
        let before_query = before
            .as_deref()
            .map(|value| format!("&before={}", percent_encode(value)))
            .unwrap_or_default();
        let json = fetch_json(
            &format!(
                "https://api.trello.com/1/cards/{}/actions?filter=commentCard&limit=1000{before_query}&key={}&token={}",
                percent_encode(id),
                percent_encode(api_key),
                percent_encode(token)
            ),
            vec![],
        )?;
        let page = json
            .as_array()
            .ok_or_else(|| "Trello returned an invalid comments response".to_string())?;
        let page_len = page.len();
        before = page.last().and_then(|item| json_id_string(item, "id"));
        actions.extend(page.iter().cloned());
        if page_len < 1000 || before.is_none() {
            break;
        }
    }
    Ok(trello_comments_from_json(&actions, card_url))
}

fn gitlab_comments_from_json(
    discussions: &[Value],
    diffs: &[Value],
    merge_request_url: Option<&str>,
) -> Vec<TaskComment> {
    let diff_by_path = diffs
        .iter()
        .filter_map(|diff| {
            Some((
                (
                    json_string(diff, "comment_head_sha"),
                    json_string(diff, "new_path").or_else(|| json_string(diff, "old_path"))?,
                ),
                json_string(diff, "diff")?,
            ))
        })
        .collect::<HashMap<_, _>>();
    let comments = discussions.iter().flat_map(|discussion| {
        let diff_by_path = &diff_by_path;
        let discussion_id = json_id_string(discussion, "id");
        let notes = discussion
            .get("notes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let threaded = notes.len() > 1;
        notes.into_iter().filter_map(move |item| {
            if json_bool(&item, "system") == Some(true) {
                return None;
            }
            let author = item.get("author")?;
            if is_bot_user(author) {
                return None;
            }
            let id = json_id_string(&item, "id")?;
            let kind = if json_string(&item, "type").as_deref() == Some("DiffNote") {
                "inline"
            } else {
                "comment"
            };
            let position = item.get("position");
            let path = position.and_then(|value| {
                json_string(value, "new_path").or_else(|| json_string(value, "old_path"))
            });
            let old = position.and_then(|value| json_i64(value, "old_line"));
            let new = position.and_then(|value| json_i64(value, "new_line"));
            let head_sha = position.and_then(|value| json_string(value, "head_sha"));
            let code_context = path.clone().map(|path| {
                diff_by_path
                    .get(&(head_sha.clone(), path.clone()))
                    .or_else(|| diff_by_path.get(&(None, path.clone())))
                    .map(|diff| diff_context(path.clone(), diff, old, new, false))
                    .unwrap_or(TaskCommentCodeContext {
                        path,
                        old_start_line: old,
                        old_line: old,
                        new_start_line: new,
                        new_line: new,
                        outdated: true,
                        lines: Vec::new(),
                    })
            });
            Some(TaskComment {
                id: format!("gitlab:{id}"),
                kind: kind.to_string(),
                author: json_string(author, "name")
                    .or_else(|| json_string(author, "username"))
                    .unwrap_or_else(|| "Unknown author".to_string()),
                body: json_string(&item, "body")?,
                created_at: json_string(&item, "created_at"),
                updated_at: json_string(&item, "updated_at"),
                url: merge_request_url.map(|url| format!("{url}#note_{id}")),
                discussion_id: if threaded || kind == "inline" {
                    discussion_id.clone().map(|id| format!("gitlab:{id}"))
                } else {
                    None
                },
                reply_to_id: None,
                code_context,
            })
        })
    });
    normalize_task_comments(comments.collect())
}

fn fetch_gitlab_merge_request_comments(
    connection: &ConnectionRecord,
    project_path: &str,
    iid: &str,
    merge_request_url: Option<&str>,
) -> Result<Vec<TaskComment>, String> {
    let base_url = normalize_base_url(&connection.base_url);
    let discussions = fetch_paginated_json(
        &format!(
            "{base_url}/api/v4/projects/{}/merge_requests/{}/discussions",
            percent_encode(project_path),
            percent_encode(iid)
        ),
        vec![("PRIVATE-TOKEN", connection.token.clone())],
    )?;
    let mut diffs = fetch_paginated_json(
        &format!(
            "{base_url}/api/v4/projects/{}/merge_requests/{}/diffs",
            percent_encode(project_path),
            percent_encode(iid)
        ),
        vec![("PRIVATE-TOKEN", connection.token.clone())],
    )
    .unwrap_or_default();
    let requested_heads = discussions
        .iter()
        .flat_map(|discussion| {
            discussion
                .get("notes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|note| {
            note.get("position")
                .and_then(|position| json_string(position, "head_sha"))
        })
        .collect::<HashSet<_>>();
    if !requested_heads.is_empty() {
        let versions = fetch_paginated_json(
            &format!(
                "{base_url}/api/v4/projects/{}/merge_requests/{}/versions",
                percent_encode(project_path),
                percent_encode(iid)
            ),
            vec![("PRIVATE-TOKEN", connection.token.clone())],
        )
        .unwrap_or_default();
        for head_sha in requested_heads {
            let Some(version_id) = versions
                .iter()
                .find(|version| {
                    json_string(version, "head_commit_sha").as_deref() == Some(head_sha.as_str())
                })
                .and_then(|version| json_id_string(version, "id"))
            else {
                continue;
            };
            let Ok(version) = fetch_json(
                &format!(
                    "{base_url}/api/v4/projects/{}/merge_requests/{}/versions/{version_id}",
                    percent_encode(project_path),
                    percent_encode(iid)
                ),
                vec![("PRIVATE-TOKEN", connection.token.clone())],
            ) else {
                continue;
            };
            for mut diff in version
                .get("diffs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                if let Some(object) = diff.as_object_mut() {
                    object.insert(
                        "comment_head_sha".to_string(),
                        Value::String(head_sha.clone()),
                    );
                }
                diffs.push(diff);
            }
        }
    }
    Ok(gitlab_comments_from_json(
        &discussions,
        &diffs,
        merge_request_url,
    ))
}

fn trello_credentials(connection: &ConnectionRecord) -> Result<(&str, &str), String> {
    validate_connection_credentials(connection)?;
    if connection.provider != "trello" {
        return Err("The selected resource does not use a Trello connection.".to_string());
    }
    Ok((
        connection.api_key.as_deref().unwrap_or_default().trim(),
        connection.token.trim(),
    ))
}

fn trello_board_templates_from_json(cards: &Value, lists: &Value) -> TrelloBoardTemplates {
    let templates = cards
        .as_array()
        .into_iter()
        .flatten()
        .filter(|card| {
            json_bool(card, "isTemplate") == Some(true)
                || card
                    .get("cover")
                    .and_then(|cover| json_bool(cover, "isTemplate"))
                    == Some(true)
        })
        .filter_map(|card| {
            Some(TrelloTicketTemplate {
                id: json_string(card, "id")?,
                name: json_string(card, "name").unwrap_or_else(|| "Untitled template".to_string()),
                description: json_string(card, "desc").unwrap_or_default(),
                list_id: json_string(card, "idList")?,
            })
        })
        .collect();
    let lists = lists
        .as_array()
        .into_iter()
        .flatten()
        .filter(|list| json_bool(list, "closed") != Some(true))
        .filter_map(|list| {
            Some(TrelloBoardList {
                id: json_string(list, "id")?,
                name: json_string(list, "name").unwrap_or_else(|| "Untitled list".to_string()),
                color: trello_color(json_string(list, "color")),
            })
        })
        .collect();
    TrelloBoardTemplates { templates, lists }
}

fn fetch_trello_board_templates(
    connection: &ConnectionRecord,
    board_id: &str,
) -> Result<TrelloBoardTemplates, String> {
    let (api_key, token) = trello_credentials(connection)?;
    let cards_url = format!(
        "https://api.trello.com/1/boards/{}/cards/open?fields=id,name,desc,idBoard,idList,isTemplate,cover&key={}&token={}",
        percent_encode(board_id),
        percent_encode(api_key),
        percent_encode(token)
    );
    let lists_url = format!(
        "https://api.trello.com/1/boards/{}/lists/open?fields=id,name,closed,color&key={}&token={}",
        percent_encode(board_id),
        percent_encode(api_key),
        percent_encode(token)
    );
    let cards = fetch_json(&cards_url, Vec::new())?;
    let lists = fetch_json(&lists_url, Vec::new())?;
    Ok(trello_board_templates_from_json(&cards, &lists))
}

fn create_trello_card_from_template(
    connection: &ConnectionRecord,
    template_id: &str,
    list_id: &str,
    title: &str,
    description: &str,
) -> Result<Value, String> {
    let (api_key, token) = trello_credentials(connection)?;
    let url = format!(
        "https://api.trello.com/1/cards?key={}&token={}",
        percent_encode(api_key),
        percent_encode(token)
    );
    let response = reqwest::blocking::Client::new()
        .post(url)
        .header("Accept", "application/json")
        .json(&serde_json::json!({
            "idList": list_id,
            "idCardSource": template_id,
            "keepFromSource": "all",
            "name": title,
            "desc": description,
        }))
        .send()
        .map_err(db_error)?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(if body.trim().is_empty() {
            format!("Trello returned {status} while creating the card.")
        } else {
            format!(
                "Trello returned {status} while creating the card: {}",
                body.trim()
            )
        });
    }
    response.json::<Value>().map_err(db_error)
}

fn delete_trello_card(connection: &ConnectionRecord, card_id: &str) -> Result<(), String> {
    let (api_key, token) = trello_credentials(connection)?;
    let url = format!(
        "https://api.trello.com/1/cards/{}?key={}&token={}",
        percent_encode(card_id),
        percent_encode(api_key),
        percent_encode(token)
    );
    let response = reqwest::blocking::Client::new()
        .delete(url)
        .send()
        .map_err(db_error)?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "Trello returned {} while removing the card.",
            response.status()
        ))
    }
}

fn fetch_connection_activities(
    connection: &ConnectionRecord,
    date: &str,
    start_at: i64,
    end_at: i64,
) -> Result<Vec<ActivityInput>, String> {
    match connection.provider.as_str() {
        "github" => fetch_github_activities(connection, start_at, end_at),
        "gitlab" => fetch_gitlab_activities(connection, date, start_at, end_at),
        "trello" => fetch_trello_activities(connection, date, start_at, end_at),
        _ => Err(format!("Unsupported provider: {}", connection.provider)),
    }
}

fn fetch_connection_review_requests(
    connection: &ConnectionRecord,
) -> Result<Vec<SmartInboxReviewRequest>, String> {
    validate_connection_credentials(connection)?;

    match connection.provider.as_str() {
        "github" => fetch_github_review_requests(connection),
        "gitlab" => fetch_gitlab_review_requests(connection),
        "trello" => fetch_trello_assigned_cards(connection),
        _ => Err(format!("Unsupported provider: {}", connection.provider)),
    }
}

fn fetch_trello_assigned_cards(
    connection: &ConnectionRecord,
) -> Result<Vec<SmartInboxReviewRequest>, String> {
    let api_key = connection
        .api_key
        .as_deref()
        .ok_or_else(|| "Trello API key is required.".to_string())?;
    let url = format!(
        "https://api.trello.com/1/members/me/cards?filter=open&fields=id,name,shortLink,shortUrl,url,closed,dateLastActivity,idBoard,idList&board=true&board_fields=name&list=true&list_fields=name,closed&key={}&token={}",
        percent_encode(api_key),
        percent_encode(&connection.token)
    );
    let json = fetch_json(&url, Vec::new())?;
    let boards_url = format!(
        "https://api.trello.com/1/members/me/boards?filter=all&fields=id,name&lists=all&list_fields=id,name,closed&key={}&token={}",
        percent_encode(api_key),
        percent_encode(&connection.token)
    );
    let boards_json = fetch_json(&boards_url, Vec::new())?;
    let (board_names, list_metadata) = trello_board_and_list_metadata(&boards_json);

    Ok(json
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    trello_assigned_card_from_json_with_context(
                        connection,
                        item,
                        &board_names,
                        &list_metadata,
                    )
                })
                .collect()
        })
        .unwrap_or_default())
}

#[derive(Debug, Clone)]
struct TrelloListMetadata {
    name: Option<String>,
    closed: bool,
}

fn trello_board_and_list_metadata(
    json: &Value,
) -> (HashMap<String, String>, HashMap<String, TrelloListMetadata>) {
    let mut board_names = HashMap::new();
    let mut list_metadata = HashMap::new();

    for board in json.as_array().into_iter().flatten() {
        if let (Some(id), Some(name)) = (json_string(board, "id"), json_string(board, "name")) {
            board_names.insert(id, name);
        }
        for list in board
            .get("lists")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(id) = json_string(list, "id") else {
                continue;
            };
            list_metadata.insert(
                id,
                TrelloListMetadata {
                    name: json_string(list, "name"),
                    closed: list.get("closed").and_then(Value::as_bool).unwrap_or(false),
                },
            );
        }
    }

    (board_names, list_metadata)
}

#[cfg(test)]
fn trello_assigned_card_from_json(
    connection: &ConnectionRecord,
    item: &Value,
) -> Option<SmartInboxReviewRequest> {
    trello_assigned_card_from_json_with_context(connection, item, &HashMap::new(), &HashMap::new())
}

fn trello_assigned_card_from_json_with_context(
    connection: &ConnectionRecord,
    item: &Value,
    board_names: &HashMap<String, String>,
    list_metadata: &HashMap<String, TrelloListMetadata>,
) -> Option<SmartInboxReviewRequest> {
    let list = json_string(item, "idList").and_then(|id| list_metadata.get(&id));
    if item.get("closed").and_then(Value::as_bool).unwrap_or(false)
        || item
            .get("list")
            .and_then(|list| list.get("closed"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        || list.map(|list| list.closed).unwrap_or(false)
    {
        return None;
    }

    // Smart-input task links use the `/c/{shortLink}` URL identity, so the cache
    // must use that same value when resolving an existing local task.
    let external_id = json_string(item, "shortLink").or_else(|| json_string(item, "id"))?;
    let title = json_string(item, "name")?;
    let url = json_string(item, "shortUrl")
        .or_else(|| json_string(item, "url"))
        .or_else(|| {
            json_string(item, "shortLink").map(|value| format!("https://trello.com/c/{value}"))
        })?;
    let updated_at =
        json_string(item, "dateLastActivity").and_then(|value| parse_rfc3339_millis(&value));
    let source_id = json_string(item, "idBoard")?;
    let source_name = json_path_string(item, &["board", "name"])
        .or_else(|| board_names.get(&source_id).cloned())
        .unwrap_or_else(|| source_id.clone());

    Some(SmartInboxReviewRequest {
        provider: "trello".to_string(),
        connection_id: connection.id.clone(),
        connection_name: connection.name.clone(),
        source_id,
        source_name: source_name.clone(),
        external_id,
        title,
        url,
        context_path: Some(source_name),
        context_detail: json_path_string(item, &["list", "name"])
            .or_else(|| list.and_then(|list| list.name.clone())),
        number: None,
        author: None,
        review_requested_at: None,
        updated_at,
        created_at: None,
        sort_at: updated_at,
        sort_source: if updated_at.is_some() {
            "updated"
        } else {
            "unknown"
        }
        .to_string(),
        state: "open".to_string(),
        linked_task: None,
    })
}

fn fetch_github_review_requests(
    connection: &ConnectionRecord,
) -> Result<Vec<SmartInboxReviewRequest>, String> {
    let query = "is:pr is:open user-review-requested:@me archived:false";
    let url = format!(
        "https://api.github.com/search/issues?q={}&sort=updated&order=desc&per_page=50",
        percent_encode(query)
    );
    let json = fetch_json(
        &url,
        vec![
            ("Authorization", format!("Bearer {}", connection.token)),
            ("X-GitHub-Api-Version", "2022-11-28".to_string()),
            ("User-Agent", "dev-crash-flash-ai-studio".to_string()),
        ],
    )?;

    Ok(json
        .get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| github_review_request_from_json(connection, item))
                .collect()
        })
        .unwrap_or_default())
}

fn fetch_gitlab_review_requests(
    connection: &ConnectionRecord,
) -> Result<Vec<SmartInboxReviewRequest>, String> {
    let base_url = normalize_base_url(&connection.base_url);
    let url = format!(
        "{base_url}/api/v4/merge_requests?scope=reviews_for_me&state=opened&order_by=updated_at&sort=desc&per_page=50&view=simple&non_archived=true"
    );
    let json = fetch_json(&url, vec![("PRIVATE-TOKEN", connection.token.clone())])?;

    Ok(json
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| gitlab_review_request_from_json(connection, item))
                .collect()
        })
        .unwrap_or_default())
}

fn github_review_request_from_json(
    connection: &ConnectionRecord,
    item: &Value,
) -> Option<SmartInboxReviewRequest> {
    if json_string(item, "state")?.to_ascii_lowercase() != "open" {
        return None;
    }
    if json_path_string(item, &["pull_request", "merged_at"]).is_some() {
        return None;
    }

    let url = json_string(item, "html_url")?;
    let (repo_path, number) = github_repo_and_number_from_url(&url).or_else(|| {
        let repo_path = json_string(item, "repository_url").and_then(|value| {
            value
                .rsplit_once("/repos/")
                .map(|(_, path)| path.to_string())
        })?;
        let number = json_value_string(item.get("number"))?;
        Some((repo_path, number))
    })?;
    let review_requested_at = review_request_requested_at(item);
    let updated_at = json_string(item, "updated_at").and_then(|value| parse_rfc3339_millis(&value));
    let created_at = json_string(item, "created_at").and_then(|value| parse_rfc3339_millis(&value));
    let (sort_at, sort_source) =
        review_request_sort_metadata(review_requested_at, updated_at, created_at);

    Some(SmartInboxReviewRequest {
        provider: "github".to_string(),
        connection_id: connection.id.clone(),
        connection_name: connection.name.clone(),
        source_id: repo_path.clone(),
        source_name: repo_path.clone(),
        external_id: format!("{repo_path}#{number}"),
        title: json_string(item, "title").unwrap_or_else(|| format!("{repo_path} PR #{number}")),
        url,
        context_path: Some(repo_path),
        context_detail: None,
        number: Some(number),
        author: json_path_string(item, &["user", "login"]),
        review_requested_at,
        updated_at,
        created_at,
        sort_at,
        sort_source,
        state: "open".to_string(),
        linked_task: None,
    })
}

fn gitlab_review_request_from_json(
    connection: &ConnectionRecord,
    item: &Value,
) -> Option<SmartInboxReviewRequest> {
    let state = json_string(item, "state")?.to_ascii_lowercase();
    if state != "opened" {
        return None;
    }
    if json_string(item, "merged_at").is_some() {
        return None;
    }

    let url = json_string(item, "web_url")?;
    let repo_path =
        json_string(item, "path_with_namespace").or_else(|| gitlab_repo_path_from_url(&url))?;
    let number = json_value_string(item.get("iid"))?;
    let review_requested_at = review_request_requested_at(item);
    let updated_at = json_string(item, "updated_at").and_then(|value| parse_rfc3339_millis(&value));
    let created_at = json_string(item, "created_at").and_then(|value| parse_rfc3339_millis(&value));
    let (sort_at, sort_source) =
        review_request_sort_metadata(review_requested_at, updated_at, created_at);

    Some(SmartInboxReviewRequest {
        provider: "gitlab".to_string(),
        connection_id: connection.id.clone(),
        connection_name: connection.name.clone(),
        source_id: repo_path.clone(),
        source_name: repo_path.clone(),
        external_id: format!("{repo_path}!{number}"),
        title: json_string(item, "title").unwrap_or_else(|| format!("{repo_path} MR !{number}")),
        url,
        context_path: Some(repo_path),
        context_detail: None,
        number: Some(number),
        author: json_path_string(item, &["author", "username"])
            .or_else(|| json_path_string(item, &["author", "name"])),
        review_requested_at,
        updated_at,
        created_at,
        sort_at,
        sort_source,
        state: "opened".to_string(),
        linked_task: None,
    })
}

fn review_request_requested_at(item: &Value) -> Option<i64> {
    json_string(item, "review_requested_at")
        .or_else(|| json_string(item, "reviewer_added_at"))
        .or_else(|| json_string(item, "requested_at"))
        .or_else(|| json_path_string(item, &["review_request", "requested_at"]))
        .and_then(|value| parse_rfc3339_millis(&value))
}

fn review_request_sort_metadata(
    review_requested_at: Option<i64>,
    updated_at: Option<i64>,
    created_at: Option<i64>,
) -> (Option<i64>, String) {
    if let Some(value) = review_requested_at {
        return (Some(value), "review_requested".to_string());
    }
    if let Some(value) = updated_at {
        return (Some(value), "updated".to_string());
    }
    if let Some(value) = created_at {
        return (Some(value), "created".to_string());
    }
    (None, "unknown".to_string())
}

fn github_repo_and_number_from_url(url: &str) -> Option<(String, String)> {
    let without_scheme = url
        .trim()
        .strip_prefix("https://")
        .or_else(|| url.trim().strip_prefix("http://"))
        .unwrap_or(url.trim());
    let parts = without_scheme.split('/').collect::<Vec<_>>();
    if parts.len() < 5 || parts[3] != "pull" {
        return None;
    }
    let owner = parts[1].trim().to_string();
    let repo = parts[2].trim().to_string();
    let number = parts[4].trim().to_string();
    if owner.is_empty() || repo.is_empty() || number.is_empty() {
        return None;
    }
    Some((format!("{owner}/{repo}"), number))
}

fn gitlab_repo_path_from_url(url: &str) -> Option<String> {
    let without_scheme = url
        .trim()
        .strip_prefix("https://")
        .or_else(|| url.trim().strip_prefix("http://"))
        .unwrap_or(url.trim());
    let mut path_parts = without_scheme.split('/').skip(1).collect::<Vec<_>>();
    let marker = path_parts.iter().position(|part| *part == "-")?;
    if path_parts.get(marker + 1) != Some(&"merge_requests") {
        return None;
    }
    path_parts.truncate(marker);
    let repo_path = path_parts.join("/");
    if repo_path.is_empty() {
        return None;
    }
    Some(repo_path)
}

fn fetch_github_activities(
    connection: &ConnectionRecord,
    start_at: i64,
    end_at: i64,
) -> Result<Vec<ActivityInput>, String> {
    let headers = vec![
        ("Authorization", format!("Bearer {}", connection.token)),
        ("X-GitHub-Api-Version", "2022-11-28".to_string()),
        ("User-Agent", "dev-crash-flash-ai-studio".to_string()),
    ];
    let user = fetch_json("https://api.github.com/user", headers.clone())?;
    let login = json_string(&user, "login")
        .ok_or_else(|| "GitHub account login was not returned.".to_string())?;
    let events = fetch_json(
        &format!(
            "https://api.github.com/users/{}/events?per_page=100",
            percent_encode(&login)
        ),
        headers.clone(),
    )?;

    let mut pull_requests = HashMap::<String, Option<Value>>::new();
    let mut activities = Vec::new();
    for event in events.as_array().into_iter().flatten() {
        let Some(mut activity) = github_activity_from_json(connection, event, start_at, end_at)
        else {
            continue;
        };
        if let Some(locator) = github_pull_request_locator(event) {
            let pull_request = pull_requests
                .entry(locator.api_url.clone())
                .or_insert_with(|| fetch_json(&locator.api_url, headers.clone()).ok());
            hydrate_github_pull_request_activity(
                &mut activity,
                event,
                Some(&locator),
                pull_request.as_ref(),
            );
        }
        activities.push(activity);
    }
    Ok(activities)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GithubPullRequestLocator {
    api_url: String,
    web_url: String,
    fallback_title: String,
}

fn github_pull_request_locator(event: &Value) -> Option<GithubPullRequestLocator> {
    let api_url = [
        &["payload", "pull_request", "url"][..],
        &["payload", "comment", "pull_request_url"][..],
        &["payload", "comment", "_links", "pull_request", "href"][..],
        &["payload", "review", "pull_request_url"][..],
        &["payload", "review", "_links", "pull_request", "href"][..],
        &["payload", "issue", "pull_request", "url"][..],
    ]
    .into_iter()
    .find_map(|path| json_path_string(event, path))?;
    let (repository, number) = github_pull_request_identity(&api_url).or_else(|| {
        let repository = json_path_string(event, &["repo", "name"])?;
        let payload = event.get("payload")?;
        let number = payload
            .get("pull_request")
            .and_then(|pull_request| json_id_string(pull_request, "number"))
            .or_else(|| json_id_string(payload, "number"))?;
        Some((repository, number))
    })?;
    Some(GithubPullRequestLocator {
        api_url,
        web_url: format!("https://github.com/{repository}/pull/{number}"),
        fallback_title: format!("{repository} PR #{number}"),
    })
}

fn github_pull_request_identity(api_url: &str) -> Option<(String, String)> {
    let path = api_url
        .trim()
        .strip_prefix("https://api.github.com/repos/")?;
    let parts = path.split('/').collect::<Vec<_>>();
    if parts.len() < 4 || parts[2] != "pulls" || parts[0].is_empty() || parts[1].is_empty() {
        return None;
    }
    Some((format!("{}/{}", parts[0], parts[1]), parts[3].to_string()))
}

fn hydrate_github_pull_request_activity(
    activity: &mut ActivityInput,
    event: &Value,
    locator: Option<&GithubPullRequestLocator>,
    hydrated: Option<&Value>,
) {
    let derived_locator;
    let locator = match locator {
        Some(locator) => locator,
        None => {
            derived_locator = github_pull_request_locator(event);
            let Some(locator) = derived_locator.as_ref() else {
                return;
            };
            locator
        }
    };
    let mut subject = hydrated
        .cloned()
        .or_else(|| {
            event
                .get("payload")
                .and_then(|payload| payload.get("pull_request").or_else(|| payload.get("issue")))
                .cloned()
        })
        .unwrap_or_else(|| Value::Object(Default::default()));
    let title = json_string(&subject, "title")
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| locator.fallback_title.clone());
    let has_web_url = json_string(&subject, "html_url").is_some();
    let Some(subject_object) = subject.as_object_mut() else {
        return;
    };
    subject_object.insert("title".to_string(), Value::String(title.clone()));
    if !has_web_url {
        subject_object.insert(
            "html_url".to_string(),
            Value::String(locator.web_url.clone()),
        );
    }
    activity.title = title;
    activity.subject_json = Some(subject.to_string());
}

fn github_activity_from_json(
    connection: &ConnectionRecord,
    event: &Value,
    start_at: i64,
    end_at: i64,
) -> Option<ActivityInput> {
    let occurred_at = parse_rfc3339_millis(&json_string(event, "created_at")?)?;
    if occurred_at < start_at || occurred_at >= end_at {
        return None;
    }

    let external_id = json_string(event, "id")?;
    let event_type = json_string(event, "type").unwrap_or_else(|| "GitHubEvent".to_string());
    let payload_action = json_path_string(event, &["payload", "action"]);
    let repo_name = json_path_string(event, &["repo", "name"]);
    let title = json_path_string(event, &["payload", "pull_request", "title"])
        .or_else(|| json_path_string(event, &["payload", "issue", "title"]))
        .or_else(|| json_path_string(event, &["payload", "release", "name"]))
        .or_else(|| {
            json_path_string(event, &["payload", "comment", "body"]).map(|body| first_line(&body))
        })
        .or_else(|| {
            json_path_string(event, &["payload", "commits", "0", "message"])
                .map(|body| first_line(&body))
        })
        .or(repo_name.clone())
        .unwrap_or_else(|| event_type.clone());
    let target_url = json_path_string(event, &["payload", "pull_request", "html_url"])
        .or_else(|| json_path_string(event, &["payload", "issue", "html_url"]))
        .or_else(|| json_path_string(event, &["payload", "release", "html_url"]))
        .or_else(|| json_path_string(event, &["payload", "comment", "html_url"]))
        .or_else(|| repo_name.map(|name| format!("https://github.com/{name}")));

    let mut activity = ActivityInput {
        provider: "github".to_string(),
        connection_id: connection.id.clone(),
        external_id,
        event_type: event_type.clone(),
        action_label: github_activity_label(event, &event_type, payload_action.as_deref()),
        actor: json_path_string(event, &["actor", "login"]),
        title,
        target_url,
        occurred_at,
        raw_json: event.to_string(),
        subject_json: event
            .get("payload")
            .and_then(|payload| payload.get("pull_request").or_else(|| payload.get("issue")))
            .map(Value::to_string),
    };
    hydrate_github_pull_request_activity(&mut activity, event, None, None);
    Some(activity)
}

fn fetch_gitlab_activities(
    connection: &ConnectionRecord,
    date: &str,
    start_at: i64,
    end_at: i64,
) -> Result<Vec<ActivityInput>, String> {
    let base_url = normalize_base_url(&connection.base_url);
    let headers = vec![("PRIVATE-TOKEN", connection.token.clone())];
    let user = fetch_json(&format!("{base_url}/api/v4/user"), headers.clone())?;
    let user_id =
        json_i64(&user, "id").ok_or_else(|| "GitLab account id was not returned.".to_string())?;
    // GitLab's date-only event filters are evaluated independently of the
    // desktop's local timezone. Query a wider window and keep the exact local
    // day filtering in gitlab_activity_from_json.
    let after = add_days_to_date(date, -1).unwrap_or_else(|| date.to_string());
    let before = add_days_to_date(date, 2).unwrap_or_else(|| date.to_string());
    let events = fetch_paginated_json(
        &format!(
            "{base_url}/api/v4/users/{user_id}/events?after={}&before={}&sort=desc",
            percent_encode(&after),
            percent_encode(&before)
        ),
        headers.clone(),
    )?;
    let mut activities = Vec::new();
    for event in &events {
        let Some(mut activity) =
            gitlab_activity_from_json(connection, event, user_id, start_at, end_at)
        else {
            continue;
        };
        if let Some((project_id, merge_request_iid)) = gitlab_event_merge_request_locator(event) {
            let merge_request_url = format!(
                "{base_url}/api/v4/projects/{}/merge_requests/{}",
                percent_encode(&project_id),
                percent_encode(&merge_request_iid)
            );
            if let Ok(merge_request) = fetch_json(&merge_request_url, headers.clone()) {
                hydrate_gitlab_merge_request_event_activity(
                    &mut activity,
                    event,
                    &project_id,
                    &merge_request_iid,
                    &merge_request,
                );
            }
        }
        activities.push(activity);
    }

    // GitLab's Events API omits merge-request-associated events and does not
    // support DiscussionNote events. Inspect every MR updated during the day
    // so authored notes, inline notes, and replies are represented reliably.
    let start = gitlab_datetime_parameter(start_at)?;
    let end = gitlab_datetime_parameter(end_at)?;
    let updated_merge_requests_url = format!(
        "{base_url}/api/v4/merge_requests?scope=all&state=all&updated_after={}&updated_before={}&order_by=updated_at&sort=desc",
        percent_encode(&start),
        percent_encode(&end)
    );
    let updated_merge_requests =
        fetch_paginated_json(&updated_merge_requests_url, headers.clone())?;
    attach_gitlab_branch_activities_to_merge_requests(&mut activities, &updated_merge_requests);
    for merge_request in &updated_merge_requests {
        activities.extend(gitlab_merge_request_activities_from_json(
            connection,
            merge_request,
            user_id,
            start_at,
            end_at,
        ));
        let project_id = json_id_string(merge_request, "project_id")
            .ok_or_else(|| "GitLab merge request project id was not returned.".to_string())?;
        let merge_request_iid = json_id_string(merge_request, "iid")
            .ok_or_else(|| "GitLab merge request iid was not returned.".to_string())?;
        let discussions = fetch_paginated_json(
            &format!(
                "{base_url}/api/v4/projects/{}/merge_requests/{}/discussions",
                percent_encode(&project_id),
                percent_encode(&merge_request_iid)
            ),
            headers.clone(),
        )?;
        activities.extend(gitlab_merge_request_note_activities_from_json(
            connection,
            merge_request,
            &discussions,
            user_id,
            start_at,
            end_at,
        ));
    }

    Ok(deduplicate_activities_prefer_latest(activities))
}

fn attach_gitlab_branch_activities_to_merge_requests(
    activities: &mut [ActivityInput],
    merge_requests: &[Value],
) {
    for activity in activities {
        if activity.action_label != "Pushed" && activity.action_label != "Deleted" {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(&activity.raw_json) else {
            continue;
        };
        let Some(branch) = json_path_string(&event, &["push_data", "ref"]) else {
            continue;
        };
        let Some(project_id) = json_value_string(event.get("project_id")) else {
            continue;
        };
        let Some(merge_request) = merge_requests.iter().find(|merge_request| {
            json_string(merge_request, "source_branch").as_deref() == Some(branch.as_str())
                && [
                    json_value_string(merge_request.get("source_project_id")),
                    json_value_string(merge_request.get("project_id")),
                ]
                .into_iter()
                .flatten()
                .any(|candidate| candidate == project_id)
        }) else {
            continue;
        };

        activity.title = json_string(merge_request, "title").unwrap_or(activity.title.clone());
        activity.target_url = json_string(merge_request, "web_url").or(activity.target_url.clone());
        activity.subject_json = Some(merge_request.to_string());
    }
}

fn gitlab_datetime_parameter(timestamp: i64) -> Result<String, String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(timestamp)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .ok_or_else(|| "Activity date is outside GitLab's supported range.".to_string())
}

fn gitlab_merge_request_activities_from_json(
    connection: &ConnectionRecord,
    merge_request: &Value,
    user_id: i64,
    start_at: i64,
    end_at: i64,
) -> Vec<ActivityInput> {
    let Some(id) = json_id_string(merge_request, "id") else {
        return Vec::new();
    };
    let title =
        json_string(merge_request, "title").unwrap_or_else(|| format!("Merge request {id}"));
    let target_url = json_string(merge_request, "web_url");
    let raw_json = merge_request.to_string();
    let mut activities = Vec::new();

    let candidates = [
        (
            "created",
            "Created",
            "created_at",
            json_i64(merge_request.get("author").unwrap_or(&Value::Null), "id") == Some(user_id),
            json_path_string(merge_request, &["author", "username"])
                .or_else(|| json_path_string(merge_request, &["author", "name"])),
        ),
        (
            "merged",
            "Merged",
            "merged_at",
            json_i64(
                merge_request.get("merge_user").unwrap_or(&Value::Null),
                "id",
            ) == Some(user_id),
            json_path_string(merge_request, &["merge_user", "username"])
                .or_else(|| json_path_string(merge_request, &["merge_user", "name"])),
        ),
        (
            "closed",
            "Closed",
            "closed_at",
            json_i64(merge_request.get("closed_by").unwrap_or(&Value::Null), "id") == Some(user_id),
            json_path_string(merge_request, &["closed_by", "username"])
                .or_else(|| json_path_string(merge_request, &["closed_by", "name"])),
        ),
    ];

    for (suffix, action_label, timestamp_key, performed_by_user, actor) in candidates {
        if !performed_by_user {
            continue;
        }
        let Some(occurred_at) = json_string(merge_request, timestamp_key)
            .and_then(|value| parse_rfc3339_millis(&value))
        else {
            continue;
        };
        if occurred_at < start_at || occurred_at >= end_at {
            continue;
        }
        activities.push(ActivityInput {
            provider: "gitlab".to_string(),
            connection_id: connection.id.clone(),
            external_id: format!("merge-request:{id}:{suffix}"),
            event_type: "MergeRequest".to_string(),
            action_label: action_label.to_string(),
            actor,
            title: title.clone(),
            target_url: target_url.clone(),
            occurred_at,
            raw_json: raw_json.clone(),
            subject_json: Some(raw_json.clone()),
        });
    }

    activities
}

fn gitlab_merge_request_note_activities_from_json(
    connection: &ConnectionRecord,
    merge_request: &Value,
    discussions: &[Value],
    user_id: i64,
    start_at: i64,
    end_at: i64,
) -> Vec<ActivityInput> {
    let Some(project_id) = json_id_string(merge_request, "project_id") else {
        return Vec::new();
    };
    let Some(merge_request_iid) = json_id_string(merge_request, "iid") else {
        return Vec::new();
    };
    let title = json_string(merge_request, "title")
        .unwrap_or_else(|| format!("Merge request {merge_request_iid}"));
    let merge_request_url = json_string(merge_request, "web_url");
    let subject_json = merge_request.to_string();
    let mut activities = discussions
        .iter()
        .flat_map(|discussion| {
            discussion
                .get("notes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|note| {
            if json_i64(note.get("author").unwrap_or(&Value::Null), "id") != Some(user_id) {
                return None;
            }
            let is_approval = json_bool(note, "system") == Some(true)
                && json_string(note, "body").is_some_and(|body| {
                    body.trim()
                        .eq_ignore_ascii_case("approved this merge request")
                });
            if json_bool(note, "system") == Some(true) && !is_approval {
                return None;
            }
            let note_id = json_id_string(note, "id")?;
            let occurred_at =
                json_string(note, "created_at").and_then(|value| parse_rfc3339_millis(&value))?;
            if occurred_at < start_at || occurred_at >= end_at {
                return None;
            }
            let actor = json_path_string(note, &["author", "username"])
                .or_else(|| json_path_string(note, &["author", "name"]));
            Some(ActivityInput {
                provider: "gitlab".to_string(),
                connection_id: connection.id.clone(),
                external_id: gitlab_merge_request_note_external_id(
                    &project_id,
                    &merge_request_iid,
                    &note_id,
                ),
                event_type: if is_approval {
                    "MergeRequestApproval".to_string()
                } else {
                    "Note".to_string()
                },
                action_label: if is_approval {
                    "Approved".to_string()
                } else {
                    "Commented".to_string()
                },
                actor,
                title: title.clone(),
                target_url: if is_approval {
                    merge_request_url.clone()
                } else {
                    merge_request_url
                        .as_ref()
                        .map(|url| format!("{url}#note_{note_id}"))
                },
                occurred_at,
                raw_json: note.to_string(),
                subject_json: Some(subject_json.clone()),
            })
        })
        .collect::<Vec<_>>();
    activities.sort_by(|left, right| {
        left.occurred_at
            .cmp(&right.occurred_at)
            .then_with(|| left.external_id.cmp(&right.external_id))
    });
    activities
}

fn gitlab_merge_request_note_external_id(
    project_id: &str,
    merge_request_iid: &str,
    note_id: &str,
) -> String {
    format!("merge-request-note:{project_id}:{merge_request_iid}:{note_id}")
}

fn gitlab_event_merge_request_note_id(event: &Value) -> Option<String> {
    let note = event.get("note")?;
    let noteable_type = json_string(note, "noteable_type")?;
    if !noteable_type.eq_ignore_ascii_case("mergerequest")
        && !noteable_type.eq_ignore_ascii_case("merge_request")
    {
        return None;
    }
    json_id_string(note, "id")
}

fn hydrate_gitlab_merge_request_event_activity(
    activity: &mut ActivityInput,
    event: &Value,
    project_id: &str,
    merge_request_iid: &str,
    merge_request: &Value,
) {
    activity.title = json_string(merge_request, "title").unwrap_or_else(|| activity.title.clone());
    let merge_request_web_url = json_string(merge_request, "web_url");
    activity.target_url = merge_request_web_url
        .clone()
        .or_else(|| activity.target_url.clone());
    activity.subject_json = Some(merge_request.to_string());
    if let Some(note_id) = gitlab_event_merge_request_note_id(event) {
        activity.external_id =
            gitlab_merge_request_note_external_id(project_id, merge_request_iid, &note_id);
        activity.target_url = merge_request_web_url.map(|url| format!("{url}#note_{note_id}"));
    }
}

fn deduplicate_activities_prefer_latest(activities: Vec<ActivityInput>) -> Vec<ActivityInput> {
    let mut by_external_id = HashMap::new();
    for activity in activities {
        by_external_id.insert(activity.external_id.clone(), activity);
    }
    let mut activities = by_external_id.into_values().collect::<Vec<_>>();
    activities.sort_by(|left, right| {
        left.occurred_at
            .cmp(&right.occurred_at)
            .then_with(|| left.external_id.cmp(&right.external_id))
    });
    activities
}

fn gitlab_activity_from_json(
    connection: &ConnectionRecord,
    event: &Value,
    user_id: i64,
    start_at: i64,
    end_at: i64,
) -> Option<ActivityInput> {
    if json_i64(event, "author_id") != Some(user_id) {
        return None;
    }
    let occurred_at = parse_rfc3339_millis(&json_string(event, "created_at")?)?;
    if occurred_at < start_at || occurred_at >= end_at {
        return None;
    }

    let event_type = json_string(event, "target_type")
        .or_else(|| json_string(event, "action_name"))
        .unwrap_or_else(|| "event".to_string());
    let action_label =
        gitlab_activity_label(json_string(event, "action_name").as_deref(), &event_type);
    let external_id = json_value_string(event.get("id")).unwrap_or_else(|| {
        format!(
            "{}:{}",
            event_type,
            json_string(event, "created_at").unwrap_or_default()
        )
    });
    let title = json_string(event, "target_title")
        .or_else(|| json_path_string(event, &["push_data", "ref"]))
        .or_else(|| json_string(event, "project_name"))
        .unwrap_or_else(|| action_label.clone());

    Some(ActivityInput {
        provider: "gitlab".to_string(),
        connection_id: connection.id.clone(),
        external_id,
        event_type,
        action_label,
        actor: json_path_string(event, &["author", "username"])
            .or_else(|| json_path_string(event, &["author", "name"])),
        title,
        target_url: json_string(event, "target_url"),
        occurred_at,
        raw_json: event.to_string(),
        subject_json: None,
    })
}

fn gitlab_event_merge_request_locator(event: &Value) -> Option<(String, String)> {
    let project_id = json_value_string(event.get("project_id"))?;
    if let Some(note) = event.get("note") {
        let noteable_type = json_string(note, "noteable_type").unwrap_or_default();
        if noteable_type.eq_ignore_ascii_case("mergerequest")
            || noteable_type.eq_ignore_ascii_case("merge_request")
        {
            return Some((project_id, json_value_string(note.get("noteable_iid"))?));
        }
    }
    let target_type = json_string(event, "target_type").unwrap_or_default();
    if target_type.eq_ignore_ascii_case("mergerequest")
        || target_type.eq_ignore_ascii_case("merge_request")
    {
        let iid = json_value_string(event.get("target_iid"))
            .or_else(|| json_value_string(event.get("iid")))?;
        return Some((project_id, iid));
    }
    None
}

fn fetch_trello_activities(
    connection: &ConnectionRecord,
    date: &str,
    start_at: i64,
    end_at: i64,
) -> Result<Vec<ActivityInput>, String> {
    let api_key = connection.api_key.as_deref().unwrap_or_default().trim();
    let token = connection.token.trim();
    if api_key.is_empty() || token.is_empty() {
        return Err("Trello API key and token are required".to_string());
    }

    let before = add_days_to_date(date, 1).unwrap_or_else(|| date.to_string());
    let url = format!(
        "https://api.trello.com/1/members/me/actions?filter=all&limit=1000&since={}&before={}&key={}&token={}",
        percent_encode(date),
        percent_encode(&before),
        percent_encode(api_key),
        percent_encode(token)
    );
    let actions = fetch_json(&url, vec![])?;

    Ok(actions
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|action| {
                    trello_activity_from_json(connection, action, start_at, end_at)
                })
                .collect()
        })
        .unwrap_or_default())
}

fn trello_card_short_link_from_url(value: &str) -> Option<String> {
    let without_query = value.trim().split(['?', '#']).next().unwrap_or_default();
    let parts = without_query.split('/').collect::<Vec<_>>();
    let marker = parts.iter().position(|part| *part == "c")?;
    let short_link = parts.get(marker + 1)?.trim();
    if short_link.is_empty()
        || !short_link
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return None;
    }
    Some(short_link.to_string())
}

fn fetch_resolved_trello_ticket(
    connection: &ConnectionRecord,
    external_id: &str,
) -> Result<ResolvedTrelloTicket, String> {
    let api_key = connection.api_key.as_deref().unwrap_or_default().trim();
    let token = connection.token.trim();
    if api_key.is_empty() || token.is_empty() {
        return Err("Trello API key and token are required".to_string());
    }
    let url = format!(
        "https://api.trello.com/1/cards/{}?fields=name,shortLink,shortUrl,url,idBoard&board=true&board_fields=name,shortLink,shortUrl,url&key={}&token={}",
        percent_encode(external_id),
        percent_encode(api_key),
        percent_encode(token)
    );
    let json = fetch_json(&url, vec![])?;
    let canonical_external_id =
        json_string(&json, "shortLink").unwrap_or_else(|| external_id.to_string());
    Ok(ResolvedTrelloTicket {
        external_id: canonical_external_id.clone(),
        title: json_string(&json, "name")
            .unwrap_or_else(|| format!("Trello ticket {canonical_external_id}")),
        url: json_string(&json, "shortUrl")
            .or_else(|| json_string(&json, "url"))
            .unwrap_or_else(|| format!("https://trello.com/c/{canonical_external_id}")),
        board_external_id: json_path_string(&json, &["board", "shortLink"])
            .or_else(|| json_string(&json, "idBoard")),
        board_name: json_path_string(&json, &["board", "name"]),
        connection_id: connection.id.clone(),
    })
}

fn trello_activity_from_json(
    connection: &ConnectionRecord,
    action: &Value,
    start_at: i64,
    end_at: i64,
) -> Option<ActivityInput> {
    let occurred_at = parse_rfc3339_millis(&json_string(action, "date")?)?;
    if occurred_at < start_at || occurred_at >= end_at {
        return None;
    }

    let event_type = json_string(action, "type").unwrap_or_else(|| "action".to_string());
    if is_trello_position_only_update(action, &event_type) {
        return None;
    }
    let title = json_path_string(action, &["data", "card", "name"])
        .or_else(|| json_path_string(action, &["data", "board", "name"]))
        .or_else(|| json_path_string(action, &["data", "list", "name"]))
        .unwrap_or_else(|| title_case_words(&event_type));
    let target_url = json_path_string(action, &["data", "card", "shortLink"])
        .map(|short_link| format!("https://trello.com/c/{short_link}"))
        .or_else(|| {
            json_path_string(action, &["data", "board", "shortLink"])
                .map(|short_link| format!("https://trello.com/b/{short_link}"))
        });

    Some(ActivityInput {
        provider: "trello".to_string(),
        connection_id: connection.id.clone(),
        external_id: json_string(action, "id")?,
        event_type: event_type.clone(),
        action_label: trello_activity_label(action, &event_type),
        actor: json_path_string(action, &["memberCreator", "username"])
            .or_else(|| json_path_string(action, &["memberCreator", "fullName"])),
        title,
        target_url,
        occurred_at,
        raw_json: action.to_string(),
        subject_json: None,
    })
}

fn is_trello_position_only_update(action: &Value, event_type: &str) -> bool {
    if event_type != "updateCard" {
        return false;
    }
    let old = action.get("data").and_then(|data| data.get("old"));
    old.and_then(|value| value.get("pos")).is_some()
        && old.and_then(|value| value.get("idList")).is_none()
}

fn github_activity_label(event: &Value, event_type: &str, action: Option<&str>) -> String {
    if event_type == "PullRequestEvent"
        && action == Some("closed")
        && json_path_bool(event, &["payload", "pull_request", "merged"]) == Some(true)
    {
        return "Merged".to_string();
    }

    match event_type {
        "IssueCommentEvent" | "CommitCommentEvent" | "PullRequestReviewCommentEvent" => {
            return "Commented".to_string();
        }
        "PullRequestReviewEvent" => return "Reviewed".to_string(),
        _ => {}
    }

    if let Some(action) = action.and_then(canonical_activity_action) {
        return action;
    }

    match event_type {
        "PushEvent" => "Pushed".to_string(),
        "CreateEvent" => "Created".to_string(),
        "DeleteEvent" => "Deleted".to_string(),
        "WatchEvent" => "Starred".to_string(),
        "ForkEvent" => "Forked".to_string(),
        _ => event_type
            .strip_suffix("Event")
            .map(title_case_words)
            .unwrap_or_else(|| title_case_words(event_type)),
    }
}

fn gitlab_activity_label(action: Option<&str>, event_type: &str) -> String {
    action
        .and_then(canonical_activity_action)
        .unwrap_or_else(|| title_case_words(event_type))
}

fn trello_activity_label(action: &Value, event_type: &str) -> String {
    match event_type {
        "createCard" | "createBoard" | "createList" => "Created".to_string(),
        "commentCard" => "Commented".to_string(),
        "deleteCard" | "deleteBoard" => "Deleted".to_string(),
        "copyCard" => "Copied".to_string(),
        "addAttachmentToCard" | "deleteAttachmentFromCard" | "removeAttachmentFromCard" => {
            "Changed".to_string()
        }
        "addMemberToCard" => "Assigned".to_string(),
        "removeMemberFromCard" => "Unassigned".to_string(),
        "updateCard"
            if action
                .get("data")
                .and_then(|data| data.get("old"))
                .is_some() =>
        {
            let old = action.get("data").and_then(|data| data.get("old"));
            if old.and_then(|value| value.get("idList")).is_some() {
                trello_moved_label(action)
            } else {
                "Changed".to_string()
            }
        }
        "updateBoard" | "updateList" | "updateChecklist" | "updateCheckItemStateOnCard" => {
            "Changed".to_string()
        }
        _ => canonical_activity_action(event_type).unwrap_or_else(|| title_case_words(event_type)),
    }
}

fn trello_moved_label(action: &Value) -> String {
    json_path_string(action, &["data", "listAfter", "name"])
        .or_else(|| json_path_string(action, &["data", "list", "name"]))
        .map(|name| format!("Moved: {name}"))
        .unwrap_or_else(|| "Moved".to_string())
}

fn canonical_activity_action(value: &str) -> Option<String> {
    let normalized = value.trim().to_ascii_lowercase();
    let label = match normalized.as_str() {
        "add" | "added" | "create" | "created" | "open" | "opened" => "Created",
        "move" | "moved" => "Moved",
        "update" | "updated" | "change" | "changed" | "edit" | "edited" => "Changed",
        "comment" | "commented" | "commented on" => "Commented",
        "approve" | "approved" => "Approved",
        "merge" | "merged" | "accept" | "accepted" => "Merged",
        "close" | "closed" => "Closed",
        "reopen" | "reopened" => "Reopened",
        "delete" | "deleted" | "remove" | "removed" | "destroy" | "destroyed" => "Deleted",
        "push" | "pushed" | "pushed to" => "Pushed",
        "review" | "reviewed" => "Reviewed",
        "attach" | "attached" | "attachment" => "Changed",
        "assign" | "assigned" => "Assigned",
        "unassign" | "unassigned" => "Unassigned",
        _ => return None,
    };
    Some(label.to_string())
}

fn test_connection_with_record(connection: &ConnectionRecord) -> TestConnectionResult {
    if let Err(message) = validate_connection_credentials(connection) {
        return TestConnectionResult {
            ok: false,
            message,
            account_name: None,
        };
    }

    let result = match connection.provider.as_str() {
        "github" => test_github_connection(connection),
        "gitlab" => test_gitlab_connection(connection),
        "trello" => test_trello_connection(connection),
        _ => Err(format!("Unsupported provider: {}", connection.provider)),
    };

    match result {
        Ok(account_name) => TestConnectionResult {
            ok: true,
            message: account_name
                .as_deref()
                .map(|name| format!("Connection successful for {name}."))
                .unwrap_or_else(|| "Connection successful.".to_string()),
            account_name,
        },
        Err(message) => TestConnectionResult {
            ok: false,
            message: connection_test_error_message(&connection.provider, &message),
            account_name: None,
        },
    }
}

fn connection_test_error_message(provider: &str, message: &str) -> String {
    if message.contains("401") || message.contains("403") {
        format!("{message}. {}", provider_permission_hint(provider))
    } else {
        message.to_string()
    }
}

fn provider_permission_hint(provider: &str) -> &'static str {
    match provider {
        "gitlab" => {
            "GitLab tokens need read_api or api to read project issues and merge requests; read_repository alone is not enough."
        }
        "github" => {
            "GitHub fine-grained tokens need repository Metadata read, Pull requests read, and Issues read permissions; classic tokens need repo for private repositories or public_repo for public repositories."
        }
        "trello" => "Trello tokens must be authorized with read access.",
        _ => "Check that the token has read access for this provider.",
    }
}

fn validate_connection_credentials(connection: &ConnectionRecord) -> Result<(), String> {
    if connection.base_url.trim().is_empty() {
        return Err("Base URL is required.".to_string());
    }
    if connection.token.trim().is_empty() {
        return Err("Token is required.".to_string());
    }
    if connection.provider == "trello"
        && connection
            .api_key
            .as_deref()
            .unwrap_or_default()
            .trim()
            .is_empty()
    {
        return Err("Trello API key is required.".to_string());
    }
    Ok(())
}

fn test_github_connection(connection: &ConnectionRecord) -> Result<Option<String>, String> {
    let json = fetch_json(
        "https://api.github.com/user",
        vec![
            ("Authorization", format!("Bearer {}", connection.token)),
            ("X-GitHub-Api-Version", "2022-11-28".to_string()),
            ("User-Agent", "dev-crash-flash-ai-studio".to_string()),
        ],
    )?;
    Ok(account_name_from_json(&json, &["login", "name"]))
}

fn test_gitlab_connection(connection: &ConnectionRecord) -> Result<Option<String>, String> {
    let base_url = normalize_base_url(&connection.base_url);
    fetch_json(
        &format!("{base_url}/api/v4/projects?membership=true&per_page=1"),
        vec![("PRIVATE-TOKEN", connection.token.clone())],
    )?;
    Ok(None)
}

fn test_trello_connection(connection: &ConnectionRecord) -> Result<Option<String>, String> {
    let api_key = connection.api_key.as_deref().unwrap_or_default().trim();
    let token = connection.token.trim();
    let json = fetch_json(
        &format!(
            "https://api.trello.com/1/members/me?key={}&token={}",
            percent_encode(api_key),
            percent_encode(token)
        ),
        vec![],
    )?;
    Ok(account_name_from_json(
        &json,
        &["username", "fullName", "name"],
    ))
}

fn account_name_from_json(json: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| json_string(json, key))
}

fn normalize_label_color(value: Option<String>) -> Option<String> {
    let value = value?.trim().trim_start_matches('#').to_ascii_lowercase();
    if matches!(value.len(), 3 | 6) && value.chars().all(|character| character.is_ascii_hexdigit())
    {
        Some(format!("#{value}"))
    } else {
        None
    }
}

fn normalize_external_labels(labels: Vec<ExternalLabel>) -> Vec<ExternalLabel> {
    let mut names = HashSet::new();
    labels
        .into_iter()
        .filter_map(|label| {
            let name = label.name.trim().to_string();
            if name.is_empty() || !names.insert(name.clone()) {
                return None;
            }
            Some(ExternalLabel {
                name,
                color: normalize_label_color(label.color),
            })
        })
        .collect()
}

fn trello_color(value: Option<String>) -> Option<String> {
    let value = value?;
    let family = value.trim().split(['_', '-']).find(|part| {
        matches!(
            *part,
            "green"
                | "yellow"
                | "orange"
                | "red"
                | "purple"
                | "blue"
                | "sky"
                | "lime"
                | "pink"
                | "black"
        )
    })?;
    let color = match family {
        "green" => "#61bd4f",
        "yellow" => "#f2d600",
        "orange" => "#ff9f1a",
        "red" => "#eb5a46",
        "purple" => "#c377e0",
        "blue" => "#0079bf",
        "sky" => "#00c2e0",
        "lime" => "#51e898",
        "pink" => "#ff78cb",
        "black" => "#344563",
        _ => return None,
    };
    Some(color.to_string())
}

fn trello_labels(json: &Value) -> Vec<ExternalLabel> {
    normalize_external_labels(
        json.get("labels")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|label| {
                Some(ExternalLabel {
                    name: json_string(label, "name")?,
                    color: trello_color(json_string(label, "color")),
                })
            })
            .collect(),
    )
}

fn github_labels(json: &Value) -> Vec<ExternalLabel> {
    normalize_external_labels(
        json.get("labels")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|label| {
                Some(ExternalLabel {
                    name: json_string(label, "name")?,
                    color: json_string(label, "color"),
                })
            })
            .collect(),
    )
}

fn gitlab_labels(
    connection: &ConnectionRecord,
    project_path: &str,
    json: &Value,
) -> Vec<ExternalLabel> {
    if json
        .get("labels")
        .and_then(Value::as_array)
        .is_none_or(Vec::is_empty)
    {
        return Vec::new();
    }

    let base_url = normalize_base_url(&connection.base_url);
    let catalog_url = format!(
        "{base_url}/api/v4/projects/{}/labels?include_ancestor_groups=true",
        percent_encode(project_path)
    );
    let catalog = fetch_paginated_json(
        &catalog_url,
        vec![("PRIVATE-TOKEN", connection.token.clone())],
    )
    .unwrap_or_default();

    gitlab_labels_with_catalog(json, &catalog)
}

fn gitlab_labels_with_catalog(json: &Value, catalog: &[Value]) -> Vec<ExternalLabel> {
    let colors = catalog
        .iter()
        .filter_map(|label| Some((json_string(label, "name")?, json_string(label, "color"))))
        .collect::<HashMap<_, _>>();

    normalize_external_labels(
        json.get("labels")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .map(|name| ExternalLabel {
                color: colors.get(&name).cloned().flatten(),
                name,
            })
            .collect(),
    )
}

fn fetch_trello_card(
    connection: &ConnectionRecord,
    parsed: &ParsedInputPayload,
) -> Result<ProviderMetadata, String> {
    let api_key = connection.api_key.as_deref().unwrap_or_default().trim();
    let token = connection.token.trim();
    if api_key.is_empty() || token.is_empty() {
        return Err("Trello API key and token are required".to_string());
    }
    let id = parsed
        .external_id
        .as_deref()
        .ok_or_else(|| "Trello card id is missing".to_string())?;
    let url = format!(
        "https://api.trello.com/1/cards/{}?key={}&token={}",
        percent_encode(id),
        percent_encode(api_key),
        percent_encode(token)
    );
    let json = fetch_json(&url, vec![])?;
    let parent_resource = json_string(&json, "idBoard")
        .and_then(|board_id| fetch_trello_board_parent_resource(&board_id, api_key, token).ok());
    let list_url = format!(
        "https://api.trello.com/1/cards/{}/list?fields=name,color&key={}&token={}",
        percent_encode(id),
        percent_encode(api_key),
        percent_encode(token)
    );
    let list_json = fetch_json(&list_url, vec![])?;
    let attachments_url = format!(
        "https://api.trello.com/1/cards/{}/attachments?key={}&token={}",
        percent_encode(id),
        percent_encode(api_key),
        percent_encode(token)
    );
    let attachments_json = fetch_json(&attachments_url, vec![])?;
    let card_url = json_string(&json, "url").or_else(|| parsed.url.clone());
    let comments = fetch_trello_card_comments(id, card_url.as_deref(), api_key, token)?;
    Ok(ProviderMetadata {
        title: json_string(&json, "name"),
        body: json_string(&json, "desc"),
        state: trello_list_state(&list_json),
        state_color: trello_color(json_string(&list_json, "color")),
        url: card_url,
        files: trello_attachment_files(&attachments_json),
        comments,
        labels: trello_labels(&json),
        parent_resource,
        ..ProviderMetadata::empty()
    })
}

fn fetch_trello_board_parent_resource(
    board_id: &str,
    api_key: &str,
    token: &str,
) -> Result<ProviderResourceMetadata, String> {
    let url = format!(
        "https://api.trello.com/1/boards/{}?fields=name,shortLink,shortUrl,url&key={}&token={}",
        percent_encode(board_id),
        percent_encode(api_key),
        percent_encode(token)
    );
    let json = fetch_json(&url, vec![])?;
    let external_id = json_string(&json, "shortLink").unwrap_or_else(|| board_id.to_string());
    let url = json_string(&json, "url")
        .or_else(|| json_string(&json, "shortUrl"))
        .unwrap_or_else(|| format!("https://trello.com/b/{external_id}"));
    let name = json_string(&json, "name").unwrap_or_else(|| format!("Trello board {external_id}"));

    Ok(ProviderResourceMetadata {
        provider: "trello".to_string(),
        kind: "trello_board".to_string(),
        external_id,
        url,
        name,
        icon_url: None,
    })
}

fn github_pull_request_state(json: &Value) -> Option<String> {
    if json_bool(json, "merged") == Some(true) {
        return Some("merged".to_string());
    }

    json_string(json, "state")
}

fn github_pull_request_target_branch(json: &Value) -> Option<String> {
    json.get("base").and_then(|base| json_string(base, "ref"))
}

fn fetch_github_pull_request(
    connection: &ConnectionRecord,
    parsed: &ParsedInputPayload,
) -> Result<ProviderMetadata, String> {
    let (repo_path, number) = split_github_external_id(parsed)?;
    let url = format!("https://api.github.com/repos/{repo_path}/pulls/{number}");
    let json = fetch_json(
        &url,
        vec![
            ("Authorization", format!("Bearer {}", connection.token)),
            ("X-GitHub-Api-Version", "2022-11-28".to_string()),
            ("User-Agent", "dev-crash-flash-ai-studio".to_string()),
        ],
    )?;
    let comments = fetch_github_pull_request_comments(connection, &repo_path, &number)?;
    Ok(ProviderMetadata {
        title: json_string(&json, "title"),
        body: json_string(&json, "body"),
        state: github_pull_request_state(&json),
        target_branch: github_pull_request_target_branch(&json),
        url: json_string(&json, "html_url").or_else(|| parsed.url.clone()),
        comments,
        labels: github_labels(&json),
        ..ProviderMetadata::empty()
    })
}

fn fetch_github_issue(
    connection: &ConnectionRecord,
    parsed: &ParsedInputPayload,
) -> Result<ProviderMetadata, String> {
    let (repo_path, number) = split_github_external_id(parsed)?;
    let url = format!("https://api.github.com/repos/{repo_path}/issues/{number}");
    let json = fetch_json(
        &url,
        vec![
            ("Authorization", format!("Bearer {}", connection.token)),
            ("X-GitHub-Api-Version", "2022-11-28".to_string()),
            ("User-Agent", "dev-crash-flash-ai-studio".to_string()),
        ],
    )?;
    Ok(ProviderMetadata {
        title: json_string(&json, "title"),
        body: json_string(&json, "body"),
        state: github_issue_state(&json),
        url: json_string(&json, "html_url").or_else(|| parsed.url.clone()),
        labels: github_labels(&json),
        ..ProviderMetadata::empty()
    })
}

fn fetch_gitlab_merge_request(
    connection: &ConnectionRecord,
    parsed: &ParsedInputPayload,
) -> Result<ProviderMetadata, String> {
    let (project_path, iid) = split_gitlab_external_id(parsed)?;
    let base_url = normalize_base_url(&connection.base_url);
    let url = format!(
        "{base_url}/api/v4/projects/{}/merge_requests/{}",
        percent_encode(&project_path),
        percent_encode(&iid)
    );
    let json = fetch_json(&url, vec![("PRIVATE-TOKEN", connection.token.clone())])?;
    let merge_request_url = json_string(&json, "web_url").or_else(|| parsed.url.clone());
    let comments = fetch_gitlab_merge_request_comments(
        connection,
        &project_path,
        &iid,
        merge_request_url.as_deref(),
    )?;
    let labels = gitlab_labels(connection, &project_path, &json);
    Ok(ProviderMetadata {
        title: json_string(&json, "title"),
        body: json_string(&json, "description"),
        state: json_string(&json, "state"),
        target_branch: json_string(&json, "target_branch"),
        url: merge_request_url,
        comments,
        labels,
        ..ProviderMetadata::empty()
    })
}

fn fetch_gitlab_issue(
    connection: &ConnectionRecord,
    parsed: &ParsedInputPayload,
) -> Result<ProviderMetadata, String> {
    let (project_path, iid) = split_gitlab_external_id(parsed)?;
    let base_url = normalize_base_url(&connection.base_url);
    let url = format!(
        "{base_url}/api/v4/projects/{}/issues/{}",
        percent_encode(&project_path),
        percent_encode(&iid)
    );
    let json = fetch_json(&url, vec![("PRIVATE-TOKEN", connection.token.clone())])?;
    let labels = gitlab_labels(connection, &project_path, &json);
    Ok(ProviderMetadata {
        title: json_string(&json, "title"),
        body: json_string(&json, "description"),
        state: json_string(&json, "state"),
        url: json_string(&json, "web_url").or_else(|| parsed.url.clone()),
        labels,
        ..ProviderMetadata::empty()
    })
}

fn split_github_external_id(parsed: &ParsedInputPayload) -> Result<(String, String), String> {
    let value = parsed
        .external_id
        .as_deref()
        .ok_or_else(|| "GitHub PR id is missing".to_string())?;
    let (repo, number) = value
        .rsplit_once('#')
        .ok_or_else(|| "GitHub PR id is invalid".to_string())?;
    Ok((repo.to_string(), number.to_string()))
}

fn split_gitlab_external_id(parsed: &ParsedInputPayload) -> Result<(String, String), String> {
    let value = parsed
        .external_id
        .as_deref()
        .ok_or_else(|| "GitLab MR id is missing".to_string())?;
    let (repo, number) = value
        .rsplit_once('!')
        .ok_or_else(|| "GitLab MR id is invalid".to_string())?;
    Ok((repo.to_string(), number.to_string()))
}

fn percent_encode(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn parse_rfc3339_millis(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.len() < 20 {
        return None;
    }
    let year = value.get(0..4)?.parse::<i32>().ok()?;
    let month = value.get(5..7)?.parse::<u32>().ok()?;
    let day = value.get(8..10)?.parse::<u32>().ok()?;
    let hour = value.get(11..13)?.parse::<i64>().ok()?;
    let minute = value.get(14..16)?.parse::<i64>().ok()?;
    let second = value.get(17..19)?.parse::<i64>().ok()?;
    let mut index = 19;
    let mut millis = 0_i64;

    if value.as_bytes().get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while value
            .as_bytes()
            .get(index)
            .is_some_and(|byte| byte.is_ascii_digit())
        {
            index += 1;
        }
        let fraction = value.get(fraction_start..index).unwrap_or("");
        let mut padded = fraction.chars().take(3).collect::<String>();
        while padded.len() < 3 {
            padded.push('0');
        }
        millis = padded.parse::<i64>().unwrap_or_default();
    }

    let timezone = value.get(index..)?;
    let offset_seconds = if timezone == "Z" {
        0
    } else if timezone.len() >= 6 {
        let sign = match timezone.as_bytes().first()? {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        let offset_hour = timezone.get(1..3)?.parse::<i64>().ok()?;
        let offset_minute = timezone.get(4..6)?.parse::<i64>().ok()?;
        sign * ((offset_hour * 60 + offset_minute) * 60)
    } else {
        return None;
    };

    let days = days_from_civil(year, month, day)?;
    let local_seconds = days * 86_400 + hour * 3_600 + minute * 60 + second;
    Some((local_seconds - offset_seconds) * 1_000 + millis)
}

fn add_days_to_date(date: &str, days: i64) -> Option<String> {
    let year = date.get(0..4)?.parse::<i32>().ok()?;
    let month = date.get(5..7)?.parse::<u32>().ok()?;
    let day = date.get(8..10)?.parse::<u32>().ok()?;
    let target_days = days_from_civil(year, month, day)? + days;
    let (year, month, day) = civil_from_days(target_days);
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    Some((era * 146_097 + day_of_era - 719_468) as i64)
}

fn civil_from_days(days: i64) -> (i32, u32, u32) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era as i32 + (era as i32) * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i32::from(month <= 2);
    (year, month as u32, day as u32)
}

fn json_string(json: &Value, key: &str) -> Option<String> {
    json.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn json_value_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) => Some(value.trim().to_string()).filter(|value| !value.is_empty()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn json_path_string(json: &Value, path: &[&str]) -> Option<String> {
    let mut current = json;
    for segment in path {
        current = if let Ok(index) = segment.parse::<usize>() {
            current.as_array()?.get(index)?
        } else {
            current.get(*segment)?
        };
    }
    json_value_string(Some(current))
}

fn json_bool(json: &Value, key: &str) -> Option<bool> {
    json.get(key).and_then(Value::as_bool)
}

fn json_path_bool(json: &Value, path: &[&str]) -> Option<bool> {
    let mut current = json;
    for segment in path {
        current = if let Ok(index) = segment.parse::<usize>() {
            current.as_array()?.get(index)?
        } else {
            current.get(*segment)?
        };
    }
    current.as_bool()
}

fn first_line(value: &str) -> String {
    value.lines().next().unwrap_or(value).trim().to_string()
}

fn first_non_empty_line(value: &str) -> String {
    value
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(value)
        .trim()
        .to_string()
}

fn title_case_words(value: &str) -> String {
    let mut normalized = String::new();
    let mut previous_was_lower_or_digit = false;
    for character in value.chars() {
        if character == '_' || character == '-' {
            normalized.push(' ');
            previous_was_lower_or_digit = false;
            continue;
        }
        if character.is_uppercase() && previous_was_lower_or_digit {
            normalized.push(' ');
        }
        previous_was_lower_or_digit = character.is_lowercase() || character.is_ascii_digit();
        normalized.push(character);
    }

    let words = normalized
        .split_whitespace()
        .filter(|word| !word.is_empty())
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => format!("{}{}", first.to_uppercase(), chars.as_str().to_lowercase()),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>();

    if words.is_empty() {
        value.to_string()
    } else {
        words.join(" ")
    }
}

fn trello_attachment_files(json: &Value) -> Vec<TaskFile> {
    json.as_array()
        .map(|attachments| {
            attachments
                .iter()
                .filter_map(trello_attachment_file)
                .collect()
        })
        .unwrap_or_default()
}

fn trello_attachment_file(json: &Value) -> Option<TaskFile> {
    if json_bool(json, "isUpload") != Some(true) {
        return None;
    }

    let url = json_string(json, "url")?;
    let name = json_string(json, "name").unwrap_or_else(|| url.clone());
    Some(TaskFile {
        id: json_string(json, "id").unwrap_or_else(|| url.clone()),
        name,
        url,
        source: "trello".to_string(),
        content_type: json_string(json, "mimeType"),
        bytes: json.get("bytes").and_then(Value::as_i64),
        created_at: json_string(json, "date"),
    })
}

fn trello_list_state(json: &Value) -> Option<String> {
    json_string(json, "name")
}

fn github_issue_state(json: &Value) -> Option<String> {
    json_string(json, "state")
}

#[tauri::command]
fn list_projects(state: tauri::State<'_, AppState>) -> Result<Vec<Project>, String> {
    let db = state.db.lock().map_err(db_error)?;
    let mut statement = db
        .prepare(
            "SELECT id, name, icon, color, created_at, updated_at FROM projects ORDER BY created_at ASC",
        )
        .map_err(db_error)?;
    let projects = statement
        .query_map([], row_to_project)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(projects)
}

#[tauri::command]
fn create_project(
    state: tauri::State<'_, AppState>,
    name: String,
    icon: Option<String>,
    color: Option<String>,
) -> Result<Project, String> {
    let db = state.db.lock().map_err(db_error)?;
    create_project_in_db(&db, name, icon, color).map_err(db_error)
}

#[tauri::command]
fn update_project(
    state: tauri::State<'_, AppState>,
    id: String,
    name: Option<String>,
    icon: Option<String>,
    color: Option<String>,
) -> Result<Project, String> {
    let db = state.db.lock().map_err(db_error)?;
    let existing = get_project(&db, &id)
        .map_err(db_error)?
        .ok_or_else(|| "Project not found".to_string())?;
    let updated_name = name.unwrap_or(existing.name);
    let updated_icon = icon.unwrap_or(existing.icon);
    let updated_color = color
        .map(|value| normalize_project_color(Some(value)))
        .unwrap_or(existing.color);
    let timestamp = now_millis();
    db.execute(
        "UPDATE projects SET name = ?1, icon = ?2, color = ?3, updated_at = ?4 WHERE id = ?5",
        params![updated_name, updated_icon, updated_color, timestamp, id],
    )
    .map_err(db_error)?;
    get_project(&db, &id)
        .map_err(db_error)?
        .ok_or_else(|| "Project not found".to_string())
}

#[tauri::command]
fn delete_project(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(db_error)?;
    db.execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(db_error)?;
    Ok(())
}

#[tauri::command]
fn list_project_resources(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<Vec<Resource>, String> {
    let db = state.db.lock().map_err(db_error)?;
    let mut statement = db
        .prepare(
            "SELECT id, project_id, provider, kind, external_id, url, name, icon_url, connection_id
             FROM resources WHERE project_id = ?1 ORDER BY provider ASC, name ASC",
        )
        .map_err(db_error)?;
    let resources = statement
        .query_map(params![project_id], row_to_resource)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(resources)
}

#[tauri::command]
fn connect_resource(
    state: tauri::State<'_, AppState>,
    input: ResourceInput,
) -> Result<Resource, String> {
    let db = state.db.lock().map_err(db_error)?;
    connect_resource_in_db(&db, input).map_err(db_error)
}

#[tauri::command]
fn disconnect_resource(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(db_error)?;
    db.execute("DELETE FROM resources WHERE id = ?1", params![id])
        .map_err(db_error)?;
    Ok(())
}

#[tauri::command]
fn list_local_resources(
    state: tauri::State<'_, AppState>,
    project_id: String,
    repo_url: Option<String>,
) -> Result<Vec<LocalResource>, String> {
    let db = state.db.lock().map_err(db_error)?;
    let normalized_repo_url = repo_url
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .and_then(normalize_repository_url);

    if let Some(normalized_repo_url) = normalized_repo_url {
        let mut statement = db
            .prepare(
                "SELECT id, project_id, provider, repo_url, path, name, created_at, updated_at
                 FROM local_resources
                 WHERE project_id = ?1 AND normalized_repo_url = ?2
                 ORDER BY updated_at DESC",
            )
            .map_err(db_error)?;
        let resources = statement
            .query_map(
                params![project_id, normalized_repo_url],
                row_to_local_resource,
            )
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        return Ok(resources);
    }

    let mut statement = db
        .prepare(
            "SELECT id, project_id, provider, repo_url, path, name, created_at, updated_at
             FROM local_resources
             WHERE project_id = ?1
             ORDER BY updated_at DESC",
        )
        .map_err(db_error)?;
    let resources = statement
        .query_map(params![project_id], row_to_local_resource)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(resources)
}

#[tauri::command]
fn save_local_resource(
    state: tauri::State<'_, AppState>,
    input: LocalResourceInput,
) -> Result<LocalResource, String> {
    let db = state.db.lock().map_err(db_error)?;
    save_local_resource_in_db(&db, input)
}

#[tauri::command]
fn delete_local_resource(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(db_error)?;
    db.execute("DELETE FROM local_resources WHERE id = ?1", params![id])
        .map_err(db_error)?;
    Ok(())
}

#[tauri::command]
fn checkout_pull_request_for_review(
    state: tauri::State<'_, AppState>,
    local_resource_id: String,
    provider: String,
    pr_url: String,
) -> Result<PullRequestCheckoutResult, String> {
    let db = state.db.lock().map_err(db_error)?;
    checkout_pull_request_for_review_in_db(&db, local_resource_id, provider, pr_url)
}

#[tauri::command]
fn load_review_diff(
    state: tauri::State<'_, AppState>,
    local_resource_id: String,
    branch: Option<String>,
    base_ref: Option<String>,
) -> Result<ReviewDiffResult, String> {
    let db = state.db.lock().map_err(db_error)?;
    load_review_diff_in_db(&db, local_resource_id, branch, base_ref)
}

#[tauri::command]
fn load_review_diff_file(
    state: tauri::State<'_, AppState>,
    local_resource_id: String,
    base_ref: String,
    branch: String,
    path: String,
) -> Result<ReviewDiffFile, String> {
    let db = state.db.lock().map_err(db_error)?;
    load_review_diff_file_in_db(&db, local_resource_id, base_ref, branch, path)
}

#[tauri::command]
fn list_review_comment_drafts(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<Vec<ReviewCommentDraft>, String> {
    let db = state.db.lock().map_err(db_error)?;
    list_review_comment_drafts_in_db(&db, &task_id)
}

#[tauri::command]
fn save_review_comment_draft(
    state: tauri::State<'_, AppState>,
    input: ReviewCommentDraftInput,
) -> Result<ReviewCommentDraft, String> {
    let db = state.db.lock().map_err(db_error)?;
    save_review_comment_draft_in_db(&db, input)
}

#[tauri::command]
fn delete_review_comment_draft(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(db_error)?;
    db.execute(
        "DELETE FROM review_comment_drafts WHERE id = ?1",
        params![id],
    )
    .map_err(db_error)?;
    Ok(())
}

#[tauri::command]
fn submit_review_comments(
    state: tauri::State<'_, AppState>,
    task_id: String,
    overall_body: Option<String>,
) -> Result<ReviewCommentSubmissionResult, String> {
    let db = state.db.lock().map_err(db_error)?;
    submit_review_comments_in_db(&db, &task_id, overall_body)
}

#[tauri::command]
fn create_task_from_input(
    state: tauri::State<'_, AppState>,
    input: String,
    parsed: ParsedInputPayload,
    project_id: Option<String>,
) -> Result<SmartTaskResult, String> {
    let db = state.db.lock().map_err(db_error)?;
    create_smart_task_in_db(&db, input, parsed, project_id)
}

fn normalize_smart_inbox_provider(provider: &str) -> Result<String, String> {
    let provider = provider.trim().to_ascii_lowercase();
    if ["github", "gitlab", "trello"].contains(&provider.as_str()) {
        Ok(provider)
    } else {
        Err("Unsupported smart inbox provider.".to_string())
    }
}

fn list_smart_inbox_provider_items_in_db(
    db: &SqliteConnection,
    provider: &str,
) -> Result<SmartInboxReviewRequestResult, String> {
    let mut statement = db
        .prepare(
            "SELECT i.provider, i.connection_id, c.name, i.source_id, i.source_name,
                    i.external_id, i.title, i.url,
                    i.context_path, i.context_detail, i.number, i.author,
                    i.review_requested_at, i.updated_at, i.created_at, i.sort_at,
                    i.sort_source, i.state
             FROM smart_inbox_provider_items i
             JOIN connections c ON c.id = i.connection_id
             WHERE i.provider = ?1
               AND i.source_id IS NOT NULL
               AND i.source_name IS NOT NULL
             ORDER BY COALESCE(i.sort_at, 0) DESC, i.title ASC",
        )
        .map_err(db_error)?;
    let mut items = statement
        .query_map(params![provider], |row| {
            Ok(SmartInboxReviewRequest {
                provider: row.get(0)?,
                connection_id: row.get(1)?,
                connection_name: row.get(2)?,
                source_id: row.get(3)?,
                source_name: row.get(4)?,
                external_id: row.get(5)?,
                title: row.get(6)?,
                url: row.get(7)?,
                context_path: row.get(8)?,
                context_detail: row.get(9)?,
                number: row.get(10)?,
                author: row.get(11)?,
                review_requested_at: row.get(12)?,
                updated_at: row.get(13)?,
                created_at: row.get(14)?,
                sort_at: row.get(15)?,
                sort_source: row.get(16)?,
                state: row.get(17)?,
                linked_task: None,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;

    let mut seen = HashSet::new();
    items.retain(|item| seen.insert(format!("{}:{}", item.provider, item.url)));

    let task_kind = match provider {
        "github" => "pull_request",
        "gitlab" => "merge_request",
        "trello" => "trello_card",
        _ => return Err("Unsupported smart inbox provider.".to_string()),
    };
    for item in &mut items {
        item.linked_task =
            get_latest_project_task_by_link(db, &item.provider, task_kind, &item.external_id)
                .map_err(db_error)?;
    }

    let mut warning_statement = db
        .prepare(
            "SELECT r.provider, r.connection_id, c.name, r.warning
             FROM smart_inbox_provider_sync_runs r
             JOIN connections c ON c.id = r.connection_id
             WHERE r.provider = ?1 AND r.status = 'error' AND r.warning IS NOT NULL
             ORDER BY c.name ASC",
        )
        .map_err(db_error)?;
    let warnings = warning_statement
        .query_map(params![provider], |row| {
            Ok(SmartInboxReviewRequestWarning {
                provider: row.get(0)?,
                connection_id: row.get(1)?,
                connection_name: row.get(2)?,
                message: row.get(3)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;

    let mut sync_statement = db
        .prepare(
            "SELECT r.provider, r.connection_id, c.name, r.status, r.synced_at
             FROM smart_inbox_provider_sync_runs r
             JOIN connections c ON c.id = r.connection_id
             WHERE r.provider = ?1
             ORDER BY c.name ASC",
        )
        .map_err(db_error)?;
    let sync_runs = sync_statement
        .query_map(params![provider], |row| {
            Ok(SmartInboxProviderSyncRun {
                provider: row.get(0)?,
                connection_id: row.get(1)?,
                connection_name: row.get(2)?,
                status: row.get(3)?,
                synced_at: row.get(4)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;

    Ok(SmartInboxReviewRequestResult {
        items,
        warnings,
        sync_runs,
    })
}

fn replace_smart_inbox_provider_items(
    db: &SqliteConnection,
    connection: &ConnectionRecord,
    items: &[SmartInboxReviewRequest],
) -> Result<(), String> {
    let transaction = db.unchecked_transaction().map_err(db_error)?;
    let fetched_at = now_millis();
    for item in items {
        transaction
            .execute(
                "INSERT INTO smart_inbox_provider_sources
                 (connection_id, provider, source_id, source_name, enabled, discovered_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)
                 ON CONFLICT(connection_id, provider, source_id) DO UPDATE SET
                   source_name = excluded.source_name, updated_at = excluded.updated_at",
                params![
                    connection.id,
                    connection.provider,
                    item.source_id,
                    item.source_name,
                    fetched_at,
                ],
            )
            .map_err(db_error)?;
    }
    transaction
        .execute(
            "DELETE FROM smart_inbox_provider_items WHERE connection_id = ?1 AND provider = ?2",
            params![connection.id, connection.provider],
        )
        .map_err(db_error)?;
    for item in items {
        let enabled = transaction
            .query_row(
                "SELECT enabled FROM smart_inbox_provider_sources
                 WHERE connection_id = ?1 AND provider = ?2 AND source_id = ?3",
                params![connection.id, connection.provider, item.source_id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(db_error)?;
        if !enabled {
            continue;
        }
        transaction
            .execute(
                "INSERT INTO smart_inbox_provider_items
                 (connection_id, provider, source_id, source_name, external_id, title, url, context_path, context_detail,
                  number, author, review_requested_at, updated_at, created_at, sort_at,
                  sort_source, state, fetched_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
                params![
                    connection.id,
                    connection.provider,
                    item.source_id,
                    item.source_name,
                    item.external_id,
                    item.title,
                    item.url,
                    item.context_path,
                    item.context_detail,
                    item.number,
                    item.author,
                    item.review_requested_at,
                    item.updated_at,
                    item.created_at,
                    item.sort_at,
                    item.sort_source,
                    item.state,
                    fetched_at,
                ],
            )
            .map_err(db_error)?;
    }
    transaction
        .execute(
            "INSERT INTO smart_inbox_provider_sync_runs
             (connection_id, provider, status, warning, synced_at)
             VALUES (?1, ?2, 'success', NULL, ?3)
             ON CONFLICT(connection_id, provider) DO UPDATE SET
               status = 'success', warning = NULL, synced_at = excluded.synced_at",
            params![connection.id, connection.provider, fetched_at],
        )
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)
}

fn list_smart_inbox_provider_sources_in_db(
    db: &SqliteConnection,
    provider: &str,
) -> Result<Vec<SmartInboxProviderSource>, String> {
    let mut statement = db
        .prepare(
            "SELECT s.provider, s.connection_id, c.name, s.source_id, s.source_name,
                    s.enabled, s.discovered_at, s.updated_at
             FROM smart_inbox_provider_sources s
             JOIN connections c ON c.id = s.connection_id
             WHERE s.provider = ?1
             ORDER BY c.name COLLATE NOCASE, s.source_name COLLATE NOCASE",
        )
        .map_err(db_error)?;
    let sources = statement
        .query_map(params![provider], |row| {
            Ok(SmartInboxProviderSource {
                provider: row.get(0)?,
                connection_id: row.get(1)?,
                connection_name: row.get(2)?,
                source_id: row.get(3)?,
                source_name: row.get(4)?,
                enabled: row.get(5)?,
                discovered_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(sources)
}

#[tauri::command]
fn list_smart_inbox_provider_sources(
    state: tauri::State<'_, AppState>,
    provider: String,
) -> Result<Vec<SmartInboxProviderSource>, String> {
    let provider = normalize_smart_inbox_provider(&provider)?;
    let db = state.db.lock().map_err(db_error)?;
    list_smart_inbox_provider_sources_in_db(&db, &provider)
}

#[tauri::command]
fn update_smart_inbox_provider_sources(
    state: tauri::State<'_, AppState>,
    provider: String,
    changes: Vec<SmartInboxProviderSourceChange>,
) -> Result<Vec<SmartInboxProviderSource>, String> {
    let provider = normalize_smart_inbox_provider(&provider)?;
    let db = state.db.lock().map_err(db_error)?;
    update_smart_inbox_provider_sources_in_db(&db, &provider, changes)
}

fn update_smart_inbox_provider_sources_in_db(
    db: &SqliteConnection,
    provider: &str,
    changes: Vec<SmartInboxProviderSourceChange>,
) -> Result<Vec<SmartInboxProviderSource>, String> {
    let transaction = db.unchecked_transaction().map_err(db_error)?;
    let updated_at = now_millis();
    for change in changes {
        let changed = transaction
            .execute(
                "UPDATE smart_inbox_provider_sources SET enabled = ?1, updated_at = ?2
                 WHERE connection_id = ?3 AND provider = ?4 AND source_id = ?5",
                params![
                    change.enabled,
                    updated_at,
                    change.connection_id,
                    provider,
                    change.source_id
                ],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err("Smart inbox source not found.".to_string());
        }
        if !change.enabled {
            transaction
                .execute(
                    "DELETE FROM smart_inbox_provider_items
                     WHERE connection_id = ?1 AND provider = ?2 AND source_id = ?3",
                    params![change.connection_id, provider, change.source_id],
                )
                .map_err(db_error)?;
        }
    }
    transaction.commit().map_err(db_error)?;
    list_smart_inbox_provider_sources_in_db(db, provider)
}

fn save_smart_inbox_provider_warning(
    db: &SqliteConnection,
    connection: &ConnectionRecord,
    message: &str,
) -> Result<(), String> {
    db.execute(
        "INSERT INTO smart_inbox_provider_sync_runs
         (connection_id, provider, status, warning, synced_at)
         VALUES (?1, ?2, 'error', ?3, ?4)
         ON CONFLICT(connection_id, provider) DO UPDATE SET
           status = 'error', warning = excluded.warning, synced_at = excluded.synced_at",
        params![connection.id, connection.provider, message, now_millis()],
    )
    .map_err(db_error)?;
    Ok(())
}

#[tauri::command]
fn list_smart_inbox_provider_items(
    state: tauri::State<'_, AppState>,
    provider: String,
) -> Result<SmartInboxReviewRequestResult, String> {
    let provider = normalize_smart_inbox_provider(&provider)?;
    let db = state.db.lock().map_err(db_error)?;
    list_smart_inbox_provider_items_in_db(&db, &provider)
}

#[tauri::command]
async fn sync_smart_inbox_provider_items(
    app_handle: tauri::AppHandle,
    provider: String,
) -> Result<SmartInboxReviewRequestResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let provider = normalize_smart_inbox_provider(&provider)?;
        let connections = {
            let state = app_handle.state::<AppState>();
            let db = state.db.lock().map_err(db_error)?;
            list_connections_in_db(&db)
                .map_err(db_error)?
                .into_iter()
                .filter(|connection| connection.provider == provider)
                .collect::<Vec<_>>()
        };

        for connection in connections {
            match fetch_connection_review_requests(&connection) {
                Ok(items) => {
                    let state = app_handle.state::<AppState>();
                    let db = state.db.lock().map_err(db_error)?;
                    replace_smart_inbox_provider_items(&db, &connection, &items)?;
                }
                Err(error) => {
                    let message = connection_test_error_message(&connection.provider, &error);
                    let state = app_handle.state::<AppState>();
                    let db = state.db.lock().map_err(db_error)?;
                    save_smart_inbox_provider_warning(&db, &connection, &message)?;
                }
            }
        }

        let state = app_handle.state::<AppState>();
        let db = state.db.lock().map_err(db_error)?;
        list_smart_inbox_provider_items_in_db(&db, &provider)
    })
    .await
    .map_err(|error| format!("Could not sync smart inbox provider: {error}"))?
}

#[tauri::command]
fn list_smart_inbox_todos(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<SmartInboxTodo>, String> {
    let db = state.db.lock().map_err(db_error)?;
    list_smart_inbox_todos_in_db(&db)
}

#[tauri::command]
fn create_smart_inbox_todo(
    state: tauri::State<'_, AppState>,
    input: SmartInboxTodoInput,
) -> Result<SmartInboxTodo, String> {
    let db = state.db.lock().map_err(db_error)?;
    create_smart_inbox_todo_in_db(&db, input)
}

#[tauri::command]
fn update_smart_inbox_todo(
    state: tauri::State<'_, AppState>,
    input: SmartInboxTodoUpdateInput,
) -> Result<SmartInboxTodo, String> {
    let db = state.db.lock().map_err(db_error)?;
    update_smart_inbox_todo_in_db(&db, input)
}

#[tauri::command]
fn delete_smart_inbox_todo(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(db_error)?;
    delete_smart_inbox_todo_in_db(&db, &id)
}

#[tauri::command]
async fn ocr_image_file(
    app_handle: tauri::AppHandle,
    path: String,
    mime_type: Option<String>,
) -> Result<OcrImageResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        ocr_image_file_in_app(&app_handle, &state, path, mime_type)
    })
    .await
    .map_err(|error| format!("Could not run OCR task: {error}"))?
}

#[tauri::command]
async fn ocr_image_bytes(
    app_handle: tauri::AppHandle,
    bytes: Vec<u8>,
    name: Option<String>,
    mime_type: Option<String>,
) -> Result<OcrImageResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        ocr_image_bytes_in_app(&app_handle, &state, bytes, name, mime_type)
    })
    .await
    .map_err(|error| format!("Could not run OCR task: {error}"))?
}

#[tauri::command]
fn read_email_file(path: String, mime_type: Option<String>) -> Result<EmailFileResult, String> {
    read_email_file_in_app(path, mime_type)
}

#[tauri::command]
fn read_email_bytes(bytes: Vec<u8>) -> Result<EmailFileResult, String> {
    read_email_bytes_in_app(&bytes)
}

#[tauri::command]
fn read_apple_mail_message(message_uri: String) -> Result<EmailFileResult, String> {
    read_apple_mail_message_in_app(message_uri)
}

#[tauri::command]
fn list_tasks(
    state: tauri::State<'_, AppState>,
    project_id: Option<String>,
) -> Result<Vec<Task>, String> {
    let db = state.db.lock().map_err(db_error)?;
    let sql = if project_id.is_some() {
        "SELECT t.id, t.project_id, t.title, t.body, t.status, t.source_url, t.created_at, t.updated_at,
                l.provider, l.kind, l.external_state_color
         FROM tasks t
         LEFT JOIN task_links l ON l.task_id = t.id
         WHERE t.project_id = ?1 ORDER BY t.created_at DESC"
    } else {
        "SELECT t.id, t.project_id, t.title, t.body, t.status, t.source_url, t.created_at, t.updated_at,
                l.provider, l.kind, l.external_state_color
         FROM tasks t
         LEFT JOIN task_links l ON l.task_id = t.id
         ORDER BY t.created_at DESC"
    };
    let mut statement = db.prepare(sql).map_err(db_error)?;
    let tasks = if let Some(project_id) = project_id {
        statement
            .query_map(params![project_id], row_to_task_with_source)
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?
    } else {
        statement
            .query_map([], row_to_task_with_source)
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?
    };
    Ok(tasks)
}

#[tauri::command]
fn update_task(
    state: tauri::State<'_, AppState>,
    id: String,
    title: Option<String>,
    body: Option<String>,
    status: Option<String>,
    project_id: Option<String>,
) -> Result<Task, String> {
    let db = state.db.lock().map_err(db_error)?;
    let existing = get_task(&db, &id)
        .map_err(db_error)?
        .ok_or_else(|| "Task not found".to_string())?;
    let timestamp = now_millis();
    db.execute(
        "UPDATE tasks SET title = ?1, body = ?2, status = ?3, project_id = ?4, updated_at = ?5 WHERE id = ?6",
        params![
            title.unwrap_or(existing.title),
            body.unwrap_or(existing.body),
            status.unwrap_or(existing.status),
            project_id.or(existing.project_id),
            timestamp,
            id
        ],
    )
    .map_err(db_error)?;
    get_task(&db, &id)
        .map_err(db_error)?
        .ok_or_else(|| "Task not found".to_string())
}

#[tauri::command]
fn delete_task(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(db_error)?;
    delete_task_in_db(&db, &id)
}

fn task_trello_boards_in_db(db: &SqliteConnection, task_id: &str) -> Result<Vec<Resource>, String> {
    let task = get_task(db, task_id)
        .map_err(db_error)?
        .ok_or_else(|| "Task not found.".to_string())?;
    let project_id = task.project_id.ok_or_else(|| {
        "The task must belong to a project before creating a Trello ticket.".to_string()
    })?;
    let mut statement = db
        .prepare(
            "SELECT id, project_id, provider, kind, external_id, url, name, icon_url, connection_id
             FROM resources
             WHERE project_id = ?1 AND provider = 'trello' AND kind = 'trello_board'
             ORDER BY name COLLATE NOCASE ASC",
        )
        .map_err(db_error)?;
    let boards = statement
        .query_map(params![project_id], row_to_resource)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(boards)
}

fn resolve_trello_board_connection(
    db: &SqliteConnection,
    resource: &Resource,
) -> Result<ConnectionRecord, String> {
    if let Some(connection_id) = resource.connection_id.as_deref() {
        if let Some(connection) = get_connection(db, connection_id).map_err(db_error)? {
            if connection.provider == "trello"
                && validate_connection_credentials(&connection).is_ok()
            {
                return Ok(connection);
            }
        }
    }

    let connection = list_enabled_connections(db, &resource.project_id)
        .map_err(db_error)?
        .into_iter()
        .map(|(connection, _)| connection)
        .find(|connection| connection.provider == "trello")
        .ok_or_else(|| {
            "Enable a Trello connection for this project before creating a ticket.".to_string()
        })?;
    validate_connection_credentials(&connection)?;
    Ok(connection)
}

fn prepare_trello_board_for_task(
    db: &SqliteConnection,
    task_id: &str,
    board_resource_id: &str,
    require_unlinked: bool,
) -> Result<(Task, Resource, ConnectionRecord), String> {
    let task = get_task(db, task_id)
        .map_err(db_error)?
        .ok_or_else(|| "Task not found.".to_string())?;
    let project_id = task.project_id.as_deref().ok_or_else(|| {
        "The task must belong to a project before creating a Trello ticket.".to_string()
    })?;
    if require_unlinked {
        let has_link = !list_task_links_in_db(db, task_id)
            .map_err(db_error)?
            .is_empty();
        if has_link || task.source_url.is_some() {
            return Err("This task already has an external resource.".to_string());
        }
    }
    let resource = get_resource_by_id(db, board_resource_id)
        .map_err(db_error)?
        .ok_or_else(|| "Trello board resource not found.".to_string())?;
    if resource.project_id != project_id
        || resource.provider != "trello"
        || resource.kind != "trello_board"
    {
        return Err(
            "The selected Trello board is not connected to this task's project.".to_string(),
        );
    }
    let connection = resolve_trello_board_connection(db, &resource)?;
    Ok((task, resource, connection))
}

fn persist_trello_ticket_conversion(
    db: &mut SqliteConnection,
    task_id: &str,
    board_resource_id: &str,
    card_id: &str,
    card_url: &str,
    title: &str,
    description: &str,
    status: &str,
    metadata: &ProviderMetadata,
) -> Result<TrelloTicketConversionResult, String> {
    let transaction = db.transaction().map_err(db_error)?;
    prepare_trello_board_for_task(&transaction, task_id, board_resource_id, true)?;
    link_task_resource_in_db(
        &transaction,
        task_id.to_string(),
        "trello".to_string(),
        "trello_card".to_string(),
        card_id.to_string(),
        card_url.to_string(),
        metadata,
    )
    .map_err(db_error)?;
    transaction
        .execute(
            "UPDATE tasks SET title = ?1, body = ?2, status = ?3, updated_at = ?4 WHERE id = ?5",
            params![title, description, status, now_millis(), task_id],
        )
        .map_err(db_error)?;
    transaction.commit().map_err(db_error)?;
    let task = get_task(db, task_id)
        .map_err(db_error)?
        .ok_or_else(|| "Converted task could not be reloaded.".to_string())?;
    let link = list_task_links_in_db(db, task_id)
        .map_err(db_error)?
        .into_iter()
        .next()
        .ok_or_else(|| "Converted Trello link could not be reloaded.".to_string())?;
    Ok(TrelloTicketConversionResult { task, link })
}

#[tauri::command]
fn list_task_trello_boards(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<Vec<Resource>, String> {
    let db = state.db.lock().map_err(db_error)?;
    task_trello_boards_in_db(&db, &task_id)
}

#[tauri::command]
async fn list_trello_board_templates(
    app_handle: tauri::AppHandle,
    task_id: String,
    board_resource_id: String,
) -> Result<TrelloBoardTemplates, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let (resource, connection) = {
            let db = state.db.lock().map_err(db_error)?;
            let (_, resource, connection) =
                prepare_trello_board_for_task(&db, &task_id, &board_resource_id, true)?;
            (resource, connection)
        };
        fetch_trello_board_templates(&connection, &resource.external_id)
            .map_err(|error| format!("Could not load Trello templates: {error}"))
    })
    .await
    .map_err(|error| format!("Could not load Trello templates: {error}"))?
}

#[tauri::command]
async fn convert_task_to_trello_ticket(
    app_handle: tauri::AppHandle,
    task_id: String,
    board_resource_id: String,
    template_card_id: String,
    list_id: String,
    title: String,
    description: String,
) -> Result<TrelloTicketConversionResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let title = title.trim().to_string();
        if title.is_empty() {
            return Err("Ticket title is required.".to_string());
        }

        let state = app_handle.state::<AppState>();
        let (resource, connection) = {
            let db = state.db.lock().map_err(db_error)?;
            let (_, resource, connection) =
                prepare_trello_board_for_task(&db, &task_id, &board_resource_id, true)?;
            (resource, connection)
        };
        let board_data = fetch_trello_board_templates(&connection, &resource.external_id)
            .map_err(|error| format!("Could not validate the selected Trello template: {error}"))?;
        if !board_data.templates.iter().any(|template| template.id == template_card_id) {
            return Err("The selected card is not a template on this Trello board.".to_string());
        }
        let destination_list = board_data
            .lists
            .iter()
            .find(|list| list.id == list_id)
            .ok_or_else(|| "The selected destination list is not open on this Trello board.".to_string())?;

        let created = create_trello_card_from_template(
            &connection,
            &template_card_id,
            &list_id,
            &title,
            &description,
        )?;
        let card_id = json_string(&created, "id")
            .ok_or_else(|| "Trello created a card without returning its ID.".to_string())?;
        let card_url = json_string(&created, "url")
            .or_else(|| json_string(&created, "shortUrl"))
            .unwrap_or_else(|| format!("https://trello.com/c/{card_id}"));
        let metadata = ProviderMetadata {
            connection_id: Some(connection.id.clone()),
            title: Some(title.clone()),
            body: Some(description.clone()),
            state: Some(destination_list.name.clone()),
            state_color: destination_list.color.clone(),
            url: Some(card_url.clone()),
            fetched_at: Some(now_millis()),
            parent_resource: Some(ProviderResourceMetadata {
                provider: resource.provider.clone(),
                kind: resource.kind.clone(),
                external_id: resource.external_id.clone(),
                url: resource.url.clone(),
                name: resource.name.clone(),
                icon_url: resource.icon_url.clone(),
            }),
            ..ProviderMetadata::empty()
        };

        let persisted = (|| {
            let mut db = state.db.lock().map_err(db_error)?;
            persist_trello_ticket_conversion(
                &mut db,
                &task_id,
                &board_resource_id,
                &card_id,
                &card_url,
                &title,
                &description,
                &destination_list.name,
                &metadata,
            )
        })();

        match persisted {
            Ok(result) => Ok(result),
            Err(error) => match delete_trello_card(&connection, &card_id) {
                Ok(()) => Err(format!("Could not save the converted task: {error}")),
                Err(cleanup_error) => Err(format!(
                    "Could not save the converted task: {error}. The Trello card was created but could not be removed: {cleanup_error}"
                )),
            },
        }
    })
    .await
    .map_err(|error| format!("Could not create Trello ticket: {error}"))?
}

#[tauri::command]
fn link_task_resource(
    state: tauri::State<'_, AppState>,
    task_id: String,
    provider: String,
    kind: String,
    external_id: String,
    url: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(db_error)?;
    link_task_resource_in_db(
        &db,
        task_id,
        provider,
        kind,
        external_id,
        url,
        &ProviderMetadata::empty(),
    )
    .map_err(db_error)
}

#[tauri::command]
fn list_task_links(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<Vec<TaskLink>, String> {
    let db = state.db.lock().map_err(db_error)?;
    list_task_links_in_db(&db, &task_id).map_err(db_error)
}

#[tauri::command]
async fn refresh_task_external_details(
    app_handle: tauri::AppHandle,
    task_id: String,
) -> Result<RefreshTaskExternalDetailsResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let db = state.db.lock().map_err(db_error)?;
        refresh_task_external_details_in_db(&db, task_id)
    })
    .await
    .map_err(|error| format!("Could not refresh external task details: {error}"))?
}

#[tauri::command]
fn list_task_relations(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<Vec<TaskRelationView>, String> {
    let db = state.db.lock().map_err(db_error)?;
    let mut statement = db
        .prepare(
            "SELECT r.id, r.source_task_id, r.target_task_id, r.relation_type, r.created_at,
                    t.id, t.project_id, t.title, t.body, t.status, t.source_url, t.created_at, t.updated_at,
                    l.provider, l.kind, l.external_state_color
             FROM task_relations r
             INNER JOIN tasks t ON t.id = CASE WHEN r.source_task_id = ?1 THEN r.target_task_id ELSE r.source_task_id END
             LEFT JOIN task_links l ON l.task_id = t.id
             WHERE r.source_task_id = ?1 OR r.target_task_id = ?1
             ORDER BY r.created_at DESC",
        )
        .map_err(db_error)?;
    let relations = statement
        .query_map(params![task_id], row_to_task_relation_view)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(relations)
}

#[tauri::command]
fn save_task_relation(
    state: tauri::State<'_, AppState>,
    input: TaskRelationInput,
) -> Result<TaskRelationView, String> {
    let db = state.db.lock().map_err(db_error)?;
    save_task_relation_in_db(&db, input)
}

#[tauri::command]
fn delete_task_relation(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(db_error)?;
    db.execute("DELETE FROM task_relations WHERE id = ?1", params![id])
        .map_err(db_error)?;
    Ok(())
}

#[tauri::command]
fn list_connections(state: tauri::State<'_, AppState>) -> Result<Vec<ConnectionRecord>, String> {
    let db = state.db.lock().map_err(db_error)?;
    list_connections_in_db(&db).map_err(db_error)
}

#[tauri::command]
fn save_connection(
    state: tauri::State<'_, AppState>,
    input: ConnectionInput,
) -> Result<ConnectionRecord, String> {
    let db = state.db.lock().map_err(db_error)?;
    save_connection_in_db(&db, input).map_err(db_error)
}

#[tauri::command]
fn delete_connection(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(db_error)?;
    db.execute("DELETE FROM connections WHERE id = ?1", params![id])
        .map_err(db_error)?;
    Ok(())
}

#[tauri::command]
fn list_ai_prompts(state: tauri::State<'_, AppState>) -> Result<Vec<AiPromptRecord>, String> {
    let db = state.db.lock().map_err(db_error)?;
    list_ai_prompts_in_db(&db)
}

#[tauri::command]
fn save_ai_prompt(
    state: tauri::State<'_, AppState>,
    input: AiPromptInput,
) -> Result<AiPromptRecord, String> {
    let db = state.db.lock().map_err(db_error)?;
    save_ai_prompt_in_db(&db, input)
}

#[tauri::command]
fn delete_ai_prompt(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(db_error)?;
    delete_ai_prompt_in_db(&db, &id)
}

#[tauri::command]
fn open_ai_prompt_thread(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    input: OpenAiPromptThreadInput,
) -> Result<String, String> {
    let deep_link = {
        let db = state.db.lock().map_err(db_error)?;
        prepare_ai_prompt_thread_in_db(&db, &input)?
    };
    app.opener()
        .open_url(&deep_link, None::<&str>)
        .map_err(|error| format!("Could not open the AI Prompt: {error}"))?;
    Ok(deep_link)
}

#[tauri::command]
fn list_browser_settings(state: tauri::State<'_, AppState>) -> Result<BrowserSettings, String> {
    let db = state.db.lock().map_err(db_error)?;
    let browser_bundle_id =
        get_app_setting(&db, BROWSER_BUNDLE_ID_SETTING_KEY).map_err(db_error)?;

    #[cfg(target_os = "macos")]
    let detected_browser_bundle_id = macos_default_browser_bundle_id();
    #[cfg(not(target_os = "macos"))]
    let detected_browser_bundle_id = None;

    Ok(BrowserSettings {
        detected_browser_bundle_id,
        browser_bundle_id,
    })
}

#[tauri::command]
fn save_browser_settings(
    state: tauri::State<'_, AppState>,
    input: BrowserSettingsInput,
) -> Result<BrowserSettings, String> {
    {
        let db = state.db.lock().map_err(db_error)?;
        set_app_setting(
            &db,
            BROWSER_BUNDLE_ID_SETTING_KEY,
            input.browser_bundle_id.as_deref(),
        )
        .map_err(db_error)?;
    }

    list_browser_settings(state)
}

#[tauri::command]
fn list_directories(state: tauri::State<'_, AppState>) -> Result<Vec<DirectoryRecord>, String> {
    let db = state.db.lock().map_err(db_error)?;
    let mut statement = db
        .prepare(
            "SELECT id, path, name, created_at, updated_at
             FROM directories ORDER BY updated_at DESC",
        )
        .map_err(db_error)?;
    let directories = statement
        .query_map([], row_to_directory)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(directories)
}

#[tauri::command]
fn save_directory(
    state: tauri::State<'_, AppState>,
    input: DirectoryInput,
) -> Result<DirectoryRecord, String> {
    let db = state.db.lock().map_err(db_error)?;
    save_directory_in_db(&db, input)
}

#[tauri::command]
fn delete_directory(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let db = state.db.lock().map_err(db_error)?;
    db.execute("DELETE FROM directories WHERE id = ?1", params![id])
        .map_err(db_error)?;
    Ok(())
}

#[tauri::command]
fn list_recent_directory_files(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RecentDirectoryFile>, String> {
    let db = state.db.lock().map_err(db_error)?;
    list_recent_directory_files_in_db(&db, 5)
}

#[tauri::command]
fn test_connection(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<TestConnectionResult, String> {
    let db = state.db.lock().map_err(db_error)?;
    let connection = get_connection(&db, &id)
        .map_err(db_error)?
        .ok_or_else(|| "Connection not found".to_string())?;
    Ok(test_connection_with_record(&connection))
}

#[tauri::command]
fn list_project_connections(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<Vec<String>, String> {
    let db = state.db.lock().map_err(db_error)?;
    let mut statement = db
        .prepare(
            "SELECT connection_id FROM project_connections WHERE project_id = ?1 ORDER BY enabled_at DESC",
        )
        .map_err(db_error)?;
    let connection_ids = statement
        .query_map(params![project_id], |row| row.get(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(connection_ids)
}

#[tauri::command]
fn set_project_connections(
    state: tauri::State<'_, AppState>,
    project_id: String,
    connection_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    let db = state.db.lock().map_err(db_error)?;
    db.execute(
        "DELETE FROM project_connections WHERE project_id = ?1",
        params![&project_id],
    )
    .map_err(db_error)?;
    let timestamp = now_millis();
    for connection_id in connection_ids {
        db.execute(
            "INSERT OR IGNORE INTO project_connections (project_id, connection_id, enabled_at)
             VALUES (?1, ?2, ?3)",
            params![&project_id, &connection_id, timestamp],
        )
        .map_err(db_error)?;
    }
    let mut statement = db
        .prepare(
            "SELECT connection_id FROM project_connections WHERE project_id = ?1 ORDER BY enabled_at DESC",
        )
        .map_err(db_error)?;
    let connection_ids = statement
        .query_map(params![project_id], |row| row.get(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(connection_ids)
}

#[tauri::command]
fn list_calendar_accounts(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<calendar::CalendarAccount>, String> {
    let db = state.db.lock().map_err(db_error)?;
    calendar::list_accounts(&db)
}

#[tauri::command]
async fn connect_google_account(
    app: tauri::AppHandle,
    account_id: Option<String>,
) -> Result<calendar::CalendarAccount, String> {
    if GOOGLE_OAUTH_ACTIVE.swap(true, Ordering::SeqCst) {
        return Err("Google sign-in is already in progress.".to_string());
    }
    GOOGLE_OAUTH_CANCELLED.store(false, Ordering::SeqCst);

    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let db = state.db.lock().map_err(db_error)?;
        calendar::connect_google_account(
            &db,
            now_millis(),
            account_id.as_deref(),
            |url| {
                app.opener()
                    .open_url(url, None::<&str>)
                    .map_err(|error| error.to_string())
            },
            || GOOGLE_OAUTH_CANCELLED.load(Ordering::SeqCst),
        )
    })
    .await
    .map_err(|error| format!("Google sign-in task failed: {error}"));

    GOOGLE_OAUTH_ACTIVE.store(false, Ordering::SeqCst);
    result?
}

#[tauri::command]
fn cancel_google_account_connection() {
    GOOGLE_OAUTH_CANCELLED.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn update_calendar_service(
    state: tauri::State<'_, AppState>,
    input: calendar::CalendarServiceInput,
) -> Result<calendar::CalendarAccount, String> {
    let db = state.db.lock().map_err(db_error)?;
    calendar::update_calendar_service(&db, input, now_millis())
}

#[tauri::command]
fn save_calendar_subscription(
    state: tauri::State<'_, AppState>,
    input: calendar::CalendarSubscriptionInput,
) -> Result<calendar::CalendarAccount, String> {
    let db = state.db.lock().map_err(db_error)?;
    calendar::save_calendar_subscription(&db, input, now_millis())
}

#[tauri::command]
fn save_caldav_account(
    state: tauri::State<'_, AppState>,
    input: calendar::CalDavAccountInput,
) -> Result<calendar::CalendarAccount, String> {
    let db = state.db.lock().map_err(db_error)?;
    calendar::save_caldav_account(&db, input, now_millis(), || new_id("calendar_account"))
}

#[tauri::command]
fn refresh_calendar_collections(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<calendar::CalendarAccount, String> {
    let db = state.db.lock().map_err(db_error)?;
    calendar::refresh_collections(&db, &account_id, now_millis())
}

#[tauri::command]
fn update_calendar_collections(
    state: tauri::State<'_, AppState>,
    selections: Vec<calendar::CalendarSelectionInput>,
) -> Result<Vec<calendar::CalendarAccount>, String> {
    let db = state.db.lock().map_err(db_error)?;
    calendar::update_collections(&db, selections)?;
    calendar::list_accounts(&db)
}

#[tauri::command]
fn test_calendar_account(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<String, String> {
    let db = state.db.lock().map_err(db_error)?;
    calendar::test_account(&db, &account_id)
}

#[tauri::command]
fn delete_calendar_account(
    state: tauri::State<'_, AppState>,
    account_id: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(db_error)?;
    calendar::delete_account(&db, &account_id)
}

#[tauri::command]
fn list_calendar_events(
    state: tauri::State<'_, AppState>,
    date: String,
    start_at: i64,
    end_at: i64,
) -> Result<calendar::CalendarResult, String> {
    let db = state.db.lock().map_err(db_error)?;
    calendar::list_events(&db, &date, start_at, end_at)
}

#[tauri::command]
async fn sync_calendar_events(
    app: tauri::AppHandle,
    date: String,
    start_at: i64,
    end_at: i64,
) -> Result<calendar::CalendarResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db_path = app.state::<AppState>().db_path.clone();
        let db = SqliteConnection::open(db_path).map_err(db_error)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(db_error)?;
        calendar::sync_events(&db, &date, start_at, end_at, now_millis())
    })
    .await
    .map_err(|error| format!("Calendar sync task failed: {error}"))?
}

#[tauri::command]
fn list_activities(
    state: tauri::State<'_, AppState>,
    date: String,
    start_at: i64,
    end_at: i64,
) -> Result<ActivityResult, String> {
    let db = state.db.lock().map_err(db_error)?;
    list_activities_in_db(&db, &date, start_at, end_at)
}

#[tauri::command]
async fn sync_activities(
    app: tauri::AppHandle,
    date: String,
    start_at: i64,
    end_at: i64,
) -> Result<ActivityResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db_path = app.state::<AppState>().db_path.clone();
        let mut db = SqliteConnection::open(db_path).map_err(db_error)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(db_error)?;
        let fetched_at = now_millis();
        list_connections_in_db(&db)
            .map_err(db_error)?
            .into_iter()
            .try_for_each(|connection| {
                let result = validate_connection_credentials(&connection).and_then(|_| {
                    fetch_connection_activities(&connection, &date, start_at, end_at)
                });

                match result {
                    Ok(activities) => {
                        if connection.provider == "gitlab" {
                            replace_gitlab_activity_sync_in_db(
                                &mut db,
                                &connection.id,
                                &date,
                                start_at,
                                end_at,
                                &activities,
                                fetched_at,
                            )
                            .map_err(db_error)?;
                        } else {
                            for activity in activities {
                                upsert_activity_in_db(&db, &activity, fetched_at)
                                    .map_err(db_error)?;
                            }
                            save_activity_sync_run_in_db(
                                &db,
                                &connection.id,
                                &date,
                                "success",
                                None,
                                fetched_at,
                            )
                            .map_err(db_error)?;
                        }
                    }
                    Err(error) => {
                        save_activity_sync_run_in_db(
                            &db,
                            &connection.id,
                            &date,
                            "failed",
                            Some(&connection_test_error_message(&connection.provider, &error)),
                            fetched_at,
                        )
                        .map_err(db_error)?;
                    }
                }
                Ok::<(), String>(())
            })?;

        list_activities_in_db(&db, &date, start_at, end_at)
    })
    .await
    .map_err(|error| format!("Activity sync task failed: {error}"))?
}

#[tauri::command]
async fn resolve_trello_tickets(
    app: tauri::AppHandle,
    input: ResolveTrelloTicketsInput,
) -> Result<ResolveTrelloTicketsResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let db_path = app.state::<AppState>().db_path.clone();
        let db = SqliteConnection::open(db_path).map_err(db_error)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(db_error)?;
        let connections = list_connections_in_db(&db)
            .map_err(db_error)?
            .into_iter()
            .filter(|connection| connection.provider == "trello")
            .collect::<Vec<_>>();
        let mut seen = HashSet::new();
        let mut tickets = Vec::new();
        let mut warnings = Vec::new();

        for url in input.urls {
            let Some(external_id) = trello_card_short_link_from_url(&url) else {
                warnings.push(format!("Could not recognize Trello ticket URL: {url}"));
                continue;
            };
            if !seen.insert(external_id.clone()) {
                continue;
            }
            let mut resolved = None;
            for connection in &connections {
                if let Ok(ticket) = fetch_resolved_trello_ticket(connection, &external_id) {
                    resolved = Some(ticket);
                    break;
                }
            }
            if let Some(ticket) = resolved {
                tickets.push(ticket);
            } else {
                warnings.push(format!(
                    "Could not load Trello ticket {external_id} with the configured connections."
                ));
            }
        }

        Ok(ResolveTrelloTicketsResult { tickets, warnings })
    })
    .await
    .map_err(|error| format!("Trello ticket resolution task failed: {error}"))?
}

#[tauri::command]
fn list_pull_requests(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<Vec<PullRequestRecord>, String> {
    let db = state.db.lock().map_err(db_error)?;
    let mut statement = db
        .prepare(
            "SELECT id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, connection_id, external_title, external_body, external_state, target_branch, fetched_at, created_at, updated_at
             FROM pull_requests WHERE project_id = ?1 ORDER BY updated_at DESC",
        )
        .map_err(db_error)?;
    let pull_requests = statement
        .query_map(params![project_id], row_to_pull_request)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(pull_requests)
}

#[tauri::command]
fn save_pull_request(
    state: tauri::State<'_, AppState>,
    input: PullRequestInput,
) -> Result<PullRequestSaveResult, String> {
    let db = state.db.lock().map_err(db_error)?;
    let metadata = input
        .parsed
        .as_ref()
        .map(|parsed| fetch_provider_metadata(&db, &input.project_id, parsed))
        .unwrap_or_else(ProviderMetadata::empty);
    let title = metadata
        .title
        .clone()
        .or(input.external_title.clone())
        .unwrap_or(input.title);
    let pr_url = metadata.url.clone().unwrap_or(input.pr_url);
    let timestamp = now_millis();
    let id = input.id.unwrap_or_else(|| new_id("pr"));
    let exists: Option<String> = db
        .query_row(
            "SELECT id FROM pull_requests WHERE id = ?1 OR pr_url = ?2 LIMIT 1",
            params![id, pr_url],
            |row| row.get(0),
        )
        .optional()
        .map_err(db_error)?;
    let target_id = exists.unwrap_or(id);

    let row_exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pull_requests WHERE id = ?1)",
            params![target_id],
            |row| row.get(0),
        )
        .map_err(db_error)?;

    if row_exists {
        db.execute(
            "UPDATE pull_requests
             SET project_id = ?1, provider = ?2, repo_url = ?3, pr_url = ?4, title = ?5,
                 status = ?6, review_notes = ?7, test_state = ?8, connection_id = ?9,
                 external_title = ?10, external_body = ?11, external_state = ?12, target_branch = ?13, fetched_at = ?14,
                 updated_at = ?15
             WHERE id = ?16",
            params![
                input.project_id,
                input.provider,
                input.repo_url,
                pr_url,
                title,
                input.status,
                input.review_notes,
                input.test_state,
                metadata
                    .connection_id
                    .clone()
                    .or(input.connection_id.clone()),
                metadata.title.clone().or(input.external_title.clone()),
                metadata.body.clone().or(input.external_body.clone()),
                metadata.state.clone().or(input.external_state.clone()),
                metadata
                    .target_branch
                    .clone()
                    .or(input.target_branch.clone()),
                metadata.fetched_at.or(input.fetched_at),
                timestamp,
                target_id
            ],
        )
        .map_err(db_error)?;
    } else {
        db.execute(
            "INSERT INTO pull_requests
             (id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, connection_id, external_title, external_body, external_state, target_branch, fetched_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
            params![
                target_id,
                input.project_id,
                input.provider,
                input.repo_url,
                pr_url,
                title,
                input.status,
                input.review_notes,
                input.test_state,
                metadata.connection_id.clone().or(input.connection_id.clone()),
                metadata.title.clone().or(input.external_title.clone()),
                metadata.body.clone().or(input.external_body.clone()),
                metadata.state.clone().or(input.external_state.clone()),
                metadata
                    .target_branch
                    .clone()
                    .or(input.target_branch.clone()),
                metadata.fetched_at.or(input.fetched_at),
                timestamp,
                timestamp
            ],
        )
        .map_err(db_error)?;
    }

    let pull_request = db.query_row(
        "SELECT id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, connection_id, external_title, external_body, external_state, target_branch, fetched_at, created_at, updated_at
         FROM pull_requests WHERE id = ?1",
        params![target_id],
        row_to_pull_request,
    )
    .map_err(db_error)?;
    Ok(PullRequestSaveResult {
        pull_request,
        notice: metadata.notice.clone(),
    })
}

#[tauri::command]
fn update_pull_request_review_state(
    state: tauri::State<'_, AppState>,
    id: String,
    status: Option<String>,
    review_notes: Option<String>,
    test_state: Option<String>,
) -> Result<PullRequestRecord, String> {
    let db = state.db.lock().map_err(db_error)?;
    let existing = db
        .query_row(
            "SELECT id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, connection_id, external_title, external_body, external_state, target_branch, fetched_at, created_at, updated_at
             FROM pull_requests WHERE id = ?1",
            params![id],
            row_to_pull_request,
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "Pull request not found".to_string())?;
    let timestamp = now_millis();
    db.execute(
        "UPDATE pull_requests SET status = ?1, review_notes = ?2, test_state = ?3, updated_at = ?4 WHERE id = ?5",
        params![
            status.unwrap_or(existing.status),
            review_notes.unwrap_or(existing.review_notes),
            test_state.unwrap_or(existing.test_state),
            timestamp,
            id
        ],
    )
    .map_err(db_error)?;
    db.query_row(
        "SELECT id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, connection_id, external_title, external_body, external_state, target_branch, fetched_at, created_at, updated_at
         FROM pull_requests WHERE id = ?1",
        params![id],
        row_to_pull_request,
    )
    .map_err(db_error)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> SqliteConnection {
        let db = SqliteConnection::open_in_memory().expect("open in-memory database");
        init_database(&db).expect("initialize database");
        db
    }

    #[test]
    fn quick_capture_centers_on_a_secondary_monitor_with_negative_coordinates() {
        assert_eq!(
            centered_origin(-1920.0, 24.0, 1920.0, 1056.0, 640.0, 180.0),
            (-1280.0, 462.0)
        );
    }

    #[test]
    fn quick_capture_uses_work_area_origin_when_window_is_larger() {
        assert_eq!(
            centered_origin(-800.0, -200.0, 500.0, 120.0, 640.0, 180.0),
            (-800.0, -200.0)
        );
    }

    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    #[test]
    fn quick_capture_shortcuts_normalize_and_require_a_primary_modifier() {
        let normalized = normalize_quick_capture_shortcut("CommandOrControl+Shift+Space")
            .expect("normalize default shortcut");
        assert!(normalized.ends_with("Space"));
        assert!(normalized.contains("shift"));
        assert!(normalize_quick_capture_shortcut("KeyK").is_err());
        assert!(normalize_quick_capture_shortcut("Shift+KeyK").is_err());
        assert_eq!(
            normalize_quick_capture_shortcut("Alt+KeyK").expect("normalize alt shortcut"),
            "alt+KeyK"
        );
    }

    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    #[test]
    fn quick_capture_shortcut_setting_persists_and_resets_to_default() {
        let db = memory_db();
        persist_quick_capture_shortcut(&db, "alt+KeyK").expect("persist shortcut");
        assert_eq!(
            load_quick_capture_shortcut(&db).expect("load shortcut"),
            "alt+KeyK"
        );

        let default = normalize_quick_capture_shortcut(DEFAULT_QUICK_CAPTURE_SHORTCUT)
            .expect("normalize default");
        persist_quick_capture_shortcut(&db, &default).expect("reset shortcut");
        assert_eq!(
            get_app_setting(&db, QUICK_CAPTURE_SHORTCUT_SETTING_KEY).expect("read setting"),
            None
        );
        assert_eq!(
            load_quick_capture_shortcut(&db).expect("load default"),
            default
        );
    }

    #[cfg(any(target_os = "macos", windows, target_os = "linux"))]
    #[test]
    fn malformed_quick_capture_shortcut_falls_back_and_is_removed() {
        let db = memory_db();
        set_app_setting(&db, QUICK_CAPTURE_SHORTCUT_SETTING_KEY, Some("Shift+KeyK"))
            .expect("store malformed shortcut");

        let loaded = load_quick_capture_shortcut(&db).expect("fall back to default");
        assert_eq!(
            loaded,
            normalize_quick_capture_shortcut(DEFAULT_QUICK_CAPTURE_SHORTCUT)
                .expect("normalize default")
        );
        assert_eq!(
            get_app_setting(&db, QUICK_CAPTURE_SHORTCUT_SETTING_KEY).expect("read setting"),
            None
        );
    }

    fn column_exists(db: &SqliteConnection, table: &str, column: &str) -> bool {
        let mut statement = db
            .prepare(&format!("PRAGMA table_info({table})"))
            .expect("prepare table info");
        statement
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table info")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect columns")
            .contains(&column.to_string())
    }

    fn temp_test_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{name}_{}", new_id("test")))
    }

    fn parsed_text(title: &str) -> ParsedInputPayload {
        ParsedInputPayload {
            kind: "text".to_string(),
            provider: None,
            external_id: None,
            url: None,
            title: title.to_string(),
            repo_url: None,
        }
    }

    fn parsed_gitlab(url: &str, host: &str) -> ParsedInputPayload {
        ParsedInputPayload {
            kind: "merge_request".to_string(),
            provider: Some("gitlab".to_string()),
            external_id: Some("group/app!17".to_string()),
            url: Some(url.to_string()),
            title: "group/app MR !17".to_string(),
            repo_url: Some(format!("https://{host}/group/app")),
        }
    }

    fn parsed_github_pull_request(url: &str) -> ParsedInputPayload {
        ParsedInputPayload {
            kind: "pull_request".to_string(),
            provider: Some("github".to_string()),
            external_id: Some("owner/repo#42".to_string()),
            url: Some(url.to_string()),
            title: "owner/repo PR #42".to_string(),
            repo_url: Some("https://github.com/owner/repo".to_string()),
        }
    }

    fn parsed_trello_card(url: &str) -> ParsedInputPayload {
        ParsedInputPayload {
            kind: "trello_card".to_string(),
            provider: Some("trello".to_string()),
            external_id: Some("card123".to_string()),
            url: Some(url.to_string()),
            title: "Trello card card123".to_string(),
            repo_url: None,
        }
    }

    fn temp_file(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "dev-crash-flash-ai-studio-{}-{}-{name}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::write(&path, []).expect("write temp file");
        path
    }

    fn temp_file_with_contents(name: &str, contents: &[u8]) -> PathBuf {
        let path = temp_file(name);
        fs::write(&path, contents).expect("write temp file contents");
        path
    }

    fn connection_record(provider: &str, api_key: Option<&str>, token: &str) -> ConnectionRecord {
        ConnectionRecord {
            id: format!("{provider}_1"),
            provider: provider.to_string(),
            name: provider.to_string(),
            base_url: match provider {
                "gitlab" => "https://gitlab.example.org".to_string(),
                "github" => "https://github.com".to_string(),
                "trello" => "https://api.trello.com".to_string(),
                _ => "https://example.org".to_string(),
            },
            api_key: api_key.map(ToString::to_string),
            token: token.to_string(),
            created_at: 1,
            updated_at: 1,
        }
    }

    fn smart_inbox_provider_item(
        connection: &ConnectionRecord,
        external_id: &str,
        url: &str,
        title: &str,
    ) -> SmartInboxReviewRequest {
        SmartInboxReviewRequest {
            provider: connection.provider.clone(),
            connection_id: connection.id.clone(),
            connection_name: connection.name.clone(),
            source_id: format!("{}-source", connection.provider),
            source_name: format!("{} source", connection.provider),
            external_id: external_id.to_string(),
            title: title.to_string(),
            url: url.to_string(),
            context_path: None,
            context_detail: None,
            number: None,
            author: None,
            review_requested_at: None,
            updated_at: Some(1),
            created_at: Some(1),
            sort_at: Some(1),
            sort_source: "updated".to_string(),
            state: "open".to_string(),
            linked_task: None,
        }
    }

    #[test]
    fn github_review_request_normalization_excludes_closed_and_merged_items() {
        let connection = connection_record("github", None, "token");
        let open = serde_json::json!({
            "html_url": "https://github.com/owner/repo/pull/42",
            "repository_url": "https://api.github.com/repos/owner/repo",
            "number": 42,
            "state": "open",
            "title": "Improve checkout",
            "review_requested_at": "2026-07-12T08:40:00Z",
            "created_at": "2026-07-10T08:30:00Z",
            "updated_at": "2026-07-12T08:30:00Z",
            "user": { "login": "octocat" },
            "pull_request": { "merged_at": null }
        });
        let closed = serde_json::json!({
            "html_url": "https://github.com/owner/repo/pull/43",
            "number": 43,
            "state": "closed",
            "title": "Closed review",
            "pull_request": { "merged_at": null }
        });
        let merged = serde_json::json!({
            "html_url": "https://github.com/owner/repo/pull/44",
            "number": 44,
            "state": "open",
            "title": "Merged review",
            "pull_request": { "merged_at": "2026-07-12T08:35:00Z" }
        });

        let request = github_review_request_from_json(&connection, &open).expect("open request");

        assert_eq!(request.provider, "github");
        assert_eq!(request.source_id, "owner/repo");
        assert_eq!(request.source_name, "owner/repo");
        assert_eq!(request.context_path.as_deref(), Some("owner/repo"));
        assert_eq!(request.number.as_deref(), Some("42"));
        assert_eq!(request.author.as_deref(), Some("octocat"));
        assert_eq!(request.sort_source, "review_requested");
        assert_eq!(request.sort_at, request.review_requested_at);
        assert!(request.updated_at.is_some());
        assert!(github_review_request_from_json(&connection, &closed).is_none());
        assert!(github_review_request_from_json(&connection, &merged).is_none());
    }

    #[test]
    fn gitlab_review_request_normalization_excludes_closed_and_merged_items() {
        let connection = connection_record("gitlab", None, "token");
        let opened = serde_json::json!({
            "web_url": "https://gitlab.example.org/group/app/-/merge_requests/17",
            "path_with_namespace": "group/app",
            "iid": 17,
            "state": "opened",
            "title": "Improve checkout",
            "created_at": "2026-07-10T08:30:00Z",
            "updated_at": "2026-07-12T08:30:00Z",
            "merged_at": null,
            "author": { "username": "alice" }
        });
        let closed = serde_json::json!({
            "web_url": "https://gitlab.example.org/group/app/-/merge_requests/18",
            "iid": 18,
            "state": "closed",
            "title": "Closed review",
            "merged_at": null
        });
        let merged = serde_json::json!({
            "web_url": "https://gitlab.example.org/group/app/-/merge_requests/19",
            "iid": 19,
            "state": "opened",
            "title": "Merged review",
            "merged_at": "2026-07-12T08:35:00Z"
        });

        let request =
            gitlab_review_request_from_json(&connection, &opened).expect("opened request");

        assert_eq!(request.provider, "gitlab");
        assert_eq!(request.source_id, "group/app");
        assert_eq!(request.source_name, "group/app");
        assert_eq!(request.context_path.as_deref(), Some("group/app"));
        assert_eq!(request.number.as_deref(), Some("17"));
        assert_eq!(request.author.as_deref(), Some("alice"));
        assert_eq!(request.sort_source, "updated");
        assert_eq!(request.sort_at, request.updated_at);
        assert!(request.updated_at.is_some());
        assert!(gitlab_review_request_from_json(&connection, &closed).is_none());
        assert!(gitlab_review_request_from_json(&connection, &merged).is_none());
    }

    #[test]
    fn trello_assigned_card_normalization_keeps_open_cards_with_context() {
        let connection = connection_record("trello", Some("key"), "token");
        let open = serde_json::json!({
            "id": "card123",
            "shortLink": "abc123",
            "name": "Ship local-first inbox",
            "shortUrl": "https://trello.com/c/abc123",
            "closed": false,
            "dateLastActivity": "2026-07-12T08:30:00Z",
            "idBoard": "board-studio",
            "board": { "name": "Studio" },
            "list": { "name": "Doing", "closed": false }
        });
        let archived_list = serde_json::json!({
            "id": "card126",
            "shortLink": "abc126",
            "name": "Hidden with archived list",
            "shortUrl": "https://trello.com/c/abc126",
            "closed": false,
            "idBoard": "board-studio",
            "board": { "name": "Studio" },
            "list": { "name": "Archived", "closed": true }
        });
        let closed = serde_json::json!({
            "id": "card124",
            "name": "Already done",
            "shortUrl": "https://trello.com/c/abc124",
            "closed": true
        });

        let item = trello_assigned_card_from_json(&connection, &open).expect("open card");
        assert_eq!(item.source_id, "board-studio");
        assert_eq!(item.source_name, "Studio");
        assert_eq!(item.external_id, "abc123");
        assert_eq!(item.context_path.as_deref(), Some("Studio"));
        assert_eq!(item.context_detail.as_deref(), Some("Doing"));
        assert_eq!(item.sort_source, "updated");
        let without_embedded_board = serde_json::json!({
            "id": "card125", "name": "Board lookup", "shortUrl": "https://trello.com/c/lookup",
            "closed": false, "idBoard": "board-lookup", "idList": "list-doing"
        });
        let archived_without_embedded_list = serde_json::json!({
            "id": "card127", "name": "Archived lookup", "shortUrl": "https://trello.com/c/archived",
            "closed": false, "idBoard": "board-lookup", "idList": "list-archived"
        });
        let missing_list_metadata = serde_json::json!({
            "id": "card128", "name": "Unknown list", "shortUrl": "https://trello.com/c/unknown",
            "closed": false, "idBoard": "board-lookup", "idList": "list-unknown"
        });
        let (board_names, list_metadata) = trello_board_and_list_metadata(&serde_json::json!([{
            "id": "board-lookup",
            "name": "Resolved board",
            "lists": [
                { "id": "list-doing", "name": "Doing", "closed": false },
                { "id": "list-archived", "name": "Archived", "closed": true }
            ]
        }]));
        let looked_up = trello_assigned_card_from_json_with_context(
            &connection,
            &without_embedded_board,
            &board_names,
            &list_metadata,
        )
        .expect("card with looked-up board");
        assert_eq!(looked_up.source_name, "Resolved board");
        assert_eq!(looked_up.context_path.as_deref(), Some("Resolved board"));
        assert_eq!(looked_up.context_detail.as_deref(), Some("Doing"));
        assert!(trello_assigned_card_from_json_with_context(
            &connection,
            &archived_without_embedded_list,
            &board_names,
            &list_metadata,
        )
        .is_none());
        assert!(trello_assigned_card_from_json_with_context(
            &connection,
            &missing_list_metadata,
            &board_names,
            &list_metadata,
        )
        .is_some());
        assert!(trello_assigned_card_from_json(&connection, &archived_list).is_none());
        assert!(trello_assigned_card_from_json(&connection, &closed).is_none());
        assert!(trello_assigned_card_from_json(&connection, &serde_json::json!({})).is_none());
    }

    #[test]
    fn smart_inbox_cache_reconciles_and_preserves_rows_after_warning() {
        let db = memory_db();
        let connection = save_connection_in_db(
            &db,
            ConnectionInput {
                id: None,
                provider: "trello".to_string(),
                name: "Work Trello".to_string(),
                base_url: "https://api.trello.com".to_string(),
                api_key: Some("key".to_string()),
                token: "token".to_string(),
            },
        )
        .expect("save connection");
        let first = trello_assigned_card_from_json(
            &connection,
            &serde_json::json!({
                "id": "card1", "name": "First", "shortUrl": "https://trello.com/c/first",
                "closed": false, "dateLastActivity": "2026-07-12T08:30:00Z",
                "idBoard": "board-work", "board": { "name": "Work" }
            }),
        )
        .expect("first card");
        replace_smart_inbox_provider_items(&db, &connection, &[first]).expect("cache first");
        save_smart_inbox_provider_warning(&db, &connection, "offline").expect("save warning");

        let stale = list_smart_inbox_provider_items_in_db(&db, "trello").expect("list stale");
        assert_eq!(stale.items.len(), 1);
        assert_eq!(stale.warnings.len(), 1);
        assert_eq!(stale.sync_runs[0].status, "error");

        let second = trello_assigned_card_from_json(
            &connection,
            &serde_json::json!({
                "id": "card2", "name": "Second", "shortUrl": "https://trello.com/c/second",
                "closed": false, "dateLastActivity": "2026-07-13T08:30:00Z",
                "idBoard": "board-work", "board": { "name": "Work" }
            }),
        )
        .expect("second card");
        replace_smart_inbox_provider_items(&db, &connection, &[second]).expect("reconcile");

        let refreshed =
            list_smart_inbox_provider_items_in_db(&db, "trello").expect("list refreshed");
        assert_eq!(refreshed.items.len(), 1);
        assert_eq!(refreshed.items[0].external_id, "card2");
        assert!(refreshed.warnings.is_empty());
        assert_eq!(refreshed.sync_runs[0].status, "success");
    }

    #[test]
    fn smart_inbox_sources_default_enabled_and_disabled_sources_stay_out_of_cache() {
        let db = memory_db();
        let connection = save_connection_in_db(
            &db,
            ConnectionInput {
                id: None,
                provider: "trello".to_string(),
                name: "Work Trello".to_string(),
                base_url: "https://api.trello.com".to_string(),
                api_key: Some("key".to_string()),
                token: "token".to_string(),
            },
        )
        .expect("save connection");
        let card = trello_assigned_card_from_json(
            &connection,
            &serde_json::json!({
                "id": "card1", "shortLink": "card-one", "name": "Card one",
                "shortUrl": "https://trello.com/c/card-one", "closed": false,
                "idBoard": "board-work", "board": { "name": "Work" }
            }),
        )
        .expect("card");

        replace_smart_inbox_provider_items(&db, &connection, std::slice::from_ref(&card))
            .expect("initial sync");
        let sources = list_smart_inbox_provider_sources_in_db(&db, "trello").expect("sources");
        assert_eq!(sources.len(), 1);
        assert!(sources[0].enabled);
        assert_eq!(sources[0].source_id, "board-work");

        update_smart_inbox_provider_sources_in_db(
            &db,
            "trello",
            vec![SmartInboxProviderSourceChange {
                connection_id: connection.id.clone(),
                source_id: "board-work".to_string(),
                enabled: false,
            }],
        )
        .expect("disable source");
        assert!(list_smart_inbox_provider_items_in_db(&db, "trello")
            .expect("items after disable")
            .items
            .is_empty());
        assert!(
            !list_smart_inbox_provider_sources_in_db(&db, "trello")
                .expect("source remains")
                .first()
                .expect("source")
                .enabled
        );

        replace_smart_inbox_provider_items(&db, &connection, std::slice::from_ref(&card))
            .expect("sync while disabled");
        assert!(list_smart_inbox_provider_items_in_db(&db, "trello")
            .expect("disabled cache")
            .items
            .is_empty());

        update_smart_inbox_provider_sources_in_db(
            &db,
            "trello",
            vec![SmartInboxProviderSourceChange {
                connection_id: connection.id.clone(),
                source_id: "board-work".to_string(),
                enabled: true,
            }],
        )
        .expect("enable source");
        replace_smart_inbox_provider_items(&db, &connection, &[card]).expect("sync enabled");
        assert_eq!(
            list_smart_inbox_provider_items_in_db(&db, "trello")
                .expect("enabled cache")
                .items
                .len(),
            1
        );

        db.execute(
            "DELETE FROM connections WHERE id = ?1",
            params![connection.id],
        )
        .expect("delete connection");
        assert!(list_smart_inbox_provider_sources_in_db(&db, "trello")
            .expect("sources after connection deletion")
            .is_empty());
    }

    #[test]
    fn linked_provider_items_include_latest_project_task() {
        let db = memory_db();
        db.execute(
            "INSERT INTO projects (id, name, icon, color, created_at, updated_at)
             VALUES ('project1', 'Project', 'FolderKanban', '#2563eb', 1, 1)",
            [],
        )
        .expect("insert project");
        db.execute(
            "INSERT INTO tasks (id, project_id, title, body, status, source_url, created_at, updated_at)
             VALUES
                ('trello-old', 'project1', 'Old Trello task', '', 'todo', NULL, 1, 1),
                ('trello-new', 'project1', 'Current Trello task', '', 'todo', NULL, 1, 2),
                ('github-task', 'project1', 'GitHub task', '', 'todo', NULL, 1, 1),
                ('gitlab-task', 'project1', 'GitLab task', '', 'todo', NULL, 1, 1)",
            [],
        )
        .expect("insert tasks");

        let cases = [
            (
                "trello",
                "trello_card",
                "linked",
                "https://trello.com/c/linked",
                "trello-old",
                "trello-new",
            ),
            (
                "github",
                "pull_request",
                "owner/repo#42",
                "https://github.com/owner/repo/pull/42",
                "github-task",
                "github-task",
            ),
            (
                "gitlab",
                "merge_request",
                "group/app!17",
                "https://gitlab.example.org/group/app/-/merge_requests/17",
                "gitlab-task",
                "gitlab-task",
            ),
        ];

        for (provider, kind, external_id, url, first_task_id, expected_task_id) in cases {
            let connection = save_connection_in_db(
                &db,
                ConnectionInput {
                    id: None,
                    provider: provider.to_string(),
                    name: provider.to_string(),
                    base_url: if provider == "trello" {
                        "https://api.trello.com".to_string()
                    } else {
                        format!("https://{provider}.example.org")
                    },
                    api_key: (provider == "trello").then(|| "key".to_string()),
                    token: "token".to_string(),
                },
            )
            .expect("save connection");
            let linked = smart_inbox_provider_item(&connection, external_id, url, "Linked");
            let unlinked = smart_inbox_provider_item(
                &connection,
                &format!("{external_id}-unlinked"),
                &format!("{url}-unlinked"),
                "Unlinked",
            );
            replace_smart_inbox_provider_items(&db, &connection, &[linked, unlinked])
                .expect("cache provider items");
            db.execute(
                "INSERT INTO task_links
                 (task_id, provider, kind, external_id, url, connection_id, files_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]')",
                params![
                    first_task_id,
                    provider,
                    kind,
                    external_id,
                    url,
                    connection.id
                ],
            )
            .expect("link task");
            if provider == "trello" {
                db.execute(
                    "INSERT INTO task_links
                     (task_id, provider, kind, external_id, url, connection_id, files_json)
                     VALUES ('trello-new', ?1, ?2, ?3, ?4, ?5, '[]')",
                    params![provider, kind, external_id, url, connection.id],
                )
                .expect("link newer task");
            }

            let result =
                list_smart_inbox_provider_items_in_db(&db, provider).expect("list provider items");
            assert_eq!(result.items.len(), 2);
            let linked = result
                .items
                .iter()
                .find(|item| item.external_id == external_id)
                .expect("linked item remains visible");
            assert_eq!(
                linked.linked_task.as_ref().map(|task| task.id.as_str()),
                Some(expected_task_id)
            );
            assert!(result
                .items
                .iter()
                .find(|item| item.title == "Unlinked")
                .expect("unlinked item")
                .linked_task
                .is_none());
        }
    }

    #[test]
    fn review_request_sort_metadata_falls_back_to_created_at() {
        let created_at = parse_rfc3339_millis("2026-07-10T08:30:00Z");

        let (sort_at, sort_source) = review_request_sort_metadata(None, None, created_at);

        assert_eq!(sort_at, created_at);
        assert_eq!(sort_source, "created");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn prefers_apple_vision_before_ocrs_on_macos() {
        assert_eq!(
            preferred_ocr_backends(),
            &[OcrBackend::MacosVision, OcrBackend::Ocrs]
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn uses_ocrs_as_ocr_backend_on_non_macos() {
        assert_eq!(preferred_ocr_backends(), &[OcrBackend::Ocrs]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires OCR_UMLAUT_FIXTURE to point to a PNG/JPEG/WebP image containing German Umlauts"]
    fn macos_vision_ocr_preserves_german_umlauts_fixture() {
        let fixture_path =
            std::env::var("OCR_UMLAUT_FIXTURE").expect("OCR_UMLAUT_FIXTURE must be set");
        let bytes = fs::read(fixture_path).expect("read OCR fixture");
        let result = macos_vision_ocr_image_bytes(&bytes).expect("run Apple Vision OCR");

        assert!(
            result.text.contains("Grüße"),
            "expected OCR text to preserve Grüße, got {:?}",
            result.text
        );
        assert!(
            result.text.contains("Käseöl"),
            "expected OCR text to preserve Käseöl, got {:?}",
            result.text
        );
        assert!(
            result.text.contains("schön"),
            "expected OCR text to preserve schön, got {:?}",
            result.text
        );
    }

    #[test]
    fn validates_supported_ocr_file_by_mime_type() {
        let path = temp_file("scan.bin");
        let result = validate_ocr_image_path(path.to_str().unwrap(), Some("image/png"));

        assert!(result.is_ok());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn validates_supported_ocr_file_by_extension_when_mime_type_is_missing() {
        let path = temp_file("scan.webp");
        let result = validate_ocr_image_path(path.to_str().unwrap(), None);

        assert!(result.is_ok());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn validates_supported_ocr_file_name_for_bytes() {
        assert!(validate_ocr_image_name("scan.png", None).is_ok());
        assert!(validate_ocr_image_name("scan", Some("image/webp")).is_ok());
        assert_eq!(
            validate_ocr_image_name("scan.gif", Some("image/gif")).unwrap_err(),
            "Unsupported file type. Drop a PNG, JPEG, or WebP image."
        );
    }

    #[test]
    fn rejects_unsupported_ocr_file_type() {
        let path = temp_file("scan.pdf");
        let result = validate_ocr_image_path(path.to_str().unwrap(), Some("application/pdf"));

        assert_eq!(
            result.unwrap_err(),
            "Unsupported file type. Drop a PNG, JPEG, or WebP image."
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn validates_supported_email_file_by_extension() {
        let path = temp_file("message.eml");
        let result = validate_email_file_path(path.to_str().unwrap(), None);

        assert!(result.is_ok());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn validates_supported_email_file_by_mime_type() {
        let path = temp_file("message.bin");
        let result = validate_email_file_path(path.to_str().unwrap(), Some("message/rfc822"));

        assert!(result.is_ok());
        let _ = fs::remove_file(path);
    }

    #[test]
    fn rejects_unsupported_email_file_type() {
        let path = temp_file("message.txt");
        let result = validate_email_file_path(path.to_str().unwrap(), Some("text/plain"));

        assert_eq!(
            result.unwrap_err(),
            "Unsupported file type. Drop a PNG, JPEG, WebP image, or .eml email."
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reads_plain_text_email_file() {
        let path = temp_file_with_contents(
            "plain.eml",
            b"Subject: Ship auth fix\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease review the auth fix.\r\n",
        );

        let result = read_email_file_in_app(path.to_string_lossy().to_string(), None)
            .expect("read email file");

        assert_eq!(result.subject, "Ship auth fix");
        assert_eq!(result.body, "Please review the auth fix.");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reads_plain_text_email_bytes() {
        let result = read_email_bytes_in_app(
            b"Subject: Browser drop\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nRead from file bytes.\r\n",
        )
        .expect("read email bytes");

        assert_eq!(result.subject, "Browser drop");
        assert_eq!(result.body, "Read from file bytes.");
    }

    #[test]
    fn decodes_apple_mail_message_uri() {
        assert_eq!(
            apple_mail_message_id_from_uri("message:%3Cabc@example.test%3E").expect("message id"),
            "abc@example.test"
        );
    }

    #[test]
    fn extracts_message_bytes_from_emlx() {
        let message = b"Subject: Wrapped\r\nMessage-ID: <abc@example.test>\r\n\r\nBody\r\n";
        let mut emlx = format!("{}\n", message.len()).into_bytes();
        emlx.extend_from_slice(message);
        emlx.extend_from_slice(b"<?xml version=\"1.0\"?><plist></plist>");

        assert_eq!(emlx_message_bytes(&emlx), message);
    }

    #[test]
    fn reads_encoded_subject_and_quoted_printable_email_body() {
        let path = temp_file_with_contents(
            "encoded.eml",
            b"Subject: =?UTF-8?Q?Gr=C3=BC=C3=9Fe_pr=C3=BCfen?=\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nBitte pr=C3=BCfen.\r\n",
        );

        let result = read_email_file_in_app(path.to_string_lossy().to_string(), None)
            .expect("read email file");

        assert_eq!(result.subject, "Grüße prüfen");
        assert_eq!(result.body, "Bitte prüfen.");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reads_base64_email_body() {
        let path = temp_file_with_contents(
            "base64.eml",
            b"Subject: Base64 body\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\nUmV2aWV3IHRoZSBkZXBsb3ltZW50IHBsYW4u\r\n",
        );

        let result = read_email_file_in_app(path.to_string_lossy().to_string(), None)
            .expect("read email file");

        assert_eq!(result.subject, "Base64 body");
        assert_eq!(result.body, "Review the deployment plan.");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reads_multipart_email_preferring_plain_text_body() {
        let path = temp_file_with_contents(
            "multipart.eml",
            b"Subject: Multipart body\r\nContent-Type: multipart/alternative; boundary=\"part\"\r\n\r\n--part\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>HTML body</p>\r\n--part\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlain body\r\n--part--\r\n",
        );

        let result = read_email_file_in_app(path.to_string_lossy().to_string(), None)
            .expect("read email file");

        assert_eq!(result.subject, "Multipart body");
        assert_eq!(result.body, "Plain body");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn reads_html_only_placeholder_email_as_markdown() {
        let path = temp_file_with_contents(
            "html-only.eml",
            b"Subject: HTML task\r\nContent-Type: multipart/alternative; boundary=\"part\"\r\n\r\n--part\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nThis mail can only be viewed in HTML.\r\n--part\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<h1>Action required</h1><p>Open <strong>dashboard</strong> and <a href=\"https://example.test/path?a=1&amp;b=2\">review it</a>.</p><ul><li>First item</li><li>Second item</li></ul>\r\n--part--\r\n",
        );

        let result = read_email_file_in_app(path.to_string_lossy().to_string(), None)
            .expect("read email file");

        assert_eq!(result.subject, "HTML task");
        assert_eq!(
            result.body,
            "# Action required\n\nOpen **dashboard** and [review it](https://example.test/path?a=1&b=2).\n\n- First item\n- Second item"
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn converts_html_breaks_to_markdown_hard_breaks() {
        let markdown = html_to_markdown("<p>Line one<br>Line two</p><p>Next paragraph</p>");

        assert_eq!(markdown, "Line one  \nLine two\n\nNext paragraph");
    }

    #[test]
    fn converts_contact_form_html_to_compact_markdown() {
        let markdown = html_to_markdown(
            "<strong>First name</strong>: Benjamin<br>
             <strong>Last name</strong>: Ritschel<br>
             <strong>Email</strong>: benjamin@example.test<br>
             <strong>Phone</strong>: +491778382130<br>
             <strong>How can we help? Tell us more ...</strong>: Dear Sulu Team, Sulu was brought into the CMS market exploration for our client, Flughafen Berlin Brandenburg GmbH (Berlin Brandenburg Airport, BER), through our network partner Open Digital. Based on the input received through this channel, we are pleased to inform you that Sulu has been shortlisted – as a next step, we would like to invite you to a product demo.<br />
             <br />
             Please note: this remains a market exploration, not a formal tender.<br />
             <br />
             Available slots (all times CEST):<br />
             – Tue, 21 July, 09:00–10:30<br />
             – Tue, 21 July, 11:00–12:30<br />
             <br />
             Kind regards<br />
             Benjamin Ritschel<br />
             3 Letter Code Consulting GmbH<br>",
        );

        assert_eq!(
            markdown,
            "**First name**: Benjamin  \n**Last name**: Ritschel  \n**Email**: benjamin@example.test  \n**Phone**: +491778382130  \n\n**How can we help? Tell us more ...**: Dear Sulu Team, Sulu was brought into the CMS market exploration for our client, Flughafen Berlin Brandenburg GmbH (Berlin Brandenburg Airport, BER), through our network partner Open Digital. Based on the input received through this channel, we are pleased to inform you that Sulu has been shortlisted – as a next step, we would like to invite you to a product demo.\n\nPlease note: this remains a market exploration, not a formal tender.\n\nAvailable slots (all times CEST):  \n– Tue, 21 July, 09:00–10:30  \n– Tue, 21 July, 11:00–12:30\n\nKind regards  \nBenjamin Ritschel  \n3 Letter Code Consulting GmbH"
        );
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "dev-crash-flash-ai-studio-{name}-{}-{}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn run_git_test(path: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(path)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_repo_with_remote(remote_name: &str, remote_url: &str) -> PathBuf {
        let path = unique_temp_dir("repo");
        fs::create_dir_all(&path).expect("create temp git repo");
        run_git_test(&path, &["init"]);
        run_git_test(&path, &["remote", "add", remote_name, remote_url]);
        path
    }

    fn git_repo_with_origin(origin: &str) -> PathBuf {
        git_repo_with_remote("origin", origin)
    }

    fn review_diff_repo_with_origin(origin: &str) -> PathBuf {
        let path = git_repo_with_origin(origin);
        run_git_test(&path, &["config", "user.email", "test@example.org"]);
        run_git_test(&path, &["config", "user.name", "Test User"]);
        run_git_test(&path, &["checkout", "-b", "main"]);
        fs::write(path.join("a.txt"), "base a\n").expect("write a base");
        fs::write(path.join("b.txt"), "base b\n").expect("write b base");
        run_git_test(&path, &["add", "a.txt", "b.txt"]);
        run_git_test(&path, &["commit", "-m", "base"]);
        run_git_test(&path, &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        run_git_test(
            &path,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/main",
            ],
        );
        run_git_test(&path, &["checkout", "-b", "review/test"]);
        fs::write(path.join("a.txt"), "base a\nreview a\n").expect("write a review");
        fs::write(path.join("b.txt"), "base b\nreview b\n").expect("write b review");
        fs::write(path.join("--flag.txt"), "path-safe\n").expect("write path-safe file");
        run_git_test(&path, &["add", "--", "a.txt", "b.txt", "--flag.txt"]);
        run_git_test(&path, &["commit", "-m", "review"]);
        path
    }

    fn save_test_local_resource(
        db: &SqliteConnection,
        project_id: &str,
        path: &Path,
    ) -> LocalResource {
        save_local_resource_in_db(
            db,
            LocalResourceInput {
                project_id: project_id.to_string(),
                path: path.to_string_lossy().to_string(),
                expected_provider: Some("github".to_string()),
                expected_repo_url: Some("https://github.com/owner/repo".to_string()),
                name: None,
            },
        )
        .expect("save local resource")
    }

    #[test]
    fn normalizes_repository_urls_for_matching() {
        assert_eq!(
            normalize_repository_url("https://github.com/Owner/Repo.git/").as_deref(),
            Some("github.com/owner/repo")
        );
        assert_eq!(
            normalize_repository_url("git@github.com:Owner/Repo.git").as_deref(),
            Some("github.com/owner/repo")
        );
        assert_eq!(
            normalize_repository_url("ssh://git@gitlab.example.org/group/app.git").as_deref(),
            Some("gitlab.example.org/group/app")
        );
    }

    #[test]
    fn derives_checkout_targets_for_github_and_gitlab() {
        assert_eq!(
            checkout_target("github", "https://github.com/owner/repo/pull/42")
                .expect("github target"),
            (
                "pull/42/head".to_string(),
                "review/github-pr-42".to_string(),
                "review/github-pr-42".to_string()
            )
        );
        assert_eq!(
            checkout_target(
                "gitlab",
                "https://gitlab.example.org/group/app/-/merge_requests/7"
            )
            .expect("gitlab target"),
            (
                "merge-requests/7/head".to_string(),
                "review/gitlab-mr-7".to_string(),
                "review/gitlab-mr-7".to_string()
            )
        );
    }

    #[test]
    fn saves_multiple_local_resources_for_same_repo_and_rejects_mismatches() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let first_path = git_repo_with_origin("git@github.com:owner/repo.git");
        let second_path = git_repo_with_origin("https://github.com/owner/repo.git");

        let first = save_local_resource_in_db(
            &db,
            LocalResourceInput {
                project_id: project.id.clone(),
                path: first_path.to_string_lossy().to_string(),
                expected_provider: Some("github".to_string()),
                expected_repo_url: Some("https://github.com/owner/repo".to_string()),
                name: None,
            },
        )
        .expect("save first local resource");
        let duplicate = save_local_resource_in_db(
            &db,
            LocalResourceInput {
                project_id: project.id.clone(),
                path: first_path.to_string_lossy().to_string(),
                expected_provider: Some("github".to_string()),
                expected_repo_url: Some("https://github.com/owner/repo".to_string()),
                name: Some("Renamed".to_string()),
            },
        )
        .expect("save duplicate local resource");
        let second = save_local_resource_in_db(
            &db,
            LocalResourceInput {
                project_id: project.id,
                path: second_path.to_string_lossy().to_string(),
                expected_provider: Some("github".to_string()),
                expected_repo_url: Some("https://github.com/owner/repo".to_string()),
                name: None,
            },
        )
        .expect("save second local resource");

        assert_eq!(first.id, duplicate.id);
        assert_ne!(first.id, second.id);

        let mismatch = local_resource_from_directory(
            &second_path.to_string_lossy(),
            Some("gitlab"),
            Some("https://gitlab.example.org/group/app"),
        )
        .unwrap_err();
        assert!(mismatch.contains("repository"));
    }

    #[test]
    fn local_resources_can_match_non_origin_remotes() {
        let repo_path = git_repo_with_remote("upstream", "git@gitlab.example.org:group/app.git");

        let (path, provider, normalized_repo_url) = local_resource_from_directory(
            &repo_path.to_string_lossy(),
            Some("gitlab"),
            Some("https://gitlab.example.org/group/app"),
        )
        .expect("match upstream remote");

        assert!(Path::new(&path).ends_with(repo_path.file_name().unwrap()));
        assert_eq!(provider, "gitlab");
        assert_eq!(normalized_repo_url, "gitlab.example.org/group/app");
    }

    #[test]
    fn checkout_rejects_dirty_local_resources_before_fetch() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let repo_path = git_repo_with_origin("git@github.com:owner/repo.git");
        let resource = save_local_resource_in_db(
            &db,
            LocalResourceInput {
                project_id: project.id,
                path: repo_path.to_string_lossy().to_string(),
                expected_provider: Some("github".to_string()),
                expected_repo_url: Some("https://github.com/owner/repo".to_string()),
                name: None,
            },
        )
        .expect("save local resource");
        fs::write(repo_path.join("untracked.txt"), "dirty").expect("write untracked file");

        let error = checkout_pull_request_for_review_in_db(
            &db,
            resource.id,
            "github".to_string(),
            "https://github.com/owner/repo/pull/42".to_string(),
        )
        .unwrap_err();

        assert!(error.contains("uncommitted or untracked changes"));
    }

    #[test]
    fn loads_review_diff_first_file_and_specific_file() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let repo_path = review_diff_repo_with_origin("git@github.com:owner/repo.git");
        let resource = save_test_local_resource(&db, &project.id, &repo_path);

        let diff = load_review_diff_in_db(
            &db,
            resource.id.clone(),
            Some("review/test".to_string()),
            None,
        )
        .expect("load review diff");

        assert_eq!(diff.branch, "review/test");
        assert_eq!(diff.base_ref, "origin/HEAD");
        assert!(diff.files.contains(&"a.txt".to_string()));
        assert!(diff.files.contains(&"b.txt".to_string()));
        assert_eq!(
            diff.current_file.as_ref().map(|file| file.path.as_str()),
            diff.files.first().map(|value| value.as_str())
        );
        let current_file = diff.current_file.expect("first file");
        assert!(current_file.diff.contains(&current_file.path));

        let file = load_review_diff_file_in_db(
            &db,
            resource.id,
            diff.base_ref,
            diff.branch,
            "b.txt".to_string(),
        )
        .expect("load b diff");
        assert_eq!(file.path, "b.txt");
        assert!(file.diff.contains("review b"));
    }

    #[test]
    fn loads_path_safe_review_diff_file() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let repo_path = review_diff_repo_with_origin("git@github.com:owner/repo.git");
        let resource = save_test_local_resource(&db, &project.id, &repo_path);

        let file = load_review_diff_file_in_db(
            &db,
            resource.id,
            "origin/HEAD".to_string(),
            "review/test".to_string(),
            "--flag.txt".to_string(),
        )
        .expect("load path-safe diff");

        assert_eq!(file.path, "--flag.txt");
        assert!(file.diff.contains("path-safe"));
    }

    #[test]
    fn loads_empty_review_diff() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let repo_path = review_diff_repo_with_origin("git@github.com:owner/repo.git");
        let resource = save_test_local_resource(&db, &project.id, &repo_path);

        let diff = load_review_diff_in_db(&db, resource.id, Some("main".to_string()), None)
            .expect("load empty diff");

        assert!(diff.files.is_empty());
        assert!(diff.current_file.is_none());
    }

    #[test]
    fn loads_review_diff_with_preferred_target_base_ref() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let repo_path = review_diff_repo_with_origin("git@github.com:owner/repo.git");
        run_git_test(
            &repo_path,
            &["update-ref", "refs/remotes/origin/develop", "origin/HEAD"],
        );
        let resource = save_test_local_resource(&db, &project.id, &repo_path);

        let diff = load_review_diff_in_db(
            &db,
            resource.id,
            Some("review/test".to_string()),
            Some("origin/develop".to_string()),
        )
        .expect("load diff against target");

        assert_eq!(diff.base_ref, "origin/develop");
        assert!(!diff.files.is_empty());
    }

    #[test]
    fn loads_review_diff_from_merge_base_when_target_advanced() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let repo_path = git_repo_with_origin("git@github.com:owner/repo.git");
        run_git_test(&repo_path, &["config", "user.email", "test@example.org"]);
        run_git_test(&repo_path, &["config", "user.name", "Test User"]);
        run_git_test(&repo_path, &["checkout", "-b", "main"]);
        fs::write(repo_path.join("shared.txt"), "base\n").expect("write shared base");
        run_git_test(&repo_path, &["add", "shared.txt"]);
        run_git_test(&repo_path, &["commit", "-m", "base"]);

        run_git_test(&repo_path, &["checkout", "-b", "review/test"]);
        fs::write(repo_path.join("review-only.txt"), "review change\n")
            .expect("write review change");
        run_git_test(&repo_path, &["add", "review-only.txt"]);
        run_git_test(&repo_path, &["commit", "-m", "review change"]);

        run_git_test(&repo_path, &["checkout", "main"]);
        fs::write(repo_path.join("target-only.txt"), "target change\n")
            .expect("write target change");
        run_git_test(&repo_path, &["add", "target-only.txt"]);
        run_git_test(&repo_path, &["commit", "-m", "target advanced"]);
        run_git_test(
            &repo_path,
            &["update-ref", "refs/remotes/origin/main", "HEAD"],
        );

        let resource = save_test_local_resource(&db, &project.id, &repo_path);
        let diff = load_review_diff_in_db(
            &db,
            resource.id.clone(),
            Some("review/test".to_string()),
            Some("origin/main".to_string()),
        )
        .expect("load review diff from merge base");

        assert_eq!(diff.files, vec!["review-only.txt".to_string()]);
        let current_file = diff.current_file.expect("review file");
        assert!(current_file.diff.contains("review change"));
        assert!(!current_file.diff.contains("target change"));

        let file = load_review_diff_file_in_db(
            &db,
            resource.id,
            diff.base_ref,
            diff.branch,
            "review-only.txt".to_string(),
        )
        .expect("load review file diff from merge base");
        assert!(file.diff.contains("review change"));
        assert!(!file.diff.contains("target change"));
    }

    #[test]
    fn creates_and_updates_project() {
        let db = memory_db();
        let project = create_project_in_db(
            &db,
            "Access".to_string(),
            Some("GitBranch".to_string()),
            None,
        )
        .expect("create project");

        assert_eq!(project.name, "Access");
        assert_eq!(project.icon, "GitBranch");

        db.execute(
            "UPDATE projects SET name = 'Access App' WHERE id = ?1",
            params![project.id],
        )
        .expect("update project");
        let updated = get_project(&db, &project.id)
            .expect("load project")
            .expect("project exists");
        assert_eq!(updated.name, "Access App");
    }

    #[test]
    fn migrates_existing_database_columns() {
        let db = SqliteConnection::open_in_memory().expect("open in-memory database");
        db.execute_batch(
            "
            PRAGMA foreign_keys = ON;
            CREATE TABLE connections (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                name TEXT NOT NULL,
                base_url TEXT NOT NULL,
                token TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                icon TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE ai_prompts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                agent_type TEXT NOT NULL,
                prompt_text TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE resources (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                provider TEXT NOT NULL,
                kind TEXT NOT NULL,
                external_id TEXT NOT NULL,
                url TEXT NOT NULL,
                name TEXT NOT NULL,
                icon_url TEXT,
                connection_id TEXT REFERENCES connections(id) ON DELETE SET NULL,
                UNIQUE(provider, kind, external_id)
            );
            CREATE TABLE task_links (
                task_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                kind TEXT NOT NULL,
                external_id TEXT NOT NULL,
                url TEXT NOT NULL,
                PRIMARY KEY(task_id, provider, kind, external_id)
            );
            CREATE TABLE pull_requests (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                provider TEXT NOT NULL,
                repo_url TEXT NOT NULL,
                pr_url TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                review_notes TEXT NOT NULL,
                test_state TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO projects (id, name, icon, created_at, updated_at)
            VALUES ('project_1', 'Access', 'FolderKanban', 1, 1),
                   ('project_2', 'Portal', 'FolderKanban', 1, 1);
            INSERT INTO ai_prompts (id, name, agent_type, prompt_text, created_at, updated_at)
            VALUES ('prompt_1', 'Legacy prompt', 'codex', '', 1, 1);
            INSERT INTO resources
                (id, project_id, provider, kind, external_id, url, name, icon_url, connection_id)
            VALUES
                ('resource_1', 'project_1', 'github', 'github_repo', 'github.com/owner/repo',
                 'https://github.com/owner/repo', 'owner/repo', NULL, NULL);
            ",
        )
        .expect("create legacy schema");

        init_database(&db).expect("migrate legacy schema");

        assert!(column_exists(&db, "connections", "api_key"));
        assert!(column_exists(&db, "ai_prompts", "icon"));
        assert_eq!(
            list_ai_prompts_in_db(&db).expect("list migrated AI Prompts")[0].icon,
            "sparkles"
        );
        assert!(column_exists(&db, "task_links", "connection_id"));
        assert!(column_exists(&db, "task_links", "external_state_color"));
        assert!(column_exists(&db, "task_links", "target_branch"));
        assert!(column_exists(&db, "task_links", "files_json"));
        assert!(column_exists(&db, "task_links", "comments_json"));
        assert!(column_exists(&db, "task_links", "labels_json"));
        assert!(column_exists(&db, "pull_requests", "external_state"));
        assert!(column_exists(&db, "pull_requests", "target_branch"));
        assert!(column_exists(&db, "directories", "path"));
        assert!(column_exists(&db, "directories", "name"));
        assert!(column_exists(&db, "activities", "occurred_at"));
        assert!(column_exists(&db, "activity_sync_runs", "synced_at"));
        assert!(column_exists(&db, "smart_inbox_todos", "raw_text"));
        assert!(column_exists(&db, "smart_inbox_todos", "file_path"));

        connect_resource_in_db(
            &db,
            ResourceInput {
                project_id: "project_2".to_string(),
                provider: "github".to_string(),
                kind: "github_repo".to_string(),
                external_id: "github.com/owner/repo".to_string(),
                url: "https://github.com/owner/repo".to_string(),
                name: "owner/repo".to_string(),
                icon_url: None,
                connection_id: None,
            },
        )
        .expect("connect same repo to second project after migration");
        let duplicate = connect_resource_in_db(
            &db,
            ResourceInput {
                project_id: "project_1".to_string(),
                provider: "github".to_string(),
                kind: "github_repo".to_string(),
                external_id: "github.com/owner/repo".to_string(),
                url: "https://github.com/owner/repo".to_string(),
                name: "owner/repo".to_string(),
                icon_url: None,
                connection_id: None,
            },
        )
        .expect("dedupe existing first project resource");
        assert_eq!(duplicate.id, "resource_1");
    }

    #[test]
    fn smart_inbox_todos_create_list_and_delete() {
        let db = memory_db();
        let first = create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "text".to_string(),
                title: None,
                raw_text: Some("Review onboarding\nnext line".to_string()),
                file_path: None,
                file_name: None,
                mime_type: None,
            },
        )
        .expect("create first todo");
        let second = create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "file".to_string(),
                title: None,
                raw_text: None,
                file_path: Some("/tmp/notes.txt".to_string()),
                file_name: Some("notes.txt".to_string()),
                mime_type: Some("text/plain".to_string()),
            },
        )
        .expect("create second todo");
        db.execute(
            "UPDATE smart_inbox_todos SET created_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![first.created_at + 1, &second.id],
        )
        .expect("update created timestamp");

        let todos = list_smart_inbox_todos_in_db(&db).expect("list todos");
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].id, second.id);
        assert_eq!(todos[1].title, "Review onboarding");

        delete_smart_inbox_todo_in_db(&db, &second.id).expect("delete todo");
        let todos = list_smart_inbox_todos_in_db(&db).expect("list after delete");
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].id, first.id);
    }

    #[test]
    fn smart_inbox_file_todos_reuse_existing_path() {
        let db = memory_db();
        let first = create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "file".to_string(),
                title: None,
                raw_text: None,
                file_path: Some("/tmp/archive.zip".to_string()),
                file_name: Some("archive.zip".to_string()),
                mime_type: Some("application/zip".to_string()),
            },
        )
        .expect("create file todo");
        db.execute(
            "UPDATE smart_inbox_todos SET updated_at = ?1 WHERE id = ?2",
            params![first.created_at - 1, &first.id],
        )
        .expect("age file todo");

        let duplicate = create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "file".to_string(),
                title: None,
                raw_text: None,
                file_path: Some("  /tmp/archive.zip  ".to_string()),
                file_name: Some("archive-latest.zip".to_string()),
                mime_type: Some("application/octet-stream".to_string()),
            },
        )
        .expect("reuse file todo");

        let todos = list_smart_inbox_todos_in_db(&db).expect("list todos");
        assert_eq!(duplicate.id, first.id);
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].file_name.as_deref(), Some("archive-latest.zip"));
        assert!(todos[0].updated_at >= first.created_at);
    }

    #[test]
    fn duplicate_smart_inbox_file_todo_moves_to_top() {
        let db = memory_db();
        let first = create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "file".to_string(),
                title: None,
                raw_text: None,
                file_path: Some("/tmp/first.txt".to_string()),
                file_name: Some("first.txt".to_string()),
                mime_type: Some("text/plain".to_string()),
            },
        )
        .expect("create first file todo");
        let second = create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "file".to_string(),
                title: None,
                raw_text: None,
                file_path: Some("/tmp/second.txt".to_string()),
                file_name: Some("second.txt".to_string()),
                mime_type: Some("text/plain".to_string()),
            },
        )
        .expect("create second file todo");
        db.execute(
            "UPDATE smart_inbox_todos SET created_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![100, &first.id],
        )
        .expect("age first file todo");
        db.execute(
            "UPDATE smart_inbox_todos SET created_at = ?1, updated_at = ?1 WHERE id = ?2",
            params![200, &second.id],
        )
        .expect("age second file todo");

        create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "file".to_string(),
                title: None,
                raw_text: None,
                file_path: Some("/tmp/first.txt".to_string()),
                file_name: Some("first.txt".to_string()),
                mime_type: Some("text/plain".to_string()),
            },
        )
        .expect("move first file todo");

        let todos = list_smart_inbox_todos_in_db(&db).expect("list todos");
        assert_eq!(todos.len(), 2);
        assert_eq!(todos[0].id, first.id);
        assert_eq!(todos[1].id, second.id);
    }

    #[test]
    fn duplicate_smart_inbox_text_todos_are_allowed() {
        let db = memory_db();
        let first = create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "text".to_string(),
                title: None,
                raw_text: Some("Review onboarding".to_string()),
                file_path: None,
                file_name: None,
                mime_type: None,
            },
        )
        .expect("create first text todo");
        let second = create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "text".to_string(),
                title: None,
                raw_text: Some("Review onboarding".to_string()),
                file_path: None,
                file_name: None,
                mime_type: None,
            },
        )
        .expect("create second text todo");

        let todos = list_smart_inbox_todos_in_db(&db).expect("list todos");
        assert_eq!(todos.len(), 2);
        assert_ne!(first.id, second.id);
    }

    #[test]
    fn smart_inbox_todos_update_content_and_file_titles() {
        let db = memory_db();
        let text = create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "text".to_string(),
                title: None,
                raw_text: Some("Original todo".to_string()),
                file_path: None,
                file_name: None,
                mime_type: None,
            },
        )
        .expect("create text todo");
        let file = create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "file".to_string(),
                title: None,
                raw_text: None,
                file_path: Some("/tmp/archive.zip".to_string()),
                file_name: Some("archive.zip".to_string()),
                mime_type: Some("application/zip".to_string()),
            },
        )
        .expect("create file todo");
        db.execute(
            "UPDATE smart_inbox_todos SET updated_at = 1 WHERE id IN (?1, ?2)",
            params![&text.id, &file.id],
        )
        .expect("age todos");

        let updated_file = update_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoUpdateInput {
                id: file.id.clone(),
                title: Some("  Release archive\nKeep for deployment  ".to_string()),
                raw_text: None,
            },
        )
        .expect("update file todo");
        let updated_text = update_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoUpdateInput {
                id: text.id.clone(),
                title: None,
                raw_text: Some("\n  Updated todo\nKeep these details".to_string()),
            },
        )
        .expect("update text todo");

        assert_eq!(updated_text.title, "Updated todo");
        assert_eq!(
            updated_text.raw_text.as_deref(),
            Some("\n  Updated todo\nKeep these details")
        );
        assert_eq!(updated_text.created_at, text.created_at);
        assert!(updated_text.updated_at > 1);
        assert_eq!(updated_file.title, "Release archive\nKeep for deployment");
        assert_eq!(updated_file.file_path, file.file_path);
        assert_eq!(updated_file.file_name, file.file_name);
        assert_eq!(updated_file.mime_type, file.mime_type);
        assert_eq!(updated_file.created_at, file.created_at);
    }

    #[test]
    fn smart_inbox_todo_updates_validate_kind_fields_and_values() {
        let db = memory_db();
        let text = create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "text".to_string(),
                title: None,
                raw_text: Some("Text todo".to_string()),
                file_path: None,
                file_name: None,
                mime_type: None,
            },
        )
        .expect("create text todo");
        let file = create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "file".to_string(),
                title: None,
                raw_text: None,
                file_path: Some("/tmp/file.txt".to_string()),
                file_name: Some("file.txt".to_string()),
                mime_type: Some("text/plain".to_string()),
            },
        )
        .expect("create file todo");

        let blank_text = update_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoUpdateInput {
                id: text.id.clone(),
                title: None,
                raw_text: Some("   ".to_string()),
            },
        );
        assert!(blank_text.unwrap_err().contains("cannot be blank"));

        let wrong_text_field = update_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoUpdateInput {
                id: text.id,
                title: Some("Wrong field".to_string()),
                raw_text: None,
            },
        );
        assert!(wrong_text_field
            .unwrap_err()
            .contains("only update rawText"));

        let blank_file_title = update_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoUpdateInput {
                id: file.id.clone(),
                title: Some(" ".to_string()),
                raw_text: None,
            },
        );
        assert!(blank_file_title.unwrap_err().contains("cannot be blank"));

        let wrong_file_field = update_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoUpdateInput {
                id: file.id,
                title: None,
                raw_text: Some("Wrong field".to_string()),
            },
        );
        assert!(wrong_file_field.unwrap_err().contains("only update title"));

        let missing = update_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoUpdateInput {
                id: "missing".to_string(),
                title: None,
                raw_text: Some("Missing".to_string()),
            },
        );
        assert!(missing.unwrap_err().contains("not found"));
    }

    #[test]
    fn migration_removes_duplicate_smart_inbox_file_todos() {
        let db = memory_db();
        db.execute("DROP INDEX idx_smart_inbox_file_path", [])
            .expect("drop unique file path index");
        db.execute(
            "INSERT INTO smart_inbox_todos
                (id, kind, title, raw_text, file_path, file_name, mime_type, created_at, updated_at)
             VALUES (?1, 'file', ?2, NULL, ?3, ?4, ?5, ?6, ?7)",
            params![
                "smart_inbox_todo_old",
                "Old archive",
                "/tmp/archive.zip",
                "archive.zip",
                "application/zip",
                100,
                100
            ],
        )
        .expect("insert old duplicate");
        db.execute(
            "INSERT INTO smart_inbox_todos
                (id, kind, title, raw_text, file_path, file_name, mime_type, created_at, updated_at)
             VALUES (?1, 'file', ?2, NULL, ?3, ?4, ?5, ?6, ?7)",
            params![
                "smart_inbox_todo_new",
                "New archive",
                "/tmp/archive.zip",
                "archive.zip",
                "application/zip",
                200,
                300
            ],
        )
        .expect("insert new duplicate");

        keep_one_file_smart_inbox_todo_per_path(&db).expect("remove duplicate file todo");

        let todos = list_smart_inbox_todos_in_db(&db).expect("list todos");
        assert_eq!(todos.len(), 1);
        assert_eq!(todos[0].id, "smart_inbox_todo_new");
    }

    #[test]
    fn smart_inbox_todos_store_raw_links_and_unsupported_files() {
        let db = memory_db();
        let existing_path = temp_test_path("smart-inbox-existing-file");
        fs::write(&existing_path, "raw todo file").expect("write temp file");
        let link = create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "text".to_string(),
                title: Some("Trello card".to_string()),
                raw_text: Some("https://trello.com/c/card123/review-auth".to_string()),
                file_path: None,
                file_name: None,
                mime_type: None,
            },
        )
        .expect("create link todo");
        let file = create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "file".to_string(),
                title: None,
                raw_text: None,
                file_path: Some(existing_path.to_string_lossy().to_string()),
                file_name: Some("smart-inbox-existing-file".to_string()),
                mime_type: Some("text/plain".to_string()),
            },
        )
        .expect("create file todo");
        let missing = create_smart_inbox_todo_in_db(
            &db,
            SmartInboxTodoInput {
                kind: "file".to_string(),
                title: None,
                raw_text: None,
                file_path: Some("/tmp/archive.zip".to_string()),
                file_name: Some("archive.zip".to_string()),
                mime_type: Some("application/zip".to_string()),
            },
        )
        .expect("create missing file todo");

        assert_eq!(
            link.raw_text.as_deref(),
            Some("https://trello.com/c/card123/review-auth")
        );
        assert_eq!(file.file_name.as_deref(), Some("smart-inbox-existing-file"));
        assert_eq!(file.mime_type.as_deref(), Some("text/plain"));
        assert!(!file.file_missing);
        assert_eq!(missing.file_name.as_deref(), Some("archive.zip"));
        assert!(missing.file_missing);
    }

    #[test]
    fn upserts_and_filters_cached_activities() {
        let db = memory_db();
        let connection = save_connection_in_db(
            &db,
            ConnectionInput {
                id: Some("github_1".to_string()),
                provider: "github".to_string(),
                name: "GitHub".to_string(),
                base_url: "https://github.com".to_string(),
                api_key: None,
                token: "token".to_string(),
            },
        )
        .expect("save connection");
        let mut activity = ActivityInput {
            provider: "github".to_string(),
            connection_id: connection.id.clone(),
            external_id: "event_1".to_string(),
            event_type: "IssuesEvent".to_string(),
            action_label: "Opened".to_string(),
            actor: Some("alex".to_string()),
            title: "First title".to_string(),
            target_url: Some("https://github.com/owner/repo/issues/1".to_string()),
            occurred_at: 1_000,
            raw_json: "{}".to_string(),
            subject_json: Some("{\"title\":\"Issue subject\"}".to_string()),
        };

        upsert_activity_in_db(&db, &activity, 2_000).expect("insert activity");
        activity.title = "Updated title".to_string();
        upsert_activity_in_db(&db, &activity, 3_000).expect("update activity");
        save_activity_sync_run_in_db(&db, &connection.id, "1970-01-01", "success", None, 3_000)
            .expect("save sync run");

        let result = list_activities_in_db(&db, "1970-01-01", 0, 2_000).expect("list activities");

        assert_eq!(result.activities.len(), 1);
        assert_eq!(result.activities[0].title, "Updated title");
        assert_eq!(result.activities[0].fetched_at, 3_000);
        assert_eq!(
            result.activities[0].subject_json.as_deref(),
            Some("{\"title\":\"Issue subject\"}")
        );
        assert_eq!(result.sync_runs.len(), 1);
    }

    #[test]
    fn replaces_only_the_selected_gitlab_connection_day() {
        let mut db = memory_db();
        let gitlab = save_connection_in_db(
            &db,
            ConnectionInput {
                id: Some("gitlab_1".to_string()),
                provider: "gitlab".to_string(),
                name: "GitLab".to_string(),
                base_url: "https://gitlab.example.org".to_string(),
                api_key: None,
                token: "token".to_string(),
            },
        )
        .expect("save GitLab connection");
        let github = save_connection_in_db(
            &db,
            ConnectionInput {
                id: Some("github_1".to_string()),
                provider: "github".to_string(),
                name: "GitHub".to_string(),
                base_url: "https://github.com".to_string(),
                api_key: None,
                token: "token".to_string(),
            },
        )
        .expect("save GitHub connection");
        let activity = |provider: &str,
                        connection_id: &str,
                        external_id: &str,
                        occurred_at: i64| ActivityInput {
            provider: provider.to_string(),
            connection_id: connection_id.to_string(),
            external_id: external_id.to_string(),
            event_type: "Project".to_string(),
            action_label: "Pushed".to_string(),
            actor: Some("alexander".to_string()),
            title: external_id.to_string(),
            target_url: None,
            occurred_at,
            raw_json: "{}".to_string(),
            subject_json: None,
        };
        let stale = activity("gitlab", &gitlab.id, "stale", 1_100);
        let outside_day = activity("gitlab", &gitlab.id, "outside", 2_100);
        let other_connection = activity("github", &github.id, "other", 1_200);
        for item in [&stale, &outside_day, &other_connection] {
            upsert_activity_in_db(&db, item, 2_500).expect("seed activity");
        }

        let replacement = activity("gitlab", &gitlab.id, "replacement", 1_300);
        replace_gitlab_activity_sync_in_db(
            &mut db,
            &gitlab.id,
            "1970-01-01",
            1_000,
            2_000,
            &[replacement],
            3_000,
        )
        .expect("replace GitLab day");

        let selected_day =
            list_activities_in_db(&db, "1970-01-01", 1_000, 2_000).expect("list selected day");
        assert_eq!(selected_day.activities.len(), 2);
        assert!(selected_day
            .activities
            .iter()
            .any(|item| item.external_id == "replacement"));
        assert!(selected_day
            .activities
            .iter()
            .any(|item| item.external_id == "other"));
        assert!(!selected_day
            .activities
            .iter()
            .any(|item| item.external_id == "stale"));
        assert_eq!(selected_day.sync_runs[0].status, "success");

        let all_days =
            list_activities_in_db(&db, "1970-01-01", 1_000, 3_000).expect("list all days");
        assert!(all_days
            .activities
            .iter()
            .any(|item| item.external_id == "outside"));
    }

    #[test]
    fn failed_activity_sync_status_preserves_cached_rows() {
        let db = memory_db();
        let connection = save_connection_in_db(
            &db,
            ConnectionInput {
                id: Some("gitlab_1".to_string()),
                provider: "gitlab".to_string(),
                name: "GitLab".to_string(),
                base_url: "https://gitlab.example.org".to_string(),
                api_key: None,
                token: "token".to_string(),
            },
        )
        .expect("save GitLab connection");
        let cached = ActivityInput {
            provider: "gitlab".to_string(),
            connection_id: connection.id.clone(),
            external_id: "cached".to_string(),
            event_type: "Project".to_string(),
            action_label: "Pushed".to_string(),
            actor: Some("alexander".to_string()),
            title: "Cached activity".to_string(),
            target_url: None,
            occurred_at: 1_100,
            raw_json: "{}".to_string(),
            subject_json: None,
        };
        upsert_activity_in_db(&db, &cached, 2_000).expect("cache activity");

        save_activity_sync_run_in_db(
            &db,
            &connection.id,
            "1970-01-01",
            "failed",
            Some("provider unavailable"),
            3_000,
        )
        .expect("save failed sync");

        let result =
            list_activities_in_db(&db, "1970-01-01", 1_000, 2_000).expect("list cached activities");
        assert_eq!(result.activities.len(), 1);
        assert_eq!(result.activities[0].external_id, "cached");
        assert_eq!(result.sync_runs[0].status, "failed");
    }

    #[test]
    fn replaces_unlinked_gitlab_note_events_with_hydrated_note_activities() {
        let mut db = memory_db();
        let connection = save_connection_in_db(
            &db,
            ConnectionInput {
                id: Some("gitlab_1".to_string()),
                provider: "gitlab".to_string(),
                name: "GitLab".to_string(),
                base_url: "https://gitlab.example.org".to_string(),
                api_key: None,
                token: "token".to_string(),
            },
        )
        .expect("save GitLab connection");
        let cached = ActivityInput {
            provider: "gitlab".to_string(),
            connection_id: connection.id.clone(),
            external_id: "90678".to_string(),
            event_type: "DiffNote".to_string(),
            action_label: "Commented".to_string(),
            actor: Some("alexander".to_string()),
            title: "Edit Visit Form".to_string(),
            target_url: None,
            occurred_at: 1_100,
            raw_json: "{}".to_string(),
            subject_json: None,
        };
        upsert_activity_in_db(&db, &cached, 2_000).expect("cache unlinked activity");
        let hydrated = ActivityInput {
            external_id: "merge-request-note:97:2174:81299".to_string(),
            target_url: Some(
                "https://gitlab.example.org/group/app/-/merge_requests/2174#note_81299".to_string(),
            ),
            subject_json: Some(
                serde_json::json!({
                    "iid": 2174,
                    "title": "Edit Visit Form",
                    "web_url": "https://gitlab.example.org/group/app/-/merge_requests/2174"
                })
                .to_string(),
            ),
            ..cached.clone()
        };

        replace_gitlab_activity_sync_in_db(
            &mut db,
            &connection.id,
            "1970-01-01",
            1_000,
            2_000,
            &[hydrated],
            3_000,
        )
        .expect("replace GitLab activities");

        let result =
            list_activities_in_db(&db, "1970-01-01", 1_000, 2_000).expect("list activities");
        assert_eq!(result.activities.len(), 1);
        assert_eq!(
            result.activities[0].external_id,
            "merge-request-note:97:2174:81299"
        );
        assert!(result.activities[0].target_url.is_some());
        assert!(result.activities[0].subject_json.is_some());
    }

    #[test]
    fn normalizes_provider_activity_json() {
        let github = connection_record("github", None, "token");
        let github_event = serde_json::json!({
            "id": "123",
            "type": "IssuesEvent",
            "created_at": "2026-07-09T08:30:00Z",
            "actor": { "login": "alex" },
            "repo": { "name": "owner/repo" },
            "payload": {
                "action": "opened",
                "issue": {
                    "title": "Fix auth",
                    "html_url": "https://github.com/owner/repo/issues/1"
                }
            }
        });
        let start = parse_rfc3339_millis("2026-07-09T00:00:00Z").unwrap();
        let end = parse_rfc3339_millis("2026-07-10T00:00:00Z").unwrap();
        let activity =
            github_activity_from_json(&github, &github_event, start, end).expect("github activity");

        assert_eq!(activity.provider, "github");
        assert_eq!(activity.action_label, "Created");
        assert_eq!(activity.title, "Fix auth");
        assert_eq!(activity.actor.as_deref(), Some("alex"));

        let github_comment_event = serde_json::json!({
            "id": "124",
            "type": "IssueCommentEvent",
            "created_at": "2026-07-09T08:45:00Z",
            "actor": { "login": "alex" },
            "repo": { "name": "sulu/skeleton" },
            "payload": {
                "action": "created",
                "issue": {
                    "title": "Update dependencies",
                    "html_url": "https://github.com/sulu/skeleton/pull/325"
                },
                "comment": {
                    "body": "Looks good",
                    "html_url": "https://github.com/sulu/skeleton/pull/325#issuecomment-1"
                }
            }
        });
        let comment_activity =
            github_activity_from_json(&github, &github_comment_event, start, end)
                .expect("GitHub comment activity");

        assert_eq!(comment_activity.action_label, "Commented");

        let trello = connection_record("trello", Some("key"), "token");
        let trello_action = serde_json::json!({
            "id": "action_1",
            "type": "updateCard",
            "date": "2026-07-09T09:00:00.000Z",
            "memberCreator": { "username": "alex" },
            "data": {
                "card": { "name": "Review PR", "shortLink": "abc123" },
                "listAfter": { "name": "In Progress" },
                "old": { "idList": "list_before" }
            }
        });
        let activity = trello_activity_from_json(&trello, &trello_action, start, end)
            .expect("trello activity");

        assert_eq!(activity.provider, "trello");
        assert_eq!(activity.action_label, "Moved: In Progress");
        assert_eq!(activity.title, "Review PR");
        assert_eq!(
            activity.target_url.as_deref(),
            Some("https://trello.com/c/abc123")
        );

        let attachment_action = serde_json::json!({
            "id": "action_2",
            "type": "deleteAttachmentFromCard",
            "date": "2026-07-09T10:00:00.000Z",
            "memberCreator": { "username": "alex" },
            "data": {
                "card": { "name": "Review PR", "shortLink": "abc123" },
                "attachment": { "name": "spec.pdf" }
            }
        });
        let activity = trello_activity_from_json(&trello, &attachment_action, start, end)
            .expect("trello attachment activity");

        assert_eq!(activity.action_label, "Changed");

        let position_action = serde_json::json!({
            "id": "action_3",
            "type": "updateCard",
            "date": "2026-07-09T11:00:00.000Z",
            "memberCreator": { "username": "alex" },
            "data": {
                "card": { "name": "Review PR", "shortLink": "abc123" },
                "list": { "name": "Waiting for Approval" },
                "old": { "pos": 65535 }
            }
        });
        assert!(trello_activity_from_json(&trello, &position_action, start, end).is_none());

        let list_move_action = serde_json::json!({
            "id": "action_4",
            "type": "updateCard",
            "date": "2026-07-09T12:00:00.000Z",
            "memberCreator": { "username": "alex" },
            "data": {
                "card": { "name": "Review PR", "shortLink": "abc123" },
                "listBefore": { "name": "Inbox" },
                "listAfter": { "name": "Waiting for Approval" },
                "old": { "idList": "list_before", "pos": 65535 }
            }
        });
        let activity = trello_activity_from_json(&trello, &list_move_action, start, end)
            .expect("Trello list move activity");
        assert_eq!(activity.action_label, "Moved: Waiting for Approval");
    }

    #[test]
    fn hydrates_github_review_activity_with_its_parent_pull_request() {
        let github = connection_record("github", None, "token");
        let event = serde_json::json!({
            "id": "review-comment-1",
            "type": "PullRequestReviewCommentEvent",
            "created_at": "2026-07-09T09:42:21Z",
            "actor": { "login": "alexander-schranz" },
            "repo": { "name": "sulu/SuluProductBundle" },
            "payload": {
                "action": "created",
                "pull_request": {
                    "number": 391,
                    "url": "https://api.github.com/repos/sulu/SuluProductBundle/pulls/391"
                },
                "comment": {
                    "body": "Think it would be code/stage/version",
                    "html_url": "https://github.com/sulu/SuluProductBundle/pull/391#discussion_r1",
                    "pull_request_url": "https://api.github.com/repos/sulu/SuluProductBundle/pulls/391"
                }
            }
        });
        let start = parse_rfc3339_millis("2026-07-09T00:00:00Z").unwrap();
        let end = parse_rfc3339_millis("2026-07-10T00:00:00Z").unwrap();
        let locator = github_pull_request_locator(&event).expect("pull request locator");

        assert_eq!(
            locator.web_url,
            "https://github.com/sulu/SuluProductBundle/pull/391"
        );
        assert_eq!(locator.fallback_title, "sulu/SuluProductBundle PR #391");

        let review_event = serde_json::json!({
            "id": "review-1",
            "type": "PullRequestReviewEvent",
            "created_at": "2026-07-09T09:45:53Z",
            "actor": { "login": "alexander-schranz" },
            "repo": { "name": "sulu/SuluProductBundle" },
            "payload": {
                "action": "created",
                "pull_request": {
                    "number": 391,
                    "url": "https://api.github.com/repos/sulu/SuluProductBundle/pulls/391"
                },
                "review": {
                    "state": "commented",
                    "pull_request_url": "https://api.github.com/repos/sulu/SuluProductBundle/pulls/391"
                }
            }
        });
        assert_eq!(
            github_pull_request_locator(&review_event),
            Some(locator.clone())
        );
        let review_activity = github_activity_from_json(&github, &review_event, start, end)
            .expect("GitHub review activity");
        assert_eq!(review_activity.action_label, "Reviewed");
        assert_eq!(review_activity.title, "sulu/SuluProductBundle PR #391");

        let mut activity = github_activity_from_json(&github, &event, start, end)
            .expect("GitHub review comment activity");
        assert_eq!(activity.title, "sulu/SuluProductBundle PR #391");
        assert!(activity.subject_json.as_deref().is_some_and(|subject| {
            subject.contains("https://github.com/sulu/SuluProductBundle/pull/391")
        }));
        assert_eq!(
            activity.target_url.as_deref(),
            Some("https://github.com/sulu/SuluProductBundle/pull/391#discussion_r1")
        );

        let hydrated = serde_json::json!({
            "number": 391,
            "title": "Add product versioning",
            "html_url": "https://github.com/sulu/SuluProductBundle/pull/391",
            "user": { "login": "martinlagler" }
        });
        hydrate_github_pull_request_activity(
            &mut activity,
            &event,
            Some(&locator),
            Some(&hydrated),
        );
        assert_eq!(activity.title, "Add product versioning");
        assert!(activity.subject_json.as_deref().is_some_and(|subject| {
            subject.contains("Add product versioning") && subject.contains("martinlagler")
        }));
    }

    #[test]
    fn normalizes_only_gitlab_events_authored_by_the_current_user() {
        let gitlab = connection_record("gitlab", None, "token");
        let start = parse_rfc3339_millis("2026-07-17T00:00:00Z").unwrap();
        let end = parse_rfc3339_millis("2026-07-18T00:00:00Z").unwrap();
        let own_event = serde_json::json!({
            "id": 90716,
            "author_id": 3,
            "action_name": "commented on",
            "target_type": "Note",
            "target_title": "Review activity filtering",
            "created_at": "2026-07-17T11:42:25Z",
            "author": { "id": 3, "username": "alexander" }
        });

        let activity = gitlab_activity_from_json(&gitlab, &own_event, 3, start, end)
            .expect("own GitLab activity");
        assert_eq!(activity.actor.as_deref(), Some("alexander"));
        assert_eq!(activity.title, "Review activity filtering");

        let mut other_event = own_event.clone();
        other_event["author_id"] = Value::from(2);
        assert!(gitlab_activity_from_json(&gitlab, &other_event, 3, start, end).is_none());

        let mut missing_author = own_event.clone();
        missing_author
            .as_object_mut()
            .expect("event object")
            .remove("author_id");
        assert!(gitlab_activity_from_json(&gitlab, &missing_author, 3, start, end).is_none());

        let mut outside_day = own_event;
        outside_day["created_at"] = Value::from("2026-07-18T00:00:00Z");
        assert!(gitlab_activity_from_json(&gitlab, &outside_day, 3, start, end).is_none());
    }

    #[test]
    fn normalizes_gitlab_merge_request_activity_for_the_current_user() {
        let gitlab = connection_record("gitlab", None, "token");
        let merge_request = serde_json::json!({
            "id": 8738,
            "iid": 2180,
            "title": "Add migration",
            "description": "Tracks https://trello.com/c/abc123",
            "web_url": "https://gitlab.example.com/group/app/-/merge_requests/2180",
            "created_at": "2026-07-17T08:55:09.439Z",
            "merged_at": "2026-07-17T10:08:39.185Z",
            "closed_at": "2026-07-17T11:08:39.185Z",
            "author": { "id": 3, "username": "alexander" },
            "merge_user": { "id": 3, "username": "alexander" },
            "closed_by": { "id": 3, "username": "alexander" }
        });
        let start = parse_rfc3339_millis("2026-07-17T00:00:00Z").unwrap();
        let end = parse_rfc3339_millis("2026-07-18T00:00:00Z").unwrap();

        let activities =
            gitlab_merge_request_activities_from_json(&gitlab, &merge_request, 3, start, end);

        assert_eq!(activities.len(), 3);
        assert_eq!(activities[0].external_id, "merge-request:8738:created");
        assert_eq!(activities[0].action_label, "Created");
        assert_eq!(activities[1].external_id, "merge-request:8738:merged");
        assert_eq!(activities[1].action_label, "Merged");
        assert_eq!(activities[1].actor.as_deref(), Some("alexander"));
        assert_eq!(activities[1].event_type, "MergeRequest");
        assert_eq!(activities[2].external_id, "merge-request:8738:closed");
        assert_eq!(activities[2].action_label, "Closed");
        assert_eq!(
            activities[1]
                .subject_json
                .as_deref()
                .and_then(|value| serde_json::from_str::<Value>(value).ok())
                .and_then(|value| json_string(&value, "description")),
            Some("Tracks https://trello.com/c/abc123".to_string())
        );
    }

    #[test]
    fn attaches_gitlab_branch_pushes_and_deletes_to_their_merge_request() {
        let gitlab = connection_record("gitlab", None, "token");
        let start = parse_rfc3339_millis("2026-07-17T00:00:00Z").unwrap();
        let end = parse_rfc3339_millis("2026-07-18T00:00:00Z").unwrap();
        let event = |id, action_name| {
            serde_json::json!({
                "id": id,
                "author_id": 3,
                "project_id": 55,
                "action_name": action_name,
                "created_at": "2026-07-17T10:00:00Z",
                "push_data": { "ref": "feature/summary", "ref_type": "branch" }
            })
        };
        let mut activities = [
            gitlab_activity_from_json(&gitlab, &event(1, "pushed to"), 3, start, end).unwrap(),
            gitlab_activity_from_json(&gitlab, &event(2, "deleted"), 3, start, end).unwrap(),
        ];
        let merge_requests = [serde_json::json!({
            "id": 90,
            "iid": 9,
            "project_id": 55,
            "source_project_id": 55,
            "source_branch": "feature/summary",
            "title": "Improve summary",
            "description": "Tracks https://trello.com/c/summary-card",
            "web_url": "https://gitlab.example.com/acme/app/-/merge_requests/9"
        })];

        attach_gitlab_branch_activities_to_merge_requests(&mut activities, &merge_requests);

        for activity in activities {
            assert_eq!(activity.title, "Improve summary");
            assert_eq!(
                activity.target_url.as_deref(),
                Some("https://gitlab.example.com/acme/app/-/merge_requests/9")
            );
            assert!(activity
                .subject_json
                .as_deref()
                .is_some_and(|subject| subject.contains("summary-card")));
        }
    }

    #[test]
    fn normalizes_current_user_gitlab_merge_request_discussion_notes() {
        let gitlab = connection_record("gitlab", None, "token");
        let merge_request = serde_json::json!({
            "id": 8727,
            "iid": 2175,
            "project_id": 55,
            "title": "Fix timeprofile validator",
            "description": "Tracks https://trello.com/c/abc123",
            "web_url": "https://gitlab.example.com/group/app/-/merge_requests/2175",
            "author": { "id": 9, "username": "author" }
        });
        let discussions = vec![serde_json::json!({
            "id": "discussion-1",
            "notes": [
                {
                    "id": 103,
                    "type": "DiscussionNote",
                    "body": "Reply",
                    "system": false,
                    "created_at": "2026-07-17T10:00:00Z",
                    "author": { "id": 3, "username": "alexander" }
                },
                {
                    "id": 101,
                    "body": "General comment",
                    "system": false,
                    "created_at": "2026-07-17T08:00:00Z",
                    "author": { "id": 3, "username": "alexander" }
                },
                {
                    "id": 102,
                    "type": "DiffNote",
                    "body": "Inline comment",
                    "system": false,
                    "created_at": "2026-07-17T09:00:00Z",
                    "author": { "id": 3, "name": "Alexander" }
                },
                {
                    "id": 107,
                    "body": "approved this merge request",
                    "system": true,
                    "created_at": "2026-07-17T09:30:00Z",
                    "author": { "id": 3, "username": "alexander" }
                },
                {
                    "id": 104,
                    "body": "Other user",
                    "system": false,
                    "created_at": "2026-07-17T11:00:00Z",
                    "author": { "id": 4, "username": "other" }
                },
                {
                    "id": 105,
                    "body": "System note",
                    "system": true,
                    "created_at": "2026-07-17T12:00:00Z",
                    "author": { "id": 3, "username": "alexander" }
                },
                {
                    "id": 108,
                    "body": "approved this merge request",
                    "system": true,
                    "created_at": "2026-07-17T13:00:00Z",
                    "author": { "id": 4, "username": "other" }
                },
                {
                    "id": 106,
                    "body": "Outside the day",
                    "system": false,
                    "created_at": "2026-07-18T00:00:00Z",
                    "author": { "id": 3, "username": "alexander" }
                },
                {
                    "id": 109,
                    "body": "approved this merge request",
                    "system": true,
                    "created_at": "2026-07-18T00:00:00Z",
                    "author": { "id": 3, "username": "alexander" }
                }
            ]
        })];
        let start = parse_rfc3339_millis("2026-07-17T00:00:00Z").unwrap();
        let end = parse_rfc3339_millis("2026-07-18T00:00:00Z").unwrap();

        let activities = gitlab_merge_request_note_activities_from_json(
            &gitlab,
            &merge_request,
            &discussions,
            3,
            start,
            end,
        );

        assert_eq!(activities.len(), 4);
        assert_eq!(activities[0].external_id, "merge-request-note:55:2175:101");
        assert_eq!(activities[1].external_id, "merge-request-note:55:2175:102");
        assert_eq!(activities[2].external_id, "merge-request-note:55:2175:107");
        assert_eq!(activities[3].external_id, "merge-request-note:55:2175:103");
        assert!(activities[..2]
            .iter()
            .chain(&activities[3..])
            .all(|activity| {
                activity.event_type == "Note" && activity.action_label == "Commented"
            }));
        assert_eq!(activities[2].event_type, "MergeRequestApproval");
        assert_eq!(activities[2].action_label, "Approved");
        assert_eq!(activities[2].actor.as_deref(), Some("alexander"));
        assert_eq!(
            activities[2].occurred_at,
            parse_rfc3339_millis("2026-07-17T09:30:00Z").unwrap()
        );
        assert_eq!(
            activities[2].target_url.as_deref(),
            Some("https://gitlab.example.com/group/app/-/merge_requests/2175")
        );
        assert_eq!(
            serde_json::from_str::<Value>(&activities[2].raw_json)
                .ok()
                .and_then(|value| json_string(&value, "body")),
            Some("approved this merge request".to_string())
        );
        assert_eq!(
            activities[2].subject_json.as_deref(),
            Some(merge_request.to_string().as_str())
        );
        assert_eq!(activities[0].actor.as_deref(), Some("alexander"));
        assert_eq!(activities[1].actor.as_deref(), Some("Alexander"));
        assert_eq!(
            activities[1].target_url.as_deref(),
            Some("https://gitlab.example.com/group/app/-/merge_requests/2175#note_102")
        );
        assert_eq!(
            activities[0]
                .subject_json
                .as_deref()
                .and_then(|value| serde_json::from_str::<Value>(value).ok())
                .and_then(|value| json_string(&value, "description")),
            Some("Tracks https://trello.com/c/abc123".to_string())
        );
        assert_eq!(
            serde_json::from_str::<Value>(&activities[3].raw_json)
                .ok()
                .and_then(|value| json_string(&value, "body")),
            Some("Reply".to_string())
        );
        assert_eq!(
            canonical_activity_action("approve").as_deref(),
            Some("Approved")
        );
        assert_eq!(
            canonical_activity_action("approved").as_deref(),
            Some("Approved")
        );
    }

    #[test]
    fn gitlab_merge_request_note_identity_deduplicates_event_and_discussion_activity() {
        let gitlab = connection_record("gitlab", None, "token");
        let event = serde_json::json!({
            "project_id": 55,
            "target_type": "Note",
            "note": {
                "id": 101,
                "noteable_type": "MergeRequest",
                "noteable_iid": 2175
            }
        });
        assert_eq!(
            gitlab_event_merge_request_note_id(&event).as_deref(),
            Some("101")
        );
        let external_id = gitlab_merge_request_note_external_id("55", "2175", "101");
        let event_activity = ActivityInput {
            provider: "gitlab".to_string(),
            connection_id: gitlab.id.clone(),
            external_id: external_id.clone(),
            event_type: "Note".to_string(),
            action_label: "Commented".to_string(),
            actor: Some("alexander".to_string()),
            title: "MR".to_string(),
            target_url: None,
            occurred_at: 1,
            raw_json: "event".to_string(),
            subject_json: None,
        };
        let mut discussion_activity = event_activity.clone();
        discussion_activity.raw_json = "discussion".to_string();
        discussion_activity.target_url = Some("https://gitlab.example/mr#note_101".to_string());

        let activities =
            deduplicate_activities_prefer_latest(vec![event_activity, discussion_activity]);

        assert_eq!(activities.len(), 1);
        assert_eq!(activities[0].external_id, external_id);
        assert_eq!(activities[0].raw_json, "discussion");
        assert_eq!(
            activities[0].target_url.as_deref(),
            Some("https://gitlab.example/mr#note_101")
        );
    }

    #[test]
    fn locates_gitlab_merge_request_note_subjects() {
        for target_type in ["Note", "DiffNote", "DiscussionNote"] {
            let event = serde_json::json!({
                "project_id": 55,
                "target_type": target_type,
                "note": {
                    "id": 81299,
                    "noteable_type": "MergeRequest",
                    "noteable_iid": 2180
                }
            });
            assert_eq!(
                gitlab_event_merge_request_locator(&event),
                Some(("55".to_string(), "2180".to_string()))
            );
            assert_eq!(
                gitlab_event_merge_request_note_id(&event),
                Some("81299".to_string())
            );
        }
        assert_eq!(
            gitlab_event_merge_request_locator(&serde_json::json!({
                "project_id": 55,
                "target_type": "Note",
                "note": { "noteable_type": "Issue", "noteable_iid": 12 }
            })),
            None
        );
    }

    #[test]
    fn hydrates_gitlab_diff_and_discussion_note_events_with_merge_request_metadata() {
        let gitlab = connection_record("gitlab", None, "token");
        let merge_request = serde_json::json!({
            "id": 8727,
            "iid": 2175,
            "project_id": 97,
            "title": "Fix timeprofile validator",
            "description": "Tracks https://trello.com/c/abc123",
            "web_url": "https://gitlab.example.com/group/app/-/merge_requests/2175"
        });
        let start = parse_rfc3339_millis("2026-07-17T00:00:00Z").unwrap();
        let end = parse_rfc3339_millis("2026-07-18T00:00:00Z").unwrap();

        for (target_type, event_id, note_id) in
            [("DiffNote", 90678, 81299), ("DiscussionNote", 90545, 81166)]
        {
            let event = serde_json::json!({
                "id": event_id,
                "project_id": 97,
                "target_type": target_type,
                "target_title": "Unhydrated title",
                "action_name": "commented on",
                "author_id": 3,
                "author": { "id": 3, "username": "alexander" },
                "created_at": "2026-07-17T10:08:02.444Z",
                "note": {
                    "id": note_id,
                    "noteable_type": "MergeRequest",
                    "noteable_iid": 2175,
                    "project_id": 97,
                    "system": false
                }
            });
            let mut activity = gitlab_activity_from_json(&gitlab, &event, 3, start, end)
                .expect("normalize GitLab note event");

            hydrate_gitlab_merge_request_event_activity(
                &mut activity,
                &event,
                "97",
                "2175",
                &merge_request,
            );

            assert_eq!(
                activity.external_id,
                format!("merge-request-note:97:2175:{note_id}")
            );
            assert_eq!(activity.title, "Fix timeprofile validator");
            assert_eq!(
                activity.target_url.as_deref(),
                Some(
                    format!(
                        "https://gitlab.example.com/group/app/-/merge_requests/2175#note_{note_id}"
                    )
                    .as_str()
                )
            );
            assert_eq!(
                activity
                    .subject_json
                    .as_deref()
                    .and_then(|value| serde_json::from_str::<Value>(value).ok())
                    .and_then(|value| json_string(&value, "description")),
                Some("Tracks https://trello.com/c/abc123".to_string())
            );
        }
    }

    #[test]
    fn parses_trello_card_short_links_for_ticket_resolution() {
        assert_eq!(
            trello_card_short_link_from_url("https://trello.com/c/abc123/a-slug?x=1#comments"),
            Some("abc123".to_string())
        );
        assert_eq!(
            trello_card_short_link_from_url("https://trello.com/b/board123"),
            None
        );

        let response = ResolveTrelloTicketsResult {
            tickets: vec![ResolvedTrelloTicket {
                external_id: "abc123".to_string(),
                title: "Ticket".to_string(),
                url: "https://trello.com/c/abc123".to_string(),
                board_external_id: Some("board123".to_string()),
                board_name: Some("Board".to_string()),
                connection_id: "trello_1".to_string(),
            }],
            warnings: vec![],
        };
        let json = serde_json::to_value(response).expect("serialize resolver response");
        assert_eq!(json["tickets"][0]["boardExternalId"], "board123");
        assert_eq!(json["tickets"][0]["connectionId"], "trello_1");
    }

    #[test]
    fn ignores_gitlab_merge_request_actions_by_other_users_or_outside_the_day() {
        let gitlab = connection_record("gitlab", None, "token");
        let merge_request = serde_json::json!({
            "id": 42,
            "title": "Existing merge request",
            "web_url": "https://gitlab.example.com/group/app/-/merge_requests/42",
            "created_at": "2026-07-16T23:59:59.999Z",
            "merged_at": "2026-07-17T10:00:00Z",
            "closed_at": null,
            "author": { "id": 3, "username": "alexander" },
            "merge_user": { "id": 4, "username": "reviewer" },
            "closed_by": null
        });
        let start = parse_rfc3339_millis("2026-07-17T00:00:00Z").unwrap();
        let end = parse_rfc3339_millis("2026-07-18T00:00:00Z").unwrap();

        let activities =
            gitlab_merge_request_activities_from_json(&gitlab, &merge_request, 3, start, end);

        assert!(activities.is_empty());
    }

    #[test]
    fn saves_global_directories_without_git_validation() {
        let db = memory_db();
        let directory_path = temp_test_path("studio-directory");
        fs::create_dir_all(&directory_path).expect("create temp directory");

        let directory = save_directory_in_db(
            &db,
            DirectoryInput {
                path: directory_path.to_string_lossy().to_string(),
            },
        )
        .expect("save directory");

        assert_eq!(
            directory.path,
            fs::canonicalize(&directory_path)
                .expect("canonical path")
                .to_string_lossy()
                .to_string()
        );
        assert_eq!(
            directory.name,
            directory_path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .to_string()
        );
        assert!(directory.created_at > 0);
        assert!(directory.updated_at > 0);

        fs::remove_dir_all(directory_path).expect("remove temp directory");
    }

    #[test]
    fn rejects_missing_directory_paths() {
        let db = memory_db();
        let error = save_directory_in_db(
            &db,
            DirectoryInput {
                path: temp_test_path("missing-directory")
                    .to_string_lossy()
                    .to_string(),
            },
        )
        .expect_err("reject missing directory");

        assert_eq!(error, "Directory does not exist.");
    }

    #[test]
    fn rejects_file_paths_as_directories() {
        let db = memory_db();
        let file_path = temp_test_path("studio-directory-file");
        fs::write(&file_path, "not a directory").expect("create temp file");

        let error = save_directory_in_db(
            &db,
            DirectoryInput {
                path: file_path.to_string_lossy().to_string(),
            },
        )
        .expect_err("reject file path");

        assert_eq!(error, "Path must be a directory.");
        fs::remove_file(file_path).expect("remove temp file");
    }

    #[test]
    fn updates_existing_directory_for_duplicate_paths() {
        let db = memory_db();
        let directory_path = temp_test_path("studio-duplicate-directory");
        fs::create_dir_all(&directory_path).expect("create temp directory");
        let input_path = directory_path.to_string_lossy().to_string();

        let first = save_directory_in_db(
            &db,
            DirectoryInput {
                path: input_path.clone(),
            },
        )
        .expect("save first directory");
        let second = save_directory_in_db(&db, DirectoryInput { path: input_path })
            .expect("save duplicate directory");
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM directories", [], |row| row.get(0))
            .expect("count directories");

        assert_eq!(first.id, second.id);
        assert_eq!(count, 1);

        fs::remove_dir_all(directory_path).expect("remove temp directory");
    }

    #[test]
    fn lists_latest_files_from_configured_directories() {
        let db = memory_db();
        let directory_path = temp_test_path("studio-recent-files");
        let nested_path = directory_path.join("nested");
        fs::create_dir_all(&nested_path).expect("create nested temp directory");

        save_directory_in_db(
            &db,
            DirectoryInput {
                path: directory_path.to_string_lossy().to_string(),
            },
        )
        .expect("save directory");

        for index in 0..6 {
            let path = if index % 2 == 0 {
                directory_path.join(format!("file-{index}.txt"))
            } else {
                nested_path.join(format!("file-{index}.txt"))
            };
            fs::write(path, format!("file {index}")).expect("write temp file");
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        fs::write(directory_path.join(".DS_Store"), "metadata").expect("write hidden temp file");
        let hidden_path = directory_path.join(".hidden");
        fs::create_dir_all(&hidden_path).expect("create hidden temp directory");
        fs::write(hidden_path.join("file-7.txt"), "hidden").expect("write hidden nested temp file");

        let files = list_recent_directory_files_in_db(&db, 5).expect("list recent directory files");

        assert_eq!(files.len(), 5);
        assert!(files.iter().all(|file| file.path.ends_with(".txt")));
        assert!(files.iter().all(|file| !file.name.starts_with('.')));
        assert!(files
            .iter()
            .all(|file| !file.relative_path.starts_with(".hidden")));
        assert!(files
            .iter()
            .any(|file| file.relative_path.contains("nested")));
        assert!(files
            .windows(2)
            .all(|window| window[0].modified_at >= window[1].modified_at));

        fs::remove_dir_all(directory_path).expect("remove temp directory");
    }

    #[test]
    fn task_files_json_defaults_invalid_values_to_empty() {
        assert!(task_files_from_json(None).is_empty());
        assert!(task_files_from_json(Some("not json")).is_empty());
        assert!(task_files_from_json(Some("{}")).is_empty());
    }

    #[test]
    fn external_labels_round_trip_and_invalid_json_defaults_to_empty() {
        let labels = vec![ExternalLabel {
            name: "Bug".to_string(),
            color: Some("#eb5a46".to_string()),
        }];
        assert_eq!(
            external_labels_from_json(Some(&external_labels_to_json(&labels))),
            labels
        );
        assert!(external_labels_from_json(None).is_empty());
        assert!(external_labels_from_json(Some("not json")).is_empty());
    }

    #[test]
    fn provider_labels_are_normalized_with_colors_and_fallbacks() {
        let trello = trello_labels(&serde_json::json!({
            "labels": [
                { "name": " Bug ", "color": "red" },
                { "name": "Bug", "color": "blue" },
                { "name": "", "color": "green" },
                { "name": "Uncolored", "color": null }
            ]
        }));
        assert_eq!(
            trello,
            vec![
                ExternalLabel {
                    name: "Bug".to_string(),
                    color: Some("#eb5a46".to_string())
                },
                ExternalLabel {
                    name: "Uncolored".to_string(),
                    color: None
                },
            ]
        );

        let github = github_labels(&serde_json::json!({
            "labels": [
                { "name": "feature", "color": "ABCDEF" },
                { "name": "invalid", "color": "not-hex" }
            ]
        }));
        assert_eq!(github[0].color.as_deref(), Some("#abcdef"));
        assert_eq!(github[1].color, None);

        let gitlab_json = serde_json::json!({ "labels": ["backend", "unknown"] });
        let gitlab = gitlab_labels_with_catalog(
            &gitlab_json,
            &[serde_json::json!({ "name": "backend", "color": "#1F75CB" })],
        );
        assert_eq!(gitlab[0].color.as_deref(), Some("#1f75cb"));
        assert_eq!(gitlab[1].color, None);
        assert_eq!(gitlab_labels_with_catalog(&gitlab_json, &[])[0].color, None);
    }

    #[test]
    fn trello_attachment_files_maps_uploaded_files_only() {
        let json = serde_json::json!([
            {
                "id": "attachment_1",
                "name": "Design spec.pdf",
                "url": "https://trello.com/1/cards/card123/attachments/attachment_1/download/spec.pdf",
                "isUpload": true,
                "mimeType": "application/pdf",
                "bytes": 2048,
                "date": "2026-07-09T10:00:00.000Z"
            },
            {
                "id": "attachment_2",
                "name": "Trello link attachment",
                "url": "https://example.com/spec",
                "isUpload": false
            },
            {
                "id": "attachment_2",
                "name": "No URL"
            }
        ]);

        let files = trello_attachment_files(&json);

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].id, "attachment_1");
        assert_eq!(files[0].name, "Design spec.pdf");
        assert_eq!(files[0].source, "trello");
        assert_eq!(files[0].content_type.as_deref(), Some("application/pdf"));
        assert_eq!(files[0].bytes, Some(2048));
        assert_eq!(
            files[0].created_at.as_deref(),
            Some("2026-07-09T10:00:00.000Z")
        );
    }

    #[test]
    fn connects_resource_without_duplicates() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let input = ResourceInput {
            project_id: project.id.clone(),
            provider: "trello".to_string(),
            kind: "trello_board".to_string(),
            external_id: "abc123".to_string(),
            url: "https://trello.com/b/abc123/work".to_string(),
            name: "Work".to_string(),
            icon_url: None,
            connection_id: None,
        };
        let first = connect_resource_in_db(&db, input).expect("connect resource");
        let duplicate = connect_resource_in_db(
            &db,
            ResourceInput {
                project_id: project.id,
                provider: "trello".to_string(),
                kind: "trello_board".to_string(),
                external_id: "abc123".to_string(),
                url: "https://trello.com/b/abc123/work".to_string(),
                name: "Work".to_string(),
                icon_url: None,
                connection_id: None,
            },
        )
        .expect("connect duplicate");

        assert_eq!(first.id, duplicate.id);
    }

    #[test]
    fn connects_same_external_resource_to_multiple_projects() {
        let db = memory_db();
        let first_project =
            create_project_in_db(&db, "Access".to_string(), None, None).expect("first project");
        let second_project =
            create_project_in_db(&db, "Portal".to_string(), None, None).expect("second project");

        let first = connect_resource_in_db(
            &db,
            ResourceInput {
                project_id: first_project.id.clone(),
                provider: "github".to_string(),
                kind: "github_repo".to_string(),
                external_id: "github.com/owner/repo".to_string(),
                url: "https://github.com/owner/repo".to_string(),
                name: "owner/repo".to_string(),
                icon_url: None,
                connection_id: None,
            },
        )
        .expect("connect first resource");
        let second = connect_resource_in_db(
            &db,
            ResourceInput {
                project_id: second_project.id.clone(),
                provider: "github".to_string(),
                kind: "github_repo".to_string(),
                external_id: "github.com/owner/repo".to_string(),
                url: "https://github.com/owner/repo".to_string(),
                name: "owner/repo".to_string(),
                icon_url: None,
                connection_id: None,
            },
        )
        .expect("connect second resource");

        assert_ne!(first.id, second.id);
        assert_eq!(first.project_id, first_project.id);
        assert_eq!(second.project_id, second_project.id);
    }

    #[test]
    fn smart_task_auto_connects_github_repo_resource() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");

        let result = create_smart_task_in_db(
            &db,
            "https://github.com/owner/repo/pull/42".to_string(),
            parsed_github_pull_request("https://github.com/owner/repo/pull/42"),
            Some(project.id.clone()),
        )
        .expect("create smart task");

        let resource = result.resource.expect("resource");
        assert_eq!(resource.project_id, project.id);
        assert_eq!(resource.provider, "github");
        assert_eq!(resource.kind, "github_repo");
        assert_eq!(resource.external_id, "github.com/owner/repo");
        assert_eq!(resource.url, "https://github.com/owner/repo");
    }

    #[test]
    fn smart_task_auto_connects_gitlab_repo_resource() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");

        let result = create_smart_task_in_db(
            &db,
            "https://gitlab.example.org/group/app/-/merge_requests/17".to_string(),
            parsed_gitlab(
                "https://gitlab.example.org/group/app/-/merge_requests/17",
                "gitlab.example.org",
            ),
            Some(project.id.clone()),
        )
        .expect("create smart task");

        let resource = result.resource.expect("resource");
        assert_eq!(resource.project_id, project.id);
        assert_eq!(resource.provider, "gitlab");
        assert_eq!(resource.kind, "gitlab_repo");
        assert_eq!(resource.external_id, "gitlab.example.org/group/app");
        assert_eq!(resource.url, "https://gitlab.example.org/group/app");
    }

    #[test]
    fn trello_card_parent_metadata_connects_board_resource() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let parsed = parsed_trello_card("https://trello.com/c/card123/review");
        let metadata = ProviderMetadata {
            parent_resource: Some(ProviderResourceMetadata {
                provider: "trello".to_string(),
                kind: "trello_board".to_string(),
                external_id: "board123".to_string(),
                url: "https://trello.com/b/board123/access".to_string(),
                name: "Access".to_string(),
                icon_url: None,
            }),
            ..ProviderMetadata::empty()
        };

        let resource = upsert_parent_resource_in_db(&db, &project.id, &parsed, Some(&metadata))
            .expect("connect parent resource")
            .expect("parent resource");

        assert_eq!(resource.provider, "trello");
        assert_eq!(resource.kind, "trello_board");
        assert_eq!(resource.external_id, "board123");
        assert_eq!(resource.project_id, project.id);
    }

    #[test]
    fn creates_task_and_links_resource() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let task = create_task_in_db(
            &db,
            Some(project.id),
            "Review PR".to_string(),
            "Review PR".to_string(),
            Some("https://trello.com/c/card123/review-pr".to_string()),
        )
        .expect("task");

        link_task_resource_in_db(
            &db,
            task.id.clone(),
            "trello".to_string(),
            "trello_card".to_string(),
            "card123".to_string(),
            "https://trello.com/c/card123/review-pr".to_string(),
            &ProviderMetadata::empty(),
        )
        .expect("link");

        let linked = get_task_by_link(&db, "trello", "trello_card", "card123")
            .expect("query linked")
            .expect("linked task");
        assert_eq!(linked.id, task.id);
        assert_eq!(linked.source_provider.as_deref(), Some("trello"));
        assert_eq!(linked.source_kind.as_deref(), Some("trello_card"));

        let mut statement = db
            .prepare(
                "SELECT task_id, provider, kind, external_id, url, connection_id, external_title, external_body, external_state, external_state_color, target_branch, fetched_at, files_json, comments_json, labels_json
                 FROM task_links WHERE task_id = ?1",
            )
            .expect("prepare task links query");
        let links = statement
            .query_map(params![task.id], row_to_task_link)
            .expect("query task links")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect task links");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].kind, "trello_card");

        link_task_resource_in_db(
            &db,
            task.id.clone(),
            "github".to_string(),
            "github_issue".to_string(),
            "owner/repo#12".to_string(),
            "https://github.com/owner/repo/issues/12".to_string(),
            &ProviderMetadata::empty(),
        )
        .expect("replace link");

        let links = statement
            .query_map(params![task.id], row_to_task_link)
            .expect("query replaced task links")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect replaced task links");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].provider, "github");
        assert_eq!(links[0].kind, "github_issue");
    }

    #[test]
    fn deletes_task_with_links_and_relations() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let parent = create_task_in_db(
            &db,
            Some(project.id.clone()),
            "Parent".to_string(),
            "".to_string(),
            None,
        )
        .expect("parent task");
        let child = create_task_in_db(
            &db,
            Some(project.id),
            "Child".to_string(),
            "".to_string(),
            None,
        )
        .expect("child task");

        link_task_resource_in_db(
            &db,
            parent.id.clone(),
            "trello".to_string(),
            "trello_card".to_string(),
            "card123".to_string(),
            "https://trello.com/c/card123/review".to_string(),
            &ProviderMetadata::empty(),
        )
        .expect("link task resource");
        save_task_relation_in_db(
            &db,
            TaskRelationInput {
                id: None,
                source_task_id: parent.id.clone(),
                target_task_id: child.id.clone(),
                relation_type: "related".to_string(),
            },
        )
        .expect("save relation");

        delete_task_in_db(&db, &parent.id).expect("delete task");

        assert!(get_task(&db, &parent.id)
            .expect("load deleted task")
            .is_none());
        assert_eq!(
            list_task_links_in_db(&db, &parent.id)
                .expect("load deleted task links")
                .len(),
            0
        );
        let relation_count: i64 = db
            .query_row("SELECT COUNT(*) FROM task_relations", [], |row| row.get(0))
            .expect("count task relations");
        assert_eq!(relation_count, 0);
    }

    #[test]
    fn review_comment_drafts_persist_update_and_cascade_with_tasks() {
        let db = memory_db();
        let task =
            create_task_in_db(&db, None, "Review".to_string(), "".to_string(), None).expect("task");
        let summary = save_review_comment_draft_in_db(
            &db,
            ReviewCommentDraftInput {
                id: None,
                task_id: task.id.clone(),
                kind: "overall".to_string(),
                body: "Initial summary".to_string(),
                path: None,
                old_path: None,
                new_path: None,
                start_old_line: None,
                start_new_line: None,
                start_side: None,
                old_line: None,
                new_line: None,
                side: None,
                head_sha: None,
            },
        )
        .expect("summary");
        let updated = save_review_comment_draft_in_db(
            &db,
            ReviewCommentDraftInput {
                id: None,
                task_id: task.id.clone(),
                kind: "overall".to_string(),
                body: "Updated summary".to_string(),
                path: None,
                old_path: None,
                new_path: None,
                start_old_line: None,
                start_new_line: None,
                start_side: None,
                old_line: None,
                new_line: None,
                side: None,
                head_sha: None,
            },
        )
        .expect("update summary");
        assert_eq!(summary.id, updated.id);

        save_review_comment_draft_in_db(
            &db,
            ReviewCommentDraftInput {
                id: None,
                task_id: task.id.clone(),
                kind: "inline".to_string(),
                body: "Please rename this.".to_string(),
                path: Some("src/app.rs".to_string()),
                old_path: Some("src/app.rs".to_string()),
                new_path: Some("src/app.rs".to_string()),
                start_old_line: None,
                start_new_line: Some(10),
                start_side: Some("RIGHT".to_string()),
                old_line: None,
                new_line: Some(12),
                side: Some("RIGHT".to_string()),
                head_sha: Some("abc123".to_string()),
            },
        )
        .expect("inline draft");
        assert_eq!(
            list_review_comment_drafts_in_db(&db, &task.id)
                .expect("drafts")
                .len(),
            2
        );

        delete_task_in_db(&db, &task.id).expect("delete task");
        assert!(list_review_comment_drafts_in_db(&db, &task.id)
            .expect("drafts after delete")
            .is_empty());
    }

    #[test]
    fn review_comment_drafts_validate_inline_anchors() {
        let input = ReviewCommentDraftInput {
            id: None,
            task_id: "task".to_string(),
            kind: "inline".to_string(),
            body: "Comment".to_string(),
            path: Some("src/app.rs".to_string()),
            old_path: None,
            new_path: None,
            start_old_line: None,
            start_new_line: None,
            start_side: None,
            old_line: None,
            new_line: None,
            side: Some("RIGHT".to_string()),
            head_sha: Some("abc123".to_string()),
        };
        assert_eq!(
            validate_review_comment_draft(&input).unwrap_err(),
            "A right-side review comment requires a new line."
        );
    }

    #[test]
    fn builds_github_and_gitlab_multiline_positions() {
        let draft = ReviewCommentDraft {
            id: "draft".to_string(),
            task_id: "task".to_string(),
            kind: "inline".to_string(),
            body: "Comment".to_string(),
            path: Some("src/app.rs".to_string()),
            old_path: Some("src/app.rs".to_string()),
            new_path: Some("src/app.rs".to_string()),
            start_old_line: Some(10),
            start_new_line: Some(10),
            start_side: Some("RIGHT".to_string()),
            old_line: Some(12),
            new_line: Some(13),
            side: Some("RIGHT".to_string()),
            head_sha: Some("abc123".to_string()),
            last_error: None,
            created_at: 1,
            updated_at: 1,
        };
        let github = github_review_comment_payload(&draft);
        assert_eq!(github["start_line"], 10);
        assert_eq!(github["start_side"], "RIGHT");
        assert_eq!(github["line"], 13);
        assert_eq!(github["side"], "RIGHT");

        let gitlab = gitlab_review_position(&draft, "base", "start", "head");
        assert_eq!(gitlab["base_sha"], "base");
        assert_eq!(gitlab["new_line"], 13);
        assert_eq!(gitlab["line_range"]["start"]["old_line"], 10);
        assert_eq!(gitlab["line_range"]["start"]["new_line"], 10);
        assert_eq!(gitlab["line_range"]["end"]["old_line"], 12);
        assert_eq!(gitlab["line_range"]["end"]["new_line"], 13);

        assert_eq!(
            gitlab_line_code("src/app.rs", Some(10), Some(10)),
            "a841ae12f0c6bcc9fffab1c77aa87ed0e21a0708_10_10"
        );
        let added = gitlab_range_point("src/app.rs", None, Some(13));
        assert_eq!(added["type"], "new");
        assert_eq!(added["old_line"], Value::Null);
        assert_eq!(added["new_line"], 13);

        let mut single = draft.clone();
        single.start_old_line = single.old_line;
        single.start_new_line = single.new_line;
        let github_single = github_review_comment_payload(&single);
        assert!(github_single.get("start_line").is_none());
        let gitlab_single = gitlab_review_position(&single, "base", "start", "head");
        assert!(gitlab_single.get("line_range").is_none());
    }

    #[test]
    fn review_diff_paths_preserve_renames_and_deleted_files() {
        assert_eq!(
            review_diff_paths("--- a/old.rs\n+++ b/new.rs", "new.rs"),
            ("old.rs".to_string(), "new.rs".to_string())
        );
        assert_eq!(
            review_diff_paths("--- a/deleted.rs\n+++ /dev/null", "deleted.rs"),
            ("deleted.rs".to_string(), "deleted.rs".to_string())
        );
    }

    #[test]
    fn trello_refresh_requires_enabled_project_connection() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let task = create_task_in_db(
            &db,
            Some(project.id),
            "Review auth".to_string(),
            "Local notes".to_string(),
            Some("https://trello.com/c/card123/review-auth".to_string()),
        )
        .expect("task");
        let cached_metadata = ProviderMetadata {
            comments: vec![TaskComment {
                id: "trello:comment-1".to_string(),
                kind: "comment".to_string(),
                author: "Alice".to_string(),
                body: "Cached comment".to_string(),
                created_at: Some("2026-07-15T09:00:00Z".to_string()),
                updated_at: None,
                url: None,
                discussion_id: None,
                reply_to_id: None,
                code_context: None,
            }],
            labels: vec![ExternalLabel {
                name: "Cached".to_string(),
                color: Some("#0079bf".to_string()),
            }],
            ..ProviderMetadata::empty()
        };
        link_task_resource_in_db(
            &db,
            task.id.clone(),
            "trello".to_string(),
            "trello_card".to_string(),
            "card123".to_string(),
            "https://trello.com/c/card123/review-auth".to_string(),
            &cached_metadata,
        )
        .expect("link trello card");

        let result = refresh_task_external_details_in_db(&db, task.id).expect("refresh");

        assert!(result.connection_required);
        assert_eq!(result.task.body, "Local notes");
        assert_eq!(result.links[0].comments[0].body, "Cached comment");
        assert_eq!(result.links[0].labels[0].name, "Cached");
        assert_eq!(
            result.notice.as_deref(),
            Some("Please add a Trello connection to this project.")
        );
    }

    #[test]
    fn provider_metadata_replaces_task_notes_status_and_link_metadata() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let connection = save_connection_in_db(
            &db,
            ConnectionInput {
                id: None,
                provider: "trello".to_string(),
                name: "Trello".to_string(),
                base_url: "https://trello.com".to_string(),
                api_key: Some("key".to_string()),
                token: "token".to_string(),
            },
        )
        .expect("connection");
        let task = create_task_in_db(
            &db,
            Some(project.id),
            "Review auth".to_string(),
            "Local notes".to_string(),
            Some("https://trello.com/c/card123/review-auth".to_string()),
        )
        .expect("task");
        link_task_resource_in_db(
            &db,
            task.id.clone(),
            "trello".to_string(),
            "trello_card".to_string(),
            "card123".to_string(),
            "https://trello.com/c/card123/review-auth".to_string(),
            &ProviderMetadata::empty(),
        )
        .expect("link trello card");
        let link = list_task_links_in_db(&db, &task.id)
            .expect("load links")
            .remove(0);
        let metadata = ProviderMetadata {
            connection_id: Some(connection.id),
            title: Some("Fetched Trello title".to_string()),
            body: Some("Fetched Trello description".to_string()),
            state: Some("Doing".to_string()),
            state_color: Some("#61bd4f".to_string()),
            target_branch: None,
            url: Some("https://trello.com/c/card123/fetched".to_string()),
            fetched_at: Some(123),
            files: vec![TaskFile {
                id: "attachment_1".to_string(),
                name: "Design spec.pdf".to_string(),
                url:
                    "https://trello.com/1/cards/card123/attachments/attachment_1/download/spec.pdf"
                        .to_string(),
                source: "trello".to_string(),
                content_type: Some("application/pdf".to_string()),
                bytes: Some(2048),
                created_at: Some("2026-07-09T10:00:00.000Z".to_string()),
            }],
            comments: Vec::new(),
            labels: vec![ExternalLabel {
                name: "Ready".to_string(),
                color: Some("#61bd4f".to_string()),
            }],
            parent_resource: None,
            notice: None,
        };

        let refreshed =
            apply_provider_metadata_to_task(&db, &task, &link, &metadata).expect("apply metadata");
        let links = list_task_links_in_db(&db, &refreshed.id).expect("load updated links");

        assert_eq!(refreshed.title, "Fetched Trello title");
        assert_eq!(refreshed.body, "Fetched Trello description");
        assert_eq!(refreshed.status, "Doing");
        assert_eq!(refreshed.source_provider.as_deref(), Some("trello"));
        assert_eq!(refreshed.source_kind.as_deref(), Some("trello_card"));
        assert_eq!(refreshed.status_color.as_deref(), Some("#61bd4f"));
        assert_eq!(
            serde_json::to_value(&refreshed).expect("serialize refreshed task")["statusColor"],
            "#61bd4f"
        );
        assert_eq!(
            links[0].external_title.as_deref(),
            Some("Fetched Trello title")
        );
        assert_eq!(
            links[0].external_body.as_deref(),
            Some("Fetched Trello description")
        );
        assert_eq!(links[0].external_state.as_deref(), Some("Doing"));
        assert_eq!(links[0].external_state_color.as_deref(), Some("#61bd4f"));
        assert_eq!(links[0].fetched_at, Some(123));
        assert_eq!(links[0].files.len(), 1);
        assert_eq!(links[0].files[0].name, "Design spec.pdf");
        assert_eq!(links[0].labels[0].name, "Ready");
        assert_eq!(links[0].labels[0].color.as_deref(), Some("#61bd4f"));
    }

    #[test]
    fn provider_metadata_apply_returns_current_task_when_link_disappears() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let task = create_task_in_db(
            &db,
            Some(project.id),
            "Review auth".to_string(),
            "Local notes".to_string(),
            Some("https://trello.com/c/card123/review-auth".to_string()),
        )
        .expect("task");
        link_task_resource_in_db(
            &db,
            task.id.clone(),
            "trello".to_string(),
            "trello_card".to_string(),
            "card123".to_string(),
            "https://trello.com/c/card123/review-auth".to_string(),
            &ProviderMetadata::empty(),
        )
        .expect("link trello card");
        let link = list_task_links_in_db(&db, &task.id)
            .expect("load links")
            .remove(0);
        db.execute(
            "DELETE FROM task_links WHERE task_id = ?1",
            params![&task.id],
        )
        .expect("delete link");

        let result = apply_refreshed_task_external_metadata(
            &db,
            &task,
            &link,
            &ProviderMetadata {
                connection_id: Some("connection_1".to_string()),
                title: Some("Fetched title".to_string()),
                body: Some("Fetched body".to_string()),
                state: Some("Done".to_string()),
                state_color: None,
                target_branch: None,
                url: None,
                fetched_at: Some(123),
                files: Vec::new(),
                comments: Vec::new(),
                labels: Vec::new(),
                parent_resource: None,
                notice: None,
            },
        )
        .expect("apply stale metadata");

        assert_eq!(result.task.body, "Local notes");
        assert!(result.links.is_empty());
        assert_eq!(
            result.notice.as_deref(),
            Some("External link changed before refresh finished.")
        );
    }

    #[test]
    fn refresh_ignores_unsupported_links() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let task = create_task_in_db(
            &db,
            Some(project.id),
            "External doc".to_string(),
            "Local notes".to_string(),
            Some("https://example.com/docs/12".to_string()),
        )
        .expect("task");
        link_task_resource_in_db(
            &db,
            task.id.clone(),
            "external".to_string(),
            "external_url".to_string(),
            "https://example.com/docs/12".to_string(),
            "https://example.com/docs/12".to_string(),
            &ProviderMetadata::empty(),
        )
        .expect("link external doc");

        let result = refresh_task_external_details_in_db(&db, task.id).expect("refresh");

        assert!(!result.connection_required);
        assert_eq!(result.task.body, "Local notes");
        assert_eq!(result.links[0].kind, "external_url");
    }

    #[test]
    fn github_refresh_requires_enabled_project_connection() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let task = create_task_in_db(
            &db,
            Some(project.id),
            "GitHub issue".to_string(),
            "Local notes".to_string(),
            Some("https://github.com/owner/repo/issues/12".to_string()),
        )
        .expect("task");
        link_task_resource_in_db(
            &db,
            task.id.clone(),
            "github".to_string(),
            "github_issue".to_string(),
            "owner/repo#12".to_string(),
            "https://github.com/owner/repo/issues/12".to_string(),
            &ProviderMetadata::empty(),
        )
        .expect("link github issue");

        let result = refresh_task_external_details_in_db(&db, task.id).expect("refresh");

        assert!(result.connection_required);
        assert_eq!(result.task.body, "Local notes");
        assert_eq!(
            result.notice.as_deref(),
            Some("Please add a GitHub connection to this project.")
        );
    }

    #[test]
    fn gitlab_refresh_requires_enabled_project_connection() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let task = create_task_in_db(
            &db,
            Some(project.id),
            "GitLab merge request".to_string(),
            "Local notes".to_string(),
            Some("https://gitlab.com/owner/repo/-/merge_requests/12".to_string()),
        )
        .expect("task");
        link_task_resource_in_db(
            &db,
            task.id.clone(),
            "gitlab".to_string(),
            "merge_request".to_string(),
            "owner/repo!12".to_string(),
            "https://gitlab.com/owner/repo/-/merge_requests/12".to_string(),
            &ProviderMetadata::empty(),
        )
        .expect("link gitlab merge request");

        let result = refresh_task_external_details_in_db(&db, task.id).expect("refresh");

        assert!(result.connection_required);
        assert_eq!(result.task.body, "Local notes");
        assert_eq!(
            result.notice.as_deref(),
            Some("Please add a GitLab connection to this project.")
        );
    }

    #[test]
    fn smart_text_task_requires_project() {
        let db = memory_db();
        let result = create_smart_task_in_db(
            &db,
            "Review onboarding".to_string(),
            parsed_text("Review onboarding"),
            None,
        )
        .expect("smart task result");

        assert!(result.project_required);
        assert!(result.task.is_none());
    }

    #[test]
    fn smart_text_task_creates_inside_project() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let result = create_smart_task_in_db(
            &db,
            "Review onboarding".to_string(),
            parsed_text("Review onboarding"),
            Some(project.id.clone()),
        )
        .expect("smart task result");

        let task = result.task.expect("created task");
        assert!(!result.project_required);
        assert_eq!(task.project_id.as_deref(), Some(project.id.as_str()));
    }

    #[test]
    fn smart_pull_request_creates_task_directly() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let url = "https://github.com/owner/repo/pull/42";
        let result = create_smart_task_in_db(
            &db,
            url.to_string(),
            parsed_github_pull_request(url),
            Some(project.id.clone()),
        )
        .expect("smart task result");

        let task = result.task.expect("created task");
        assert!(result.created);
        assert_eq!(task.project_id.as_deref(), Some(project.id.as_str()));
        assert_eq!(task.source_url.as_deref(), Some(url));
        assert!(result
            .notice
            .unwrap_or_default()
            .contains("No enabled connection"));

        let linked = get_task_by_link(&db, "github", "pull_request", "owner/repo#42")
            .expect("query linked")
            .expect("linked task");
        assert_eq!(linked.id, task.id);
    }

    #[test]
    fn task_relations_prevent_duplicates_and_self_relations() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let parent = create_task_in_db(
            &db,
            Some(project.id.clone()),
            "Parent".to_string(),
            "".to_string(),
            None,
        )
        .expect("parent task");
        let child = create_task_in_db(
            &db,
            Some(project.id),
            "Child".to_string(),
            "".to_string(),
            None,
        )
        .expect("child task");

        let first = save_task_relation_in_db(
            &db,
            TaskRelationInput {
                id: None,
                source_task_id: parent.id.clone(),
                target_task_id: child.id.clone(),
                relation_type: "sub_task".to_string(),
            },
        )
        .expect("save relation");
        let duplicate = save_task_relation_in_db(
            &db,
            TaskRelationInput {
                id: None,
                source_task_id: parent.id.clone(),
                target_task_id: child.id.clone(),
                relation_type: "sub_task".to_string(),
            },
        )
        .expect("save duplicate relation");

        assert_eq!(first.id, duplicate.id);
        assert_eq!(first.related_task.id, child.id);

        let child_view = get_task_relation_view(&db, &first.id, &child.id)
            .expect("load child relation")
            .expect("child relation");
        assert_eq!(child_view.related_task.id, parent.id);

        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM task_relations", [], |row| row.get(0))
            .expect("count task relations");
        assert_eq!(count, 1);

        let updated = save_task_relation_in_db(
            &db,
            TaskRelationInput {
                id: Some(first.id.clone()),
                source_task_id: parent.id.clone(),
                target_task_id: child.id,
                relation_type: "related".to_string(),
            },
        )
        .expect("update relation");
        assert_eq!(updated.id, first.id);
        assert_eq!(updated.relation_type, "related");

        let self_relation = save_task_relation_in_db(
            &db,
            TaskRelationInput {
                id: None,
                source_task_id: parent.id.clone(),
                target_task_id: parent.id,
                relation_type: "related".to_string(),
            },
        );
        assert_eq!(
            self_relation.unwrap_err(),
            "A task cannot be related to itself"
        );
    }

    #[test]
    fn migrates_pull_requests_into_tasks_and_relations() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let existing_task = create_task_in_db(
            &db,
            Some(project.id.clone()),
            "Original task".to_string(),
            "".to_string(),
            None,
        )
        .expect("existing task");
        let pr_url = "https://github.com/owner/repo/pull/42";
        db.execute(
            "INSERT INTO task_links
                (task_id, provider, kind, external_id, url, connection_id, external_title, external_body, external_state, target_branch, fetched_at)
             VALUES
                (?1, 'github', 'pull_request', 'owner/repo#42', ?2, NULL, NULL, NULL, NULL, 'main', NULL)",
            params![existing_task.id, pr_url],
        )
        .expect("insert old task link");

        db.execute(
            "INSERT INTO pull_requests
                (id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, connection_id, external_title, external_body, external_state, target_branch, fetched_at, created_at, updated_at)
             VALUES
                ('pr_1', ?1, 'github', 'https://github.com/owner/repo', ?2, 'Fallback title', 'reviewing', 'Review note', '{}', NULL, 'Fetched title', 'Fetched body', 'open', 'main', 10, 1, 2)",
            params![project.id, pr_url],
        )
        .expect("insert pull request");

        migrate_pull_requests_into_tasks(&db).expect("migrate pull requests");

        let pr_task = get_task_by_source_url(&db, pr_url)
            .expect("query PR task")
            .expect("PR task");
        assert_ne!(pr_task.id, existing_task.id);
        assert_eq!(pr_task.title, "Fetched title");

        let relation_count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM task_relations
                 WHERE source_task_id = ?1 AND target_task_id = ?2 AND relation_type = 'related'",
                params![existing_task.id, pr_task.id],
                |row| row.get(0),
            )
            .expect("count migrated relations");
        assert_eq!(relation_count, 1);
    }

    #[test]
    fn stores_connection_settings() {
        let db = memory_db();
        let connection = save_connection_in_db(
            &db,
            ConnectionInput {
                id: None,
                provider: "gitlab".to_string(),
                name: "Work GitLab".to_string(),
                base_url: "https://gitlab.example.com".to_string(),
                api_key: None,
                token: "secret".to_string(),
            },
        )
        .expect("save connection");

        assert_eq!(connection.provider, "gitlab");
        assert_eq!(connection.token, "secret");
    }

    #[test]
    fn stores_updates_lists_and_deletes_ai_prompts() {
        let db = memory_db();
        let codex = save_ai_prompt_in_db(
            &db,
            AiPromptInput {
                id: None,
                agent_type: "codex".to_string(),
                name: " Implement ticket ".to_string(),
                icon: "hammer".to_string(),
                prompt_text: " Fix it carefully. ".to_string(),
            },
        )
        .expect("save Codex prompt");
        let claude = save_ai_prompt_in_db(
            &db,
            AiPromptInput {
                id: None,
                agent_type: "claude".to_string(),
                name: "Review ticket".to_string(),
                icon: "review".to_string(),
                prompt_text: String::new(),
            },
        )
        .expect("save Claude prompt");

        assert_eq!(codex.name, "Implement ticket");
        assert_eq!(codex.icon, "hammer");
        assert_eq!(codex.prompt_text, "Fix it carefully.");
        let listed = list_ai_prompts_in_db(&db).expect("list prompts");
        assert_eq!(
            listed
                .iter()
                .map(|prompt| prompt.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Implement ticket", "Review ticket"]
        );

        let updated = save_ai_prompt_in_db(
            &db,
            AiPromptInput {
                id: Some(codex.id.clone()),
                agent_type: "claude".to_string(),
                name: "Ship ticket".to_string(),
                icon: "target".to_string(),
                prompt_text: String::new(),
            },
        )
        .expect("update prompt");
        assert_eq!(updated.id, codex.id);
        assert_eq!(updated.agent_type, "claude");
        assert_eq!(updated.icon, "target");
        assert_eq!(updated.prompt_text, "");
        assert_eq!(updated.created_at, codex.created_at);

        delete_ai_prompt_in_db(&db, &claude.id).expect("delete prompt");
        assert_eq!(
            list_ai_prompts_in_db(&db).expect("list remaining"),
            vec![updated]
        );
    }

    #[test]
    fn validates_ai_prompt_agent_name_and_case_insensitive_uniqueness() {
        let db = memory_db();
        let existing = save_ai_prompt_in_db(
            &db,
            AiPromptInput {
                id: None,
                agent_type: "codex".to_string(),
                name: "Implement ticket".to_string(),
                icon: "hammer".to_string(),
                prompt_text: String::new(),
            },
        )
        .expect("save prompt");

        let invalid_type = save_ai_prompt_in_db(
            &db,
            AiPromptInput {
                id: None,
                agent_type: "other".to_string(),
                name: "Other".to_string(),
                icon: "hammer".to_string(),
                prompt_text: String::new(),
            },
        )
        .unwrap_err();
        assert_eq!(invalid_type, "AI Prompt agent must be Codex or Claude.");

        let invalid_icon = save_ai_prompt_in_db(
            &db,
            AiPromptInput {
                id: None,
                agent_type: "codex".to_string(),
                name: "Other".to_string(),
                icon: "other".to_string(),
                prompt_text: String::new(),
            },
        )
        .unwrap_err();
        assert_eq!(invalid_icon, "AI Prompt icon is not supported.");

        let blank_name = save_ai_prompt_in_db(
            &db,
            AiPromptInput {
                id: None,
                agent_type: "codex".to_string(),
                name: "  ".to_string(),
                icon: "hammer".to_string(),
                prompt_text: String::new(),
            },
        )
        .unwrap_err();
        assert_eq!(blank_name, "AI Prompt name is required.");

        let duplicate = save_ai_prompt_in_db(
            &db,
            AiPromptInput {
                id: None,
                agent_type: "claude".to_string(),
                name: "implement ticket".to_string(),
                icon: "review".to_string(),
                prompt_text: String::new(),
            },
        )
        .unwrap_err();
        assert_eq!(duplicate, "An AI Prompt with this name already exists.");

        assert!(save_ai_prompt_in_db(
            &db,
            AiPromptInput {
                id: Some(existing.id),
                agent_type: "claude".to_string(),
                name: "IMPLEMENT TICKET".to_string(),
                icon: "review".to_string(),
                prompt_text: String::new(),
            },
        )
        .is_ok());
    }

    #[test]
    fn migrates_legacy_ai_agents_into_ai_prompts() {
        let db = SqliteConnection::open_in_memory().expect("open database");
        db.execute_batch(
            "
            CREATE TABLE ai_agents (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            INSERT INTO ai_agents (id, type, name, created_at, updated_at)
            VALUES ('agent_1', 'codex', 'Legacy Codex', 1, 2);
            ",
        )
        .expect("create legacy AI Agent schema");

        init_database(&db).expect("migrate database");

        assert_eq!(
            list_ai_prompts_in_db(&db).expect("list migrated prompts"),
            vec![AiPromptRecord {
                id: "agent_1".to_string(),
                name: "Legacy Codex".to_string(),
                agent_type: "codex".to_string(),
                icon: "sparkles".to_string(),
                prompt_text: String::new(),
                created_at: 1,
                updated_at: 2,
            }]
        );
        let legacy_table_exists: bool = db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_agents')",
                [],
                |row| row.get(0),
            )
            .expect("check legacy table");
        assert!(!legacy_table_exists);
    }

    #[test]
    fn builds_provider_specific_ai_prompt_deep_links_with_task_content() {
        let task = Task {
            id: "task_1".to_string(),
            project_id: None,
            title: "Fix login redirect".to_string(),
            body: "Preserve the requested destination.".to_string(),
            status: "open".to_string(),
            source_url: Some("https://trello.com/c/card123/fix-login".to_string()),
            source_provider: Some("trello".to_string()),
            source_kind: Some("trello_card".to_string()),
            status_color: Some("#61bd4f".to_string()),
            created_at: 1,
            updated_at: 1,
        };
        let prompt = ai_prompt_with_task_context("Implement this ticket.", &task);
        assert_eq!(
            prompt,
            "Implement this ticket.\n\nhttps://trello.com/c/card123/fix-login\n\nFix login redirect\n\nPreserve the requested destination."
        );

        let codex = reqwest::Url::parse(
            &ai_prompt_deep_link("codex", &prompt, "/work/app").expect("Codex deep link"),
        )
        .expect("parse Codex deep link");
        let codex_query = codex.query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(codex.scheme(), "codex");
        assert_eq!(codex.host_str(), Some("threads"));
        assert_eq!(codex.path(), "/new");
        assert_eq!(
            codex_query.get("prompt").map(|value| value.as_ref()),
            Some(prompt.as_str())
        );
        assert_eq!(
            codex_query.get("path").map(|value| value.as_ref()),
            Some("/work/app")
        );

        let claude = reqwest::Url::parse(
            &ai_prompt_deep_link("claude", &prompt, "/work/app").expect("Claude deep link"),
        )
        .expect("parse Claude deep link");
        let claude_query = claude.query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(claude.scheme(), "claude");
        assert_eq!(claude.host_str(), Some("code"));
        assert_eq!(claude.path(), "/new");
        assert_eq!(
            claude_query.get("q").map(|value| value.as_ref()),
            Some(prompt.as_str())
        );
        assert_eq!(
            claude_query.get("folder").map(|value| value.as_ref()),
            Some("/work/app")
        );
    }

    #[test]
    fn omits_empty_values_when_composing_ai_prompt_task_context() {
        let task = Task {
            id: "task_1".to_string(),
            project_id: None,
            title: "Task title".to_string(),
            body: String::new(),
            status: "open".to_string(),
            source_url: None,
            source_provider: None,
            source_kind: None,
            status_color: None,
            created_at: 1,
            updated_at: 1,
        };
        assert_eq!(ai_prompt_with_task_context("  ", &task), "Task title");
    }

    #[test]
    fn avoids_repeating_a_todo_title_in_ai_prompt_task_context() {
        let task = Task {
            id: "task_1".to_string(),
            project_id: Some("project_1".to_string()),
            title: "Review onboarding".to_string(),
            body: "  Review   onboarding  ".to_string(),
            status: "open".to_string(),
            source_url: None,
            source_provider: None,
            source_kind: None,
            status_color: None,
            created_at: 1,
            updated_at: 1,
        };

        assert_eq!(
            ai_prompt_with_task_context("Implement this task.", &task),
            "Implement this task.\n\nReview onboarding"
        );
    }

    #[test]
    fn prepares_ai_prompt_thread_for_a_configured_directory() {
        let db = memory_db();
        let directory_path = temp_test_path("ai-prompt-workspace");
        fs::create_dir_all(&directory_path).expect("create workspace");
        let directory = save_directory_in_db(
            &db,
            DirectoryInput {
                path: directory_path.to_string_lossy().to_string(),
            },
        )
        .expect("save directory");
        let prompt = save_ai_prompt_in_db(
            &db,
            AiPromptInput {
                id: None,
                agent_type: "codex".to_string(),
                name: "Implement ticket".to_string(),
                icon: "hammer".to_string(),
                prompt_text: "Use the project conventions.".to_string(),
            },
        )
        .expect("save prompt");
        let task = create_task_in_db(
            &db,
            None,
            "Task title".to_string(),
            "Task content".to_string(),
            Some("https://github.com/acme/app/issues/7".to_string()),
        )
        .expect("create task");

        let deep_link = prepare_ai_prompt_thread_in_db(
            &db,
            &OpenAiPromptThreadInput {
                ai_prompt_id: prompt.id,
                task_id: task.id.clone(),
                path: directory.path,
            },
        )
        .expect("prepare thread");
        assert!(deep_link.starts_with("codex://threads/new?"));
        let deep_link = reqwest::Url::parse(&deep_link).expect("parse deep link");
        let query = deep_link.query_pairs().collect::<HashMap<_, _>>();
        assert_eq!(
            query.get("prompt").map(|value| value.as_ref()),
            Some("Use the project conventions.\n\nhttps://github.com/acme/app/issues/7\n\nTask title\n\nTask content")
        );
        assert!(
            get_task(&db, &task.id)
                .expect("load original task")
                .is_some(),
            "preparing an AI thread must keep the original task"
        );

        fs::remove_dir_all(directory_path).expect("remove workspace");
    }

    #[test]
    fn normalizes_connection_base_url_on_save() {
        let db = memory_db();
        let connection = save_connection_in_db(
            &db,
            ConnectionInput {
                id: None,
                provider: "gitlab".to_string(),
                name: "Work GitLab".to_string(),
                base_url: "gitlab.example.org/".to_string(),
                api_key: None,
                token: "secret".to_string(),
            },
        )
        .expect("save connection");

        assert_eq!(connection.base_url, "https://gitlab.example.org");
    }

    #[test]
    fn normalizes_base_url_without_scheme() {
        assert_eq!(
            normalize_base_url("gitlab.example.org"),
            "https://gitlab.example.org"
        );
        assert_eq!(
            normalize_base_url("https://gitlab.example.org/"),
            "https://gitlab.example.org"
        );
        assert_eq!(
            normalize_base_url("http://gitlab.example.org"),
            "http://gitlab.example.org"
        );
    }

    #[test]
    fn stores_trello_key_and_token_with_fixed_cloud_endpoint() {
        let db = memory_db();
        let connection = save_connection_in_db(
            &db,
            ConnectionInput {
                id: None,
                provider: "trello".to_string(),
                name: " Trello ".to_string(),
                base_url: "https://trello.com".to_string(),
                api_key: Some(" key ".to_string()),
                token: " token ".to_string(),
            },
        )
        .expect("save connection");

        assert_eq!(connection.name, "Trello");
        assert_eq!(connection.base_url, "https://api.trello.com");
        assert_eq!(connection.api_key.as_deref(), Some("key"));
        assert_eq!(connection.token, "token");
    }

    #[test]
    fn validates_connection_credentials_by_provider() {
        let github = connection_record("github", None, "");
        assert_eq!(
            validate_connection_credentials(&github).unwrap_err(),
            "Token is required."
        );

        let gitlab = connection_record("gitlab", None, "");
        assert_eq!(
            validate_connection_credentials(&gitlab).unwrap_err(),
            "Token is required."
        );

        let trello = connection_record("trello", None, "token");
        assert_eq!(
            validate_connection_credentials(&trello).unwrap_err(),
            "Trello API key is required."
        );

        let trello = connection_record("trello", Some("key"), "token");
        assert!(validate_connection_credentials(&trello).is_ok());
    }

    #[test]
    fn normalizes_connection_test_account_names() {
        let github = serde_json::json!({ "login": "octocat", "name": "Mona" });
        assert_eq!(
            account_name_from_json(&github, &["login", "name"]).as_deref(),
            Some("octocat")
        );

        let gitlab = serde_json::json!({ "username": "alex", "name": "Alex" });
        assert_eq!(
            account_name_from_json(&gitlab, &["username", "name"]).as_deref(),
            Some("alex")
        );

        let trello = serde_json::json!({ "username": "trello_user", "fullName": "Trello User" });
        assert_eq!(
            account_name_from_json(&trello, &["username", "fullName", "name"]).as_deref(),
            Some("trello_user")
        );
    }

    #[test]
    fn normalizes_provider_comments_and_filters_automation() {
        let github = github_comments_from_json(
            &[
                serde_json::json!({
                    "id": 2, "body": "Second", "created_at": "2026-07-15T11:00:00Z",
                    "html_url": "https://github.com/acme/app/pull/1#issuecomment-2",
                    "user": { "login": "bob", "type": "User" }
                }),
                serde_json::json!({
                    "id": 1, "body": "Bot", "created_at": "2026-07-15T09:00:00Z",
                    "user": { "login": "ci[bot]", "type": "Bot" }
                }),
                serde_json::json!({
                    "id": 3, "body": "", "created_at": "2026-07-15T12:00:00Z",
                    "user": { "login": "alice", "type": "User" }
                }),
            ],
            "comment",
        );
        assert_eq!(github.len(), 1);
        assert_eq!(github[0].author, "bob");
        assert_eq!(github[0].kind, "comment");

        let trello = trello_comments_from_json(
            &[
                serde_json::json!({
                    "id": "action-1", "date": "2026-07-15T10:00:00Z",
                    "data": { "text": "Human comment" },
                    "memberCreator": { "fullName": "Alice" }
                }),
                serde_json::json!({
                    "id": "action-2", "date": "2026-07-15T11:00:00Z",
                    "data": { "text": "Automation" },
                    "memberCreator": { "fullName": "Butler" },
                    "appCreator": { "id": "butler" }
                }),
            ],
            Some("https://trello.com/c/card"),
        );
        assert_eq!(trello.len(), 1);
        assert_eq!(trello[0].author, "Alice");
        assert_eq!(
            trello[0].url.as_deref(),
            Some("https://trello.com/c/card#comment-action-1")
        );

        let gitlab = gitlab_comments_from_json(
            &[serde_json::json!({
              "id": "discussion-1",
              "notes": [
                {
                    "id": 8, "body": "Inline note", "type": "DiffNote", "system": false,
                    "created_at": "2026-07-15T08:00:00Z", "updated_at": "2026-07-15T08:30:00Z",
                    "author": { "name": "Alex", "bot": false }
                },
                {
                    "id": 9, "body": "changed title", "system": true,
                    "author": { "name": "Alex", "bot": false }
                },
                {
                    "id": 10, "body": "Bot note", "system": false,
                    "author": { "name": "Bot", "bot": true }
                }
              ]
            })],
            &[],
            Some("https://gitlab.example/acme/app/-/merge_requests/1"),
        );
        assert_eq!(gitlab.len(), 1);
        assert_eq!(gitlab[0].kind, "inline");
        assert_eq!(gitlab[0].author, "Alex");
    }

    #[test]
    fn groups_github_inline_replies_and_extracts_compact_diff_context() {
        let comments = github_inline_comments_from_json(&[
            serde_json::json!({
                "id": 11, "body": "Root", "path": "src/app.js", "line": 3, "side": "RIGHT",
                "diff_hunk": "@@ -1,3 +1,4 @@\n one\n two\n+three\n four",
                "created_at": "2026-07-15T09:00:00Z", "user": { "login": "alice", "type": "User" }
            }),
            serde_json::json!({
                "id": 12, "in_reply_to_id": 11, "body": "Reply", "path": "src/app.js", "line": 3, "side": "RIGHT",
                "diff_hunk": "@@ -1,3 +1,4 @@\n one\n two\n+three\n four",
                "created_at": "2026-07-15T10:00:00Z", "user": { "login": "bob", "type": "User" }
            }),
        ]);
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].discussion_id, comments[1].discussion_id);
        let context = comments[0].code_context.as_ref().expect("code context");
        assert_eq!(context.path, "src/app.js");
        assert!(context.lines.len() <= 7);
        assert!(context
            .lines
            .iter()
            .any(|line| line.highlighted && line.content == "three"));
    }

    #[test]
    fn comment_cache_is_sorted_deduplicated_replaceable_and_malformed_safe() {
        assert!(task_comments_from_json(Some("not json")).is_empty());

        let comments = normalize_task_comments(vec![
            TaskComment {
                id: "comment-2".to_string(),
                kind: "comment".to_string(),
                author: "Bob".to_string(),
                body: "Old body".to_string(),
                created_at: Some("2026-07-15T11:00:00Z".to_string()),
                updated_at: None,
                url: None,
                discussion_id: None,
                reply_to_id: None,
                code_context: None,
            },
            TaskComment {
                id: "comment-1".to_string(),
                kind: "review".to_string(),
                author: "Alice".to_string(),
                body: "First".to_string(),
                created_at: Some("2026-07-15T09:00:00Z".to_string()),
                updated_at: None,
                url: None,
                discussion_id: None,
                reply_to_id: None,
                code_context: None,
            },
            TaskComment {
                id: "comment-2".to_string(),
                kind: "comment".to_string(),
                author: "Bob".to_string(),
                body: "Edited body".to_string(),
                created_at: Some("2026-07-15T11:00:00Z".to_string()),
                updated_at: Some("2026-07-15T12:00:00Z".to_string()),
                url: None,
                discussion_id: None,
                reply_to_id: None,
                code_context: None,
            },
        ]);
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0].id, "comment-1");
        assert_eq!(comments[1].body, "Edited body");
        assert_eq!(
            task_comments_from_json(Some(&task_comments_to_json(&comments))),
            comments
        );

        let db = memory_db();
        let project =
            create_project_in_db(&db, "Comments".to_string(), None, None).expect("project");
        let task = create_task_in_db(
            &db,
            Some(project.id),
            "Review".to_string(),
            "Description".to_string(),
            Some("https://github.com/acme/app/pull/1".to_string()),
        )
        .expect("task");
        let with_comments = ProviderMetadata {
            comments,
            ..ProviderMetadata::empty()
        };
        link_task_resource_in_db(
            &db,
            task.id.clone(),
            "github".to_string(),
            "pull_request".to_string(),
            "acme/app#1".to_string(),
            "https://github.com/acme/app/pull/1".to_string(),
            &with_comments,
        )
        .expect("cache comments");
        assert_eq!(
            list_task_links_in_db(&db, &task.id).expect("links")[0]
                .comments
                .len(),
            2
        );

        link_task_resource_in_db(
            &db,
            task.id.clone(),
            "github".to_string(),
            "pull_request".to_string(),
            "acme/app#1".to_string(),
            "https://github.com/acme/app/pull/1".to_string(),
            &ProviderMetadata::empty(),
        )
        .expect("replace comments");
        assert!(list_task_links_in_db(&db, &task.id).expect("links")[0]
            .comments
            .is_empty());
    }

    #[test]
    fn maps_provider_metadata_status_values() {
        let trello_list = serde_json::json!({ "name": "In Progress", "color": "green_dark" });
        assert_eq!(
            trello_list_state(&trello_list).as_deref(),
            Some("In Progress")
        );
        assert_eq!(
            trello_color(json_string(&trello_list, "color")).as_deref(),
            Some("#61bd4f")
        );
        assert_eq!(
            trello_color(Some("light-red".to_string())).as_deref(),
            Some("#eb5a46")
        );
        assert_eq!(trello_color(None), None);
        assert_eq!(trello_color(Some("unknown".to_string())), None);

        let github_issue = serde_json::json!({ "state": "closed" });
        assert_eq!(github_issue_state(&github_issue).as_deref(), Some("closed"));

        let open_pr = serde_json::json!({ "state": "open", "merged": false });
        assert_eq!(github_pull_request_state(&open_pr).as_deref(), Some("open"));

        let merged_pr = serde_json::json!({ "state": "closed", "merged": true });
        assert_eq!(
            github_pull_request_state(&merged_pr).as_deref(),
            Some("merged")
        );
        assert!(review_request_is_closed(Some("merged")));
        assert!(review_request_is_closed(Some(" CLOSED ")));
        assert!(!review_request_is_closed(Some("open")));
        assert!(!review_request_is_closed(Some("opened")));
        assert!(!review_request_is_closed(None));

        let github_pr = serde_json::json!({ "base": { "ref": "2.x" } });
        assert_eq!(
            github_pull_request_target_branch(&github_pr).as_deref(),
            Some("2.x")
        );

        let gitlab_mr = serde_json::json!({ "target_branch": "2.6" });
        assert_eq!(
            json_string(&gitlab_mr, "target_branch").as_deref(),
            Some("2.6")
        );
    }

    #[test]
    fn connection_test_auth_errors_include_permission_hints() {
        let message = connection_test_error_message("gitlab", "provider returned 403 Forbidden");
        assert!(message.contains("read_api or api"));
        assert!(message.contains("read_repository alone is not enough"));

        let github = connection_test_error_message("github", "provider returned 401 Unauthorized");
        assert!(github.contains("Pull requests read"));

        let unchanged = connection_test_error_message("gitlab", "dns error");
        assert_eq!(unchanged, "dns error");
    }

    #[test]
    fn connection_test_preserves_provider_error_details() {
        let message = connection_test_error_message(
            "trello",
            "provider returned 401 Unauthorized: invalid token",
        );

        assert!(message.contains("invalid token"));
        assert!(message.contains("Trello tokens must be authorized with read access."));
    }

    #[test]
    fn enables_project_connections_and_selects_best_host() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let gitlab_com = save_connection_in_db(
            &db,
            ConnectionInput {
                id: None,
                provider: "gitlab".to_string(),
                name: "GitLab.com".to_string(),
                base_url: "https://gitlab.com".to_string(),
                api_key: None,
                token: "secret".to_string(),
            },
        )
        .expect("save gitlab.com");
        let self_hosted = save_connection_in_db(
            &db,
            ConnectionInput {
                id: None,
                provider: "gitlab".to_string(),
                name: "Self-hosted".to_string(),
                base_url: "https://gitlab.example.org".to_string(),
                api_key: None,
                token: "secret".to_string(),
            },
        )
        .expect("save self-hosted gitlab");

        db.execute(
            "INSERT INTO project_connections (project_id, connection_id, enabled_at) VALUES (?1, ?2, ?3)",
            params![project.id, gitlab_com.id, 1],
        )
        .expect("enable gitlab.com");
        db.execute(
            "INSERT INTO project_connections (project_id, connection_id, enabled_at) VALUES (?1, ?2, ?3)",
            params![project.id, self_hosted.id, 2],
        )
        .expect("enable self-hosted");

        let selected = select_best_connection(
            &db,
            &project.id,
            &parsed_gitlab(
                "https://gitlab.example.org/group/app/-/merge_requests/17",
                "gitlab.example.org",
            ),
        )
        .expect("select connection")
        .expect("connection selected");

        assert_eq!(selected.name, "Self-hosted");
    }

    #[test]
    fn provider_metadata_normalizes_json() {
        let json = serde_json::json!({
            "title": "Fix auth",
            "description": "Updates login flow",
            "state": "opened",
            "web_url": "https://gitlab.example.org/group/app/-/merge_requests/17"
        });

        assert_eq!(json_string(&json, "title").as_deref(), Some("Fix auth"));
        assert_eq!(json_string(&json, "state").as_deref(), Some("opened"));
        assert_eq!(
            json_string(&json, "web_url").as_deref(),
            Some("https://gitlab.example.org/group/app/-/merge_requests/17")
        );
    }

    #[test]
    fn trello_board_template_payload_filters_templates_and_closed_lists() {
        let cards = serde_json::json!([
            {"id": "template-1", "name": "Bug", "desc": "Bug body", "idList": "list-1", "isTemplate": true},
            {"id": "template-2", "name": "Feature", "desc": "", "idList": "list-2", "cover": {"isTemplate": true}},
            {"id": "regular", "name": "Ordinary card", "idList": "list-1", "isTemplate": false}
        ]);
        let lists = serde_json::json!([
            {"id": "list-1", "name": "Todo", "color": "blue_light", "closed": false},
            {"id": "list-2", "name": "Archived", "closed": true}
        ]);

        let result = trello_board_templates_from_json(&cards, &lists);

        assert_eq!(result.templates.len(), 2);
        assert_eq!(result.templates[0].name, "Bug");
        assert_eq!(result.templates[1].list_id, "list-2");
        assert_eq!(
            result.lists,
            vec![TrelloBoardList {
                id: "list-1".to_string(),
                name: "Todo".to_string(),
                color: Some("#0079bf".to_string()),
            }]
        );
    }

    #[test]
    fn task_trello_boards_are_project_scoped_and_conversion_rejects_linked_tasks() {
        let mut db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None, None).expect("project");
        let other_project =
            create_project_in_db(&db, "Other".to_string(), None, None).expect("other project");
        let connection = save_connection_in_db(
            &db,
            ConnectionInput {
                id: None,
                provider: "trello".to_string(),
                name: "Trello".to_string(),
                base_url: "https://api.trello.com".to_string(),
                api_key: Some("key".to_string()),
                token: "token".to_string(),
            },
        )
        .expect("connection");
        let board = connect_resource_in_db(
            &db,
            ResourceInput {
                project_id: project.id.clone(),
                provider: "trello".to_string(),
                kind: "trello_board".to_string(),
                external_id: "board-1".to_string(),
                url: "https://trello.com/b/board-1".to_string(),
                name: "Delivery".to_string(),
                icon_url: None,
                connection_id: Some(connection.id.clone()),
            },
        )
        .expect("board");
        connect_resource_in_db(
            &db,
            ResourceInput {
                project_id: other_project.id,
                provider: "trello".to_string(),
                kind: "trello_board".to_string(),
                external_id: "board-2".to_string(),
                url: "https://trello.com/b/board-2".to_string(),
                name: "Other board".to_string(),
                icon_url: None,
                connection_id: Some(connection.id.clone()),
            },
        )
        .expect("other board");
        let task = create_task_in_db(
            &db,
            Some(project.id),
            "Local task".to_string(),
            "Description".to_string(),
            None,
        )
        .expect("task");

        let boards = task_trello_boards_in_db(&db, &task.id).expect("boards");
        assert_eq!(boards.len(), 1);
        assert_eq!(boards[0].id, board.id);
        assert!(prepare_trello_board_for_task(&db, &task.id, &board.id, true).is_ok());

        let related = create_task_in_db(
            &db,
            task.project_id.clone(),
            "Related task".to_string(),
            "".to_string(),
            None,
        )
        .expect("related task");
        let relation = save_task_relation_in_db(
            &db,
            TaskRelationInput {
                id: None,
                source_task_id: task.id.clone(),
                target_task_id: related.id.clone(),
                relation_type: "related".to_string(),
            },
        )
        .expect("relation");
        let metadata = ProviderMetadata {
            connection_id: Some(connection.id),
            title: Some("Converted title".to_string()),
            body: Some("Converted body".to_string()),
            state: Some("Doing".to_string()),
            state_color: Some("#0079bf".to_string()),
            url: Some("https://trello.com/c/card-1".to_string()),
            fetched_at: Some(now_millis()),
            ..ProviderMetadata::empty()
        };
        let converted = persist_trello_ticket_conversion(
            &mut db,
            &task.id,
            &board.id,
            "card-1",
            "https://trello.com/c/card-1",
            "Converted title",
            "Converted body",
            "Doing",
            &metadata,
        )
        .expect("convert");
        assert_eq!(converted.task.id, task.id);
        assert_eq!(converted.task.created_at, task.created_at);
        assert_eq!(converted.task.title, "Converted title");
        assert_eq!(converted.task.body, "Converted body");
        assert_eq!(converted.task.status, "Doing");
        assert_eq!(converted.task.status_color.as_deref(), Some("#0079bf"));
        assert_eq!(converted.task.source_kind.as_deref(), Some("trello_card"));
        let related_view = get_task_relation_view(&db, &relation.id, &related.id)
            .expect("load relation")
            .expect("related view");
        assert_eq!(
            related_view.related_task.status_color.as_deref(),
            Some("#0079bf")
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM task_relations WHERE source_task_id = ?1 OR target_task_id = ?1",
                params![task.id],
                |row| row.get::<_, i64>(0),
            )
            .expect("relation count"),
            1
        );
        assert_eq!(
            prepare_trello_board_for_task(&db, &task.id, &board.id, true).unwrap_err(),
            "This task already has an external resource."
        );
    }
}
