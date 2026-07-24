import assert from "node:assert/strict";
import test from "node:test";

import { aiSessionWaitingStatusFromPayload } from "./aiSessionEvents.js";

test("accepts only explicit waiting status event payloads", () => {
  assert.equal(aiSessionWaitingStatusFromPayload({ waitingForInput: true }), true);
  assert.equal(aiSessionWaitingStatusFromPayload({ waitingForInput: false }), false);
  assert.equal(aiSessionWaitingStatusFromPayload({ waitingForInput: "true" }), false);
  assert.equal(aiSessionWaitingStatusFromPayload(null), false);
});
