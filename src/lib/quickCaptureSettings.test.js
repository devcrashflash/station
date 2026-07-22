import assert from "node:assert/strict";
import test from "node:test";

import { quickCaptureStatus } from "./quickCaptureSettings.js";

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
