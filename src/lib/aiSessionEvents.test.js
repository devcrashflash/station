import assert from "node:assert/strict";
import test from "node:test";

import {
  aiSessionRevisionFromPayload,
  aiSessionWaitingTerminalTabIdsFromPayload,
  aiSessionWaitingStatusFromPayload,
  newerAiSessionSnapshot,
  normalizeAiSessionSnapshot,
} from "./aiSessionEvents.js";

test("reads revisions from full snapshots and compact monitor status", () => {
  assert.equal(aiSessionRevisionFromPayload({ revision: "abc" }), "abc");
  assert.equal(aiSessionRevisionFromPayload({ revision: 123 }), "");
  assert.equal(aiSessionRevisionFromPayload(null), "");
});

test("derives waiting status from native snapshots", () => {
  assert.equal(aiSessionWaitingStatusFromPayload({ waitingSessionCount: 2 }), true);
  assert.equal(aiSessionWaitingStatusFromPayload({ waitingSessionCount: 0 }), false);
  assert.equal(aiSessionWaitingStatusFromPayload({ sessions: [{ state: "waiting" }] }), false);
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
    revision: "revision-1",
    sessions: [{ state: "waiting", children: [] }],
    archivedSessions: "invalid",
    warnings: null,
  }, 123), {
    sessions: [{ state: "waiting", children: [] }],
    archivedSessions: [],
    warnings: [],
    revision: "revision-1",
    loadedAt: 123,
    lastRefreshedAt: 123,
    waitingSessionCount: 0,
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
