import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  isWorkspaceShortcut,
  terminalInputFromKeyEvent,
  workspaceSplitShortcut,
  workspaceNumberShortcut,
  workspaceTabForNumber,
  workspaceTabsApi,
} from "@/lib/workspaceTabs";

export function WorkspaceShortcuts() {
  const pendingTerminalRef = useRef(null);

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
      const splitAxis = workspaceSplitShortcut(event);
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
