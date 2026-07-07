use rusqlite::{params, Connection as SqliteConnection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
const DEFAULT_PROJECT_COLOR: &str = "#2563eb";

struct AppState {
    db: Mutex<SqliteConnection>,
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
struct Task {
    id: String,
    project_id: Option<String>,
    title: String,
    body: String,
    status: String,
    source_url: Option<String>,
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
    fetched_at: Option<i64>,
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
struct PullRequestSaveResult {
    pull_request: PullRequestRecord,
    notice: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RefreshTaskExternalDetailsResult {
    task: Task,
    links: Vec<TaskLink>,
    notice: Option<String>,
    connection_required: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestConnectionResult {
    ok: bool,
    message: String,
    account_name: Option<String>,
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

#[derive(Debug, Clone)]
struct ProviderMetadata {
    connection_id: Option<String>,
    title: Option<String>,
    body: Option<String>,
    state: Option<String>,
    url: Option<String>,
    fetched_at: Option<i64>,
    notice: Option<String>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let app_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_dir)?;
            let db = SqliteConnection::open(app_dir.join("studio.sqlite"))?;
            init_database(&db)?;
            app.manage(AppState { db: Mutex::new(db) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_projects,
            create_project,
            update_project,
            delete_project,
            list_project_resources,
            connect_resource,
            disconnect_resource,
            create_task_from_input,
            list_tasks,
            update_task,
            link_task_resource,
            list_task_links,
            refresh_task_external_details,
            list_task_relations,
            save_task_relation,
            delete_task_relation,
            list_connections,
            save_connection,
            delete_connection,
            test_connection,
            list_project_connections,
            set_project_connections,
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
        && trimmed.chars().skip(1).all(|character| character.is_ascii_hexdigit());

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
            fetched_at INTEGER,
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
            fetched_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        ",
    )?;
    add_column_if_missing(db, "projects", "color", "TEXT NOT NULL DEFAULT '#2563eb'")?;
    add_column_if_missing(db, "connections", "api_key", "TEXT")?;
    add_column_if_missing(
        db,
        "task_links",
        "connection_id",
        "TEXT REFERENCES connections(id) ON DELETE SET NULL",
    )?;
    add_column_if_missing(db, "task_links", "external_title", "TEXT")?;
    add_column_if_missing(db, "task_links", "external_body", "TEXT")?;
    add_column_if_missing(db, "task_links", "external_state", "TEXT")?;
    add_column_if_missing(db, "task_links", "fetched_at", "INTEGER")?;
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
    add_column_if_missing(db, "pull_requests", "fetched_at", "INTEGER")?;
    migrate_pull_requests_into_tasks(db)?;
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

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        body: row.get(3)?,
        status: row.get(4)?,
        source_url: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn row_to_task_link(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskLink> {
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
        fetched_at: row.get(9)?,
    })
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
        fetched_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
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

fn save_connection_in_db(
    db: &SqliteConnection,
    input: ConnectionInput,
) -> rusqlite::Result<ConnectionRecord> {
    let timestamp = now_millis();
    let id = input.id.unwrap_or_else(|| new_id("connection"));
    let base_url = normalize_base_url(&input.base_url);
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM connections WHERE id = ?1)",
        params![id],
        |row| row.get(0),
    )?;

    if exists {
        db.execute(
            "UPDATE connections SET provider = ?1, name = ?2, base_url = ?3, api_key = ?4, token = ?5, updated_at = ?6 WHERE id = ?7",
            params![
                input.provider,
                input.name,
                base_url,
                input.api_key,
                input.token,
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
                input.provider,
                input.name,
                base_url,
                input.api_key,
                input.token,
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

fn get_connection(db: &SqliteConnection, id: &str) -> rusqlite::Result<Option<ConnectionRecord>> {
    db.query_row(
        "SELECT id, provider, name, base_url, api_key, token, created_at, updated_at FROM connections WHERE id = ?1",
        params![id],
        row_to_connection,
    )
    .optional()
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
        "SELECT id, project_id, title, body, status, source_url, created_at, updated_at FROM tasks WHERE id = ?1",
        params![id],
        row_to_task,
    )
    .optional()
}

fn get_task_by_source_url(
    db: &SqliteConnection,
    source_url: &str,
) -> rusqlite::Result<Option<Task>> {
    db.query_row(
        "SELECT id, project_id, title, body, status, source_url, created_at, updated_at FROM tasks WHERE source_url = ?1 LIMIT 1",
        params![source_url],
        row_to_task,
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
        "SELECT t.id, t.project_id, t.title, t.body, t.status, t.source_url, t.created_at, t.updated_at
         FROM tasks t
         INNER JOIN task_links l ON l.task_id = t.id
         WHERE l.provider = ?1 AND l.kind = ?2 AND l.external_id = ?3
         LIMIT 1",
        params![provider, kind, external_id],
        row_to_task,
    )
    .optional()
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
                t.id, t.project_id, t.title, t.body, t.status, t.source_url, t.created_at, t.updated_at
         FROM task_relations r
         INNER JOIN tasks t ON t.id = CASE WHEN r.source_task_id = ?2 THEN r.target_task_id ELSE r.source_task_id END
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
    db.execute(
        "INSERT INTO task_links
            (task_id, provider, kind, external_id, url, connection_id, external_title, external_body, external_state, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(task_id) DO UPDATE SET
            provider = excluded.provider,
            kind = excluded.kind,
            external_id = excluded.external_id,
            url = excluded.url,
            connection_id = excluded.connection_id,
            external_title = excluded.external_title,
            external_body = excluded.external_body,
            external_state = excluded.external_state,
            fetched_at = excluded.fetched_at",
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
            &metadata.fetched_at
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
        "SELECT task_id, provider, kind, external_id, url, connection_id, external_title, external_body, external_state, fetched_at
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

fn apply_trello_metadata_to_task(
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
    db.execute(
        "UPDATE tasks SET title = ?1, body = ?2, updated_at = ?3 WHERE id = ?4",
        params![refreshed_title, refreshed_body, now_millis(), &task.id],
    )?;

    get_task(db, &task.id)?.ok_or_else(|| rusqlite::Error::QueryReturnedNoRows)
}

fn refresh_task_external_details_in_db(
    db: &SqliteConnection,
    task_id: String,
) -> Result<RefreshTaskExternalDetailsResult, String> {
    let task = get_task(db, &task_id)
        .map_err(db_error)?
        .ok_or_else(|| "Task not found".to_string())?;
    let links = list_task_links_in_db(db, &task.id).map_err(db_error)?;
    let Some(link) = links.first() else {
        return Ok(RefreshTaskExternalDetailsResult {
            task,
            links,
            notice: None,
            connection_required: false,
        });
    };

    if link.provider != "trello" || link.kind != "trello_card" {
        return Ok(RefreshTaskExternalDetailsResult {
            task,
            links,
            notice: None,
            connection_required: false,
        });
    }

    let Some(project_id) = task.project_id.as_deref() else {
        return Ok(RefreshTaskExternalDetailsResult {
            task,
            links,
            notice: Some("Please add a Trello connection to this project.".to_string()),
            connection_required: true,
        });
    };

    let parsed = parsed_payload_from_task_link(&task, link);
    let connection = select_best_connection(db, project_id, &parsed).map_err(db_error)?;
    let Some(connection) = connection else {
        return Ok(RefreshTaskExternalDetailsResult {
            task,
            links,
            notice: Some("Please add a Trello connection to this project.".to_string()),
            connection_required: true,
        });
    };

    match fetch_provider_metadata_with_connection(&connection, &parsed) {
        Ok(mut metadata) => {
            metadata.connection_id = Some(connection.id);
            metadata.fetched_at = Some(now_millis());
            let refreshed_task =
                apply_trello_metadata_to_task(db, &task, link, &metadata).map_err(db_error)?;
            Ok(RefreshTaskExternalDetailsResult {
                links: list_task_links_in_db(db, &refreshed_task.id).map_err(db_error)?,
                task: refreshed_task,
                notice: metadata.notice,
                connection_required: false,
            })
        }
        Err(error) => Ok(RefreshTaskExternalDetailsResult {
            task,
            links,
            notice: Some(format!("Could not fetch external details: {error}")),
            connection_required: false,
        }),
    }
}

fn migrate_pull_requests_into_tasks(db: &SqliteConnection) -> rusqlite::Result<()> {
    let mut statement = db.prepare(
        "SELECT id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, connection_id, external_title, external_body, external_state, fetched_at, created_at, updated_at
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
            url: Some(pull_request.pr_url.clone()),
            fetched_at: pull_request.fetched_at,
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
            url: None,
            fetched_at: None,
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
        return Err(format!("provider returned {status}"));
    }
    response.json::<Value>().map_err(db_error)
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
    let api_key = connection.api_key.as_deref().unwrap_or_default();
    let json = fetch_json(
        &format!(
            "https://api.trello.com/1/members/me?key={}&token={}",
            percent_encode(api_key),
            percent_encode(&connection.token)
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
    let api_key = connection.api_key.as_deref().unwrap_or_default();
    if api_key.trim().is_empty() || connection.token.trim().is_empty() {
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
        percent_encode(&connection.token)
    );
    let json = fetch_json(&url, vec![])?;
    Ok(ProviderMetadata {
        title: json_string(&json, "name"),
        body: json_string(&json, "desc"),
        state: json_bool(&json, "closed").map(|closed| {
            if closed {
                "closed".to_string()
            } else {
                "open".to_string()
            }
        }),
        url: json_string(&json, "url").or_else(|| parsed.url.clone()),
        ..ProviderMetadata::empty()
    })
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
        state: json_string(&json, "state"),
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
        state: json_string(&json, "state"),
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

fn json_string(json: &Value, key: &str) -> Option<String> {
    json.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn json_bool(json: &Value, key: &str) -> Option<bool> {
    json.get(key).and_then(Value::as_bool)
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
fn list_tasks(
    state: tauri::State<'_, AppState>,
    project_id: Option<String>,
) -> Result<Vec<Task>, String> {
    let db = state.db.lock().map_err(db_error)?;
    let sql = if project_id.is_some() {
        "SELECT id, project_id, title, body, status, source_url, created_at, updated_at FROM tasks WHERE project_id = ?1 ORDER BY created_at DESC"
    } else {
        "SELECT id, project_id, title, body, status, source_url, created_at, updated_at FROM tasks ORDER BY created_at DESC"
    };
    let mut statement = db.prepare(sql).map_err(db_error)?;
    let tasks = if let Some(project_id) = project_id {
        statement
            .query_map(params![project_id], row_to_task)
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?
    } else {
        statement
            .query_map([], row_to_task)
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
fn refresh_task_external_details(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<RefreshTaskExternalDetailsResult, String> {
    let db = state.db.lock().map_err(db_error)?;
    refresh_task_external_details_in_db(&db, task_id)
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
                    t.id, t.project_id, t.title, t.body, t.status, t.source_url, t.created_at, t.updated_at
             FROM task_relations r
             INNER JOIN tasks t ON t.id = CASE WHEN r.source_task_id = ?1 THEN r.target_task_id ELSE r.source_task_id END
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
    let mut statement = db
        .prepare(
            "SELECT id, provider, name, base_url, api_key, token, created_at, updated_at
             FROM connections ORDER BY provider ASC, name ASC",
        )
        .map_err(db_error)?;
    let connections = statement
        .query_map([], row_to_connection)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(connections)
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
fn list_pull_requests(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<Vec<PullRequestRecord>, String> {
    let db = state.db.lock().map_err(db_error)?;
    let mut statement = db
        .prepare(
            "SELECT id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, connection_id, external_title, external_body, external_state, fetched_at, created_at, updated_at
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
                 external_title = ?10, external_body = ?11, external_state = ?12, fetched_at = ?13,
                 updated_at = ?14
             WHERE id = ?15",
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
                metadata.fetched_at.or(input.fetched_at),
                timestamp,
                target_id
            ],
        )
        .map_err(db_error)?;
    } else {
        db.execute(
            "INSERT INTO pull_requests
             (id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, connection_id, external_title, external_body, external_state, fetched_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
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
                metadata.fetched_at.or(input.fetched_at),
                timestamp,
                timestamp
            ],
        )
        .map_err(db_error)?;
    }

    let pull_request = db.query_row(
        "SELECT id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, connection_id, external_title, external_body, external_state, fetched_at, created_at, updated_at
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
            "SELECT id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, connection_id, external_title, external_body, external_state, fetched_at, created_at, updated_at
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
        "SELECT id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, connection_id, external_title, external_body, external_state, fetched_at, created_at, updated_at
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

    fn connection_record(provider: &str, api_key: Option<&str>, token: &str) -> ConnectionRecord {
        ConnectionRecord {
            id: format!("{provider}_1"),
            provider: provider.to_string(),
            name: provider.to_string(),
            base_url: match provider {
                "gitlab" => "https://gitlab.example.org".to_string(),
                "github" => "https://github.com".to_string(),
                "trello" => "https://trello.com".to_string(),
                _ => "https://example.org".to_string(),
            },
            api_key: api_key.map(ToString::to_string),
            token: token.to_string(),
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn creates_and_updates_project() {
        let db = memory_db();
        let project =
            create_project_in_db(
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
        assert!(column_exists(&db, "pull_requests", "external_state"));
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

        let mut statement = db
            .prepare(
                "SELECT task_id, provider, kind, external_id, url, connection_id, external_title, external_body, external_state, fetched_at
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
    fn trello_metadata_replaces_task_notes_and_link_metadata() {
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
            state: Some("open".to_string()),
            url: Some("https://trello.com/c/card123/fetched".to_string()),
            fetched_at: Some(123),
            notice: None,
        };

        let refreshed = apply_trello_metadata_to_task(&db, &task, &link, &metadata)
            .expect("apply metadata");
        let links = list_task_links_in_db(&db, &refreshed.id).expect("load updated links");

        assert_eq!(refreshed.title, "Fetched Trello title");
        assert_eq!(refreshed.body, "Fetched Trello description");
        assert_eq!(links[0].external_title.as_deref(), Some("Fetched Trello title"));
        assert_eq!(
            links[0].external_body.as_deref(),
            Some("Fetched Trello description")
        );
        assert_eq!(links[0].external_state.as_deref(), Some("open"));
        assert_eq!(links[0].fetched_at, Some(123));
    }

    #[test]
    fn refresh_ignores_non_trello_links() {
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

        assert!(!result.connection_required);
        assert_eq!(result.task.body, "Local notes");
        assert_eq!(result.links[0].kind, "github_issue");
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
                (task_id, provider, kind, external_id, url, connection_id, external_title, external_body, external_state, fetched_at)
             VALUES
                (?1, 'github', 'pull_request', 'owner/repo#42', ?2, NULL, NULL, NULL, NULL, NULL)",
            params![existing_task.id, pr_url],
        )
        .expect("insert old task link");

        db.execute(
            "INSERT INTO pull_requests
                (id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, connection_id, external_title, external_body, external_state, fetched_at, created_at, updated_at)
             VALUES
                ('pr_1', ?1, 'github', 'https://github.com/owner/repo', ?2, 'Fallback title', 'reviewing', 'Review note', '{}', NULL, 'Fetched title', 'Fetched body', 'open', 10, 1, 2)",
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
    fn stores_trello_key_and_token() {
        let db = memory_db();
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
        .expect("save connection");

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
