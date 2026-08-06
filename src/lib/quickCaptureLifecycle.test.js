import assert from "node:assert/strict";
import test from "node:test";

import {
  QUICK_CAPTURE_DEFAULT_TAB,
  resetQuickCaptureTab,
} from "./quickCaptureLifecycle.js";

for (const previousTab of ["agents", "programs"]) {
  test(`resets ${previousTab} to the inbox before the blur handler returns`, () => {
    const draft = "Keep this quick-capture draft";
    let state = { activeTab: previousTab, draft };
    let resetReturned = false;

    resetQuickCaptureTab((activeTab) => {
      assert.equal(resetReturned, false);
      state = { ...state, activeTab };
    });
    resetReturned = true;

    assert.deepEqual(state, {
      activeTab: QUICK_CAPTURE_DEFAULT_TAB,
      draft,
    });
  });
}
