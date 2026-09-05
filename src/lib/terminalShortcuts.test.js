import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_TERMINAL_SHORTCUTS,
  defaultTerminalShortcuts,
  matchesTerminalShortcut,
  normalizeTerminalShortcuts,
  shortcutsMatch,
  terminalShiftEnterSequence,
  terminalShortcutConflict,
  terminalPaneFocusDirection,
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
  assert.equal(matchesTerminalShortcut(event({ metaKey: true, repeat: true }), "CommandOrControl+KeyD", "MacIntel"), false);
});

test("uses native pane focus defaults on each platform", () => {
  assert.deepEqual(
    Object.values(defaultTerminalShortcuts("MacIntel")).slice(-4),
    [
      "Super+Alt+ArrowLeft",
      "Super+Alt+ArrowRight",
      "Super+Alt+ArrowUp",
      "Super+Alt+ArrowDown",
    ],
  );
  assert.deepEqual(
    Object.values(defaultTerminalShortcuts("Win32")).slice(-4),
    ["Alt+ArrowLeft", "Alt+ArrowRight", "Alt+ArrowUp", "Alt+ArrowDown"],
  );
  assert.deepEqual(
    Object.values(defaultTerminalShortcuts("Linux x86_64")).slice(-4),
    ["Alt+ArrowLeft", "Alt+ArrowRight", "Alt+ArrowUp", "Alt+ArrowDown"],
  );
});

test("maps exact pane focus shortcuts and recognizes repeats for consumption", () => {
  const macShortcuts = defaultTerminalShortcuts("MacIntel");
  const windowsShortcuts = defaultTerminalShortcuts("Win32");
  assert.equal(terminalPaneFocusDirection(event({
    code: "ArrowLeft",
    key: "ArrowLeft",
    metaKey: true,
    altKey: true,
  }), macShortcuts, "MacIntel"), "left");
  assert.equal(terminalPaneFocusDirection(event({
    code: "ArrowDown",
    key: "ArrowDown",
    altKey: true,
    repeat: true,
  }), windowsShortcuts, "Win32"), "down");
  assert.equal(terminalPaneFocusDirection(event({
    code: "ArrowRight",
    key: "ArrowRight",
    metaKey: true,
  }), macShortcuts, "MacIntel"), null);
  assert.equal(terminalPaneFocusDirection(event({
    code: "ArrowUp",
    key: "ArrowUp",
    ctrlKey: true,
    altKey: true,
  }), windowsShortcuts, "Win32"), null);
});

test("encodes exact Shift+Enter keydown as a distinct CSI-u event", () => {
  assert.equal(terminalShiftEnterSequence(event({
    code: "Enter",
    key: "Enter",
    shiftKey: true,
  })), "\x1b[13;2u");
  assert.equal(terminalShiftEnterSequence(event({
    code: "NumpadEnter",
    key: "Enter",
    shiftKey: true,
    repeat: true,
  })), "\x1b[13;2u");
});

test("leaves other Enter events and modifier combinations to xterm", () => {
  const shiftEnter = { code: "Enter", key: "Enter", shiftKey: true };
  assert.equal(terminalShiftEnterSequence(event({ code: "Enter", key: "Enter" })), null);
  assert.equal(terminalShiftEnterSequence(event({ ...shiftEnter, ctrlKey: true })), null);
  assert.equal(terminalShiftEnterSequence(event({ ...shiftEnter, altKey: true })), null);
  assert.equal(terminalShiftEnterSequence(event({ ...shiftEnter, metaKey: true })), null);
  assert.equal(terminalShiftEnterSequence(event({ ...shiftEnter, type: "keypress" })), null);
  assert.equal(terminalShiftEnterSequence(event({ ...shiftEnter, type: "keyup" })), null);
  assert.equal(terminalShiftEnterSequence(event({ code: "KeyD", key: "d", shiftKey: true })), null);
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
  assert.deepEqual(normalizeTerminalShortcuts({ search: "Alt+KeyS" }, "MacIntel"), {
    ...defaultTerminalShortcuts("MacIntel"),
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
  assert.deepEqual(terminalShortcutConflict({
    ...defaultTerminalShortcuts("Win32"),
    focusPaneRight: "Alt+ArrowLeft",
  }, "Win32"), {
    action: "focusPaneRight",
    otherAction: "focusPaneLeft",
    reserved: false,
    invalid: false,
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
  assert.equal(terminalZoomDelta(event({ code: "BracketRight", key: "+", metaKey: true, repeat: true }), DEFAULT_TERMINAL_SHORTCUTS, "MacIntel"), null);
  assert.equal(terminalZoomDelta(event({ code: "Slash", key: "-", ctrlKey: true, repeat: true }), DEFAULT_TERMINAL_SHORTCUTS, "Linux x86_64"), null);
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
