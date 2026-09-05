import test from "node:test";
import assert from "node:assert/strict";

import {
  TERMINAL_WORD_SEPARATORS,
  adjacentTerminalPaneId,
  clampSplitRatio,
  copyableTerminalSelection,
  flattenPaneLayout,
  isTerminalClearShortcut,
  isTerminalSearchShortcut,
  nextTerminalFontZoomOffset,
  paneHasHorizontalSplitBelow,
  paneDropPosition,
  paneIds,
  parseOsc7Cwd,
  terminalFontSizeWithZoom,
  terminalFontZoomDelta,
  terminalPaneDropTarget,
} from "./terminalPanes.js";

test("separates prompt metadata without splitting branch names and paths", () => {
  assert.equal(TERMINAL_WORD_SEPARATORS.includes("|"), true);
  assert.equal(TERMINAL_WORD_SEPARATORS.includes("/"), false);
});

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

test("recognizes platform-primary terminal font zoom shortcuts", () => {
  const commandPlus = {
    type: "keydown",
    key: "+",
    code: "Equal",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
  };

  assert.equal(terminalFontZoomDelta(commandPlus, "MacIntel"), 1);
  assert.equal(terminalFontZoomDelta({ ...commandPlus, key: "=", shiftKey: false }, "MacIntel"), 1);
  assert.equal(terminalFontZoomDelta({ ...commandPlus, key: "-", code: "Minus", shiftKey: false }, "MacIntel"), -1);
  assert.equal(terminalFontZoomDelta({ ...commandPlus, key: "+", code: "NumpadAdd", shiftKey: false }, "MacIntel"), 1);
  assert.equal(terminalFontZoomDelta({ ...commandPlus, key: "-", code: "NumpadSubtract", shiftKey: false }, "MacIntel"), -1);

  const controlPlus = { ...commandPlus, metaKey: false, ctrlKey: true };
  assert.equal(terminalFontZoomDelta(controlPlus, "Win32"), 1);
  assert.equal(terminalFontZoomDelta(controlPlus, "Linux x86_64"), 1);
  assert.equal(terminalFontZoomDelta({ ...controlPlus, key: "-", code: "Minus", shiftKey: false }, "Win32"), -1);
});

test("rejects non-primary and modified terminal font zoom events", () => {
  const commandPlus = {
    type: "keydown",
    key: "+",
    code: "Equal",
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: true,
  };

  assert.equal(terminalFontZoomDelta({ ...commandPlus, type: "keyup" }, "MacIntel"), null);
  assert.equal(terminalFontZoomDelta({ ...commandPlus, metaKey: false }, "MacIntel"), null);
  assert.equal(terminalFontZoomDelta({ ...commandPlus, ctrlKey: true }, "MacIntel"), null);
  assert.equal(terminalFontZoomDelta({ ...commandPlus, altKey: true }, "MacIntel"), null);
  assert.equal(terminalFontZoomDelta({ ...commandPlus, key: "-", code: "Minus" }, "MacIntel"), null);
  assert.equal(terminalFontZoomDelta({ ...commandPlus, code: "NumpadAdd" }, "MacIntel"), null);
  assert.equal(terminalFontZoomDelta({ ...commandPlus, key: "0", code: "Digit0", shiftKey: false }, "MacIntel"), null);
  assert.equal(terminalFontZoomDelta(commandPlus, "Win32"), null);
});

test("applies and clamps temporary terminal font zoom", () => {
  assert.equal(terminalFontSizeWithZoom(13, 1), 14);
  assert.equal(terminalFontSizeWithZoom(13, -1), 12);
  assert.equal(terminalFontSizeWithZoom(13, 0), 13);
  assert.equal(terminalFontSizeWithZoom(31, 5), 32);
  assert.equal(terminalFontSizeWithZoom(9, -20), 1);
  assert.equal(nextTerminalFontZoomOffset(13, 1 - 13, -1), 0);
  assert.equal(nextTerminalFontZoomOffset(13, 0, -1), -1);
  assert.equal(nextTerminalFontZoomOffset(13, -1, 1), 0);
  assert.equal(nextTerminalFontZoomOffset(31, 1, 1), 1);
  assert.equal(nextTerminalFontZoomOffset(31, 1, -1), 0);
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
  assert.deepEqual(
    flattened.panes.map((pane) => paneHasHorizontalSplitBelow(pane, flattened.splits)),
    [false, true, false],
  );
});

test("moves focus spatially through a nested pane grid", () => {
  const root = {
    type: "split",
    splitId: "columns",
    axis: "columns",
    ratio: 0.5,
    first: {
      type: "split",
      splitId: "left-rows",
      axis: "rows",
      ratio: 0.5,
      first: { type: "pane", paneId: "top-left" },
      second: { type: "pane", paneId: "bottom-left", running: false },
    },
    second: {
      type: "split",
      splitId: "right-rows",
      axis: "rows",
      ratio: 0.25,
      first: { type: "pane", paneId: "top-right" },
      second: { type: "pane", paneId: "bottom-right" },
    },
  };

  assert.equal(adjacentTerminalPaneId(root, "top-left", "right"), "top-right");
  assert.equal(adjacentTerminalPaneId(root, "top-left", "down"), "bottom-left");
  assert.equal(adjacentTerminalPaneId(root, "bottom-right", "left"), "bottom-left");
  assert.equal(adjacentTerminalPaneId(root, "bottom-right", "up"), "top-right");
});

test("wraps pane focus to the opposite aligned edge", () => {
  const root = {
    type: "split",
    splitId: "columns",
    axis: "columns",
    ratio: 0.5,
    first: {
      type: "split",
      splitId: "left-rows",
      axis: "rows",
      ratio: 0.5,
      first: { type: "pane", paneId: "top-left" },
      second: { type: "pane", paneId: "bottom-left" },
    },
    second: {
      type: "split",
      splitId: "right-rows",
      axis: "rows",
      ratio: 0.5,
      first: { type: "pane", paneId: "top-right" },
      second: { type: "pane", paneId: "bottom-right" },
    },
  };

  assert.equal(adjacentTerminalPaneId(root, "top-left", "left"), "top-right");
  assert.equal(adjacentTerminalPaneId(root, "bottom-right", "right"), "bottom-left");
  assert.equal(adjacentTerminalPaneId(root, "top-right", "up"), "bottom-right");
  assert.equal(adjacentTerminalPaneId(root, "bottom-left", "down"), "top-left");
});

test("uses deterministic spatial fallbacks and rejects invalid layouts", () => {
  const root = {
    type: "split",
    splitId: "columns",
    axis: "columns",
    ratio: 0.5,
    first: { type: "pane", paneId: "left" },
    second: {
      type: "split",
      splitId: "rows",
      axis: "rows",
      ratio: 0.5,
      first: { type: "pane", paneId: "top-right" },
      second: { type: "pane", paneId: "bottom-right" },
    },
  };

  assert.equal(adjacentTerminalPaneId(root, "left", "right"), "top-right");
  assert.equal(adjacentTerminalPaneId(root, "left", "right", { rows: 0.25 }), "bottom-right");
  assert.equal(adjacentTerminalPaneId({ type: "pane", paneId: "only" }, "only", "left"), null);
  assert.equal(adjacentTerminalPaneId(root, "missing", "left"), null);
  assert.equal(adjacentTerminalPaneId(root, "left", "diagonal"), null);
});

test("detects only panes directly above horizontal split boundaries", () => {
  const flattened = flattenPaneLayout({
    type: "split",
    splitId: "rows",
    axis: "rows",
    ratio: 0.5,
    first: {
      type: "split",
      splitId: "columns",
      axis: "columns",
      ratio: 0.4,
      first: { type: "pane", paneId: "top-left" },
      second: { type: "pane", paneId: "top-right" },
    },
    second: { type: "pane", paneId: "bottom" },
  });

  assert.deepEqual(
    flattened.panes.map(({ pane, ...bounds }) => [
      pane.paneId,
      paneHasHorizontalSplitBelow(bounds, flattened.splits),
    ]),
    [
      ["top-left", true],
      ["top-right", true],
      ["bottom", false],
    ],
  );
  assert.equal(paneHasHorizontalSplitBelow(flattened.panes[0], []), false);
  assert.equal(paneHasHorizontalSplitBelow(null, flattened.splits), false);
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
