import { aiSessionsWaitingForInputCount } from "./aiSessions.js";

export const AI_SESSION_MONITOR_UPDATED_EVENT = "ai-session-monitor-updated";

export function aiSessionWaitingStatusFromPayload(payload) {
  if (Number.isFinite(Number(payload?.waitingSessionCount))) {
    return Number(payload.waitingSessionCount) > 0;
  }
  return aiSessionsWaitingForInputCount(payload?.sessions) > 0;
}

export function normalizeAiSessionSnapshot(payload, now = Date.now()) {
  const refreshedAt = Number(payload?.lastRefreshedAt);
  const loadedAt = Number(payload?.loadedAt);
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  return {
    sessions,
    archivedSessions: Array.isArray(payload?.archivedSessions) ? payload.archivedSessions : [],
    warnings: Array.isArray(payload?.warnings) ? payload.warnings : [],
    loadedAt: Number.isFinite(loadedAt) && loadedAt > 0 ? loadedAt : now,
    lastRefreshedAt: Number.isFinite(refreshedAt) && refreshedAt > 0 ? refreshedAt : now,
    waitingSessionCount: Number.isFinite(Number(payload?.waitingSessionCount))
      ? Math.max(0, Number(payload.waitingSessionCount))
      : aiSessionsWaitingForInputCount(sessions),
  };
}

export function newerAiSessionSnapshot(current, candidate) {
  if (!candidate) return current;
  return Number(candidate.lastRefreshedAt || 0) >= Number(current?.lastRefreshedAt || 0)
    ? candidate
    : current;
}
