use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use rusqlite::{params, Connection as SqliteConnection};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    thread,
};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    Emitter, LogicalPosition, LogicalSize, Manager, Rect, Webview, WebviewUrl, Window, WindowEvent,
};

use super::{db_error, get_app_setting, now_millis, set_app_setting, AppState};

pub const MAIN_TAB_ID: &str = "main";
const MAIN_WEBVIEW_LABEL: &str = "main-content";
const TAB_BAR_WEBVIEW_LABEL: &str = "tab-bar";
const TERMINAL_WEBVIEW_PREFIX: &str = "terminal-";
const TAB_BAR_HEIGHT: f64 = 25.0;
const DEFAULT_TERMINAL_TITLE: &str = "~";
const NEW_TAB_DIRECTORY_SETTING_KEY: &str = "terminal_new_tab_directory";
const NEW_PANE_DIRECTORY_SETTING_KEY: &str = "terminal_new_pane_directory";
const INACTIVE_PANE_OPACITY_SETTING_KEY: &str = "terminal_inactive_pane_opacity";
const CLOSE_TERMINALS_ON_APP_EXIT_SETTING_KEY: &str = "terminal_close_on_app_exit";
const DEFAULT_INACTIVE_PANE_OPACITY: f64 = 0.65;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    new_tab_directory: Option<String>,
    new_pane_directory: Option<String>,
    inactive_pane_opacity: f64,
    close_terminals_on_app_exit: bool,
    profile_directory: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettingsInput {
    new_tab_directory: Option<String>,
    new_pane_directory: Option<String>,
    inactive_pane_opacity: Option<f64>,
    close_terminals_on_app_exit: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTab {
    id: String,
    kind: &'static str,
    title: String,
    closable: bool,
    running: bool,
    exit_code: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTabsSnapshot {
    tabs: Vec<WorkspaceTab>,
    active_tab_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PaneNode {
    Pane {
        pane_id: String,
        title: String,
        cwd: Option<String>,
        running: bool,
        exit_code: Option<u32>,
    },
    Split {
        split_id: String,
        axis: SplitAxis,
        ratio: f64,
        first: Box<PaneNode>,
        second: Box<PaneNode>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SplitAxis {
    Columns,
    Rows,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalLayout {
    tab_id: String,
    focused_pane_id: String,
    root: PaneNode,
}

#[derive(Debug, Clone)]
struct TerminalTab {
    id: String,
    focused_pane_id: String,
    root: PaneNode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TerminalLifecycleEvent {
    Exited {
        exit_code: u32,
        signal: Option<String>,
    },
    Error {
        message: String,
    },
}

struct TerminalSession {
    generation: u64,
    process_id: Option<u32>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

struct TerminalTabsRuntime {
    tabs: Vec<TerminalTab>,
    active_tab_id: String,
    sessions: HashMap<String, TerminalSession>,
    next_generation: u64,
}

pub struct TerminalTabsState {
    runtime: Mutex<TerminalTabsRuntime>,
}

impl PaneNode {
    fn pane(pane_id: impl Into<String>, title: impl Into<String>, cwd: Option<String>) -> Self {
        Self::Pane {
            pane_id: pane_id.into(),
            title: title.into(),
            cwd,
            running: false,
            exit_code: None,
        }
    }

    fn contains_pane(&self, target: &str) -> bool {
        match self {
            Self::Pane { pane_id, .. } => pane_id == target,
            Self::Split { first, second, .. } => {
                first.contains_pane(target) || second.contains_pane(target)
            }
        }
    }

    fn first_pane_id(&self) -> &str {
        match self {
            Self::Pane { pane_id, .. } => pane_id,
            Self::Split { first, .. } => first.first_pane_id(),
        }
    }

    fn pane_ids(&self, ids: &mut Vec<String>) {
        match self {
            Self::Pane { pane_id, .. } => ids.push(pane_id.clone()),
            Self::Split { first, second, .. } => {
                first.pane_ids(ids);
                second.pane_ids(ids);
            }
        }
    }

    fn pane_count(&self) -> usize {
        match self {
            Self::Pane { .. } => 1,
            Self::Split { first, second, .. } => first.pane_count() + second.pane_count(),
        }
    }

    fn find_pane(&self, target: &str) -> Option<&PaneNode> {
        match self {
            Self::Pane { pane_id, .. } if pane_id == target => Some(self),
            Self::Pane { .. } => None,
            Self::Split { first, second, .. } => {
                first.find_pane(target).or_else(|| second.find_pane(target))
            }
        }
    }

    fn find_pane_mut(&mut self, target: &str) -> Option<&mut PaneNode> {
        match self {
            Self::Pane { pane_id, .. } if pane_id == target => Some(self),
            Self::Pane { .. } => None,
            Self::Split { first, second, .. } => {
                if first.contains_pane(target) {
                    first.find_pane_mut(target)
                } else {
                    second.find_pane_mut(target)
                }
            }
        }
    }

    fn find_split_mut(&mut self, target: &str) -> Option<&mut PaneNode> {
        if matches!(self, Self::Split { split_id, .. } if split_id == target) {
            return Some(self);
        }
        match self {
            Self::Pane { .. } => None,
            Self::Split { first, second, .. } => {
                if let Some(node) = first.find_split_mut(target) {
                    Some(node)
                } else {
                    second.find_split_mut(target)
                }
            }
        }
    }

    fn replace_pane_with_split(
        &mut self,
        target: &str,
        split_id: String,
        axis: SplitAxis,
        new_pane: PaneNode,
    ) -> bool {
        match self {
            Self::Pane { pane_id, .. } if pane_id == target => {
                let original = self.clone();
                *self = Self::Split {
                    split_id,
                    axis,
                    ratio: 0.5,
                    first: Box::new(original),
                    second: Box::new(new_pane),
                };
                true
            }
            Self::Pane { .. } => false,
            Self::Split { first, second, .. } => {
                if first.contains_pane(target) {
                    first.replace_pane_with_split(target, split_id, axis, new_pane)
                } else {
                    second.replace_pane_with_split(target, split_id, axis, new_pane)
                }
            }
        }
    }

    fn remove_pane(self, target: &str) -> (Option<PaneNode>, Option<String>) {
        match self {
            Self::Pane { pane_id, .. } if pane_id == target => (None, None),
            Self::Pane { .. } => (Some(self), None),
            Self::Split {
                split_id,
                axis,
                ratio,
                first,
                second,
            } => {
                if first.contains_pane(target) {
                    let (next_first, focus) = first.remove_pane(target);
                    match next_first {
                        Some(next_first) => (
                            Some(Self::Split {
                                split_id,
                                axis,
                                ratio,
                                first: Box::new(next_first),
                                second,
                            }),
                            focus,
                        ),
                        None => {
                            let focus = second.first_pane_id().to_string();
                            (Some(*second), Some(focus))
                        }
                    }
                } else {
                    let (next_second, focus) = second.remove_pane(target);
                    match next_second {
                        Some(next_second) => (
                            Some(Self::Split {
                                split_id,
                                axis,
                                ratio,
                                first,
                                second: Box::new(next_second),
                            }),
                            focus,
                        ),
                        None => {
                            let focus = first.first_pane_id().to_string();
                            (Some(*first), Some(focus))
                        }
                    }
                }
            }
        }
    }

    fn reset_lifecycle(&mut self) {
        match self {
            Self::Pane {
                running, exit_code, ..
            } => {
                *running = false;
                *exit_code = None;
            }
            Self::Split { first, second, .. } => {
                first.reset_lifecycle();
                second.reset_lifecycle();
            }
        }
    }

    fn any_running(&self) -> bool {
        match self {
            Self::Pane { running, .. } => *running,
            Self::Split { first, second, .. } => first.any_running() || second.any_running(),
        }
    }
}

impl TerminalTab {
    fn new(id: String, title: String) -> Self {
        Self::new_with_cwd(id, title, None)
    }

    fn new_with_cwd(id: String, title: String, cwd: Option<String>) -> Self {
        Self {
            focused_pane_id: id.clone(),
            root: PaneNode::pane(id.clone(), title, cwd),
            id,
        }
    }

    fn layout(&self) -> TerminalLayout {
        TerminalLayout {
            tab_id: self.id.clone(),
            focused_pane_id: self.focused_pane_id.clone(),
            root: self.root.clone(),
        }
    }

    fn focused_pane(&self) -> &PaneNode {
        self.root
            .find_pane(&self.focused_pane_id)
            .unwrap_or(&self.root)
    }

    fn title(&self) -> String {
        match self.focused_pane() {
            PaneNode::Pane { title, .. } => title.clone(),
            PaneNode::Split { .. } => DEFAULT_TERMINAL_TITLE.to_string(),
        }
    }

    fn exit_code(&self) -> Option<u32> {
        if self.root.any_running() {
            return None;
        }
        match self.focused_pane() {
            PaneNode::Pane { exit_code, .. } => *exit_code,
            PaneNode::Split { .. } => None,
        }
    }

    fn snapshot(&self) -> WorkspaceTab {
        WorkspaceTab {
            id: self.id.clone(),
            kind: "terminal",
            title: self.title(),
            closable: true,
            running: self.root.any_running(),
            exit_code: self.exit_code(),
        }
    }
}

impl TerminalTabsState {
    fn snapshot(&self) -> Result<WorkspaceTabsSnapshot, String> {
        let runtime = self.runtime.lock().map_err(db_error)?;
        Ok(snapshot_from_runtime(&runtime))
    }
}

fn snapshot_from_runtime(runtime: &TerminalTabsRuntime) -> WorkspaceTabsSnapshot {
    let mut tabs = Vec::with_capacity(runtime.tabs.len() + 1);
    tabs.push(WorkspaceTab {
        id: MAIN_TAB_ID.to_string(),
        kind: "main",
        title: "Inbox".to_string(),
        closable: false,
        running: true,
        exit_code: None,
    });
    tabs.extend(runtime.tabs.iter().map(TerminalTab::snapshot));
    WorkspaceTabsSnapshot {
        tabs,
        active_tab_id: runtime.active_tab_id.clone(),
    }
}

pub fn init_terminal_schema(db: &SqliteConnection) -> rusqlite::Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS terminal_tabs (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            position INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            layout_json TEXT NOT NULL DEFAULT ''
        );",
    )?;
    let has_layout: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('terminal_tabs') WHERE name = 'layout_json')",
        [],
        |row| row.get(0),
    )?;
    if !has_layout {
        db.execute(
            "ALTER TABLE terminal_tabs ADD COLUMN layout_json TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    Ok(())
}

fn load_runtime(db: &SqliteConnection) -> Result<TerminalTabsRuntime, String> {
    let mut statement = db
        .prepare(
            "SELECT id, title, layout_json FROM terminal_tabs ORDER BY position ASC, created_at ASC",
        )
        .map_err(db_error)?;
    let tabs = statement
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let title: String = row.get(1)?;
            let layout_json: String = row.get(2)?;
            let mut tab = serde_json::from_str::<TerminalLayout>(&layout_json)
                .ok()
                .filter(|layout| {
                    layout.tab_id == id && layout.root.contains_pane(&layout.focused_pane_id)
                })
                .map(|layout| TerminalTab {
                    id: layout.tab_id,
                    focused_pane_id: layout.focused_pane_id,
                    root: layout.root,
                })
                .unwrap_or_else(|| TerminalTab::new(id, title));
            tab.root.reset_lifecycle();
            Ok(tab)
        })
        .map_err(db_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_error)?;
    Ok(TerminalTabsRuntime {
        tabs,
        active_tab_id: MAIN_TAB_ID.to_string(),
        sessions: HashMap::new(),
        next_generation: 1,
    })
}

pub fn initialize_state(db: &SqliteConnection) -> Result<TerminalTabsState, String> {
    if close_terminals_on_app_exit(db) {
        db.execute("DELETE FROM terminal_tabs", [])
            .map_err(db_error)?;
    }
    Ok(TerminalTabsState {
        runtime: Mutex::new(load_runtime(db)?),
    })
}

fn terminal_webview_label(tab_id: &str) -> String {
    format!("{TERMINAL_WEBVIEW_PREFIX}{tab_id}")
}

fn content_size(window: &Window) -> Result<LogicalSize<f64>, String> {
    let scale_factor = window.scale_factor().map_err(db_error)?;
    let size = window
        .inner_size()
        .map_err(db_error)?
        .to_logical::<f64>(scale_factor);
    Ok(LogicalSize::new(
        size.width,
        (size.height - TAB_BAR_HEIGHT).max(1.0),
    ))
}

fn webview_rect(position: LogicalPosition<f64>, size: LogicalSize<f64>) -> Rect {
    Rect {
        position: position.into(),
        size: size.into(),
    }
}

fn layout_webviews(window: &Window) -> Result<(), String> {
    let scale_factor = window.scale_factor().map_err(db_error)?;
    let window_size = window
        .inner_size()
        .map_err(db_error)?
        .to_logical::<f64>(scale_factor);
    let content_height = (window_size.height - TAB_BAR_HEIGHT).max(1.0);
    let content_rect = webview_rect(
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(window_size.width, content_height),
    );
    let tab_bar_rect = webview_rect(
        LogicalPosition::new(0.0, content_height),
        LogicalSize::new(window_size.width, TAB_BAR_HEIGHT.min(window_size.height)),
    );
    for webview in window.webviews() {
        let rect = if webview.label() == TAB_BAR_WEBVIEW_LABEL {
            tab_bar_rect
        } else {
            content_rect
        };
        webview.set_bounds(rect).map_err(db_error)?;
    }
    Ok(())
}

fn add_terminal_webview(window: &Window, tab_id: &str) -> Result<(), String> {
    let label = terminal_webview_label(tab_id);
    if window
        .webviews()
        .iter()
        .any(|webview| webview.label() == label)
    {
        return Ok(());
    }
    let size = content_size(window)?;
    let url = WebviewUrl::App(
        format!("index.html?surface=terminal&tab={tab_id}")
            .parse()
            .map_err(db_error)?,
    );
    let webview = window
        .add_child(
            tauri::webview::WebviewBuilder::new(label, url),
            LogicalPosition::new(0.0, 0.0),
            size,
        )
        .map_err(db_error)?;
    webview.hide().map_err(db_error)
}

pub fn setup_workspace_window(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = tauri::window::WindowBuilder::new(app, "main")
        .title("Dev Crash Flash AI Studio")
        .inner_size(1400.0, 900.0)
        .visible(false)
        .build()?;
    let size = content_size(&window).map_err(std::io::Error::other)?;
    window.add_child(
        tauri::webview::WebviewBuilder::new(
            MAIN_WEBVIEW_LABEL,
            WebviewUrl::App("index.html?surface=main".into()),
        ),
        LogicalPosition::new(0.0, 0.0),
        size,
    )?;
    window.add_child(
        tauri::webview::WebviewBuilder::new(
            TAB_BAR_WEBVIEW_LABEL,
            WebviewUrl::App("index.html?surface=tab-bar".into()),
        ),
        LogicalPosition::new(0.0, size.height),
        LogicalSize::new(size.width, TAB_BAR_HEIGHT),
    )?;
    let (terminal_ids, active_tab_id) = {
        let state = app.state::<TerminalTabsState>();
        let runtime = state.runtime.lock().map_err(db_error)?;
        (
            runtime
                .tabs
                .iter()
                .map(|tab| tab.id.clone())
                .collect::<Vec<_>>(),
            runtime.active_tab_id.clone(),
        )
    };
    for tab_id in terminal_ids {
        add_terminal_webview(&window, &tab_id).map_err(std::io::Error::other)?;
    }
    apply_active_webview(app.handle(), &active_tab_id).map_err(std::io::Error::other)?;
    layout_webviews(&window).map_err(std::io::Error::other)?;

    let resize_window = window.clone();
    let cleanup_app = app.handle().clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. }
        ) {
            if let Err(error) = layout_webviews(&resize_window) {
                eprintln!("Could not resize workspace webviews: {error}");
            }
        } else if matches!(event, WindowEvent::Destroyed) {
            let state = cleanup_app.state::<TerminalTabsState>();
            if let Ok(mut runtime) = state.runtime.lock() {
                let pane_ids = runtime.sessions.keys().cloned().collect::<Vec<_>>();
                for pane_id in pane_ids {
                    terminate_session(&mut runtime, &pane_id);
                }
            };
        }
    });
    window.show()?;
    Ok(())
}

fn validate_management_caller(webview: &Webview) -> Result<(), String> {
    if management_label_allowed(webview.label()) {
        Ok(())
    } else {
        Err("This webview cannot manage workspace tabs.".to_string())
    }
}

fn management_label_allowed(label: &str) -> bool {
    label == MAIN_WEBVIEW_LABEL
        || label == TAB_BAR_WEBVIEW_LABEL
        || label.starts_with(TERMINAL_WEBVIEW_PREFIX)
}

fn validate_terminal_caller(webview: &Webview, tab_id: &str) -> Result<(), String> {
    if terminal_label_matches(webview.label(), tab_id) {
        Ok(())
    } else {
        Err("Terminal commands must target the calling terminal tab.".to_string())
    }
}

fn validate_pane(runtime: &TerminalTabsRuntime, tab_id: &str, pane_id: &str) -> Result<(), String> {
    let tab = runtime
        .tabs
        .iter()
        .find(|tab| tab.id == tab_id)
        .ok_or_else(|| "Unknown terminal tab.".to_string())?;
    if tab.root.contains_pane(pane_id) {
        Ok(())
    } else {
        Err("Unknown terminal pane.".to_string())
    }
}

fn terminal_label_matches(label: &str, tab_id: &str) -> bool {
    label == terminal_webview_label(tab_id)
}

fn persist_tabs(app: &tauri::AppHandle, runtime: &TerminalTabsRuntime) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut db = state.db.lock().map_err(db_error)?;
    let transaction = db.transaction().map_err(db_error)?;
    transaction
        .execute("DELETE FROM terminal_tabs", [])
        .map_err(db_error)?;
    let now = now_millis();
    for (position, tab) in runtime.tabs.iter().enumerate() {
        let layout_json = serde_json::to_string(&tab.layout()).map_err(db_error)?;
        transaction.execute(
            "INSERT INTO terminal_tabs (id, title, position, created_at, updated_at, layout_json)
             VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
            params![tab.id, tab.title(), position as i64, now, layout_json],
        ).map_err(db_error)?;
    }
    transaction.commit().map_err(db_error)
}

fn emit_snapshot(app: &tauri::AppHandle, snapshot: &WorkspaceTabsSnapshot) {
    let _ = app.emit_to(TAB_BAR_WEBVIEW_LABEL, "workspace-tabs-changed", snapshot);
}

fn emit_layout(app: &tauri::AppHandle, layout: &TerminalLayout) {
    let _ = app.emit_to(
        terminal_webview_label(&layout.tab_id),
        "terminal-layout-changed",
        layout,
    );
}

fn apply_active_webview(app: &tauri::AppHandle, tab_id: &str) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "The main window is unavailable.".to_string())?;
    let active_label = if tab_id == MAIN_TAB_ID {
        MAIN_WEBVIEW_LABEL.to_string()
    } else {
        terminal_webview_label(tab_id)
    };
    for webview in window.webviews() {
        if webview.label() == TAB_BAR_WEBVIEW_LABEL {
            continue;
        }
        if webview.label() == active_label {
            webview.show().map_err(db_error)?;
            webview.set_focus().map_err(db_error)?;
        } else {
            webview.hide().map_err(db_error)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn list_workspace_tabs(
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
) -> Result<WorkspaceTabsSnapshot, String> {
    validate_management_caller(&webview)?;
    state.snapshot()
}

#[tauri::command]
pub fn get_terminal_layout(
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
) -> Result<TerminalLayout, String> {
    validate_terminal_caller(&webview, &tab_id)?;
    let runtime = state.runtime.lock().map_err(db_error)?;
    runtime
        .tabs
        .iter()
        .find(|tab| tab.id == tab_id)
        .map(TerminalTab::layout)
        .ok_or_else(|| "Unknown terminal tab.".to_string())
}

#[tauri::command]
pub async fn create_terminal_tab(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
) -> Result<WorkspaceTabsSnapshot, String> {
    validate_management_caller(&webview)?;
    let new_tab_directory = configured_terminal_directories(&app)?.0;
    let (tab_id, snapshot) = {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        let tab_id = super::new_id("terminal_tab");
        runtime.tabs.push(TerminalTab::new_with_cwd(
            tab_id.clone(),
            DEFAULT_TERMINAL_TITLE.to_string(),
            new_tab_directory,
        ));
        runtime.active_tab_id = tab_id.clone();
        persist_tabs(&app, &runtime)?;
        (tab_id, snapshot_from_runtime(&runtime))
    };
    let window = app
        .get_window("main")
        .ok_or_else(|| "The main window is unavailable.".to_string())?;
    if let Err(error) = add_terminal_webview(&window, &tab_id) {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        runtime.tabs.retain(|tab| tab.id != tab_id);
        runtime.active_tab_id = MAIN_TAB_ID.to_string();
        let _ = persist_tabs(&app, &runtime);
        return Err(error);
    }
    apply_active_webview(&app, &tab_id)?;
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn activate_tab(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
) -> Result<WorkspaceTabsSnapshot, String> {
    validate_management_caller(&webview)?;
    let snapshot = {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        if tab_id != MAIN_TAB_ID && !runtime.tabs.iter().any(|tab| tab.id == tab_id) {
            return Err("Unknown workspace tab.".to_string());
        }
        runtime.active_tab_id = tab_id.clone();
        persist_tabs(&app, &runtime)?;
        snapshot_from_runtime(&runtime)
    };
    apply_active_webview(&app, &tab_id)?;
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn reorder_tabs(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_ids: Vec<String>,
) -> Result<WorkspaceTabsSnapshot, String> {
    validate_management_caller(&webview)?;
    let snapshot = {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        reorder_runtime_tabs(&mut runtime, &tab_ids)?;
        persist_tabs(&app, &runtime)?;
        snapshot_from_runtime(&runtime)
    };
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

fn reorder_runtime_tabs(
    runtime: &mut TerminalTabsRuntime,
    tab_ids: &[String],
) -> Result<(), String> {
    let current_ids = runtime
        .tabs
        .iter()
        .map(|tab| tab.id.clone())
        .collect::<HashSet<_>>();
    let requested_ids = tab_ids.iter().cloned().collect::<HashSet<_>>();
    if tab_ids.len() != runtime.tabs.len()
        || requested_ids.len() != tab_ids.len()
        || requested_ids != current_ids
    {
        return Err("Tab order must contain every terminal tab exactly once.".to_string());
    }
    let mut by_id = runtime
        .tabs
        .drain(..)
        .map(|tab| (tab.id.clone(), tab))
        .collect::<HashMap<_, _>>();
    runtime.tabs = tab_ids.iter().filter_map(|id| by_id.remove(id)).collect();
    Ok(())
}

fn terminate_session(runtime: &mut TerminalTabsRuntime, pane_id: &str) {
    if let Some(mut session) = runtime.sessions.remove(pane_id) {
        let _ = session.killer.kill();
    }
}

fn terminate_tab_sessions(runtime: &mut TerminalTabsRuntime, tab_id: &str) {
    let mut pane_ids = Vec::new();
    if let Some(tab) = runtime.tabs.iter().find(|tab| tab.id == tab_id) {
        tab.root.pane_ids(&mut pane_ids);
    }
    for pane_id in pane_ids {
        terminate_session(runtime, &pane_id);
    }
}

fn close_terminal_tab_inner(
    app: &tauri::AppHandle,
    state: &TerminalTabsState,
    tab_id: &str,
) -> Result<WorkspaceTabsSnapshot, String> {
    if tab_id == MAIN_TAB_ID {
        return Err("The Main tab cannot be closed.".to_string());
    }
    let (next_active, snapshot) = {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        let index = runtime
            .tabs
            .iter()
            .position(|tab| tab.id == tab_id)
            .ok_or_else(|| "Unknown terminal tab.".to_string())?;
        terminate_tab_sessions(&mut runtime, tab_id);
        runtime.tabs.remove(index);
        if runtime.active_tab_id == tab_id {
            runtime.active_tab_id = active_after_close(&runtime.tabs, index);
        }
        persist_tabs(app, &runtime)?;
        (
            runtime.active_tab_id.clone(),
            snapshot_from_runtime(&runtime),
        )
    };
    if let Some(webview) = app.get_webview(&terminal_webview_label(tab_id)) {
        webview.close().map_err(db_error)?;
    }
    apply_active_webview(app, &next_active)?;
    emit_snapshot(app, &snapshot);
    Ok(snapshot)
}

fn close_terminal_pane_inner(
    app: &tauri::AppHandle,
    state: &TerminalTabsState,
    tab_id: &str,
    pane_id: &str,
) -> Result<WorkspaceTabsSnapshot, String> {
    let close_tab = {
        let runtime = state.runtime.lock().map_err(db_error)?;
        let tab = runtime
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .ok_or_else(|| "Unknown terminal tab.".to_string())?;
        if !tab.root.contains_pane(pane_id) {
            return Err("Unknown terminal pane.".to_string());
        }
        tab.root.pane_count() == 1
    };
    if close_tab {
        return close_terminal_tab_inner(app, state, tab_id);
    }

    let (layout, snapshot) = {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        terminate_session(&mut runtime, pane_id);
        let tab = runtime
            .tabs
            .iter_mut()
            .find(|tab| tab.id == tab_id)
            .ok_or_else(|| "Unknown terminal tab.".to_string())?;
        let root = tab.root.clone();
        let (next_root, next_focus) = root.remove_pane(pane_id);
        tab.root = next_root
            .ok_or_else(|| "Cannot remove the final pane without closing its tab.".to_string())?;
        tab.focused_pane_id = next_focus.unwrap_or_else(|| tab.root.first_pane_id().to_string());
        let layout = tab.layout();
        persist_tabs(app, &runtime)?;
        (layout, snapshot_from_runtime(&runtime))
    };
    emit_layout(app, &layout);
    emit_snapshot(app, &snapshot);
    Ok(snapshot)
}

#[cfg(target_os = "macos")]
pub fn close_active_terminal(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<TerminalTabsState>();
    let target = {
        let runtime = state.runtime.lock().map_err(db_error)?;
        if runtime.active_tab_id == MAIN_TAB_ID {
            None
        } else {
            runtime
                .tabs
                .iter()
                .find(|tab| tab.id == runtime.active_tab_id)
                .map(|tab| (tab.id.clone(), tab.focused_pane_id.clone()))
        }
    };
    if let Some((tab_id, pane_id)) = target {
        close_terminal_pane_inner(app, state.inner(), &tab_id, &pane_id)?;
    }
    Ok(())
}

#[tauri::command]
pub fn close_active_terminal_pane(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
) -> Result<WorkspaceTabsSnapshot, String> {
    validate_management_caller(&webview)?;
    let target = {
        let runtime = state.runtime.lock().map_err(db_error)?;
        if runtime.active_tab_id == MAIN_TAB_ID {
            None
        } else {
            runtime
                .tabs
                .iter()
                .find(|tab| tab.id == runtime.active_tab_id)
                .map(|tab| (tab.id.clone(), tab.focused_pane_id.clone()))
        }
    };
    match target {
        Some((tab_id, pane_id)) => {
            close_terminal_pane_inner(&app, state.inner(), &tab_id, &pane_id)
        }
        None => state.snapshot(),
    }
}

#[tauri::command]
pub fn close_terminal_tab(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
) -> Result<WorkspaceTabsSnapshot, String> {
    validate_management_caller(&webview)?;
    close_terminal_tab_inner(&app, state.inner(), &tab_id)
}

#[tauri::command]
pub fn close_terminal_pane(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
    pane_id: String,
) -> Result<WorkspaceTabsSnapshot, String> {
    validate_terminal_caller(&webview, &tab_id)?;
    close_terminal_pane_inner(&app, state.inner(), &tab_id, &pane_id)
}

fn active_after_close(remaining_tabs: &[TerminalTab], removed_index: usize) -> String {
    if removed_index > 0 {
        remaining_tabs[removed_index - 1].id.clone()
    } else {
        MAIN_TAB_ID.to_string()
    }
}

fn parse_split_axis(axis: &str) -> Result<SplitAxis, String> {
    match axis {
        "columns" => Ok(SplitAxis::Columns),
        "rows" => Ok(SplitAxis::Rows),
        _ => Err("Split axis must be columns or rows.".to_string()),
    }
}

#[cfg(target_os = "macos")]
fn parse_lsof_cwd(output: &str) -> Option<PathBuf> {
    output
        .lines()
        .find_map(|line| line.strip_prefix('n'))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_dir())
}

#[cfg(target_os = "macos")]
fn process_cwd(process_id: u32) -> Option<PathBuf> {
    let process_id = process_id.to_string();
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", process_id.as_str(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_lsof_cwd(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(target_os = "linux")]
fn process_cwd(process_id: u32) -> Option<PathBuf> {
    std::fs::read_link(format!("/proc/{process_id}/cwd"))
        .ok()
        .filter(|path| path.is_absolute() && path.is_dir())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_cwd(_process_id: u32) -> Option<PathBuf> {
    None
}

#[tauri::command]
pub fn split_active_terminal(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    axis: String,
) -> Result<Option<TerminalLayout>, String> {
    validate_management_caller(&webview)?;
    let axis = parse_split_axis(&axis)?;
    let new_pane_directory = configured_terminal_directories(&app)?.1;
    let result = {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        if runtime.active_tab_id == MAIN_TAB_ID {
            None
        } else {
            let active_id = runtime.active_tab_id.clone();
            let focused_pane_id = runtime
                .tabs
                .iter()
                .find(|tab| tab.id == active_id)
                .ok_or_else(|| "Unknown active terminal tab.".to_string())?
                .focused_pane_id
                .clone();
            let live_directory = runtime
                .sessions
                .get(&focused_pane_id)
                .and_then(|session| session.process_id)
                .and_then(process_cwd)
                .map(|path| path.to_string_lossy().into_owned());
            let tab = runtime
                .tabs
                .iter_mut()
                .find(|tab| tab.id == active_id)
                .ok_or_else(|| "Unknown active terminal tab.".to_string())?;
            let current_directory = match tab.focused_pane() {
                PaneNode::Pane { cwd, .. } => cwd.clone(),
                PaneNode::Split { .. } => None,
            };
            let inherited_directory = live_directory.or(current_directory);
            if let Some(PaneNode::Pane { cwd, .. }) = tab.root.find_pane_mut(&focused_pane_id) {
                *cwd = inherited_directory.clone();
            }
            let cwd = new_pane_directory.clone().or(inherited_directory);
            let new_pane_id = super::new_id("terminal_pane");
            let replaced = tab.root.replace_pane_with_split(
                &focused_pane_id,
                super::new_id("terminal_split"),
                axis,
                PaneNode::pane(new_pane_id.clone(), DEFAULT_TERMINAL_TITLE, cwd),
            );
            if !replaced {
                return Err("The focused terminal pane no longer exists.".to_string());
            }
            tab.focused_pane_id = new_pane_id;
            let layout = tab.layout();
            persist_tabs(&app, &runtime)?;
            Some((layout, snapshot_from_runtime(&runtime)))
        }
    };
    if let Some((layout, snapshot)) = result {
        emit_layout(&app, &layout);
        emit_snapshot(&app, &snapshot);
        Ok(Some(layout))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub fn focus_terminal_pane(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
    pane_id: String,
) -> Result<TerminalLayout, String> {
    validate_terminal_caller(&webview, &tab_id)?;
    let (layout, snapshot) = {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        validate_pane(&runtime, &tab_id, &pane_id)?;
        let tab = runtime
            .tabs
            .iter_mut()
            .find(|tab| tab.id == tab_id)
            .unwrap();
        tab.focused_pane_id = pane_id;
        let layout = tab.layout();
        persist_tabs(&app, &runtime)?;
        (layout, snapshot_from_runtime(&runtime))
    };
    emit_layout(&app, &layout);
    emit_snapshot(&app, &snapshot);
    Ok(layout)
}

#[tauri::command]
pub fn resize_terminal_split(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
    split_id: String,
    ratio: f64,
) -> Result<TerminalLayout, String> {
    validate_terminal_caller(&webview, &tab_id)?;
    if !ratio.is_finite() {
        return Err("Split ratio must be finite.".to_string());
    }
    let layout = {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        let tab = runtime
            .tabs
            .iter_mut()
            .find(|tab| tab.id == tab_id)
            .ok_or_else(|| "Unknown terminal tab.".to_string())?;
        let split = tab
            .root
            .find_split_mut(&split_id)
            .ok_or_else(|| "Unknown terminal split.".to_string())?;
        let PaneNode::Split { ratio: stored, .. } = split else {
            unreachable!()
        };
        *stored = ratio.clamp(0.1, 0.9);
        let layout = tab.layout();
        persist_tabs(&app, &runtime)?;
        layout
    };
    emit_layout(&app, &layout);
    Ok(layout)
}

fn configure_terminal_environment(command: &mut CommandBuilder) {
    // The desktop app can be launched from a non-interactive parent that opts
    // out of color globally. A PTY is interactive, so do not pass those
    // suppression flags through to terminal applications.
    command.env_remove("NO_COLOR");
    command.env_remove("CLICOLOR");
    command.env_remove("CLICOLOR_FORCE");
    command.env_remove("FORCE_COLOR");
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
}

fn normalize_terminal_directory(
    home: &Path,
    value: Option<String>,
) -> Result<Option<String>, String> {
    let Some(value) = value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    let path = if value == "~" {
        home.to_path_buf()
    } else if let Some(relative) = value.strip_prefix("~/") {
        home.join(relative)
    } else {
        PathBuf::from(&value)
    };
    if !path.is_absolute() || !path.is_dir() {
        return Err(format!(
            "Terminal start directory must be an existing absolute directory: {value}"
        ));
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn configured_terminal_directories(
    app: &tauri::AppHandle,
) -> Result<(Option<String>, Option<String>), String> {
    let state = app.state::<AppState>();
    let db = state.db.lock().map_err(db_error)?;
    Ok((
        get_app_setting(&db, NEW_TAB_DIRECTORY_SETTING_KEY).map_err(db_error)?,
        get_app_setting(&db, NEW_PANE_DIRECTORY_SETTING_KEY).map_err(db_error)?,
    ))
}

fn inactive_pane_opacity(db: &SqliteConnection) -> f64 {
    get_app_setting(db, INACTIVE_PANE_OPACITY_SETTING_KEY)
        .ok()
        .flatten()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(0.2, 0.95))
        .unwrap_or(DEFAULT_INACTIVE_PANE_OPACITY)
}

fn close_terminals_on_app_exit(db: &SqliteConnection) -> bool {
    get_app_setting(db, CLOSE_TERMINALS_ON_APP_EXIT_SETTING_KEY)
        .ok()
        .flatten()
        .is_some_and(|value| value == "true")
}

#[tauri::command]
pub fn list_terminal_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<TerminalSettings, String> {
    let profile_directory = app.path().home_dir().map_err(db_error)?;
    let db = state.db.lock().map_err(db_error)?;
    Ok(TerminalSettings {
        new_tab_directory: get_app_setting(&db, NEW_TAB_DIRECTORY_SETTING_KEY).map_err(db_error)?,
        new_pane_directory: get_app_setting(&db, NEW_PANE_DIRECTORY_SETTING_KEY)
            .map_err(db_error)?,
        inactive_pane_opacity: inactive_pane_opacity(&db),
        close_terminals_on_app_exit: close_terminals_on_app_exit(&db),
        profile_directory: profile_directory.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub fn save_terminal_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    input: TerminalSettingsInput,
) -> Result<TerminalSettings, String> {
    let home = app.path().home_dir().map_err(db_error)?;
    let new_tab_directory = normalize_terminal_directory(&home, input.new_tab_directory)?;
    let new_pane_directory = normalize_terminal_directory(&home, input.new_pane_directory)?;
    let requested_opacity = input
        .inactive_pane_opacity
        .unwrap_or(DEFAULT_INACTIVE_PANE_OPACITY);
    if !requested_opacity.is_finite() {
        return Err("Inactive pane opacity must be a finite number.".to_string());
    }
    let inactive_pane_opacity = requested_opacity.clamp(0.2, 0.95);
    {
        let db = state.db.lock().map_err(db_error)?;
        let close_terminals_on_app_exit = input
            .close_terminals_on_app_exit
            .unwrap_or_else(|| close_terminals_on_app_exit(&db));
        set_app_setting(
            &db,
            NEW_TAB_DIRECTORY_SETTING_KEY,
            new_tab_directory.as_deref(),
        )
        .map_err(db_error)?;
        set_app_setting(
            &db,
            NEW_PANE_DIRECTORY_SETTING_KEY,
            new_pane_directory.as_deref(),
        )
        .map_err(db_error)?;
        let inactive_pane_opacity = inactive_pane_opacity.to_string();
        set_app_setting(
            &db,
            INACTIVE_PANE_OPACITY_SETTING_KEY,
            Some(&inactive_pane_opacity),
        )
        .map_err(db_error)?;
        set_app_setting(
            &db,
            CLOSE_TERMINALS_ON_APP_EXIT_SETTING_KEY,
            Some(if close_terminals_on_app_exit {
                "true"
            } else {
                "false"
            }),
        )
        .map_err(db_error)?;
    }
    let settings = list_terminal_settings(app.clone(), state)?;
    let _ = app.emit("terminal-settings-changed", &settings);
    Ok(settings)
}

fn pane_cwd(
    app: &tauri::AppHandle,
    runtime: &TerminalTabsRuntime,
    tab_id: &str,
    pane_id: &str,
) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(db_error)?;
    let tab = runtime
        .tabs
        .iter()
        .find(|tab| tab.id == tab_id)
        .ok_or_else(|| "Unknown terminal tab.".to_string())?;
    let pane = tab
        .root
        .find_pane(pane_id)
        .ok_or_else(|| "Unknown terminal pane.".to_string())?;
    let PaneNode::Pane { cwd, .. } = pane else {
        unreachable!()
    };
    Ok(cwd
        .as_ref()
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_dir())
        .unwrap_or(home))
}

fn spawn_terminal_session(
    app: &tauri::AppHandle,
    state: &TerminalTabsState,
    tab_id: &str,
    pane_id: &str,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
    on_event: Channel<TerminalLifecycleEvent>,
) -> Result<WorkspaceTabsSnapshot, String> {
    let cwd = {
        let runtime = state.runtime.lock().map_err(db_error)?;
        validate_pane(&runtime, tab_id, pane_id)?;
        pane_cwd(app, &runtime, tab_id, pane_id)?
    };
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(db_error)?;
    let mut command = CommandBuilder::new_default_prog();
    configure_terminal_environment(&mut command);
    command.cwd(cwd);
    let mut child = pair.slave.spawn_command(command).map_err(db_error)?;
    let process_id = child.process_id();
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(db_error)?;
    let writer = pair.master.take_writer().map_err(db_error)?;
    let mut killer = child.clone_killer();

    let generation = {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        if let Err(error) = validate_pane(&runtime, tab_id, pane_id) {
            let _ = killer.kill();
            return Err(error);
        }
        terminate_session(&mut runtime, pane_id);
        let generation = runtime.next_generation;
        runtime.next_generation += 1;
        runtime.sessions.insert(
            pane_id.to_string(),
            TerminalSession {
                generation,
                process_id,
                master: pair.master,
                writer,
                killer,
            },
        );
        let tab = runtime
            .tabs
            .iter_mut()
            .find(|tab| tab.id == tab_id)
            .unwrap();
        if let Some(PaneNode::Pane {
            running, exit_code, ..
        }) = tab.root.find_pane_mut(pane_id)
        {
            *running = true;
            *exit_code = None;
        }
        generation
    };

    let output_channel = on_output.clone();
    let reader_event_channel = on_event.clone();
    thread::spawn(move || {
        let mut buffer = vec![0_u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if output_channel
                        .send(InvokeResponseBody::Raw(buffer[..count].to_vec()))
                        .is_err()
                    {
                        break;
                    }
                }
                Err(error) => {
                    let _ = reader_event_channel.send(TerminalLifecycleEvent::Error {
                        message: error.to_string(),
                    });
                    break;
                }
            }
        }
    });

    let wait_app = app.clone();
    let wait_tab_id = tab_id.to_string();
    let wait_pane_id = pane_id.to_string();
    thread::spawn(move || {
        let result = child.wait();
        let state = wait_app.state::<TerminalTabsState>();
        let update = {
            let Ok(mut runtime) = state.runtime.lock() else {
                return;
            };
            let is_current = runtime
                .sessions
                .get(&wait_pane_id)
                .is_some_and(|session| session.generation == generation);
            if !is_current {
                return;
            }
            runtime.sessions.remove(&wait_pane_id);
            let Some(tab) = runtime.tabs.iter_mut().find(|tab| tab.id == wait_tab_id) else {
                return;
            };
            let Some(PaneNode::Pane {
                running, exit_code, ..
            }) = tab.root.find_pane_mut(&wait_pane_id)
            else {
                return;
            };
            *running = false;
            match result {
                Ok(status) => {
                    *exit_code = Some(status.exit_code());
                    let _ = on_event.send(TerminalLifecycleEvent::Exited {
                        exit_code: status.exit_code(),
                        signal: status.signal().map(ToString::to_string),
                    });
                }
                Err(error) => {
                    *exit_code = Some(1);
                    let _ = on_event.send(TerminalLifecycleEvent::Error {
                        message: error.to_string(),
                    });
                }
            }
            (tab.layout(), snapshot_from_runtime(&runtime))
        };
        emit_layout(&wait_app, &update.0);
        emit_snapshot(&wait_app, &update.1);
    });
    let snapshot = state.snapshot()?;
    let layout = {
        let runtime = state.runtime.lock().map_err(db_error)?;
        runtime
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .unwrap()
            .layout()
    };
    emit_layout(app, &layout);
    emit_snapshot(app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub fn terminal_attach(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
    pane_id: String,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
    on_event: Channel<TerminalLifecycleEvent>,
) -> Result<WorkspaceTabsSnapshot, String> {
    validate_terminal_caller(&webview, &tab_id)?;
    spawn_terminal_session(
        &app, &state, &tab_id, &pane_id, cols, rows, on_output, on_event,
    )
}

#[tauri::command]
pub fn restart_terminal(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
    pane_id: String,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
    on_event: Channel<TerminalLifecycleEvent>,
) -> Result<WorkspaceTabsSnapshot, String> {
    validate_terminal_caller(&webview, &tab_id)?;
    spawn_terminal_session(
        &app, &state, &tab_id, &pane_id, cols, rows, on_output, on_event,
    )
}

#[tauri::command]
pub fn terminal_write(
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
    pane_id: String,
    data: String,
) -> Result<(), String> {
    validate_terminal_caller(&webview, &tab_id)?;
    let mut runtime = state.runtime.lock().map_err(db_error)?;
    validate_pane(&runtime, &tab_id, &pane_id)?;
    let session = runtime
        .sessions
        .get_mut(&pane_id)
        .ok_or_else(|| "The terminal process is not running.".to_string())?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(db_error)?;
    session.writer.flush().map_err(db_error)
}

#[tauri::command]
pub fn terminal_resize(
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    validate_terminal_caller(&webview, &tab_id)?;
    let runtime = state.runtime.lock().map_err(db_error)?;
    validate_pane(&runtime, &tab_id, &pane_id)?;
    let Some(session) = runtime.sessions.get(&pane_id) else {
        return Ok(());
    };
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(db_error)
}

#[tauri::command]
pub fn terminal_set_title(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
    pane_id: String,
    title: String,
) -> Result<WorkspaceTabsSnapshot, String> {
    validate_terminal_caller(&webview, &tab_id)?;
    let normalized = title.trim().chars().take(120).collect::<String>();
    if normalized.is_empty() {
        return state.snapshot();
    }
    let (layout, snapshot) = {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        validate_pane(&runtime, &tab_id, &pane_id)?;
        let tab = runtime
            .tabs
            .iter_mut()
            .find(|tab| tab.id == tab_id)
            .unwrap();
        let PaneNode::Pane { title, .. } = tab.root.find_pane_mut(&pane_id).unwrap() else {
            unreachable!()
        };
        *title = normalized;
        let layout = tab.layout();
        persist_tabs(&app, &runtime)?;
        (layout, snapshot_from_runtime(&runtime))
    };
    emit_layout(&app, &layout);
    emit_snapshot(&app, &snapshot);
    Ok(snapshot)
}

fn local_osc_host(host: &str) -> bool {
    if host.is_empty() || host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    ["HOST", "HOSTNAME", "COMPUTERNAME"]
        .into_iter()
        .filter_map(|name| std::env::var(name).ok())
        .any(|local| local.eq_ignore_ascii_case(host))
}

#[tauri::command]
pub fn terminal_set_cwd(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
    pane_id: String,
    host: String,
    path: String,
) -> Result<TerminalLayout, String> {
    validate_terminal_caller(&webview, &tab_id)?;
    let candidate = Path::new(&path);
    if !local_osc_host(&host) || !candidate.is_absolute() || !candidate.is_dir() {
        return Err("Terminal cwd must be an existing local absolute directory.".to_string());
    }
    let layout = {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        validate_pane(&runtime, &tab_id, &pane_id)?;
        let tab = runtime
            .tabs
            .iter_mut()
            .find(|tab| tab.id == tab_id)
            .unwrap();
        let PaneNode::Pane { cwd, .. } = tab.root.find_pane_mut(&pane_id).unwrap() else {
            unreachable!()
        };
        *cwd = Some(path);
        let layout = tab.layout();
        persist_tabs(&app, &runtime)?;
        layout
    };
    emit_layout(&app, &layout);
    Ok(layout)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime(ids: &[&str], active: &str) -> TerminalTabsRuntime {
        TerminalTabsRuntime {
            tabs: ids
                .iter()
                .map(|id| TerminalTab::new((*id).to_string(), (*id).to_string()))
                .collect(),
            active_tab_id: active.to_string(),
            sessions: HashMap::new(),
            next_generation: 1,
        }
    }

    #[test]
    fn snapshot_always_pins_main_first() {
        let snapshot = snapshot_from_runtime(&runtime(&["one", "two"], "two"));
        assert_eq!(snapshot.tabs[0].id, MAIN_TAB_ID);
        assert!(!snapshot.tabs[0].closable);
        assert_eq!(snapshot.tabs[1].id, "one");
    }

    #[test]
    fn terminal_webview_labels_are_stable_and_scoped() {
        assert_eq!(terminal_webview_label("tab-42"), "terminal-tab-42");
        assert!(management_label_allowed("main-content"));
        assert!(management_label_allowed("tab-bar"));
        assert!(management_label_allowed("terminal-tab-42"));
        assert!(!management_label_allowed("quick-capture"));
        assert!(terminal_label_matches("terminal-tab-42", "tab-42"));
        assert!(!terminal_label_matches("terminal-tab-41", "tab-42"));
    }

    #[test]
    fn reorders_terminals_only_with_a_complete_unique_id_set() {
        let mut runtime = runtime(&["one", "two", "three"], "two");
        reorder_runtime_tabs(&mut runtime, &["three".into(), "one".into(), "two".into()]).unwrap();
        assert_eq!(
            runtime
                .tabs
                .iter()
                .map(|tab| tab.id.as_str())
                .collect::<Vec<_>>(),
            vec!["three", "one", "two"]
        );
        assert!(reorder_runtime_tabs(&mut runtime, &["one".into()]).is_err());
    }

    #[test]
    fn close_fallback_selects_the_left_terminal_or_main() {
        let runtime = runtime(&["one", "two"], "two");
        assert_eq!(active_after_close(&runtime.tabs[..1], 1), "one");
        assert_eq!(active_after_close(&runtime.tabs[1..], 0), MAIN_TAB_ID);
    }

    #[test]
    fn splits_only_the_target_and_collapses_to_its_sibling() {
        let mut root = PaneNode::pane("one", "~", Some("/tmp".into()));
        assert!(root.replace_pane_with_split(
            "one",
            "split-a".into(),
            SplitAxis::Columns,
            PaneNode::pane("two", "~", Some("/tmp".into()))
        ));
        assert!(root.replace_pane_with_split(
            "two",
            "split-b".into(),
            SplitAxis::Rows,
            PaneNode::pane("three", "~", None)
        ));
        assert_eq!(root.pane_count(), 3);
        let (root, focus) = root.remove_pane("three");
        let root = root.unwrap();
        assert_eq!(root.pane_count(), 2);
        assert_eq!(focus.as_deref(), Some("two"));
    }

    #[test]
    fn snapshot_uses_focused_title_and_aggregate_running_state() {
        let mut tab = TerminalTab::new("tab".into(), "first".into());
        tab.root.replace_pane_with_split(
            "tab",
            "split".into(),
            SplitAxis::Columns,
            PaneNode::pane("second", "Second", None),
        );
        tab.focused_pane_id = "second".into();
        let PaneNode::Pane { running, .. } = tab.root.find_pane_mut("tab").unwrap() else {
            unreachable!()
        };
        *running = true;
        let snapshot = tab.snapshot();
        assert_eq!(snapshot.title, "Second");
        assert!(snapshot.running);
        assert_eq!(snapshot.exit_code, None);
    }

    #[test]
    fn terminal_environment_advertises_256_colors_and_truecolor() {
        let mut command = CommandBuilder::new_default_prog();
        configure_terminal_environment(&mut command);
        assert_eq!(
            command.get_env("TERM"),
            Some(std::ffi::OsStr::new("xterm-256color"))
        );
        assert_eq!(
            command.get_env("COLORTERM"),
            Some(std::ffi::OsStr::new("truecolor"))
        );
        assert_eq!(command.get_env("NO_COLOR"), None);
        assert_eq!(command.get_env("CLICOLOR"), None);
        assert_eq!(command.get_env("CLICOLOR_FORCE"), None);
        assert_eq!(command.get_env("FORCE_COLOR"), None);
    }

    #[test]
    fn terminal_directory_settings_support_defaults_home_expansion_and_absolute_paths() {
        let home = std::env::temp_dir();
        assert_eq!(normalize_terminal_directory(&home, None).unwrap(), None);
        assert_eq!(
            normalize_terminal_directory(&home, Some("  ".into())).unwrap(),
            None
        );
        assert_eq!(
            normalize_terminal_directory(&home, Some("~".into())).unwrap(),
            Some(home.to_string_lossy().into_owned())
        );
        assert_eq!(
            normalize_terminal_directory(&home, Some(home.to_string_lossy().into_owned())).unwrap(),
            Some(home.to_string_lossy().into_owned())
        );
        assert!(normalize_terminal_directory(&home, Some("relative/path".into())).is_err());
    }

    #[test]
    fn inactive_pane_opacity_uses_a_default_and_clamps_saved_values() {
        let db = SqliteConnection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .unwrap();

        assert_eq!(inactive_pane_opacity(&db), DEFAULT_INACTIVE_PANE_OPACITY);

        set_app_setting(&db, INACTIVE_PANE_OPACITY_SETTING_KEY, Some("0.5")).unwrap();
        assert_eq!(inactive_pane_opacity(&db), 0.5);

        set_app_setting(&db, INACTIVE_PANE_OPACITY_SETTING_KEY, Some("0.1")).unwrap();
        assert_eq!(inactive_pane_opacity(&db), 0.2);

        set_app_setting(&db, INACTIVE_PANE_OPACITY_SETTING_KEY, Some("invalid")).unwrap();
        assert_eq!(inactive_pane_opacity(&db), DEFAULT_INACTIVE_PANE_OPACITY);
    }

    #[test]
    fn close_on_exit_setting_clears_restored_terminal_tabs() {
        let db = SqliteConnection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        init_terminal_schema(&db).unwrap();
        db.execute("INSERT INTO terminal_tabs (id, title, position, created_at, updated_at) VALUES ('one', '~', 0, 1, 1)", []).unwrap();

        assert!(!close_terminals_on_app_exit(&db));
        assert_eq!(
            initialize_state(&db)
                .unwrap()
                .runtime
                .into_inner()
                .unwrap()
                .tabs
                .len(),
            1
        );

        set_app_setting(&db, CLOSE_TERMINALS_ON_APP_EXIT_SETTING_KEY, Some("true")).unwrap();
        let state = initialize_state(&db).unwrap();
        assert!(state.runtime.into_inner().unwrap().tabs.is_empty());
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM terminal_tabs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn legacy_schema_migrates_and_restores_a_single_pane() {
        let db = SqliteConnection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE terminal_tabs (id TEXT PRIMARY KEY, title TEXT NOT NULL, position INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);").unwrap();
        db.execute("INSERT INTO terminal_tabs (id, title, position, created_at, updated_at) VALUES ('two', 'Second', 1, 1, 1), ('one', 'First', 0, 1, 1)", []).unwrap();
        init_terminal_schema(&db).unwrap();
        let loaded = load_runtime(&db).unwrap();
        assert_eq!(
            loaded
                .tabs
                .iter()
                .map(|tab| tab.id.as_str())
                .collect::<Vec<_>>(),
            vec!["one", "two"]
        );
        assert_eq!(loaded.tabs[0].focused_pane_id, "one");
        assert_eq!(loaded.tabs[0].root.pane_count(), 1);
        assert_eq!(loaded.active_tab_id, MAIN_TAB_ID);
    }

    #[test]
    fn serialized_layout_restores_nested_panes_and_resets_lifecycle() {
        let db = SqliteConnection::open_in_memory().unwrap();
        init_terminal_schema(&db).unwrap();
        let mut tab = TerminalTab::new("tab".into(), "~".into());
        tab.root.replace_pane_with_split(
            "tab",
            "split".into(),
            SplitAxis::Columns,
            PaneNode::pane("pane", "Other", Some("/tmp".into())),
        );
        tab.focused_pane_id = "pane".into();
        let PaneNode::Pane { running, .. } = tab.root.find_pane_mut("pane").unwrap() else {
            unreachable!()
        };
        *running = true;
        let json = serde_json::to_string(&tab.layout()).unwrap();
        db.execute("INSERT INTO terminal_tabs (id, title, position, created_at, updated_at, layout_json) VALUES ('tab', 'Other', 0, 1, 1, ?1)", [json]).unwrap();
        let loaded = load_runtime(&db).unwrap();
        assert_eq!(loaded.tabs[0].root.pane_count(), 2);
        assert_eq!(loaded.tabs[0].focused_pane_id, "pane");
        assert!(!loaded.tabs[0].root.any_running());
    }

    #[test]
    fn layout_json_uses_frontend_camel_case_pane_fields() {
        let mut tab = TerminalTab::new("tab".into(), "~".into());
        tab.root.replace_pane_with_split(
            "tab",
            "split".into(),
            SplitAxis::Columns,
            PaneNode::pane("pane", "Other", None),
        );
        tab.focused_pane_id = "pane".into();
        let json = serde_json::to_value(tab.layout()).unwrap();
        assert_eq!(json["focusedPaneId"], "pane");
        assert_eq!(json["root"]["splitId"], "split");
        assert_eq!(json["root"]["first"]["paneId"], "tab");
        assert_eq!(json["root"]["second"]["paneId"], "pane");
        assert!(json["root"].get("split_id").is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_macos_lsof_working_directory_records() {
        let cwd = std::env::current_dir().unwrap();
        let output = format!("p42\nfcwd\nn{}\n", cwd.display());
        assert_eq!(parse_lsof_cwd(&output), Some(cwd));
        assert_eq!(parse_lsof_cwd("p42\nfcwd\n"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn reads_a_live_process_working_directory_on_macos() {
        let expected = std::env::current_dir().unwrap().canonicalize().unwrap();
        let actual = process_cwd(std::process::id())
            .expect("the current test process should expose its cwd")
            .canonicalize()
            .unwrap();
        assert_eq!(actual, expected);
    }
}
