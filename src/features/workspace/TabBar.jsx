import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import {
  reorderTerminalIds,
  requestCloseTerminal,
  workspaceNumberForTab,
  workspaceTabsApi,
} from "@/lib/workspaceTabs";

const EMPTY_SNAPSHOT = { tabs: [{ id: "main", kind: "main", title: "Inbox", closable: false }], activeTabId: "main" };

export function TabBar() {
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [draggedId, setDraggedId] = useState(null);

  useEffect(() => {
    let disposed = false;
    workspaceTabsApi.list().then((next) => {
      if (!disposed) setSnapshot(next);
    }).catch(console.error);
    const unlistenPromise = listen("workspace-tabs-changed", ({ payload }) => {
      if (!disposed) setSnapshot(payload);
    });
    return () => {
      disposed = true;
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  async function activate(tabId) {
    setSnapshot(await workspaceTabsApi.activate(tabId));
  }

  async function close(event, tab) {
    event.stopPropagation();
    const next = await requestCloseTerminal(tab);
    if (next) setSnapshot(next);
  }

  async function dropOn(event, targetId) {
    event.preventDefault();
    if (!draggedId) return;
    const tabIds = reorderTerminalIds(snapshot.tabs, draggedId, targetId);
    setDraggedId(null);
    setSnapshot(await workspaceTabsApi.reorder(tabIds));
  }

  return (
    <main className="tab-bar" role="tablist" aria-label="Workspace tabs">
      <div className="tab-bar-items">
        {snapshot.tabs.map((tab) => {
          const active = tab.id === snapshot.activeTabId;
          const shortcutNumber = workspaceNumberForTab(snapshot, tab.id);
          return (
            <div
              key={tab.id}
              className={`workspace-tab ${tab.kind === "main" ? "workspace-tab-main" : ""} ${active ? "workspace-tab-active" : ""} ${tab.running === false && tab.kind === "terminal" ? "workspace-tab-exited" : ""}`}
              draggable={tab.kind === "terminal"}
              onDragStart={(event) => {
                setDraggedId(tab.id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={() => setDraggedId(null)}
              onDragOver={(event) => tab.kind === "terminal" && event.preventDefault()}
              onDrop={(event) => tab.kind === "terminal" && dropOn(event, tab.id)}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="workspace-tab-select"
                onClick={() => activate(tab.id)}
                title={tab.title}
              >
                <span className="workspace-tab-title">{tab.title}</span>
                {shortcutNumber !== null && (
                  <span className="workspace-tab-shortcut" aria-hidden="true">⌘{shortcutNumber}</span>
                )}
              </button>
              {tab.closable && (
                <button
                  type="button"
                  aria-label={`Close ${tab.title}`}
                  className="workspace-tab-close"
                  onClick={(event) => close(event, tab)}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        <button
          type="button"
          className="workspace-tab-add"
          title="New terminal (Cmd/Ctrl+T)"
          aria-label="New terminal"
          onClick={() => workspaceTabsApi.createTerminal().then(setSnapshot)}
        >
          +
        </button>
      </div>
    </main>
  );
}
