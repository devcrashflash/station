import { formatLocalDate } from "./activity.js";

export const CALENDAR_AUTO_SYNC_STALE_MS = 5 * 60 * 1000;

export function sortCalendarEvents(events = []) {
  return [...events].sort((left, right) => (
    Number(Boolean(right.allDay)) - Number(Boolean(left.allDay))
    || (left.startAt || 0) - (right.startAt || 0)
    || String(left.id || "").localeCompare(String(right.id || ""))
  ));
}

export function latestCalendarSyncAt(syncRuns = []) {
  return Math.max(0, ...syncRuns.map((run) => run.syncedAt || 0));
}

export function shouldAutoSyncCalendar(date, syncRuns = [], now = Date.now(), today = formatLocalDate()) {
  const latest = latestCalendarSyncAt(syncRuns);
  if (!latest) return true;
  return date === today && now - latest > CALENDAR_AUTO_SYNC_STALE_MS;
}

export function calendarWarningMessages(syncRuns = []) {
  return syncRuns
    .filter((run) => run.status === "failed" && run.warning)
    .map((run) => `${run.accountName} · ${run.calendarName}: ${run.warning}`);
}

export function calendarEventTimeLabel(event) {
  if (event.allDay) return "All day";
  const start = new Date(event.startAt);
  const end = new Date(event.endAt);
  const formatter = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${formatter.format(start)}–${formatter.format(end)}`;
}

export function calendarEventOpenUrl(event) {
  return event.joinUrl || event.eventUrl || null;
}
