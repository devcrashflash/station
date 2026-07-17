export function formatLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseLocalDate(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) {
    return new Date();
  }
  return new Date(year, month - 1, day);
}

export function addDays(dateValue, days) {
  const date = parseLocalDate(dateValue);
  date.setDate(date.getDate() + days);
  return formatLocalDate(date);
}

export function localDayBounds(dateValue) {
  const start = parseLocalDate(dateValue);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    startAt: start.getTime(),
    endAt: end.getTime(),
  };
}

export function isPastLocalDate(dateValue, today = formatLocalDate()) {
  return Boolean(dateValue) && dateValue < today;
}

export const ACTIVITY_AUTO_SYNC_STALE_MS = 5 * 60 * 1000;

export function latestActivitySyncAt(syncRuns = []) {
  return Math.max(0, ...syncRuns.map((run) => run.syncedAt || 0));
}

export function formatActivityLastSyncText(value, now = new Date()) {
  if (!value) return "Last sync: never";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Last sync: never";

  const referenceDate = new Date(now);
  const isToday = formatLocalDate(date) === formatLocalDate(referenceDate);
  const options = isToday
    ? { hour: "2-digit", minute: "2-digit" }
    : {
        weekday: "short",
        month: "short",
        day: "numeric",
        ...(date.getFullYear() === referenceDate.getFullYear() ? {} : { year: "numeric" }),
        hour: "2-digit",
        minute: "2-digit",
      };

  return `Last sync ${new Intl.DateTimeFormat(undefined, options).format(date)}`;
}

export function shouldAutoSyncActivity(dateValue, syncRuns = [], now = Date.now(), today = formatLocalDate()) {
  if (dateValue !== today) return false;
  const latestSyncAt = latestActivitySyncAt(syncRuns);
  return !latestSyncAt || now - latestSyncAt > ACTIVITY_AUTO_SYNC_STALE_MS;
}

export function sortActivities(activities) {
  return [...(activities || [])].sort((left, right) => {
    const occurredDelta = (left.occurredAt || 0) - (right.occurredAt || 0);
    if (occurredDelta !== 0) return occurredDelta;
    return String(left.id || "").localeCompare(String(right.id || ""));
  });
}

export function isTrelloAutomationActivity(activity) {
  if (activity?.provider !== "trello" || !activity?.rawJson) return false;

  try {
    return hasAppCreatorMetadata(JSON.parse(activity.rawJson));
  } catch {
    return false;
  }
}

function hasAppCreatorMetadata(value) {
  if (!value || typeof value !== "object") return false;

  if (!Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (normalizeMetadataKey(key) === "appcreator" && hasNonEmptyMetadataValue(child)) {
        return true;
      }
      if (hasAppCreatorMetadata(child)) return true;
    }
    return false;
  }

  return value.some(hasAppCreatorMetadata);
}

function normalizeMetadataKey(key) {
  return String(key || "").replace(/[-_]/g, "").toLowerCase();
}

function hasNonEmptyMetadataValue(value) {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function activityProviderLabel(provider) {
  return {
    github: "GitHub",
    gitlab: "GitLab",
    trello: "Trello",
    calendar: "Calendar",
  }[provider] || provider || "Provider";
}

export function activityActionLabel(activity) {
  const label = activity?.actionLabel || activity?.eventType || "Activity";
  const normalized = label.toLowerCase();
  const eventType = String(activity?.eventType || "").toLowerCase();
  if (normalized.includes("attach") || eventType.includes("attachment")) return "Changed";
  if (normalized.startsWith("moved:")) return label;
  if (normalized.includes("move")) return "Moved";
  if (normalized.includes("comment")) return "Commented";
  if (normalized.includes("create") || normalized.includes("open") || normalized.includes("add")) return "Created";
  if (normalized.includes("merge") || normalized.includes("accept")) return "Merged";
  if (normalized.includes("close")) return "Closed";
  if (normalized.includes("delete") || normalized.includes("remove") || normalized.includes("destroy")) return "Deleted";
  if (normalized.includes("push")) return "Pushed";
  if (normalized.includes("review")) return "Reviewed";
  if (normalized.includes("assign")) return "Assigned";
  if (normalized.includes("update") || normalized.includes("change") || normalized.includes("edit")) return "Changed";
  return label;
}

export function activityEventKindLabel(activity) {
  const type = activity?.eventType || "";
  const normalized = type.toLowerCase();
  if (normalized.includes("pullrequest") || normalized.includes("merge_request") || normalized.includes("merge request")) {
    return "Pull Request";
  }
  if (normalized.includes("issue")) return "Issue";
  if (normalized.includes("comment")) return "Comment";
  if (normalized.includes("push")) return "Push";
  if (normalized.includes("card")) return "Card";
  if (normalized.includes("board")) return "Board";
  if (normalized.includes("list")) return "List";
  if (normalized.includes("release")) return "Release";
  if (normalized.includes("wiki")) return "Wiki";
  return type.replace(/Event$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim() || "Event";
}

export function activityActionClassName(label) {
  const normalized = String(label || "").toLowerCase();
  if (normalized === "created") return "border-green-200 bg-green-50 text-green-800";
  if (normalized === "moved" || normalized.startsWith("moved:")) return "border-blue-200 bg-blue-50 text-blue-800";
  if (normalized === "changed") return "border-amber-200 bg-amber-50 text-amber-800";
  if (normalized === "commented") return "border-cyan-200 bg-cyan-50 text-cyan-800";
  if (normalized === "merged") return "border-purple-200 bg-purple-50 text-purple-800";
  if (normalized === "closed" || normalized === "deleted") return "border-red-200 bg-red-50 text-red-800";
  return "border-border bg-muted text-muted-foreground";
}

export function syncWarningMessages(syncRuns = []) {
  return syncRuns
    .filter((run) => run.status === "failed" && run.warning)
    .map((run) => `${activityProviderLabel(run.provider)} ${run.connectionName}: ${run.warning}`);
}
