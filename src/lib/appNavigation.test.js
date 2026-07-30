import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_SESSIONS_DESTINATION,
  PROJECT_SWITCHER_DESTINATION,
  SMART_INBOX_DESTINATION,
  appNavigationDestination,
  appNavigationReturnTabId,
  preserveProjectSwitcherReturnTabId,
} from "./appNavigation.js";

test("accepts only the supported app navigation destination", () => {
  assert.equal(
    appNavigationDestination({ destination: AI_SESSIONS_DESTINATION }),
    AI_SESSIONS_DESTINATION,
  );
  assert.equal(
    appNavigationDestination({ destination: SMART_INBOX_DESTINATION }),
    SMART_INBOX_DESTINATION,
  );
  assert.equal(
    appNavigationDestination({ destination: PROJECT_SWITCHER_DESTINATION }),
    PROJECT_SWITCHER_DESTINATION,
  );
  assert.equal(appNavigationDestination({ destination: "unknown" }), null);
  assert.equal(appNavigationDestination(null), null);
});

test("validates optional project switcher return tab ids", () => {
  assert.equal(appNavigationReturnTabId({ returnTabId: "terminal-2" }), "terminal-2");
  assert.equal(appNavigationReturnTabId({ returnTabId: " terminal-2 " }), "terminal-2");
  assert.equal(appNavigationReturnTabId({ returnTabId: "" }), null);
  assert.equal(appNavigationReturnTabId({ returnTabId: 2 }), null);
  assert.equal(appNavigationReturnTabId(null), null);
});

test("preserves the original return tab while the switcher remains open", () => {
  assert.equal(preserveProjectSwitcherReturnTabId(null, "terminal-2", false), "terminal-2");
  assert.equal(preserveProjectSwitcherReturnTabId("terminal-2", null, true), "terminal-2");
  assert.equal(preserveProjectSwitcherReturnTabId("terminal-2", "terminal-3", true), "terminal-2");
  assert.equal(preserveProjectSwitcherReturnTabId("terminal-2", null, false), null);
});
