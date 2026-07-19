import test from "node:test";
import assert from "node:assert/strict";

import { clampSplitRatio, flattenPaneLayout, paneIds, parseOsc7Cwd } from "./terminalPanes.js";

test("clamps persisted and dragged split ratios", () => {
  assert.equal(clampSplitRatio(0.5), 0.5);
  assert.equal(clampSplitRatio(-1), 0.1);
  assert.equal(clampSplitRatio(2), 0.9);
  assert.equal(clampSplitRatio(Number.NaN), 0.5);
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
