import test from "node:test";
import assert from "node:assert/strict";

import {
  activityLocation,
  agentsLocation,
  appHistoryShortcutDirection,
  createNavigationHistory,
  inboxLocation,
  moveNavigationHistory,
  projectLocation,
  pushNavigationHistory,
  replaceNavigationHistory,
  taskLocation,
  unavailableTaskFallback,
} from "./appHistory.js";

function event(overrides = {}) {
  return {
    type: "keydown",
    key: "ArrowLeft",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    isComposing: false,
    target: null,
    ...overrides,
  };
}

test("pushes destinations, suppresses duplicates, and clears forward history", () => {
  let history = createNavigationHistory();
  history = pushNavigationHistory(history, projectLocation("project-1"));
  history = pushNavigationHistory(history, taskLocation({ id: "task-1", projectId: "project-1" }));
  assert.equal(history.entries.length, 3);

  history = pushNavigationHistory(history, taskLocation({ id: "task-1", projectId: "project-2" }));
  assert.equal(history.entries.length, 3);
  assert.equal(history.entries[2].projectId, "project-2");

  history = moveNavigationHistory(history, "back").history;
  history = pushNavigationHistory(history, agentsLocation());
  assert.deepEqual(history.entries, [
    inboxLocation(),
    projectLocation("project-1"),
    agentsLocation(),
  ]);
});

test("moves backward and forward without moving past either edge", () => {
  let history = createNavigationHistory();
  history = pushNavigationHistory(history, projectLocation("project-1"));
  history = pushNavigationHistory(history, activityLocation("2026-07-29"));

  let movement = moveNavigationHistory(history, "back");
  assert.deepEqual(movement.location, projectLocation("project-1"));
  movement = moveNavigationHistory(movement.history, "back");
  assert.deepEqual(movement.location, inboxLocation());
  movement = moveNavigationHistory(movement.history, "back");
  assert.equal(movement.location, null);
  movement = moveNavigationHistory(movement.history, "forward");
  assert.deepEqual(movement.location, projectLocation("project-1"));
  movement = moveNavigationHistory(movement.history, "forward");
  assert.deepEqual(movement.location, activityLocation("2026-07-29"));
});

test("replaces the current destination and bounds retained entries", () => {
  let history = createNavigationHistory();
  history = pushNavigationHistory(history, projectLocation("project-1"));
  history = replaceNavigationHistory(history, agentsLocation());
  assert.deepEqual(history.entries, [inboxLocation(), agentsLocation()]);

  for (let index = 0; index < 105; index += 1) {
    history = pushNavigationHistory(history, projectLocation(`project-${index}`));
  }
  assert.equal(history.entries.length, 100);
  assert.equal(history.entries[0].projectId, "project-5");
  assert.equal(history.entries.at(-1).projectId, "project-104");
});

test("matches exact platform back and forward shortcuts", () => {
  assert.equal(appHistoryShortcutDirection(event({ metaKey: true }), "MacIntel", false), "back");
  assert.equal(appHistoryShortcutDirection(
    event({ key: "ArrowRight", metaKey: true }),
    "MacIntel",
    false,
  ), "forward");
  assert.equal(appHistoryShortcutDirection(event({ ctrlKey: true }), "Win32", false), "back");
  assert.equal(appHistoryShortcutDirection(
    event({ key: "ArrowRight", ctrlKey: true }),
    "Linux x86_64",
    false,
  ), "forward");
});

test("ignores invalid shortcuts, dialogs, and editable targets", () => {
  const editableTarget = { closest: () => ({}) };
  assert.equal(appHistoryShortcutDirection(event({ metaKey: true, shiftKey: true }), "MacIntel", false), null);
  assert.equal(appHistoryShortcutDirection(event({ metaKey: true, ctrlKey: true }), "MacIntel", false), null);
  assert.equal(appHistoryShortcutDirection(event({ metaKey: true, repeat: true }), "MacIntel", false), null);
  assert.equal(appHistoryShortcutDirection(event({ metaKey: true, defaultPrevented: true }), "MacIntel", false), null);
  assert.equal(appHistoryShortcutDirection(event({ metaKey: true }), "MacIntel", true), null);
  assert.equal(appHistoryShortcutDirection(
    event({ metaKey: true, target: editableTarget }),
    "MacIntel",
    false,
  ), null);
});

test("falls back from an unavailable task to its project or the inbox", () => {
  const location = taskLocation({ id: "task-1", projectId: "project-1" });
  assert.deepEqual(
    unavailableTaskFallback(location, [{ id: "project-1" }]),
    projectLocation("project-1"),
  );
  assert.deepEqual(unavailableTaskFallback(location, []), inboxLocation());
  assert.deepEqual(
    unavailableTaskFallback(taskLocation({ id: "task-2", projectId: null }), []),
    inboxLocation(),
  );
});
