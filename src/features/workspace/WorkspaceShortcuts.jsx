import { useEffect } from "react";

import {
  isWorkspaceShortcut,
  workspaceSplitShortcut,
  workspaceNumberShortcut,
  workspaceTabForNumber,
  workspaceTabsApi,
} from "@/lib/workspaceTabs";

export function WorkspaceShortcuts() {
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return undefined;

    function consume(event) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    async function handleKeyDown(event) {
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
        await workspaceTabsApi.createTerminal();
        return;
      }
      if (isWorkspaceShortcut(event, "w")) {
        consume(event);
        await workspaceTabsApi.closeActivePane();
      }
    }

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, []);

  return null;
}
