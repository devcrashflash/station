import { invoke } from "@tauri-apps/api/core";

export const MAIN_WORKSPACE_TAB_ID = "main";

export const workspaceTabsApi = {
  list: () => invoke("list_workspace_tabs"),
  createTerminal: () => invoke("create_terminal_tab"),
  activate: (tabId) => invoke("activate_tab", { tabId }),
  reorder: (tabIds) => invoke("reorder_tabs", { tabIds }),
  close: (tabId) => invoke("close_terminal_tab", { tabId }),
  closeActivePane: () => invoke("close_active_terminal_pane"),
  splitActive: (axis) => invoke("split_active_terminal", { axis }),
};

export function terminalTabs(snapshot) {
  return (snapshot?.tabs || []).filter((tab) => tab.kind === "terminal");
}

export function reorderTerminalIds(tabs, draggedId, targetId) {
  const ids = terminalTabs({ tabs }).map((tab) => tab.id);
  const from = ids.indexOf(draggedId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0 || from === to) return ids;
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  return ids;
}

export function isWorkspaceShortcut(event, key) {
  return !event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === key;
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

export function workspaceNumberShortcut(event) {
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
