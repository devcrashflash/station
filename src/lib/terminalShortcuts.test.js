import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TERMINAL_SHORTCUTS,
  matchesTerminalShortcut,
  normalizeTerminalShortcuts,
  terminalShortcutConflict,
  terminalZoomDelta,
} from "./terminalShortcuts.js";

function event(overrides = {}) {
  return { type: "keydown", code: "KeyD", key: "d", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...overrides };
}

test("matches shortcuts with exact platform modifiers", () => {
  assert.equal(matchesTerminalShortcut(event({ metaKey: true }), "CommandOrControl+KeyD", "MacIntel"), true);
  assert.equal(matchesTerminalShortcut(event({ ctrlKey: true }), "CommandOrControl+KeyD", "Win32"), true);
  assert.equal(matchesTerminalShortcut(event({ metaKey: true, shiftKey: true }), "CommandOrControl+KeyD", "MacIntel"), false);
  assert.equal(matchesTerminalShortcut(event({ metaKey: true, code: "KeyF" }), "CommandOrControl+KeyD", "MacIntel"), false);
});

test("normalizes missing and malformed terminal shortcuts independently", () => {
  assert.deepEqual(normalizeTerminalShortcuts({ search: "Alt+KeyS", clear: "KeyK" }), {
    ...DEFAULT_TERMINAL_SHORTCUTS,
    search: "Alt+KeyS",
  });
});

test("rejects duplicate and reserved terminal shortcuts", () => {
  assert.deepEqual(terminalShortcutConflict({
    ...DEFAULT_TERMINAL_SHORTCUTS,
    search: "Super+KeyD",
  }, "MacIntel"), {
    action: "search",
    otherAction: "splitColumns",
    reserved: false,
    invalid: false,
  });
  assert.deepEqual(terminalShortcutConflict({
    ...DEFAULT_TERMINAL_SHORTCUTS,
    search: "CommandOrControl+KeyT",
  }, "Win32"), {
    action: "search",
    reserved: true,
    invalid: false,
  });
  assert.deepEqual(terminalShortcutConflict({
    ...DEFAULT_TERMINAL_SHORTCUTS,
    search: "KeyF",
  }, "Win32"), {
    action: "search",
    reserved: false,
    invalid: true,
  });
});

test("preserves historical default zoom aliases and replaces them for custom bindings", () => {
  assert.equal(terminalZoomDelta(event({ code: "Equal", key: "+", metaKey: true, shiftKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "MacIntel"), 1);
  assert.equal(terminalZoomDelta(event({ code: "NumpadAdd", key: "+", ctrlKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "Win32"), 1);
  assert.equal(terminalZoomDelta(event({ code: "NumpadSubtract", key: "-", ctrlKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "Win32"), -1);
  assert.equal(terminalZoomDelta(event({ code: "Equal", key: "+", metaKey: true, shiftKey: true }), {
    ...DEFAULT_TERMINAL_SHORTCUTS,
    zoomIn: "Alt+KeyI",
  }, "MacIntel"), null);
});
