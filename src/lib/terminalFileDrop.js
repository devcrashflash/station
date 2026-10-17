// Format arguments for the shell launched by Station, not a nested shell or SSH.
export function formatTerminalDropPaths(paths, shellPath) {
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const shell = String(shellPath || "").split(/[\\/]/).at(-1).toLowerCase().replace(/\.exe$/, "");
  if (!shell) throw new Error("The terminal is not ready to receive files.");
  const formatted = paths.map((path) => {
    if (typeof path !== "string" || !path || /[\x00-\x1f\x7f-\x9f]/.test(path)) {
      throw new Error("Cannot drop paths containing terminal control characters.");
    }
    if (!/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path)) {
      throw new Error("Only absolute local file paths can be dropped into Terminal.");
    }
    if (shell === "cmd") {
      // cmd expands variables even inside quotes. There is no general literal
      // quoting for %...% or delayed !...! expansion in an interactive prompt.
      if (/["%!]/.test(path)) {
        throw new Error('Cannot safely drop paths containing quotes, % or ! into cmd.exe. A terminal launched with PowerShell supports these paths.');
      }
      // Preserve trailing directory separators for Windows argv parsers, which
      // otherwise interpret a backslash before the closing quote as an escape.
      return `"${path.replace(/\\+$/, (slashes) => slashes + slashes)}"`;
    }
    if (shell === "powershell" || shell === "pwsh") return `'${path.replaceAll("'", "''")}'`;
    if (shell === "fish") return `'${path.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
    if (["sh", "bash", "zsh", "dash", "ksh", "ash"].includes(shell)) {
      return `'${path.replaceAll("'", "'\\''")}'`;
    }
    throw new Error(`File drops are not supported for the ${shell} shell.`);
  });
  return `${formatted.join(" ")} `;
}

export function terminalDropPoint(position, scaleFactor) {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)
    || !Number.isFinite(scaleFactor) || scaleFactor <= 0) return null;
  return { x: position.x / scaleFactor, y: position.y / scaleFactor };
}

export function terminalFileDropTarget(targets, point, hit, activeTabId) {
  if (!point || !hit) return null;
  return targets.find((target) => {
    if (!target.active || !target.running || !target.ready || target.tabId !== activeTabId
      || !target.host?.isConnected || !target.host.contains(hit)) return false;
    const rect = target.host.getBoundingClientRect();
    return point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom;
  }) || null;
}

// One controller per webview. Keep input delivery synchronous so focus IPC
// cannot redirect a pending drop after switching tabs or closing a pane.
export function createTerminalFileDropController({ getTargets, getActiveTabId, getScaleFactor, elementFromPoint, onError }) {
  let paths = [];
  let dragTabId = null;
  let highlighted = null;
  function clearHighlight() {
    highlighted?.classList.remove("terminal-file-drop-hover");
    highlighted = null;
  }
  function reset() {
    clearHighlight();
    paths = [];
    dragTabId = null;
  }
  function handle(payload) {
    clearHighlight();
    if (payload.type === "leave") return reset();
    if (payload.type === "enter") {
      paths = Array.isArray(payload.paths) ? payload.paths : [];
      dragTabId = getActiveTabId();
    }
    if (!["enter", "over", "drop"].includes(payload.type)) return;
    const activeTabId = getActiveTabId();
    // Keep the original tab until leave/new enter: resetting it on an over
    // event would allow a later drop event to reach the newly active tab.
    if (dragTabId !== null && dragTabId !== activeTabId) {
      paths = [];
      return;
    }
    const point = terminalDropPoint(payload.position, getScaleFactor());
    const target = terminalFileDropTarget(
      getTargets(), point, point && elementFromPoint(point.x, point.y), activeTabId,
    );
    if (payload.type !== "drop") {
      if (target && paths.length) {
        highlighted = target.host;
        highlighted.classList.add("terminal-file-drop-hover");
      }
      return;
    }
    const droppedPaths = payload.paths?.length ? payload.paths : paths;
    reset();
    if (!target) return;
    try {
      const text = formatTerminalDropPaths(droppedPaths, target.shell);
      if (text) {
        target.focus();
        target.terminal.paste(text);
      }
    } catch (error) {
      onError(error.message);
    }
  }
  return { handle, reset, clearHighlight };
}
