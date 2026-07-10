import test from "node:test";
import assert from "node:assert/strict";

import {
  activityActionLabel,
  activityEventKindLabel,
  addDays,
  formatLocalDate,
  isTrelloAutomationActivity,
  isPastLocalDate,
  localDayBounds,
  shouldAutoSyncActivity,
  sortActivities,
  syncWarningMessages,
} from "./activity.js";
import { api } from "./api.js";

test("formats local dates for native date inputs", () => {
  assert.equal(formatLocalDate(new Date(2026, 6, 9, 13, 5)), "2026-07-09");
  assert.equal(addDays("2026-07-09", -1), "2026-07-08");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("calculates local day bounds as one full day", () => {
  const bounds = localDayBounds("2026-07-09");

  assert.equal(bounds.endAt - bounds.startAt, 24 * 60 * 60 * 1000);
  assert.equal(formatLocalDate(new Date(bounds.startAt)), "2026-07-09");
});

test("detects past local dates from yyyy-mm-dd values", () => {
  assert.equal(isPastLocalDate("2026-07-09", "2026-07-10"), true);
  assert.equal(isPastLocalDate("2026-07-10", "2026-07-10"), false);
  assert.equal(isPastLocalDate("2026-07-11", "2026-07-10"), false);
});

test("only auto-syncs today when cached sync is stale", () => {
  const now = Date.UTC(2026, 6, 10, 12, 0, 0);

  assert.equal(shouldAutoSyncActivity("2026-07-09", [], now, "2026-07-10"), false);
  assert.equal(shouldAutoSyncActivity("2026-07-11", [], now, "2026-07-10"), false);
  assert.equal(shouldAutoSyncActivity("2026-07-10", [], now, "2026-07-10"), true);
  assert.equal(
    shouldAutoSyncActivity("2026-07-10", [{ syncedAt: now - 4 * 60 * 1000 }], now, "2026-07-10"),
    false,
  );
  assert.equal(
    shouldAutoSyncActivity("2026-07-10", [{ syncedAt: now - 6 * 60 * 1000 }], now, "2026-07-10"),
    true,
  );
});

test("sorts activities oldest first", () => {
  const sorted = sortActivities([
    { id: "old", occurredAt: 10 },
    { id: "new", occurredAt: 30 },
    { id: "middle", occurredAt: 20 },
  ]);

  assert.deepEqual(sorted.map((activity) => activity.id), ["old", "middle", "new"]);
});

test("detects trello automation activities from app metadata", () => {
  assert.equal(
    isTrelloAutomationActivity({
      provider: "trello",
      rawJson: JSON.stringify({
        appCreator: { id: "butler", name: "Automation" },
        memberCreator: { username: "alex" },
      }),
    }),
    true,
  );
  assert.equal(
    isTrelloAutomationActivity({
      provider: "trello",
      rawJson: JSON.stringify({
        memberCreator: { username: "alex" },
      }),
    }),
    false,
  );
  assert.equal(
    isTrelloAutomationActivity({
      provider: "github",
      rawJson: JSON.stringify({
        appCreator: { id: "app_1" },
      }),
    }),
    false,
  );
  assert.equal(
    isTrelloAutomationActivity({
      provider: "gitlab",
      rawJson: JSON.stringify({
        appCreator: { id: "app_1" },
      }),
    }),
    false,
  );
  assert.equal(isTrelloAutomationActivity({ provider: "trello", rawJson: "{bad json" }), false);
  assert.equal(isTrelloAutomationActivity({ provider: "trello" }), false);
});

test("formats provider sync warnings", () => {
  assert.deepEqual(
    syncWarningMessages([
      {
        provider: "github",
        connectionName: "GitHub",
        status: "failed",
        warning: "Bad credentials.",
      },
      {
        provider: "gitlab",
        connectionName: "GitLab",
        status: "success",
      },
    ]),
    ["GitHub GitHub: Bad credentials."],
  );
});

test("derives compact activity badge labels", () => {
  assert.equal(
    activityActionLabel({ actionLabel: "Update Card", eventType: "updateCard" }),
    "Changed",
  );
  assert.equal(
    activityActionLabel({ actionLabel: "Moved: In Progress", eventType: "updateCard" }),
    "Moved: In Progress",
  );
  assert.equal(
    activityActionLabel({ actionLabel: "commented on", eventType: "Note" }),
    "Commented",
  );
  assert.equal(
    activityActionLabel({ actionLabel: "Deleted", eventType: "deleteAttachmentFromCard" }),
    "Changed",
  );
  assert.equal(
    activityActionLabel({ actionLabel: "Attached", eventType: "addAttachmentToCard" }),
    "Changed",
  );
  assert.equal(activityEventKindLabel({ eventType: "PullRequestEvent" }), "Pull Request");
  assert.equal(activityEventKindLabel({ eventType: "updateCard" }), "Card");
});

test("local fallback reads cached activities for a selected day", async () => {
  const bounds = localDayBounds("2026-07-09");
  global.localStorage = {
    getItem: () =>
      JSON.stringify({
        activities: [
          {
            id: "activity_1",
            provider: "github",
            connectionId: "connection_1",
            connectionName: "GitHub",
            externalId: "1",
            eventType: "IssueCommentEvent",
            actionLabel: "Created",
            actor: "alex",
            title: "Fix auth",
            targetUrl: "https://github.com/acme/app/issues/1",
            occurredAt: bounds.startAt + 1000,
            fetchedAt: bounds.startAt + 2000,
            rawJson: "{}",
          },
          {
            id: "activity_2",
            provider: "gitlab",
            connectionId: "connection_2",
            externalId: "2",
            occurredAt: bounds.endAt + 1000,
          },
        ],
        activitySyncRuns: [
          {
            connectionId: "connection_1",
            connectionName: "GitHub",
            provider: "github",
            date: "2026-07-09",
            status: "success",
            syncedAt: bounds.startAt + 3000,
          },
        ],
      }),
    setItem: () => {},
  };

  const result = await api.listActivities({ date: "2026-07-09" });

  assert.deepEqual(result.activities.map((activity) => activity.id), ["activity_1"]);
  assert.equal(result.syncRuns.length, 1);
});
