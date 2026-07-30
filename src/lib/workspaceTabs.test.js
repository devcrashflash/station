import test from "node:test";
import assert from "node:assert/strict";

import {
  activeWorkspaceTab,
  isWorkspaceShortcut,
  reorderTerminalIds,
  terminalTabs,
  workspaceNumberShortcut,
  workspaceNumberForTab,
  workspaceSplitShortcut,
  workspaceTabForNumber,
} from "./workspaceTabs.js";

const tabs = [
  { id: "main", kind: "main" },
  { id: "one", kind: "terminal" },
  { id: "two", kind: "terminal" },
  { id: "three", kind: "terminal" },
];

test("keeps Main outside the reorderable terminal list", () => {
  assert.deepEqual(terminalTabs({ tabs }).map((tab) => tab.id), ["one", "two", "three"]);
  assert.deepEqual(reorderTerminalIds(tabs, "three", "one"), ["three", "one", "two"]);
});

test("returns the unchanged order for invalid drag targets", () => {
  assert.deepEqual(reorderTerminalIds(tabs, "main", "two"), ["one", "two", "three"]);
  assert.deepEqual(reorderTerminalIds(tabs, "one", "main"), ["one", "two", "three"]);
});

test("recognizes workspace command shortcuts", () => {
  assert.equal(isWorkspaceShortcut({ metaKey: true, ctrlKey: false, altKey: false, key: "T" }, "t"), true);
  assert.equal(isWorkspaceShortcut({ metaKey: false, ctrlKey: true, altKey: false, key: "w" }, "w"), true);
  assert.equal(isWorkspaceShortcut({ metaKey: true, ctrlKey: false, altKey: false, key: "B" }, "b"), true);
  assert.equal(isWorkspaceShortcut({ metaKey: false, ctrlKey: true, altKey: false, key: "b" }, "b"), true);
  assert.equal(isWorkspaceShortcut({ metaKey: true, ctrlKey: false, altKey: false, key: "I" }, "i"), true);
  assert.equal(isWorkspaceShortcut({ metaKey: false, ctrlKey: true, altKey: false, key: "i" }, "i"), true);
  assert.equal(isWorkspaceShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: "P" }, "p"), true);
  assert.equal(isWorkspaceShortcut({ metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, key: "p" }, "p"), true);
  assert.equal(isWorkspaceShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: "P" }, "p"), false);
  assert.equal(isWorkspaceShortcut({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, key: "P" }, "p"), false);
  assert.equal(isWorkspaceShortcut({ metaKey: true, ctrlKey: false, altKey: true, key: "t" }, "t"), false);
  assert.equal(isWorkspaceShortcut({ metaKey: true, ctrlKey: false, altKey: true, key: "b" }, "b"), false);
  assert.equal(isWorkspaceShortcut({ metaKey: true, ctrlKey: false, altKey: true, key: "i" }, "i"), false);
  assert.equal(isWorkspaceShortcut({ metaKey: true, ctrlKey: false, altKey: false, key: "k" }, "b"), false);
  assert.equal(isWorkspaceShortcut({ metaKey: true, ctrlKey: false, altKey: false, key: "k" }, "i"), false);
});

test("maps platform split shortcuts to pane axes", () => {
  assert.equal(workspaceSplitShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: "d" }, "MacIntel"), "columns");
  assert.equal(workspaceSplitShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: "D" }, "MacIntel"), "rows");
  assert.equal(workspaceSplitShortcut({ metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, key: "d" }, "Win32"), "columns");
  assert.equal(workspaceSplitShortcut({ metaKey: false, ctrlKey: true, altKey: false, shiftKey: true, key: "d" }, "Linux x86_64"), "rows");
  assert.equal(workspaceSplitShortcut({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "d" }, "MacIntel"), null);
  assert.equal(workspaceSplitShortcut({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, key: "d" }, "MacIntel"), null);
  assert.equal(workspaceSplitShortcut({ metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, key: "x" }, "Win32"), null);
});

test("recognizes unmodified workspace number shortcuts", () => {
  assert.equal(workspaceNumberShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: "0" }), 0);
  assert.equal(workspaceNumberShortcut({ metaKey: false, ctrlKey: true, altKey: false, shiftKey: false, key: "9" }), 9);
  assert.equal(workspaceNumberShortcut({ metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, key: "1" }), null);
  assert.equal(workspaceNumberShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: true, key: "1" }), null);
  assert.equal(workspaceNumberShortcut({ metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: "1" }), null);
  assert.equal(workspaceNumberShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: "t" }), null);
  assert.equal(workspaceNumberShortcut({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, key: "1" }, true), null);
});

test("maps workspace numbers to Main and terminals in visible order", () => {
  assert.equal(workspaceTabForNumber({ tabs }, 0)?.id, "main");
  assert.equal(workspaceTabForNumber({ tabs }, 1)?.id, "one");
  assert.equal(workspaceTabForNumber({ tabs }, 2)?.id, "two");
  assert.equal(workspaceTabForNumber({ tabs }, 3)?.id, "three");
  assert.equal(workspaceTabForNumber({ tabs }, 4), null);
});

test("uses reordered terminal positions for workspace numbers", () => {
  const reorderedTabs = [tabs[0], tabs[3], tabs[1], tabs[2]];
  assert.equal(workspaceTabForNumber({ tabs: reorderedTabs }, 1)?.id, "three");
  assert.equal(workspaceTabForNumber({ tabs: reorderedTabs }, 2)?.id, "one");
  assert.equal(workspaceTabForNumber({ tabs: reorderedTabs }, 10), null);
});

test("shows numbered shortcuts for Main and the first nine terminal positions", () => {
  const reorderedTabs = [tabs[0], tabs[3], tabs[1], tabs[2]];
  assert.equal(workspaceNumberForTab({ tabs: reorderedTabs }, "main"), 0);
  assert.equal(workspaceNumberForTab({ tabs: reorderedTabs }, "three"), 1);
  assert.equal(workspaceNumberForTab({ tabs: reorderedTabs }, "one"), 2);
  assert.equal(workspaceNumberForTab({ tabs: reorderedTabs }, "missing"), null);

  const tenTerminals = Array.from({ length: 10 }, (_, index) => ({ id: `terminal-${index + 1}`, kind: "terminal" }));
  const snapshot = { tabs: [{ id: "main", kind: "main" }, ...tenTerminals] };
  assert.equal(workspaceNumberForTab(snapshot, "terminal-9"), 9);
  assert.equal(workspaceNumberForTab(snapshot, "terminal-10"), null);
});

test("finds the active tab from a snapshot", () => {
  assert.equal(activeWorkspaceTab({ tabs, activeTabId: "two" })?.id, "two");
  assert.equal(activeWorkspaceTab({ tabs, activeTabId: "missing" }), null);
});
