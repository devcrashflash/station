//! Quickstart rules and atomic pane launch, kept separate from normal split behavior.
use super::*;
use globset::{GlobBuilder, GlobMatcher};

const SETTING_KEY: &str = "terminal_quickstart_rules";
const COMPOSE_YAML_MIGRATION_KEY: &str = "terminal_quickstart_compose_yaml_migrated";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuickstartRule {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub paths: Vec<String>,
    pub match_mode: MatchMode,
    pub command: String,
    pub position: Position,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MatchMode {
    Any,
    All,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Position {
    Left,
    Right,
    Top,
    Bottom,
}

pub fn defaults() -> Vec<QuickstartRule> {
    vec![
        QuickstartRule {
            id: "docker-compose".into(),
            name: "Docker Compose".into(),
            enabled: true,
            paths: vec![
                "docker-compose.yml".into(),
                "compose.yml".into(),
                "docker-compose.yaml".into(),
                "compose.yaml".into(),
            ],
            match_mode: MatchMode::Any,
            command: "docker compose up".into(),
            position: Position::Right,
        },
        QuickstartRule {
            id: "symfony".into(),
            name: "Symfony".into(),
            enabled: true,
            paths: vec!["public/index.php".into()],
            match_mode: MatchMode::Any,
            command: "symfony serve".into(),
            position: Position::Right,
        },
    ]
}

/// An absolute condition matches the current directory, never a file below it.
struct DirectoryCondition {
    prefix: PathBuf,
    descendants: Option<GlobMatcher>,
}

fn directory_pattern_text(path: &str) -> String {
    #[cfg(windows)]
    {
        let normalized = path.replace('\\', "/");
        if let Some(unc) = normalized.strip_prefix("//?/UNC/") {
            return format!("//{unc}");
        }
        normalized
            .strip_prefix("//?/")
            .unwrap_or(&normalized)
            .to_string()
    }
    #[cfg(not(windows))]
    {
        path.to_string()
    }
}

fn directory_condition(path: &str) -> Result<DirectoryCondition, String> {
    if !path.ends_with(std::path::is_separator) {
        return Err(format!("Absolute file checks are not supported. End the directory condition '{path}' with '/'."));
    }
    let normalized = directory_pattern_text(path);
    let pattern = normalized.trim_end_matches('/');
    let pattern = if pattern.is_empty() { "/" } else { pattern };
    let wildcard = pattern.find(['*', '?', '[', '{']);
    let (prefix, descendants) = if let Some(index) = wildcard {
        let separator = pattern[..index]
            .rfind('/')
            .ok_or_else(|| format!("Invalid absolute directory pattern '{path}'."))?;
        let matcher = GlobBuilder::new(&pattern[separator + 1..])
            .literal_separator(true)
            .backslash_escape(false)
            .case_insensitive(cfg!(windows))
            .build()
            .map_err(|error| format!("Invalid directory pattern '{path}': {error}"))?
            .compile_matcher();
        (PathBuf::from(&pattern[..=separator]), Some(matcher))
    } else {
        (
            PathBuf::from(if cfg!(windows) && pattern.ends_with(':') {
                &normalized
            } else {
                pattern
            }),
            None,
        )
    };
    Ok(DirectoryCondition {
        prefix,
        descendants,
    })
}

impl DirectoryCondition {
    fn matches(&self, cwd: &Path) -> bool {
        // Canonicalize only the literal prefix. No directory tree enumeration is needed.
        let Ok(prefix) = self.prefix.canonicalize() else {
            return false;
        };
        if !prefix.is_dir() {
            return false;
        }
        match &self.descendants {
            None => cwd == prefix,
            Some(matcher) => cwd
                .strip_prefix(prefix)
                .ok()
                .filter(|relative| !relative.as_os_str().is_empty())
                .is_some_and(|relative| {
                    matcher.is_match(directory_pattern_text(&relative.to_string_lossy()))
                }),
        }
    }
}

pub fn validate(rules: &[QuickstartRule]) -> Result<(), String> {
    let mut ids = HashSet::new();
    for rule in rules {
        if rule.id.trim().is_empty() || !ids.insert(&rule.id) {
            return Err("Quickstart rules must have unique IDs.".into());
        }
        if rule.name.trim().is_empty()
            || rule.command.trim().is_empty()
            || rule.command.contains('\0')
        {
            return Err(
                "Every Quickstart rule needs a name and a command without null characters.".into(),
            );
        }
        if rule.paths.is_empty() {
            return Err("Every Quickstart rule needs at least one path condition.".into());
        }
        for path in &rule.paths {
            if path.trim().is_empty()
                || path.contains(['\0', '\r', '\n'])
                || path.starts_with('~')
                || path.split(['/', '\\']).any(|part| part == "..")
            {
                return Err("Quickstart conditions must use relative paths or absolute directories, without '..' or home expansion.".into());
            }
            if Path::new(path).is_absolute() {
                directory_condition(path)?;
            } else if path.starts_with(['/', '\\']) || path.contains(':') {
                return Err("Quickstart conditions must use relative paths or native absolute directories ending in '/'.".into());
            }
        }
    }
    Ok(())
}

pub fn load(db: &SqliteConnection) -> Result<Vec<QuickstartRule>, String> {
    match get_app_setting(db, SETTING_KEY).map_err(db_error)? {
        None => Ok(defaults()),
        Some(value) => {
            let mut rules =
                serde_json::from_str::<Vec<QuickstartRule>>(&value).map_err(db_error)?;
            validate(&rules)?;
            if get_app_setting(db, COMPOSE_YAML_MIGRATION_KEY)
                .map_err(db_error)?
                .is_none()
            {
                let updated = defaults().remove(0);
                let mut legacy = updated.clone();
                legacy.paths = vec!["docker-compose.yml".into(), "compose.yml".into()];
                for rule in &mut rules {
                    if *rule == legacy {
                        *rule = updated.clone();
                    }
                }
                // Mark the migration once, so users can subsequently save a narrower rule.
                save(db, &rules)?;
            }
            Ok(rules)
        }
    }
}

pub fn validate_for_save(rules: &[QuickstartRule]) -> Result<(), String> {
    validate(rules)?;
    for path in rules.iter().flat_map(|rule| &rule.paths) {
        if Path::new(path).is_absolute() {
            let condition = directory_condition(path)?;
            let prefix: PathBuf = condition.prefix.components().collect();
            if prefix.is_file() {
                return Err(format!(
                    "Absolute file checks are not supported: '{path}' points to a file."
                ));
            }
        }
    }
    Ok(())
}

pub fn save(db: &SqliteConnection, rules: &[QuickstartRule]) -> Result<(), String> {
    validate_for_save(rules)?;
    set_app_setting(
        db,
        SETTING_KEY,
        Some(&serde_json::to_string(rules).map_err(db_error)?),
    )
    .map_err(db_error)?;
    set_app_setting(db, COMPOSE_YAML_MIGRATION_KEY, Some("true")).map_err(db_error)
}

fn matches(rule: &QuickstartRule, cwd: &Path) -> bool {
    if !rule.enabled {
        return false;
    }
    let exists = |path: &String| {
        if Path::new(path).is_absolute() {
            return directory_condition(path).is_ok_and(|condition| condition.matches(cwd));
        }
        // Symlinks may name local files/directories, but must remain beneath the matched directory.
        cwd.join(path).canonicalize().ok().is_some_and(|resolved| {
            resolved.starts_with(cwd) && (resolved.is_file() || resolved.is_dir())
        })
    };
    match rule.match_mode {
        MatchMode::Any => rule.paths.iter().any(exists),
        MatchMode::All => rule.paths.iter().all(exists),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuickstartPreview {
    tab_id: String,
    pane_id: String,
    cwd: String,
    // Include all settings so changes to unmatched/disabled rules also invalidate the preview.
    settings: Vec<QuickstartRule>,
    rules: Vec<QuickstartRule>,
}

fn eligible_tab<'a>(runtime: &'a TerminalTabsRuntime, tab_id: &str) -> Option<&'a TerminalTab> {
    if runtime.active_tab_id != tab_id || runtime.startup_input_gates.contains(tab_id) {
        return None;
    }
    let tab = runtime.tabs.iter().find(|tab| tab.id == tab_id)?;
    match &tab.root {
        PaneNode::Pane { running: true, .. } => Some(tab),
        _ => None,
    }
}

fn matching_preview(
    tab: &TerminalTab,
    cwd: &Path,
    rules: Vec<QuickstartRule>,
) -> Option<QuickstartPreview> {
    let cwd = cwd.canonicalize().ok()?;
    let matched: Vec<_> = rules
        .iter()
        .filter(|rule| matches(rule, &cwd))
        .cloned()
        .collect();
    // Keep the directory context even without matches so dismissal resets on every cd.
    Some(QuickstartPreview {
        tab_id: tab.id.clone(),
        pane_id: tab.focused_pane_id.clone(),
        cwd: cwd.to_string_lossy().into_owned(),
        settings: rules,
        rules: matched,
    })
}

fn preview(
    app: &tauri::AppHandle,
    runtime: &TerminalTabsRuntime,
    tab_id: &str,
    rules: Vec<QuickstartRule>,
) -> Result<Option<QuickstartPreview>, String> {
    let Some(tab) = eligible_tab(runtime, tab_id) else {
        return Ok(None);
    };
    let cwd = runtime
        .sessions
        .get(&tab.focused_pane_id)
        .and_then(|s| s.process_id)
        .and_then(process_cwd)
        .unwrap_or(pane_cwd(app, runtime, tab_id, &tab.focused_pane_id)?);
    Ok(matching_preview(tab, &cwd, rules))
}

// Balanced splits keep equal slots within the renderer’s supported ratio range.
fn equal_group(mut nodes: Vec<PaneNode>, axis: SplitAxis) -> PaneNode {
    let count = nodes.len();
    if count == 1 {
        return nodes.remove(0);
    }
    let midpoint = count / 2;
    let second = nodes.split_off(midpoint);
    PaneNode::Split {
        split_id: super::super::new_id("terminal_split"),
        axis,
        ratio: midpoint as f64 / count as f64,
        first: Box::new(equal_group(nodes, axis)),
        second: Box::new(equal_group(second, axis)),
    }
}

fn build_layout(
    original: PaneNode,
    rules: &[QuickstartRule],
    cwd: &str,
) -> (PaneNode, Vec<(String, Vec<u8>)>) {
    let mut left = vec![];
    let mut right = vec![];
    let mut top = vec![];
    let mut bottom = vec![];
    let mut commands = vec![];
    for rule in rules {
        let pane_id = super::super::new_id("terminal_pane");
        let node = PaneNode::pane(&pane_id, &rule.name, Some(cwd.into()));
        let command = format!(
            "{}\r",
            rule.command.replace("\r\n", "\n").replace('\n', "\r")
        );
        commands.push((pane_id, command.into_bytes()));
        match rule.position {
            Position::Left => left.push(node),
            Position::Right => right.push(node),
            Position::Top => top.push(node),
            Position::Bottom => bottom.push(node),
        }
    }
    let mut columns = vec![];
    if !left.is_empty() {
        columns.push(equal_group(left, SplitAxis::Rows));
    }
    columns.push(original);
    if !right.is_empty() {
        columns.push(equal_group(right, SplitAxis::Rows));
    }
    let mut bands = vec![];
    if !top.is_empty() {
        bands.push(equal_group(top, SplitAxis::Columns));
    }
    bands.push(equal_group(columns, SplitAxis::Columns));
    if !bottom.is_empty() {
        bands.push(equal_group(bottom, SplitAxis::Columns));
    }
    (equal_group(bands, SplitAxis::Rows), commands)
}

fn apply_preview(
    runtime: &mut TerminalTabsRuntime,
    expected: &QuickstartPreview,
    current: Option<&QuickstartPreview>,
) -> Option<TerminalLayout> {
    if expected.rules.is_empty()
        || current != Some(expected)
        || eligible_tab(runtime, &expected.tab_id)?.focused_pane_id != expected.pane_id
    {
        return None;
    }
    let tab = runtime
        .tabs
        .iter_mut()
        .find(|tab| tab.id == expected.tab_id)?;
    let (root, commands) = build_layout(tab.root.clone(), &expected.rules, &expected.cwd);
    tab.root = root;
    let layout = tab.layout();
    for (pane_id, command) in commands {
        runtime.pending_input.insert(pane_id, command);
    }
    mark_terminal_tabs_dirty(runtime);
    Some(layout)
}

#[tauri::command]
pub fn preview_terminal_quickstart(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, AppState>,
    terminal_state: tauri::State<'_, TerminalTabsState>,
    tab_id: String,
) -> Result<Option<QuickstartPreview>, String> {
    validate_terminal_caller(&webview, &tab_id)?;
    let db = state.db.lock().map_err(db_error)?;
    let rules = load(&db)?;
    let runtime = terminal_state.runtime.lock().map_err(db_error)?;
    preview(&app, &runtime, &tab_id, rules)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickstartActivation {
    launched: bool,
    preview: Option<QuickstartPreview>,
}

#[tauri::command]
pub fn activate_terminal_quickstart(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, AppState>,
    terminal_state: tauri::State<'_, TerminalTabsState>,
    expected: QuickstartPreview,
) -> Result<QuickstartActivation, String> {
    validate_terminal_caller(&webview, &expected.tab_id)?;
    let (layout, snapshot) = {
        // Lock settings through commit, and check eligibility inside the same lock as layout mutation.
        let db = state.db.lock().map_err(db_error)?;
        let rules = load(&db)?;
        let mut runtime = terminal_state.runtime.lock().map_err(db_error)?;
        let current = preview(&app, &runtime, &expected.tab_id, rules)?;
        let Some(layout) = apply_preview(&mut runtime, &expected, current.as_ref()) else {
            return Ok(QuickstartActivation {
                launched: false,
                preview: current,
            });
        };
        (layout, snapshot_from_runtime(&runtime))
    };
    emit_layout(&app, &layout);
    emit_snapshot(&app, &snapshot);
    persist_terminal_tabs_in_background(&app);
    Ok(QuickstartActivation {
        launched: true,
        preview: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = env::temp_dir().join(super::super::super::new_id("quickstart_test"));
            fs::create_dir_all(path.join("public")).unwrap();
            Self(path.canonicalize().unwrap())
        }
        fn touch(&self, path: &str) {
            fs::write(self.0.join(path), "").unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn runtime(cwd: &Path) -> TerminalTabsRuntime {
        let mut tab = TerminalTab::new_with_cwd(
            "tab".into(),
            "Original".into(),
            Some(cwd.to_string_lossy().into_owned()),
        );
        if let PaneNode::Pane { running, .. } = &mut tab.root {
            *running = true;
        }
        TerminalTabsRuntime {
            tabs: vec![tab],
            active_tab_id: "tab".into(),
            new_tab_directory: None,
            new_pane_directory: Some("/unrelated".into()),
            sessions: HashMap::new(),
            pending_input: HashMap::new(),
            startup_input_gates: HashSet::new(),
            next_generation: 1,
            next_attachment_id: 1,
            persistence_revision: 0,
            persisted_revision: 0,
            persistence_degraded: false,
            persistence_worker_running: false,
        }
    }

    #[test]
    fn matching_handles_any_all_files_directories_disabled_rules_and_changes() {
        let fixture = Fixture::new();
        let tab = runtime(&fixture.0).tabs.remove(0);
        assert!(matching_preview(&tab, &fixture.0, defaults())
            .unwrap()
            .rules
            .is_empty());
        fixture.touch("compose.yml");
        fixture.touch("docker-compose.yml");
        let preview = matching_preview(&tab, &fixture.0, defaults()).unwrap();
        assert_eq!(preview.rules.len(), 1);
        fixture.touch("public/index.php");
        assert_eq!(
            matching_preview(&tab, &fixture.0, defaults())
                .unwrap()
                .rules
                .len(),
            2
        );
        let mut rule = defaults().remove(0);
        rule.match_mode = MatchMode::All;
        rule.paths = vec!["public".into(), "public/index.php".into()];
        assert!(matches(&rule, &fixture.0));
        fs::remove_file(fixture.0.join("public/index.php")).unwrap();
        assert!(!matches(&rule, &fixture.0));
        rule.match_mode = MatchMode::Any;
        assert!(matches(&rule, &fixture.0));
        rule.enabled = false;
        assert!(!matches(&rule, &fixture.0));
        fs::create_dir(fixture.0.join("nested")).unwrap();
        let nested = matching_preview(&tab, &fixture.0.join("nested"), defaults()).unwrap();
        assert!(nested.rules.is_empty());
        assert_ne!(nested.cwd, preview.cwd);
    }

    #[test]
    fn unmatched_directory_context_cannot_launch_commands() {
        let fixture = Fixture::new();
        let mut runtime = runtime(&fixture.0);
        let context = matching_preview(&runtime.tabs[0], &fixture.0, defaults()).unwrap();
        assert!(context.rules.is_empty());
        assert_eq!(context.cwd, fixture.0.to_string_lossy());
        assert!(apply_preview(&mut runtime, &context, Some(&context)).is_none());
        assert!(runtime.pending_input.is_empty());
        assert!(eligible_tab(&runtime, "tab").is_some());
    }

    #[test]
    fn all_four_compose_filenames_match_once() {
        let fixture = Fixture::new();
        let tab = runtime(&fixture.0).tabs.remove(0);
        for filename in [
            "compose.yml",
            "compose.yaml",
            "docker-compose.yml",
            "docker-compose.yaml",
        ] {
            fixture.touch(filename);
            let preview = matching_preview(&tab, &fixture.0, defaults()).unwrap();
            assert_eq!(preview.rules.len(), 1, "{filename}");
            assert_eq!(preview.rules[0].command, "docker compose up");
            fs::remove_file(fixture.0.join(filename)).unwrap();
        }
        for filename in [
            "compose.yml",
            "compose.yaml",
            "docker-compose.yml",
            "docker-compose.yaml",
        ] {
            fixture.touch(filename);
        }
        assert_eq!(
            matching_preview(&tab, &fixture.0, defaults())
                .unwrap()
                .rules
                .len(),
            1
        );
    }

    fn directory_rule(path: String) -> QuickstartRule {
        QuickstartRule {
            paths: vec![path],
            ..defaults().remove(0)
        }
    }

    fn directory_path(path: &Path) -> String {
        format!(
            "{}/",
            directory_pattern_text(&path.to_string_lossy()).trim_end_matches('/')
        )
    }

    #[test]
    fn directory_conditions_match_exact_children_and_recursive_descendants() {
        let fixture = Fixture::new();
        let projects = fixture.0.join("Projects");
        let child = projects.join("alexander");
        let nested = child.join("some/subdirectory");
        let sibling = fixture.0.join("Projects-other");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir(&sibling).unwrap();
        let exact = directory_rule(directory_path(&child));
        let immediate = directory_rule(format!("{}*/", directory_path(&projects)));
        let recursive = directory_rule(format!("{}**/", directory_path(&projects)));
        for rule in [&exact, &immediate, &recursive] {
            validate_for_save(std::slice::from_ref(rule)).unwrap();
        }
        assert!(matches(&exact, &child));
        assert!(!matches(&exact, &nested));
        assert!(!matches(&exact, &projects));
        assert!(matches(&immediate, &child));
        assert!(!matches(&immediate, &nested));
        assert!(!matches(&immediate, &projects));
        assert!(!matches(&immediate, &sibling));
        assert!(matches(&recursive, &child));
        assert!(matches(&recursive, &nested));
        assert!(!matches(&recursive, &projects));
        assert!(!matches(&recursive, &sibling));
        let named = directory_rule(format!("{}alex*/", directory_path(&projects)));
        assert!(matches(&named, &child));
        assert!(!matches(&named, &nested));
        let root = projects.ancestors().last().unwrap();
        let root_rule = directory_rule(directory_path(root));
        assert!(matches(&root_rule, root));
        assert!(!matches(&root_rule, &projects));
    }

    #[test]
    fn directory_conditions_combine_with_relative_checks_without_changing_their_semantics() {
        let fixture = Fixture::new();
        let mut rule = directory_rule(directory_path(&fixture.0));
        rule.paths.push("compose.yaml".into());
        rule.match_mode = MatchMode::All;
        assert!(!matches(&rule, &fixture.0));
        fixture.touch("compose.yaml");
        assert!(matches(&rule, &fixture.0));
        rule.paths[0] = directory_path(&fixture.0.join("missing"));
        assert!(!matches(&rule, &fixture.0));
        rule.match_mode = MatchMode::Any;
        assert!(matches(&rule, &fixture.0));
        rule.paths = vec!["compose.*".into()];
        assert!(!matches(&rule, &fixture.0)); // Relative entries stay literal.
        rule.paths = vec!["public/".into()];
        assert!(matches(&rule, &fixture.0));
    }

    #[test]
    fn directory_validation_rejects_absolute_files_and_invalid_globs_without_saving() {
        let fixture = Fixture::new();
        fixture.touch("file");
        let db = SqliteConnection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);").unwrap();
        save(&db, &defaults()).unwrap();
        for path in [
            directory_pattern_text(&fixture.0.to_string_lossy()),
            directory_pattern_text(&fixture.0.join("file").to_string_lossy()),
            directory_path(&fixture.0.join("file")),
            format!("{}file/*/", directory_path(&fixture.0)),
            format!("{}[unclosed/", directory_path(&fixture.0)),
        ] {
            assert!(
                save(&db, &[directory_rule(path.clone())]).is_err(),
                "{path}"
            );
            assert_eq!(load(&db).unwrap(), defaults());
        }
        let nonexistent = directory_rule(directory_path(&fixture.0.join("not-yet-created")));
        save(&db, &[nonexistent.clone()]).unwrap();
        assert_eq!(load(&db).unwrap(), vec![nonexistent.clone()]);
        assert!(!matches(&nonexistent, &fixture.0));
        // Filesystem changes do not prevent loading and editing a previously valid condition.
        fixture.touch("not-yet-created");
        assert_eq!(load(&db).unwrap(), vec![nonexistent.clone()]);
        assert!(!matches(&nonexistent, &fixture.0));
    }

    #[cfg(unix)]
    #[test]
    fn directory_conditions_resolve_symlinked_literal_prefixes() {
        let fixture = Fixture::new();
        let real = fixture.0.join("real");
        let child = real.join("child");
        fs::create_dir_all(&child).unwrap();
        let alias = fixture.0.join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        assert!(matches(&directory_rule(directory_path(&alias)), &real));
        assert!(matches(
            &directory_rule(format!("{}*/", directory_path(&alias))),
            &child
        ));
    }

    #[test]
    fn compose_yaml_migration_updates_only_unchanged_defaults_once() {
        let db = SqliteConnection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);").unwrap();
        let mut legacy = defaults();
        legacy[0].paths = vec!["docker-compose.yml".into(), "compose.yml".into()];
        let mut custom = legacy[0].clone();
        custom.id = "custom".into();
        custom.command = "docker compose up -d".into();
        let stored = vec![legacy[0].clone(), custom.clone(), legacy[1].clone()];
        set_app_setting(
            &db,
            SETTING_KEY,
            Some(&serde_json::to_string(&stored).unwrap()),
        )
        .unwrap();
        assert_eq!(
            load(&db).unwrap(),
            vec![defaults().remove(0), custom, legacy[1].clone()]
        );
        // Explicit edits after migration, including the old paths or no rules, remain authoritative.
        save(&db, &legacy).unwrap();
        assert_eq!(load(&db).unwrap(), legacy);
        save(&db, &[]).unwrap();
        assert!(load(&db).unwrap().is_empty());
    }

    #[test]
    fn settings_defaults_are_only_used_when_absent_and_validation_is_atomic() {
        let db = SqliteConnection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);").unwrap();
        assert_eq!(load(&db).unwrap(), defaults());
        save(&db, &[]).unwrap();
        assert!(load(&db).unwrap().is_empty());
        let mut custom = defaults();
        custom[0].name = "Custom".into();
        custom.reverse();
        save(&db, &custom).unwrap();
        assert_eq!(load(&db).unwrap(), custom);
        for path in [
            "",
            "/tmp",
            "../outside",
            "a/../b",
            "a\\..\\b",
            "C:\\app",
            "~/app",
        ] {
            let mut invalid = custom.clone();
            invalid[0].paths = vec![path.into()];
            assert!(save(&db, &invalid).is_err());
            assert_eq!(load(&db).unwrap(), custom);
        }
        let mut duplicate = custom.clone();
        duplicate.push(custom[0].clone());
        assert!(validate(&duplicate).is_err());
        let mut invalid = custom.clone();
        invalid[0].command = " ".into();
        assert!(validate(&invalid).is_err());
    }

    fn bounds(node: &PaneNode, rect: [f64; 4], result: &mut Vec<(String, [f64; 4])>) {
        let [x, y, w, h] = rect;
        match node {
            PaneNode::Pane { title, .. } => result.push((title.clone(), rect)),
            PaneNode::Split {
                axis,
                ratio,
                first,
                second,
                ..
            } => {
                assert!((0.1..=0.9).contains(ratio));
                let (a, b) = match axis {
                    SplitAxis::Columns => (
                        [x, y, w * ratio, h],
                        [x + w * ratio, y, w * (1.0 - ratio), h],
                    ),
                    SplitAxis::Rows => (
                        [x, y, w, h * ratio],
                        [x, y + h * ratio, w, h * (1.0 - ratio)],
                    ),
                };
                bounds(first, a, result);
                bounds(second, b, result);
            }
        }
    }

    #[test]
    fn defaults_keep_original_full_height_and_stack_docker_above_symfony() {
        let original = PaneNode::pane("original", "Original", Some("/old".into()));
        let (root, commands) = build_layout(original.clone(), &defaults(), "/matched");
        assert_eq!(root.find_pane("original"), Some(&original));
        let mut panes = vec![];
        bounds(&root, [0.0, 0.0, 1.0, 1.0], &mut panes);
        assert_eq!(
            panes,
            vec![
                ("Original".into(), [0.0, 0.0, 0.5, 1.0]),
                ("Docker Compose".into(), [0.5, 0.0, 0.5, 0.5]),
                ("Symfony".into(), [0.5, 0.5, 0.5, 0.5])
            ]
        );
        assert_eq!(commands[0].1, b"docker compose up\r");
        assert_eq!(commands[1].1, b"symfony serve\r");
        for (id, _) in commands {
            let PaneNode::Pane { cwd, .. } = root.find_pane(&id).unwrap() else {
                panic!()
            };
            assert_eq!(cwd.as_deref(), Some("/matched"));
        }
    }

    #[test]
    fn four_sides_are_grouped_and_many_panes_remain_equal() {
        let mut rules = vec![];
        for position in [
            Position::Top,
            Position::Left,
            Position::Right,
            Position::Bottom,
        ] {
            for n in 0..12 {
                let mut rule = defaults().remove(0);
                rule.position = position;
                rule.name = format!("{position:?}-{n}");
                rules.push(rule);
            }
        }
        let (root, commands) = build_layout(
            PaneNode::pane("original", "Original", None),
            &rules,
            "/matched",
        );
        assert_eq!(commands.len(), 48);
        let mut panes = vec![];
        bounds(&root, [0.0, 0.0, 1.0, 1.0], &mut panes);
        let get = |name: &str| panes.iter().find(|(title, _)| title == name).unwrap().1;
        let near = |a: f64, b: f64| assert!((a - b).abs() < 1e-9, "{a} != {b}");
        let original = get("Original");
        for coordinate in original {
            near(coordinate, 1.0 / 3.0);
        }
        for n in 0..12 {
            let top = get(&format!("Top-{n}"));
            near(top[0], n as f64 / 12.0);
            near(top[1], 0.0);
            near(top[2], 1.0 / 12.0);
            near(top[3], 1.0 / 3.0);
            let right = get(&format!("Right-{n}"));
            near(right[0], 2.0 / 3.0);
            near(right[1], 1.0 / 3.0 + n as f64 / 36.0);
            near(right[3], 1.0 / 36.0);
            let left = get(&format!("Left-{n}"));
            near(left[0], 0.0);
            near(left[1], right[1]);
            let bottom = get(&format!("Bottom-{n}"));
            near(bottom[0], top[0]);
            near(bottom[1], 2.0 / 3.0);
        }
    }

    #[test]
    fn stale_and_duplicate_launches_are_rejected_and_pending_commands_are_transient() {
        let fixture = Fixture::new();
        fixture.touch("compose.yml");
        let mut runtime = runtime(&fixture.0);
        let expected = matching_preview(&runtime.tabs[0], &fixture.0, defaults()).unwrap();
        let mut changed = expected.clone();
        changed.settings[1].enabled = false;
        assert!(apply_preview(&mut runtime, &expected, Some(&changed)).is_none());
        assert!(runtime.pending_input.is_empty());
        let original = runtime.tabs[0].root.clone();
        let focused = runtime.tabs[0].focused_pane_id.clone();
        let layout = apply_preview(&mut runtime, &expected, Some(&expected)).unwrap();
        assert_eq!(layout.focused_pane_id, focused);
        assert_eq!(layout.root.find_pane(&focused), Some(&original));
        assert_eq!(runtime.pending_input.len(), 1);
        assert!(apply_preview(&mut runtime, &expected, Some(&expected)).is_none());
        assert_eq!(runtime.pending_input.len(), 1);
        let saved = serde_json::to_string(&layout).unwrap();
        assert!(!saved.contains("docker compose up"));
        let restored: TerminalLayout = serde_json::from_str(&saved).unwrap();
        assert_eq!(restored, layout);
        let mut db = SqliteConnection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);").unwrap();
        init_terminal_schema(&db).unwrap();
        persist_tabs_to_db(&mut db, &runtime.tabs).unwrap();
        let loaded = load_runtime(&db).unwrap();
        assert!(loaded.pending_input.is_empty());
        assert!(loaded.sessions.is_empty());
        assert_eq!(loaded.tabs[0].focused_pane_id, focused);
        terminate_tab_sessions(&mut runtime, "tab");
        assert!(runtime.pending_input.is_empty());
        // Close the generated pane: the original becomes eligible again.
        runtime.tabs[0].root = original;
        assert!(eligible_tab(&runtime, "tab").is_some());
        runtime.active_tab_id = MAIN_TAB_ID.into();
        assert!(apply_preview(&mut runtime, &expected, Some(&expected)).is_none());
        runtime.active_tab_id = "tab".into();
        runtime.tabs.clear();
        assert!(apply_preview(&mut runtime, &expected, Some(&expected)).is_none());
    }

    #[test]
    fn concurrent_requests_launch_once() {
        let fixture = Fixture::new();
        fixture.touch("compose.yml");
        let state = std::sync::Arc::new(Mutex::new(runtime(&fixture.0)));
        let expected =
            matching_preview(&state.lock().unwrap().tabs[0], &fixture.0, defaults()).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let state = state.clone();
                let expected = expected.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    let mut runtime = state.lock().unwrap();
                    let current = eligible_tab(&runtime, "tab").and_then(|tab| {
                        matching_preview(tab, Path::new(&expected.cwd), defaults())
                    });
                    apply_preview(&mut runtime, &expected, current.as_ref()).is_some()
                })
            })
            .collect();
        assert_eq!(
            workers
                .into_iter()
                .map(|worker| usize::from(worker.join().unwrap()))
                .sum::<usize>(),
            1
        );
        assert_eq!(state.lock().unwrap().pending_input.len(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn queued_commands_run_in_real_ptys_and_fail_independently() {
        let fixture = Fixture::new();
        let mut rules = defaults();
        rules[0].command = "__station_quickstart_missing_executable__".into();
        rules[1].command = "printf '%s' \"$PWD\" > quickstart-cwd".into();
        let (_, commands) = build_layout(
            PaneNode::pane("original", "Original", None),
            &rules,
            fixture.0.to_str().unwrap(),
        );
        let mut sessions = vec![];
        for (_, data) in commands {
            let pair = native_pty_system()
                .openpty(PtySize {
                    rows: 24,
                    cols: 80,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .unwrap();
            let mut command = CommandBuilder::new("/bin/sh");
            command.arg("-i");
            command.cwd(&fixture.0);
            let child = pair.slave.spawn_command(command).unwrap();
            drop(pair.slave);
            let mut writer = pair.master.take_writer().unwrap();
            writer.write_all(&data).unwrap();
            writer.write_all(b"exit\r").unwrap();
            writer.flush().unwrap();
            sessions.push((child, pair.master, writer));
        }
        let results: Vec<_> = sessions
            .iter_mut()
            .map(|(child, _, _)| child.wait().unwrap().exit_code())
            .collect();
        assert_ne!(results[0], 0);
        assert_eq!(results[1], 0);
        assert_eq!(
            fs::read_to_string(fixture.0.join("quickstart-cwd")).unwrap(),
            fixture.0.to_string_lossy()
        );
    }

    #[cfg(unix)]
    #[test]
    fn matches_do_not_escape_through_symlinks() {
        let fixture = Fixture::new();
        let outside = Fixture::new();
        outside.touch("secret");
        std::os::unix::fs::symlink(&outside.0, fixture.0.join("outside")).unwrap();
        let mut rule = defaults().remove(0);
        rule.paths = vec!["outside/secret".into()];
        assert!(!matches(&rule, &fixture.0));
    }
}
