import assert from "node:assert/strict";
import test from "node:test";

import { aiSessionCommand, aiSessionRelativeTime, sortAiSessions } from "./aiSessions.js";

test("builds provider resume commands from validated identifiers", () => {
  assert.equal(aiSessionCommand({ provider: "codex", id: "thread-1" }), "codex resume thread-1\r");
  assert.equal(aiSessionCommand({ provider: "claude", id: "session_1" }), "claude --resume session_1\r");
  assert.throws(() => aiSessionCommand({ provider: "codex", id: "bad; command" }), /Invalid/);
});

test("formats relative session activity", () => {
  const now = 10_000_000;
  assert.equal(aiSessionRelativeTime(now - 30_000, now), "just now");
  assert.equal(aiSessionRelativeTime(now - 2 * 3_600_000, now), "2h ago");
  assert.equal(aiSessionRelativeTime(now - 3 * 86_400_000, now), "3d ago");
});

test("sorts parents using their latest child activity", () => {
  const sessions = sortAiSessions([
    { id: "a", updatedAt: 10, children: [{ updatedAt: 100 }] },
    { id: "b", updatedAt: 50, children: [] },
  ]);
  assert.equal(sessions[0].id, "a");
});
