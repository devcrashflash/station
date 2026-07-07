use rusqlite::{params, Connection as SqliteConnection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

struct AppState {
    db: Mutex<SqliteConnection>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    icon: String,
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
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SmartTaskResult {
    task: Option<Task>,
    resource: Option<Resource>,
    parsed: ParsedInputResponse,
    project_required: bool,
    created: bool,
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
struct ConnectionInput {
    id: Option<String>,
    provider: String,
    name: String,
    base_url: String,
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
}

#[derive(Debug, Clone)]
struct ParsedInput {
    kind: String,
    provider: Option<String>,
    external_id: Option<String>,
    url: Option<String>,
    title: String,
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
            list_connections,
            save_connection,
            delete_connection,
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

fn init_database(db: &SqliteConnection) -> rusqlite::Result<()> {
    db.execute_batch(
        "
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            icon TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS connections (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            token TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
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
            PRIMARY KEY(task_id, provider, kind, external_id)
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
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        ",
    )
}

fn row_to_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        icon: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
    })
}

fn row_to_connection(row: &rusqlite::Row<'_>) -> rusqlite::Result<ConnectionRecord> {
    Ok(ConnectionRecord {
        id: row.get(0)?,
        provider: row.get(1)?,
        name: row.get(2)?,
        base_url: row.get(3)?,
        token: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
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
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn create_project_in_db(
    db: &SqliteConnection,
    name: String,
    icon: Option<String>,
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
        created_at: timestamp,
        updated_at: timestamp,
    };

    db.execute(
        "INSERT INTO projects (id, name, icon, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            project.id,
            project.name,
            project.icon,
            project.created_at,
            project.updated_at
        ],
    )?;

    Ok(project)
}

fn get_project(db: &SqliteConnection, id: &str) -> rusqlite::Result<Option<Project>> {
    db.query_row(
        "SELECT id, name, icon, created_at, updated_at FROM projects WHERE id = ?1",
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
    let exists: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM connections WHERE id = ?1)",
        params![id],
        |row| row.get(0),
    )?;

    if exists {
        db.execute(
            "UPDATE connections SET provider = ?1, name = ?2, base_url = ?3, token = ?4, updated_at = ?5 WHERE id = ?6",
            params![input.provider, input.name, input.base_url, input.token, timestamp, id],
        )?;
    } else {
        db.execute(
            "INSERT INTO connections (id, provider, name, base_url, token, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                id,
                input.provider,
                input.name,
                input.base_url,
                input.token,
                timestamp,
                timestamp
            ],
        )?;
    }

    db.query_row(
        "SELECT id, provider, name, base_url, token, created_at, updated_at FROM connections WHERE id = ?1",
        params![id],
        row_to_connection,
    )
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

fn link_task_resource_in_db(
    db: &SqliteConnection,
    task_id: String,
    provider: String,
    kind: String,
    external_id: String,
    url: String,
) -> rusqlite::Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO task_links (task_id, provider, kind, external_id, url)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![task_id, provider, kind, external_id, url],
    )?;
    Ok(())
}

fn create_smart_task_in_db(
    db: &SqliteConnection,
    input: String,
    project_id: Option<String>,
) -> Result<SmartTaskResult, String> {
    let parsed = parse_input(&input);
    let response = parsed_response(&parsed);

    if parsed.kind == "text" {
        let Some(target_project_id) = project_id else {
            return Ok(SmartTaskResult {
                task: None,
                resource: None,
                parsed: response,
                project_required: true,
                created: false,
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
        });
    }

    let provider = parsed.provider.clone().unwrap_or_default();
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
        });
    };

    if parsed.kind == "trello_board" && resource.is_none() {
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

    let task = create_task_in_db(
        db,
        Some(target_project_id),
        response.title.clone(),
        input.trim().to_string(),
        Some(source_url.clone()),
    )
    .map_err(db_error)?;
    link_task_resource_in_db(
        db,
        task.id.clone(),
        provider,
        parsed.kind.clone(),
        external_id,
        source_url,
    )
    .map_err(db_error)?;

    Ok(SmartTaskResult {
        task: Some(task),
        resource,
        parsed: response,
        project_required: false,
        created: true,
    })
}

fn parse_input(input: &str) -> ParsedInput {
    let trimmed = input.trim();
    let url = trimmed
        .split_whitespace()
        .find(|part| part.starts_with("http://") || part.starts_with("https://"))
        .unwrap_or(trimmed);

    if url.contains("trello.com/b/") {
        let external_id = segment_after(url, "/b/").unwrap_or_else(|| url.to_string());
        return ParsedInput {
            kind: "trello_board".to_string(),
            provider: Some("trello".to_string()),
            external_id: Some(external_id.clone()),
            url: Some(url.to_string()),
            title: title_from_url(url, &format!("Trello board {external_id}")),
        };
    }

    if url.contains("trello.com/c/") {
        let external_id = segment_after(url, "/c/").unwrap_or_else(|| url.to_string());
        return ParsedInput {
            kind: "trello_card".to_string(),
            provider: Some("trello".to_string()),
            external_id: Some(external_id.clone()),
            url: Some(url.to_string()),
            title: title_from_url(url, &format!("Trello card {external_id}")),
        };
    }

    ParsedInput {
        kind: "text".to_string(),
        provider: None,
        external_id: None,
        url: None,
        title: trimmed
            .lines()
            .next()
            .unwrap_or("New task")
            .trim()
            .to_string(),
    }
}

fn segment_after(url: &str, marker: &str) -> Option<String> {
    let start = url.find(marker)? + marker.len();
    url[start..]
        .split(['/', '?', '#'])
        .next()
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn title_from_url(url: &str, fallback: &str) -> String {
    let title = url
        .split('/')
        .filter(|part| !part.is_empty())
        .last()
        .unwrap_or(fallback)
        .replace('-', " ");
    if title.starts_with("http") || title.trim().is_empty() {
        fallback.to_string()
    } else {
        title
    }
}

fn parsed_response(parsed: &ParsedInput) -> ParsedInputResponse {
    ParsedInputResponse {
        kind: parsed.kind.clone(),
        provider: parsed.provider.clone(),
        external_id: parsed.external_id.clone(),
        url: parsed.url.clone(),
        title: parsed.title.clone(),
    }
}

#[tauri::command]
fn list_projects(state: tauri::State<'_, AppState>) -> Result<Vec<Project>, String> {
    let db = state.db.lock().map_err(db_error)?;
    let mut statement = db
        .prepare(
            "SELECT id, name, icon, created_at, updated_at FROM projects ORDER BY created_at ASC",
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
) -> Result<Project, String> {
    let db = state.db.lock().map_err(db_error)?;
    create_project_in_db(&db, name, icon).map_err(db_error)
}

#[tauri::command]
fn update_project(
    state: tauri::State<'_, AppState>,
    id: String,
    name: Option<String>,
    icon: Option<String>,
) -> Result<Project, String> {
    let db = state.db.lock().map_err(db_error)?;
    let existing = get_project(&db, &id)
        .map_err(db_error)?
        .ok_or_else(|| "Project not found".to_string())?;
    let updated_name = name.unwrap_or(existing.name);
    let updated_icon = icon.unwrap_or(existing.icon);
    let timestamp = now_millis();
    db.execute(
        "UPDATE projects SET name = ?1, icon = ?2, updated_at = ?3 WHERE id = ?4",
        params![updated_name, updated_icon, timestamp, id],
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
    project_id: Option<String>,
) -> Result<SmartTaskResult, String> {
    let db = state.db.lock().map_err(db_error)?;
    create_smart_task_in_db(&db, input, project_id)
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
    link_task_resource_in_db(&db, task_id, provider, kind, external_id, url).map_err(db_error)
}

#[tauri::command]
fn list_task_links(
    state: tauri::State<'_, AppState>,
    task_id: String,
) -> Result<Vec<TaskLink>, String> {
    let db = state.db.lock().map_err(db_error)?;
    let mut statement = db
        .prepare(
            "SELECT task_id, provider, kind, external_id, url
             FROM task_links WHERE task_id = ?1 ORDER BY provider ASC, kind ASC",
        )
        .map_err(db_error)?;
    let links = statement
        .query_map(params![task_id], row_to_task_link)
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(links)
}

#[tauri::command]
fn list_connections(state: tauri::State<'_, AppState>) -> Result<Vec<ConnectionRecord>, String> {
    let db = state.db.lock().map_err(db_error)?;
    let mut statement = db
        .prepare(
            "SELECT id, provider, name, base_url, token, created_at, updated_at
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
fn list_pull_requests(
    state: tauri::State<'_, AppState>,
    project_id: String,
) -> Result<Vec<PullRequestRecord>, String> {
    let db = state.db.lock().map_err(db_error)?;
    let mut statement = db
        .prepare(
            "SELECT id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, created_at, updated_at
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
) -> Result<PullRequestRecord, String> {
    let db = state.db.lock().map_err(db_error)?;
    let timestamp = now_millis();
    let id = input.id.unwrap_or_else(|| new_id("pr"));
    let exists: Option<String> = db
        .query_row(
            "SELECT id FROM pull_requests WHERE id = ?1 OR pr_url = ?2 LIMIT 1",
            params![id, input.pr_url],
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
                 status = ?6, review_notes = ?7, test_state = ?8, updated_at = ?9
             WHERE id = ?10",
            params![
                input.project_id,
                input.provider,
                input.repo_url,
                input.pr_url,
                input.title,
                input.status,
                input.review_notes,
                input.test_state,
                timestamp,
                target_id
            ],
        )
        .map_err(db_error)?;
    } else {
        db.execute(
            "INSERT INTO pull_requests
             (id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                target_id,
                input.project_id,
                input.provider,
                input.repo_url,
                input.pr_url,
                input.title,
                input.status,
                input.review_notes,
                input.test_state,
                timestamp,
                timestamp
            ],
        )
        .map_err(db_error)?;
    }

    db.query_row(
        "SELECT id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, created_at, updated_at
         FROM pull_requests WHERE id = ?1",
        params![target_id],
        row_to_pull_request,
    )
    .map_err(db_error)
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
            "SELECT id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, created_at, updated_at
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
        "SELECT id, project_id, provider, repo_url, pr_url, title, status, review_notes, test_state, created_at, updated_at
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
    fn creates_and_updates_project() {
        let db = memory_db();
        let project =
            create_project_in_db(&db, "Access".to_string(), Some("GitBranch".to_string()))
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
    fn connects_resource_without_duplicates() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None).expect("project");
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
        let project = create_project_in_db(&db, "Access".to_string(), None).expect("project");
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
        )
        .expect("link");

        let linked = get_task_by_link(&db, "trello", "trello_card", "card123")
            .expect("query linked")
            .expect("linked task");
        assert_eq!(linked.id, task.id);

        let mut statement = db
            .prepare(
                "SELECT task_id, provider, kind, external_id, url
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
    }

    #[test]
    fn smart_text_task_requires_project() {
        let db = memory_db();
        let result = create_smart_task_in_db(&db, "Review onboarding".to_string(), None)
            .expect("smart task result");

        assert!(result.project_required);
        assert!(result.task.is_none());
    }

    #[test]
    fn smart_text_task_creates_inside_project() {
        let db = memory_db();
        let project = create_project_in_db(&db, "Access".to_string(), None).expect("project");
        let result = create_smart_task_in_db(
            &db,
            "Review onboarding".to_string(),
            Some(project.id.clone()),
        )
        .expect("smart task result");

        let task = result.task.expect("created task");
        assert!(!result.project_required);
        assert_eq!(task.project_id.as_deref(), Some(project.id.as_str()));
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
                token: "secret".to_string(),
            },
        )
        .expect("save connection");

        assert_eq!(connection.provider, "gitlab");
        assert_eq!(connection.token, "secret");
    }

    #[test]
    fn parses_trello_inputs() {
        let board = parse_input("https://trello.com/b/abc123/project-board");
        assert_eq!(board.kind, "trello_board");
        assert_eq!(board.external_id.as_deref(), Some("abc123"));

        let card = parse_input("https://trello.com/c/card123/review-this");
        assert_eq!(card.kind, "trello_card");
        assert_eq!(card.external_id.as_deref(), Some("card123"));
    }
}
