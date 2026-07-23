export const AI_SESSION_WINDOWS = [
  { value: 24, label: "24 hours" },
  { value: 24 * 7, label: "7 days" },
  { value: 24 * 30, label: "30 days" },
];

export function aiSessionProviderLabel(provider) {
  return { codex: "Codex", claude: "Claude" }[provider] || provider;
}

export function aiSessionCommand(session) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(session?.id || "")) {
    throw new Error("Invalid AI session identifier.");
  }
  if (session.provider === "codex") return `codex resume ${session.id}\r`;
  if (session.provider === "claude") return `claude --resume ${session.id}\r`;
  throw new Error("Unsupported AI session provider.");
}

export function aiSessionRelativeTime(timestamp, now = Date.now()) {
  const elapsed = Math.max(0, now - Number(timestamp || 0));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function sortAiSessions(sessions) {
  return [...(sessions || [])].sort((left, right) => {
    const leftTime = Math.max(left.updatedAt || 0, ...(left.children || []).map((child) => child.updatedAt || 0));
    const rightTime = Math.max(right.updatedAt || 0, ...(right.children || []).map((child) => child.updatedAt || 0));
    return rightTime - leftTime || String(left.id).localeCompare(String(right.id));
  });
}
