export const AI_SESSION_WAITING_STATUS_EVENT = "ai-session-waiting-status-changed";
export const AI_SESSION_WAITING_STATUS_REQUEST_EVENT = "ai-session-waiting-status-requested";

export function aiSessionWaitingStatusFromPayload(payload) {
  return payload?.waitingForInput === true;
}
