import test from "node:test";
import assert from "node:assert/strict";

import {
  activityActionLabel,
  activityEventKindLabel,
  activityOpenUrl,
  addDays,
  formatActivityLastSyncText,
  formatLocalDate,
  isTrelloAutomationActivity,
  isTrelloDelimiterActivity,
  isTrelloListMoveActivity,
  isTrelloPositionOnlyActivity,
  isPastLocalDate,
  localDayBounds,
  shouldAutoSyncActivity,
  sortActivities,
  syncWarningMessages,
  timelineItemsToCsv,
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

test("formats last activity sync time with the day for non-today syncs", () => {
  const now = new Date(2026, 6, 13, 12, 30);
  const todaySync = new Date(2026, 6, 13, 9, 5);
  const olderSync = new Date(2026, 6, 12, 9, 5);

  assert.equal(
    formatActivityLastSyncText(todaySync.getTime(), now),
    `Last sync ${new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(todaySync)}`,
  );
  assert.equal(
    formatActivityLastSyncText(olderSync.getTime(), now),
    `Last sync ${new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(olderSync)}`,
  );
  assert.equal(formatActivityLastSyncText(null, now), "Last sync: never");
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

test("normalizes cached GitHub review submissions independently from review comments", () => {
  assert.equal(activityActionLabel({ eventType: "PullRequestReviewEvent", actionLabel: "Created" }), "Reviewed");
  assert.equal(activityActionLabel({ eventType: "PullRequestReviewCommentEvent", actionLabel: "Created" }), "Commented");
});

test("sorts activities oldest first", () => {
  const sorted = sortActivities([
    { id: "old", occurredAt: 10 },
    { id: "new", occurredAt: 30 },
    { id: "middle", occurredAt: 20 },
  ]);

  assert.deepEqual(sorted.map((activity) => activity.id), ["old", "middle", "new"]);
});

test("uses canonical GitHub and GitLab review request URLs for activities", () => {
  assert.equal(
    activityOpenUrl({
      provider: "github",
      targetUrl: "https://github.com/acme/app/pull/42#issuecomment-1",
      subjectJson: JSON.stringify({ html_url: "https://github.com/acme/app/pull/42" }),
    }),
    "https://github.com/acme/app/pull/42",
  );
  assert.equal(
    activityOpenUrl({
      provider: "gitlab",
      targetUrl: "https://gitlab.example.com/acme/app/-/merge_requests/7#note_1",
      subjectJson: JSON.stringify({ web_url: "https://gitlab.example.com/acme/app/-/merge_requests/7" }),
    }),
    "https://gitlab.example.com/acme/app/-/merge_requests/7",
  );
  assert.equal(
    activityOpenUrl({ provider: "trello", targetUrl: "https://trello.com/c/abc123" }),
    "https://trello.com/c/abc123",
  );
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

test("detects Trello delimiter cards with at least three ASCII hyphens", () => {
  const trelloCardActivity = (name, overrides = {}) => ({
    provider: "trello",
    title: name,
    targetUrl: "https://trello.com/c/abc123",
    rawJson: JSON.stringify({ data: { card: { name, shortLink: "abc123" } } }),
    ...overrides,
  });

  assert.equal(isTrelloDelimiterActivity(trelloCardActivity("---")), true);
  assert.equal(isTrelloDelimiterActivity(trelloCardActivity("  ----  ")), true);
  assert.equal(isTrelloDelimiterActivity(trelloCardActivity("----------")), true);

  for (const title of ["--", "—", "–––", "--- Notes", "Review PR"]) {
    assert.equal(isTrelloDelimiterActivity(trelloCardActivity(title)), false, title);
  }

  assert.equal(isTrelloDelimiterActivity({
    provider: "trello",
    title: "---",
    targetUrl: "https://trello.com/c/legacy",
    rawJson: "{bad json",
  }), true);
  assert.equal(isTrelloDelimiterActivity({
    provider: "trello",
    title: "---",
    rawJson: JSON.stringify({ data: { board: { name: "---" } } }),
  }), false);
  assert.equal(isTrelloDelimiterActivity({
    provider: "trello",
    title: "---",
    rawJson: JSON.stringify({ data: { list: { name: "---" } } }),
  }), false);
  assert.equal(isTrelloDelimiterActivity({
    provider: "github",
    title: "---",
    targetUrl: "https://trello.com/c/abc123",
  }), false);
});

test("detects Trello position-only card updates without hiding list moves", () => {
  assert.equal(
    isTrelloPositionOnlyActivity({
      provider: "trello",
      eventType: "updateCard",
      rawJson: JSON.stringify({ data: { old: { pos: 12345 }, list: { name: "Waiting" } } }),
    }),
    true,
  );
  assert.equal(
    isTrelloPositionOnlyActivity({
      provider: "trello",
      eventType: "updateCard",
      rawJson: JSON.stringify({
        data: {
          old: { idList: "list-a", pos: 12345 },
          listBefore: { name: "Inbox" },
          listAfter: { name: "Waiting" },
        },
      }),
    }),
    false,
  );
  assert.equal(isTrelloPositionOnlyActivity({ provider: "trello", eventType: "commentCard" }), false);
});

test("identifies normalized Trello list moves", () => {
  assert.equal(isTrelloListMoveActivity({ provider: "trello", actionLabel: "Moved: Done" }), true);
  assert.equal(isTrelloListMoveActivity({ provider: "trello", actionLabel: "Commented" }), false);
  assert.equal(isTrelloListMoveActivity({ provider: "gitlab", actionLabel: "Moved" }), false);
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
    activityActionLabel({ actionLabel: "Created", eventType: "IssueCommentEvent" }),
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
  assert.equal(activityEventKindLabel({ eventType: "MergeRequest" }), "Pull Request");
  assert.equal(activityEventKindLabel({ eventType: "updateCard" }), "Card");
});

test("exports visible timeline items as CSV with external links", () => {
  const csv = timelineItemsToCsv([
    {
      type: "activity",
      value: {
        provider: "github",
        connectionName: "Work GitHub",
        eventType: "PullRequestEvent",
        actionLabel: "Opened",
        actor: "alex",
        title: 'Fix "login", finally',
        targetUrl: "https://github.com/acme/app/pull/42",
        occurredAt: Date.UTC(2026, 6, 17, 8, 30),
      },
    },
    {
      type: "calendar",
      value: {
        calendarName: "Team",
        title: "Standup",
        organizer: "lead@example.com",
        joinUrl: "https://meet.google.com/abc-defg-hij",
        startAt: Date.UTC(2026, 6, 17, 9, 0),
      },
    },
    {
      type: "activity",
      value: {
        provider: "gitlab",
        eventType: "IssueEvent",
        title: "Fix deployment",
        targetUrl: "https://gitlab.com/acme/app/-/issues/7",
      },
    },
    {
      type: "activity",
      value: {
        provider: "trello",
        eventType: "updateCard",
        title: "Ship release",
        targetUrl: "https://trello.com/c/abc123/ship-release",
      },
    },
  ]);

  assert.equal(
    csv,
    '"Timestamp","Provider","Connection","Action","Type","Actor","Title","Link"\r\n' +
      '"2026-07-17T08:30:00.000Z","GitHub","Work GitHub","Created","Pull Request","alex","Fix ""login"", finally","https://github.com/acme/app/pull/42"\r\n' +
      '"2026-07-17T09:00:00.000Z","Calendar","Team","Scheduled","Event","lead@example.com","Standup","https://meet.google.com/abc-defg-hij"\r\n' +
      '"","GitLab","","IssueEvent","Issue","","Fix deployment","https://gitlab.com/acme/app/-/issues/7"\r\n' +
      '"","Trello","","Changed","Card","","Ship release","https://trello.com/c/abc123/ship-release"',
  );
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
