use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    hash::{DefaultHasher, Hash, Hasher},
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, Condvar, Mutex},
    thread,
    time::UNIX_EPOCH,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use crate::{
    db_error, now_millis, set_ai_session_dock_badge, terminal_tabs, AiSessionSettings, AppState,
};

pub const AI_SESSION_MONITOR_UPDATED_EVENT: &str = "ai-session-monitor-updated";
const AI_SESSION_MONITOR_WINDOW_HOURS: i64 = 24 * 30;
const CLAUDE_AGENTS_COMMAND_TIMEOUT: Duration = Duration::from_secs(3);
const MINIMUM_CLAUDE_AGENTS_VERSION: (u64, u64, u64) = (2, 1, 175);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
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
    origin: String,
    waiting_for_input: bool,
    running: bool,
    completed_at: Option<i64>,
    #[serde(default)]
    archived_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    archive_scope: Option<String>,
    open_targets: Vec<String>,
    children: Vec<AiSession>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionDisplay {
    id: String,
    provider: String,
    origin: String,
    title: String,
    cwd: Option<String>,
    updated_at: i64,
    state: String,
    completed_at: Option<i64>,
    archived_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    archive_scope: Option<String>,
    open_targets: Vec<String>,
    children: Vec<AiSessionDisplay>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionProviderWarning {
    provider: String,
    message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionList {
    sessions: Vec<AiSession>,
    archived_sessions: Vec<AiSession>,
    warnings: Vec<AiSessionProviderWarning>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionSnapshot {
    sessions: Vec<AiSessionDisplay>,
    archived_sessions: Vec<AiSessionDisplay>,
    warnings: Vec<AiSessionProviderWarning>,
    revision: String,
    loaded_at: i64,
    last_refreshed_at: i64,
    waiting_session_count: u32,
    waiting_terminal_tab_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionMonitorStatus {
    revision: String,
    last_refreshed_at: i64,
    waiting_session_count: u32,
    waiting_terminal_tab_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AiSessionMonitorSnapshot {
    display: AiSessionSnapshot,
    source_sessions: Vec<AiSession>,
}

impl From<&AiSessionMonitorSnapshot> for AiSessionMonitorStatus {
    fn from(snapshot: &AiSessionMonitorSnapshot) -> Self {
        Self {
            revision: snapshot.display.revision.clone(),
            last_refreshed_at: snapshot.display.last_refreshed_at,
            waiting_session_count: snapshot.display.waiting_session_count,
            waiting_terminal_tab_ids: snapshot.display.waiting_terminal_tab_ids.clone(),
        }
    }
}

#[derive(Debug)]
struct AiSessionMonitorRuntime {
    settings: AiSessionSettings,
    view_active: bool,
    window_foreground: bool,
    requested_generation: u64,
    completed_generation: u64,
    latest: Option<AiSessionMonitorSnapshot>,
    last_error: Option<String>,
}

#[derive(Clone)]
pub struct AiSessionMonitorHandle {
    shared: Arc<(Mutex<AiSessionMonitorRuntime>, Condvar)>,
}

impl AiSessionMonitorHandle {
    fn polling_interval(runtime: &AiSessionMonitorRuntime) -> Duration {
        Duration::from_secs(ai_session_polling_interval_seconds(
            &runtime.settings,
            runtime.view_active && runtime.window_foreground,
        ))
    }

    fn request_refresh(&self) -> Result<AiSessionMonitorSnapshot, String> {
        let (lock, wake) = &*self.shared;
        let mut runtime = lock.lock().map_err(db_error)?;
        runtime.requested_generation = runtime.requested_generation.saturating_add(1);
        let requested_generation = runtime.requested_generation;
        wake.notify_all();
        while runtime.completed_generation < requested_generation {
            runtime = wake.wait(runtime).map_err(db_error)?;
        }
        match &runtime.last_error {
            Some(error) => Err(error.clone()),
            None => runtime
                .latest
                .clone()
                .ok_or_else(|| "AI session refresh did not produce a snapshot.".to_string()),
        }
    }

    fn latest_or_refresh(&self) -> Result<AiSessionMonitorSnapshot, String> {
        let latest = {
            let (lock, _) = &*self.shared;
            lock.lock().map_err(db_error)?.latest.clone()
        };
        match latest {
            Some(snapshot) => Ok(snapshot),
            None => self.request_refresh(),
        }
    }

    fn latest_status_or_refresh(&self) -> Result<AiSessionMonitorStatus, String> {
        let status = {
            let (lock, _) = &*self.shared;
            lock.lock()
                .map_err(db_error)?
                .latest
                .as_ref()
                .map(AiSessionMonitorStatus::from)
        };
        match status {
            Some(status) => Ok(status),
            None => self
                .request_refresh()
                .map(|snapshot| AiSessionMonitorStatus::from(&snapshot)),
        }
    }

    pub(crate) fn latest_session_cwd(
        &self,
        provider: &str,
        session_id: &str,
    ) -> Result<Option<String>, String> {
        self.latest_or_refresh()?
            .source_sessions
            .iter()
            .find(|session| session.provider == provider && session.id == session_id)
            .map(|session| session.cwd.clone())
            .ok_or_else(|| "AI session was not found in the latest native scan.".to_string())
    }

    pub(crate) fn update_settings(&self, settings: AiSessionSettings) {
        let (lock, wake) = &*self.shared;
        if let Ok(mut runtime) = lock.lock() {
            runtime.settings = settings;
            runtime.requested_generation = runtime.requested_generation.saturating_add(1);
            wake.notify_all();
        }
    }

    fn update_view_active(&self, active: bool) {
        let (lock, wake) = &*self.shared;
        if let Ok(mut runtime) = lock.lock() {
            if runtime.view_active != active {
                runtime.view_active = active;
                wake.notify_all();
            }
        }
    }

    fn update_window_foreground(&self, foreground: bool) {
        let (lock, wake) = &*self.shared;
        if let Ok(mut runtime) = lock.lock() {
            if runtime.window_foreground != foreground {
                runtime.window_foreground = foreground;
                wake.notify_all();
            }
        }
    }
}

fn ai_session_polling_interval_seconds(settings: &AiSessionSettings, foreground: bool) -> u64 {
    if foreground && settings.foreground_refresh_interval_seconds > 0 {
        settings.foreground_refresh_interval_seconds
    } else {
        settings.background_refresh_interval_seconds
    }
}

fn session_tree_waiting_for_input(session: &AiSession) -> bool {
    session.waiting_for_input || session.children.iter().any(session_tree_waiting_for_input)
}

fn waiting_session_count(sessions: &[AiSession]) -> u32 {
    sessions
        .iter()
        .filter(|session| session.archived_at.is_none() && session_tree_waiting_for_input(session))
        .count()
        .try_into()
        .unwrap_or(u32::MAX)
}

fn waiting_terminal_session_keys(sessions: &[AiSession]) -> Vec<(String, String)> {
    fn collect(session: &AiSession, keys: &mut HashSet<(String, String)>) {
        if session.archived_at.is_some() || !session_tree_waiting_for_input(session) {
            return;
        }
        keys.insert((session.provider.clone(), session.id.clone()));
        for child in &session.children {
            collect(child, keys);
        }
    }

    let mut keys = HashSet::new();
    for session in sessions {
        collect(session, &mut keys);
    }
    keys.into_iter().collect()
}

fn ai_session_display_state(session: &AiSession, now: i64, done_duration_seconds: u64) -> String {
    if session.waiting_for_input {
        "waiting"
    } else if session.running {
        "running"
    } else if session.completed_at.is_some_and(|completed_at| {
        now.saturating_sub(completed_at)
            <= i64::try_from(done_duration_seconds.saturating_mul(1_000)).unwrap_or(i64::MAX)
    }) {
        "done"
    } else {
        "idle"
    }
    .to_string()
}

fn display_session(session: &AiSession, now: i64, done_duration_seconds: u64) -> AiSessionDisplay {
    AiSessionDisplay {
        id: session.id.clone(),
        provider: session.provider.clone(),
        origin: session.origin.clone(),
        title: session.title.clone(),
        cwd: session.cwd.clone(),
        updated_at: session.updated_at,
        state: ai_session_display_state(session, now, done_duration_seconds),
        completed_at: session.completed_at,
        archived_at: session.archived_at,
        archive_scope: session.archive_scope.clone(),
        open_targets: session.open_targets.clone(),
        children: session
            .children
            .iter()
            .map(|child| display_session(child, now, done_duration_seconds))
            .collect(),
    }
}

fn display_revision(
    sessions: &[AiSessionDisplay],
    archived_sessions: &[AiSessionDisplay],
    warnings: &[AiSessionProviderWarning],
) -> String {
    let mut hasher = DefaultHasher::new();
    sessions.hash(&mut hasher);
    archived_sessions.hash(&mut hasher);
    warnings.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

pub fn init_database(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS ai_session_archives (
            provider TEXT NOT NULL,
            session_id TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            archived_at INTEGER NOT NULL,
            PRIMARY KEY(provider, session_id)
        );
        ",
    )
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

#[cfg(target_os = "macos")]
fn claude_desktop_sessions_root() -> Option<PathBuf> {
    home_dir().map(|path| {
        path.join("Library")
            .join("Application Support")
            .join("Claude")
            .join("claude-code-sessions")
    })
}

#[cfg(windows)]
fn claude_desktop_sessions_root() -> Option<PathBuf> {
    env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|path| path.join("Claude").join("claude-code-sessions"))
}

#[cfg(target_os = "linux")]
fn claude_desktop_sessions_root() -> Option<PathBuf> {
    env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| home_dir().map(|path| path.join(".config")))
        .map(|path| path.join("Claude").join("claude-code-sessions"))
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn claude_desktop_sessions_root() -> Option<PathBuf> {
    None
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

fn file_created_millis(metadata: &fs::Metadata) -> i64 {
    metadata
        .created()
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

fn command_path(command: &str) -> Option<PathBuf> {
    let Some(path) = env::var_os("PATH") else {
        return None;
    };
    let extensions: &[&str] = if cfg!(windows) {
        &["", ".exe", ".cmd", ".bat"]
    } else {
        &[""]
    };
    env::split_paths(&path).find_map(|directory| {
        extensions.iter().find_map(|extension| {
            let candidate = directory.join(format!("{command}{extension}"));
            candidate.is_file().then_some(candidate)
        })
    })
}

fn claude_executable() -> Option<PathBuf> {
    command_path("claude").or_else(|| {
        let mut candidates = Vec::new();
        if let Some(home) = home_dir() {
            #[cfg(windows)]
            candidates.extend([
                home.join(".local/bin/claude.exe"),
                home.join(".local/bin/claude.cmd"),
            ]);
            #[cfg(not(windows))]
            candidates.push(home.join(".local/bin/claude"));
        }
        #[cfg(target_os = "macos")]
        candidates.extend([
            PathBuf::from("/opt/homebrew/bin/claude"),
            PathBuf::from("/usr/local/bin/claude"),
        ]);
        #[cfg(target_os = "linux")]
        candidates.extend([
            PathBuf::from("/usr/local/bin/claude"),
            PathBuf::from("/usr/bin/claude"),
        ]);
        candidates.into_iter().find(|candidate| candidate.is_file())
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommandResult {
    success: bool,
    stdout: Vec<u8>,
}

fn command_output_with_timeout(
    executable: &Path,
    arguments: &[&str],
    timeout: Duration,
) -> Option<CommandResult> {
    let mut child = Command::new(executable)
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    let reader = thread::spawn(move || {
        let mut output = Vec::new();
        stdout.read_to_end(&mut output).ok()?;
        Some(output)
    });
    let started_at = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started_at.elapsed() < timeout => {
                thread::sleep(Duration::from_millis(20));
            }
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = reader.join().ok().flatten()?;
    status.map(|status| CommandResult {
        success: status.success(),
        stdout,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ClaudeExecutableFingerprint {
    path: PathBuf,
    modified_at: i64,
    file_len: u64,
}

fn executable_fingerprint(path: &Path) -> ClaudeExecutableFingerprint {
    ClaudeExecutableFingerprint {
        path: path.to_path_buf(),
        modified_at: file_millis(path),
        file_len: fs::metadata(path)
            .map(|metadata| metadata.len())
            .unwrap_or(0),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClaudeLiveLifecycle {
    Working,
    NeedsInput,
    Inactive,
    Unknown,
}

impl ClaudeLiveLifecycle {
    fn precedence(self) -> u8 {
        match self {
            Self::Unknown => 0,
            Self::Inactive => 1,
            Self::Working => 2,
            Self::NeedsInput => 3,
        }
    }
}

#[derive(Debug, Default)]
struct ClaudeLiveStateCache {
    capability: Option<(ClaudeExecutableFingerprint, bool)>,
}

fn parse_claude_version(value: &str) -> Option<(u64, u64, u64)> {
    value.split_whitespace().find_map(|field| {
        let mut parts = field.split('.');
        let version = (
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
        );
        parts.next().is_none().then_some(version)
    })
}

fn parse_claude_live_states(value: &[u8]) -> Option<HashMap<String, ClaudeLiveLifecycle>> {
    let entries = serde_json::from_slice::<Value>(value)
        .ok()?
        .as_array()?
        .clone();
    let mut states = HashMap::new();
    for entry in entries {
        let Some(session_id) = entry.get("sessionId").and_then(Value::as_str) else {
            continue;
        };
        let lifecycle = match entry
            .get("state")
            .and_then(Value::as_str)
            .or_else(|| entry.get("status").and_then(Value::as_str))
        {
            Some("working") => ClaudeLiveLifecycle::Working,
            Some("needs_input" | "waiting") => ClaudeLiveLifecycle::NeedsInput,
            Some("idle" | "completed" | "failed" | "stopped") => ClaudeLiveLifecycle::Inactive,
            None if entry.get("waitingFor").and_then(Value::as_str).is_some() => {
                ClaudeLiveLifecycle::NeedsInput
            }
            _ => ClaudeLiveLifecycle::Unknown,
        };
        states
            .entry(session_id.to_string())
            .and_modify(|current: &mut ClaudeLiveLifecycle| {
                if lifecycle.precedence() > current.precedence() {
                    *current = lifecycle;
                }
            })
            .or_insert(lifecycle);
    }
    Some(states)
}

fn claude_live_states_with(
    cache: &mut ClaudeLiveStateCache,
    executable: Option<PathBuf>,
    mut run: impl FnMut(&Path, &[&str], Duration) -> Option<CommandResult>,
) -> Option<HashMap<String, ClaudeLiveLifecycle>> {
    let executable = executable?;
    let fingerprint = executable_fingerprint(&executable);
    let supported = match &cache.capability {
        Some((cached, supported)) if cached == &fingerprint => *supported,
        _ => {
            let output = run(&executable, &["--version"], CLAUDE_AGENTS_COMMAND_TIMEOUT)?;
            if !output.success {
                return None;
            }
            let version = parse_claude_version(&String::from_utf8_lossy(&output.stdout))?;
            let supported = version >= MINIMUM_CLAUDE_AGENTS_VERSION;
            cache.capability = Some((fingerprint, supported));
            supported
        }
    };
    if !supported {
        return None;
    }
    let output = run(
        &executable,
        &["agents", "--all", "--json"],
        CLAUDE_AGENTS_COMMAND_TIMEOUT,
    )?;
    output
        .success
        .then(|| parse_claude_live_states(&output.stdout))?
}

fn claude_live_states(
    cache: &mut ClaudeLiveStateCache,
) -> Option<HashMap<String, ClaudeLiveLifecycle>> {
    claude_live_states_with(cache, claude_executable(), command_output_with_timeout)
}

#[cfg(target_os = "macos")]
fn bundled_codex_executable() -> Option<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = home_dir() {
        roots.push(home.join("Applications"));
    }
    roots.into_iter().find_map(|root| {
        ["Codex.app", "ChatGPT.app"].into_iter().find_map(|bundle| {
            let candidate = root
                .join(bundle)
                .join("Contents")
                .join("Resources")
                .join("codex");
            candidate.is_file().then_some(candidate)
        })
    })
}

#[cfg(not(target_os = "macos"))]
fn bundled_codex_executable() -> Option<PathBuf> {
    None
}

fn codex_executable() -> Option<PathBuf> {
    command_path("codex").or_else(bundled_codex_executable)
}

fn is_bundled_codex_executable(path: &Path) -> bool {
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let components = resolved
        .components()
        .map(|component| component.as_os_str().to_string_lossy())
        .collect::<Vec<_>>();
    components.windows(4).any(|window| {
        matches!(window[0].as_ref(), "ChatGPT.app" | "Codex.app")
            && window[1] == "Contents"
            && window[2] == "Resources"
            && window[3] == "codex"
    })
}

fn codex_cli_executable_from(path: Option<PathBuf>) -> Option<PathBuf> {
    path.filter(|candidate| !is_bundled_codex_executable(candidate))
}

fn codex_cli_executable() -> Option<PathBuf> {
    codex_cli_executable_from(command_path("codex"))
}

fn command_available(command: &str) -> bool {
    if command == "codex" {
        codex_cli_executable().is_some()
    } else if command == "claude" {
        claude_executable().is_some()
    } else {
        command_path(command).is_some()
    }
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
    open_targets_with(command_available(provider), desktop_available(provider))
}

fn open_targets_with(cli_available: bool, app_available: bool) -> Vec<String> {
    let mut targets = Vec::new();
    if cli_available {
        targets.push("terminal".to_string());
    }
    if app_available {
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

fn read_codex_database(
    path: &Path,
    since: i64,
    cache: &mut CodexDiscoveryCache,
) -> Result<Vec<AiSession>, String> {
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    let targets = open_targets("codex");
    let mut statement = db
        .prepare(
            "SELECT id, created_at, updated_at, cwd, title, source, rollout_path
             FROM threads WHERE archived = 0",
        )
        .map_err(|error| error.to_string())?;
    let mut sessions = statement
        .query_map([], |row| {
            let source = row.get::<_, String>(5).unwrap_or_default();
            let rollout_path = row.get::<_, String>(6).unwrap_or_default();
            let updated_at = millis(row.get(2)?);
            let state = if updated_at >= since {
                read_codex_transcript_state_cached(Path::new(&rollout_path), cache)
                    .map(|state| state.lifecycle)
                    .unwrap_or_default()
            } else {
                CodexSessionState::default()
            };
            Ok(AiSession {
                id: row.get(0)?,
                provider: "codex".to_string(),
                title: row.get::<_, String>(4).unwrap_or_default(),
                cwd: row
                    .get::<_, String>(3)
                    .ok()
                    .filter(|value| !value.is_empty()),
                created_at: millis(row.get(1)?),
                updated_at,
                parent_id: None,
                kind: "session".to_string(),
                origin: codex_origin(&source, Path::new(&rollout_path)),
                waiting_for_input: state.waiting_for_input(),
                running: state.running,
                completed_at: state.completed_at,
                archived_at: None,
                archive_scope: None,
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

fn codex_origin(source: &str, rollout_path: &Path) -> String {
    if source.eq_ignore_ascii_case("cli") {
        return "cli".to_string();
    }
    let Ok(file) = fs::File::open(rollout_path) else {
        return "unknown".to_string();
    };
    for line in BufReader::new(file).lines().map_while(Result::ok).take(10) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("session_meta") {
            continue;
        }
        let originator = value
            .pointer("/payload/originator")
            .and_then(Value::as_str)
            .unwrap_or("");
        return if originator.eq_ignore_ascii_case("Codex Desktop") {
            "desktop".to_string()
        } else {
            "unknown".to_string()
        };
    }
    "unknown".to_string()
}

#[derive(Debug, Clone, Default)]
struct CodexSessionState {
    pending_inputs: HashSet<String>,
    pending_approvals: HashSet<String>,
    proposed_plan: bool,
    final_question: bool,
    running: bool,
    completed_at: Option<i64>,
}

impl CodexSessionState {
    fn waiting_for_input(&self) -> bool {
        self.proposed_plan
            || self.final_question
            || !self.pending_inputs.is_empty()
            || !self.pending_approvals.is_empty()
    }
}

fn contains_proposed_plan_block(text: &str) -> bool {
    let mut found_opening_tag = false;
    for line in text.lines().map(str::trim) {
        if line == "<proposed_plan>" {
            found_opening_tag = true;
        } else if found_opening_tag && line == "</proposed_plan>" {
            return true;
        }
    }
    false
}

fn ends_with_question(text: &str) -> bool {
    text.trim_end_matches(|character: char| {
        character.is_whitespace()
            || matches!(
                character,
                '*' | '_' | '`' | '~' | '"' | '\'' | '’' | '”' | ')' | ']'
            )
    })
    .ends_with('?')
}

fn codex_function_call_requires_approval(payload: &Value) -> bool {
    let Some(arguments) = payload.get("arguments").and_then(Value::as_str) else {
        return false;
    };
    let Ok(arguments) = serde_json::from_str::<Value>(arguments) else {
        return false;
    };
    match payload.get("name").and_then(Value::as_str) {
        Some("exec_command") => {
            arguments.get("sandbox_permissions").and_then(Value::as_str)
                == Some("require_escalated")
        }
        Some("js") => arguments
            .get("code")
            .and_then(Value::as_str)
            .is_some_and(|code| code.contains("browser.")),
        _ => false,
    }
}

fn codex_custom_exec_requires_approval(payload: &Value) -> bool {
    if payload.get("name").and_then(Value::as_str) != Some("exec") {
        return false;
    }
    let Some(input) = payload.get("input").and_then(Value::as_str) else {
        return false;
    };
    input
        .split("tools.exec_command(")
        .skip(1)
        .any(codex_exec_command_arguments_require_approval)
}

fn codex_exec_command_arguments_require_approval(arguments: &str) -> bool {
    if serde_json::Deserializer::from_str(arguments.trim_start())
        .into_iter::<Value>()
        .next()
        .and_then(Result::ok)
        .is_some_and(|arguments| {
            arguments.get("sandbox_permissions").and_then(Value::as_str)
                == Some("require_escalated")
        })
    {
        return true;
    }

    // Custom exec scripts are JavaScript, and the generated object literals can
    // use identifier keys instead of strict JSON (`sandbox_permissions:"..."`).
    // Only inspect code outside string literals so command text mentioning the
    // option does not look like an approval request.
    let bytes = arguments.as_bytes();
    let key = b"sandbox_permissions";
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' | b'"' | b'`' => {
                let quote = bytes[index];
                index += 1;
                while index < bytes.len() {
                    if bytes[index] == b'\\' {
                        index += 2;
                    } else if bytes[index] == quote {
                        index += 1;
                        break;
                    } else {
                        index += 1;
                    }
                }
            }
            _ if bytes[index..].starts_with(key)
                && (index == 0
                    || !(bytes[index - 1].is_ascii_alphanumeric()
                        || matches!(bytes[index - 1], b'_' | b'$')))
                && bytes.get(index + key.len()).is_none_or(|value| {
                    !value.is_ascii_alphanumeric() && !matches!(*value, b'_' | b'$')
                }) =>
            {
                index += key.len();
                while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
                    index += 1;
                }
                if bytes.get(index) != Some(&b':') {
                    continue;
                }
                index += 1;
                while bytes.get(index).is_some_and(u8::is_ascii_whitespace) {
                    index += 1;
                }
                let Some(quote @ (b'\'' | b'"')) = bytes.get(index).copied() else {
                    continue;
                };
                index += 1;
                let value_start = index;
                while bytes
                    .get(index)
                    .is_some_and(|value| *value != quote && *value != b'\\')
                {
                    index += 1;
                }
                if bytes.get(index) == Some(&quote)
                    && &bytes[value_start..index] == b"require_escalated"
                {
                    return true;
                }
            }
            _ => index += 1,
        }
    }
    false
}

fn update_codex_session_state(value: &Value, state: &mut CodexSessionState) {
    if value.get("type").and_then(Value::as_str) == Some("event_msg") {
        match value.pointer("/payload/type").and_then(Value::as_str) {
            Some("task_started") => {
                state.running = true;
                state.completed_at = None;
            }
            Some("task_complete") => {
                state.running = false;
                state.completed_at = Some(timestamp_millis(
                    value.get("timestamp").and_then(Value::as_str),
                ));
            }
            Some("turn_aborted") => {
                state.running = false;
                state.completed_at = None;
                state.pending_inputs.clear();
                state.pending_approvals.clear();
                state.proposed_plan = false;
                state.final_question = false;
            }
            _ => {}
        }
        return;
    }
    if value.get("type").and_then(Value::as_str) != Some("response_item") {
        return;
    }
    let Some(payload) = value.get("payload") else {
        return;
    };
    match payload.get("type").and_then(Value::as_str) {
        Some("message") if payload.get("role").and_then(Value::as_str) == Some("user") => {
            state.proposed_plan = false;
            state.final_question = false;
        }
        Some("message")
            if payload.get("role").and_then(Value::as_str) == Some("assistant")
                && payload.get("phase").and_then(Value::as_str) == Some("final_answer") =>
        {
            let text = payload.get("content").and_then(content_text);
            state.proposed_plan = text.as_deref().is_some_and(contains_proposed_plan_block);
            state.final_question = text.as_deref().is_some_and(ends_with_question);
        }
        Some("function_call")
            if payload.get("name").and_then(Value::as_str) == Some("request_user_input") =>
        {
            if let Some(call_id) = payload.get("call_id").and_then(Value::as_str) {
                state.pending_inputs.insert(call_id.to_string());
            }
        }
        Some("function_call") if codex_function_call_requires_approval(payload) => {
            if let Some(call_id) = payload.get("call_id").and_then(Value::as_str) {
                state.pending_approvals.insert(call_id.to_string());
            }
        }
        Some("custom_tool_call") if codex_custom_exec_requires_approval(payload) => {
            if let Some(call_id) = payload.get("call_id").and_then(Value::as_str) {
                state.pending_approvals.insert(call_id.to_string());
            }
        }
        Some("function_call_output") | Some("custom_tool_call_output") => {
            if let Some(call_id) = payload.get("call_id").and_then(Value::as_str) {
                state.pending_inputs.remove(call_id);
                state.pending_approvals.remove(call_id);
            }
        }
        _ => {}
    }
}

#[derive(Debug, Clone, Default)]
struct CodexTranscriptState {
    id: Option<String>,
    cwd: Option<String>,
    created_at: i64,
    title: Option<String>,
    origin: String,
    lifecycle: CodexSessionState,
}

impl CodexTranscriptState {
    fn apply(&mut self, value: &Value) {
        update_codex_session_state(value, &mut self.lifecycle);
        let timestamp = timestamp_millis(value.get("timestamp").and_then(Value::as_str));
        if value.get("type").and_then(Value::as_str) == Some("session_meta") {
            let Some(payload) = value.get("payload") else {
                return;
            };
            self.id = payload
                .get("id")
                .or_else(|| payload.get("session_id"))
                .and_then(Value::as_str)
                .map(str::to_string);
            self.cwd = payload
                .get("cwd")
                .and_then(Value::as_str)
                .map(str::to_string);
            self.created_at =
                timestamp_millis(payload.get("timestamp").and_then(Value::as_str)).max(timestamp);
            let source = payload.get("source").and_then(Value::as_str).unwrap_or("");
            let originator = payload
                .get("originator")
                .and_then(Value::as_str)
                .unwrap_or("");
            self.origin = if source.eq_ignore_ascii_case("cli") {
                "cli".to_string()
            } else if originator.eq_ignore_ascii_case("Codex Desktop") {
                "desktop".to_string()
            } else {
                "unknown".to_string()
            };
        } else if self.title.is_none()
            && value.get("type").and_then(Value::as_str) == Some("response_item")
            && value.pointer("/payload/role").and_then(Value::as_str) == Some("user")
        {
            self.title = value
                .pointer("/payload/content")
                .and_then(content_text)
                .map(|text| concise_title(&text, "Codex session"));
        }
    }
}

#[derive(Debug, Clone)]
struct CodexTranscriptCacheEntry {
    file_len: u64,
    modified_at: i64,
    created_at: i64,
    prefix_len: usize,
    prefix_hash: u64,
    complete_len: u64,
    state: CodexTranscriptState,
}

#[derive(Debug, Default)]
struct CodexDiscoveryCache {
    transcripts: HashMap<PathBuf, CodexTranscriptCacheEntry>,
    #[cfg(test)]
    full_reads: usize,
    #[cfg(test)]
    incremental_reads: usize,
}

fn file_prefix_hash(path: &Path, prefix_len: usize) -> Option<u64> {
    let mut file = fs::File::open(path).ok()?;
    let mut prefix = [0_u8; 4096];
    let read = file.read(&mut prefix[..prefix_len.min(4096)]).ok()?;
    let mut hasher = DefaultHasher::new();
    prefix[..read].hash(&mut hasher);
    Some(hasher.finish())
}

fn read_complete_codex_lines<R: BufRead>(
    reader: &mut R,
    state: &mut CodexTranscriptState,
    start: u64,
) -> u64 {
    let mut complete_len = start;
    loop {
        let mut line = String::new();
        let Ok(bytes_read) = reader.read_line(&mut line) else {
            break;
        };
        if bytes_read == 0 {
            break;
        }
        let parsed = serde_json::from_str::<Value>(&line);
        if !line.ends_with('\n') && parsed.is_err() {
            break;
        }
        complete_len = complete_len.saturating_add(bytes_read as u64);
        if let Ok(value) = parsed {
            state.apply(&value);
        }
    }
    complete_len
}

fn read_codex_transcript_state_cached(
    path: &Path,
    cache: &mut CodexDiscoveryCache,
) -> Option<CodexTranscriptState> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => {
            cache.transcripts.remove(path);
            return None;
        }
    };
    let file_len = metadata.len();
    let modified_at = file_millis(path);
    let created_at = file_created_millis(&metadata);
    let prefix_len = cache
        .transcripts
        .get(path)
        .map(|entry| entry.prefix_len)
        .unwrap_or_else(|| file_len.min(4096) as usize);
    let prefix_hash = file_prefix_hash(path, prefix_len)?;
    if let Some(entry) = cache.transcripts.get(path) {
        if entry.file_len == file_len
            && entry.modified_at == modified_at
            && entry.created_at == created_at
            && entry.prefix_hash == prefix_hash
        {
            return Some(entry.state.clone());
        }
    }
    let can_append = cache.transcripts.get(path).is_some_and(|entry| {
        file_len > entry.file_len
            && prefix_hash == entry.prefix_hash
            && (created_at == 0 || entry.created_at == 0 || created_at == entry.created_at)
    });
    let (mut state, complete_len) = if can_append {
        let entry = cache.transcripts.get(path)?;
        let mut state = entry.state.clone();
        let mut file = fs::File::open(path).ok()?;
        file.seek(SeekFrom::Start(entry.complete_len)).ok()?;
        let mut reader = BufReader::new(file);
        let complete_len = read_complete_codex_lines(&mut reader, &mut state, entry.complete_len);
        #[cfg(test)]
        {
            cache.incremental_reads += 1;
        }
        (state, complete_len)
    } else {
        let mut state = CodexTranscriptState {
            origin: "unknown".to_string(),
            ..CodexTranscriptState::default()
        };
        let file = fs::File::open(path).ok()?;
        let mut reader = BufReader::new(file);
        let complete_len = read_complete_codex_lines(&mut reader, &mut state, 0);
        #[cfg(test)]
        {
            cache.full_reads += 1;
        }
        (state, complete_len)
    };
    if state.origin.is_empty() {
        state.origin = "unknown".to_string();
    }
    cache.transcripts.insert(
        path.to_path_buf(),
        CodexTranscriptCacheEntry {
            file_len,
            modified_at,
            created_at,
            prefix_len,
            prefix_hash,
            complete_len,
            state: state.clone(),
        },
    );
    Some(state)
}

#[cfg(test)]
fn codex_session_state(path: &Path) -> CodexSessionState {
    let Ok(file) = fs::File::open(path) else {
        return CodexSessionState::default();
    };
    let mut state = CodexSessionState::default();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        update_codex_session_state(&value, &mut state);
    }
    if state.completed_at == Some(0) {
        state.completed_at = match file_millis(path) {
            0 => None,
            value => Some(value),
        };
    }
    state
}

#[cfg(test)]
fn read_codex_transcript(path: &Path) -> Option<AiSession> {
    let file = fs::File::open(path).ok()?;
    let mut id = None;
    let mut cwd = None;
    let mut created_at = 0;
    let mut title = None;
    let mut origin = "unknown".to_string();
    let mut session_state = CodexSessionState::default();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        update_codex_session_state(&value, &mut session_state);
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
            let source = payload.get("source").and_then(Value::as_str).unwrap_or("");
            let originator = payload
                .get("originator")
                .and_then(Value::as_str)
                .unwrap_or("");
            origin = if source.eq_ignore_ascii_case("cli") {
                "cli".to_string()
            } else if originator.eq_ignore_ascii_case("Codex Desktop") {
                "desktop".to_string()
            } else {
                "unknown".to_string()
            };
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
    if session_state.completed_at == Some(0) {
        session_state.completed_at = match file_millis(path) {
            0 => None,
            value => Some(value),
        };
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
        origin,
        waiting_for_input: session_state.waiting_for_input(),
        running: session_state.running,
        completed_at: session_state.completed_at,
        archived_at: None,
        archive_scope: None,
        open_targets: open_targets("codex"),
        children: Vec::new(),
    })
}

fn discover_codex(since: i64, cache: &mut CodexDiscoveryCache) -> Result<Vec<AiSession>, String> {
    let home =
        codex_home().ok_or_else(|| "Could not determine the Codex data directory.".to_string())?;
    if let Some(database) = codex_database(&home) {
        if let Ok(sessions) = read_codex_database(&database, since, cache) {
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
    let selected = files.into_iter().collect::<HashSet<_>>();
    cache.transcripts.retain(|path, _| selected.contains(path));
    Ok(selected
        .iter()
        .filter_map(|path| {
            let state = read_codex_transcript_state_cached(path, cache)?;
            let mut lifecycle = state.lifecycle;
            if lifecycle.completed_at == Some(0) {
                lifecycle.completed_at = match file_millis(path) {
                    0 => None,
                    value => Some(value),
                };
            }
            Some(AiSession {
                id: state.id?,
                provider: "codex".to_string(),
                title: state.title.unwrap_or_else(|| "Codex session".to_string()),
                cwd: state.cwd,
                created_at: state.created_at,
                updated_at: file_millis(path).max(state.created_at),
                parent_id: None,
                kind: "session".to_string(),
                origin: state.origin,
                waiting_for_input: lifecycle.waiting_for_input(),
                running: lifecycle.running,
                completed_at: lifecycle.completed_at,
                archived_at: None,
                archive_scope: None,
                open_targets: open_targets("codex"),
                children: Vec::new(),
            })
        })
        .collect())
}

#[derive(Debug, Clone, Default)]
struct ClaudeTranscriptState {
    id: Option<String>,
    cwd: Option<String>,
    created_at: i64,
    updated_at: i64,
    title: Option<String>,
    first_prompt: Option<String>,
    origin: String,
    pending_inputs: HashSet<String>,
    running: bool,
    completed_at: Option<i64>,
}

fn claude_user_event_starts_turn(value: &Value) -> bool {
    if value.get("type").and_then(Value::as_str) != Some("user") {
        return false;
    }
    let Some(content) = value.pointer("/message/content").and_then(Value::as_str) else {
        return true;
    };
    let content = content.trim_start();
    ![
        "<local-command-caveat>",
        "<command-name>",
        "<local-command-stdout>",
    ]
    .iter()
    .any(|prefix| content.starts_with(prefix))
}

impl ClaudeTranscriptState {
    fn apply(&mut self, value: &Value) {
        self.id = self.id.take().or_else(|| {
            value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        self.cwd = self
            .cwd
            .take()
            .or_else(|| value.get("cwd").and_then(Value::as_str).map(str::to_string));
        let timestamp = timestamp_millis(value.get("timestamp").and_then(Value::as_str));
        if timestamp > 0 {
            self.created_at = if self.created_at == 0 {
                timestamp
            } else {
                self.created_at.min(timestamp)
            };
            self.updated_at = self.updated_at.max(timestamp);
        }
        if value.get("type").and_then(Value::as_str) == Some("ai-title") {
            self.title = value
                .get("aiTitle")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if self.origin == "unknown" {
            self.origin = match value.get("entrypoint").and_then(Value::as_str) {
                Some("cli") => "cli".to_string(),
                Some("claude-desktop") => "desktop".to_string(),
                _ => std::mem::take(&mut self.origin),
            };
            if self.origin.is_empty() {
                self.origin = "unknown".to_string();
            }
        }
        let is_user = value.get("type").and_then(Value::as_str) == Some("user");
        let is_interruption = is_user
            && value
                .pointer("/message/content")
                .and_then(content_text)
                .is_some_and(|text| text.trim().starts_with("[Request interrupted by user"));
        let starts_turn = !is_interruption && claude_user_event_starts_turn(value);
        if self.first_prompt.is_none() && starts_turn {
            self.first_prompt = value
                .pointer("/message/content")
                .and_then(content_text)
                .map(|text| concise_title(&text, "Claude session"));
        }
        if value.get("type").and_then(Value::as_str) == Some("assistant") {
            for item in value
                .pointer("/message/content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if item.get("type").and_then(Value::as_str) == Some("tool_use")
                    && item.get("name").and_then(Value::as_str) == Some("AskUserQuestion")
                {
                    if let Some(id) = item.get("id").and_then(Value::as_str) {
                        self.pending_inputs.insert(id.to_string());
                    }
                }
            }
            if matches!(
                value
                    .pointer("/message/stop_reason")
                    .and_then(Value::as_str),
                Some("end_turn" | "stop_sequence" | "max_tokens" | "refusal")
            ) {
                self.running = false;
                self.completed_at = Some(timestamp);
            }
        } else if is_interruption {
            self.running = false;
            self.completed_at = None;
            self.pending_inputs.clear();
        } else if starts_turn {
            self.running = true;
            self.completed_at = None;
            for item in value
                .pointer("/message/content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                if item.get("type").and_then(Value::as_str) == Some("tool_result") {
                    if let Some(id) = item.get("tool_use_id").and_then(Value::as_str) {
                        self.pending_inputs.remove(id);
                    }
                }
            }
        }
    }
}

#[derive(Debug, Clone)]
struct ClaudeTranscriptCacheEntry {
    file_len: u64,
    modified_at: i64,
    created_at: i64,
    prefix_len: usize,
    prefix_hash: u64,
    complete_len: u64,
    state: ClaudeTranscriptState,
    session: AiSession,
}

#[derive(Debug, Default)]
struct ClaudeDiscoveryCache {
    transcripts: HashMap<PathBuf, ClaudeTranscriptCacheEntry>,
    #[cfg(test)]
    full_reads: usize,
    #[cfg(test)]
    incremental_reads: usize,
}

fn claude_path_context(path: &Path, projects_root: &Path) -> Option<(Option<String>, bool)> {
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
    Some((parent_id, is_subagent))
}

fn initial_claude_transcript_state(
    path: &Path,
    projects_root: &Path,
) -> Option<ClaudeTranscriptState> {
    let (_, is_subagent) = claude_path_context(path, projects_root)?;
    Some(ClaudeTranscriptState {
        id: if is_subagent {
            path.file_stem()
                .map(|value| value.to_string_lossy().into_owned())
        } else {
            None
        },
        origin: "unknown".to_string(),
        ..ClaudeTranscriptState::default()
    })
}

fn read_complete_claude_lines<R: BufRead>(
    reader: &mut R,
    state: &mut ClaudeTranscriptState,
    start: u64,
) -> u64 {
    let mut complete_len = start;
    loop {
        let mut line = String::new();
        let Ok(bytes_read) = reader.read_line(&mut line) else {
            break;
        };
        if bytes_read == 0 {
            break;
        }
        let parsed = serde_json::from_str::<Value>(&line);
        if !line.ends_with('\n') && parsed.is_err() {
            break;
        }
        complete_len = complete_len.saturating_add(bytes_read as u64);
        if let Ok(value) = parsed {
            state.apply(&value);
        }
    }
    complete_len
}

fn claude_session_from_state(
    path: &Path,
    projects_root: &Path,
    state: &ClaudeTranscriptState,
) -> Option<AiSession> {
    let (parent_id, is_subagent) = claude_path_context(path, projects_root)?;
    let fallback = if is_subagent {
        "Claude subagent"
    } else {
        "Claude session"
    };
    let completed_at = if state.completed_at == Some(0) {
        match file_millis(path) {
            0 => None,
            value => Some(value),
        }
    } else {
        state.completed_at
    };
    let updated_at = if state.updated_at == 0 {
        file_millis(path)
    } else {
        state.updated_at
    };
    Some(AiSession {
        id: state.id.clone()?,
        provider: "claude".to_string(),
        title: state
            .title
            .clone()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| state.first_prompt.clone())
            .unwrap_or_else(|| fallback.to_string()),
        cwd: state.cwd.clone(),
        created_at: state.created_at,
        updated_at,
        parent_id,
        kind: if is_subagent { "subagent" } else { "session" }.to_string(),
        origin: state.origin.clone(),
        waiting_for_input: !state.pending_inputs.is_empty(),
        running: state.running,
        completed_at,
        archived_at: None,
        archive_scope: None,
        open_targets: if is_subagent {
            Vec::new()
        } else {
            open_targets("claude")
        },
        children: Vec::new(),
    })
}

fn read_claude_transcript_cached(
    path: &Path,
    projects_root: &Path,
    cache: &mut ClaudeDiscoveryCache,
) -> Option<AiSession> {
    let metadata = fs::metadata(path).ok()?;
    let file_len = metadata.len();
    let modified_at = file_millis(path);
    let created_at = file_created_millis(&metadata);
    let prefix_len = cache
        .transcripts
        .get(path)
        .map(|entry| entry.prefix_len)
        .unwrap_or_else(|| file_len.min(4096) as usize);
    let prefix_hash = file_prefix_hash(path, prefix_len)?;
    if let Some(entry) = cache.transcripts.get(path) {
        if entry.file_len == file_len
            && entry.modified_at == modified_at
            && entry.created_at == created_at
            && entry.prefix_hash == prefix_hash
        {
            return Some(entry.session.clone());
        }
    }

    let can_append = cache.transcripts.get(path).is_some_and(|entry| {
        file_len > entry.file_len
            && prefix_hash == entry.prefix_hash
            && (created_at == 0 || entry.created_at == 0 || created_at == entry.created_at)
    });
    let (mut state, complete_len) = if can_append {
        let entry = cache.transcripts.get(path)?;
        let mut state = entry.state.clone();
        let mut file = fs::File::open(path).ok()?;
        file.seek(SeekFrom::Start(entry.complete_len)).ok()?;
        let mut reader = BufReader::new(file);
        let complete_len = read_complete_claude_lines(&mut reader, &mut state, entry.complete_len);
        #[cfg(test)]
        {
            cache.incremental_reads += 1;
        }
        (state, complete_len)
    } else {
        let mut state = initial_claude_transcript_state(path, projects_root)?;
        let file = fs::File::open(path).ok()?;
        let mut reader = BufReader::new(file);
        let complete_len = read_complete_claude_lines(&mut reader, &mut state, 0);
        #[cfg(test)]
        {
            cache.full_reads += 1;
        }
        (state, complete_len)
    };
    if state.origin.is_empty() {
        state.origin = "unknown".to_string();
    }
    let session = claude_session_from_state(path, projects_root, &state)?;
    cache.transcripts.insert(
        path.to_path_buf(),
        ClaudeTranscriptCacheEntry {
            file_len,
            modified_at,
            created_at,
            prefix_len,
            prefix_hash,
            complete_len,
            state,
            session: session.clone(),
        },
    );
    Some(session)
}

#[cfg(test)]
fn read_claude_transcript(path: &Path, projects_root: &Path) -> Option<AiSession> {
    read_claude_transcript_cached(path, projects_root, &mut ClaudeDiscoveryCache::default())
}

fn archived_claude_session_ids(desktop_sessions_root: Option<&Path>) -> HashSet<String> {
    let Some(root) = desktop_sessions_root.filter(|path| path.is_dir()) else {
        return HashSet::new();
    };
    let mut markers = Vec::new();
    collect_files(
        root,
        &|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .and_then(|value| value.strip_prefix("deleted_"))
                .is_some_and(valid_session_id)
        },
        &mut markers,
    );
    markers
        .iter()
        .filter_map(|path| path.file_name()?.to_str()?.strip_prefix("deleted_"))
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
fn discover_claude_from_roots(
    projects_root: &Path,
    desktop_sessions_root: Option<&Path>,
) -> Vec<AiSession> {
    discover_claude_from_roots_cached(
        projects_root,
        desktop_sessions_root,
        i64::MIN,
        &mut ClaudeDiscoveryCache::default(),
    )
}

fn claude_parent_transcript_path(path: &Path, projects_root: &Path) -> Option<PathBuf> {
    let relative = path.strip_prefix(projects_root).ok()?;
    let components = relative.iter().collect::<Vec<_>>();
    let subagent_index = components
        .iter()
        .position(|value| value.to_string_lossy() == "subagents")?;
    let parent_id = components.get(subagent_index.checked_sub(1)?)?;
    let mut parent = projects_root.to_path_buf();
    for component in components.iter().take(subagent_index.saturating_sub(1)) {
        parent.push(component);
    }
    parent.push(format!("{}.jsonl", parent_id.to_string_lossy()));
    Some(parent)
}

fn discover_claude_from_roots_cached(
    projects_root: &Path,
    desktop_sessions_root: Option<&Path>,
    since: i64,
    cache: &mut ClaudeDiscoveryCache,
) -> Vec<AiSession> {
    if !projects_root.is_dir() {
        cache.transcripts.clear();
        return Vec::new();
    }
    let archived_ids = archived_claude_session_ids(desktop_sessions_root);
    let mut files = Vec::new();
    collect_files(
        projects_root,
        &|path| path.extension().is_some_and(|value| value == "jsonl"),
        &mut files,
    );
    let available = files.iter().cloned().collect::<HashSet<_>>();
    let mut selected = files
        .iter()
        .filter(|path| file_millis(path) >= since)
        .cloned()
        .collect::<HashSet<_>>();
    for path in selected.clone() {
        if let Some(parent) = claude_parent_transcript_path(&path, projects_root) {
            if available.contains(&parent) {
                selected.insert(parent);
            }
        }
    }
    cache.transcripts.retain(|path, _| selected.contains(path));
    selected
        .iter()
        .filter_map(|path| read_claude_transcript_cached(path, projects_root, cache))
        .filter(|session| !archived_ids.contains(&session.id))
        .collect()
}

fn discover_claude(since: i64, cache: &mut ClaudeDiscoveryCache) -> Result<Vec<AiSession>, String> {
    let home = claude_home()
        .ok_or_else(|| "Could not determine the Claude data directory.".to_string())?;
    let projects_root = home.join("projects");
    let desktop_sessions_root = claude_desktop_sessions_root();
    Ok(discover_claude_from_roots_cached(
        &projects_root,
        desktop_sessions_root.as_deref(),
        since,
        cache,
    ))
}

fn session_enabled(session: &AiSession, settings: &AiSessionSettings) -> bool {
    match (session.provider.as_str(), session.origin.as_str()) {
        ("codex", "cli") => settings.codex_cli,
        ("codex", "desktop") => settings.codex_desktop,
        ("codex", _) => settings.codex_cli || settings.codex_desktop,
        ("claude", "cli") => settings.claude_cli,
        ("claude", "desktop") => settings.claude_desktop,
        ("claude", _) => settings.claude_cli || settings.claude_desktop,
        _ => false,
    }
}

fn inherit_origins(sessions: &mut [AiSession]) {
    let parent_origins = sessions
        .iter()
        .filter(|session| session.parent_id.is_none())
        .map(|session| (session.id.clone(), session.origin.clone()))
        .collect::<HashMap<_, _>>();
    for session in sessions {
        if session.origin == "unknown" {
            if let Some(origin) = session
                .parent_id
                .as_ref()
                .and_then(|parent_id| parent_origins.get(parent_id))
            {
                session.origin = origin.clone();
            }
        }
    }
}

fn reconcile_claude_live_states(
    sessions: &mut [AiSession],
    live_states: Option<&HashMap<String, ClaudeLiveLifecycle>>,
) {
    let Some(live_states) = live_states else {
        return;
    };
    for session in sessions
        .iter_mut()
        .filter(|session| session.provider == "claude" && session.parent_id.is_none())
    {
        match live_states.get(&session.id) {
            Some(ClaudeLiveLifecycle::Working) => {
                session.running = true;
                session.waiting_for_input = false;
                session.completed_at = None;
            }
            Some(ClaudeLiveLifecycle::NeedsInput) => {
                session.running = false;
                session.waiting_for_input = true;
                session.completed_at = None;
            }
            Some(ClaudeLiveLifecycle::Inactive) | None => {
                session.running = false;
                session.waiting_for_input = false;
            }
            Some(ClaudeLiveLifecycle::Unknown) => {}
        }
    }
}

fn reconcile_child_lifecycle(parent: &AiSession, children: &mut [AiSession]) {
    if parent.provider != "claude" || parent.running || parent.waiting_for_input {
        return;
    }
    for child in children {
        child.running = false;
        child.waiting_for_input = false;
        if child.completed_at.is_none() {
            child.completed_at = parent.completed_at;
        }
    }
}

fn group_and_filter(
    mut sessions: Vec<AiSession>,
    since: i64,
    settings: &AiSessionSettings,
) -> Vec<AiSession> {
    inherit_origins(&mut sessions);
    sessions.retain(|session| session_enabled(session, settings));
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
        let mut session_children = children.remove(&session.id).unwrap_or_default();
        reconcile_child_lifecycle(session, &mut session_children);
        session.children = session_children;
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

fn session_tree_active(session: &AiSession) -> bool {
    session.waiting_for_input || session.running || session.children.iter().any(session_tree_active)
}

fn validate_archivable_session(session: &AiSession) -> Result<(), String> {
    if !matches!(session.provider.as_str(), "codex" | "claude") {
        return Err("Unsupported AI session provider.".to_string());
    }
    fn valid_tree_ids(session: &AiSession) -> bool {
        valid_session_id(&session.id) && session.children.iter().all(valid_tree_ids)
    }
    if !valid_tree_ids(session) {
        return Err("Invalid AI session identifier.".to_string());
    }
    if session.parent_id.is_some() || session.kind != "session" {
        return Err("Only top-level AI sessions can be archived.".to_string());
    }
    if session_tree_active(session) {
        return Err(
            "Running sessions and sessions waiting for input cannot be archived.".to_string(),
        );
    }
    Ok(())
}

fn authoritative_archivable_session(
    snapshot: &AiSessionMonitorSnapshot,
    provider: &str,
    session_id: &str,
) -> Result<AiSession, String> {
    let session = snapshot
        .source_sessions
        .iter()
        .find(|session| session.provider == provider && session.id == session_id)
        .cloned()
        .ok_or_else(|| "AI session was not found in the latest native scan.".to_string())?;
    validate_archivable_session(&session)?;
    Ok(session)
}

fn archive_session_in_db(
    db: &Connection,
    session: &AiSession,
    archived_at: i64,
    archive_scope: &str,
) -> Result<AiSession, String> {
    validate_archivable_session(session)?;
    let mut archived = session.clone();
    archived.archived_at = Some(archived_at);
    archived.archive_scope = Some(archive_scope.to_string());
    let snapshot_json = serde_json::to_string(&archived).map_err(db_error)?;
    db.execute(
        "INSERT INTO ai_session_archives (provider, session_id, snapshot_json, archived_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(provider, session_id) DO UPDATE SET
            snapshot_json = excluded.snapshot_json,
            archived_at = excluded.archived_at",
        params![archived.provider, archived.id, snapshot_json, archived_at],
    )
    .map_err(db_error)?;
    Ok(archived)
}

fn restore_session_in_db(db: &Connection, provider: &str, session_id: &str) -> Result<(), String> {
    if !matches!(provider, "codex" | "claude") {
        return Err("Unsupported AI session provider.".to_string());
    }
    if !valid_session_id(session_id) {
        return Err("Invalid AI session identifier.".to_string());
    }
    db.execute(
        "DELETE FROM ai_session_archives WHERE provider = ?1 AND session_id = ?2",
        params![provider, session_id],
    )
    .map_err(db_error)?;
    Ok(())
}

fn archived_session_scope(
    db: &Connection,
    provider: &str,
    session_id: &str,
) -> Result<Option<String>, String> {
    let snapshot_json = db
        .query_row(
            "SELECT snapshot_json FROM ai_session_archives
             WHERE provider = ?1 AND session_id = ?2",
            params![provider, session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_error)?;
    snapshot_json
        .map(|snapshot| {
            serde_json::from_str::<AiSession>(&snapshot)
                .map(|session| {
                    session
                        .archive_scope
                        .unwrap_or_else(|| "station".to_string())
                })
                .map_err(db_error)
        })
        .transpose()
}

fn run_codex_archive_action(action: &str, session_id: &str) -> Result<(), String> {
    if !matches!(action, "archive" | "unarchive") {
        return Err("Unsupported Codex archive action.".to_string());
    }
    let executable = codex_executable().ok_or_else(|| {
        "Could not find the Codex command. Install Codex CLI or the Codex desktop app and try again."
            .to_string()
    })?;
    let output = Command::new(executable)
        .args([action, session_id])
        .output()
        .map_err(|error| format!("Could not run Codex {action}: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    let suffix = if detail.is_empty() {
        String::new()
    } else {
        format!(": {detail}")
    };
    Err(format!("Codex could not {action} this session{suffix}"))
}

fn archive_session_with_sync(
    db: &Connection,
    session: &AiSession,
    archived_at: i64,
    mut sync_codex: impl FnMut(&str, &str) -> Result<(), String>,
) -> Result<AiSession, String> {
    validate_archivable_session(session)?;
    let scope = if session.provider == "codex" {
        sync_codex("archive", &session.id)?;
        "provider"
    } else {
        "station"
    };
    archive_session_in_db(db, session, archived_at, scope)
}

fn restore_session_with_sync(
    db: &Connection,
    provider: &str,
    session_id: &str,
    mut sync_codex: impl FnMut(&str, &str) -> Result<(), String>,
) -> Result<(), String> {
    if !matches!(provider, "codex" | "claude") {
        return Err("Unsupported AI session provider.".to_string());
    }
    if !valid_session_id(session_id) {
        return Err("Invalid AI session identifier.".to_string());
    }
    if provider == "codex"
        && archived_session_scope(db, provider, session_id)?.as_deref() == Some("provider")
    {
        sync_codex("unarchive", session_id)?;
    }
    restore_session_in_db(db, provider, session_id)
}

fn load_archived_sessions(db: &Connection) -> Result<Vec<AiSession>, String> {
    let mut statement = db
        .prepare(
            "SELECT snapshot_json, archived_at
             FROM ai_session_archives
             ORDER BY archived_at DESC, provider, session_id",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(db_error)?;
    let mut sessions = Vec::new();
    for row in rows {
        let (snapshot_json, archived_at) = row.map_err(db_error)?;
        let mut session = serde_json::from_str::<AiSession>(&snapshot_json).map_err(db_error)?;
        session.archived_at = Some(archived_at);
        if session.archive_scope.is_none() {
            session.archive_scope = Some("station".to_string());
        }
        sessions.push(session);
    }
    Ok(sessions)
}

fn reconcile_archived_sessions(
    db: &Connection,
    mut sessions: Vec<AiSession>,
) -> Result<(Vec<AiSession>, Vec<AiSession>), String> {
    for session in sessions
        .iter()
        .filter(|session| session_tree_active(session))
    {
        db.execute(
            "DELETE FROM ai_session_archives WHERE provider = ?1 AND session_id = ?2",
            params![session.provider, session.id],
        )
        .map_err(db_error)?;
    }
    let archived_sessions = load_archived_sessions(db)?;
    let archived_keys = archived_sessions
        .iter()
        .map(|session| (session.provider.clone(), session.id.clone()))
        .collect::<HashSet<_>>();
    sessions
        .retain(|session| !archived_keys.contains(&(session.provider.clone(), session.id.clone())));
    Ok((sessions, archived_sessions))
}

fn partition_claude_lifecycle_archives(
    sessions: Vec<AiSession>,
    live_states: Option<&HashMap<String, ClaudeLiveLifecycle>>,
) -> (Vec<AiSession>, Vec<AiSession>) {
    let Some(live_states) = live_states else {
        return (sessions, Vec::new());
    };
    let mut active_sessions = Vec::new();
    let mut archived_sessions = Vec::new();
    for mut session in sessions {
        if session.provider == "claude"
            && session.origin == "cli"
            && !live_states.contains_key(&session.id)
        {
            session.archived_at = Some(session.updated_at);
            session.archive_scope = Some("lifecycle".to_string());
            archived_sessions.push(session);
        } else {
            if session.archive_scope.as_deref() == Some("lifecycle") {
                session.archived_at = None;
                session.archive_scope = None;
            }
            active_sessions.push(session);
        }
    }
    (active_sessions, archived_sessions)
}

fn sort_archived_sessions(sessions: &mut [AiSession]) {
    sessions.sort_by(|left, right| {
        right
            .archived_at
            .unwrap_or(0)
            .cmp(&left.archived_at.unwrap_or(0))
            .then_with(|| left.provider.cmp(&right.provider))
            .then_with(|| left.id.cmp(&right.id))
    });
}

fn scan_ai_sessions(
    state: &AppState,
    since: i64,
    settings: AiSessionSettings,
    codex_cache: &mut CodexDiscoveryCache,
    claude_cache: &mut ClaudeDiscoveryCache,
    claude_live_cache: &mut ClaudeLiveStateCache,
) -> Result<AiSessionList, String> {
    let mut sessions = Vec::new();
    let mut warnings = Vec::new();
    let mut providers = Vec::new();
    if settings.codex_cli || settings.codex_desktop {
        providers.push(("codex", discover_codex(since, codex_cache)));
    } else {
        codex_cache.transcripts.clear();
    }
    if settings.claude_cli || settings.claude_desktop {
        providers.push(("claude", discover_claude(since, claude_cache)));
    } else {
        claude_cache.transcripts.clear();
    }
    for (provider, result) in providers {
        match result {
            Ok(mut provider_sessions) => sessions.append(&mut provider_sessions),
            Err(message) => warnings.push(AiSessionProviderWarning {
                provider: provider.to_string(),
                message,
            }),
        }
    }
    let live_states = (settings.claude_cli || settings.claude_desktop)
        .then(|| claude_live_states(claude_live_cache))
        .flatten();
    reconcile_claude_live_states(&mut sessions, live_states.as_ref());
    let sessions = group_and_filter(sessions, since, &settings);
    let db = state.db.lock().map_err(db_error)?;
    let (sessions, mut archived_sessions) = reconcile_archived_sessions(&db, sessions)?;
    let (sessions, mut lifecycle_archives) =
        partition_claude_lifecycle_archives(sessions, live_states.as_ref());
    archived_sessions.append(&mut lifecycle_archives);
    sort_archived_sessions(&mut archived_sessions);
    Ok(AiSessionList {
        sessions,
        archived_sessions,
        warnings,
    })
}

fn scan_ai_session_snapshot(
    app: &tauri::AppHandle,
    settings: AiSessionSettings,
    codex_cache: &mut CodexDiscoveryCache,
    claude_cache: &mut ClaudeDiscoveryCache,
    claude_live_cache: &mut ClaudeLiveStateCache,
) -> Result<AiSessionMonitorSnapshot, String> {
    let requested_at = now_millis();
    let since = requested_at - AI_SESSION_MONITOR_WINDOW_HOURS * 3_600_000;
    let state = app.state::<AppState>();
    let result = scan_ai_sessions(
        state.inner(),
        since,
        settings,
        codex_cache,
        claude_cache,
        claude_live_cache,
    )?;
    let refreshed_at = now_millis();
    let waiting_session_count = waiting_session_count(&result.sessions);
    let waiting_terminal_sessions = waiting_terminal_session_keys(&result.sessions);
    let terminal_state = app.state::<terminal_tabs::TerminalTabsState>();
    let waiting_terminal_tab_ids = terminal_tabs::matching_ai_session_tab_ids(
        terminal_state.inner(),
        &waiting_terminal_sessions,
    );
    let sessions = result
        .sessions
        .iter()
        .map(|session| display_session(session, refreshed_at, settings.done_state_duration_seconds))
        .collect::<Vec<_>>();
    let archived_sessions = result
        .archived_sessions
        .iter()
        .map(|session| display_session(session, refreshed_at, settings.done_state_duration_seconds))
        .collect::<Vec<_>>();
    let revision = display_revision(&sessions, &archived_sessions, &result.warnings);
    Ok(AiSessionMonitorSnapshot {
        display: AiSessionSnapshot {
            sessions,
            archived_sessions,
            warnings: result.warnings,
            revision,
            loaded_at: refreshed_at,
            last_refreshed_at: refreshed_at,
            waiting_session_count,
            waiting_terminal_tab_ids,
        },
        source_sessions: result.sessions,
    })
}

fn publish_snapshot(app: &tauri::AppHandle, snapshot: &AiSessionMonitorSnapshot) {
    if let Err(error) =
        set_ai_session_dock_badge(app.clone(), snapshot.display.waiting_session_count)
    {
        eprintln!("Could not update AI session dock badge: {error}");
    }
    if let Err(error) = app.emit(
        AI_SESSION_MONITOR_UPDATED_EVENT,
        AiSessionMonitorStatus::from(snapshot),
    ) {
        eprintln!("Could not publish AI session monitor update: {error}");
    }
}

fn complete_monitor_attempt(
    runtime: &mut AiSessionMonitorRuntime,
    completed_generation: u64,
    result: Result<AiSessionMonitorSnapshot, String>,
) -> Option<AiSessionMonitorSnapshot> {
    runtime.completed_generation = completed_generation;
    match result {
        Ok(snapshot) => {
            runtime.latest = Some(snapshot.clone());
            runtime.last_error = None;
            Some(snapshot)
        }
        Err(error) => {
            runtime.last_error = Some(error);
            None
        }
    }
}

fn run_monitor(app: tauri::AppHandle, handle: AiSessionMonitorHandle) {
    let mut last_attempt_at: Option<Instant> = None;
    let mut codex_cache = CodexDiscoveryCache::default();
    let mut claude_cache = ClaudeDiscoveryCache::default();
    let mut claude_live_cache = ClaudeLiveStateCache::default();
    loop {
        let (settings, started_generation) = {
            let (lock, wake) = &*handle.shared;
            let mut runtime = match lock.lock() {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!("AI session monitor state is unavailable: {error}");
                    return;
                }
            };
            loop {
                let requested = runtime.requested_generation > runtime.completed_generation;
                let interval = AiSessionMonitorHandle::polling_interval(&runtime);
                let due = last_attempt_at
                    .map(|attempt| attempt.elapsed() >= interval)
                    .unwrap_or(true);
                if requested || due {
                    break (runtime.settings, runtime.requested_generation);
                }
                let remaining = interval.saturating_sub(
                    last_attempt_at
                        .map(|attempt| attempt.elapsed())
                        .unwrap_or_default(),
                );
                let waited = wake.wait_timeout(runtime, remaining);
                match waited {
                    Ok((next_runtime, _)) => runtime = next_runtime,
                    Err(error) => {
                        eprintln!("AI session monitor wait failed: {error}");
                        return;
                    }
                }
            }
        };

        let result = scan_ai_session_snapshot(
            &app,
            settings,
            &mut codex_cache,
            &mut claude_cache,
            &mut claude_live_cache,
        );
        last_attempt_at = Some(Instant::now());
        {
            let (lock, wake) = &*handle.shared;
            let mut runtime = match lock.lock() {
                Ok(runtime) => runtime,
                Err(error) => {
                    eprintln!("AI session monitor state is unavailable: {error}");
                    return;
                }
            };
            let published = if runtime.settings == settings {
                if let Err(error) = &result {
                    eprintln!("Could not refresh AI sessions in the background: {error}");
                }
                let completed_generation = runtime.requested_generation;
                complete_monitor_attempt(&mut runtime, completed_generation, result)
            } else {
                runtime.completed_generation = started_generation;
                None
            };
            wake.notify_all();
            drop(runtime);
            if let Some(snapshot) = published {
                publish_snapshot(&app, &snapshot);
            }
        }
    }
}

pub fn start_monitor(app: tauri::AppHandle, settings: AiSessionSettings) -> AiSessionMonitorHandle {
    let window_foreground = app
        .get_window("main")
        .map(|window| {
            window.is_visible().unwrap_or(false)
                && !window.is_minimized().unwrap_or(false)
                && window.is_focused().unwrap_or(false)
        })
        .unwrap_or(false);
    let handle = AiSessionMonitorHandle {
        shared: Arc::new((
            Mutex::new(AiSessionMonitorRuntime {
                settings,
                view_active: false,
                window_foreground,
                requested_generation: 0,
                completed_generation: 0,
                latest: None,
                last_error: None,
            }),
            Condvar::new(),
        )),
    };
    let worker_handle = handle.clone();
    thread::Builder::new()
        .name("ai-session-monitor".to_string())
        .spawn(move || run_monitor(app, worker_handle))
        .expect("could not start AI session monitor");
    handle
}

fn main_window_is_foreground(window: &tauri::Window) -> bool {
    window.is_visible().unwrap_or(false)
        && !window.is_minimized().unwrap_or(false)
        && window.is_focused().unwrap_or(false)
}

pub fn setup_monitor_window_events(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "Could not find the main application window.".to_string())?;
    let monitor = app.state::<AiSessionMonitorHandle>().inner().clone();
    monitor.update_window_foreground(main_window_is_foreground(&window));
    let latest = monitor
        .shared
        .0
        .lock()
        .ok()
        .and_then(|runtime| runtime.latest.clone());
    if let Some(snapshot) = latest {
        publish_snapshot(app, &snapshot);
    }
    let observed_window = window.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Focused(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
                | WindowEvent::Destroyed
        ) {
            monitor.update_window_foreground(
                !matches!(event, WindowEvent::Destroyed)
                    && main_window_is_foreground(&observed_window),
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn latest_ai_sessions(
    monitor: tauri::State<'_, AiSessionMonitorHandle>,
) -> Result<AiSessionSnapshot, String> {
    let monitor = monitor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        monitor.latest_or_refresh().map(|snapshot| snapshot.display)
    })
    .await
    .map_err(db_error)?
}

#[tauri::command]
pub async fn latest_ai_session_status(
    monitor: tauri::State<'_, AiSessionMonitorHandle>,
) -> Result<AiSessionMonitorStatus, String> {
    let monitor = monitor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || monitor.latest_status_or_refresh())
        .await
        .map_err(db_error)?
}

#[tauri::command]
pub async fn refresh_ai_sessions(
    monitor: tauri::State<'_, AiSessionMonitorHandle>,
) -> Result<AiSessionSnapshot, String> {
    let monitor = monitor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        monitor.request_refresh().map(|snapshot| snapshot.display)
    })
    .await
    .map_err(db_error)?
}

#[tauri::command]
pub fn set_ai_session_monitor_view_active(
    monitor: tauri::State<'_, AiSessionMonitorHandle>,
    active: bool,
) {
    monitor.update_view_active(active);
}

#[tauri::command]
pub async fn archive_ai_session(
    state: tauri::State<'_, AppState>,
    monitor: tauri::State<'_, AiSessionMonitorHandle>,
    provider: String,
    session_id: String,
) -> Result<(), String> {
    if !matches!(provider.as_str(), "codex" | "claude") {
        return Err("Unsupported AI session provider.".to_string());
    }
    if !valid_session_id(&session_id) {
        return Err("Invalid AI session identifier.".to_string());
    }
    let monitor = monitor.inner().clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || monitor.request_refresh())
        .await
        .map_err(db_error)??;
    let session = authoritative_archivable_session(&snapshot, &provider, &session_id)?;
    let db = state.db.lock().map_err(db_error)?;
    archive_session_with_sync(&db, &session, now_millis(), run_codex_archive_action)?;
    Ok(())
}

#[tauri::command]
pub fn restore_ai_session(
    state: tauri::State<'_, AppState>,
    provider: String,
    session_id: String,
) -> Result<(), String> {
    let db = state.db.lock().map_err(db_error)?;
    restore_session_with_sync(&db, &provider, &session_id, run_codex_archive_action)
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
            origin: "unknown".to_string(),
            waiting_for_input: false,
            running: false,
            completed_at: None,
            archived_at: None,
            archive_scope: None,
            open_targets: Vec::new(),
            children: Vec::new(),
        }
    }

    fn snapshot(sessions: Vec<AiSession>, refreshed_at: i64) -> AiSessionMonitorSnapshot {
        let display_sessions = sessions
            .iter()
            .map(|session| display_session(session, refreshed_at, 10_800))
            .collect::<Vec<_>>();
        let revision = display_revision(&display_sessions, &[], &[]);
        AiSessionMonitorSnapshot {
            display: AiSessionSnapshot {
                waiting_session_count: waiting_session_count(&sessions),
                waiting_terminal_tab_ids: vec![],
                sessions: display_sessions,
                archived_sessions: vec![],
                warnings: vec![],
                revision,
                loaded_at: refreshed_at,
                last_refreshed_at: refreshed_at,
            },
            source_sessions: sessions,
        }
    }

    fn monitor_runtime(settings: AiSessionSettings) -> AiSessionMonitorRuntime {
        AiSessionMonitorRuntime {
            settings,
            view_active: false,
            window_foreground: false,
            requested_generation: 0,
            completed_generation: 0,
            latest: None,
            last_error: None,
        }
    }

    fn monitor_handle(settings: AiSessionSettings) -> AiSessionMonitorHandle {
        AiSessionMonitorHandle {
            shared: Arc::new((Mutex::new(monitor_runtime(settings)), Condvar::new())),
        }
    }

    #[test]
    fn selects_native_foreground_and_background_refresh_intervals() {
        let settings = AiSessionSettings {
            foreground_refresh_interval_seconds: 15,
            background_refresh_interval_seconds: 60,
            ..AiSessionSettings::default()
        };
        assert_eq!(ai_session_polling_interval_seconds(&settings, true), 15);
        assert_eq!(ai_session_polling_interval_seconds(&settings, false), 60);

        let foreground_off = AiSessionSettings {
            foreground_refresh_interval_seconds: 0,
            ..settings
        };
        assert_eq!(
            ai_session_polling_interval_seconds(&foreground_off, true),
            60
        );
    }

    #[test]
    fn parses_supported_claude_version_and_live_session_states() {
        assert_eq!(
            parse_claude_version("2.1.226 (Claude Code)"),
            Some((2, 1, 226))
        );
        assert_eq!(
            parse_claude_version("Claude Code 2.1.175"),
            Some((2, 1, 175))
        );
        assert_eq!(parse_claude_version("unknown"), None);

        let states = parse_claude_live_states(
            br#"[
                {"sessionId":"working","state":"working"},
                {"sessionId":"waiting","state":"needs_input","waitingFor":"permission prompt"},
                {"sessionId":"idle","state":"idle"},
                {"sessionId":"completed","state":"completed"},
                {"sessionId":"legacy-waiting","status":"waiting","waitingFor":"input needed"},
                {"sessionId":"waiting-for","waitingFor":"MCP input"},
                {"sessionId":"unknown","state":"future_state"},
                {"state":"working"},
                {"sessionId":"duplicate","state":"idle"},
                {"sessionId":"duplicate","state":"working"}
            ]"#,
        )
        .unwrap();
        assert_eq!(states.get("working"), Some(&ClaudeLiveLifecycle::Working));
        assert_eq!(
            states.get("waiting"),
            Some(&ClaudeLiveLifecycle::NeedsInput)
        );
        assert_eq!(states.get("idle"), Some(&ClaudeLiveLifecycle::Inactive));
        assert_eq!(
            states.get("completed"),
            Some(&ClaudeLiveLifecycle::Inactive)
        );
        assert_eq!(
            states.get("legacy-waiting"),
            Some(&ClaudeLiveLifecycle::NeedsInput)
        );
        assert_eq!(
            states.get("waiting-for"),
            Some(&ClaudeLiveLifecycle::NeedsInput)
        );
        assert_eq!(states.get("unknown"), Some(&ClaudeLiveLifecycle::Unknown));
        assert_eq!(states.get("duplicate"), Some(&ClaudeLiveLifecycle::Working));
        assert_eq!(states.len(), 8);
        assert!(parse_claude_live_states(b"not json").is_none());
        assert!(parse_claude_live_states(br#"{}"#).is_none());
    }

    #[test]
    fn uses_claude_agents_only_when_supported_and_preserves_fallback_on_failures() {
        let executable = Some(PathBuf::from("/test/claude"));
        let output = |success: bool, value: &str| CommandResult {
            success,
            stdout: value.as_bytes().to_vec(),
        };

        let mut cache = ClaudeLiveStateCache::default();
        let mut calls = Vec::new();
        let states = claude_live_states_with(&mut cache, executable.clone(), |_, arguments, _| {
            calls.push(arguments.join(" "));
            match arguments {
                ["--version"] => Some(output(true, "2.1.226 (Claude Code)")),
                ["agents", "--all", "--json"] => Some(output(true, "[]")),
                _ => None,
            }
        })
        .unwrap();
        assert!(states.is_empty());
        assert_eq!(calls, ["--version", "agents --all --json"]);

        let mut calls = Vec::new();
        let states = claude_live_states_with(&mut cache, executable.clone(), |_, arguments, _| {
            calls.push(arguments.join(" "));
            Some(output(true, "[]"))
        })
        .unwrap();
        assert!(states.is_empty());
        assert_eq!(calls, ["agents --all --json"]);

        for (version, agents) in [
            (Some(output(true, "2.1.174")), Some(output(true, "[]"))),
            (None, Some(output(true, "[]"))),
            (Some(output(false, "2.1.226")), Some(output(true, "[]"))),
            (Some(output(true, "invalid")), Some(output(true, "[]"))),
            (Some(output(true, "2.1.226")), Some(output(false, "[]"))),
            (Some(output(true, "2.1.226")), Some(output(true, "invalid"))),
        ] {
            let mut cache = ClaudeLiveStateCache::default();
            let result =
                claude_live_states_with(&mut cache, executable.clone(), |_, arguments, _| {
                    match arguments {
                        ["--version"] => version.clone(),
                        ["agents", "--all", "--json"] => agents.clone(),
                        _ => None,
                    }
                });
            assert!(result.is_none());
        }
        assert!(claude_live_states_with(
            &mut ClaudeLiveStateCache::default(),
            None,
            |_, _, _| unreachable!(),
        )
        .is_none());
    }

    #[test]
    fn reconciles_transcript_activity_with_authoritative_claude_states() {
        let mut working = session("working", 100, None);
        working.provider = "claude".to_string();
        working.completed_at = Some(90);
        let mut waiting = session("waiting", 100, None);
        waiting.provider = "claude".to_string();
        waiting.running = true;
        let mut inactive = session("inactive", 100, None);
        inactive.provider = "claude".to_string();
        inactive.running = true;
        inactive.waiting_for_input = true;
        inactive.completed_at = Some(90);
        let mut absent = session("absent", 100, None);
        absent.provider = "claude".to_string();
        absent.running = true;
        let mut unknown = session("unknown", 100, None);
        unknown.provider = "claude".to_string();
        unknown.running = true;
        let mut codex = session("codex", 100, None);
        codex.running = true;
        let mut sessions = vec![working, waiting, inactive, absent, unknown, codex];
        let states = HashMap::from([
            ("working".to_string(), ClaudeLiveLifecycle::Working),
            ("waiting".to_string(), ClaudeLiveLifecycle::NeedsInput),
            ("inactive".to_string(), ClaudeLiveLifecycle::Inactive),
            ("unknown".to_string(), ClaudeLiveLifecycle::Unknown),
        ]);

        reconcile_claude_live_states(&mut sessions, Some(&states));

        assert!(sessions[0].running);
        assert!(!sessions[0].waiting_for_input);
        assert_eq!(sessions[0].completed_at, None);
        assert!(!sessions[1].running);
        assert!(sessions[1].waiting_for_input);
        assert_eq!(sessions[1].completed_at, None);
        assert!(!sessions[2].running);
        assert!(!sessions[2].waiting_for_input);
        assert_eq!(sessions[2].completed_at, Some(90));
        assert!(!sessions[3].running);
        assert!(!sessions[3].waiting_for_input);
        assert!(sessions[4].running);
        assert!(sessions[5].running);
    }

    #[test]
    fn successful_empty_claude_roster_clears_stale_parent_and_child_activity() {
        let mut parent = session("parent", 200, None);
        parent.provider = "claude".to_string();
        parent.running = true;
        let mut child = session("child", 150, Some("parent"));
        child.provider = "claude".to_string();
        child.running = true;
        child.waiting_for_input = true;
        let mut sessions = vec![parent, child];

        reconcile_claude_live_states(&mut sessions, Some(&HashMap::new()));
        let grouped = group_and_filter(sessions, 0, &AiSessionSettings::default());

        assert!(!grouped[0].running);
        assert!(!grouped[0].children[0].running);
        assert!(!grouped[0].children[0].waiting_for_input);
    }

    #[test]
    fn unavailable_claude_roster_preserves_transcript_activity() {
        let mut session = session("fallback", 100, None);
        session.provider = "claude".to_string();
        session.running = true;
        session.waiting_for_input = true;

        reconcile_claude_live_states(std::slice::from_mut(&mut session), None);

        assert!(session.running);
        assert!(session.waiting_for_input);
    }

    #[test]
    fn partitions_only_absent_claude_cli_sessions_into_lifecycle_archives() {
        let mut present = session("present", 500, None);
        present.provider = "claude".to_string();
        present.origin = "cli".to_string();
        present.completed_at = Some(450);
        let mut absent = session("absent", 400, None);
        absent.provider = "claude".to_string();
        absent.origin = "cli".to_string();
        absent.children.push(session("child", 390, Some("absent")));
        let mut desktop = session("desktop", 300, None);
        desktop.provider = "claude".to_string();
        desktop.origin = "desktop".to_string();
        let mut unknown = session("unknown", 200, None);
        unknown.provider = "claude".to_string();
        let codex = session("codex", 100, None);
        let states = HashMap::from([("present".to_string(), ClaudeLiveLifecycle::Inactive)]);

        let (active, archived) = partition_claude_lifecycle_archives(
            vec![present, absent, desktop, unknown, codex],
            Some(&states),
        );

        assert_eq!(
            active
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            ["present", "desktop", "unknown", "codex"]
        );
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].id, "absent");
        assert_eq!(archived[0].archived_at, Some(400));
        assert_eq!(archived[0].archive_scope.as_deref(), Some("lifecycle"));
        assert_eq!(archived[0].children[0].id, "child");

        let (active_again, archived_again) = partition_claude_lifecycle_archives(
            archived,
            Some(&HashMap::from([(
                "absent".to_string(),
                ClaudeLiveLifecycle::Working,
            )])),
        );
        assert_eq!(active_again.len(), 1);
        assert!(archived_again.is_empty());
        assert_eq!(active_again[0].archived_at, None);
        assert_eq!(active_again[0].archive_scope, None);
    }

    #[test]
    fn unavailable_roster_does_not_create_lifecycle_archives() {
        let mut claude = session("fallback", 100, None);
        claude.provider = "claude".to_string();
        claude.origin = "cli".to_string();

        let (active, archived) = partition_claude_lifecycle_archives(vec![claude], None);

        assert_eq!(active.len(), 1);
        assert!(archived.is_empty());
    }

    #[test]
    fn sorts_manual_and_lifecycle_archives_deterministically() {
        let mut older = session("older", 50, None);
        older.archived_at = Some(100);
        older.archive_scope = Some("station".to_string());
        let mut claude_b = session("b", 200, None);
        claude_b.provider = "claude".to_string();
        claude_b.archived_at = Some(200);
        claude_b.archive_scope = Some("lifecycle".to_string());
        let mut claude_a = claude_b.clone();
        claude_a.id = "a".to_string();
        let mut sessions = vec![older, claude_b, claude_a];

        sort_archived_sessions(&mut sessions);

        assert_eq!(
            sessions
                .iter()
                .map(|session| session.id.as_str())
                .collect::<Vec<_>>(),
            ["a", "b", "older"]
        );
    }

    #[test]
    fn counts_waiting_top_level_session_trees_for_badges() {
        let mut waiting_parent = session("parent", 100, None);
        waiting_parent.children.push(AiSession {
            waiting_for_input: true,
            ..session("child", 100, Some("parent"))
        });
        let idle = session("idle", 100, None);
        assert_eq!(waiting_session_count(&[waiting_parent, idle]), 1);
        assert_eq!(waiting_session_count(&[]), 0);
    }

    #[test]
    fn derives_display_state_in_rust_with_expected_precedence_and_done_boundary() {
        let now = 20_000_000;
        let mut candidate = session("state", now, None);
        candidate.completed_at = Some(now - 60_000);
        assert_eq!(ai_session_display_state(&candidate, now, 60), "done");
        candidate.completed_at = Some(now - 60_001);
        assert_eq!(ai_session_display_state(&candidate, now, 60), "idle");
        candidate.running = true;
        assert_eq!(ai_session_display_state(&candidate, now, 60), "running");
        candidate.waiting_for_input = true;
        assert_eq!(ai_session_display_state(&candidate, now, 60), "waiting");
    }

    #[test]
    fn display_dto_excludes_internal_lifecycle_and_transcript_fields() {
        let mut source = session("display", 100, None);
        source.running = true;
        let serialized = serde_json::to_value(display_session(&source, 100, 10_800)).unwrap();
        let object = serialized.as_object().unwrap();
        assert_eq!(object.get("state").and_then(Value::as_str), Some("running"));
        for internal in [
            "createdAt",
            "parentId",
            "kind",
            "running",
            "waitingForInput",
            "pendingInputs",
            "transcript",
        ] {
            assert!(
                !object.contains_key(internal),
                "unexpected field {internal}"
            );
        }
    }

    #[test]
    fn display_revision_changes_only_for_meaningful_display_content() {
        let source = session("revision", 100, None);
        let first = vec![display_session(&source, 100, 10_800)];
        let same = vec![display_session(&source, 200, 10_800)];
        assert_eq!(
            display_revision(&first, &[], &[]),
            display_revision(&same, &[], &[])
        );

        let mut changed_source = source;
        changed_source.title = "Changed".to_string();
        let changed = vec![display_session(&changed_source, 200, 10_800)];
        assert_ne!(
            display_revision(&first, &[], &[]),
            display_revision(&changed, &[], &[])
        );
    }

    #[test]
    fn authoritative_archive_lookup_rejects_missing_children_and_active_sessions() {
        let mut parent = session("parent", 100, None);
        parent.children.push(session("child", 100, Some("parent")));
        let parent_snapshot = snapshot(vec![parent], 100);
        assert!(authoritative_archivable_session(&parent_snapshot, "codex", "parent").is_ok());
        assert!(
            authoritative_archivable_session(&parent_snapshot, "codex", "child")
                .unwrap_err()
                .contains("not found")
        );
        assert!(
            authoritative_archivable_session(&parent_snapshot, "codex", "missing")
                .unwrap_err()
                .contains("not found")
        );

        let mut running = session("running", 100, None);
        running.running = true;
        let snapshot = snapshot(vec![running], 100);
        assert!(
            authoritative_archivable_session(&snapshot, "codex", "running")
                .unwrap_err()
                .contains("cannot be archived")
        );
    }

    #[test]
    fn collects_waiting_parent_and_child_sessions_for_terminal_matching() {
        let mut waiting_parent = session("parent", 100, None);
        waiting_parent.children.push(AiSession {
            waiting_for_input: true,
            ..session("child", 100, Some("parent"))
        });
        let idle = session("idle", 100, None);
        let archived = AiSession {
            waiting_for_input: true,
            archived_at: Some(200),
            ..session("archived", 100, None)
        };

        let keys = waiting_terminal_session_keys(&[waiting_parent, idle, archived])
            .into_iter()
            .collect::<HashSet<_>>();
        assert_eq!(
            keys,
            HashSet::from([
                ("codex".to_string(), "parent".to_string()),
                ("codex".to_string(), "child".to_string()),
            ])
        );
    }

    #[test]
    fn settings_and_foreground_changes_wake_and_reconfigure_monitor_state() {
        let handle = monitor_handle(AiSessionSettings::default());
        handle.update_view_active(true);
        handle.update_window_foreground(true);
        let settings = AiSessionSettings {
            foreground_refresh_interval_seconds: 30,
            background_refresh_interval_seconds: 300,
            ..AiSessionSettings::default()
        };
        handle.update_settings(settings);

        let runtime = handle.shared.0.lock().unwrap();
        assert!(runtime.view_active);
        assert!(runtime.window_foreground);
        assert_eq!(runtime.settings, settings);
        assert_eq!(runtime.requested_generation, 1);
        assert_eq!(
            AiSessionMonitorHandle::polling_interval(&runtime),
            Duration::from_secs(30)
        );
    }

    #[test]
    fn monitor_attempts_complete_coalesced_requests_and_retain_last_success_on_failure() {
        let mut runtime = monitor_runtime(AiSessionSettings::default());
        runtime.requested_generation = 3;
        let successful = snapshot(vec![session("one", 100, None)], 100);
        assert_eq!(
            complete_monitor_attempt(&mut runtime, 3, Ok(successful.clone())),
            Some(successful.clone())
        );
        assert_eq!(runtime.completed_generation, 3);
        assert_eq!(runtime.latest, Some(successful.clone()));
        assert_eq!(runtime.last_error, None);

        runtime.requested_generation = 4;
        assert_eq!(
            complete_monitor_attempt(&mut runtime, 4, Err("scan failed".to_string())),
            None
        );
        assert_eq!(runtime.completed_generation, 4);
        assert_eq!(runtime.latest, Some(successful));
        assert_eq!(runtime.last_error.as_deref(), Some("scan failed"));
    }

    #[test]
    fn exposes_only_available_resume_targets() {
        assert_eq!(open_targets_with(false, true), vec!["desktop".to_string()]);
        assert_eq!(open_targets_with(true, false), vec!["terminal".to_string()]);
        assert_eq!(
            open_targets_with(true, true),
            vec!["terminal".to_string(), "desktop".to_string()]
        );
    }

    #[test]
    fn codex_cache_reuses_appends_rereads_and_forgets_deleted_transcripts() {
        let directory = fixture_dir("codex-cache");
        let path = directory.join("rollout.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"payload\":{\"id\":\"cached\",\"cwd\":\"/work\",\"source\":\"cli\"}}\n",
                "{\"type\":\"event_msg\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"payload\":{\"type\":\"task_started\"}}\n",
            ),
        )
        .unwrap();
        let mut cache = CodexDiscoveryCache::default();
        assert!(
            read_codex_transcript_state_cached(&path, &mut cache)
                .unwrap()
                .lifecycle
                .running
        );
        assert_eq!((cache.full_reads, cache.incremental_reads), (1, 0));

        assert!(read_codex_transcript_state_cached(&path, &mut cache).is_some());
        assert_eq!((cache.full_reads, cache.incremental_reads), (1, 0));

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        std::io::Write::write_all(
            &mut file,
            b"{\"type\":\"event_msg\",\"timestamp\":\"2026-01-01T00:00:02Z\",\"payload\":{\"type\":\"task_complete\"}}\n",
        )
        .unwrap();
        drop(file);
        assert!(
            !read_codex_transcript_state_cached(&path, &mut cache)
                .unwrap()
                .lifecycle
                .running
        );
        assert_eq!(cache.incremental_reads, 1);

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        std::io::Write::write_all(&mut file, b"{\"type\":").unwrap();
        drop(file);
        assert!(read_codex_transcript_state_cached(&path, &mut cache).is_some());
        assert!(
            cache.transcripts.get(&path).unwrap().complete_len < fs::metadata(&path).unwrap().len()
        );
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        std::io::Write::write_all(&mut file, b"\"ignored\"}\n").unwrap();
        drop(file);
        assert!(read_codex_transcript_state_cached(&path, &mut cache).is_some());

        fs::write(
            &path,
            "{\"type\":\"session_meta\",\"payload\":{\"id\":\"replacement\",\"source\":\"cli\"}}\n",
        )
        .unwrap();
        assert_eq!(
            read_codex_transcript_state_cached(&path, &mut cache)
                .unwrap()
                .id
                .as_deref(),
            Some("replacement")
        );
        assert_eq!(cache.full_reads, 2);

        fs::remove_file(&path).unwrap();
        assert!(read_codex_transcript_state_cached(&path, &mut cache).is_none());
        assert!(!cache.transcripts.contains_key(&path));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn identifies_bundled_codex_executables() {
        let bundled = PathBuf::from("/Applications/Codex.app/Contents/Resources/codex");
        assert!(is_bundled_codex_executable(&bundled));
        assert_eq!(codex_cli_executable_from(Some(bundled)), None);
        assert!(is_bundled_codex_executable(Path::new(
            "/Applications/ChatGPT.app/Contents/Resources/codex"
        )));
        let cli = PathBuf::from("/usr/local/bin/codex");
        assert!(!is_bundled_codex_executable(&cli));
        assert_eq!(codex_cli_executable_from(Some(cli.clone())), Some(cli));
    }

    #[cfg(unix)]
    #[test]
    fn identifies_symlinks_to_bundled_codex_executables() {
        use std::os::unix::fs::symlink;

        let directory = fixture_dir("bundled-codex-symlink");
        let executable = directory
            .join("Codex.app")
            .join("Contents")
            .join("Resources")
            .join("codex");
        fs::create_dir_all(executable.parent().unwrap()).unwrap();
        fs::write(&executable, []).unwrap();
        let link = directory.join("bin").join("codex");
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        if link.symlink_metadata().is_ok() {
            fs::remove_file(&link).unwrap();
        }
        symlink(&executable, &link).unwrap();

        assert!(is_bundled_codex_executable(&link));
        assert_eq!(codex_cli_executable_from(Some(link)), None);
    }

    #[test]
    fn keeps_old_parent_when_recent_child_matches() {
        let grouped = group_and_filter(
            vec![
                session("parent", 10, None),
                session("child", 100, Some("parent")),
            ],
            50,
            &AiSessionSettings::default(),
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
    fn initializes_ai_session_archive_storage() {
        let db = Connection::open_in_memory().unwrap();
        init_database(&db).unwrap();
        let table_exists = db
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'table' AND name = 'ai_session_archives'
                )",
                [],
                |row| row.get::<_, bool>(0),
            )
            .unwrap();
        assert!(table_exists);
    }

    #[test]
    fn archives_updates_lists_and_restores_session_snapshots() {
        let db = Connection::open_in_memory().unwrap();
        init_database(&db).unwrap();
        let mut archived = session("archive-me", 10, None);
        archived
            .children
            .push(session("child", 11, Some("archive-me")));

        let first = archive_session_in_db(&db, &archived, 100, "station").unwrap();
        assert_eq!(first.archived_at, Some(100));
        assert_eq!(first.archive_scope.as_deref(), Some("station"));
        let snapshots = load_archived_sessions(&db).unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].children[0].id, "child");

        archived.title = "Updated snapshot".to_string();
        archive_session_in_db(&db, &archived, 200, "station").unwrap();
        let snapshots = load_archived_sessions(&db).unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].title, "Updated snapshot");
        assert_eq!(snapshots[0].archived_at, Some(200));

        restore_session_in_db(&db, "codex", "archive-me").unwrap();
        assert!(load_archived_sessions(&db).unwrap().is_empty());
    }

    #[test]
    fn synchronizes_new_codex_archives_and_restores() {
        let db = Connection::open_in_memory().unwrap();
        init_database(&db).unwrap();
        let archived = session("provider-archive", 10, None);
        let mut calls = Vec::new();

        let snapshot = archive_session_with_sync(&db, &archived, 100, |action, session_id| {
            calls.push((action.to_string(), session_id.to_string()));
            Ok(())
        })
        .unwrap();
        assert_eq!(snapshot.archive_scope.as_deref(), Some("provider"));
        assert_eq!(
            calls,
            vec![("archive".to_string(), "provider-archive".to_string())]
        );

        restore_session_with_sync(&db, "codex", "provider-archive", |action, session_id| {
            calls.push((action.to_string(), session_id.to_string()));
            Ok(())
        })
        .unwrap();
        assert_eq!(
            calls,
            vec![
                ("archive".to_string(), "provider-archive".to_string()),
                ("unarchive".to_string(), "provider-archive".to_string()),
            ]
        );
        assert!(load_archived_sessions(&db).unwrap().is_empty());
    }

    #[test]
    fn provider_sync_failures_leave_station_archive_state_unchanged() {
        let db = Connection::open_in_memory().unwrap();
        init_database(&db).unwrap();
        let archived = session("sync-failure", 10, None);

        let error =
            archive_session_with_sync(&db, &archived, 100, |_, _| Err("sync failed".to_string()))
                .unwrap_err();
        assert_eq!(error, "sync failed");
        assert!(load_archived_sessions(&db).unwrap().is_empty());

        archive_session_in_db(&db, &archived, 100, "provider").unwrap();
        let error = restore_session_with_sync(&db, "codex", "sync-failure", |_, _| {
            Err("restore failed".to_string())
        })
        .unwrap_err();
        assert_eq!(error, "restore failed");
        assert_eq!(load_archived_sessions(&db).unwrap().len(), 1);
    }

    #[test]
    fn historical_and_claude_archives_remain_station_only() {
        let db = Connection::open_in_memory().unwrap();
        init_database(&db).unwrap();
        let historical = session("historical", 10, None);
        let mut snapshot = serde_json::to_value(&historical).unwrap();
        snapshot.as_object_mut().unwrap().remove("archiveScope");
        db.execute(
            "INSERT INTO ai_session_archives
                (provider, session_id, snapshot_json, archived_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                historical.provider,
                historical.id,
                snapshot.to_string(),
                100
            ],
        )
        .unwrap();
        let snapshots = load_archived_sessions(&db).unwrap();
        assert_eq!(snapshots[0].archive_scope.as_deref(), Some("station"));
        restore_session_with_sync(&db, "codex", "historical", |_, _| {
            panic!("historical archive must not invoke Codex")
        })
        .unwrap();

        let mut claude = session("claude-local", 20, None);
        claude.provider = "claude".to_string();
        let archived = archive_session_with_sync(&db, &claude, 200, |_, _| {
            panic!("Claude archive must remain local")
        })
        .unwrap();
        assert_eq!(archived.archive_scope.as_deref(), Some("station"));
    }

    #[test]
    fn rejects_invalid_or_active_archive_requests() {
        let db = Connection::open_in_memory().unwrap();
        init_database(&db).unwrap();

        let mut invalid_provider = session("valid-id", 10, None);
        invalid_provider.provider = "other".to_string();
        assert!(archive_session_in_db(&db, &invalid_provider, 100, "station").is_err());

        let invalid_id = session("bad;id", 10, None);
        assert!(archive_session_in_db(&db, &invalid_id, 100, "station").is_err());

        let mut running = session("running", 10, None);
        running.running = true;
        assert!(archive_session_in_db(&db, &running, 100, "station").is_err());

        let mut waiting_child = session("waiting-parent", 10, None);
        let mut child = session("waiting-child", 11, Some("waiting-parent"));
        child.waiting_for_input = true;
        waiting_child.children.push(child);
        assert!(archive_session_in_db(&db, &waiting_child, 100, "station").is_err());

        assert!(restore_session_in_db(&db, "other", "valid-id").is_err());
        assert!(restore_session_in_db(&db, "codex", "bad;id").is_err());
    }

    #[test]
    fn keeps_old_archives_and_auto_restores_reactivated_sessions() {
        let db = Connection::open_in_memory().unwrap();
        init_database(&db).unwrap();
        let archived = session("old-session", 1, None);
        archive_session_in_db(&db, &archived, 2, "station").unwrap();

        let (active, snapshots) = reconcile_archived_sessions(&db, vec![]).unwrap();
        assert!(active.is_empty());
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].updated_at, 1);

        let (active, snapshots) = reconcile_archived_sessions(&db, vec![archived.clone()]).unwrap();
        assert!(active.is_empty());
        assert_eq!(snapshots.len(), 1);

        let mut reactivated = archived;
        reactivated.running = true;
        let (active, snapshots) = reconcile_archived_sessions(&db, vec![reactivated]).unwrap();
        assert_eq!(active.len(), 1);
        assert!(snapshots.is_empty());
        assert!(load_archived_sessions(&db).unwrap().is_empty());
    }

    #[test]
    fn reads_codex_desktop_origin_from_transcript_metadata() {
        let directory = fixture_dir("codex-desktop");
        let path = directory.join("rollout.jsonl");
        fs::write(
            &path,
            "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-22T10:00:00Z\",\"payload\":{\"id\":\"desktop-session\",\"cwd\":\"/work/app\",\"source\":\"vscode\",\"originator\":\"Codex Desktop\"}}\n",
        )
        .unwrap();

        let session = read_codex_transcript(&path).unwrap();
        assert_eq!(session.origin, "desktop");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn detects_codex_running_lifecycle_and_skips_malformed_events() {
        let directory = fixture_dir("codex-running");
        let path = directory.join("rollout.jsonl");
        let prefix = concat!(
            "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-22T10:00:00Z\",\"payload\":{\"id\":\"running-session\",\"cwd\":\"/work/app\",\"source\":\"cli\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
            "{malformed\n",
        );
        fs::write(&path, prefix).unwrap();

        let state = codex_session_state(&path);
        assert!(state.running);
        assert!(!state.waiting_for_input());
        assert!(read_codex_transcript(&path).unwrap().running);

        let complete = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n";
        fs::write(&path, format!("{prefix}{complete}")).unwrap();
        let completed_without_timestamp = codex_session_state(&path);
        assert!(!completed_without_timestamp.running);
        assert!(!completed_without_timestamp.waiting_for_input());
        assert!(completed_without_timestamp.completed_at.is_some());
        assert!(read_codex_transcript(&path).unwrap().completed_at.is_some());

        let timestamped_complete = "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-22T10:03:00Z\",\"payload\":{\"type\":\"task_complete\"}}\n";
        fs::write(&path, format!("{prefix}{timestamped_complete}")).unwrap();
        assert_eq!(
            codex_session_state(&path).completed_at,
            Some(timestamp_millis(Some("2026-07-22T10:03:00Z")))
        );

        let restart = "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-22T10:04:00Z\",\"payload\":{\"type\":\"task_started\"}}\n";
        fs::write(&path, format!("{prefix}{timestamped_complete}{restart}")).unwrap();
        let restarted = codex_session_state(&path);
        assert!(restarted.running);
        assert_eq!(restarted.completed_at, None);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn treats_aborted_codex_turns_as_idle_and_allows_restart() {
        let directory = fixture_dir("codex-aborted");
        let path = directory.join("rollout.jsonl");
        let prefix = concat!(
            "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-31T15:52:53Z\",\"payload\":{\"id\":\"aborted-session\",\"cwd\":\"/work/app\",\"source\":\"cli\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"request_user_input\",\"call_id\":\"input-call\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"exec_command\",\"call_id\":\"approval-call\",\"arguments\":\"{\\\"cmd\\\":\\\"npm test\\\",\\\"sandbox_permissions\\\":\\\"require_escalated\\\"}\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[{\"type\":\"output_text\",\"text\":\"<proposed_plan>\\nWait?\\n</proposed_plan>\"}]}}\n",
        );
        let aborted = "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-31T17:13:54Z\",\"payload\":{\"type\":\"turn_aborted\",\"reason\":\"interrupted\"}}\n";
        fs::write(&path, format!("{prefix}{aborted}")).unwrap();

        let state = codex_session_state(&path);
        assert!(!state.running);
        assert!(!state.waiting_for_input());
        assert_eq!(state.completed_at, None);
        assert!(state.pending_inputs.is_empty());
        assert!(state.pending_approvals.is_empty());
        assert!(!state.proposed_plan);
        assert!(!state.final_question);

        let session = read_codex_transcript(&path).unwrap();
        assert!(!session.running);
        assert!(!session.waiting_for_input);
        assert_eq!(session.completed_at, None);

        let restart = "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-31T17:14:00Z\",\"payload\":{\"type\":\"task_started\"}}\n";
        fs::write(&path, format!("{prefix}{aborted}{restart}")).unwrap();
        let restarted = codex_session_state(&path);
        assert!(restarted.running);
        assert!(!restarted.waiting_for_input());
        assert_eq!(restarted.completed_at, None);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn does_not_treat_completed_plan_mode_turns_as_waiting_without_a_plan() {
        let directory = fixture_dir("codex-plan-mode");
        let path = directory.join("rollout.jsonl");
        let prefix = concat!(
            "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-27T16:49:55Z\",\"payload\":{\"id\":\"plan-mode-session\",\"cwd\":\"/work/app\",\"source\":\"vscode\",\"originator\":\"Codex Desktop\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"collaboration_mode_kind\":\"plan\"}}\n",
        );
        let resolved_input = concat!(
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"request_user_input\",\"call_id\":\"direction-choice\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"direction-choice\",\"output\":\"auto-resolved\"}}\n",
        );
        let ordinary_final = "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[{\"type\":\"output_text\",\"text\":\"The provider contract still needs a decision.\"}]}}\n";
        let complete = "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-27T16:57:40Z\",\"payload\":{\"type\":\"task_complete\"}}\n";
        let completed_plan = format!("{prefix}{resolved_input}{ordinary_final}{complete}");
        fs::write(&path, &completed_plan).unwrap();

        let state = codex_session_state(&path);
        assert!(!state.running);
        assert!(!state.waiting_for_input());
        assert!(!read_codex_transcript(&path).unwrap().waiting_for_input);

        fs::write(&path, prefix).unwrap();
        let plan_running = codex_session_state(&path);
        assert!(plan_running.running);
        assert!(!plan_running.waiting_for_input());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn detects_codex_final_questions_until_the_next_user_or_final_answer() {
        let directory = fixture_dir("codex-final-question");
        let path = directory.join("rollout.jsonl");
        let prefix = concat!(
            "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-27T16:49:55Z\",\"payload\":{\"id\":\"question-session\",\"cwd\":\"/work/app\",\"source\":\"vscode\",\"originator\":\"Codex Desktop\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"collaboration_mode_kind\":\"plan\"}}\n",
        );
        let complete =
            "{\"type\":\"event_msg\",\"timestamp\":\"2026-07-27T16:57:40Z\",\"payload\":{\"type\":\"task_complete\"}}\n";
        let commentary_question = "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"phase\":\"commentary\",\"content\":[{\"type\":\"output_text\",\"text\":\"Should I inspect the fixtures?\"}]}}\n";
        fs::write(&path, format!("{prefix}{commentary_question}{complete}")).unwrap();
        assert!(!codex_session_state(&path).waiting_for_input());

        let final_question = "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[{\"type\":\"output_text\",\"text\":\"**Which branch should I use?**\"}]}}\n";
        let completed_question = format!("{prefix}{final_question}{complete}");
        fs::write(&path, &completed_question).unwrap();
        assert!(codex_session_state(&path).waiting_for_input());
        assert!(read_codex_transcript(&path).unwrap().waiting_for_input);

        let next_user = "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Use the current branch.\"}]}}\n";
        fs::write(&path, format!("{completed_question}{next_user}")).unwrap();
        assert!(!codex_session_state(&path).waiting_for_input());

        let ordinary_final = "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[{\"type\":\"output_text\",\"text\":\"The earlier question was \\\"Which branch?\\\", and the task is complete.\"}]}}\n";
        fs::write(
            &path,
            format!("{completed_question}{ordinary_final}{complete}"),
        )
        .unwrap();
        assert!(!codex_session_state(&path).waiting_for_input());
        assert!(!read_codex_transcript(&path).unwrap().waiting_for_input);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn recognizes_only_questions_at_the_end_of_final_text() {
        assert!(ends_with_question("Which branch should I use?"));
        assert!(ends_with_question("**Which branch should I use?**"));
        assert!(ends_with_question("Choose the current branch (okay?)"));
        assert!(ends_with_question("Use the current branch?”"));
        assert!(!ends_with_question("Why? The task is complete."));
        assert!(!ends_with_question("The task needs a decision."));
        assert!(!ends_with_question(""));
    }

    #[test]
    fn recognizes_javascript_exec_approval_arguments_without_matching_command_text() {
        assert!(codex_exec_command_arguments_require_approval(
            r#"{cmd:"php bin/phpunit",yield_time_ms:30000,sandbox_permissions:"require_escalated",justification:"Allow the test database?"})"#
        ));
        assert!(codex_exec_command_arguments_require_approval(
            r#"{cmd:'npm test', sandbox_permissions: 'require_escalated'})"#
        ));
        assert!(!codex_exec_command_arguments_require_approval(
            r#"{cmd:"rg -n 'sandbox_permissions:\"require_escalated\"' .",sandbox_permissions:"use_default"})"#
        ));
        assert!(!codex_exec_command_arguments_require_approval(
            r#"{cmd:"npm test",sandbox_permissions:"use_default"})"#
        ));
    }

    #[test]
    fn keeps_codex_waiting_until_every_pending_reason_is_resolved() {
        let mut state = CodexSessionState::default();
        let events = [
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "task_started"}
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "request_user_input",
                    "call_id": "input-call"
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call",
                    "name": "exec_command",
                    "call_id": "direct-approval-call",
                    "arguments": r#"{"cmd":"npm test","sandbox_permissions":"require_escalated"}"#
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "name": "exec",
                    "call_id": "wrapped-approval-call",
                    "input": r#"const r = await tools.exec_command({cmd:"php bin/phpunit",sandbox_permissions:"require_escalated"}); text(r.output);"#
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "assistant",
                    "phase": "final_answer",
                    "content": [{
                        "type": "output_text",
                        "text": "<proposed_plan>\nRun the tests\n</proposed_plan>"
                    }]
                }
            }),
            serde_json::json!({
                "type": "event_msg",
                "timestamp": "2026-07-27T08:00:00Z",
                "payload": {"type": "task_complete"}
            }),
        ];
        for event in &events {
            update_codex_session_state(event, &mut state);
        }

        assert!(!state.running);
        assert!(state.waiting_for_input());

        for (call_id, output_type) in [
            ("input-call", "function_call_output"),
            ("direct-approval-call", "function_call_output"),
            ("wrapped-approval-call", "custom_tool_call_output"),
        ] {
            update_codex_session_state(
                &serde_json::json!({
                    "type": "response_item",
                    "payload": {
                        "type": output_type,
                        "call_id": call_id,
                        "output": "resolved"
                    }
                }),
                &mut state,
            );
            assert!(
                state.waiting_for_input(),
                "resolving {call_id} must not clear the other waiting reasons"
            );
        }

        update_codex_session_state(
            &serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": "Implement it"}]
                }
            }),
            &mut state,
        );
        assert!(!state.waiting_for_input());
    }

    #[test]
    fn detects_only_unanswered_codex_input_requests() {
        let directory = fixture_dir("codex-waiting");
        let path = directory.join("rollout.jsonl");
        let prefix = concat!(
            "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-22T10:00:00Z\",\"payload\":{\"id\":\"waiting-session\",\"cwd\":\"/work/app\",\"source\":\"cli\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Could you clarify?\"}]}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"unrelated_tool\",\"call_id\":\"ordinary-call\"}}\n",
        );
        let request = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"request_user_input\",\"call_id\":\"input-call\"}}\n";
        fs::write(&path, format!("{prefix}{request}{{malformed\n")).unwrap();

        assert!(codex_session_state(&path).waiting_for_input());
        assert!(read_codex_transcript(&path).unwrap().waiting_for_input);

        let answer = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"input-call\",\"output\":\"answered\"}}\n";
        fs::write(&path, format!("{prefix}{request}{answer}")).unwrap();
        assert!(!codex_session_state(&path).waiting_for_input());
        assert!(!read_codex_transcript(&path).unwrap().waiting_for_input);

        fs::write(&path, prefix).unwrap();
        assert!(!codex_session_state(&path).waiting_for_input());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn detects_only_unanswered_codex_approval_requests() {
        let directory = fixture_dir("codex-approval");
        let path = directory.join("rollout.jsonl");
        let prefix = concat!(
            "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-24T06:20:00Z\",\"payload\":{\"id\":\"approval-session\",\"cwd\":\"/work/app\",\"source\":\"vscode\",\"originator\":\"Codex Desktop\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"exec_command\",\"call_id\":\"ordinary-call\",\"arguments\":\"{\\\"cmd\\\":\\\"npm test\\\",\\\"sandbox_permissions\\\":\\\"use_default\\\"}\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"write_stdin\",\"call_id\":\"unrelated-call\",\"arguments\":\"{\\\"sandbox_permissions\\\":\\\"require_escalated\\\"}\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"exec_command\",\"call_id\":\"malformed-call\",\"arguments\":\"{malformed\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"js\",\"call_id\":\"ordinary-js-call\",\"arguments\":\"{\\\"code\\\":\\\"const result = 1 + 1;\\\"}\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"js\",\"call_id\":\"malformed-js-call\",\"arguments\":\"{malformed\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"unrelated_tool\",\"call_id\":\"unrelated-browser-call\",\"arguments\":\"{\\\"code\\\":\\\"await browser.tabs.new();\\\"}\"}}\n",
        );
        let approval = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"exec_command\",\"call_id\":\"approval-call\",\"arguments\":\"{\\\"cmd\\\":\\\"npm run dev -- --host 127.0.0.1\\\",\\\"sandbox_permissions\\\":\\\"require_escalated\\\",\\\"justification\\\":\\\"Allow the local preview server?\\\"}\"}}\n";
        fs::write(&path, format!("{prefix}{approval}")).unwrap();

        let state = codex_session_state(&path);
        assert!(state.running);
        assert!(state.waiting_for_input());
        assert!(read_codex_transcript(&path).unwrap().waiting_for_input);

        let denied = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"approval-call\",\"output\":\"denied by user\"}}\n";
        fs::write(&path, format!("{prefix}{approval}{denied}")).unwrap();
        let state = codex_session_state(&path);
        assert!(state.running);
        assert!(!state.waiting_for_input());
        assert!(!read_codex_transcript(&path).unwrap().waiting_for_input);

        fs::write(&path, prefix).unwrap();
        assert!(!codex_session_state(&path).waiting_for_input());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn detects_only_unanswered_wrapped_codex_approval_requests() {
        let directory = fixture_dir("codex-wrapped-approval");
        let path = directory.join("rollout.jsonl");
        let prefix = [
            serde_json::json!({
                "type": "session_meta",
                "timestamp": "2026-07-24T06:20:00Z",
                "payload": {
                    "id": "wrapped-approval-session",
                    "cwd": "/work/app",
                    "source": "vscode",
                    "originator": "Codex Desktop"
                }
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": {"type": "task_started"}
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "name": "exec",
                    "call_id": "ordinary-call",
                    "input": r#"const r = await tools.exec_command({"cmd":"npm test","sandbox_permissions":"use_default"}); text(r.output);"#
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "name": "exec",
                    "call_id": "search-call",
                    "input": r#"const r = await tools.exec_command({"cmd":"rg -n '\"sandbox_permissions\":\"require_escalated\"' .","sandbox_permissions":"use_default"}); text(r.output);"#
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "name": "exec",
                    "call_id": "javascript-search-call",
                    "input": r#"const r = await tools.exec_command({cmd:"rg -n 'sandbox_permissions:\"require_escalated\"' .",sandbox_permissions:"use_default"}); text(r.output);"#
                }
            }),
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "custom_tool_call",
                    "name": "other",
                    "call_id": "unrelated-call",
                    "input": r#"const r = await tools.exec_command({"cmd":"npm run dev","sandbox_permissions":"require_escalated"}); text(r.output);"#
                }
            }),
        ]
        .into_iter()
        .map(|value| value.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        fs::write(&path, format!("{prefix}\n")).unwrap();

        assert!(!codex_session_state(&path).waiting_for_input());
        assert!(!read_codex_transcript(&path).unwrap().waiting_for_input);

        let javascript_approval = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "javascript-approval-call",
                "input": r#"const checks = await Promise.all([
                    tools.exec_command({cmd:"npm test",sandbox_permissions:"use_default"}),
                    tools.exec_command({cmd:"php bin/phpunit",yield_time_ms:30000,sandbox_permissions:"require_escalated",justification:"Allow the test database?"})
                ]);"#
            }
        })
        .to_string();
        fs::write(&path, format!("{prefix}\n{javascript_approval}\n")).unwrap();

        assert!(codex_session_state(&path).waiting_for_input());
        assert!(read_codex_transcript(&path).unwrap().waiting_for_input);

        let javascript_answer = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "javascript-approval-call",
                "output": "permission denied"
            }
        })
        .to_string();
        fs::write(
            &path,
            format!("{prefix}\n{javascript_approval}\n{javascript_answer}\n"),
        )
        .unwrap();
        assert!(!codex_session_state(&path).waiting_for_input());

        let approval = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "call_id": "approval-call",
                "input": r#"const r = await tools.exec_command({"cmd":"npm run dev -- --host 127.0.0.1","sandbox_permissions":"require_escalated","justification":"Allow the local preview server?"}); text(r.output);"#
            }
        })
        .to_string();
        fs::write(&path, format!("{prefix}\n{approval}\n")).unwrap();

        let state = codex_session_state(&path);
        assert!(state.running);
        assert!(state.waiting_for_input());
        assert!(read_codex_transcript(&path).unwrap().waiting_for_input);

        let denied = serde_json::json!({
            "type": "response_item",
            "payload": {
                "type": "custom_tool_call_output",
                "call_id": "approval-call",
                "output": "permission denied"
            }
        })
        .to_string();
        fs::write(&path, format!("{prefix}\n{approval}\n{denied}\n")).unwrap();

        let state = codex_session_state(&path);
        assert!(state.running);
        assert!(!state.waiting_for_input());
        assert!(!read_codex_transcript(&path).unwrap().waiting_for_input);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn detects_only_unanswered_codex_browser_permission_requests() {
        let directory = fixture_dir("codex-browser-approval");
        let path = directory.join("rollout.jsonl");
        let prefix = concat!(
            "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-24T06:20:00Z\",\"payload\":{\"id\":\"browser-approval-session\",\"cwd\":\"/work/app\",\"source\":\"vscode\",\"originator\":\"Codex Desktop\"}}\n",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"js\",\"call_id\":\"ordinary-js-call\",\"arguments\":\"{\\\"code\\\":\\\"const result = 1 + 1;\\\"}\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"exec_command\",\"call_id\":\"long-running-call\",\"arguments\":\"{\\\"cmd\\\":\\\"npm test\\\",\\\"sandbox_permissions\\\":\\\"use_default\\\"}\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"js\",\"call_id\":\"malformed-js-call\",\"arguments\":\"{malformed\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"unrelated-tool\",\"call_id\":\"unrelated-browser-call\",\"arguments\":\"{\\\"code\\\":\\\"await browser.tabs.new();\\\"}\"}}\n",
        );
        let permission_request = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"js\",\"call_id\":\"browser-call\",\"arguments\":\"{\\\"code\\\":\\\"var tab = await browser.tabs.new();\\\\nawait tab.goto(\\\\\\\"http://127.0.0.1:1420/\\\\\\\");\\\",\\\"timeout_ms\\\":30000,\\\"title\\\":\\\"Open local app\\\"}\"}}\n";
        fs::write(&path, format!("{prefix}{permission_request}")).unwrap();

        let state = codex_session_state(&path);
        assert!(state.running);
        assert!(state.waiting_for_input());
        assert!(read_codex_transcript(&path).unwrap().waiting_for_input);

        let denied = "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"browser-call\",\"output\":\"permission denied\"}}\n";
        fs::write(&path, format!("{prefix}{permission_request}{denied}")).unwrap();
        let state = codex_session_state(&path);
        assert!(state.running);
        assert!(!state.waiting_for_input());
        assert!(!read_codex_transcript(&path).unwrap().waiting_for_input);

        fs::write(&path, prefix).unwrap();
        assert!(!codex_session_state(&path).waiting_for_input());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn detects_codex_proposed_plans_until_the_next_user_message() {
        let directory = fixture_dir("codex-proposed-plan");
        let path = directory.join("rollout.jsonl");
        let prefix = concat!(
            "{\"type\":\"session_meta\",\"timestamp\":\"2026-07-22T10:00:00Z\",\"payload\":{\"id\":\"plan-session\",\"cwd\":\"/work/app\",\"source\":\"vscode\",\"originator\":\"Codex Desktop\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"type\":\"input_text\",\"text\":\"Plans use <proposed_plan> tags.\"}]}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"phase\":\"commentary\",\"content\":[{\"type\":\"output_text\",\"text\":\"Preparing <proposed_plan> now.\"}]}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"request_user_input\",\"call_id\":\"grouping-choice\"}}\n",
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"grouping-choice\",\"output\":\"{\\\"answers\\\":{\\\"grouping\\\":{\\\"answers\\\":[\\\"Both\\\"]}}}\"}}\n",
        );
        let proposed_plan = "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[{\"type\":\"output_text\",\"text\":\"Planning is complete.\\n<proposed_plan>\\nGroup both providers\\n</proposed_plan>\"}]}}\n";
        let task_complete = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}\n";
        fs::write(
            &path,
            format!("{prefix}{proposed_plan}{task_complete}{{malformed\n"),
        )
        .unwrap();

        assert!(codex_session_state(&path).waiting_for_input());
        assert!(read_codex_transcript(&path).unwrap().waiting_for_input);

        let next_user = "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"Implement it\"}]}}\n";
        fs::write(
            &path,
            format!("{prefix}{proposed_plan}{task_complete}{next_user}"),
        )
        .unwrap();
        assert!(!codex_session_state(&path).waiting_for_input());
        assert!(!read_codex_transcript(&path).unwrap().waiting_for_input);

        let implementation_summary = "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[{\"type\":\"output_text\",\"text\":\"Implemented. Codex final answers containing `<proposed_plan>` and `</proposed_plan>` are detected.\"}]}}\n";
        fs::write(
            &path,
            format!("{prefix}{proposed_plan}{task_complete}{next_user}{implementation_summary}"),
        )
        .unwrap();
        assert!(!codex_session_state(&path).waiting_for_input());
        assert!(!read_codex_transcript(&path).unwrap().waiting_for_input);

        let normal_final = "{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[{\"type\":\"output_text\",\"text\":\"Planning is complete.\"}]}}\n";
        fs::write(&path, format!("{prefix}{normal_final}")).unwrap();
        assert!(!codex_session_state(&path).waiting_for_input());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn requires_complete_standalone_codex_proposed_plan_tags() {
        assert!(contains_proposed_plan_block(
            "Introduction\n<proposed_plan>\nPlan body\n</proposed_plan>"
        ));
        assert!(contains_proposed_plan_block(
            "Introduction\n  <proposed_plan>  \nPlan body\n  </proposed_plan>  "
        ));
        assert!(!contains_proposed_plan_block(
            "Implemented support for `<proposed_plan>` and `</proposed_plan>`."
        ));
        assert!(!contains_proposed_plan_block(
            "<proposed_plan>Plan body</proposed_plan>"
        ));
        assert!(!contains_proposed_plan_block(
            "Introduction\n<proposed_plan>\nIncomplete plan"
        ));
    }

    #[test]
    fn scans_codex_database_rollouts_only_inside_the_requested_window() {
        let directory = fixture_dir("codex-waiting-window");
        let rollout = directory.join("rollout.jsonl");
        fs::write(
            &rollout,
            "{\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"request_user_input\",\"call_id\":\"input-call\"}}\n",
        )
        .unwrap();
        let path = directory.join("state_5.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE threads (id TEXT, created_at INTEGER, updated_at INTEGER, cwd TEXT, title TEXT, source TEXT, rollout_path TEXT, archived INTEGER);\
             CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);",
        )
        .unwrap();
        let rollout_path = rollout.to_string_lossy().into_owned();
        db.execute(
            "INSERT INTO threads VALUES ('recent', 10, 100, '/work/app', 'Recent', 'cli', ?1, 0)",
            [&rollout_path],
        )
        .unwrap();
        db.execute(
            "INSERT INTO threads VALUES ('old', 10, 20, '/work/app', 'Old', 'cli', ?1, 0)",
            [&rollout_path],
        )
        .unwrap();
        drop(db);

        let sessions =
            read_codex_database(&path, 50_000, &mut CodexDiscoveryCache::default()).unwrap();
        assert!(
            sessions
                .iter()
                .find(|session| session.id == "recent")
                .unwrap()
                .waiting_for_input
        );
        assert!(
            !sessions
                .iter()
                .find(|session| session.id == "old")
                .unwrap()
                .waiting_for_input
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn filters_sources_and_keeps_unknown_sessions_with_enabled_provider() {
        let mut codex_cli = session("codex-cli", 100, None);
        codex_cli.origin = "cli".to_string();
        let mut codex_desktop = session("codex-desktop", 100, None);
        codex_desktop.origin = "desktop".to_string();
        let codex_unknown = session("codex-unknown", 100, None);
        let settings = AiSessionSettings {
            codex_cli: false,
            codex_desktop: true,
            claude_cli: false,
            claude_desktop: false,
            foreground_refresh_interval_seconds: 30,
            background_refresh_interval_seconds: 60,
            done_state_duration_seconds: 3 * 60 * 60,
        };

        let grouped = group_and_filter(vec![codex_cli, codex_desktop, codex_unknown], 0, &settings);
        assert!(!grouped.iter().any(|item| item.id == "codex-cli"));
        assert!(grouped.iter().any(|item| item.id == "codex-desktop"));
        assert!(grouped.iter().any(|item| item.id == "codex-unknown"));
    }

    #[test]
    fn subagents_inherit_parent_origin_before_filtering() {
        let mut parent = session("parent", 100, None);
        parent.origin = "desktop".to_string();
        let child = session("child", 100, Some("parent"));
        let settings = AiSessionSettings {
            codex_cli: true,
            codex_desktop: false,
            claude_cli: true,
            claude_desktop: true,
            foreground_refresh_interval_seconds: 30,
            background_refresh_interval_seconds: 60,
            done_state_duration_seconds: 3 * 60 * 60,
        };

        assert!(group_and_filter(vec![parent, child], 0, &settings).is_empty());
    }

    #[test]
    fn completed_claude_parents_clear_stale_child_activity() {
        let mut parent = session("parent", 200, None);
        parent.provider = "claude".to_string();
        parent.completed_at = Some(200);
        let mut child = session("child", 150, Some("parent"));
        child.provider = "claude".to_string();
        child.running = true;
        child.waiting_for_input = true;
        let settings = AiSessionSettings::default();

        let grouped = group_and_filter(vec![parent, child], 0, &settings);
        let child = &grouped[0].children[0];

        assert!(!child.running);
        assert!(!child.waiting_for_input);
        assert_eq!(child.completed_at, Some(200));
    }

    #[test]
    fn active_claude_parents_preserve_child_activity() {
        let mut parent = session("parent", 200, None);
        parent.provider = "claude".to_string();
        parent.running = true;
        let mut child = session("child", 150, Some("parent"));
        child.provider = "claude".to_string();
        child.running = true;
        let settings = AiSessionSettings::default();

        let grouped = group_and_filter(vec![parent, child], 0, &settings);

        assert!(grouped[0].children[0].running);
    }

    #[test]
    fn reads_codex_database_and_excludes_archived_threads() {
        let directory = fixture_dir("codex");
        let path = directory.join("state_5.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE threads (id TEXT, created_at INTEGER, updated_at INTEGER, cwd TEXT, title TEXT, source TEXT, rollout_path TEXT, archived INTEGER);\
             CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);\
             INSERT INTO threads VALUES ('parent', 10, 20, '/work/app', 'Parent title', 'cli', '', 0);\
             INSERT INTO threads VALUES ('child', 11, 21, '/work/app', '', 'cli', '', 0);\
             INSERT INTO threads VALUES ('archived', 12, 22, '/work/app', 'Old', 'cli', '', 1);\
             INSERT INTO thread_spawn_edges VALUES ('parent', 'child');",
        )
        .unwrap();
        drop(db);

        let sessions = read_codex_database(&path, 0, &mut CodexDiscoveryCache::default()).unwrap();
        assert_eq!(sessions.len(), 2);
        assert!(!sessions.iter().any(|session| session.id == "archived"));
        let child = sessions
            .iter()
            .find(|session| session.id == "child")
            .unwrap();
        assert_eq!(child.parent_id.as_deref(), Some("parent"));
        assert_eq!(child.title, "Codex session");
        assert_eq!(child.origin, "cli");
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
                "{{\"type\":\"user\",\"sessionId\":\"{parent_id}\",\"cwd\":\"/work/app\",\"entrypoint\":\"claude-desktop\",\"timestamp\":\"2026-07-22T10:00:00Z\",\"message\":{{\"content\":\"Fallback prompt\"}}}}\n\
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
        assert_eq!(parent_session.origin, "desktop");
        assert_eq!(child_session.id, "agent-child");
        assert_eq!(child_session.parent_id.as_deref(), Some(parent_id));
        assert!(child_session.open_targets.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn caches_unchanged_claude_transcripts_and_reads_appends_incrementally() {
        use std::io::Write;

        let directory = fixture_dir("claude-incremental-cache");
        let projects_root = directory.join("projects");
        let project = projects_root.join("project-a");
        fs::create_dir_all(&project).unwrap();
        let path = project.join("44444444-4444-4444-8444-444444444444.jsonl");
        let prompt = "x".repeat(5000);
        fs::write(
            &path,
            format!(
                "{{\"type\":\"user\",\"sessionId\":\"44444444-4444-4444-8444-444444444444\",\"timestamp\":\"2026-08-05T10:00:00Z\",\"message\":{{\"content\":\"{prompt}\"}}}}\n"
            ),
        )
        .unwrap();
        let mut cache = ClaudeDiscoveryCache::default();

        let initial = read_claude_transcript_cached(&path, &projects_root, &mut cache).unwrap();
        assert!(initial.running);
        assert_eq!(cache.full_reads, 1);
        let unchanged = read_claude_transcript_cached(&path, &projects_root, &mut cache).unwrap();
        assert_eq!(unchanged, initial);
        assert_eq!(cache.full_reads, 1);
        assert_eq!(cache.incremental_reads, 0);

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(file, "{{\"type\":\"assistant\"").unwrap();
        drop(file);
        let partial = read_claude_transcript_cached(&path, &projects_root, &mut cache).unwrap();
        assert!(partial.running);
        assert_eq!(cache.incremental_reads, 1);

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            ",\"timestamp\":\"2026-08-05T10:01:00Z\",\"message\":{{\"stop_reason\":\"end_turn\",\"content\":[]}}}}"
        )
        .unwrap();
        drop(file);
        let completed = read_claude_transcript_cached(&path, &projects_root, &mut cache).unwrap();
        assert!(!completed.running);
        let completed_at = completed.completed_at;
        assert!(completed_at.is_some());
        assert_eq!(cache.full_reads, 1);
        assert_eq!(cache.incremental_reads, 2);

        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(
            file,
            "{{\"type\":\"user\",\"sessionId\":\"44444444-4444-4444-8444-444444444444\",\"timestamp\":\"2026-08-05T10:02:00Z\",\"message\":{{\"content\":\"<local-command-stdout>output</local-command-stdout>\"}}}}"
        )
        .unwrap();
        drop(file);
        let local_command =
            read_claude_transcript_cached(&path, &projects_root, &mut cache).unwrap();
        assert!(!local_command.running);
        assert_eq!(local_command.completed_at, completed_at);
        assert_eq!(local_command.title, completed.title);
        assert_eq!(cache.full_reads, 1);
        assert_eq!(cache.incremental_reads, 3);

        fs::write(
            &path,
            "{\"type\":\"user\",\"sessionId\":\"44444444-4444-4444-8444-444444444444\",\"timestamp\":\"2026-08-05T11:00:00Z\",\"message\":{\"content\":\"Restarted\"}}\n",
        )
        .unwrap();
        let rebuilt = read_claude_transcript_cached(&path, &projects_root, &mut cache).unwrap();
        assert!(rebuilt.running);
        assert_eq!(rebuilt.title, "Restarted");
        assert_eq!(cache.full_reads, 2);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cold_claude_discovery_keeps_old_parents_for_recent_subagents_and_prunes_cache() {
        let directory = fixture_dir("claude-cold-discovery");
        let projects_root = directory.join("projects");
        let project = projects_root.join("project-a");
        let parent_id = "55555555-5555-4555-8555-555555555555";
        let parent = project.join(format!("{parent_id}.jsonl"));
        fs::create_dir_all(project.join(parent_id).join("subagents")).unwrap();
        fs::write(
            &parent,
            format!("{{\"type\":\"user\",\"sessionId\":\"{parent_id}\",\"entrypoint\":\"cli\",\"timestamp\":\"2026-01-01T10:00:00Z\",\"message\":{{\"content\":\"Old parent\"}}}}\n"),
        )
        .unwrap();
        std::thread::sleep(Duration::from_millis(5));
        let since = now_millis();
        std::thread::sleep(Duration::from_millis(5));
        let child = project
            .join(parent_id)
            .join("subagents")
            .join("agent-recent.jsonl");
        fs::write(
            &child,
            format!("{{\"type\":\"user\",\"sessionId\":\"{parent_id}\",\"timestamp\":\"2026-08-05T10:00:00Z\",\"message\":{{\"content\":\"Recent child\"}}}}\n"),
        )
        .unwrap();
        let mut cache = ClaudeDiscoveryCache::default();
        let sessions = discover_claude_from_roots_cached(&projects_root, None, since, &mut cache);
        let grouped = group_and_filter(sessions, 0, &AiSessionSettings::default());
        assert_eq!(grouped.len(), 1);
        assert_eq!(grouped[0].children.len(), 1);
        assert_eq!(grouped[0].children[0].origin, "cli");
        assert_eq!(cache.transcripts.len(), 2);

        fs::remove_file(&child).unwrap();
        let sessions = discover_claude_from_roots_cached(&projects_root, None, since, &mut cache);
        assert!(sessions.is_empty());
        assert!(cache.transcripts.is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn excludes_archived_claude_sessions_using_desktop_markers() {
        let directory = fixture_dir("claude-archived");
        let projects_root = directory.join("projects");
        let project = projects_root.join("project-a");
        let desktop_sessions_root = directory.join("claude-code-sessions");
        let markers = desktop_sessions_root.join("account").join("workspace");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&markers).unwrap();

        let active_id = "11111111-1111-4111-8111-111111111111";
        let archived_id = "22222222-2222-4222-8222-222222222222";
        for id in [active_id, archived_id] {
            fs::write(
                project.join(format!("{id}.jsonl")),
                format!(
                    "{{\"type\":\"user\",\"sessionId\":\"{id}\",\"cwd\":\"/work/app\",\"timestamp\":\"2026-07-22T10:00:00Z\",\"message\":{{\"content\":\"Prompt\"}}}}\n"
                ),
            )
            .unwrap();
        }

        fs::write(
            markers.join(format!("deleted_{archived_id}")),
            "1784877664514",
        )
        .unwrap();
        fs::write(markers.join("deleted_"), "").unwrap();
        fs::write(markers.join("deleted_invalid.id"), "").unwrap();
        fs::write(
            markers.join("unrelated_11111111-1111-4111-8111-111111111111"),
            "",
        )
        .unwrap();

        let sessions = discover_claude_from_roots(&projects_root, Some(&desktop_sessions_root));
        assert!(sessions.iter().any(|session| session.id == active_id));
        assert!(!sessions.iter().any(|session| session.id == archived_id));

        fs::remove_file(markers.join(format!("deleted_{archived_id}"))).unwrap();
        let sessions = discover_claude_from_roots(&projects_root, Some(&desktop_sessions_root));
        assert!(sessions.iter().any(|session| session.id == active_id));
        assert!(sessions.iter().any(|session| session.id == archived_id));

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn discovers_claude_sessions_without_desktop_storage() {
        let directory = fixture_dir("claude-no-desktop-storage");
        let projects_root = directory.join("projects");
        let project = projects_root.join("project-a");
        let session_id = "33333333-3333-4333-8333-333333333333";
        fs::create_dir_all(&project).unwrap();
        fs::write(
            project.join(format!("{session_id}.jsonl")),
            format!(
                "{{\"type\":\"user\",\"sessionId\":\"{session_id}\",\"cwd\":\"/work/app\",\"timestamp\":\"2026-07-22T10:00:00Z\",\"message\":{{\"content\":\"Prompt\"}}}}\n"
            ),
        )
        .unwrap();

        let sessions = discover_claude_from_roots(&projects_root, None);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, session_id);

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn detects_only_unanswered_claude_user_questions() {
        let directory = fixture_dir("claude-waiting");
        let projects = directory.join("projects/project-a");
        fs::create_dir_all(&projects).unwrap();
        let path = projects.join("waiting-session.jsonl");
        let prefix = concat!(
            "{\"type\":\"user\",\"sessionId\":\"waiting-session\",\"cwd\":\"/work/app\",\"timestamp\":\"2026-07-22T10:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"Start\"}}\n",
            "{\"type\":\"assistant\",\"sessionId\":\"waiting-session\",\"timestamp\":\"2026-07-22T10:01:00Z\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"Could you clarify?\"}]}}\n",
            "{\"type\":\"assistant\",\"sessionId\":\"waiting-session\",\"timestamp\":\"2026-07-22T10:02:00Z\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"name\":\"Bash\",\"id\":\"ordinary-tool\"}]}}\n",
        );
        let request = "{\"type\":\"assistant\",\"sessionId\":\"waiting-session\",\"timestamp\":\"2026-07-22T10:03:00Z\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"name\":\"AskUserQuestion\",\"id\":\"question-tool\"}]}}\n";
        fs::write(&path, format!("{prefix}{request}{{malformed\n")).unwrap();

        assert!(
            read_claude_transcript(&path, &directory.join("projects"))
                .unwrap()
                .waiting_for_input
        );

        let answer = "{\"type\":\"user\",\"sessionId\":\"waiting-session\",\"timestamp\":\"2026-07-22T10:04:00Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"question-tool\",\"content\":\"Answered\"}]}}\n";
        fs::write(&path, format!("{prefix}{request}{answer}")).unwrap();
        assert!(
            !read_claude_transcript(&path, &directory.join("projects"))
                .unwrap()
                .waiting_for_input
        );

        fs::write(&path, prefix).unwrap();
        assert!(
            !read_claude_transcript(&path, &directory.join("projects"))
                .unwrap()
                .waiting_for_input
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn keeps_claude_waiting_until_every_question_is_answered() {
        let directory = fixture_dir("claude-multiple-waiting");
        let projects = directory.join("projects/project-a");
        fs::create_dir_all(&projects).unwrap();
        let path = projects.join("waiting-session.jsonl");
        let prompt = "{\"type\":\"user\",\"sessionId\":\"waiting-session\",\"cwd\":\"/work/app\",\"timestamp\":\"2026-07-22T10:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"Start\"}}\n";
        let first_question = "{\"type\":\"assistant\",\"sessionId\":\"waiting-session\",\"timestamp\":\"2026-07-22T10:01:00Z\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"name\":\"AskUserQuestion\",\"id\":\"first-question\"}]}}\n";
        let second_question = "{\"type\":\"assistant\",\"sessionId\":\"waiting-session\",\"timestamp\":\"2026-07-22T10:02:00Z\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"name\":\"AskUserQuestion\",\"id\":\"second-question\"}]}}\n";
        let first_answer = "{\"type\":\"user\",\"sessionId\":\"waiting-session\",\"timestamp\":\"2026-07-22T10:03:00Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"first-question\",\"content\":\"Answered\"}]}}\n";
        let second_answer = "{\"type\":\"user\",\"sessionId\":\"waiting-session\",\"timestamp\":\"2026-07-22T10:04:00Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"second-question\",\"content\":\"Answered\"}]}}\n";

        fs::write(
            &path,
            format!("{prompt}{first_question}{second_question}{first_answer}"),
        )
        .unwrap();
        assert!(
            read_claude_transcript(&path, &directory.join("projects"))
                .unwrap()
                .waiting_for_input
        );

        fs::write(
            &path,
            format!("{prompt}{first_question}{second_question}{first_answer}{second_answer}"),
        )
        .unwrap();
        assert!(
            !read_claude_transcript(&path, &directory.join("projects"))
                .unwrap()
                .waiting_for_input
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn detects_claude_running_lifecycle_with_waiting_precedence_available() {
        let directory = fixture_dir("claude-running");
        let projects = directory.join("projects/project-a");
        fs::create_dir_all(&projects).unwrap();
        let path = projects.join("running-session.jsonl");
        let prompt = concat!(
            "{\"type\":\"user\",\"sessionId\":\"running-session\",\"cwd\":\"/work/app\",\"timestamp\":\"2026-07-22T10:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"Start\"}}\n",
            "{malformed\n",
        );
        fs::write(&path, prompt).unwrap();
        assert!(
            read_claude_transcript(&path, &directory.join("projects"))
                .unwrap()
                .running
        );

        let question = "{\"type\":\"assistant\",\"sessionId\":\"running-session\",\"timestamp\":\"2026-07-22T10:01:00Z\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"name\":\"AskUserQuestion\",\"id\":\"question-tool\"}]}}\n";
        fs::write(&path, format!("{prompt}{question}")).unwrap();
        let waiting = read_claude_transcript(&path, &directory.join("projects")).unwrap();
        assert!(waiting.running);
        assert!(waiting.waiting_for_input);

        let answer = "{\"type\":\"user\",\"sessionId\":\"running-session\",\"timestamp\":\"2026-07-22T10:02:00Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"question-tool\",\"content\":\"Answered\"}]}}\n";
        fs::write(&path, format!("{prompt}{question}{answer}")).unwrap();
        let resumed = read_claude_transcript(&path, &directory.join("projects")).unwrap();
        assert!(resumed.running);
        assert!(!resumed.waiting_for_input);

        let complete = "{\"type\":\"assistant\",\"sessionId\":\"running-session\",\"timestamp\":\"2026-07-22T10:03:00Z\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"Done\"}]}}\n";
        fs::write(&path, format!("{prompt}{question}{answer}{complete}")).unwrap();
        let completed = read_claude_transcript(&path, &directory.join("projects")).unwrap();
        assert!(!completed.running);
        assert_eq!(
            completed.completed_at,
            Some(timestamp_millis(Some("2026-07-22T10:03:00Z")))
        );

        let restart = "{\"type\":\"user\",\"sessionId\":\"running-session\",\"cwd\":\"/work/app\",\"timestamp\":\"2026-07-22T10:04:00Z\",\"message\":{\"role\":\"user\",\"content\":\"Continue\"}}\n";
        fs::write(
            &path,
            format!("{prompt}{question}{answer}{complete}{restart}"),
        )
        .unwrap();
        let restarted = read_claude_transcript(&path, &directory.join("projects")).unwrap();
        assert!(restarted.running);
        assert_eq!(restarted.completed_at, None);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn ignores_claude_local_command_events_for_session_lifecycle_and_title() {
        let directory = fixture_dir("claude-local-commands");
        let projects = directory.join("projects/project-a");
        fs::create_dir_all(&projects).unwrap();
        let path = projects.join("local-command-session.jsonl");
        let local_commands = concat!(
            "{\"type\":\"user\",\"sessionId\":\"local-command-session\",\"timestamp\":\"2026-07-22T10:00:00Z\",\"message\":{\"content\":\"<local-command-caveat>metadata</local-command-caveat>\"}}\n",
            "{\"type\":\"user\",\"sessionId\":\"local-command-session\",\"timestamp\":\"2026-07-22T10:01:00Z\",\"message\":{\"content\":\"<command-name>/status</command-name>\"}}\n",
            "{\"type\":\"user\",\"sessionId\":\"local-command-session\",\"timestamp\":\"2026-07-22T10:02:00Z\",\"message\":{\"content\":\"<local-command-stdout>output</local-command-stdout>\"}}\n",
        );
        fs::write(&path, local_commands).unwrap();
        let synthetic_only = read_claude_transcript(&path, &directory.join("projects")).unwrap();
        assert!(!synthetic_only.running);
        assert_eq!(synthetic_only.completed_at, None);
        assert_eq!(synthetic_only.title, "Claude session");

        let prompt = "{\"type\":\"user\",\"sessionId\":\"local-command-session\",\"timestamp\":\"2026-07-22T10:03:00Z\",\"message\":{\"content\":\"Start real work\"}}\n";
        let complete = "{\"type\":\"assistant\",\"sessionId\":\"local-command-session\",\"timestamp\":\"2026-07-22T10:04:00Z\",\"message\":{\"stop_reason\":\"end_turn\",\"content\":[]}}\n";
        fs::write(
            &path,
            format!("{local_commands}{prompt}{complete}{local_commands}"),
        )
        .unwrap();
        let completed = read_claude_transcript(&path, &directory.join("projects")).unwrap();
        let completed_at = timestamp_millis(Some("2026-07-22T10:04:00Z"));
        assert!(!completed.running);
        assert_eq!(completed.completed_at, Some(completed_at));
        assert_eq!(completed.title, "Start real work");

        let restart = "{\"type\":\"user\",\"sessionId\":\"local-command-session\",\"timestamp\":\"2026-07-22T10:05:00Z\",\"message\":{\"content\":\"Continue real work\"}}\n";
        fs::write(
            &path,
            format!("{local_commands}{prompt}{complete}{local_commands}{restart}"),
        )
        .unwrap();
        let restarted = read_claude_transcript(&path, &directory.join("projects")).unwrap();
        assert!(restarted.running);
        assert_eq!(restarted.completed_at, None);
        assert_eq!(restarted.title, "Start real work");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn clears_task_notification_activity_when_claude_live_roster_is_empty() {
        let directory = fixture_dir("claude-stale-task-notification");
        let projects = directory.join("projects/project-a");
        fs::create_dir_all(&projects).unwrap();
        let path = projects.join("task-notification-session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"sessionId\":\"task-notification-session\",\"timestamp\":\"2026-08-10T06:51:05Z\",\"message\":{\"content\":\"Debug tests\"}}\n",
                "{\"type\":\"assistant\",\"sessionId\":\"task-notification-session\",\"timestamp\":\"2026-08-10T06:51:16Z\",\"message\":{\"stop_reason\":\"end_turn\",\"content\":[]}}\n",
                "{\"type\":\"user\",\"sessionId\":\"task-notification-session\",\"timestamp\":\"2026-08-10T06:51:46Z\",\"message\":{\"content\":\"<task-notification>background task completed</task-notification>\"}}\n",
            ),
        )
        .unwrap();
        let mut session = read_claude_transcript(&path, &directory.join("projects")).unwrap();
        assert!(session.running);

        reconcile_claude_live_states(std::slice::from_mut(&mut session), Some(&HashMap::new()));

        assert!(!session.running);
        assert!(!session.waiting_for_input);
        assert_eq!(session.completed_at, None);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn treats_claude_request_interruptions_as_idle_and_allows_restart() {
        let directory = fixture_dir("claude-interrupted");
        let projects = directory.join("projects/project-a");
        fs::create_dir_all(&projects).unwrap();
        let path = projects.join("interrupted-session.jsonl");
        let prompt = "{\"type\":\"user\",\"sessionId\":\"interrupted-session\",\"cwd\":\"/work/app\",\"timestamp\":\"2026-07-22T10:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"Start\"}}\n";
        let question = "{\"type\":\"assistant\",\"sessionId\":\"interrupted-session\",\"timestamp\":\"2026-07-22T10:01:00Z\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"tool_use\",\"content\":[{\"type\":\"tool_use\",\"name\":\"AskUserQuestion\",\"id\":\"question-tool\"}]}}\n";
        let interrupted = "{\"type\":\"user\",\"sessionId\":\"interrupted-session\",\"timestamp\":\"2026-07-22T10:02:00Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"[Request interrupted by user]\"}]}}\n";
        fs::write(&path, format!("{prompt}{question}{interrupted}")).unwrap();

        let session = read_claude_transcript(&path, &directory.join("projects")).unwrap();
        assert!(!session.running);
        assert!(!session.waiting_for_input);
        assert_eq!(session.completed_at, None);

        let restart = "{\"type\":\"user\",\"sessionId\":\"interrupted-session\",\"timestamp\":\"2026-07-22T10:03:00Z\",\"message\":{\"role\":\"user\",\"content\":\"Continue\"}}\n";
        fs::write(&path, format!("{prompt}{question}{interrupted}{restart}")).unwrap();
        assert!(
            read_claude_transcript(&path, &directory.join("projects"))
                .unwrap()
                .running
        );

        let interrupted_for_tool_use = "{\"type\":\"user\",\"sessionId\":\"interrupted-session\",\"timestamp\":\"2026-07-22T10:04:00Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"[Request interrupted by user for tool use]\"}]}}\n";
        fs::write(
            &path,
            format!("{prompt}{question}{interrupted}{restart}{interrupted_for_tool_use}"),
        )
        .unwrap();
        assert!(
            !read_claude_transcript(&path, &directory.join("projects"))
                .unwrap()
                .running
        );

        let second_restart = "{\"type\":\"user\",\"sessionId\":\"interrupted-session\",\"timestamp\":\"2026-07-22T10:05:00Z\",\"message\":{\"role\":\"user\",\"content\":\"Try again\"}}\n";
        fs::write(
            &path,
            format!(
                "{prompt}{question}{interrupted}{restart}{interrupted_for_tool_use}{second_restart}"
            ),
        )
        .unwrap();
        assert!(
            read_claude_transcript(&path, &directory.join("projects"))
                .unwrap()
                .running
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn uses_claude_event_time_without_untimestamped_metadata_touching_activity() {
        let directory = fixture_dir("claude-event-time");
        let projects = directory.join("projects/project-a");
        fs::create_dir_all(&projects).unwrap();
        let path = projects.join("event-time-session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"sessionId\":\"event-time-session\",\"timestamp\":\"2026-06-26T17:24:26.969Z\",\"message\":{\"role\":\"user\",\"content\":\"Start\"}}\n",
                "{\"type\":\"ai-title\",\"aiTitle\":\"A title without a timestamp\",\"sessionId\":\"event-time-session\"}\n",
                "{\"type\":\"mode\",\"mode\":\"plan\",\"sessionId\":\"event-time-session\"}\n",
            ),
        )
        .unwrap();

        let session = read_claude_transcript(&path, &directory.join("projects")).unwrap();
        assert_eq!(
            session.updated_at,
            timestamp_millis(Some("2026-06-26T17:24:26.969Z"))
        );
        assert!(file_millis(&path) > session.updated_at);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn falls_back_to_claude_file_time_without_valid_event_timestamps() {
        let directory = fixture_dir("claude-file-time");
        let projects = directory.join("projects/project-a");
        fs::create_dir_all(&projects).unwrap();
        let path = projects.join("file-time-session.jsonl");
        fs::write(
            &path,
            "{\"type\":\"user\",\"sessionId\":\"file-time-session\",\"timestamp\":\"invalid\",\"message\":{\"role\":\"user\",\"content\":\"Start\"}}\n",
        )
        .unwrap();

        let session = read_claude_transcript(&path, &directory.join("projects")).unwrap();
        assert!(session.updated_at > 0);
        assert_eq!(session.updated_at, file_millis(&path));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn falls_back_to_file_time_for_malformed_claude_completion_timestamp() {
        let directory = fixture_dir("claude-completion-fallback");
        let projects = directory.join("projects/project-a");
        fs::create_dir_all(&projects).unwrap();
        let path = projects.join("completed-session.jsonl");
        fs::write(
            &path,
            concat!(
                "{\"type\":\"user\",\"sessionId\":\"completed-session\",\"cwd\":\"/work/app\",\"timestamp\":\"2026-07-22T10:00:00Z\",\"message\":{\"role\":\"user\",\"content\":\"Start\"}}\n",
                "{\"type\":\"assistant\",\"sessionId\":\"completed-session\",\"timestamp\":\"invalid\",\"message\":{\"role\":\"assistant\",\"stop_reason\":\"end_turn\",\"content\":[{\"type\":\"text\",\"text\":\"Done\"}]}}\n",
            ),
        )
        .unwrap();

        let session = read_claude_transcript(&path, &directory.join("projects")).unwrap();
        assert!(!session.running);
        assert!(session.completed_at.is_some());
        fs::remove_dir_all(directory).unwrap();
    }
}
