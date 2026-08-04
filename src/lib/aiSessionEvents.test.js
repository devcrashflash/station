import assert from "node:assert/strict";
import test from "node:test";

import {
  aiSessionWaitingStatusFromPayload,
  newerAiSessionSnapshot,
  normalizeAiSessionSnapshot,
} from "./aiSessionEvents.js";

test("derives waiting status from native snapshots", () => {
  assert.equal(aiSessionWaitingStatusFromPayload({ waitingSessionCount: 2 }), true);
  assert.equal(aiSessionWaitingStatusFromPayload({ waitingSessionCount: 0 }), false);
  assert.equal(aiSessionWaitingStatusFromPayload({
    sessions: [{ waitingForInput: false, children: [{ waitingForInput: true }] }],
  }), true);
  assert.equal(aiSessionWaitingStatusFromPayload(null), false);
});

test("normalizes native and browser AI session snapshots", () => {
  assert.deepEqual(normalizeAiSessionSnapshot({
    sessions: [{ waitingForInput: true, children: [] }],
    archivedSessions: "invalid",
    warnings: null,
  }, 123), {
    sessions: [{ waitingForInput: true, children: [] }],
    archivedSessions: [],
    warnings: [],
    loadedAt: 123,
    lastRefreshedAt: 123,
    waitingSessionCount: 1,
  });
});

test("rejects stale AI session monitor events", () => {
  const current = { lastRefreshedAt: 200, sessions: [{ id: "new" }] };
  const stale = { lastRefreshedAt: 100, sessions: [{ id: "old" }] };
  const equallyNew = { lastRefreshedAt: 200, sessions: [{ id: "event" }] };
  assert.equal(newerAiSessionSnapshot(current, stale), current);
  assert.equal(newerAiSessionSnapshot(current, equallyNew), equallyNew);
});
