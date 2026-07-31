import assert from "node:assert/strict";
import test from "node:test";

import {
  smartOverlayAgentSessions,
  smartOverlayHighlightedId,
  smartOverlayMovedId,
  smartOverlayNumberSession,
  smartOverlaySessionKey,
} from "./smartOverlay.js";

const NOW = Date.parse("2026-07-31T12:00:00Z");
const settings = {
  codexCli: true,
  codexDesktop: false,
  claudeCli: true,
  claudeDesktop: false,
};

function session(id, overrides = {}) {
  return {
    id,
    provider: "codex",
    origin: "cli",
    title: id,
    cwd: `/work/${id}`,
    updatedAt: NOW - 60_000,
    children: [],
    ...overrides,
  };
}

test("filters overlay agents by source, rolling 24 hours, and search", () => {
  const sessions = [
    session("recent", { title: "Recent checkout" }),
    session("old", { updatedAt: NOW - 25 * 3_600_000 }),
    session("desktop", { origin: "desktop" }),
    session("child-match", {
      title: "Parent",
      children: [session("subagent", { title: "Database migration" })],
    }),
  ];

  assert.deepEqual(
    smartOverlayAgentSessions(sessions, settings, "", NOW).map(({ id }) => id),
    ["child-match", "recent"],
  );
  assert.deepEqual(
    smartOverlayAgentSessions(sessions, settings, "migration", NOW).map(({ id }) => id),
    ["child-match"],
  );
});

test("sorts waiting agents before more recently updated agents", () => {
  const sessions = [
    session("recent", { updatedAt: NOW }),
    session("waiting", { updatedAt: NOW - 3_600_000, waitingForInput: true }),
  ];
  assert.deepEqual(
    smartOverlayAgentSessions(sessions, settings, "", NOW).map(({ id }) => id),
    ["waiting", "recent"],
  );
});

test("keeps or repairs the highlighted agent and wraps arrow navigation", () => {
  const sessions = [session("one"), session("two"), session("three")];
  assert.equal(smartOverlayHighlightedId(sessions, "codex:two"), "codex:two");
  assert.equal(smartOverlayHighlightedId(sessions, "missing"), "codex:one");
  assert.equal(smartOverlayMovedId(sessions, "codex:one", -1), "codex:three");
  assert.equal(smartOverlayMovedId(sessions, "codex:three", 1), "codex:one");
  assert.notEqual(
    smartOverlaySessionKey(session("same")),
    smartOverlaySessionKey(session("same", { provider: "claude" })),
  );
});

test("selects the first nine agents by bare number only for an empty query", () => {
  const sessions = Array.from({ length: 10 }, (_, index) => session(`agent-${index + 1}`));
  assert.equal(smartOverlayNumberSession(sessions, "1", "")?.id, "agent-1");
  assert.equal(smartOverlayNumberSession(sessions, "9", "")?.id, "agent-9");
  assert.equal(smartOverlayNumberSession(sessions, "0", ""), null);
  assert.equal(smartOverlayNumberSession(sessions, "1", "agent"), null);
});
