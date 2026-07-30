import test from "node:test";
import assert from "node:assert/strict";

import { timelineItemsToCsv } from "./activity.js";
import { calendarEventTimeLabel } from "./calendar.js";
import { filterTimelineItemsBySearch } from "./activitySearch.js";

const activityItem = {
  type: "activity",
  value: {
    id: "activity-one",
    provider: "github",
    actionLabel: "Merged",
    eventType: "PullRequestEvent",
    actor: "Ada Lovelace",
    title: "Ship the search",
    connectionName: "Acme GitHub",
    occurredAt: new Date(2026, 6, 30, 9, 24).getTime(),
  },
};
const calendarItem = {
  type: "calendar",
  value: {
    id: "meeting-one",
    title: "Product planning",
    calendarName: "Team Calendar",
    attendeeStatus: "accepted",
    location: "Vienna room",
    startAt: new Date(2026, 6, 30, 11, 0).getTime(),
    endAt: new Date(2026, 6, 30, 11, 30).getTime(),
  },
};
const items = [activityItem, calendarItem];

test("timeline search returns every item for blank and whitespace queries", () => {
  assert.equal(filterTimelineItemsBySearch(items, ""), items);
  assert.equal(filterTimelineItemsBySearch(items, "   "), items);
});

test("timeline search matches visible activity values case-insensitively", () => {
  for (const query of ["gitHUB", "MERG", "pull request", "ada love", "the SEARCH", "acme git"]) {
    assert.deepEqual(filterTimelineItemsBySearch(items, query), [activityItem]);
  }
});

test("timeline search matches visible calendar values and time text", () => {
  const timeQuery = calendarEventTimeLabel(calendarItem.value).slice(0, 3);
  for (const query of ["CALENDAR", "product PLAN", "team cal", "ACCEPT", "vienna", timeQuery]) {
    assert.deepEqual(filterTimelineItemsBySearch(items, query), [calendarItem]);
  }
});

test("timeline search preserves source ordering and returns no unmatched items", () => {
  const matching = [
    { ...activityItem, value: { ...activityItem.value, id: "first", title: "Common first" } },
    { ...calendarItem, value: { ...calendarItem.value, id: "second", title: "Common second" } },
  ];

  assert.deepEqual(
    filterTimelineItemsBySearch(matching, "common").map((item) => item.value.id),
    ["first", "second"],
  );
  assert.deepEqual(filterTimelineItemsBySearch(items, "not present"), []);
});

test("timeline CSV can be generated from only the searched items", () => {
  const csv = timelineItemsToCsv(filterTimelineItemsBySearch(items, "ship the search"));

  assert.match(csv, /Ship the search/);
  assert.doesNotMatch(csv, /Product planning/);
});
