export const APP_NAVIGATION_REQUEST_EVENT = "app-navigation-requested";
export const AI_SESSIONS_DESTINATION = "ai-sessions";
export const SMART_INBOX_DESTINATION = "smart-inbox";

export function appNavigationDestination(payload) {
  return [AI_SESSIONS_DESTINATION, SMART_INBOX_DESTINATION].includes(payload?.destination)
    ? payload.destination
    : null;
}
