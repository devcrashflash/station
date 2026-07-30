export const APP_NAVIGATION_REQUEST_EVENT = "app-navigation-requested";
export const AI_SESSIONS_DESTINATION = "ai-sessions";
export const PROJECT_SWITCHER_DESTINATION = "project-switcher";
export const SMART_INBOX_DESTINATION = "smart-inbox";

export function appNavigationDestination(payload) {
  return [
    AI_SESSIONS_DESTINATION,
    PROJECT_SWITCHER_DESTINATION,
    SMART_INBOX_DESTINATION,
  ].includes(payload?.destination)
    ? payload.destination
    : null;
}

export function appNavigationReturnTabId(payload) {
  return typeof payload?.returnTabId === "string" && payload.returnTabId.trim()
    ? payload.returnTabId.trim()
    : null;
}

export function preserveProjectSwitcherReturnTabId(currentReturnTabId, incomingReturnTabId, switcherOpen) {
  return switcherOpen
    ? appNavigationReturnTabId({ returnTabId: currentReturnTabId })
    : appNavigationReturnTabId({ returnTabId: incomingReturnTabId });
}
