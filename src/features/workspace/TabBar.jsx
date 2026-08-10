import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { api } from "@/lib/api";
import {
  AI_SESSION_MONITOR_UPDATED_EVENT,
  aiSessionWaitingTerminalTabIdsFromPayload,
  aiSessionWaitingStatusFromPayload,
} from "@/lib/aiSessionEvents";
import {
  reorderTerminalIds,
  requestCloseTerminal,
  terminalPersistenceWarning,
  terminalTabDropPlacement,
  terminalTabs,
  withTerminalTabOrder,
  workspaceNumberForTab,
  workspaceTabsApi,
} from "@/lib/workspaceTabs";
import { formatShortcut } from "@/lib/keyboardShortcut";
import { useSynchronizedTheme } from "@/lib/theme";

const EMPTY_SNAPSHOT = { tabs: [{ id: "main", kind: "main", title: "Inbox", closable: false }], activeTabId: "main" };

function sameIds(left, right) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function TabBar() {
  useSynchronizedTheme();
  const newTerminalShortcut = formatShortcut("CommandOrControl+KeyT");
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [tabDrag, setTabDrag] = useState(null);
  const [hasWaitingAiSession, setHasWaitingAiSession] = useState(false);
  const [waitingTerminalTabIds, setWaitingTerminalTabIds] = useState([]);
  const tabBarItemsRef = useRef(null);
  const suppressActivationRef = useRef(false);
  const persistenceWarning = terminalPersistenceWarning(snapshot);

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

  useEffect(() => {
    let disposed = false;
    let unlisten = null;
    listen(AI_SESSION_MONITOR_UPDATED_EVENT, ({ payload }) => {
      if (!disposed) {
        setHasWaitingAiSession(aiSessionWaitingStatusFromPayload(payload));
        const nextIds = aiSessionWaitingTerminalTabIdsFromPayload(payload);
        setWaitingTerminalTabIds((current) => (sameIds(current, nextIds) ? current : nextIds));
      }
    }).then((cleanup) => {
      if (disposed) {
        cleanup();
        return;
      }
      unlisten = cleanup;
      api.latestAiSessionStatus().then((next) => {
        if (!disposed) {
          setHasWaitingAiSession(aiSessionWaitingStatusFromPayload(next));
          const nextIds = aiSessionWaitingTerminalTabIdsFromPayload(next);
          setWaitingTerminalTabIds((current) => (sameIds(current, nextIds) ? current : nextIds));
        }
      }).catch(console.error);
    }).catch(console.error);
    return () => {
      disposed = true;
      unlisten?.();
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

  function startTabDrag(event, sourceId) {
    if (event.button !== 0 || event.target.closest(".workspace-tab-close")) return;
    const pointerId = event.pointerId;
    const dragHandle = event.currentTarget;
    const originSnapshot = snapshot;
    const startX = event.clientX;
    const startY = event.clientY;
    let currentSnapshot = snapshot;
    let currentDrop = null;
    let started = false;
    try {
      dragHandle.setPointerCapture(pointerId);
    } catch {
      // Window-level listeners still provide a fallback when capture is unavailable.
    }

    function dropAt(pointerEvent) {
      const container = tabBarItemsRef.current;
      if (!container) return null;
      const target = Array.from(container.querySelectorAll("[data-terminal-tab-id]")).find((element) => {
        const bounds = element.getBoundingClientRect();
        return pointerEvent.clientX >= bounds.left
          && pointerEvent.clientX <= bounds.right
          && pointerEvent.clientY >= bounds.top
          && pointerEvent.clientY <= bounds.bottom;
      });
      if (!target) return null;
      const ids = terminalTabs(currentSnapshot).map((tab) => tab.id);
      const sourceIndex = ids.indexOf(sourceId);
      const targetIndex = ids.indexOf(target.dataset.terminalTabId);
      const placement = terminalTabDropPlacement(
        target.getBoundingClientRect(),
        pointerEvent.clientX,
        pointerEvent.clientY,
        sourceIndex,
        targetIndex,
      );
      return { targetId: target.dataset.terminalTabId, placement };
    }

    function preview(drop) {
      if (!drop?.placement) {
        setTabDrag({ sourceId });
        return;
      }
      const tabIds = reorderTerminalIds(
        currentSnapshot.tabs,
        sourceId,
        drop.targetId,
        drop.placement,
      );
      currentSnapshot = withTerminalTabOrder(currentSnapshot, tabIds);
      setSnapshot(currentSnapshot);
      setTabDrag({ sourceId, ...drop });
    }

    function move(pointerEvent) {
      if (!started && Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < 5) return;
      started = true;
      pointerEvent.preventDefault();
      currentDrop = dropAt(pointerEvent);
      preview(currentDrop);
    }

    function suppressActivation() {
      suppressActivationRef.current = true;
      setTimeout(() => {
        suppressActivationRef.current = false;
      }, 0);
    }

    function cleanup() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", keydown, true);
      try {
        if (dragHandle.hasPointerCapture(pointerId)) dragHandle.releasePointerCapture(pointerId);
      } catch {
        // Pointer capture may already have been released by the browser.
      }
      setTabDrag(null);
    }

    async function persist(tabIds) {
      try {
        setSnapshot(await workspaceTabsApi.reorder(tabIds));
      } catch (error) {
        console.error(error);
        try {
          setSnapshot(await workspaceTabsApi.list());
        } catch (reloadError) {
          console.error(reloadError);
          setSnapshot(originSnapshot);
        }
      }
    }

    function finish(pointerEvent) {
      if (started) {
        currentDrop = dropAt(pointerEvent);
        suppressActivation();
      }
      cleanup();
      if (!started) return;
      if (!currentDrop) {
        setSnapshot(originSnapshot);
        return;
      }
      persist(terminalTabs(currentSnapshot).map((tab) => tab.id));
    }

    function cancel() {
      if (started) suppressActivation();
      cleanup();
      if (started) setSnapshot(originSnapshot);
    }

    function keydown(keyEvent) {
      if (!started || keyEvent.key !== "Escape") return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      cancel();
    }

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", keydown, true);
  }

  return (
    <main className="tab-bar" role="tablist" aria-label="Workspace tabs">
      <div ref={tabBarItemsRef} className="tab-bar-items">
        {snapshot.tabs.map((tab) => {
          const active = tab.id === snapshot.activeTabId;
          const waitingForAiSession = tab.kind === "main"
            ? hasWaitingAiSession
            : waitingTerminalTabIds.includes(tab.id);
          const shortcutNumber = workspaceNumberForTab(snapshot, tab.id);
          return (
            <div
              key={tab.id}
              className={`workspace-tab ${tab.kind === "main" ? "workspace-tab-main" : ""} ${active ? "workspace-tab-active" : ""} ${tab.running === false && tab.kind === "terminal" ? "workspace-tab-exited" : ""} ${tabDrag?.sourceId === tab.id ? "workspace-tab-dragging" : ""} ${tabDrag?.targetId === tab.id ? `workspace-tab-drop-${tabDrag.placement}` : ""}`}
              data-terminal-tab-id={tab.kind === "terminal" ? tab.id : undefined}
              onPointerDown={(event) => tab.kind === "terminal" && startTabDrag(event, tab.id)}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className="workspace-tab-select"
                onClick={(event) => {
                  if (suppressActivationRef.current) {
                    event.preventDefault();
                    event.stopPropagation();
                    suppressActivationRef.current = false;
                    return;
                  }
                  activate(tab.id);
                }}
                title={waitingForAiSession
                  ? `${tab.title} — AI session waiting for you`
                  : tab.title}
              >
                {waitingForAiSession && (
                  <span
                    className="workspace-tab-waiting-dot"
                    aria-label="AI session waiting for you"
                    role="img"
                  />
                )}
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
          title={`New terminal (${newTerminalShortcut})`}
          aria-label={`New terminal (${newTerminalShortcut})`}
          onClick={() => window.dispatchEvent(new Event("workspace-create-terminal"))}
        >
          <span className="workspace-tab-add-symbol" aria-hidden="true">+</span>
          <span className="workspace-tab-shortcut" aria-hidden="true">{newTerminalShortcut}</span>
        </button>
      </div>
      {persistenceWarning && (
        <div
          className="terminal-persistence-warning"
          role="status"
          aria-live="polite"
          title={persistenceWarning}
        >
          <span aria-hidden="true">⚠</span>
          <span>Terminal changes not saved</span>
        </div>
      )}
    </main>
  );
}
