import test from "node:test";
import assert from "node:assert/strict";

import {
  GOOGLE_AUTHORIZATION_EXPIRED_WARNING,
  calendarEventTimeLabel,
  calendarWarningMessages,
  calendarWarnings,
  shouldAutoSyncCalendar,
  sortCalendarEvents,
} from "./calendar.js";

test("calendar events sort all-day first and timed events chronologically", () => {
  const events = sortCalendarEvents([
    { id: "late", startAt: 30, allDay: false },
    { id: "all-day", startAt: 20, allDay: true },
    { id: "early", startAt: 10, allDay: false },
  ]);
  assert.deepEqual(events.map(({ id }) => id), ["all-day", "early", "late"]);
});

test("calendar auto-syncs uncached days and stale today only", () => {
  const now = new Date(2026, 6, 15, 12).getTime();
  assert.equal(shouldAutoSyncCalendar("2026-07-14", [], now, "2026-07-15"), true);
  assert.equal(shouldAutoSyncCalendar("2026-07-14", [{ syncedAt: now - 1 }], now, "2026-07-15"), false);
  assert.equal(shouldAutoSyncCalendar("2026-07-15", [{ syncedAt: now - 6 * 60 * 1000 }], now, "2026-07-15"), true);
});

test("formats all-day events compactly", () => {
  assert.equal(calendarEventTimeLabel({ allDay: true }), "All day");
});

test("calendar warnings preserve account metadata and classify expired Google authorization", () => {
  const warnings = calendarWarnings([
    {
      accountId: "google-account",
      collectionId: "google-calendar",
      accountName: "alexander@sulu.io",
      calendarName: "alexander@sulu.io",
      status: "failed",
      warning: GOOGLE_AUTHORIZATION_EXPIRED_WARNING,
    },
    {
      accountId: "other-account",
      collectionId: "other-calendar",
      accountName: "Work",
      calendarName: "Team",
      status: "failed",
      warning: "Could not load calendar events.",
    },
    {
      accountId: "healthy-account",
      accountName: "Healthy",
      calendarName: "Healthy",
      status: "success",
      warning: null,
    },
  ]);

  assert.deepEqual(warnings, [
    {
      accountId: "google-account",
      collectionId: "google-calendar",
      message: "alexander@sulu.io · alexander@sulu.io: Google authorization expired or was revoked. Reconnect the account.",
      reconnectable: true,
    },
    {
      accountId: "other-account",
      collectionId: "other-calendar",
      message: "Work · Team: Could not load calendar events.",
      reconnectable: false,
    },
  ]);
  assert.deepEqual(calendarWarningMessages([{
    accountId: "google-account",
    collectionId: "google-calendar",
    accountName: "alexander@sulu.io",
    calendarName: "alexander@sulu.io",
    status: "failed",
    warning: GOOGLE_AUTHORIZATION_EXPIRED_WARNING,
  }]), [
    "alexander@sulu.io · alexander@sulu.io: Google authorization expired or was revoked. Reconnect the account.",
  ]);
});
