use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
#[cfg(any(windows, target_os = "linux"))]
use std::process::Command;
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSession {
    id: String,
    provider: String,
    title: String,
    cwd: Option<String>,
    created_at: i64,
    updated_at: i64,
    parent_id: Option<String>,
    kind: String,
    open_targets: Vec<String>,
    children: Vec<AiSession>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionProviderWarning {
    provider: String,
    message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionList {
    sessions: Vec<AiSession>,
    warnings: Vec<AiSessionProviderWarning>,
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn codex_home() -> Option<PathBuf> {
    env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|path| path.join(".codex")))
}

fn claude_home() -> Option<PathBuf> {
    env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|path| path.join(".claude")))
}

fn millis(value: i64) -> i64 {
    if value > 0 && value < 10_000_000_000 {
        value * 1000
    } else {
        value
    }
}

fn file_millis(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn timestamp_millis(value: Option<&str>) -> i64 {
    value
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
        .unwrap_or(0)
}

fn collect_files(root: &Path, predicate: &impl Fn(&Path) -> bool, output: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, predicate, output);
        } else if predicate(&path) {
            output.push(path);
        }
    }
}

fn command_available(command: &str) -> bool {
    let Some(path) = env::var_os("PATH") else {
        return false;
    };
    let extensions: &[&str] = if cfg!(windows) {
        &["", ".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };
    env::split_paths(&path).any(|directory| {
        extensions
            .iter()
            .any(|extension| directory.join(format!("{command}{extension}")).is_file())
    })
}

#[cfg(target_os = "macos")]
fn desktop_available(provider: &str) -> bool {
    let bundle_names: &[&str] = match provider {
        "codex" => &["ChatGPT.app", "Codex.app"],
        "claude" => &["Claude.app"],
        _ => return false,
    };
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = home_dir() {
        roots.push(home.join("Applications"));
    }
    roots
        .iter()
        .any(|root| bundle_names.iter().any(|name| root.join(name).is_dir()))
}

#[cfg(windows)]
fn desktop_available(provider: &str) -> bool {
    Command::new("reg")
        .args(["query", &format!(r"HKCU\Software\Classes\{provider}")])
        .output()
        .is_ok_and(|output| output.status.success())
}

#[cfg(target_os = "linux")]
fn desktop_available(provider: &str) -> bool {
    Command::new("xdg-mime")
        .args(["query", "default", &format!("x-scheme-handler/{provider}")])
        .output()
        .is_ok_and(|output| output.status.success() && !output.stdout.is_empty())
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn desktop_available(_provider: &str) -> bool {
    false
}

fn open_targets(provider: &str) -> Vec<String> {
    let mut targets = Vec::new();
    if command_available(provider) {
        targets.push("terminal".to_string());
    }
    if desktop_available(provider) {
        targets.push("desktop".to_string());
    }
    targets
}

fn codex_database(home: &Path) -> Option<PathBuf> {
    [
        home.join("state_5.sqlite"),
        home.join("sqlite/state_5.sqlite"),
    ]
    .into_iter()
    .filter(|path| path.is_file())
    .max_by_key(|path| file_millis(path))
}

fn read_codex_database(path: &Path) -> Result<Vec<AiSession>, String> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    let targets = open_targets("codex");
    let mut statement = db
        .prepare("SELECT id, created_at, updated_at, cwd, title FROM threads WHERE archived = 0")
        .map_err(|error| error.to_string())?;
    let mut sessions = statement
        .query_map([], |row| {
            Ok(AiSession {
                id: row.get(0)?,
                provider: "codex".to_string(),
                title: row.get::<_, String>(4).unwrap_or_default(),
                cwd: row
                    .get::<_, String>(3)
                    .ok()
                    .filter(|value| !value.is_empty()),
                created_at: millis(row.get(1)?),
                updated_at: millis(row.get(2)?),
                parent_id: None,
                kind: "session".to_string(),
                open_targets: targets.clone(),
                children: Vec::new(),
            })
        })
        .map_err(|error| error.to_string())?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();

    let edges = db
        .prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()
        })
        .unwrap_or_default();
    let parents = edges
        .into_iter()
        .map(|(parent_id, child_id)| (child_id, parent_id))
        .collect::<HashMap<_, _>>();
    for session in &mut sessions {
        if let Some(parent_id) = parents.get(&session.id) {
            session.parent_id = Some(parent_id.clone());
            session.kind = "subagent".to_string();
            session.open_targets.clear();
        }
        if session.title.trim().is_empty() {
            session.title = "Codex session".to_string();
        }
    }
    Ok(sessions)
}

fn content_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    value.as_array().and_then(|items| {
        items.iter().find_map(|item| {
            item.get("text")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    item.get("content")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
        })
    })
}

fn concise_title(value: &str, fallback: &str) -> String {
    let line = value
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("")
        .trim();
    if line.is_empty() {
        return fallback.to_string();
    }
    let mut title = line.chars().take(100).collect::<String>();
    if line.chars().count() > 100 {
        title.push('…');
    }
    title
}

fn read_codex_transcript(path: &Path) -> Option<AiSession> {
    let file = fs::File::open(path).ok()?;
    let mut id = None;
    let mut cwd = None;
    let mut created_at = 0;
    let mut title = None;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let timestamp = timestamp_millis(value.get("timestamp").and_then(Value::as_str));
        if value.get("type").and_then(Value::as_str) == Some("session_meta") {
            let payload = value.get("payload")?;
            id = payload
                .get("id")
                .or_else(|| payload.get("session_id"))
                .and_then(Value::as_str)
                .map(str::to_string);
            cwd = payload
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::to_string);
            created_at =
                timestamp_millis(payload.get("timestamp").and_then(Value::as_str)).max(timestamp);
        } else if title.is_none()
            && value.get("type").and_then(Value::as_str) == Some("response_item")
            && value.pointer("/payload/role").and_then(Value::as_str) == Some("user")
        {
            title = value
                .pointer("/payload/content")
                .and_then(content_text)
                .map(|text| concise_title(&text, "Codex session"));
        }
    }
    Some(AiSession {
        id: id?,
        provider: "codex".to_string(),
        title: title.unwrap_or_else(|| "Codex session".to_string()),
        cwd,
        created_at,
        updated_at: file_millis(path).max(created_at),
        parent_id: None,
        kind: "session".to_string(),
        open_targets: open_targets("codex"),
        children: Vec::new(),
    })
}

fn discover_codex() -> Result<Vec<AiSession>, String> {
    let home =
        codex_home().ok_or_else(|| "Could not determine the Codex data directory.".to_string())?;
    if let Some(database) = codex_database(&home) {
        if let Ok(sessions) = read_codex_database(&database) {
            return Ok(sessions);
        }
    }
    let sessions_root = home.join("sessions");
    if !sessions_root.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    collect_files(
        &sessions_root,
        &|path| path.extension().is_some_and(|value| value == "jsonl"),
        &mut files,
    );
    Ok(files
        .iter()
        .filter_map(|path| read_codex_transcript(path))
        .collect())
}

fn read_claude_transcript(path: &Path, projects_root: &Path) -> Option<AiSession> {
    let file = fs::File::open(path).ok()?;
    let relative = path.strip_prefix(projects_root).ok()?;
    let components = relative
        .iter()
        .map(|value| value.to_string_lossy())
        .collect::<Vec<_>>();
    let subagent_index = components.iter().position(|value| value == "subagents");
    let parent_id = subagent_index
        .and_then(|index| index.checked_sub(1))
        .and_then(|index| components.get(index))
        .map(|value| value.to_string());
    let is_subagent = parent_id.is_some();
    let mut id = if is_subagent {
        path.file_stem()
            .map(|value| value.to_string_lossy().into_owned())
    } else {
        None
    };
    let mut cwd = None;
    let mut created_at = 0;
    let mut updated_at = 0;
    let mut title = None;
    let mut first_prompt = None;
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        id = id.or_else(|| {
            value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        cwd = cwd.or_else(|| value.get("cwd").and_then(Value::as_str).map(str::to_string));
        let timestamp = timestamp_millis(value.get("timestamp").and_then(Value::as_str));
        if timestamp > 0 {
            created_at = if created_at == 0 {
                timestamp
            } else {
                created_at.min(timestamp)
            };
            updated_at = updated_at.max(timestamp);
        }
        if value.get("type").and_then(Value::as_str) == Some("ai-title") {
            title = value
                .get("aiTitle")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if first_prompt.is_none() && value.get("type").and_then(Value::as_str) == Some("user") {
            first_prompt = value
                .pointer("/message/content")
                .and_then(content_text)
                .map(|text| concise_title(&text, "Claude session"));
        }
    }
    let fallback = if is_subagent {
        "Claude subagent"
    } else {
        "Claude session"
    };
    Some(AiSession {
        id: id?,
        provider: "claude".to_string(),
        title: title
            .filter(|value| !value.trim().is_empty())
            .or(first_prompt)
            .unwrap_or_else(|| fallback.to_string()),
        cwd,
        created_at,
        updated_at: updated_at.max(file_millis(path)),
        parent_id,
        kind: if is_subagent { "subagent" } else { "session" }.to_string(),
        open_targets: if is_subagent {
            Vec::new()
        } else {
            open_targets("claude")
        },
        children: Vec::new(),
    })
}

fn discover_claude() -> Result<Vec<AiSession>, String> {
    let home = claude_home()
        .ok_or_else(|| "Could not determine the Claude data directory.".to_string())?;
    let projects_root = home.join("projects");
    if !projects_root.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    collect_files(
        &projects_root,
        &|path| path.extension().is_some_and(|value| value == "jsonl"),
        &mut files,
    );
    Ok(files
        .iter()
        .filter_map(|path| read_claude_transcript(path, &projects_root))
        .collect())
}

fn group_and_filter(mut sessions: Vec<AiSession>, since: i64) -> Vec<AiSession> {
    let child_ids = sessions
        .iter()
        .filter(|session| session.parent_id.is_some())
        .map(|session| session.id.clone())
        .collect::<HashSet<_>>();
    let mut children = HashMap::<String, Vec<AiSession>>::new();
    for child in sessions
        .iter()
        .filter(|session| child_ids.contains(&session.id))
    {
        if child.updated_at >= since {
            children
                .entry(child.parent_id.clone().unwrap())
                .or_default()
                .push(child.clone());
        }
    }
    sessions.retain(|session| session.parent_id.is_none());
    for session in &mut sessions {
        session.children = children.remove(&session.id).unwrap_or_default();
        session
            .children
            .sort_by_key(|child| std::cmp::Reverse(child.updated_at));
    }
    sessions.retain(|session| session.updated_at >= since || !session.children.is_empty());
    sessions.sort_by_key(|session| {
        std::cmp::Reverse(
            session.updated_at.max(
                session
                    .children
                    .first()
                    .map(|child| child.updated_at)
                    .unwrap_or(0),
            ),
        )
    });
    sessions
}

#[tauri::command]
pub fn list_ai_sessions(since: i64) -> AiSessionList {
    let mut sessions = Vec::new();
    let mut warnings = Vec::new();
    for (provider, result) in [("codex", discover_codex()), ("claude", discover_claude())] {
        match result {
            Ok(mut provider_sessions) => sessions.append(&mut provider_sessions),
            Err(message) => warnings.push(AiSessionProviderWarning {
                provider: provider.to_string(),
                message,
            }),
        }
    }
    AiSessionList {
        sessions: group_and_filter(sessions, since),
        warnings,
    }
}

fn valid_session_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

#[tauri::command]
pub fn open_ai_session_desktop(
    app: tauri::AppHandle,
    provider: String,
    session_id: String,
) -> Result<(), String> {
    if !valid_session_id(&session_id) {
        return Err("Invalid AI session identifier.".to_string());
    }
    if !desktop_available(&provider) {
        return Err(format!("The {provider} desktop app is not available."));
    }
    let url = match provider.as_str() {
        "codex" => format!("codex://threads/{session_id}"),
        "claude" => format!("claude://resume?session={session_id}"),
        _ => return Err("Unsupported AI session provider.".to_string()),
    };
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_dir(name: &str) -> PathBuf {
        let path = env::temp_dir().join(format!(
            "station-ai-sessions-{name}-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn session(id: &str, updated_at: i64, parent_id: Option<&str>) -> AiSession {
        AiSession {
            id: id.to_string(),
            provider: "codex".to_string(),
            title: id.to_string(),
            cwd: None,
            created_at: updated_at,
            updated_at,
            parent_id: parent_id.map(str::to_string),
            kind: if parent_id.is_some() {
                "subagent"
            } else {
                "session"
            }
            .to_string(),
            open_targets: Vec::new(),
            children: Vec::new(),
        }
    }

    #[test]
    fn keeps_old_parent_when_recent_child_matches() {
        let grouped = group_and_filter(
            vec![
                session("parent", 10, None),
                session("child", 100, Some("parent")),
            ],
            50,
        );
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].children[0].id, "child");
    }

    #[test]
    fn validates_resume_identifiers() {
        assert!(valid_session_id("019f8b86-6180-7102-948b-d3b5c043a27a"));
        assert!(valid_session_id("agent-a7a3d35c2918fbe89"));
        assert!(!valid_session_id("id; rm -rf /"));
        assert!(!valid_session_id(""));
    }

    #[test]
    fn reads_codex_database_and_excludes_archived_threads() {
        let directory = fixture_dir("codex");
        let path = directory.join("state_5.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE threads (id TEXT, created_at INTEGER, updated_at INTEGER, cwd TEXT, title TEXT, archived INTEGER);\
             CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);\
             INSERT INTO threads VALUES ('parent', 10, 20, '/work/app', 'Parent title', 0);\
             INSERT INTO threads VALUES ('child', 11, 21, '/work/app', '', 0);\
             INSERT INTO threads VALUES ('archived', 12, 22, '/work/app', 'Old', 1);\
             INSERT INTO thread_spawn_edges VALUES ('parent', 'child');",
        )
        .unwrap();
        drop(db);

        let sessions = read_codex_database(&path).unwrap();
        assert_eq!(sessions.len(), 2);
        assert!(!sessions.iter().any(|session| session.id == "archived"));
        let child = sessions
            .iter()
            .find(|session| session.id == "child")
            .unwrap();
        assert_eq!(child.parent_id.as_deref(), Some("parent"));
        assert_eq!(child.title, "Codex session");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reads_claude_titles_and_groups_subagent_paths() {
        let directory = fixture_dir("claude");
        let projects = directory.join("projects/project-a");
        let parent_id = "1853652a-2f7e-4691-aa02-627822c06b92";
        fs::create_dir_all(projects.join(parent_id).join("subagents")).unwrap();
        let parent = projects.join(format!("{parent_id}.jsonl"));
        fs::write(
            &parent,
            format!(
                "{{\"type\":\"user\",\"sessionId\":\"{parent_id}\",\"cwd\":\"/work/app\",\"timestamp\":\"2026-07-22T10:00:00Z\",\"message\":{{\"content\":\"Fallback prompt\"}}}}\n\
                 {{\"type\":\"ai-title\",\"sessionId\":\"{parent_id}\",\"aiTitle\":\"Generated title\"}}\n"
            ),
        )
        .unwrap();
        let child = projects
            .join(parent_id)
            .join("subagents")
            .join("agent-child.jsonl");
        fs::write(
            &child,
            format!(
                "{{\"type\":\"user\",\"sessionId\":\"{parent_id}\",\"cwd\":\"/work/app\",\"timestamp\":\"2026-07-22T10:05:00Z\",\"message\":{{\"content\":\"Child task\"}}}}\n"
            ),
        )
        .unwrap();

        let parent_session = read_claude_transcript(&parent, &directory.join("projects")).unwrap();
        let child_session = read_claude_transcript(&child, &directory.join("projects")).unwrap();
        assert_eq!(parent_session.title, "Generated title");
        assert_eq!(parent_session.cwd.as_deref(), Some("/work/app"));
        assert_eq!(child_session.id, "agent-child");
        assert_eq!(child_session.parent_id.as_deref(), Some(parent_id));
        assert!(child_session.open_targets.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }
}
