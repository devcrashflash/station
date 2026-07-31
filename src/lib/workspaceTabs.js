import { invoke } from "@tauri-apps/api/core";

export const MAIN_WORKSPACE_TAB_ID = "main";

export const workspaceTabsApi = {
  list: () => invoke("list_workspace_tabs"),
  createTerminal: (deferInput = false, cwd = null) => invoke("create_terminal_tab", { deferInput, cwd }),
  completeTerminalStartupInput: (tabId, data) => invoke("complete_terminal_startup_input", { tabId, data }),
  activate: (tabId) => invoke("activate_tab", { tabId }),
  reorder: (tabIds) => invoke("reorder_tabs", { tabIds }),
  close: (tabId) => invoke("close_terminal_tab", { tabId }),
  closeActivePane: () => invoke("close_active_terminal_pane"),
  splitActive: (axis) => invoke("split_active_terminal", { axis }),
  listTerminalSettings: () => invoke("list_terminal_settings"),
};

export function terminalTabs(snapshot) {
  return (snapshot?.tabs || []).filter((tab) => tab.kind === "terminal");
}

export function reorderTerminalIds(tabs, draggedId, targetId, placement = null) {
  const ids = terminalTabs({ tabs }).map((tab) => tab.id);
  const from = ids.indexOf(draggedId);
  const to = ids.indexOf(targetId);
  const resolvedPlacement = placement ?? (from < to ? "after" : "before");
  if (from < 0 || to < 0 || from === to || !["before", "after"].includes(resolvedPlacement)) return ids;
  const [moved] = ids.splice(from, 1);
  const targetIndex = ids.indexOf(targetId);
  ids.splice(targetIndex + (resolvedPlacement === "after" ? 1 : 0), 0, moved);
  return ids;
}

export function withTerminalTabOrder(snapshot, tabIds) {
  const current = terminalTabs(snapshot);
  const requestedIds = new Set(tabIds);
  if (tabIds.length !== current.length
    || requestedIds.size !== tabIds.length
    || current.some((tab) => !requestedIds.has(tab.id))) {
    return snapshot;
  }
  const tabsById = new Map(current.map((tab) => [tab.id, tab]));
  const ordered = tabIds.map((id) => tabsById.get(id));
  let terminalIndex = 0;
  return {
    ...snapshot,
    tabs: snapshot.tabs.map((tab) => (
      tab.kind === "terminal" ? ordered[terminalIndex++] : tab
    )),
  };
}

export function terminalTabDropPlacement(
  bounds,
  clientX,
  clientY,
  sourceIndex,
  targetIndex,
  threshold = 0.25,
) {
  if (!bounds || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const { left, top, width, height } = bounds;
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  if (clientX < left || clientX > left + width || clientY < top || clientY > top + height) return null;
  if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex)
    || sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex
    || !Number.isFinite(threshold) || threshold <= 0 || threshold > 0.5) {
    return null;
  }
  if (targetIndex > sourceIndex) {
    return clientX >= left + width * threshold ? "after" : null;
  }
  return clientX <= left + width * (1 - threshold) ? "before" : null;
}

export function isWorkspaceShortcut(event, key) {
  return !event.altKey
    && !event.shiftKey
    && (event.metaKey || event.ctrlKey)
    && event.key.toLowerCase() === key;
}

export function workspaceSplitShortcut(event, platform = globalThis.navigator?.platform || "") {
  if (event.altKey || event.key.toLowerCase() !== "d") return null;
  const mac = platform.toLowerCase().startsWith("mac");
  const expectedModifier = mac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!expectedModifier) return null;
  return event.shiftKey ? "rows" : "columns";
}

export function workspaceNumberShortcut(event, projectSwitcherOpen = false) {
  if (projectSwitcherOpen) return null;
  if (event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey)) return null;
  if (!/^[0-9]$/.test(event.key)) return null;
  return Number(event.key);
}

export function workspaceTabForNumber(snapshot, number) {
  if (!Number.isInteger(number) || number < 0 || number > 9) return null;
  if (number === 0) {
    return snapshot?.tabs?.find((tab) => tab.id === MAIN_WORKSPACE_TAB_ID) || null;
  }
  return terminalTabs(snapshot)[number - 1] || null;
}

export function workspaceNumberForTab(snapshot, tabId) {
  if (tabId === MAIN_WORKSPACE_TAB_ID) return 0;
  const index = terminalTabs(snapshot).findIndex((tab) => tab.id === tabId);
  if (index < 0 || index >= 9) return null;
  return index + 1;
}

export async function requestCloseTerminal(tab) {
  if (!tab || tab.kind !== "terminal") return null;
  return workspaceTabsApi.close(tab.id);
}

export function activeWorkspaceTab(snapshot) {
  return snapshot?.tabs?.find((tab) => tab.id === snapshot.activeTabId) || null;
}
