import {
  activityActionLabel,
  activityEventKindLabel,
  activityProviderLabel,
} from "./activity.js";
import { calendarEventTimeLabel } from "./calendar.js";

export function filterTimelineItemsBySearch(items = [], query = "") {
  const normalizedQuery = String(query).trim().toLocaleLowerCase();
  if (!normalizedQuery) return items;

  return items.filter((item) => timelineItemSearchValues(item).some(
    (value) => String(value || "").toLocaleLowerCase().includes(normalizedQuery),
  ));
}

function timelineItemSearchValues(item) {
  if (item?.type === "calendar") {
    const event = item.value || {};
    return [
      "Calendar",
      calendarEventTimeLabel(event),
      event.title,
      event.calendarName,
      event.attendeeStatus,
      event.location,
    ];
  }

  const activity = item?.value || {};
  const occurred = activity.occurredAt ? new Date(activity.occurredAt) : null;
  return [
    occurred?.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    activityProviderLabel(activity.provider),
    activityActionLabel(activity),
    activityEventKindLabel(activity),
    activity.actor,
    activity.title || activity.externalId,
    activity.connectionName || activity.connectionId,
  ];
}
