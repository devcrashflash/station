import { useEffect, useRef } from "react";
import { emit, listen } from "@tauri-apps/api/event";

import {
  AI_SESSIONS_DESTINATION,
  APP_NAVIGATION_REQUEST_EVENT,
  PROJECT_SWITCHER_DESTINATION,
  SMART_INBOX_DESTINATION,
} from "@/lib/appNavigation";
import {
  isWorkspaceShortcut,
  workspaceNumberShortcut,
  workspaceTabForNumber,
  workspaceTabsApi,
} from "@/lib/workspaceTabs";
import {
  DEFAULT_TERMINAL_SHORTCUTS,
  matchesTerminalShortcut,
  normalizeTerminalShortcuts,
  terminalShortcutRecordingActive,
} from "@/lib/terminalShortcuts";

export function WorkspaceShortcuts() {
  const shortcutsRef = useRef(DEFAULT_TERMINAL_SHORTCUTS);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;
    let disposed = false;
    let unlisten = null;
    async function subscribe() {
      unlisten = await listen("terminal-settings-changed", ({ payload }) => {
        if (!disposed) shortcutsRef.current = normalizeTerminalShortcuts(payload?.shortcuts);
      });
      const settings = await workspaceTabsApi.listTerminalSettings();
      if (!disposed) shortcutsRef.current = normalizeTerminalShortcuts(settings?.shortcuts);
    }
    subscribe().catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;

    function consume(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    async function createTerminal() {
      await workspaceTabsApi.createTerminal();
    }

    function handleCreateTerminalRequest() {
      createTerminal().catch(console.error);
    }

    async function handleKeyDown(event) {
      if (terminalShortcutRecordingActive()) return;
      if (event.repeat) return;
      if (isWorkspaceShortcut(event, "i")) {
        consume(event);
        await emit(APP_NAVIGATION_REQUEST_EVENT, {
          destination: SMART_INBOX_DESTINATION,
        });
        return;
      }
      if (isWorkspaceShortcut(event, "b")) {
        consume(event);
        await emit(APP_NAVIGATION_REQUEST_EVENT, {
          destination: AI_SESSIONS_DESTINATION,
        });
        return;
      }
      if (isWorkspaceShortcut(event, "p")) {
        consume(event);
        const snapshot = await workspaceTabsApi.list();
        const activeTab = snapshot.tabs?.find((tab) => tab.id === snapshot.activeTabId);
        await emit(APP_NAVIGATION_REQUEST_EVENT, {
          destination: PROJECT_SWITCHER_DESTINATION,
          returnTabId: activeTab?.kind === "terminal" ? activeTab.id : undefined,
        });
        return;
      }
      const splitAxis = matchesTerminalShortcut(event, shortcutsRef.current.splitRows)
        ? "rows"
        : matchesTerminalShortcut(event, shortcutsRef.current.splitColumns) ? "columns" : null;
      if (splitAxis) {
        consume(event);
        await workspaceTabsApi.splitActive(splitAxis);
        return;
      }
      const projectSwitcherOpen = Boolean(document.querySelector("[data-project-switcher]"));
      const tabNumber = workspaceNumberShortcut(event, projectSwitcherOpen);
      if (projectSwitcherOpen && /^[0-9]$/.test(event.key) && (event.metaKey || event.ctrlKey)) {
        consume(event);
        return;
      }
      if (tabNumber !== null) {
        consume(event);
        const snapshot = await workspaceTabsApi.list();
        const tab = workspaceTabForNumber(snapshot, tabNumber);
        if (tab) await workspaceTabsApi.activate(tab.id);
        return;
      }
      if (isWorkspaceShortcut(event, "t")) {
        consume(event);
        await createTerminal();
        return;
      }
      if (isWorkspaceShortcut(event, "w")) {
        consume(event);
        await workspaceTabsApi.closeActivePane();
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("workspace-create-terminal", handleCreateTerminalRequest);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("workspace-create-terminal", handleCreateTerminalRequest);
    };
  }, []);

  return null;
}
