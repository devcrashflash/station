import test from "node:test";
import assert from "node:assert/strict";

import {
  clampSplitRatio,
  copyableTerminalSelection,
  flattenPaneLayout,
  isTerminalClearShortcut,
  isTerminalSearchShortcut,
  paneDropPosition,
  paneIds,
  parseOsc7Cwd,
  terminalPaneDropTarget,
} from "./terminalPanes.js";

test("returns only enabled non-empty terminal selections for copying", () => {
  assert.equal(copyableTerminalSelection(false, "selected"), null);
  assert.equal(copyableTerminalSelection(true, ""), null);
  assert.equal(copyableTerminalSelection(true, null), null);
  assert.equal(copyableTerminalSelection(true, "search result", true), null);
  assert.equal(copyableTerminalSelection(true, "first line\nGrüße 👋"), "first line\nGrüße 👋");
});

test("clamps persisted and dragged split ratios", () => {
  assert.equal(clampSplitRatio(0.5), 0.5);
  assert.equal(clampSplitRatio(-1), 0.1);
  assert.equal(clampSplitRatio(2), 0.9);
  assert.equal(clampSplitRatio(Number.NaN), 0.5);
});

test("recognizes only unmodified macOS Command+K keydown events", () => {
  const commandK = {
    type: "keydown",
    key: "k",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  };

  assert.equal(isTerminalClearShortcut(commandK, "MacIntel"), true);
  assert.equal(isTerminalClearShortcut({ ...commandK, key: "K" }, "MacIntel"), true);
  assert.equal(isTerminalClearShortcut({ ...commandK, type: "keyup" }, "MacIntel"), false);
  assert.equal(isTerminalClearShortcut({ ...commandK, metaKey: false, ctrlKey: true }, "MacIntel"), false);
  assert.equal(isTerminalClearShortcut({ ...commandK, altKey: true }, "MacIntel"), false);
  assert.equal(isTerminalClearShortcut({ ...commandK, shiftKey: true }, "MacIntel"), false);
  assert.equal(isTerminalClearShortcut({ ...commandK, key: "l" }, "MacIntel"), false);
  assert.equal(isTerminalClearShortcut(commandK, "Win32"), false);
});

test("recognizes the platform-primary terminal search shortcut", () => {
  const commandF = {
    type: "keydown",
    key: "f",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
  };

  assert.equal(isTerminalSearchShortcut(commandF, "MacIntel"), true);
  assert.equal(isTerminalSearchShortcut({ ...commandF, key: "F" }, "MacIntel"), true);
  assert.equal(isTerminalSearchShortcut({ ...commandF, metaKey: false, ctrlKey: true }, "MacIntel"), false);
  assert.equal(isTerminalSearchShortcut({ ...commandF, altKey: true }, "MacIntel"), false);
  assert.equal(isTerminalSearchShortcut({ ...commandF, shiftKey: true }, "MacIntel"), false);
  assert.equal(isTerminalSearchShortcut({ ...commandF, type: "keyup" }, "MacIntel"), false);
  assert.equal(isTerminalSearchShortcut({ ...commandF, metaKey: false, ctrlKey: true }, "Win32"), true);
  assert.equal(isTerminalSearchShortcut({ ...commandF, metaKey: false, ctrlKey: true }, "Linux x86_64"), true);
  assert.equal(isTerminalSearchShortcut(commandF, "Win32"), false);
});

test("walks nested pane layouts in visible order", () => {
  const root = {
    type: "split",
    first: { type: "pane", paneId: "one" },
    second: {
      type: "split",
      first: { type: "pane", paneId: "two" },
      second: { type: "pane", paneId: "three" },
    },
  };
  assert.deepEqual(paneIds(root), ["one", "two", "three"]);
  assert.deepEqual(paneIds(null), []);
  const flattened = flattenPaneLayout({
    ...root,
    splitId: "outer",
    axis: "columns",
    ratio: 0.5,
    second: { ...root.second, splitId: "inner", axis: "rows", ratio: 0.25 },
  });
  assert.deepEqual(flattened.panes.map(({ pane }) => pane.paneId), ["one", "two", "three"]);
  assert.deepEqual(flattened.panes.map(({ left, top, width, height }) => [left, top, width, height]), [
    [0, 0, 0.5, 1],
    [0.5, 0, 0.5, 0.25],
    [0.5, 0.25, 0.5, 0.75],
  ]);
});

test("chooses a pane drop position from the nearest normalized edge", () => {
  const bounds = { left: 100, top: 50, width: 400, height: 200 };
  assert.equal(paneDropPosition(bounds, 110, 150), "left");
  assert.equal(paneDropPosition(bounds, 490, 150), "right");
  assert.equal(paneDropPosition(bounds, 300, 55), "top");
  assert.equal(paneDropPosition(bounds, 300, 245), "bottom");
  assert.equal(paneDropPosition(bounds, 99, 150), null);
  assert.equal(paneDropPosition({ ...bounds, width: 0 }, 100, 50), null);
});

test("rejects terminal pane drops onto the source or outside the target", () => {
  const bounds = { left: 0, top: 0, width: 100, height: 100 };
  assert.equal(terminalPaneDropTarget("one", "one", bounds, 5, 50), null);
  assert.equal(terminalPaneDropTarget("one", "two", bounds, 101, 50), null);
  assert.deepEqual(terminalPaneDropTarget("one", "two", bounds, 5, 50), {
    targetPaneId: "two",
    position: "left",
  });
});

test("parses OSC 7 file URLs without accepting other URL forms", () => {
  assert.deepEqual(parseOsc7Cwd("file://localhost/Users/alex/My%20Project", "MacIntel"), {
    host: "",
    path: "/Users/alex/My Project",
  });
  assert.deepEqual(parseOsc7Cwd("file:///C:/Users/Alex", "Win32"), {
    host: "",
    path: "C:/Users/Alex",
  });
  assert.equal(parseOsc7Cwd("https://example.com/tmp", "MacIntel"), null);
  assert.equal(parseOsc7Cwd("not a url", "MacIntel"), null);
  assert.equal(parseOsc7Cwd("file:///tmp?query=1", "MacIntel"), null);
});
