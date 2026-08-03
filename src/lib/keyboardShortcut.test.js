import assert from "node:assert/strict";
import test from "node:test";

import {
  formatShortcut,
  isPrimarySearchShortcut,
  shortcutFromKeyboardEvent,
  shortcutPreviewFromKeyboardEvent,
} from "./keyboardShortcut.js";

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

test("builds live shortcut previews from pressed modifiers and keys", () => {
  assert.equal(shortcutPreviewFromKeyboardEvent(keyEvent({
    key: "Control",
    code: "ControlLeft",
    ctrlKey: true,
  })), "Control");
  assert.equal(shortcutPreviewFromKeyboardEvent(keyEvent({
    key: "Alt",
    code: "AltLeft",
    altKey: true,
  })), "Alt");
  assert.equal(shortcutPreviewFromKeyboardEvent(keyEvent({
    key: "Shift",
    code: "ShiftLeft",
    shiftKey: true,
  })), "Shift");
  assert.equal(shortcutPreviewFromKeyboardEvent(keyEvent({
    key: "Meta",
    code: "MetaLeft",
    metaKey: true,
  })), "Super");
  assert.equal(shortcutPreviewFromKeyboardEvent(keyEvent({
    ctrlKey: true,
    altKey: true,
    shiftKey: true,
    metaKey: true,
  })), "Control+Alt+Shift+Super+KeyK");
});

test("removes the released key from an incomplete shortcut preview", () => {
  assert.equal(shortcutPreviewFromKeyboardEvent(keyEvent({
    key: "Control",
    code: "ControlLeft",
  }), { includeKey: false }), "");
  assert.equal(shortcutPreviewFromKeyboardEvent(keyEvent({
    key: "Shift",
    code: "ShiftLeft",
    ctrlKey: true,
  }), { includeKey: false }), "Control");
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
  assert.equal(formatShortcut("CommandOrControl+KeyT", "MacIntel"), "⌘T");
  assert.equal(formatShortcut("CommandOrControl+KeyT", "Win32"), "Ctrl+T");
  assert.equal(formatShortcut("CommandOrControl+KeyT", "Linux x86_64"), "Ctrl+T");
});

const commandF = {
  type: "keydown",
  key: "f",
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

test("matches the platform-primary search shortcut", () => {
  assert.equal(isPrimarySearchShortcut(commandF, "MacIntel"), true);
  assert.equal(isPrimarySearchShortcut({ ...commandF, metaKey: false, ctrlKey: true }, "Win32"), true);
  assert.equal(isPrimarySearchShortcut({ ...commandF, metaKey: false, ctrlKey: true }, "Linux x86_64"), true);
});

test("rejects search shortcuts with missing or extra modifiers", () => {
  assert.equal(isPrimarySearchShortcut({ ...commandF, metaKey: false }, "MacIntel"), false);
  assert.equal(isPrimarySearchShortcut({ ...commandF, metaKey: false, ctrlKey: true }, "MacIntel"), false);
  assert.equal(isPrimarySearchShortcut({ ...commandF, ctrlKey: true }, "MacIntel"), false);
  assert.equal(isPrimarySearchShortcut({ ...commandF, altKey: true }, "MacIntel"), false);
  assert.equal(isPrimarySearchShortcut({ ...commandF, shiftKey: true }, "MacIntel"), false);
  assert.equal(isPrimarySearchShortcut({ ...commandF, key: "g" }, "MacIntel"), false);
  assert.equal(isPrimarySearchShortcut({ ...commandF, type: "keyup" }, "MacIntel"), false);
});
