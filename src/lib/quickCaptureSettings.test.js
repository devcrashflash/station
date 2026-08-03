import assert from "node:assert/strict";
import test from "node:test";

import {
  quickCaptureShortcutConflict,
  quickCaptureStatus,
} from "./quickCaptureSettings.js";

test("reports Quick Capture runtime status", () => {
  assert.deepEqual(quickCaptureStatus({ enabled: false, registered: false }), {
    label: "Disabled",
    variant: "secondary",
  });
  assert.deepEqual(quickCaptureStatus({ enabled: true, registered: true }), {
    label: "Active",
    variant: "secondary",
  });
  assert.deepEqual(quickCaptureStatus({ enabled: true, registered: false }), {
    label: "Unavailable",
    variant: "destructive",
  });
});

test("warns about platform-specific workspace shortcut conflicts", () => {
  assert.deepEqual(
    quickCaptureShortcutConflict("Super+KeyI", {}, "MacIntel"),
    { kind: "workspace", label: "Smart Inbox" },
  );
  assert.deepEqual(
    quickCaptureShortcutConflict("Control+KeyT", {}, "Win32"),
    { kind: "workspace", label: "new terminal" },
  );
  assert.deepEqual(
    quickCaptureShortcutConflict("Control+Digit3", {}, "Linux x86_64"),
    { kind: "workspace", label: "terminal 3 navigation" },
  );
  assert.deepEqual(
    quickCaptureShortcutConflict("Control+KeyI", {}, "MacIntel"),
    { kind: "workspace", label: "Smart Inbox" },
  );
  assert.equal(quickCaptureShortcutConflict("Alt+KeyI", {}, "MacIntel"), null);
});

test("warns about configured terminal shortcuts and allows unused shortcuts", () => {
  const terminalShortcuts = {
    splitColumns: "Alt+KeyS",
  };
  assert.deepEqual(
    quickCaptureShortcutConflict("Alt+KeyS", terminalShortcuts, "Linux x86_64"),
    { kind: "terminal", label: "Split pane right" },
  );
  assert.equal(
    quickCaptureShortcutConflict("Alt+KeyQ", terminalShortcuts, "Linux x86_64"),
    null,
  );
});
