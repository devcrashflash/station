import { useEffect, useRef } from "react";
import { emit, listen } from "@tauri-apps/api/event";

import {
  AI_SESSIONS_DESTINATION,
  APP_NAVIGATION_REQUEST_EVENT,
  SMART_INBOX_DESTINATION,
} from "@/lib/appNavigation";
import {
  isWorkspaceShortcut,
  terminalInputFromKeyEvent,
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
  const pendingTerminalRef = useRef(null);
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
      if (pendingTerminalRef.current) return;
      const pending = { data: "" };
      pendingTerminalRef.current = pending;
      let unlisten = null;
      try {
        let createdTabId = null;
        const readyTabs = new Set();
        let markReady;
        const ready = new Promise((resolve) => { markReady = resolve; });
        unlisten = await listen("terminal-startup-ready", ({ payload }) => {
          readyTabs.add(payload.tabId);
          if (payload.tabId === createdTabId) markReady();
        });
        const snapshot = await workspaceTabsApi.createTerminal(true);
        createdTabId = snapshot.activeTabId;
        if (readyTabs.has(createdTabId)) markReady();
        await ready;
        pendingTerminalRef.current = null;
        await workspaceTabsApi.completeTerminalStartupInput(createdTabId, pending.data);
      } finally {
        unlisten?.();
        if (pendingTerminalRef.current === pending) pendingTerminalRef.current = null;
      }
    }

    function handleCreateTerminalRequest() {
      createTerminal().catch(console.error);
    }

    async function handleKeyDown(event) {
      if (terminalShortcutRecordingActive()) return;
      const pendingTerminal = pendingTerminalRef.current;
      if (pendingTerminal) {
        const data = terminalInputFromKeyEvent(event);
        if (data !== null) {
          consume(event);
          pendingTerminal.data += data;
          return;
        }
      }
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
      const splitAxis = matchesTerminalShortcut(event, shortcutsRef.current.splitRows)
        ? "rows"
        : matchesTerminalShortcut(event, shortcutsRef.current.splitColumns) ? "columns" : null;
      if (splitAxis) {
        consume(event);
        await workspaceTabsApi.splitActive(splitAxis);
        return;
      }
      const tabNumber = workspaceNumberShortcut(event);
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
