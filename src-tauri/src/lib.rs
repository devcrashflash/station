use rusqlite::{params, Connection as SqliteConnection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;
#[cfg(not(target_os = "macos"))]
use tauri_plugin_opener::OpenerExt;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
const DEFAULT_PROJECT_COLOR: &str = "#2563eb";
const BROWSER_BUNDLE_ID_SETTING_KEY: &str = "browser_bundle_id";
#[cfg(not(target_os = "macos"))]
const BLANK_BROWSER_TAB_URL: &str = "about:blank";
const OCR_DETECTION_MODEL_URL: &str =
    "https://ocrs-models.s3-accelerate.amazonaws.com/text-detection.rten";
const OCR_RECOGNITION_MODEL_URL: &str =
    "https://ocrs-models.s3-accelerate.amazonaws.com/text-recognition.rten";

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
    ocr_engine: Mutex<Option<ocrs::OcrEngine>>,
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
    target_branch: Option<String>,
    fetched_at: Option<i64>,
    files: Vec<TaskFile>,
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
    diff: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReviewDiffResult {
    path: String,
    branch: String,
    base_ref: String,
    files: Vec<String>,
    current_file: Option<ReviewDiffFile>,
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

#[derive(Debug, Clone)]
struct ProviderMetadata {
    connection_id: Option<String>,
    title: Option<String>,
    body: Option<String>,
    state: Option<String>,
    target_branch: Option<String>,
    url: Option<String>,
    fetched_at: Option<i64>,
    files: Vec<TaskFile>,
    notice: Option<String>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_dir)?;
            let db = SqliteConnection::open(app_dir.join("studio.sqlite"))?;
            init_database(&db)?;
            app.manage(AppState {
                db: Mutex::new(db),
                ocr_engine: Mutex::new(None),
            });
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
            create_task_from_input,
            list_smart_inbox_todos,
            create_smart_inbox_todo,
            delete_smart_inbox_todo,
            ocr_image_file,
            ocr_image_bytes,
            read_email_file,
            read_email_bytes,
            read_apple_mail_message,
            list_tasks,
            update_task,
            delete_task,
            link_task_resource,
            list_task_links,
            refresh_task_external_details,
            list_task_relations,
            save_task_relation,
            delete_task_relation,
            list_connections,
            save_connection,
            delete_connection,
            list_browser_settings,
            save_browser_settings,
            test_connection,
            list_directories,
            save_directory,
            delete_directory,
            list_recent_directory_files,
            list_project_connections,
            set_project_connections,
            list_activities,
            sync_activities,
            list_pull_requests,
            save_pull_request,
            update_pull_request_review_state
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
            raw_json TEXT NOT NULL
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
            UNIQUE(provider, kind, external_id)
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
            target_branch TEXT,
            fetched_at INTEGER,
            files_json TEXT NOT NULL DEFAULT '[]',
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
    add_column_if_missing(db, "projects", "color", "TEXT NOT NULL DEFAULT '#2563eb'")?;
    add_column_if_missing(db, "connections", "api_key", "TEXT")?;
    db.execute(
        "CREATE INDEX IF NOT EXISTS idx_activities_occurred_at ON activities(occurred_at DESC)",
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
    add_column_if_missing(db, "task_links", "target_branch", "TEXT")?;
    add_column_if_missing(db, "task_links", "fetched_at", "INTEGER")?;
    add_column_if_missing(db, "task_links", "files_json", "TEXT NOT NULL DEFAULT '[]'")?;
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
    migrate_pull_requests_into_tasks(db)?;
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
    let files_json = row.get::<_, Option<String>>(11)?;
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
        target_branch: row.get(9)?,
        fetched_at: row.get(10)?,
        files: task_files_from_json(files_json.as_deref()),
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
    provider: &str,
    kind: &str,
    external_id: &str,
) -> rusqlite::Result<Option<Resource>> {
    db.query_row(
        "SELECT id, project_id, provider, kind, external_id, url, name, icon_url, connection_id
         FROM resources WHERE provider = ?1 AND kind = ?2 AND external_id = ?3",
        params![provider, kind, external_id],
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

    if let Some(resource) =
        get_resource_by_identity(db, &input.provider, &input.kind, &external_id)?
    {
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
    let fetch_refspec = format!("{remote_head}:{remote_ref}");
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
            .map_err(|error| format!("Existing review branch cannot be fast-forwarded: {error}"))?;
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
    let output = run_git(path, &["diff", "--name-only", base_ref, branch])?;
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
    let diff = run_git(path, &["diff", base_ref, branch, "--", file_path])?;
    Ok(ReviewDiffFile {
        path: file_path.to_string(),
        diff,
    })
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
    let files = review_diff_files(&path, &base_ref, &branch)?;
    let current_file = files
        .first()
        .map(|file_path| review_diff_file(&path, &base_ref, &branch, file_path))
        .transpose()?;

    Ok(ReviewDiffResult {
        path: resource.path,
        branch,
        base_ref,
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
                    a.action_label, a.actor, a.title, a.target_url, a.occurred_at, a.fetched_at, a.raw_json
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
            title, target_url, occurred_at, fetched_at, raw_json
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(id) DO UPDATE SET
            event_type = excluded.event_type,
            action_label = excluded.action_label,
            actor = excluded.actor,
            title = excluded.title,
            target_url = excluded.target_url,
            occurred_at = excluded.occurred_at,
            fetched_at = excluded.fetched_at,
            raw_json = excluded.raw_json",
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
    let title = first_line(raw_text);
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
                l.provider, l.kind
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
                l.provider, l.kind
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
                l.provider, l.kind
         FROM tasks t
         INNER JOIN task_links l ON l.task_id = t.id
         WHERE l.provider = ?1 AND l.kind = ?2 AND l.external_id = ?3
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
                l.provider, l.kind
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
    db.execute(
        "INSERT INTO task_links
            (task_id, provider, kind, external_id, url, connection_id, external_title, external_body, external_state, target_branch, fetched_at, files_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(task_id) DO UPDATE SET
            provider = excluded.provider,
            kind = excluded.kind,
            external_id = excluded.external_id,
            url = excluded.url,
            connection_id = excluded.connection_id,
            external_title = excluded.external_title,
            external_body = excluded.external_body,
            external_state = excluded.external_state,
            target_branch = excluded.target_branch,
            fetched_at = excluded.fetched_at,
            files_json = excluded.files_json",
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
            &metadata.target_branch,
            &metadata.fetched_at,
            &files_json
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
        "SELECT task_id, provider, kind, external_id, url, connection_id, external_title, external_body, external_state, target_branch, fetched_at, files_json
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
            target_branch: pull_request.target_branch.clone(),
            url: Some(pull_request.pr_url.clone()),
            fetched_at: pull_request.fetched_at,
            files: Vec::new(),
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
        return Ok(SmartTaskResult {
            task: Some(task),
            resource: None,
            parsed: response,
            project_required: false,
            created: false,
            notice: None,
        });
    }

    let mut resource = None;
    let target_project_id = if parsed.kind == "trello_board" {
        if let Some(existing) =
            get_resource_by_identity(db, &provider, "trello_board", &external_id)
                .map_err(db_error)?
        {
            resource = Some(existing.clone());
            Some(existing.project_id)
        } else {
            project_id.clone()
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
        if resource.is_none() {
            resource = Some(
                connect_resource_in_db(
                    db,
                    ResourceInput {
                        project_id: target_project_id.clone(),
                        provider: provider.clone(),
                        kind: "trello_board".to_string(),
                        external_id: external_id.clone(),
                        url: source_url.clone(),
                        name: response.title.clone(),
                        icon_url: None,
                        connection_id: None,
                    },
                )
                .map_err(db_error)?,
            );
        }

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
        provider,
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
            target_branch: None,
            url: None,
            fetched_at: None,
            files: Vec::new(),
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
        headers,
    )?;

    Ok(events
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|event| github_activity_from_json(connection, event, start_at, end_at))
                .collect()
        })
        .unwrap_or_default())
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

    Some(ActivityInput {
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
    })
}

fn fetch_gitlab_activities(
    connection: &ConnectionRecord,
    date: &str,
    start_at: i64,
    end_at: i64,
) -> Result<Vec<ActivityInput>, String> {
    let base_url = normalize_base_url(&connection.base_url);
    let before = add_days_to_date(date, 1).unwrap_or_else(|| date.to_string());
    let url = format!(
        "{base_url}/api/v4/events?scope=all&after={}&before={}&sort=desc&per_page=100",
        percent_encode(date),
        percent_encode(&before)
    );
    let events = fetch_json(&url, vec![("PRIVATE-TOKEN", connection.token.clone())])?;

    Ok(events
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|event| gitlab_activity_from_json(connection, event, start_at, end_at))
                .collect()
        })
        .unwrap_or_default())
}

fn gitlab_activity_from_json(
    connection: &ConnectionRecord,
    event: &Value,
    start_at: i64,
    end_at: i64,
) -> Option<ActivityInput> {
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
    })
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
    })
}

fn github_activity_label(event: &Value, event_type: &str, action: Option<&str>) -> String {
    if event_type == "PullRequestEvent"
        && action == Some("closed")
        && json_path_bool(event, &["payload", "pull_request", "merged"]) == Some(true)
    {
        return "Merged".to_string();
    }

    if let Some(action) = action.and_then(canonical_activity_action) {
        return action;
    }

    match event_type {
        "PushEvent" => "Pushed".to_string(),
        "CreateEvent" => "Created".to_string(),
        "DeleteEvent" => "Deleted".to_string(),
        "IssueCommentEvent" | "CommitCommentEvent" | "PullRequestReviewCommentEvent" => {
            "Commented".to_string()
        }
        "PullRequestReviewEvent" => "Reviewed".to_string(),
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
            if old.and_then(|value| value.get("idList")).is_some()
                || old.and_then(|value| value.get("pos")).is_some()
            {
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
    let list_url = format!(
        "https://api.trello.com/1/cards/{}/list?key={}&token={}",
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
    Ok(ProviderMetadata {
        title: json_string(&json, "name"),
        body: json_string(&json, "desc"),
        state: trello_list_state(&list_json),
        url: json_string(&json, "url").or_else(|| parsed.url.clone()),
        files: trello_attachment_files(&attachments_json),
        ..ProviderMetadata::empty()
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
    Ok(ProviderMetadata {
        title: json_string(&json, "title"),
        body: json_string(&json, "body"),
        state: github_pull_request_state(&json),
        target_branch: github_pull_request_target_branch(&json),
        url: json_string(&json, "html_url").or_else(|| parsed.url.clone()),
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
    Ok(ProviderMetadata {
        title: json_string(&json, "title"),
        body: json_string(&json, "description"),
        state: json_string(&json, "state"),
        target_branch: json_string(&json, "target_branch"),
        url: json_string(&json, "web_url").or_else(|| parsed.url.clone()),
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
    Ok(ProviderMetadata {
        title: json_string(&json, "title"),
        body: json_string(&json, "description"),
        state: json_string(&json, "state"),
        url: json_string(&json, "web_url").or_else(|| parsed.url.clone()),
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
fn create_task_from_input(
    state: tauri::State<'_, AppState>,
    input: String,
    parsed: ParsedInputPayload,
    project_id: Option<String>,
) -> Result<SmartTaskResult, String> {
    let db = state.db.lock().map_err(db_error)?;
    create_smart_task_in_db(&db, input, parsed, project_id)
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
                l.provider, l.kind
         FROM tasks t
         LEFT JOIN task_links l ON l.task_id = t.id
         WHERE t.project_id = ?1 ORDER BY t.created_at DESC"
    } else {
        "SELECT t.id, t.project_id, t.title, t.body, t.status, t.source_url, t.created_at, t.updated_at,
                l.provider, l.kind
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
                    l.provider, l.kind
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
fn sync_activities(
    state: tauri::State<'_, AppState>,
    date: String,
    start_at: i64,
    end_at: i64,
) -> Result<ActivityResult, String> {
    let connections = {
        let db = state.db.lock().map_err(db_error)?;
        list_connections_in_db(&db).map_err(db_error)?
    };

    let fetched_at = now_millis();
    for connection in connections {
        let result = validate_connection_credentials(&connection)
            .and_then(|_| fetch_connection_activities(&connection, &date, start_at, end_at));
        let db = state.db.lock().map_err(db_error)?;
        match result {
            Ok(activities) => {
                for activity in activities {
                    upsert_activity_in_db(&db, &activity, fetched_at).map_err(db_error)?;
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
    }

    let db = state.db.lock().map_err(db_error)?;
    list_activities_in_db(&db, &date, start_at, end_at)
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
            ",
        )
        .expect("create legacy schema");

        init_database(&db).expect("migrate legacy schema");

        assert!(column_exists(&db, "connections", "api_key"));
        assert!(column_exists(&db, "task_links", "connection_id"));
        assert!(column_exists(&db, "task_links", "target_branch"));
        assert!(column_exists(&db, "task_links", "files_json"));
        assert!(column_exists(&db, "pull_requests", "external_state"));
        assert!(column_exists(&db, "pull_requests", "target_branch"));
        assert!(column_exists(&db, "directories", "path"));
        assert!(column_exists(&db, "directories", "name"));
        assert!(column_exists(&db, "activities", "occurred_at"));
        assert!(column_exists(&db, "activity_sync_runs", "synced_at"));
        assert!(column_exists(&db, "smart_inbox_todos", "raw_text"));
        assert!(column_exists(&db, "smart_inbox_todos", "file_path"));
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
        assert_eq!(result.sync_runs.len(), 1);
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
                "SELECT task_id, provider, kind, external_id, url, connection_id, external_title, external_body, external_state, target_branch, fetched_at, files_json
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

        let result = refresh_task_external_details_in_db(&db, task.id).expect("refresh");

        assert!(result.connection_required);
        assert_eq!(result.task.body, "Local notes");
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
        assert_eq!(
            links[0].external_title.as_deref(),
            Some("Fetched Trello title")
        );
        assert_eq!(
            links[0].external_body.as_deref(),
            Some("Fetched Trello description")
        );
        assert_eq!(links[0].external_state.as_deref(), Some("Doing"));
        assert_eq!(links[0].fetched_at, Some(123));
        assert_eq!(links[0].files.len(), 1);
        assert_eq!(links[0].files[0].name, "Design spec.pdf");
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
                target_branch: None,
                url: None,
                fetched_at: Some(123),
                files: Vec::new(),
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
    fn maps_provider_metadata_status_values() {
        let trello_list = serde_json::json!({ "name": "In Progress" });
        assert_eq!(
            trello_list_state(&trello_list).as_deref(),
            Some("In Progress")
        );

        let github_issue = serde_json::json!({ "state": "closed" });
        assert_eq!(github_issue_state(&github_issue).as_deref(), Some("closed"));

        let open_pr = serde_json::json!({ "state": "open", "merged": false });
        assert_eq!(github_pull_request_state(&open_pr).as_deref(), Some("open"));

        let merged_pr = serde_json::json!({ "state": "closed", "merged": true });
        assert_eq!(
            github_pull_request_state(&merged_pr).as_deref(),
            Some("merged")
        );

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
}
