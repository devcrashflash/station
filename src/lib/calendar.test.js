import test from "node:test";
import assert from "node:assert/strict";

import { calendarEventTimeLabel, shouldAutoSyncCalendar, sortCalendarEvents } from "./calendar.js";

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
