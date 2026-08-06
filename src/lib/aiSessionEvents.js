export const AI_SESSION_MONITOR_UPDATED_EVENT = "ai-session-monitor-updated";

export function aiSessionRevisionFromPayload(payload) {
  return typeof payload?.revision === "string" ? payload.revision : "";
}

export function aiSessionWaitingStatusFromPayload(payload) {
  if (Number.isFinite(Number(payload?.waitingSessionCount))) {
    return Number(payload.waitingSessionCount) > 0;
  }
  return false;
}

export function aiSessionWaitingTerminalTabIdsFromPayload(payload) {
  if (!Array.isArray(payload?.waitingTerminalTabIds)) return [];
  return [...new Set(payload.waitingTerminalTabIds.filter((tabId) => (
    typeof tabId === "string" && tabId.length > 0
  )))];
}

export function normalizeAiSessionSnapshot(payload, now = Date.now()) {
  const refreshedAt = Number(payload?.lastRefreshedAt);
  const loadedAt = Number(payload?.loadedAt);
  const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
  return {
    sessions,
    archivedSessions: Array.isArray(payload?.archivedSessions) ? payload.archivedSessions : [],
    warnings: Array.isArray(payload?.warnings) ? payload.warnings : [],
    revision: aiSessionRevisionFromPayload(payload),
    loadedAt: Number.isFinite(loadedAt) && loadedAt > 0 ? loadedAt : now,
    lastRefreshedAt: Number.isFinite(refreshedAt) && refreshedAt > 0 ? refreshedAt : now,
    waitingSessionCount: Number.isFinite(Number(payload?.waitingSessionCount))
      ? Math.max(0, Number(payload.waitingSessionCount))
      : 0,
    waitingTerminalTabIds: aiSessionWaitingTerminalTabIdsFromPayload(payload),
  };
}

export function newerAiSessionSnapshot(current, candidate) {
  if (!candidate) return current;
  return Number(candidate.lastRefreshedAt || 0) >= Number(current?.lastRefreshedAt || 0)
    ? candidate
    : current;
}
