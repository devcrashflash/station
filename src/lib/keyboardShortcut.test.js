import assert from "node:assert/strict";
import test from "node:test";

import { formatShortcut, shortcutFromKeyboardEvent } from "./keyboardShortcut.js";

function keyEvent(overrides = {}) {
  return {
    key: "k",
    code: "KeyK",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

test("records a modified key using Tauri accelerator names", () => {
  assert.deepEqual(shortcutFromKeyboardEvent(keyEvent({
    key: " ",
    code: "Space",
    metaKey: true,
    shiftKey: true,
  })), {
    status: "complete",
    shortcut: "Shift+Super+Space",
  });
});

test("rejects bare keys and ignores modifier-only presses", () => {
  assert.equal(shortcutFromKeyboardEvent(keyEvent()).status, "error");
  assert.deepEqual(shortcutFromKeyboardEvent(keyEvent({
    key: "Shift",
    code: "ShiftLeft",
    shiftKey: true,
  })), { status: "recording" });
});

test("Escape cancels shortcut recording", () => {
  assert.deepEqual(shortcutFromKeyboardEvent(keyEvent({ key: "Escape", code: "Escape" })), {
    status: "cancel",
  });
});

test("formats default and normalized shortcuts for each platform", () => {
  assert.equal(formatShortcut("CommandOrControl+Shift+Space", "MacIntel"), "⌘⇧Space");
  assert.equal(formatShortcut("shift+super+KeyK", "MacIntel"), "⌘⇧K");
  assert.equal(formatShortcut("shift+control+Space", "Win32"), "Ctrl+Shift+Space");
});
