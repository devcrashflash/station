export const APP_HISTORY_LIMIT = 100;

export function inboxLocation() {
  return { kind: "inbox" };
}

export function projectLocation(projectId) {
  return { kind: "project", projectId };
}

export function taskLocation(task) {
  return {
    kind: "task",
    taskId: task.id,
    projectId: task.projectId || null,
  };
}

export function activityLocation(date) {
  return { kind: "activity", date };
}

export function agentsLocation() {
  return { kind: "agents" };
}

export function unavailableTaskFallback(location, projects) {
  return location?.projectId
    && projects.some((project) => project.id === location.projectId)
    ? projectLocation(location.projectId)
    : inboxLocation();
}

export function appLocationKey(location) {
  switch (location?.kind) {
    case "project":
      return `project:${location.projectId}`;
    case "task":
      return `task:${location.taskId}`;
    case "activity":
      return "activity";
    case "agents":
      return "agents";
    default:
      return "inbox";
  }
}

export function createNavigationHistory(initialLocation = inboxLocation()) {
  return {
    entries: [initialLocation],
    index: 0,
  };
}

export function replaceNavigationHistory(history, location) {
  const entries = [...history.entries];
  entries[history.index] = location;
  return { entries, index: history.index };
}

export function pushNavigationHistory(history, location, limit = APP_HISTORY_LIMIT) {
  if (appLocationKey(history.entries[history.index]) === appLocationKey(location)) {
    return replaceNavigationHistory(history, location);
  }

  const entries = [...history.entries.slice(0, history.index + 1), location];
  const boundedEntries = entries.slice(-Math.max(1, limit));
  return {
    entries: boundedEntries,
    index: boundedEntries.length - 1,
  };
}

export function moveNavigationHistory(history, direction) {
  const delta = direction === "back" ? -1 : direction === "forward" ? 1 : 0;
  const index = history.index + delta;
  if (!delta || index < 0 || index >= history.entries.length) {
    return { history, location: null };
  }
  return {
    history: { entries: history.entries, index },
    location: history.entries[index],
  };
}

export function isEditableHistoryTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return Boolean(target.closest?.(
    "input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox'], .xterm",
  ));
}

export function appHistoryShortcutDirection(
  event,
  platform = globalThis.navigator?.platform || "",
  dialogOpen = Boolean(globalThis.document?.querySelector?.(
    '[data-slot="dialog-content"], [role="dialog"]',
  )),
) {
  if (
    (event.type && event.type !== "keydown")
    || event.defaultPrevented
    || event.repeat
    || event.isComposing
    || dialogOpen
    || event.altKey
    || event.shiftKey
    || isEditableHistoryTarget(event.target)
  ) {
    return null;
  }

  const mac = platform.toLowerCase().startsWith("mac");
  const primaryModifier = mac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!primaryModifier) return null;
  if (event.key === "ArrowLeft") return "back";
  if (event.key === "ArrowRight") return "forward";
  return null;
}
