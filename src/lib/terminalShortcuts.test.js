import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TERMINAL_SHORTCUTS,
  matchesTerminalShortcut,
  normalizeTerminalShortcuts,
  shortcutsMatch,
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

test("compares equivalent shortcuts after resolving the platform primary modifier", () => {
  assert.equal(shortcutsMatch("CommandOrControl+KeyI", "Super+KeyI", "MacIntel"), true);
  assert.equal(shortcutsMatch("CommandOrControl+KeyI", "Control+KeyI", "Win32"), true);
  assert.equal(shortcutsMatch("CommandOrControl+KeyI", "Control+KeyI", "Linux x86_64"), true);
  assert.equal(shortcutsMatch("CommandOrControl+KeyI", "Control+KeyI", "MacIntel"), false);
  assert.equal(shortcutsMatch("", "Control+KeyI", "Win32"), false);
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

test("matches default zoom aliases by character across keyboard layouts", () => {
  assert.equal(terminalZoomDelta(event({ code: "Equal", key: "+", metaKey: true, shiftKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "MacIntel"), 1);
  assert.equal(terminalZoomDelta(event({ code: "BracketRight", key: "+", metaKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "MacIntel"), 1);
  assert.equal(terminalZoomDelta(event({ code: "Slash", key: "-", metaKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "MacIntel"), -1);
  assert.equal(terminalZoomDelta(event({ code: "BracketRight", key: "+", ctrlKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "Win32"), 1);
  assert.equal(terminalZoomDelta(event({ code: "Slash", key: "-", ctrlKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "Win32"), -1);
  assert.equal(terminalZoomDelta(event({ code: "BracketRight", key: "+", ctrlKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "Linux x86_64"), 1);
  assert.equal(terminalZoomDelta(event({ code: "Slash", key: "-", ctrlKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "Linux x86_64"), -1);
  assert.equal(terminalZoomDelta(event({ code: "NumpadAdd", key: "+", ctrlKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "Win32"), 1);
  assert.equal(terminalZoomDelta(event({ code: "NumpadSubtract", key: "-", ctrlKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "Win32"), -1);
});

test("requires exact default zoom modifiers", () => {
  assert.equal(terminalZoomDelta(event({ code: "BracketRight", key: "+", metaKey: true, ctrlKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "MacIntel"), null);
  assert.equal(terminalZoomDelta(event({ code: "BracketRight", key: "+", metaKey: true, altKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "MacIntel"), null);
  assert.equal(terminalZoomDelta(event({ code: "Slash", key: "-", ctrlKey: true, altKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "Win32"), null);
  assert.equal(terminalZoomDelta(event({ code: "Slash", key: "-", ctrlKey: true, shiftKey: true }), DEFAULT_TERMINAL_SHORTCUTS, "Linux x86_64"), null);
});

test("uses layout-independent aliases only for unchanged default zoom bindings", () => {
  assert.equal(terminalZoomDelta(event({ code: "BracketRight", key: "+", metaKey: true }), {
    ...DEFAULT_TERMINAL_SHORTCUTS,
    zoomIn: "Alt+KeyI",
  }, "MacIntel"), null);
  assert.equal(terminalZoomDelta(event({ code: "Slash", key: "-", ctrlKey: true }), {
    ...DEFAULT_TERMINAL_SHORTCUTS,
    zoomOut: "Alt+KeyO",
  }, "Win32"), null);
  assert.equal(terminalZoomDelta(event({ code: "Slash", key: "-", metaKey: true }), {
    ...DEFAULT_TERMINAL_SHORTCUTS,
    zoomIn: "Alt+KeyI",
  }, "MacIntel"), -1);
  assert.equal(terminalZoomDelta(event({ code: "BracketRight", key: "+", ctrlKey: true }), {
    ...DEFAULT_TERMINAL_SHORTCUTS,
    zoomOut: "Alt+KeyO",
  }, "Linux x86_64"), 1);
});
