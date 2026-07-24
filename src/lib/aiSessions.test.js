import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_SESSION_DONE_WINDOW_MS,
  aiSessionArchiveActionLabel,
  aiSessionCanArchive,
  aiSessionCommand,
  aiSessionPreferredOpenTarget,
  aiSessionProviderBadgeClass,
  aiSessionProviderFilterEnabled,
  aiSessionPollingIntervalMs,
  aiSessionRelativeTime,
  aiSessionSourceLabel,
  aiSessionState,
  aiSessionSourcesDisabled,
  aiSessionTreeState,
  aiSessionTreeWaitingForInput,
  aiSessionsWaitingForInput,
  aiSessionViewFilters,
  aiSessionViewFiltersDisabled,
  aiSessionWindowCounts,
  archivedAiSessionWindowCounts,
  filterAiSessions,
  filterArchivedAiSessionsByWindow,
  filterAiSessionsByWindow,
  formatAiSessionLastRefreshed,
  normalizeAiSessionBackgroundRefreshInterval,
  normalizeAiSessionForegroundRefreshInterval,
  normalizeAiSessionSettings,
  sortAiSessions,
  sortArchivedAiSessions,
} from "./aiSessions.js";

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

test("prioritizes waiting session trees while preserving activity order", () => {
  const sessions = sortAiSessions([
    { id: "recent", updatedAt: 300, waitingForInput: false, children: [] },
    { id: "waiting-old", updatedAt: 100, waitingForInput: true, children: [] },
    {
      id: "waiting-child",
      updatedAt: 50,
      waitingForInput: false,
      children: [{ updatedAt: 200, waitingForInput: true }],
    },
    { id: "waiting-new", updatedAt: 250, waitingForInput: true, children: [] },
  ]);

  assert.deepEqual(sessions.map(({ id }) => id), [
    "waiting-new",
    "waiting-child",
    "waiting-old",
    "recent",
  ]);
  assert.equal(aiSessionTreeWaitingForInput(sessions[1]), true);
  assert.equal(aiSessionTreeWaitingForInput(sessions[3]), false);
});

test("normalizes source settings and detects an all-disabled configuration", () => {
  assert.deepEqual(normalizeAiSessionSettings({ codexCli: false }), {
    codexCli: false,
    codexDesktop: true,
    claudeCli: true,
    claudeDesktop: true,
    foregroundRefreshIntervalSeconds: 30,
    backgroundRefreshIntervalSeconds: 60,
  });
  assert.equal(aiSessionSourcesDisabled({
    codexCli: false,
    codexDesktop: false,
    claudeCli: false,
    claudeDesktop: false,
  }), true);
});

test("labels detected session sources while retaining provider fallback", () => {
  assert.equal(aiSessionSourceLabel({ provider: "codex", origin: "desktop" }), "Codex Desktop");
  assert.equal(aiSessionSourceLabel({ provider: "claude", origin: "cli" }), "Claude CLI");
  assert.equal(aiSessionSourceLabel({ provider: "codex", origin: "unknown" }), "Codex");
});

test("prefers the session origin when choosing a resume target", () => {
  assert.equal(aiSessionPreferredOpenTarget({
    origin: "cli",
    openTargets: ["desktop", "terminal"],
  }), "terminal");
  assert.equal(aiSessionPreferredOpenTarget({
    origin: "desktop",
    openTargets: ["terminal", "desktop"],
  }), "desktop");
});

test("falls back to the first available resume target", () => {
  assert.equal(aiSessionPreferredOpenTarget({
    origin: "cli",
    openTargets: ["desktop"],
  }), "desktop");
  assert.equal(aiSessionPreferredOpenTarget({
    origin: "desktop",
    openTargets: ["terminal"],
  }), "terminal");
  assert.equal(aiSessionPreferredOpenTarget({
    origin: "unknown",
    openTargets: ["desktop", "terminal"],
  }), "desktop");
  assert.equal(aiSessionPreferredOpenTarget({ origin: "cli", openTargets: [] }), undefined);
});

test("styles source badges with provider identity colors", () => {
  assert.match(aiSessionProviderBadgeClass("codex"), /emerald/);
  assert.match(aiSessionProviderBadgeClass("claude"), /orange/);
  assert.match(aiSessionProviderBadgeClass("unknown"), /muted/);
});

test("derives individual and rolled-up session states with waiting and running precedence", () => {
  const now = 20_000_000;
  const recentCompletion = now - AI_SESSION_DONE_WINDOW_MS;
  const expiredCompletion = recentCompletion - 1;
  assert.equal(aiSessionState({ waitingForInput: true, running: true, completedAt: recentCompletion }, now), "waiting");
  assert.equal(aiSessionState({ waitingForInput: false, running: true, completedAt: recentCompletion }, now), "running");
  assert.equal(aiSessionState({ waitingForInput: false, running: false, completedAt: recentCompletion }, now), "done");
  assert.equal(aiSessionState({ waitingForInput: false, running: false, completedAt: expiredCompletion }, now), "idle");
  assert.equal(aiSessionState({ waitingForInput: false, running: false }, now), "idle");

  assert.equal(aiSessionTreeState({
    waitingForInput: false,
    running: false,
    children: [{ waitingForInput: false, running: true, completedAt: recentCompletion }],
  }, now), "running");
  assert.equal(aiSessionTreeState({
    waitingForInput: false,
    running: true,
    children: [{ waitingForInput: true, running: false, completedAt: recentCompletion }],
  }, now), "waiting");
  assert.equal(aiSessionTreeState({
    waitingForInput: false,
    running: false,
    children: [{ waitingForInput: false, running: false, completedAt: recentCompletion }],
  }, now), "done");
  assert.equal(aiSessionTreeState({
    waitingForInput: false,
    running: false,
    children: [{ waitingForInput: false, running: false }],
  }, now), "idle");
});

test("allows archiving only done or idle session trees", () => {
  const now = 20_000_000;
  assert.equal(aiSessionCanArchive({ running: false, waitingForInput: false, children: [] }, now), true);
  assert.equal(aiSessionCanArchive({
    running: false,
    waitingForInput: false,
    completedAt: now,
    children: [],
  }, now), true);
  assert.equal(aiSessionCanArchive({ running: true, waitingForInput: false, children: [] }, now), false);
  assert.equal(aiSessionCanArchive({
    running: false,
    waitingForInput: false,
    children: [{ running: false, waitingForInput: true }],
  }, now), false);
});

test("labels provider-synced and Station-only archive actions", () => {
  assert.equal(
    aiSessionArchiveActionLabel({ provider: "codex" }),
    "Archive in Codex and Station",
  );
  assert.equal(aiSessionArchiveActionLabel({ provider: "claude" }), "Hide from Station");
  assert.equal(
    aiSessionArchiveActionLabel({ provider: "codex", archiveScope: "provider" }, true),
    "Restore in Codex and Station",
  );
  assert.equal(
    aiSessionArchiveActionLabel({ provider: "codex", archiveScope: "station" }, true),
    "Restore in Station",
  );
});

test("sorts archived sessions by archive time with stable provider and id ties", () => {
  const sessions = sortArchivedAiSessions([
    { provider: "codex", id: "older", archivedAt: 100 },
    { provider: "claude", id: "b", archivedAt: 200 },
    { provider: "claude", id: "a", archivedAt: 200 },
  ]);
  assert.deepEqual(sessions.map(({ id }) => id), ["a", "b", "older"]);
});

test("formats the last successful AI session refresh in local time", () => {
  const value = new Date(2026, 6, 24, 14, 32).getTime();
  const expectedTime = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));

  assert.equal(formatAiSessionLastRefreshed(value), `Last refreshed ${expectedTime}`);
  assert.equal(formatAiSessionLastRefreshed(null), "");
  assert.equal(formatAiSessionLastRefreshed("not-a-date"), "");
});

test("normalizes supported AI session refresh intervals", () => {
  assert.equal(normalizeAiSessionForegroundRefreshInterval(0), 0);
  assert.equal(normalizeAiSessionForegroundRefreshInterval(5), 5);
  assert.equal(normalizeAiSessionForegroundRefreshInterval("60"), 60);
  assert.equal(normalizeAiSessionForegroundRefreshInterval(999), 30);
  assert.equal(normalizeAiSessionBackgroundRefreshInterval(0), 60);
  assert.equal(normalizeAiSessionBackgroundRefreshInterval("15"), 15);
  assert.equal(aiSessionPollingIntervalMs({
    foregroundRefreshIntervalSeconds: 15,
    backgroundRefreshIntervalSeconds: 60,
  }, true), 15_000);
  assert.equal(aiSessionPollingIntervalMs({
    foregroundRefreshIntervalSeconds: 0,
    backgroundRefreshIntervalSeconds: 60,
  }, true), 60_000);
  assert.equal(aiSessionPollingIntervalMs({
    foregroundRefreshIntervalSeconds: 15,
    backgroundRefreshIntervalSeconds: 60,
  }, false), 60_000);
});

test("migrates legacy refresh settings and detects waiting child sessions", () => {
  assert.deepEqual(normalizeAiSessionSettings({
    codexCli: false,
    refreshIntervalSeconds: 5,
  }), {
    codexCli: false,
    codexDesktop: true,
    claudeCli: true,
    claudeDesktop: true,
    foregroundRefreshIntervalSeconds: 5,
    backgroundRefreshIntervalSeconds: 60,
  });
  assert.equal(aiSessionsWaitingForInput([
    { waitingForInput: false, children: [{ waitingForInput: true }] },
  ]), true);
  assert.equal(aiSessionsWaitingForInput([
    { waitingForInput: false, children: [{ waitingForInput: false }] },
  ]), false);
});

test("filters session trees by temporary source selections", () => {
  const filters = {
    codexCli: true,
    codexDesktop: false,
    claudeCli: false,
    claudeDesktop: true,
  };
  const sessions = filterAiSessions([
    { id: "codex-cli", provider: "codex", origin: "cli", children: [] },
    { id: "codex-desktop", provider: "codex", origin: "desktop", children: [] },
    { id: "claude-desktop", provider: "claude", origin: "desktop", children: [] },
    { id: "claude-unknown", provider: "claude", origin: "unknown", children: [] },
  ], filters);

  assert.deepEqual(sessions.map(({ id }) => id), [
    "codex-cli",
    "claude-desktop",
    "claude-unknown",
  ]);
  assert.equal(aiSessionProviderFilterEnabled("codex", filters), true);
  assert.equal(aiSessionProviderFilterEnabled("claude", filters), true);
  assert.equal(aiSessionViewFiltersDisabled(filters), false);
});

test("initializes temporary filters from globally enabled sources", () => {
  assert.deepEqual(aiSessionViewFilters({
    codexCli: false,
    codexDesktop: true,
    claudeCli: false,
    claudeDesktop: true,
  }), {
    codexCli: false,
    codexDesktop: true,
    claudeCli: false,
    claudeDesktop: true,
  });
  assert.equal(aiSessionViewFiltersDisabled({
    codexCli: false,
    codexDesktop: false,
    claudeCli: false,
    claudeDesktop: false,
  }), true);
});

test("filters grouped sessions by time while preserving recent parent and child activity", () => {
  const now = 40 * 86_400_000;
  const sessions = [
    {
      id: "recent-parent",
      updatedAt: now - 24 * 3_600_000,
      children: [
        { id: "boundary-child", updatedAt: now - 24 * 3_600_000 },
        { id: "old-child", updatedAt: now - 25 * 3_600_000 },
      ],
    },
    {
      id: "old-parent-recent-child",
      updatedAt: now - 10 * 86_400_000,
      children: [{ id: "recent-child", updatedAt: now - 2 * 3_600_000 }],
    },
    {
      id: "old-tree",
      updatedAt: now - 10 * 86_400_000,
      children: [{ id: "old-child", updatedAt: now - 8 * 86_400_000 }],
    },
  ];

  const filtered = filterAiSessionsByWindow(sessions, 24, now);
  assert.deepEqual(filtered.map(({ id }) => id), [
    "recent-parent",
    "old-parent-recent-child",
  ]);
  assert.deepEqual(filtered[0].children.map(({ id }) => id), ["boundary-child"]);
  assert.deepEqual(filtered[1].children.map(({ id }) => id), ["recent-child"]);
});

test("counts top-level session trees per window after temporary source filtering", () => {
  const day = 86_400_000;
  const now = 40 * day;
  const sessions = [
    { id: "codex-cli-day", provider: "codex", origin: "cli", updatedAt: now - day, children: [] },
    { id: "codex-desktop-week", provider: "codex", origin: "desktop", updatedAt: now - 5 * day, children: [] },
    { id: "claude-desktop-month", provider: "claude", origin: "desktop", updatedAt: now - 20 * day, children: [] },
    {
      id: "claude-old-parent",
      provider: "claude",
      origin: "unknown",
      updatedAt: now - 35 * day,
      children: [
        { id: "claude-cli-child", provider: "claude", origin: "cli", updatedAt: now - 2 * day },
      ],
    },
  ];
  const allFilters = {
    codexCli: true,
    codexDesktop: true,
    claudeCli: true,
    claudeDesktop: true,
  };
  const cliFilters = {
    codexCli: true,
    codexDesktop: false,
    claudeCli: false,
    claudeDesktop: false,
  };

  assert.deepEqual(aiSessionWindowCounts(sessions, allFilters, now), {
    24: 1,
    168: 3,
    720: 4,
  });
  assert.deepEqual(aiSessionWindowCounts(sessions, cliFilters, now), {
    24: 1,
    168: 1,
    720: 1,
  });
  assert.deepEqual(aiSessionWindowCounts(sessions, {
    codexCli: false,
    codexDesktop: false,
    claudeCli: false,
    claudeDesktop: false,
  }, now), {
    24: 0,
    168: 0,
    720: 0,
  });
});

test("filters and counts archived sessions by their archive time", () => {
  const day = 86_400_000;
  const now = 40 * day;
  const sessions = [
    {
      id: "today",
      provider: "codex",
      origin: "cli",
      archivedAt: now - day,
      updatedAt: now - 20 * day,
    },
    {
      id: "this-week",
      provider: "claude",
      origin: "desktop",
      archivedAt: now - 5 * day,
      updatedAt: now,
    },
    {
      id: "this-month",
      provider: "codex",
      origin: "desktop",
      archivedAt: now - 20 * day,
      updatedAt: now,
    },
    {
      id: "older",
      provider: "claude",
      origin: "cli",
      archivedAt: now - 31 * day,
      updatedAt: now,
    },
  ];
  const filters = {
    codexCli: true,
    codexDesktop: true,
    claudeCli: true,
    claudeDesktop: true,
  };

  assert.deepEqual(
    filterArchivedAiSessionsByWindow(sessions, 24, now).map(({ id }) => id),
    ["today"],
  );
  assert.deepEqual(archivedAiSessionWindowCounts(sessions, filters, now), {
    24: 1,
    168: 2,
    720: 3,
  });
});
