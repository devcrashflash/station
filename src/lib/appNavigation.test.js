import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_SESSIONS_DESTINATION,
  SMART_INBOX_DESTINATION,
  appNavigationDestination,
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
  assert.equal(appNavigationDestination({ destination: "unknown" }), null);
  assert.equal(appNavigationDestination(null), null);
});
