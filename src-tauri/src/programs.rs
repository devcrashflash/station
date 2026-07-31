use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use image::ImageFormat;
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
};
use tauri::Manager;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgramSummary {
    id: String,
    name: String,
    description: Option<String>,
    icon: Option<String>,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
enum ProgramLaunchTarget {
    MacApplication(PathBuf),
    WindowsApplicationId(String),
    WindowsShortcut(PathBuf),
    LinuxDesktop {
        path: PathBuf,
        name: String,
        icon_name: Option<String>,
        exec: String,
    },
}

#[derive(Debug, Clone)]
enum ProgramIconSource {
    File(PathBuf),
}

#[derive(Debug, Clone)]
struct ProgramEntry {
    summary: ProgramSummary,
    launch_target: ProgramLaunchTarget,
    icon_source: Option<ProgramIconSource>,
    icon_loaded: bool,
}

#[derive(Default)]
pub struct ProgramCatalog(Mutex<HashMap<String, ProgramEntry>>);

fn program_id(identity: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(identity.as_bytes());
    format!("program-{:x}", hasher.finalize())
}

fn canonical_identity(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_lowercase()
}

fn entry(
    identity: String,
    name: String,
    description: Option<String>,
    launch_target: ProgramLaunchTarget,
    icon_source: Option<ProgramIconSource>,
) -> ProgramEntry {
    ProgramEntry {
        summary: ProgramSummary {
            id: program_id(&identity),
            name,
            description,
            icon: None,
        },
        launch_target,
        icon_source,
        icon_loaded: false,
    }
}

fn sort_entries(entries: &mut [ProgramEntry]) {
    entries.sort_by(|left, right| {
        left.summary
            .name
            .to_lowercase()
            .cmp(&right.summary.name.to_lowercase())
            .then_with(|| left.summary.name.cmp(&right.summary.name))
            .then_with(|| left.summary.id.cmp(&right.summary.id))
    });
}

fn deduplicate_entries(entries: Vec<(String, ProgramEntry)>) -> Vec<ProgramEntry> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();
    for (identity, program) in entries {
        if seen.insert(identity.to_lowercase()) {
            unique.push(program);
        }
    }
    sort_entries(&mut unique);
    unique
}

fn catalog_from_entries(entries: Vec<ProgramEntry>) -> HashMap<String, ProgramEntry> {
    entries
        .into_iter()
        .map(|program| (program.summary.id.clone(), program))
        .collect()
}

fn catalog_launch_target(
    catalog: &HashMap<String, ProgramEntry>,
    id: &str,
) -> Result<ProgramLaunchTarget, String> {
    catalog
        .get(id)
        .map(|program| program.launch_target.clone())
        .ok_or_else(|| "That application is no longer available.".to_string())
}

#[cfg(target_os = "macos")]
fn mac_application_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join("Applications"));
    }
    roots.extend([
        PathBuf::from("/Applications"),
        PathBuf::from("/System/Applications"),
        PathBuf::from("/System/Applications/Utilities"),
    ]);
    roots
}

#[cfg(target_os = "macos")]
fn collect_mac_applications(directory: &Path, depth: usize, output: &mut Vec<PathBuf>) {
    if depth > 3 {
        return;
    }
    let Ok(children) = fs::read_dir(directory) else {
        return;
    };
    for child in children.flatten() {
        let path = child.path();
        let is_application = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("app"));
        if is_application {
            output.push(path);
        } else if child.file_type().is_ok_and(|kind| kind.is_dir()) {
            collect_mac_applications(&path, depth + 1, output);
        }
    }
}

#[cfg(target_os = "macos")]
fn plist_string(dictionary: &plist::Dictionary, key: &str) -> Option<String> {
    dictionary
        .get(key)
        .and_then(plist::Value::as_string)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

#[cfg(target_os = "macos")]
fn mac_icon_source(
    bundle: &Path,
    dictionary: Option<&plist::Dictionary>,
) -> Option<ProgramIconSource> {
    let resources = bundle.join("Contents/Resources");
    let configured = dictionary
        .and_then(|values| plist_string(values, "CFBundleIconFile"))
        .map(|name| {
            let path = resources.join(&name);
            if path.extension().is_none() {
                path.with_extension("icns")
            } else {
                path
            }
        })
        .filter(|path| path.is_file());
    if let Some(path) = configured {
        return Some(ProgramIconSource::File(path));
    }
    fs::read_dir(resources)
        .ok()?
        .flatten()
        .map(|child| child.path())
        .find(|path| {
            path.extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    matches!(extension.to_lowercase().as_str(), "icns" | "png")
                })
        })
        .map(ProgramIconSource::File)
}

#[cfg(target_os = "macos")]
fn discover_programs() -> Vec<ProgramEntry> {
    let mut bundles = Vec::new();
    for root in mac_application_roots() {
        collect_mac_applications(&root, 0, &mut bundles);
    }

    let entries = bundles
        .into_iter()
        .filter_map(|bundle| {
            let fallback_name = bundle.file_stem()?.to_string_lossy().trim().to_string();
            if fallback_name.is_empty() {
                return None;
            }
            let plist = plist::Value::from_file(bundle.join("Contents/Info.plist")).ok();
            let dictionary = plist.as_ref().and_then(plist::Value::as_dictionary);
            let name = dictionary
                .and_then(|values| {
                    plist_string(values, "CFBundleDisplayName")
                        .or_else(|| plist_string(values, "CFBundleName"))
                })
                .unwrap_or(fallback_name);
            let bundle_id =
                dictionary.and_then(|values| plist_string(values, "CFBundleIdentifier"));
            let identity = bundle_id
                .as_ref()
                .map(|id| format!("mac-bundle:{id}"))
                .unwrap_or_else(|| format!("mac-path:{}", canonical_identity(&bundle)));
            let description = bundle_id
                .clone()
                .or_else(|| Some(bundle.to_string_lossy().into_owned()));
            let icon_source = mac_icon_source(&bundle, dictionary);
            let program = entry(
                identity.clone(),
                name,
                description,
                ProgramLaunchTarget::MacApplication(bundle),
                icon_source,
            );
            Some((identity, program))
        })
        .collect();
    deduplicate_entries(entries)
}

#[cfg(windows)]
fn windows_start_apps() -> Result<Vec<(String, String)>, String> {
    let output = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
        ])
        .output()
        .map_err(|error| format!("Could not enumerate Windows applications: {error}"))?;
    if !output.status.success() {
        return Err("Windows application enumeration failed.".to_string());
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Could not read Windows applications: {error}"))?;
    let values = match value {
        serde_json::Value::Array(values) => values,
        serde_json::Value::Object(object) => vec![serde_json::Value::Object(object)],
        serde_json::Value::Null => Vec::new(),
        _ => return Err("Windows returned malformed application data.".to_string()),
    };
    Ok(values
        .into_iter()
        .filter_map(|value| {
            let name = value.get("Name")?.as_str()?.trim();
            let app_id = value.get("AppID")?.as_str()?.trim();
            (!name.is_empty() && !app_id.is_empty()).then(|| (name.to_string(), app_id.to_string()))
        })
        .collect())
}

#[cfg(windows)]
fn collect_windows_shortcuts(directory: &Path, output: &mut Vec<PathBuf>) {
    let Ok(children) = fs::read_dir(directory) else {
        return;
    };
    for child in children.flatten() {
        let path = child.path();
        if child.file_type().is_ok_and(|kind| kind.is_dir()) {
            collect_windows_shortcuts(&path, output);
            continue;
        }
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if extension.eq_ignore_ascii_case("lnk") || extension.eq_ignore_ascii_case("appref-ms") {
            output.push(path);
        }
    }
}

#[cfg(windows)]
fn windows_shortcut_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(app_data) = std::env::var_os("APPDATA") {
        roots.push(PathBuf::from(app_data).join("Microsoft/Windows/Start Menu/Programs"));
    }
    if let Some(program_data) = std::env::var_os("ProgramData") {
        roots.push(PathBuf::from(program_data).join("Microsoft/Windows/Start Menu/Programs"));
    }
    roots
}

#[cfg(windows)]
fn discover_programs() -> Vec<ProgramEntry> {
    let start_apps = windows_start_apps().unwrap_or_default();
    let mut entries: Vec<(String, ProgramEntry)> = start_apps
        .into_iter()
        .map(|(name, app_id)| {
            let identity = format!("windows-app:{app_id}");
            let program = entry(
                identity.clone(),
                name,
                Some(app_id.clone()),
                ProgramLaunchTarget::WindowsApplicationId(app_id),
                None,
            );
            (identity, program)
        })
        .collect();

    if entries.is_empty() {
        let mut shortcuts = Vec::new();
        for root in windows_shortcut_roots() {
            collect_windows_shortcuts(&root, &mut shortcuts);
        }
        entries.extend(shortcuts.into_iter().filter_map(|path| {
            let name = path.file_stem()?.to_string_lossy().trim().to_string();
            if name.is_empty() {
                return None;
            }
            let identity = format!("windows-shortcut:{}", canonical_identity(&path));
            let program = entry(
                identity.clone(),
                name,
                path.parent()
                    .map(|parent| parent.to_string_lossy().into_owned()),
                ProgramLaunchTarget::WindowsShortcut(path),
                None,
            );
            Some((identity, program))
        }));
    }
    deduplicate_entries(entries)
}

#[cfg(any(target_os = "linux", test))]
#[derive(Debug, Default, PartialEq, Eq)]
struct DesktopEntry {
    name: Option<String>,
    comment: Option<String>,
    icon: Option<String>,
    exec: Option<String>,
    entry_type: Option<String>,
    hidden: bool,
    no_display: bool,
}

#[cfg(any(target_os = "linux", test))]
fn parse_bool(value: &str) -> bool {
    value.trim().eq_ignore_ascii_case("true") || value.trim() == "1"
}

#[cfg(any(target_os = "linux", test))]
fn parse_desktop_entry(contents: &str) -> DesktopEntry {
    let mut result = DesktopEntry::default();
    let mut in_desktop_entry = false;
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_desktop_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_desktop_entry || line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "Name" => result.name = (!value.is_empty()).then(|| value.to_string()),
            "Comment" => result.comment = (!value.is_empty()).then(|| value.to_string()),
            "Icon" => result.icon = (!value.is_empty()).then(|| value.to_string()),
            "Exec" => result.exec = (!value.is_empty()).then(|| value.to_string()),
            "Type" => result.entry_type = (!value.is_empty()).then(|| value.to_string()),
            "Hidden" => result.hidden = parse_bool(value),
            "NoDisplay" => result.no_display = parse_bool(value),
            _ => {}
        }
    }
    result
}

#[cfg(target_os = "linux")]
fn linux_application_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(data_home) = std::env::var_os("XDG_DATA_HOME") {
        roots.push(PathBuf::from(data_home).join("applications"));
    } else if let Some(home) = std::env::var_os("HOME") {
        roots.push(PathBuf::from(home).join(".local/share/applications"));
    }
    let data_dirs = std::env::var("XDG_DATA_DIRS")
        .unwrap_or_else(|_| "/usr/local/share:/usr/share".to_string());
    roots.extend(std::env::split_paths(&data_dirs).map(|directory| directory.join("applications")));
    roots
}

#[cfg(target_os = "linux")]
fn collect_desktop_files(directory: &Path, output: &mut Vec<PathBuf>) {
    let Ok(children) = fs::read_dir(directory) else {
        return;
    };
    for child in children.flatten() {
        let path = child.path();
        if child.file_type().is_ok_and(|kind| kind.is_dir()) {
            collect_desktop_files(&path, output);
        } else if path.extension().and_then(|value| value.to_str()) == Some("desktop") {
            output.push(path);
        }
    }
}

#[cfg(target_os = "linux")]
fn linux_icon_source(icon: Option<&str>) -> Option<ProgramIconSource> {
    let icon = icon?.trim();
    if icon.is_empty() {
        return None;
    }
    let direct = PathBuf::from(icon);
    if direct.is_absolute() && direct.is_file() {
        return Some(ProgramIconSource::File(direct));
    }
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let base = PathBuf::from(home).join(".local/share/icons/hicolor");
        for size in ["64x64", "48x48", "32x32"] {
            candidates.push(base.join(size).join("apps").join(format!("{icon}.png")));
        }
    }
    for base in ["/usr/local/share/icons/hicolor", "/usr/share/icons/hicolor"] {
        for size in ["64x64", "48x48", "32x32"] {
            candidates.push(
                Path::new(base)
                    .join(size)
                    .join("apps")
                    .join(format!("{icon}.png")),
            );
        }
    }
    candidates.push(PathBuf::from("/usr/local/share/pixmaps").join(format!("{icon}.png")));
    candidates.push(PathBuf::from("/usr/share/pixmaps").join(format!("{icon}.png")));
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(ProgramIconSource::File)
}

#[cfg(target_os = "linux")]
fn linux_desktop_id(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('/', "-")
        .replace('\\', "-")
}

#[cfg(target_os = "linux")]
fn discover_programs() -> Vec<ProgramEntry> {
    let mut entries = Vec::new();
    let mut seen_desktop_ids = HashSet::new();
    for root in linux_application_roots() {
        let mut files = Vec::new();
        collect_desktop_files(&root, &mut files);
        for path in files {
            let desktop_id = linux_desktop_id(&root, &path);
            if !seen_desktop_ids.insert(desktop_id.to_lowercase()) {
                continue;
            }
            let Ok(contents) = fs::read_to_string(&path) else {
                continue;
            };
            let desktop = parse_desktop_entry(&contents);
            if desktop.hidden
                || desktop.no_display
                || desktop.entry_type.as_deref() != Some("Application")
            {
                continue;
            }
            let (Some(name), Some(exec)) = (desktop.name, desktop.exec) else {
                continue;
            };
            let identity = format!("linux-desktop:{desktop_id}");
            let icon_source = linux_icon_source(desktop.icon.as_deref());
            let program = entry(
                identity.clone(),
                name.clone(),
                desktop.comment,
                ProgramLaunchTarget::LinuxDesktop {
                    path,
                    name,
                    icon_name: desktop.icon,
                    exec,
                },
                icon_source,
            );
            entries.push((identity, program));
        }
    }
    deduplicate_entries(entries)
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
fn discover_programs() -> Vec<ProgramEntry> {
    Vec::new()
}

fn raster_icon_data(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let decoded = image::load_from_memory(&bytes).ok()?;
    let resized = decoded.thumbnail(64, 64);
    let mut png = Cursor::new(Vec::new());
    resized.write_to(&mut png, ImageFormat::Png).ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        BASE64_STANDARD.encode(png.into_inner())
    ))
}

#[cfg(target_os = "macos")]
fn mac_icon_data(path: &Path) -> Option<String> {
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("icns"))
    {
        return raster_icon_data(path);
    }
    let digest = program_id(&canonical_identity(path));
    let output_path = std::env::temp_dir().join(format!("station-{digest}.png"));
    let status = Command::new("/usr/bin/sips")
        .args(["-s", "format", "png"])
        .arg(path)
        .arg("--out")
        .arg(&output_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()?;
    if !status.success() {
        let _ = fs::remove_file(&output_path);
        return None;
    }
    let result = raster_icon_data(&output_path);
    let _ = fs::remove_file(output_path);
    result
}

fn load_icon(source: &ProgramIconSource) -> Option<String> {
    match source {
        ProgramIconSource::File(path) => {
            #[cfg(target_os = "macos")]
            return mac_icon_data(path);
            #[cfg(not(target_os = "macos"))]
            return raster_icon_data(path);
        }
    }
}

fn split_exec(exec: &str) -> Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in exec.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if character == active_quote {
                quote = None;
            } else {
                current.push(character);
            }
            continue;
        }
        if character == '\'' || character == '"' {
            quote = Some(character);
        } else if character.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
        } else {
            current.push(character);
        }
    }
    if escaped {
        current.push('\\');
    }
    if quote.is_some() {
        return Err("Application launcher contains an unterminated quote.".to_string());
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    if tokens.is_empty() {
        return Err("Application launcher is empty.".to_string());
    }
    Ok(tokens)
}

fn expand_desktop_exec(
    exec: &str,
    name: &str,
    icon_name: Option<&str>,
    desktop_path: &Path,
) -> Result<Vec<String>, String> {
    let tokens = split_exec(exec)?;
    let mut output = Vec::new();
    for token in tokens {
        if token == "%i" {
            if let Some(icon) = icon_name {
                output.push("--icon".to_string());
                output.push(icon.to_string());
            }
            continue;
        }
        if matches!(token.as_str(), "%f" | "%F" | "%u" | "%U") {
            continue;
        }
        let mut expanded = String::new();
        let mut characters = token.chars();
        while let Some(character) = characters.next() {
            if character != '%' {
                expanded.push(character);
                continue;
            }
            match characters.next() {
                Some('%') => expanded.push('%'),
                Some('c') => expanded.push_str(name),
                Some('k') => expanded.push_str(&desktop_path.to_string_lossy()),
                Some('f' | 'F' | 'u' | 'U') => {}
                Some('i') => {}
                Some(other) => {
                    expanded.push('%');
                    expanded.push(other);
                }
                None => expanded.push('%'),
            }
        }
        if !expanded.is_empty() {
            output.push(expanded);
        }
    }
    if output.is_empty() || output[0].is_empty() {
        return Err("Application launcher is empty.".to_string());
    }
    Ok(output)
}

fn launch_target(target: ProgramLaunchTarget) -> Result<(), String> {
    match target {
        ProgramLaunchTarget::MacApplication(path) => Command::new("open").arg(path).spawn(),
        ProgramLaunchTarget::WindowsApplicationId(app_id) => Command::new("explorer.exe")
            .arg(format!("shell:AppsFolder\\{app_id}"))
            .spawn(),
        ProgramLaunchTarget::WindowsShortcut(path) => {
            Command::new("explorer.exe").arg(path).spawn()
        }
        ProgramLaunchTarget::LinuxDesktop {
            path,
            name,
            icon_name,
            exec,
        } => {
            if Command::new("gio")
                .arg("launch")
                .arg(&path)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
            {
                return Ok(());
            }
            let arguments = expand_desktop_exec(&exec, &name, icon_name.as_deref(), &path)?;
            Command::new(&arguments[0]).args(&arguments[1..]).spawn()
        }
    }
    .map(|_| ())
    .map_err(|error| format!("Could not launch application: {error}"))
}

#[tauri::command]
pub async fn list_programs(app: tauri::AppHandle) -> Result<Vec<ProgramSummary>, String> {
    let entries = tauri::async_runtime::spawn_blocking(discover_programs)
        .await
        .map_err(|error| format!("Could not enumerate applications: {error}"))?;
    let summaries = entries
        .iter()
        .map(|program| program.summary.clone())
        .collect();
    let state = app.state::<ProgramCatalog>();
    let mut catalog = state.0.lock().map_err(|error| error.to_string())?;
    *catalog = catalog_from_entries(entries);
    Ok(summaries)
}

#[tauri::command]
pub async fn program_icon(app: tauri::AppHandle, id: String) -> Result<Option<String>, String> {
    let source = {
        let state = app.state::<ProgramCatalog>();
        let catalog = state.0.lock().map_err(|error| error.to_string())?;
        let program = catalog
            .get(&id)
            .ok_or_else(|| "That application is no longer available.".to_string())?;
        if program.icon_loaded {
            return Ok(program.summary.icon.clone());
        }
        program.icon_source.clone()
    };
    let icon = tauri::async_runtime::spawn_blocking(move || source.as_ref().and_then(load_icon))
        .await
        .map_err(|error| format!("Could not load application icon: {error}"))?;
    let state = app.state::<ProgramCatalog>();
    let mut catalog = state.0.lock().map_err(|error| error.to_string())?;
    if let Some(program) = catalog.get_mut(&id) {
        program.summary.icon = icon.clone();
        program.icon_loaded = true;
    }
    Ok(icon)
}

#[tauri::command]
pub async fn launch_program(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let target = {
        let state = app.state::<ProgramCatalog>();
        let catalog = state.0.lock().map_err(|error| error.to_string())?;
        catalog_launch_target(&catalog, &id)?
    };
    tauri::async_runtime::spawn_blocking(move || launch_target(target))
        .await
        .map_err(|error| format!("Could not launch application: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_visible_desktop_entries() {
        let parsed = parse_desktop_entry(
            "[Desktop Entry]\nType=Application\nName=Visual Studio Code\nComment=Editor\nIcon=code\nExec=code %F\n",
        );
        assert_eq!(parsed.entry_type.as_deref(), Some("Application"));
        assert_eq!(parsed.name.as_deref(), Some("Visual Studio Code"));
        assert_eq!(parsed.comment.as_deref(), Some("Editor"));
        assert_eq!(parsed.exec.as_deref(), Some("code %F"));
        assert!(!parsed.hidden);
        assert!(!parsed.no_display);
    }

    #[test]
    fn parses_hidden_and_malformed_desktop_entries_safely() {
        let parsed = parse_desktop_entry(
            "ignored=true\n[Desktop Entry]\nType=Application\nHidden=true\nNoDisplay=1\nBroken\n",
        );
        assert!(parsed.hidden);
        assert!(parsed.no_display);
        assert_eq!(parsed.name, None);
        assert_eq!(parsed.exec, None);
    }

    #[test]
    fn desktop_exec_is_tokenized_without_shell_interpolation() {
        let path = Path::new("/usr/share/applications/editor.desktop");
        assert_eq!(
            expand_desktop_exec(
                "editor --name %c --desktop=%k %F 'literal;touch /tmp/nope'",
                "My Editor",
                None,
                path,
            )
            .unwrap(),
            vec![
                "editor",
                "--name",
                "My Editor",
                "--desktop=/usr/share/applications/editor.desktop",
                "literal;touch /tmp/nope",
            ]
        );
    }

    #[test]
    fn deduplicates_by_platform_identity_and_sorts_names() {
        let first = entry(
            "same".into(),
            "Zulu".into(),
            None,
            ProgramLaunchTarget::MacApplication(PathBuf::from("/one")),
            None,
        );
        let duplicate = entry(
            "same".into(),
            "Duplicate".into(),
            None,
            ProgramLaunchTarget::MacApplication(PathBuf::from("/two")),
            None,
        );
        let alpha = entry(
            "alpha".into(),
            "Alpha".into(),
            None,
            ProgramLaunchTarget::MacApplication(PathBuf::from("/alpha")),
            None,
        );
        let programs = deduplicate_entries(vec![
            ("same".into(), first),
            ("SAME".into(), duplicate),
            ("alpha".into(), alpha),
        ]);
        assert_eq!(programs.len(), 2);
        assert_eq!(programs[0].summary.name, "Alpha");
        assert_eq!(programs[1].summary.name, "Zulu");
    }

    #[test]
    fn catalog_exposes_only_current_opaque_program_ids() {
        let old = entry(
            "old".into(),
            "Old".into(),
            None,
            ProgramLaunchTarget::MacApplication(PathBuf::from("/old")),
            None,
        );
        let old_id = old.summary.id.clone();
        let current = entry(
            "current".into(),
            "Current".into(),
            None,
            ProgramLaunchTarget::MacApplication(PathBuf::from("/current")),
            None,
        );
        let current_id = current.summary.id.clone();
        let catalog = catalog_from_entries(vec![current]);

        assert!(catalog_launch_target(&catalog, &current_id).is_ok());
        assert_eq!(
            catalog_launch_target(&catalog, &old_id).unwrap_err(),
            "That application is no longer available."
        );
        assert_eq!(
            catalog_launch_target(&catalog, "/Applications/Injected.app").unwrap_err(),
            "That application is no longer available."
        );
    }
}
