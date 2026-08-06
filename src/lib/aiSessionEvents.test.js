import assert from "node:assert/strict";
import test from "node:test";

import {
  aiSessionPayloadIncludesSessions,
  aiSessionWaitingTerminalTabIdsFromPayload,
  aiSessionWaitingStatusFromPayload,
  newerAiSessionSnapshot,
  normalizeAiSessionSnapshot,
} from "./aiSessionEvents.js";

test("distinguishes full snapshots from compact monitor status", () => {
  assert.equal(aiSessionPayloadIncludesSessions({ sessions: [] }), true);
  assert.equal(aiSessionPayloadIncludesSessions({ waitingSessionCount: 2 }), false);
  assert.equal(aiSessionPayloadIncludesSessions(null), false);
});

test("derives waiting status from native snapshots", () => {
  assert.equal(aiSessionWaitingStatusFromPayload({ waitingSessionCount: 2 }), true);
  assert.equal(aiSessionWaitingStatusFromPayload({ waitingSessionCount: 0 }), false);
  assert.equal(aiSessionWaitingStatusFromPayload({
    sessions: [{ waitingForInput: false, children: [{ waitingForInput: true }] }],
  }), true);
  assert.equal(aiSessionWaitingStatusFromPayload(null), false);
});

test("normalizes waiting terminal tab ids independently from global waiting status", () => {
  assert.deepEqual(aiSessionWaitingTerminalTabIdsFromPayload({
    waitingSessionCount: 0,
    waitingTerminalTabIds: ["terminal-2", "terminal-1", "terminal-2", "", null],
  }), ["terminal-2", "terminal-1"]);
  assert.deepEqual(aiSessionWaitingTerminalTabIdsFromPayload({
    waitingSessionCount: 2,
    waitingTerminalTabIds: "terminal-1",
  }), []);
  assert.equal(aiSessionWaitingStatusFromPayload({
    waitingSessionCount: 1,
    waitingTerminalTabIds: [],
  }), true);
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
    waitingTerminalTabIds: [],
  });
});

test("rejects stale AI session monitor events", () => {
  const current = { lastRefreshedAt: 200, sessions: [{ id: "new" }] };
  const stale = { lastRefreshedAt: 100, sessions: [{ id: "old" }] };
  const equallyNew = { lastRefreshedAt: 200, sessions: [{ id: "event" }] };
  assert.equal(newerAiSessionSnapshot(current, stale), current);
  assert.equal(newerAiSessionSnapshot(current, equallyNew), equallyNew);
});
