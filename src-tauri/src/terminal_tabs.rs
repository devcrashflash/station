use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use rusqlite::{params, Connection as SqliteConnection};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    thread,
};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    Emitter, LogicalPosition, LogicalSize, Manager, Rect, Webview, WebviewUrl, Window, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

use super::{db_error, get_app_setting, now_millis, set_app_setting, AppState};

pub const MAIN_TAB_ID: &str = "main";
const MAIN_WEBVIEW_LABEL: &str = "main-content";
const TAB_BAR_WEBVIEW_LABEL: &str = "tab-bar";
const TERMINAL_WEBVIEW_LABEL: &str = "terminal-workspace";
const APP_TITLE: &str = "Station by DevCrashFlash";
const TAB_BAR_HEIGHT: f64 = 25.0;
const DEFAULT_TERMINAL_TITLE: &str = "~";
const NEW_TAB_DIRECTORY_SETTING_KEY: &str = "terminal_new_tab_directory";
const NEW_PANE_DIRECTORY_SETTING_KEY: &str = "terminal_new_pane_directory";
const INACTIVE_PANE_OPACITY_SETTING_KEY: &str = "terminal_inactive_pane_opacity";
const CLOSE_TERMINALS_ON_APP_EXIT_SETTING_KEY: &str = "terminal_close_on_app_exit";
const COPY_ON_SELECTION_SETTING_KEY: &str = "terminal_copy_on_selection";
const FONT_FAMILY_SETTING_KEY: &str = "terminal_font_family";
const FONT_WEIGHT_SETTING_KEY: &str = "terminal_font_weight";
const FONT_STYLE_SETTING_KEY: &str = "terminal_font_style";
const FONT_SIZE_SETTING_KEY: &str = "terminal_font_size";
const LINE_HEIGHT_SETTING_KEY: &str = "terminal_line_height";
const HORIZONTAL_SPACING_SETTING_KEY: &str = "terminal_horizontal_spacing";
const SCROLLBACK_LINES_SETTING_KEY: &str = "terminal_scrollback_lines";
const SHORTCUTS_SETTING_KEY: &str = "terminal_shortcuts";
const DEFAULT_INACTIVE_PANE_OPACITY: f64 = 0.65;
const DEFAULT_FONT_FAMILY: &str =
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
const DEFAULT_FONT_SIZE: f64 = 13.0;
const DEFAULT_LINE_HEIGHT: f64 = 100.0;
const DEFAULT_HORIZONTAL_SPACING: f64 = 100.0;
const DEFAULT_SCROLLBACK_LINES: u32 = 10_000;
const MAX_SCROLLBACK_LINES: u32 = 100_000;
const MAX_DETACHED_OUTPUT_BYTES: usize = 1024 * 1024;
const DETACHED_OUTPUT_TRUNCATED_NOTICE: &[u8] =
    b"\x1bc\r\n\x1b[33m[Earlier background terminal output was truncated.]\x1b[0m\r\n";
const DEFAULT_FONT_WEIGHT: u16 = 400;
const DEFAULT_FONT_STYLE: &str = "normal";
const PREFERRED_FONT_FAMILIES: [&str; 5] = [
    "SF Mono",
    "Menlo",
    "Consolas",
    "DejaVu Sans Mono",
    "Liberation Mono",
];

static TERMINAL_FONT_CATALOG: OnceLock<Vec<TerminalFontFamily>> = OnceLock::new();

fn app_window_title() -> String {
    format!("{APP_TITLE} ({})", env!("CARGO_PKG_VERSION"))
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalFontStyle {
    id: String,
    label: String,
    weight: u16,
    italic: bool,
    postscript_name: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalFontFamily {
    family: String,
    styles: Vec<TerminalFontStyle>,
}

#[derive(Debug, Clone)]
struct FontFaceCandidate {
    family: String,
    postscript_name: String,
    weight: u16,
    italic: bool,
    monospaced: bool,
}

#[cfg(target_os = "macos")]
const TERMINAL_BASE_PATH: &str = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
#[cfg(target_os = "linux")]
const TERMINAL_BASE_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettings {
    new_tab_directory: Option<String>,
    new_pane_directory: Option<String>,
    inactive_pane_opacity: f64,
    close_terminals_on_app_exit: bool,
    copy_on_selection: bool,
    font_family: String,
    font_face: Option<String>,
    font_weight: u16,
    font_style: String,
    font_size: f64,
    line_height: f64,
    horizontal_spacing: f64,
    scrollback_lines: u32,
    shortcuts: TerminalShortcuts,
    profile_directory: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalShortcuts {
    split_columns: String,
    split_rows: String,
    search: String,
    clear: String,
    zoom_in: String,
    zoom_out: String,
}

impl Default for TerminalShortcuts {
    fn default() -> Self {
        Self {
            split_columns: "CommandOrControl+KeyD".into(),
            split_rows: "CommandOrControl+Shift+KeyD".into(),
            search: "CommandOrControl+KeyF".into(),
            clear: "Super+KeyK".into(),
            zoom_in: "CommandOrControl+Equal".into(),
            zoom_out: "CommandOrControl+Minus".into(),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSettingsInput {
    new_tab_directory: Option<String>,
    new_pane_directory: Option<String>,
    inactive_pane_opacity: Option<f64>,
    close_terminals_on_app_exit: Option<bool>,
    copy_on_selection: Option<bool>,
    font_family: Option<String>,
    font_weight: Option<u16>,
    font_style: Option<String>,
    font_size: Option<f64>,
    line_height: Option<f64>,
    horizontal_spacing: Option<f64>,
    scrollback_lines: Option<i64>,
    shortcuts: Option<TerminalShortcuts>,
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachmentResult {
    attachment_id: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedTerminalPath {
    index: usize,
    path: String,
}

struct TerminalAttachment {
    id: u64,
    on_output: Channel<InvokeResponseBody>,
    on_event: Channel<TerminalLifecycleEvent>,
}

#[derive(Default)]
struct DetachedOutputBuffer {
    chunks: VecDeque<Vec<u8>>,
    byte_len: usize,
    truncated: bool,
}

impl DetachedOutputBuffer {
    fn push(&mut self, chunk: Vec<u8>) {
        if chunk.is_empty() {
            return;
        }
        if chunk.len() > MAX_DETACHED_OUTPUT_BYTES {
            self.chunks.clear();
            self.byte_len = MAX_DETACHED_OUTPUT_BYTES;
            self.chunks
                .push_back(chunk[chunk.len() - MAX_DETACHED_OUTPUT_BYTES..].to_vec());
            self.truncated = true;
            return;
        }
        self.byte_len += chunk.len();
        self.chunks.push_back(chunk);
        while self.byte_len > MAX_DETACHED_OUTPUT_BYTES {
            if let Some(removed) = self.chunks.pop_front() {
                self.byte_len -= removed.len();
                self.truncated = true;
            }
        }
    }

    fn take(&mut self) -> (bool, VecDeque<Vec<u8>>) {
        let truncated = std::mem::take(&mut self.truncated);
        self.byte_len = 0;
        (truncated, std::mem::take(&mut self.chunks))
    }
}

struct TerminalSession {
    generation: u64,
    process_id: Option<u32>,
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    attachment: Option<TerminalAttachment>,
    detached_output: DetachedOutputBuffer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PaneProcess {
    tab_id: String,
    pane_id: String,
    process_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessInfo {
    process_id: u32,
    parent_process_id: u32,
    command: String,
}

struct TerminalTabsRuntime {
    tabs: Vec<TerminalTab>,
    active_tab_id: String,
    sessions: HashMap<String, TerminalSession>,
    pending_input: HashMap<String, Vec<u8>>,
    startup_input_gates: HashSet<String>,
    next_generation: u64,
    next_attachment_id: u64,
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

    fn insert_pane_beside(
        &mut self,
        target: &str,
        split_id: String,
        axis: SplitAxis,
        insert_first: bool,
        pane: PaneNode,
    ) -> bool {
        match self {
            Self::Pane { pane_id, .. } if pane_id == target => {
                let target_pane = self.clone();
                let (first, second) = if insert_first {
                    (pane, target_pane)
                } else {
                    (target_pane, pane)
                };
                *self = Self::Split {
                    split_id,
                    axis,
                    ratio: 0.5,
                    first: Box::new(first),
                    second: Box::new(second),
                };
                true
            }
            Self::Pane { .. } => false,
            Self::Split { first, second, .. } => {
                if first.contains_pane(target) {
                    first.insert_pane_beside(target, split_id, axis, insert_first, pane)
                } else {
                    second.insert_pane_beside(target, split_id, axis, insert_first, pane)
                }
            }
        }
    }

    fn move_pane(
        &mut self,
        source: &str,
        target: &str,
        split_id: String,
        axis: SplitAxis,
        insert_first: bool,
    ) -> Result<(), String> {
        if source == target {
            return Err("Source and target terminal panes must be different.".to_string());
        }
        let pane = self
            .find_pane(source)
            .cloned()
            .ok_or_else(|| "Unknown source terminal pane.".to_string())?;
        if !self.contains_pane(target) {
            return Err("Unknown target terminal pane.".to_string());
        }

        let (next_root, _) = self.clone().remove_pane(source);
        let mut next_root =
            next_root.ok_or_else(|| "Cannot move the final terminal pane.".to_string())?;
        if !next_root.insert_pane_beside(target, split_id, axis, insert_first, pane) {
            return Err("The target terminal pane no longer exists.".to_string());
        }
        *self = next_root;
        Ok(())
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
        pending_input: HashMap::new(),
        startup_input_gates: HashSet::new(),
        next_generation: 1,
        next_attachment_id: 1,
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

pub fn setup_workspace_window(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let window = tauri::window::WindowBuilder::new(app, "main")
        .title(app_window_title())
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
            TERMINAL_WEBVIEW_LABEL,
            WebviewUrl::App("index.html?surface=terminal".into()),
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
    let active_tab_id = {
        let state = app.state::<TerminalTabsState>();
        let runtime = state.runtime.lock().map_err(db_error)?;
        runtime.active_tab_id.clone()
    };
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
        } else if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            cleanup_app.exit(0);
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
    label == MAIN_WEBVIEW_LABEL || label == TAB_BAR_WEBVIEW_LABEL || label == TERMINAL_WEBVIEW_LABEL
}

fn quick_capture_label_allowed(label: &str) -> bool {
    label == "quick-capture"
}

fn ai_session_terminal_label_allowed(label: &str) -> bool {
    label == MAIN_WEBVIEW_LABEL || quick_capture_label_allowed(label)
}

fn validate_terminal_caller(webview: &Webview, _tab_id: &str) -> Result<(), String> {
    if webview.label() == TERMINAL_WEBVIEW_LABEL {
        Ok(())
    } else {
        Err("Terminal commands must originate from the terminal workspace.".to_string())
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
    let _ = app.emit_to(TERMINAL_WEBVIEW_LABEL, "workspace-tabs-changed", snapshot);
}

fn emit_layout(app: &tauri::AppHandle, layout: &TerminalLayout) {
    let _ = app.emit_to(TERMINAL_WEBVIEW_LABEL, "terminal-layout-changed", layout);
}

fn active_content_webview_label(tab_id: &str) -> &'static str {
    if tab_id == MAIN_TAB_ID {
        MAIN_WEBVIEW_LABEL
    } else {
        TERMINAL_WEBVIEW_LABEL
    }
}

fn apply_active_webview(app: &tauri::AppHandle, tab_id: &str) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "The main window is unavailable.".to_string())?;
    let active_label = active_content_webview_label(tab_id);
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
    defer_input: bool,
    cwd: Option<String>,
) -> Result<WorkspaceTabsSnapshot, String> {
    validate_management_caller(&webview)?;
    create_terminal_tab_inner(&app, &state, defer_input, cwd)
}

fn create_terminal_tab_inner(
    app: &tauri::AppHandle,
    state: &TerminalTabsState,
    defer_input: bool,
    cwd: Option<String>,
) -> Result<WorkspaceTabsSnapshot, String> {
    let new_tab_directory = if let Some(cwd) = cwd {
        let path = PathBuf::from(&cwd);
        if !path.is_absolute() || !path.is_dir() {
            return Err(
                "The terminal working directory must be an existing absolute directory."
                    .to_string(),
            );
        }
        Some(cwd)
    } else {
        configured_terminal_directories(app)?.0
    };
    let (tab_id, snapshot) = {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        let tab_id = super::new_id("terminal_tab");
        runtime.tabs.push(TerminalTab::new_with_cwd(
            tab_id.clone(),
            DEFAULT_TERMINAL_TITLE.to_string(),
            new_tab_directory,
        ));
        if defer_input {
            runtime.startup_input_gates.insert(tab_id.clone());
        }
        runtime.active_tab_id = tab_id.clone();
        persist_tabs(app, &runtime)?;
        (tab_id, snapshot_from_runtime(&runtime))
    };
    if !defer_input {
        apply_active_webview(app, &tab_id)?;
    }
    emit_snapshot(app, &snapshot);
    Ok(snapshot)
}

fn ai_session_terminal_command(provider: &str, session_id: &str) -> Result<String, String> {
    if session_id.is_empty()
        || session_id.len() > 128
        || !session_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err("Invalid AI session identifier.".to_string());
    }

    match provider {
        "codex" => Ok(format!("codex resume {session_id}\r")),
        "claude" => Ok(format!("claude --resume {session_id}\r")),
        _ => Err("Unsupported AI session provider.".to_string()),
    }
}

fn parse_process_list(output: &str) -> Vec<ProcessInfo> {
    output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let process_id = fields.next()?.parse().ok()?;
            let parent_process_id = fields.next()?.parse().ok()?;
            let command = fields.collect::<Vec<_>>().join(" ");
            (!command.is_empty()).then_some(ProcessInfo {
                process_id,
                parent_process_id,
                command,
            })
        })
        .collect()
}

fn process_list() -> Option<Vec<ProcessInfo>> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,command="])
        .output()
        .ok()?;
    output
        .status
        .success()
        .then(|| parse_process_list(&String::from_utf8_lossy(&output.stdout)))
}

fn codex_cli_command(command: &str) -> bool {
    command.split_whitespace().take(3).any(|token| {
        Path::new(token)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| matches!(name, "codex" | "codex.exe" | "codex.js"))
    })
}

fn process_descends_from(process_id: u32, ancestor_id: u32, parents: &HashMap<u32, u32>) -> bool {
    let mut current = process_id;
    let mut visited = HashSet::new();
    while visited.insert(current) {
        if current == ancestor_id {
            return true;
        }
        let Some(parent) = parents.get(&current) else {
            return false;
        };
        current = *parent;
    }
    false
}

fn codex_rollout_matches_session(path: &Path, session_id: &str) -> bool {
    let components = path
        .components()
        .filter_map(|component| component.as_os_str().to_str())
        .collect::<Vec<_>>();
    let in_codex_sessions = components.windows(2).any(|window| {
        window[0] == ".codex" && matches!(window[1], "sessions" | "archived_sessions")
    });
    if !in_codex_sessions {
        return false;
    }
    let Some(stem) = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(".jsonl"))
        .and_then(|name| name.strip_prefix("rollout-"))
    else {
        return false;
    };
    let Some((_, time_and_session)) = stem.split_once('T') else {
        return false;
    };
    let mut fields = time_and_session.splitn(4, '-');
    let has_timestamp = fields.next().is_some_and(|value| value.len() == 2)
        && fields.next().is_some_and(|value| value.len() == 2)
        && fields.next().is_some_and(|value| value.len() == 2);
    has_timestamp && fields.next() == Some(session_id)
}

#[cfg(target_os = "macos")]
fn process_open_files(process_id: u32) -> Vec<PathBuf> {
    let output = std::process::Command::new("/usr/sbin/lsof")
        .args(["-p", &process_id.to_string(), "-Fn"])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.strip_prefix('n'))
        .map(PathBuf::from)
        .collect()
}

#[cfg(target_os = "linux")]
fn process_open_files(process_id: u32) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(format!("/proc/{process_id}/fd")) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| std::fs::read_link(entry.path()).ok())
        .collect()
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn process_open_files(_process_id: u32) -> Vec<PathBuf> {
    Vec::new()
}

fn find_matching_codex_pane(
    panes: &[PaneProcess],
    processes: &[ProcessInfo],
    session_id: &str,
    mut open_files: impl FnMut(u32) -> Vec<PathBuf>,
) -> Option<PaneProcess> {
    let parents = processes
        .iter()
        .map(|process| (process.process_id, process.parent_process_id))
        .collect::<HashMap<_, _>>();
    for pane in panes {
        for process in processes.iter().filter(|process| {
            codex_cli_command(&process.command)
                && process_descends_from(process.process_id, pane.process_id, &parents)
        }) {
            if open_files(process.process_id)
                .iter()
                .any(|path| codex_rollout_matches_session(path, session_id))
            {
                return Some(pane.clone());
            }
        }
    }
    None
}

fn pane_processes(runtime: &TerminalTabsRuntime) -> Vec<PaneProcess> {
    let mut panes = Vec::new();
    let mut push_pane = |tab: &TerminalTab, pane_id: &str| {
        let Some(process_id) = runtime
            .sessions
            .get(pane_id)
            .and_then(|session| session.process_id)
        else {
            return;
        };
        if !panes
            .iter()
            .any(|pane: &PaneProcess| pane.pane_id == pane_id)
        {
            panes.push(PaneProcess {
                tab_id: tab.id.clone(),
                pane_id: pane_id.to_string(),
                process_id,
            });
        }
    };

    if let Some(active) = runtime
        .tabs
        .iter()
        .find(|tab| tab.id == runtime.active_tab_id)
    {
        push_pane(active, &active.focused_pane_id);
    }
    for tab in &runtime.tabs {
        let mut pane_ids = Vec::new();
        tab.root.pane_ids(&mut pane_ids);
        for pane_id in pane_ids {
            push_pane(tab, &pane_id);
        }
    }
    panes
}

fn focus_existing_codex_session(
    app: &tauri::AppHandle,
    state: &TerminalTabsState,
    session_id: &str,
) -> Result<Option<WorkspaceTabsSnapshot>, String> {
    let panes = {
        let runtime = state.runtime.lock().map_err(db_error)?;
        pane_processes(&runtime)
    };
    let Some(processes) = process_list() else {
        return Ok(None);
    };
    let Some(found) = find_matching_codex_pane(&panes, &processes, session_id, process_open_files)
    else {
        return Ok(None);
    };

    let (layout, snapshot) = {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        if !runtime.sessions.contains_key(&found.pane_id) {
            return Ok(None);
        }
        let Some(tab_index) = runtime.tabs.iter().position(|tab| tab.id == found.tab_id) else {
            return Ok(None);
        };
        if !runtime.tabs[tab_index].root.contains_pane(&found.pane_id) {
            return Ok(None);
        }
        runtime.tabs[tab_index].focused_pane_id = found.pane_id;
        runtime.active_tab_id = found.tab_id.clone();
        persist_tabs(app, &runtime)?;
        (
            runtime.tabs[tab_index].layout(),
            snapshot_from_runtime(&runtime),
        )
    };
    apply_active_webview(app, &found.tab_id)?;
    emit_layout(app, &layout);
    emit_snapshot(app, &snapshot);
    Ok(Some(snapshot))
}

fn show_and_focus_workspace_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "The main window is unavailable.".to_string())?;
    window.show().map_err(db_error)?;
    window.unminimize().map_err(db_error)?;
    window.set_focus().map_err(db_error)
}

#[tauri::command]
pub async fn open_ai_session_terminal(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    provider: String,
    session_id: String,
    cwd: Option<String>,
) -> Result<WorkspaceTabsSnapshot, String> {
    if !ai_session_terminal_label_allowed(webview.label()) {
        return Err("This webview cannot open AI sessions in a terminal.".to_string());
    }
    let command = ai_session_terminal_command(&provider, &session_id)?;
    if provider == "codex" {
        if let Some(snapshot) = focus_existing_codex_session(&app, &state, &session_id)? {
            show_and_focus_workspace_window(&app)?;
            return Ok(snapshot);
        }
    }
    let snapshot = create_terminal_tab_inner(&app, &state, true, cwd)?;
    complete_terminal_startup_input_inner(&app, &state, &snapshot.active_tab_id, command)?;
    show_and_focus_workspace_window(&app)?;
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
        runtime.startup_input_gates.remove(tab_id);
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
        runtime.pending_input.remove(pane_id);
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

fn parse_pane_position(position: &str) -> Result<(SplitAxis, bool), String> {
    match position {
        "left" => Ok((SplitAxis::Columns, true)),
        "right" => Ok((SplitAxis::Columns, false)),
        "top" => Ok((SplitAxis::Rows, true)),
        "bottom" => Ok((SplitAxis::Rows, false)),
        _ => Err("Pane position must be left, right, top, or bottom.".to_string()),
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

#[tauri::command]
pub fn move_terminal_pane(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
    pane_id: String,
    target_pane_id: String,
    position: String,
) -> Result<TerminalLayout, String> {
    validate_terminal_caller(&webview, &tab_id)?;
    let (axis, insert_first) = parse_pane_position(&position)?;
    let (layout, snapshot) = {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        let tab = runtime
            .tabs
            .iter_mut()
            .find(|tab| tab.id == tab_id)
            .ok_or_else(|| "Unknown terminal tab.".to_string())?;
        tab.root.move_pane(
            &pane_id,
            &target_pane_id,
            super::new_id("terminal_split"),
            axis,
            insert_first,
        )?;
        tab.focused_pane_id = pane_id;
        let layout = tab.layout();
        persist_tabs(&app, &runtime)?;
        (layout, snapshot_from_runtime(&runtime))
    };
    emit_layout(&app, &layout);
    emit_snapshot(&app, &snapshot);
    Ok(layout)
}

fn configure_terminal_environment(command: &mut CommandBuilder) {
    // A terminal shell must not inherit command precedence or terminal identity
    // from whichever terminal or IDE launched the desktop app. Start Unix
    // shells from a stable system path and let their startup files add user
    // package managers and tools. Without SHELL, portable-pty resolves the
    // account's configured login shell from the OS user database.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        command.env("PATH", TERMINAL_BASE_PATH);
        command.env_remove("SHELL");

        for variable in [
            "TERM_PROGRAM",
            "TERM_PROGRAM_VERSION",
            "TERM_SESSION_ID",
            "COLORFGBG",
            "LC_TERMINAL",
            "LC_TERMINAL_VERSION",
            "ITERM_SESSION_ID",
            "ITERM_PROFILE",
        ] {
            command.env_remove(variable);
        }
    }

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

fn copy_on_selection(db: &SqliteConnection) -> bool {
    match get_app_setting(db, COPY_ON_SELECTION_SETTING_KEY)
        .ok()
        .flatten()
        .as_deref()
    {
        Some("false") => false,
        Some("true") | None => true,
        Some(_) => true,
    }
}

fn font_style_label(weight: u16, italic: bool) -> String {
    let weight_label = match weight {
        100 => "Thin".to_string(),
        200 => "Extra Light".to_string(),
        300 => "Light".to_string(),
        400 => "Regular".to_string(),
        500 => "Medium".to_string(),
        600 => "Semi Bold".to_string(),
        700 => "Bold".to_string(),
        800 => "Extra Bold".to_string(),
        900 => "Black".to_string(),
        value => format!("Weight {value}"),
    };
    if italic {
        if weight == DEFAULT_FONT_WEIGHT {
            "Italic".to_string()
        } else {
            format!("{weight_label} Italic")
        }
    } else {
        weight_label
    }
}

fn font_catalog_from_candidates(
    candidates: impl IntoIterator<Item = FontFaceCandidate>,
) -> Vec<TerminalFontFamily> {
    let mut families: BTreeMap<String, (String, BTreeMap<(u16, bool), TerminalFontStyle>)> =
        BTreeMap::new();
    for candidate in candidates {
        if !candidate.monospaced || candidate.family.trim().is_empty() {
            continue;
        }
        let family = candidate.family.trim().to_string();
        let weight = candidate.weight.clamp(100, 900);
        let family_entry = families
            .entry(family.to_lowercase())
            .or_insert_with(|| (family, BTreeMap::new()));
        family_entry
            .1
            .entry((weight, candidate.italic))
            .or_insert_with(|| TerminalFontStyle {
                id: format!(
                    "{weight}-{}",
                    if candidate.italic { "italic" } else { "normal" }
                ),
                label: font_style_label(weight, candidate.italic),
                weight,
                italic: candidate.italic,
                postscript_name: candidate.postscript_name,
            });
    }

    families
        .into_values()
        .map(|(family, styles)| {
            let mut styles = styles.into_values().collect::<Vec<_>>();
            styles.sort_by_key(|style| {
                (
                    !(style.weight == DEFAULT_FONT_WEIGHT && !style.italic),
                    style.weight,
                    style.italic,
                )
            });
            TerminalFontFamily { family, styles }
        })
        .collect()
}

fn load_terminal_font_catalog() -> Vec<TerminalFontFamily> {
    let mut database = fontdb::Database::new();
    database.load_system_fonts();
    font_catalog_from_candidates(database.faces().filter_map(|face| {
        let family = face.families.first()?.0.clone();
        Some(FontFaceCandidate {
            family,
            postscript_name: face.post_script_name.clone(),
            weight: face.weight.0,
            italic: matches!(face.style, fontdb::Style::Italic | fontdb::Style::Oblique),
            monospaced: face.monospaced,
        })
    }))
}

fn terminal_font_catalog() -> &'static [TerminalFontFamily] {
    TERMINAL_FONT_CATALOG
        .get_or_init(load_terminal_font_catalog)
        .as_slice()
}

fn catalog_family<'a>(
    catalog: &'a [TerminalFontFamily],
    requested: &str,
) -> Option<&'a TerminalFontFamily> {
    catalog
        .iter()
        .find(|entry| entry.family.eq_ignore_ascii_case(requested.trim()))
}

fn fallback_font_family(catalog: &[TerminalFontFamily]) -> Option<&TerminalFontFamily> {
    PREFERRED_FONT_FAMILIES
        .iter()
        .find_map(|preferred| catalog_family(catalog, preferred))
        .or_else(|| catalog.first())
}

fn resolve_font_selection(
    catalog: &[TerminalFontFamily],
    requested_family: Option<&str>,
    requested_weight: Option<u16>,
    requested_style: Option<&str>,
) -> (String, Option<String>, u16, String) {
    if catalog.is_empty() {
        return (
            requested_family
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(DEFAULT_FONT_FAMILY)
                .to_string(),
            None,
            requested_weight
                .unwrap_or(DEFAULT_FONT_WEIGHT)
                .clamp(100, 900),
            if requested_style == Some("italic") {
                "italic"
            } else {
                DEFAULT_FONT_STYLE
            }
            .to_string(),
        );
    }

    let family = requested_family
        .into_iter()
        .flat_map(|value| value.split(','))
        .map(|value| value.trim().trim_matches(['\'', '"']))
        .find_map(|candidate| catalog_family(catalog, candidate))
        .or_else(|| fallback_font_family(catalog))
        .expect("non-empty font catalog must have a fallback");
    let requested_italic = requested_style == Some("italic");
    let style = family
        .styles
        .iter()
        .find(|style| {
            style.weight == requested_weight.unwrap_or(DEFAULT_FONT_WEIGHT)
                && style.italic == requested_italic
        })
        .or_else(|| {
            family
                .styles
                .iter()
                .find(|style| style.weight == DEFAULT_FONT_WEIGHT && !style.italic)
        })
        .or_else(|| family.styles.first())
        .expect("font families must contain at least one style");
    (
        family.family.clone(),
        Some(style.postscript_name.clone()),
        style.weight,
        if style.italic { "italic" } else { "normal" }.to_string(),
    )
}

fn validate_font_selection(
    catalog: &[TerminalFontFamily],
    requested_family: &str,
    requested_weight: u16,
    requested_style: &str,
) -> Result<(String, Option<String>, u16, String), String> {
    if requested_style != "normal" && requested_style != "italic" {
        return Err("Terminal font style must be normal or italic.".to_string());
    }
    let family = catalog_family(catalog, requested_family).ok_or_else(|| {
        "The selected terminal font is not an installed monospaced font.".to_string()
    })?;
    let selected_style = family
        .styles
        .iter()
        .find(|style| {
            style.weight == requested_weight && style.italic == (requested_style == "italic")
        })
        .ok_or_else(|| "The selected terminal font style is not installed.".to_string())?;
    Ok((
        family.family.clone(),
        Some(selected_style.postscript_name.clone()),
        selected_style.weight,
        if selected_style.italic {
            "italic"
        } else {
            "normal"
        }
        .to_string(),
    ))
}

fn terminal_number_setting(
    db: &SqliteConnection,
    key: &str,
    default: f64,
    min: f64,
    max: f64,
) -> f64 {
    get_app_setting(db, key)
        .ok()
        .flatten()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| value.clamp(min, max))
        .unwrap_or(default)
}

fn terminal_percentage_setting(db: &SqliteConnection, key: &str, default: f64) -> f64 {
    get_app_setting(db, key)
        .ok()
        .flatten()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| if value <= 2.0 { value * 100.0 } else { value })
        .map(|value| value.clamp(100.0, 200.0).round())
        .unwrap_or(default)
}

fn terminal_line_height(db: &SqliteConnection) -> f64 {
    terminal_percentage_setting(db, LINE_HEIGHT_SETTING_KEY, DEFAULT_LINE_HEIGHT)
}

fn terminal_horizontal_spacing(db: &SqliteConnection) -> f64 {
    terminal_percentage_setting(
        db,
        HORIZONTAL_SPACING_SETTING_KEY,
        DEFAULT_HORIZONTAL_SPACING,
    )
}

fn terminal_scrollback_lines(db: &SqliteConnection) -> u32 {
    get_app_setting(db, SCROLLBACK_LINES_SETTING_KEY)
        .ok()
        .flatten()
        .and_then(|value| value.parse::<i64>().ok())
        .map(|value| value.clamp(0, MAX_SCROLLBACK_LINES as i64) as u32)
        .unwrap_or(DEFAULT_SCROLLBACK_LINES)
}

#[tauri::command]
pub fn list_terminal_fonts() -> Vec<TerminalFontFamily> {
    terminal_font_catalog().to_vec()
}

fn terminal_shortcut_signature(shortcut: &str) -> Option<String> {
    let mut control = false;
    let mut alt = false;
    let mut shift = false;
    let mut meta = false;
    let mut primary = false;
    let mut code = None;
    for token in shortcut
        .split('+')
        .map(str::trim)
        .filter(|token| !token.is_empty())
    {
        match token.to_ascii_lowercase().as_str() {
            "control" | "ctrl" => control = true,
            "alt" | "option" => alt = true,
            "shift" => shift = true,
            "super" | "command" | "cmd" => meta = true,
            "commandorcontrol" | "commandorctrl" | "cmdorcontrol" | "cmdorctrl" => primary = true,
            _ if code.is_none() => code = Some(token.to_ascii_lowercase()),
            _ => return None,
        }
    }
    let code = code?;
    if !control && !alt && !meta && !primary {
        return None;
    }
    #[cfg(target_os = "macos")]
    {
        meta |= primary;
    }
    #[cfg(not(target_os = "macos"))]
    {
        control |= primary;
    }
    Some(format!(
        "{}{}{}{}:{code}",
        u8::from(control),
        u8::from(alt),
        u8::from(shift),
        u8::from(meta)
    ))
}

fn terminal_shortcut_entries(shortcuts: &TerminalShortcuts) -> [(&'static str, &str); 6] {
    [
        ("Split pane right", &shortcuts.split_columns),
        ("Split pane down", &shortcuts.split_rows),
        ("Search terminal output", &shortcuts.search),
        ("Clear terminal", &shortcuts.clear),
        ("Increase font size", &shortcuts.zoom_in),
        ("Decrease font size", &shortcuts.zoom_out),
    ]
}

fn validate_terminal_shortcuts(shortcuts: &TerminalShortcuts) -> Result<(), String> {
    let mut seen = HashMap::new();
    for (label, shortcut) in terminal_shortcut_entries(shortcuts) {
        let signature = terminal_shortcut_signature(shortcut)
            .ok_or_else(|| format!("Invalid shortcut for {label}."))?;
        if let Some(other) = seen.insert(signature, label) {
            return Err(format!("{label} uses the same shortcut as {other}."));
        }
    }

    let reserved =
        ["KeyT", "KeyW"]
            .into_iter()
            .map(|code| terminal_shortcut_signature(&format!("CommandOrControl+{code}")))
            .chain((0..=9).map(|number| {
                terminal_shortcut_signature(&format!("CommandOrControl+Digit{number}"))
            }))
            .flatten()
            .collect::<HashSet<_>>();
    for (label, shortcut) in terminal_shortcut_entries(shortcuts) {
        if terminal_shortcut_signature(shortcut).is_some_and(|value| reserved.contains(&value)) {
            return Err(format!(
                "{label} cannot replace Cmd/Ctrl+T, Cmd/Ctrl+W, or Cmd/Ctrl+0–9."
            ));
        }
    }
    Ok(())
}

fn terminal_shortcuts(db: &SqliteConnection) -> TerminalShortcuts {
    let defaults = TerminalShortcuts::default();
    let Ok(Some(stored)) = get_app_setting(db, SHORTCUTS_SETTING_KEY) else {
        return defaults;
    };
    let Ok(serde_json::Value::Object(values)) = serde_json::from_str(&stored) else {
        return defaults;
    };
    let valid_or = |key: &str, fallback: &str| {
        values
            .get(key)
            .and_then(serde_json::Value::as_str)
            .filter(|value| terminal_shortcut_signature(value).is_some())
            .unwrap_or(fallback)
            .to_string()
    };
    let shortcuts = TerminalShortcuts {
        split_columns: valid_or("splitColumns", &defaults.split_columns),
        split_rows: valid_or("splitRows", &defaults.split_rows),
        search: valid_or("search", &defaults.search),
        clear: valid_or("clear", &defaults.clear),
        zoom_in: valid_or("zoomIn", &defaults.zoom_in),
        zoom_out: valid_or("zoomOut", &defaults.zoom_out),
    };
    validate_terminal_shortcuts(&shortcuts).map_or(defaults, |_| shortcuts)
}

#[tauri::command]
pub fn list_terminal_settings(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<TerminalSettings, String> {
    let profile_directory = app.path().home_dir().map_err(db_error)?;
    let db = state.db.lock().map_err(db_error)?;
    let stored_font_family = get_app_setting(&db, FONT_FAMILY_SETTING_KEY).map_err(db_error)?;
    let stored_font_weight = get_app_setting(&db, FONT_WEIGHT_SETTING_KEY)
        .map_err(db_error)?
        .and_then(|value| value.parse::<u16>().ok());
    let stored_font_style = get_app_setting(&db, FONT_STYLE_SETTING_KEY).map_err(db_error)?;
    let (font_family, font_face, font_weight, font_style) = resolve_font_selection(
        terminal_font_catalog(),
        stored_font_family.as_deref(),
        stored_font_weight,
        stored_font_style.as_deref(),
    );
    Ok(TerminalSettings {
        new_tab_directory: get_app_setting(&db, NEW_TAB_DIRECTORY_SETTING_KEY).map_err(db_error)?,
        new_pane_directory: get_app_setting(&db, NEW_PANE_DIRECTORY_SETTING_KEY)
            .map_err(db_error)?,
        inactive_pane_opacity: inactive_pane_opacity(&db),
        close_terminals_on_app_exit: close_terminals_on_app_exit(&db),
        copy_on_selection: copy_on_selection(&db),
        font_family,
        font_face,
        font_weight,
        font_style,
        font_size: terminal_number_setting(
            &db,
            FONT_SIZE_SETTING_KEY,
            DEFAULT_FONT_SIZE,
            8.0,
            32.0,
        ),
        line_height: terminal_line_height(&db),
        horizontal_spacing: terminal_horizontal_spacing(&db),
        scrollback_lines: terminal_scrollback_lines(&db),
        shortcuts: terminal_shortcuts(&db),
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
    let requested_font_family = input
        .font_family
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_FONT_FAMILY.to_string());
    let requested_font_weight = input.font_weight.unwrap_or(DEFAULT_FONT_WEIGHT);
    let requested_font_style = input
        .font_style
        .unwrap_or_else(|| DEFAULT_FONT_STYLE.to_string());
    let (font_family, _font_face, font_weight, font_style) = validate_font_selection(
        terminal_font_catalog(),
        &requested_font_family,
        requested_font_weight,
        &requested_font_style,
    )?;
    let requested_font_size = input.font_size.unwrap_or(DEFAULT_FONT_SIZE);
    let requested_line_height = input.line_height.unwrap_or(DEFAULT_LINE_HEIGHT);
    let requested_horizontal_spacing = input
        .horizontal_spacing
        .unwrap_or(DEFAULT_HORIZONTAL_SPACING);
    let requested_scrollback_lines = input.scrollback_lines;
    let requested_shortcuts = input.shortcuts;
    if !requested_font_size.is_finite()
        || !requested_line_height.is_finite()
        || !requested_horizontal_spacing.is_finite()
    {
        return Err("Terminal font size and spacing must be finite numbers.".to_string());
    }
    let font_size = requested_font_size.clamp(8.0, 32.0);
    let line_height = if requested_line_height <= 2.0 {
        requested_line_height * 100.0
    } else {
        requested_line_height
    }
    .clamp(100.0, 200.0)
    .round();
    let horizontal_spacing = if requested_horizontal_spacing <= 2.0 {
        requested_horizontal_spacing * 100.0
    } else {
        requested_horizontal_spacing
    }
    .clamp(100.0, 200.0)
    .round();
    {
        let db = state.db.lock().map_err(db_error)?;
        let scrollback_lines = requested_scrollback_lines
            .unwrap_or_else(|| terminal_scrollback_lines(&db) as i64)
            .clamp(0, MAX_SCROLLBACK_LINES as i64) as u32;
        let close_terminals_on_app_exit = input
            .close_terminals_on_app_exit
            .unwrap_or_else(|| close_terminals_on_app_exit(&db));
        let copy_on_selection = input
            .copy_on_selection
            .unwrap_or_else(|| copy_on_selection(&db));
        let shortcuts = requested_shortcuts.unwrap_or_else(|| terminal_shortcuts(&db));
        validate_terminal_shortcuts(&shortcuts)?;
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
        set_app_setting(
            &db,
            COPY_ON_SELECTION_SETTING_KEY,
            Some(if copy_on_selection { "true" } else { "false" }),
        )
        .map_err(db_error)?;
        set_app_setting(&db, FONT_FAMILY_SETTING_KEY, Some(&font_family)).map_err(db_error)?;
        set_app_setting(&db, FONT_WEIGHT_SETTING_KEY, Some(&font_weight.to_string()))
            .map_err(db_error)?;
        set_app_setting(&db, FONT_STYLE_SETTING_KEY, Some(&font_style)).map_err(db_error)?;
        set_app_setting(&db, FONT_SIZE_SETTING_KEY, Some(&font_size.to_string()))
            .map_err(db_error)?;
        set_app_setting(&db, LINE_HEIGHT_SETTING_KEY, Some(&line_height.to_string()))
            .map_err(db_error)?;
        set_app_setting(
            &db,
            HORIZONTAL_SPACING_SETTING_KEY,
            Some(&horizontal_spacing.to_string()),
        )
        .map_err(db_error)?;
        set_app_setting(
            &db,
            SCROLLBACK_LINES_SETTING_KEY,
            Some(&scrollback_lines.to_string()),
        )
        .map_err(db_error)?;
        let shortcuts_json = serde_json::to_string(&shortcuts).map_err(db_error)?;
        set_app_setting(&db, SHORTCUTS_SETTING_KEY, Some(&shortcuts_json)).map_err(db_error)?;
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

fn resolve_terminal_path(cwd: &Path, home: &Path, candidate: &str) -> Option<PathBuf> {
    if candidate.is_empty()
        || candidate
            .chars()
            .any(|character| character == '\0' || character.is_control())
    {
        return None;
    }

    let expanded = if candidate == "~" {
        home.to_path_buf()
    } else if let Some(relative) = candidate
        .strip_prefix("~/")
        .or_else(|| candidate.strip_prefix("~\\"))
    {
        home.join(relative)
    } else {
        PathBuf::from(candidate)
    };
    let absolute = if expanded.is_absolute() {
        expanded
    } else {
        cwd.join(expanded)
    };
    canonical_terminal_entry(&absolute)
}

fn canonical_terminal_entry(path: &Path) -> Option<PathBuf> {
    let canonical = path.canonicalize().ok()?;
    let metadata = canonical.metadata().ok()?;
    (metadata.is_file() || metadata.is_dir()).then_some(canonical)
}

#[tauri::command]
pub fn resolve_terminal_paths(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
    pane_id: String,
    candidates: Vec<String>,
) -> Result<Vec<ResolvedTerminalPath>, String> {
    validate_terminal_caller(&webview, &tab_id)?;
    let home = app.path().home_dir().map_err(db_error)?;
    let cwd = {
        let runtime = state.runtime.lock().map_err(db_error)?;
        validate_pane(&runtime, &tab_id, &pane_id)?;
        let tracked_cwd = pane_cwd(&app, &runtime, &tab_id, &pane_id)?;
        runtime
            .sessions
            .get(&pane_id)
            .and_then(|session| session.process_id)
            .and_then(process_cwd)
            .unwrap_or(tracked_cwd)
    };

    Ok(candidates
        .iter()
        .enumerate()
        .filter_map(|(index, candidate)| {
            let path = resolve_terminal_path(&cwd, &home, candidate)?;
            Some(ResolvedTerminalPath {
                index,
                path: path.to_str()?.to_string(),
            })
        })
        .collect())
}

#[tauri::command]
pub fn open_terminal_path(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
    pane_id: String,
    path: String,
) -> Result<(), String> {
    validate_terminal_caller(&webview, &tab_id)?;
    {
        let runtime = state.runtime.lock().map_err(db_error)?;
        validate_pane(&runtime, &tab_id, &pane_id)?;
    }
    let candidate = Path::new(&path);
    if !candidate.is_absolute() {
        return Err("Terminal links must resolve to an absolute local path.".to_string());
    }
    let canonical = canonical_terminal_entry(candidate)
        .ok_or_else(|| "Terminal link must be an existing file or directory.".to_string())?;
    let canonical = canonical
        .to_str()
        .ok_or_else(|| "Terminal link is not valid UTF-8.".to_string())?;
    app.opener()
        .open_path(canonical, None::<&str>)
        .map_err(|error| format!("Could not open terminal link: {error}"))
}

fn next_attachment_id(runtime: &mut TerminalTabsRuntime) -> u64 {
    let id = runtime.next_attachment_id;
    runtime.next_attachment_id += 1;
    id
}

fn attach_to_running_session(
    state: &TerminalTabsState,
    tab_id: &str,
    pane_id: &str,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
    on_event: Channel<TerminalLifecycleEvent>,
) -> Result<TerminalAttachmentResult, String> {
    let mut runtime = state.runtime.lock().map_err(db_error)?;
    validate_pane(&runtime, tab_id, pane_id)?;
    let attachment_id = next_attachment_id(&mut runtime);
    let session = runtime
        .sessions
        .get_mut(pane_id)
        .ok_or_else(|| "The terminal process is not running.".to_string())?;
    session
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(db_error)?;
    let (truncated, chunks) = session.detached_output.take();
    if truncated {
        on_output
            .send(InvokeResponseBody::Raw(
                DETACHED_OUTPUT_TRUNCATED_NOTICE.to_vec(),
            ))
            .map_err(db_error)?;
    }
    for chunk in chunks {
        on_output
            .send(InvokeResponseBody::Raw(chunk))
            .map_err(db_error)?;
    }
    session.attachment = Some(TerminalAttachment {
        id: attachment_id,
        on_output,
        on_event,
    });
    Ok(TerminalAttachmentResult { attachment_id })
}

fn route_terminal_output(
    app: &tauri::AppHandle,
    pane_id: &str,
    generation: u64,
    data: Vec<u8>,
) -> bool {
    let state = app.state::<TerminalTabsState>();
    let Ok(mut runtime) = state.runtime.lock() else {
        return false;
    };
    let Some(session) = runtime.sessions.get_mut(pane_id) else {
        return false;
    };
    if session.generation != generation {
        return false;
    }
    if let Some(attachment) = session.attachment.as_ref() {
        if attachment
            .on_output
            .send(InvokeResponseBody::Raw(data.clone()))
            .is_err()
        {
            session.attachment = None;
            session.detached_output.push(data);
        }
    } else {
        session.detached_output.push(data);
    }
    true
}

fn route_terminal_reader_error(
    app: &tauri::AppHandle,
    pane_id: &str,
    generation: u64,
    message: String,
) {
    let state = app.state::<TerminalTabsState>();
    let channel = {
        let Ok(runtime) = state.runtime.lock() else {
            return;
        };
        runtime.sessions.get(pane_id).and_then(|session| {
            if session.generation == generation {
                session
                    .attachment
                    .as_ref()
                    .map(|attachment| attachment.on_event.clone())
            } else {
                None
            }
        })
    };
    if let Some(channel) = channel {
        let _ = channel.send(TerminalLifecycleEvent::Error { message });
    }
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
) -> Result<TerminalAttachmentResult, String> {
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

    let (generation, attachment_id) = {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        if let Err(error) = validate_pane(&runtime, tab_id, pane_id) {
            let _ = killer.kill();
            return Err(error);
        }
        terminate_session(&mut runtime, pane_id);
        let generation = runtime.next_generation;
        runtime.next_generation += 1;
        let attachment_id = next_attachment_id(&mut runtime);
        runtime.sessions.insert(
            pane_id.to_string(),
            TerminalSession {
                generation,
                process_id,
                master: pair.master,
                writer,
                killer,
                attachment: Some(TerminalAttachment {
                    id: attachment_id,
                    on_output,
                    on_event,
                }),
                detached_output: DetachedOutputBuffer::default(),
            },
        );
        if !runtime.startup_input_gates.contains(tab_id) {
            if let Some(data) = runtime.pending_input.remove(pane_id) {
                let session = runtime.sessions.get_mut(pane_id).unwrap();
                session.writer.write_all(&data).map_err(db_error)?;
                session.writer.flush().map_err(db_error)?;
            }
        }
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
        (generation, attachment_id)
    };

    let reader_app = app.clone();
    let reader_pane_id = pane_id.to_string();
    thread::spawn(move || {
        let mut buffer = vec![0_u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if !route_terminal_output(
                        &reader_app,
                        &reader_pane_id,
                        generation,
                        buffer[..count].to_vec(),
                    ) {
                        break;
                    }
                }
                Err(error) => {
                    route_terminal_reader_error(
                        &reader_app,
                        &reader_pane_id,
                        generation,
                        error.to_string(),
                    );
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
        let (update, event_channel, lifecycle_event) = {
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
            let event_channel = runtime
                .sessions
                .get(&wait_pane_id)
                .and_then(|session| session.attachment.as_ref())
                .map(|attachment| attachment.on_event.clone());
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
            let lifecycle_event = match result {
                Ok(status) => {
                    *exit_code = Some(status.exit_code());
                    TerminalLifecycleEvent::Exited {
                        exit_code: status.exit_code(),
                        signal: status.signal().map(ToString::to_string),
                    }
                }
                Err(error) => {
                    *exit_code = Some(1);
                    TerminalLifecycleEvent::Error {
                        message: error.to_string(),
                    }
                }
            };
            (
                (tab.layout(), snapshot_from_runtime(&runtime)),
                event_channel,
                lifecycle_event,
            )
        };
        if let Some(channel) = event_channel {
            let _ = channel.send(lifecycle_event);
        }
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
    Ok(TerminalAttachmentResult { attachment_id })
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
) -> Result<TerminalAttachmentResult, String> {
    validate_terminal_caller(&webview, &tab_id)?;
    let (has_session, has_exited) = {
        let runtime = state.runtime.lock().map_err(db_error)?;
        validate_pane(&runtime, &tab_id, &pane_id)?;
        let has_exited = runtime
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .and_then(|tab| tab.root.find_pane(&pane_id))
            .is_some_and(|pane| {
                matches!(
                    pane,
                    PaneNode::Pane {
                        exit_code: Some(_),
                        ..
                    }
                )
            });
        (runtime.sessions.contains_key(&pane_id), has_exited)
    };
    if has_session {
        attach_to_running_session(&state, &tab_id, &pane_id, cols, rows, on_output, on_event)
    } else if has_exited {
        Err("The terminal process has exited. Restart it explicitly to continue.".to_string())
    } else {
        spawn_terminal_session(
            &app, &state, &tab_id, &pane_id, cols, rows, on_output, on_event,
        )
    }
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
) -> Result<TerminalAttachmentResult, String> {
    validate_terminal_caller(&webview, &tab_id)?;
    spawn_terminal_session(
        &app, &state, &tab_id, &pane_id, cols, rows, on_output, on_event,
    )
}

#[tauri::command]
pub fn terminal_detach(
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
    pane_id: String,
    attachment_id: u64,
) -> Result<(), String> {
    validate_terminal_caller(&webview, &tab_id)?;
    let mut runtime = state.runtime.lock().map_err(db_error)?;
    validate_pane(&runtime, &tab_id, &pane_id)?;
    if let Some(session) = runtime.sessions.get_mut(&pane_id) {
        if session
            .attachment
            .as_ref()
            .is_some_and(|attachment| attachment.id == attachment_id)
        {
            session.attachment = None;
        }
    }
    Ok(())
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
    if runtime.startup_input_gates.contains(&tab_id) || runtime.pending_input.contains_key(&pane_id)
    {
        runtime
            .pending_input
            .entry(pane_id)
            .or_default()
            .extend_from_slice(data.as_bytes());
        return Ok(());
    }
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
pub fn complete_terminal_startup_input(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
    data: String,
) -> Result<(), String> {
    validate_management_caller(&webview)?;
    complete_terminal_startup_input_inner(&app, &state, &tab_id, data)
}

fn complete_terminal_startup_input_inner(
    app: &tauri::AppHandle,
    state: &TerminalTabsState,
    tab_id: &str,
    data: String,
) -> Result<(), String> {
    {
        let mut runtime = state.runtime.lock().map_err(db_error)?;
        let pane_id = runtime
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .map(|tab| tab.focused_pane_id.clone())
            .ok_or_else(|| "Unknown terminal tab.".to_string())?;
        if !runtime.startup_input_gates.remove(tab_id) {
            return Err("The terminal tab is not waiting for startup input.".to_string());
        }

        let mut ordered_input = data.into_bytes();
        if let Some(suffix) = runtime.pending_input.remove(&pane_id) {
            ordered_input.extend_from_slice(&suffix);
        }
        if let Some(session) = runtime.sessions.get_mut(&pane_id) {
            if !ordered_input.is_empty() {
                session.writer.write_all(&ordered_input).map_err(db_error)?;
                session.writer.flush().map_err(db_error)?;
            }
        } else {
            // Keep an empty entry as a startup marker so input arriving between
            // this handoff and terminal_attach is still queued instead of lost.
            runtime.pending_input.insert(pane_id, ordered_input);
        }
    }
    apply_active_webview(app, tab_id)
}

#[tauri::command]
pub fn terminal_surface_ready(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
    pane_id: String,
) -> Result<(), String> {
    validate_terminal_caller(&webview, &tab_id)?;
    let ready = {
        let runtime = state.runtime.lock().map_err(db_error)?;
        validate_pane(&runtime, &tab_id, &pane_id)?;
        runtime.startup_input_gates.contains(&tab_id)
            && runtime.sessions.contains_key(&pane_id)
            && runtime
                .tabs
                .iter()
                .any(|tab| tab.id == tab_id && tab.focused_pane_id == pane_id)
    };
    if ready {
        app.emit(
            "terminal-startup-ready",
            serde_json::json!({ "tabId": tab_id }),
        )
        .map_err(db_error)?;
    }
    Ok(())
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn runtime(ids: &[&str], active: &str) -> TerminalTabsRuntime {
        TerminalTabsRuntime {
            tabs: ids
                .iter()
                .map(|id| TerminalTab::new((*id).to_string(), (*id).to_string()))
                .collect(),
            active_tab_id: active.to_string(),
            sessions: HashMap::new(),
            pending_input: HashMap::new(),
            startup_input_gates: HashSet::new(),
            next_generation: 1,
            next_attachment_id: 1,
        }
    }

    #[test]
    fn restricts_ai_session_terminal_commands_to_supported_surfaces() {
        assert!(quick_capture_label_allowed("quick-capture"));
        assert!(ai_session_terminal_label_allowed("quick-capture"));
        assert!(ai_session_terminal_label_allowed(MAIN_WEBVIEW_LABEL));
        assert!(!ai_session_terminal_label_allowed(TAB_BAR_WEBVIEW_LABEL));
        assert!(!ai_session_terminal_label_allowed(TERMINAL_WEBVIEW_LABEL));
    }

    #[test]
    fn validates_ai_session_terminal_commands() {
        assert_eq!(
            ai_session_terminal_command("codex", "thread-1").unwrap(),
            "codex resume thread-1\r"
        );
        assert_eq!(
            ai_session_terminal_command("claude", "session_1").unwrap(),
            "claude --resume session_1\r"
        );
        assert_eq!(
            ai_session_terminal_command("other", "session-1").unwrap_err(),
            "Unsupported AI session provider."
        );
        assert_eq!(
            ai_session_terminal_command("codex", "bad; command").unwrap_err(),
            "Invalid AI session identifier."
        );
    }

    #[test]
    fn parses_processes_and_recognizes_codex_cli_commands() {
        let processes = parse_process_list(
            "  10 1 -fish\n  20 10 codex\n  30 10 node /opt/codex.js resume thread-1\n",
        );
        assert_eq!(processes.len(), 3);
        assert_eq!(processes[1].parent_process_id, 10);
        assert!(codex_cli_command(&processes[1].command));
        assert!(codex_cli_command(&processes[2].command));
        assert!(!codex_cli_command("/opt/codex-code-mode-host"));
    }

    #[test]
    fn matches_only_codex_rollout_paths_for_the_exact_session_suffix() {
        let matching = Path::new(
            "/Users/test/.codex/sessions/2026/08/03/rollout-2026-08-03T09-03-14-thread-1.jsonl",
        );
        assert!(codex_rollout_matches_session(matching, "thread-1"));
        assert!(!codex_rollout_matches_session(matching, "thread-2"));
        assert!(!codex_rollout_matches_session(matching, "1"));
        assert!(!codex_rollout_matches_session(
            Path::new("/tmp/rollout-2026-08-03T09-03-14-thread-1.jsonl"),
            "thread-1"
        ));
    }

    #[test]
    fn finds_a_matching_codex_process_below_the_preferred_pane_shell() {
        let panes = vec![
            PaneProcess {
                tab_id: "active".into(),
                pane_id: "active-pane".into(),
                process_id: 10,
            },
            PaneProcess {
                tab_id: "other".into(),
                pane_id: "other-pane".into(),
                process_id: 40,
            },
        ];
        let processes = parse_process_list(
            "10 1 -fish\n20 10 codex\n40 1 -fish\n50 40 codex resume thread-1\n",
        );
        let rollout = || {
            vec![PathBuf::from(
                "/home/test/.codex/sessions/2026/08/03/rollout-2026-08-03T09-03-14-thread-1.jsonl",
            )]
        };
        let preferred =
            find_matching_codex_pane(&panes, &processes, "thread-1", |_| rollout()).unwrap();
        assert_eq!(preferred.pane_id, "active-pane");

        let found = find_matching_codex_pane(&panes, &processes, "thread-1", |process_id| {
            (process_id == 50).then(&rollout).unwrap_or_default()
        })
        .unwrap();
        assert_eq!(found.pane_id, "other-pane");
    }

    #[test]
    fn resolves_existing_terminal_paths_relative_to_cwd_and_home() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("devcrashflash-terminal-links-{suffix}"));
        let cwd = root.join("project");
        let home = root.join("home");
        std::fs::create_dir_all(cwd.join("src")).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(cwd.join("src/app.js"), "export default true;").unwrap();
        std::fs::write(home.join("notes.md"), "notes").unwrap();

        assert_eq!(
            resolve_terminal_path(&cwd, &home, "src/app.js"),
            Some(cwd.join("src/app.js").canonicalize().unwrap())
        );
        assert_eq!(
            resolve_terminal_path(&cwd, &home, "./src"),
            Some(cwd.join("src").canonicalize().unwrap())
        );
        assert_eq!(
            resolve_terminal_path(&cwd, &home, "~/notes.md"),
            Some(home.join("notes.md").canonicalize().unwrap())
        );
        assert_eq!(
            resolve_terminal_path(&cwd, &home, cwd.join("src/app.js").to_str().unwrap()),
            Some(cwd.join("src/app.js").canonicalize().unwrap())
        );
        assert_eq!(resolve_terminal_path(&cwd, &home, "missing.txt"), None);
        assert_eq!(resolve_terminal_path(&cwd, &home, "bad\npath"), None);

        #[cfg(unix)]
        assert_eq!(resolve_terminal_path(&cwd, &home, "/dev/null"), None);

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(cwd.join("src/app.js"), cwd.join("linked.js")).unwrap();
            assert_eq!(
                resolve_terminal_path(&cwd, &home, "linked.js"),
                Some(cwd.join("src/app.js").canonicalize().unwrap())
            );
        }

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_always_pins_main_first() {
        let snapshot = snapshot_from_runtime(&runtime(&["one", "two"], "two"));
        assert_eq!(snapshot.tabs[0].id, MAIN_TAB_ID);
        assert!(!snapshot.tabs[0].closable);
        assert_eq!(snapshot.tabs[1].id, "one");
    }

    #[test]
    fn terminal_workspace_label_is_stable_and_scoped() {
        assert!(management_label_allowed("main-content"));
        assert!(management_label_allowed("tab-bar"));
        assert!(management_label_allowed("terminal-workspace"));
        assert!(!management_label_allowed("terminal-tab-42"));
        assert!(!management_label_allowed("quick-capture"));
        assert_eq!(active_content_webview_label(MAIN_TAB_ID), "main-content");
        assert_eq!(
            active_content_webview_label("terminal-tab-42"),
            "terminal-workspace"
        );
    }

    #[test]
    fn window_title_includes_the_cargo_package_version() {
        assert_eq!(
            app_window_title(),
            format!("Station by DevCrashFlash ({})", env!("CARGO_PKG_VERSION"))
        );
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
    fn moves_panes_to_each_side_of_a_nested_target() {
        for (position, expected_axis, source_first) in [
            ("left", SplitAxis::Columns, true),
            ("right", SplitAxis::Columns, false),
            ("top", SplitAxis::Rows, true),
            ("bottom", SplitAxis::Rows, false),
        ] {
            let mut root = PaneNode::pane("one", "One", None);
            root.replace_pane_with_split(
                "one",
                "outer".into(),
                SplitAxis::Columns,
                PaneNode::pane("two", "Two", None),
            );
            root.replace_pane_with_split(
                "two",
                "inner".into(),
                SplitAxis::Rows,
                PaneNode::pane("three", "Three", None),
            );

            let (axis, insert_first) = parse_pane_position(position).unwrap();
            root.move_pane("one", "three", "moved".into(), axis, insert_first)
                .unwrap();

            assert_eq!(root.pane_count(), 3);
            let PaneNode::Split { second, .. } = &root else {
                panic!("the surviving inner split should become the root")
            };
            let PaneNode::Split {
                split_id,
                axis,
                ratio,
                first,
                second,
            } = second.as_ref()
            else {
                panic!("the source should be inserted beside the target")
            };
            assert_eq!(split_id, "moved");
            assert_eq!(*axis, expected_axis);
            assert_eq!(*ratio, 0.5);
            let mut ids = Vec::new();
            first.pane_ids(&mut ids);
            second.pane_ids(&mut ids);
            assert_eq!(
                ids,
                if source_first {
                    vec!["one".to_string(), "three".to_string()]
                } else {
                    vec!["three".to_string(), "one".to_string()]
                }
            );
        }
    }

    #[test]
    fn moving_a_sibling_can_reverse_the_split_order() {
        let mut root = PaneNode::pane("one", "One", None);
        root.replace_pane_with_split(
            "one",
            "original".into(),
            SplitAxis::Columns,
            PaneNode::pane("two", "Two", None),
        );
        root.move_pane("one", "two", "reversed".into(), SplitAxis::Columns, false)
            .unwrap();
        let mut ids = Vec::new();
        root.pane_ids(&mut ids);
        assert_eq!(ids, vec!["two", "one"]);
    }

    #[test]
    fn pane_moves_reject_invalid_sources_and_targets() {
        let mut root = PaneNode::pane("one", "One", None);
        root.replace_pane_with_split(
            "one",
            "split".into(),
            SplitAxis::Columns,
            PaneNode::pane("two", "Two", None),
        );
        assert!(root
            .move_pane("one", "one", "new".into(), SplitAxis::Rows, true)
            .is_err());
        assert!(root
            .move_pane("missing", "two", "new".into(), SplitAxis::Rows, true)
            .is_err());
        assert!(root
            .move_pane("one", "missing", "new".into(), SplitAxis::Rows, true)
            .is_err());
        assert!(parse_pane_position("center").is_err());
    }

    #[test]
    fn moved_layout_round_trips_through_persistence_json() {
        let mut tab = TerminalTab::new("tab".into(), "First".into());
        tab.root.replace_pane_with_split(
            "tab",
            "split".into(),
            SplitAxis::Columns,
            PaneNode::pane("second", "Second", Some("/tmp".into())),
        );
        tab.root
            .move_pane("tab", "second", "moved".into(), SplitAxis::Rows, false)
            .unwrap();
        tab.focused_pane_id = "tab".into();
        let layout = tab.layout();
        let restored: TerminalLayout =
            serde_json::from_str(&serde_json::to_string(&layout).unwrap()).unwrap();
        assert_eq!(restored, layout);
        assert_eq!(restored.focused_pane_id, "tab");
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
    fn terminal_environment_is_normalized_without_dropping_unrelated_values() {
        let mut command = CommandBuilder::new_default_prog();
        command.env("PATH", "/parent/terminal/bin:/usr/bin");
        command.env("SHELL", "/parent/terminal/shell");
        command.env("SSH_AUTH_SOCK", "/tmp/example-agent.sock");
        for variable in [
            "NO_COLOR",
            "CLICOLOR",
            "CLICOLOR_FORCE",
            "FORCE_COLOR",
            "TERM_PROGRAM",
            "TERM_PROGRAM_VERSION",
            "TERM_SESSION_ID",
            "COLORFGBG",
            "LC_TERMINAL",
            "LC_TERMINAL_VERSION",
            "ITERM_SESSION_ID",
            "ITERM_PROFILE",
        ] {
            command.env(variable, "inherited");
        }

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
        assert_eq!(
            command.get_env("SSH_AUTH_SOCK"),
            Some(std::ffi::OsStr::new("/tmp/example-agent.sock"))
        );

        #[cfg(any(target_os = "macos", target_os = "linux"))]
        {
            assert_eq!(
                command.get_env("PATH"),
                Some(std::ffi::OsStr::new(TERMINAL_BASE_PATH))
            );
            assert_eq!(command.get_env("SHELL"), None);
            for variable in [
                "TERM_PROGRAM",
                "TERM_PROGRAM_VERSION",
                "TERM_SESSION_ID",
                "COLORFGBG",
                "LC_TERMINAL",
                "LC_TERMINAL_VERSION",
                "ITERM_SESSION_ID",
                "ITERM_PROFILE",
            ] {
                assert_eq!(command.get_env(variable), None, "{variable} was preserved");
            }
        }

        #[cfg(windows)]
        {
            assert_eq!(
                command.get_env("PATH"),
                Some(std::ffi::OsStr::new("/parent/terminal/bin:/usr/bin"))
            );
            assert_eq!(
                command.get_env("SHELL"),
                Some(std::ffi::OsStr::new("/parent/terminal/shell"))
            );
        }
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
    fn copy_on_selection_defaults_to_enabled_and_reads_saved_booleans() {
        let db = SqliteConnection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .unwrap();

        assert!(copy_on_selection(&db));
        set_app_setting(&db, COPY_ON_SELECTION_SETTING_KEY, Some("false")).unwrap();
        assert!(!copy_on_selection(&db));
        set_app_setting(&db, COPY_ON_SELECTION_SETTING_KEY, Some("true")).unwrap();
        assert!(copy_on_selection(&db));
        set_app_setting(&db, COPY_ON_SELECTION_SETTING_KEY, Some("invalid")).unwrap();
        assert!(copy_on_selection(&db));
    }

    #[test]
    fn terminal_typography_settings_use_defaults_and_clamp_saved_values() {
        let db = SqliteConnection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .unwrap();

        assert_eq!(
            terminal_number_setting(&db, FONT_SIZE_SETTING_KEY, DEFAULT_FONT_SIZE, 8.0, 32.0),
            DEFAULT_FONT_SIZE
        );
        assert_eq!(terminal_line_height(&db), DEFAULT_LINE_HEIGHT);
        assert_eq!(terminal_horizontal_spacing(&db), DEFAULT_HORIZONTAL_SPACING);

        set_app_setting(&db, FONT_FAMILY_SETTING_KEY, Some("JetBrains Mono")).unwrap();
        set_app_setting(&db, FONT_SIZE_SETTING_KEY, Some("48")).unwrap();
        set_app_setting(&db, LINE_HEIGHT_SETTING_KEY, Some("1.2")).unwrap();
        set_app_setting(&db, HORIZONTAL_SPACING_SETTING_KEY, Some("1.2")).unwrap();
        assert_eq!(
            terminal_number_setting(&db, FONT_SIZE_SETTING_KEY, DEFAULT_FONT_SIZE, 8.0, 32.0),
            32.0
        );
        assert_eq!(terminal_line_height(&db), 120.0);
        assert_eq!(terminal_horizontal_spacing(&db), 120.0);
        set_app_setting(&db, LINE_HEIGHT_SETTING_KEY, Some("175")).unwrap();
        assert_eq!(terminal_line_height(&db), 175.0);
    }

    #[test]
    fn terminal_scrollback_uses_a_default_and_clamps_saved_values() {
        let db = SqliteConnection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .unwrap();

        assert_eq!(terminal_scrollback_lines(&db), DEFAULT_SCROLLBACK_LINES);
        set_app_setting(&db, SCROLLBACK_LINES_SETTING_KEY, Some("0")).unwrap();
        assert_eq!(terminal_scrollback_lines(&db), 0);
        set_app_setting(&db, SCROLLBACK_LINES_SETTING_KEY, Some("25000")).unwrap();
        assert_eq!(terminal_scrollback_lines(&db), 25_000);
        set_app_setting(&db, SCROLLBACK_LINES_SETTING_KEY, Some("200000")).unwrap();
        assert_eq!(terminal_scrollback_lines(&db), MAX_SCROLLBACK_LINES);
        set_app_setting(&db, SCROLLBACK_LINES_SETTING_KEY, Some("invalid")).unwrap();
        assert_eq!(terminal_scrollback_lines(&db), DEFAULT_SCROLLBACK_LINES);
    }

    #[test]
    fn terminal_shortcuts_fall_back_per_field_and_reject_conflicts() {
        let db = SqliteConnection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        set_app_setting(
            &db,
            SHORTCUTS_SETTING_KEY,
            Some(r#"{"splitColumns":"Alt+KeyS","search":"KeyF","zoomOut":42}"#),
        )
        .unwrap();
        let shortcuts = terminal_shortcuts(&db);
        assert_eq!(shortcuts.split_columns, "Alt+KeyS");
        assert_eq!(shortcuts.search, TerminalShortcuts::default().search);
        assert_eq!(shortcuts.zoom_out, TerminalShortcuts::default().zoom_out);

        let mut duplicate = TerminalShortcuts::default();
        duplicate.search = duplicate.split_columns.clone();
        assert!(validate_terminal_shortcuts(&duplicate)
            .unwrap_err()
            .contains("same shortcut"));

        let mut reserved = TerminalShortcuts::default();
        reserved.search = "CommandOrControl+KeyW".into();
        assert!(validate_terminal_shortcuts(&reserved)
            .unwrap_err()
            .contains("cannot replace"));
    }

    #[test]
    fn detached_output_buffer_is_bounded_and_reports_truncation_once() {
        let mut buffer = DetachedOutputBuffer::default();
        let chunk = vec![b'x'; MAX_DETACHED_OUTPUT_BYTES / 2 + 1];
        buffer.push(chunk.clone());
        buffer.push(chunk);
        assert!(buffer.byte_len <= MAX_DETACHED_OUTPUT_BYTES);
        assert!(buffer.truncated);

        let (truncated, chunks) = buffer.take();
        assert!(truncated);
        assert!(chunks.iter().map(Vec::len).sum::<usize>() <= MAX_DETACHED_OUTPUT_BYTES);
        assert_eq!(buffer.byte_len, 0);
        assert!(!buffer.truncated);

        buffer.push(b"next".to_vec());
        let (truncated, chunks) = buffer.take();
        assert!(!truncated);
        assert_eq!(
            chunks.into_iter().collect::<Vec<_>>(),
            vec![b"next".to_vec()]
        );
    }

    #[test]
    fn detached_output_keeps_the_tail_of_a_single_oversized_chunk() {
        let mut buffer = DetachedOutputBuffer::default();
        let mut chunk = vec![b'a'; MAX_DETACHED_OUTPUT_BYTES + 7];
        chunk[MAX_DETACHED_OUTPUT_BYTES + 6] = b'z';
        buffer.push(chunk);
        let (truncated, chunks) = buffer.take();
        let retained = chunks.into_iter().next().unwrap();
        assert!(truncated);
        assert_eq!(retained.len(), MAX_DETACHED_OUTPUT_BYTES);
        assert_eq!(retained.last(), Some(&b'z'));
    }

    fn font_candidate(
        family: &str,
        weight: u16,
        italic: bool,
        monospaced: bool,
    ) -> FontFaceCandidate {
        FontFaceCandidate {
            family: family.to_string(),
            postscript_name: format!(
                "{family}-{weight}-{}",
                if italic { "Italic" } else { "Normal" }
            ),
            weight,
            italic,
            monospaced,
        }
    }

    #[test]
    fn terminal_font_catalog_filters_groups_deduplicates_and_orders_styles() {
        let catalog = font_catalog_from_candidates([
            font_candidate("Proportional", 400, false, false),
            font_candidate("Example Mono", 100, true, true),
            font_candidate("Example Mono", 100, false, true),
            font_candidate("Example Mono", 400, false, true),
            font_candidate("Example Mono", 400, false, true),
            font_candidate("Alpha Mono", 700, false, true),
        ]);

        assert_eq!(catalog.len(), 2);
        assert_eq!(catalog[0].family, "Alpha Mono");
        assert_eq!(catalog[1].family, "Example Mono");
        assert_eq!(catalog[1].styles.len(), 3);
        assert_eq!(catalog[1].styles[0].label, "Regular");
        assert_eq!(catalog[1].styles[1].label, "Thin");
        assert_eq!(catalog[1].styles[2].label, "Thin Italic");
    }

    #[test]
    fn terminal_font_selection_migrates_legacy_lists_and_falls_back_safely() {
        let catalog = font_catalog_from_candidates([
            font_candidate("Alpha Mono", 300, false, true),
            font_candidate("Menlo", 400, false, true),
            font_candidate("Menlo", 700, true, true),
        ]);

        assert_eq!(
            resolve_font_selection(
                &catalog,
                Some("Missing, 'Menlo', monospace"),
                Some(700),
                Some("italic"),
            ),
            (
                "Menlo".to_string(),
                Some("Menlo-700-Italic".to_string()),
                700,
                "italic".to_string()
            )
        );
        assert_eq!(
            resolve_font_selection(&catalog, Some("Removed Mono"), Some(900), Some("normal")),
            (
                "Menlo".to_string(),
                Some("Menlo-400-Normal".to_string()),
                400,
                "normal".to_string()
            )
        );
    }

    #[test]
    fn terminal_font_validation_rejects_unavailable_families_and_styles() {
        let catalog = font_catalog_from_candidates([
            font_candidate("Example Mono", 400, false, true),
            font_candidate("Example Mono", 100, true, true),
        ]);

        assert!(validate_font_selection(&catalog, "Missing", 400, "normal").is_err());
        assert!(validate_font_selection(&catalog, "Example Mono", 100, "normal").is_err());
        assert!(validate_font_selection(&catalog, "Example Mono", 100, "oblique").is_err());
        assert_eq!(
            validate_font_selection(&catalog, "Example Mono", 100, "italic").unwrap(),
            (
                "Example Mono".to_string(),
                Some("Example Mono-100-Italic".to_string()),
                100,
                "italic".to_string(),
            )
        );
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
