import {
  aiSessionViewFilters,
  filterAiSessions,
  filterAiSessionsBySearch,
  filterAiSessionsByWindow,
  sortAiSessions,
} from "./aiSessions.js";

export const SMART_OVERLAY_AGENT_WINDOW_HOURS = 24;

export function smartOverlaySessionKey(session) {
  return `${session?.provider || "unknown"}:${session?.id || "unknown"}`;
}

export function smartOverlayAgentSessions(sessions, settings, query = "", now = Date.now()) {
  const sourceFiltered = filterAiSessions(sessions, aiSessionViewFilters(settings));
  const recent = filterAiSessionsByWindow(
    sourceFiltered,
    SMART_OVERLAY_AGENT_WINDOW_HOURS,
    now,
  );
  return filterAiSessionsBySearch(sortAiSessions(recent), query);
}

export function smartOverlayHighlightedId(sessions, currentId) {
  if (sessions.some((session) => smartOverlaySessionKey(session) === currentId)) return currentId;
  return sessions[0] ? smartOverlaySessionKey(sessions[0]) : null;
}

export function smartOverlayMovedId(sessions, currentId, direction) {
  if (sessions.length === 0) return null;
  const currentIndex = sessions.findIndex((session) => smartOverlaySessionKey(session) === currentId);
  const startIndex = currentIndex < 0 ? 0 : currentIndex;
  return smartOverlaySessionKey(
    sessions[(startIndex + direction + sessions.length) % sessions.length],
  );
}

export function smartOverlayNumberSession(sessions, key, query = "") {
  if (query || !/^[1-9]$/.test(key)) return null;
  return sessions[Number(key) - 1] || null;
}
