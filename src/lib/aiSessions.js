export const AI_SESSION_WINDOWS = [
  { value: 24, label: "1 day" },
  { value: 24 * 7, label: "7 days" },
  { value: 24 * 30, label: "30 days" },
];

export const AI_SESSION_MAX_WINDOW_HOURS = Math.max(
  ...AI_SESSION_WINDOWS.map(({ value }) => value),
);

export const AI_SESSION_DEFAULT_DONE_DURATION_SECONDS = 3 * 60 * 60;
export const AI_SESSION_MIN_DONE_DURATION_SECONDS = 60;
export const AI_SESSION_MAX_DONE_DURATION_SECONDS = 7 * 24 * 60 * 60;
export const AI_SESSION_DONE_WINDOW_MS = AI_SESSION_DEFAULT_DONE_DURATION_SECONDS * 1000;

export const AI_SESSION_REFRESH_INTERVALS = [
  { value: 0, label: "Off" },
  { value: 5, label: "5 seconds" },
  { value: 15, label: "15 seconds" },
  { value: 30, label: "30 seconds" },
  { value: 60, label: "1 minute" },
  { value: 300, label: "5 minutes" },
];

export const AI_SESSION_BACKGROUND_REFRESH_INTERVALS = AI_SESSION_REFRESH_INTERVALS.filter(
  ({ value }) => value > 0,
);

export const AI_SESSION_SOURCE_OPTIONS = [
  {
    key: "codexCli",
    provider: "codex",
    origin: "cli",
    label: "Codex CLI",
    description: "Sessions created from the Codex command-line interface.",
  },
  {
    key: "codexDesktop",
    provider: "codex",
    origin: "desktop",
    label: "Codex Desktop",
    description: "Sessions created from the Codex desktop application.",
  },
  {
    key: "claudeCli",
    provider: "claude",
    origin: "cli",
    label: "Claude CLI",
    description: "Sessions created from the Claude Code command-line interface.",
  },
  {
    key: "claudeDesktop",
    provider: "claude",
    origin: "desktop",
    label: "Claude Desktop",
    description: "Claude Code sessions created from the Claude desktop application.",
  },
];

export const DEFAULT_AI_SESSION_SETTINGS = {
  codexCli: true,
  codexDesktop: true,
  claudeCli: true,
  claudeDesktop: true,
  foregroundRefreshIntervalSeconds: 5,
  backgroundRefreshIntervalSeconds: 5,
  doneStateDurationSeconds: AI_SESSION_DEFAULT_DONE_DURATION_SECONDS,
};

export function normalizeAiSessionDoneDuration(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric)
    && numeric >= AI_SESSION_MIN_DONE_DURATION_SECONDS
    && numeric <= AI_SESSION_MAX_DONE_DURATION_SECONDS
    ? numeric
    : AI_SESSION_DEFAULT_DONE_DURATION_SECONDS;
}

export function aiSessionDoneWindowMs(settings) {
  return normalizeAiSessionDoneDuration(settings?.doneStateDurationSeconds) * 1000;
}

export function normalizeAiSessionForegroundRefreshInterval(value) {
  const numeric = Number(value);
  return AI_SESSION_REFRESH_INTERVALS.some((option) => option.value === numeric) ? numeric : 5;
}

export function normalizeAiSessionBackgroundRefreshInterval(value) {
  const numeric = Number(value);
  return AI_SESSION_BACKGROUND_REFRESH_INTERVALS.some((option) => option.value === numeric)
    ? numeric
    : 5;
}

export function aiSessionPollingIntervalMs(settings, foreground) {
  const normalized = normalizeAiSessionSettings(settings);
  const foregroundSeconds = normalized.foregroundRefreshIntervalSeconds;
  const seconds = foreground && foregroundSeconds > 0
    ? foregroundSeconds
    : normalized.backgroundRefreshIntervalSeconds;
  return seconds * 1000;
}

export function normalizeAiSessionSettings(settings) {
  const legacyForegroundInterval = settings?.refreshIntervalSeconds;
  return {
    ...Object.fromEntries(
      AI_SESSION_SOURCE_OPTIONS.map(({ key }) => [
        key,
        typeof settings?.[key] === "boolean" ? settings[key] : DEFAULT_AI_SESSION_SETTINGS[key],
      ]),
    ),
    foregroundRefreshIntervalSeconds: normalizeAiSessionForegroundRefreshInterval(
      settings?.foregroundRefreshIntervalSeconds ?? legacyForegroundInterval,
    ),
    backgroundRefreshIntervalSeconds: normalizeAiSessionBackgroundRefreshInterval(
      settings?.backgroundRefreshIntervalSeconds,
    ),
    doneStateDurationSeconds: normalizeAiSessionDoneDuration(
      settings?.doneStateDurationSeconds,
    ),
  };
}

export function aiSessionViewFilters(settings) {
  const normalized = normalizeAiSessionSettings(settings);
  return Object.fromEntries(
    AI_SESSION_SOURCE_OPTIONS.map(({ key }) => [
      key,
      normalized[key],
    ]),
  );
}

export function aiSessionProviderLabel(provider) {
  return { codex: "Codex", claude: "Claude" }[provider] || provider;
}

export function aiSessionSourceLabel(session) {
  const provider = aiSessionProviderLabel(session?.provider);
  if (session?.origin === "cli") return `${provider} CLI`;
  if (session?.origin === "desktop") return `${provider} Desktop`;
  return provider;
}

export function aiSessionPreferredOpenTarget(session) {
  const targets = session?.openTargets || [];
  const preferredTarget = {
    cli: "terminal",
    desktop: "desktop",
  }[session?.origin];
  return targets.includes(preferredTarget) ? preferredTarget : targets[0];
}

export function aiSessionProviderBadgeClass(provider) {
  if (provider === "codex") {
    return "border-emerald-500/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (provider === "claude") {
    return "border-orange-500/60 bg-orange-500/10 text-orange-700 dark:text-orange-300";
  }
  return "border-border bg-muted/40 text-muted-foreground";
}

export function aiSessionSourcesDisabled(settings) {
  const normalized = normalizeAiSessionSettings(settings);
  return AI_SESSION_SOURCE_OPTIONS.every(({ key }) => !normalized[key]);
}

export function aiSessionViewFiltersDisabled(filters) {
  return AI_SESSION_SOURCE_OPTIONS.every(({ key }) => filters?.[key] !== true);
}

export function aiSessionProviderFilterEnabled(provider, filters) {
  return AI_SESSION_SOURCE_OPTIONS.some(({ key, provider: optionProvider }) => (
    optionProvider === provider && filters?.[key] === true
  ));
}

export function aiSessionMatchesSourceFilters(session, filters) {
  const option = AI_SESSION_SOURCE_OPTIONS.find(({ provider, origin }) => (
    provider === session?.provider && origin === session?.origin
  ));
  if (option) return filters?.[option.key] === true;
  return aiSessionProviderFilterEnabled(session?.provider, filters);
}

export function filterAiSessions(sessions, filters) {
  return (sessions || []).flatMap((session) => {
    const children = (session.children || []).filter((child) => (
      aiSessionMatchesSourceFilters(child, filters)
    ));
    if (!aiSessionMatchesSourceFilters(session, filters) && children.length === 0) return [];
    return [{ ...session, children }];
  });
}

function aiSessionSearchText(session) {
  return [
    session?.title,
    session?.cwd,
    session?.provider ? aiSessionSourceLabel(session) : null,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

export function filterAiSessionsBySearch(sessions, query = "") {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return sessions;

  return (sessions || []).flatMap((session) => {
    if (aiSessionSearchText(session).includes(normalizedQuery)) return [session];

    const children = (session.children || []).filter((child) => (
      aiSessionSearchText(child).includes(normalizedQuery)
    ));
    return children.length > 0 ? [{ ...session, children }] : [];
  });
}

export function filterAiSessionsByWindow(sessions, hours, now = Date.now()) {
  const cutoff = now - Number(hours) * 3_600_000;
  return (sessions || []).flatMap((session) => {
    const children = (session.children || []).filter((child) => (
      Number(child.updatedAt || 0) >= cutoff
    ));
    if (Number(session.updatedAt || 0) < cutoff && children.length === 0) return [];
    return [{ ...session, children }];
  });
}

export function filterArchivedAiSessionsByWindow(sessions, hours, now = Date.now()) {
  const cutoff = now - Number(hours) * 3_600_000;
  return (sessions || []).filter((session) => Number(session.archivedAt || 0) >= cutoff);
}

export function aiSessionWindowCounts(sessions, filters, now = Date.now()) {
  const sourceFiltered = filterAiSessions(sessions, filters);
  return Object.fromEntries(
    AI_SESSION_WINDOWS.map(({ value }) => [
      value,
      filterAiSessionsByWindow(sourceFiltered, value, now).length,
    ]),
  );
}

export function archivedAiSessionWindowCounts(sessions, filters, now = Date.now()) {
  const sourceFiltered = filterAiSessions(sessions, filters);
  return Object.fromEntries(
    AI_SESSION_WINDOWS.map(({ value }) => [
      value,
      filterArchivedAiSessionsByWindow(sourceFiltered, value, now).length,
    ]),
  );
}

export function aiSessionTreeWaitingForInput(session) {
  return session?.waitingForInput === true
    || (session?.children || []).some((child) => child.waitingForInput === true);
}

export function aiSessionsWaitingForInput(sessions) {
  return aiSessionsWaitingForInputCount(sessions) > 0;
}

export function aiSessionsWaitingForInputCount(sessions) {
  return (sessions || []).filter((session) => (
    session?.archivedAt == null && aiSessionTreeWaitingForInput(session)
  )).length;
}

export function aiSessionState(session, now = Date.now(), doneWindowMs = AI_SESSION_DONE_WINDOW_MS) {
  if (session?.waitingForInput === true) return "waiting";
  if (session?.running === true) return "running";
  const completedAt = Number(session?.completedAt || 0);
  if (
    Number.isFinite(completedAt)
    && completedAt > 0
    && Math.max(0, Number(now) - completedAt) <= doneWindowMs
  ) {
    return "done";
  }
  return "idle";
}

export function aiSessionTreeState(
  session,
  now = Date.now(),
  doneWindowMs = AI_SESSION_DONE_WINDOW_MS,
) {
  const states = [
    aiSessionState(session, now, doneWindowMs),
    ...(session?.children || []).map((child) => aiSessionState(child, now, doneWindowMs)),
  ];
  if (states.includes("waiting")) return "waiting";
  if (states.includes("running")) return "running";
  if (states.includes("done")) return "done";
  return "idle";
}

export function aiSessionCanArchive(
  session,
  now = Date.now(),
  doneWindowMs = AI_SESSION_DONE_WINDOW_MS,
) {
  return ["done", "idle"].includes(aiSessionTreeState(session, now, doneWindowMs));
}

export function aiSessionStateTooltip(
  session,
  { now = Date.now(), doneWindowMs = AI_SESSION_DONE_WINDOW_MS, tree = false } = {},
) {
  const state = tree
    ? aiSessionTreeState(session, now, doneWindowMs)
    : aiSessionState(session, now, doneWindowMs);
  if (state === "waiting") return "Waiting for you";
  if (state === "running") return "Running";

  const sessions = tree ? [session, ...(session?.children || [])] : [session];
  if (state === "done") {
    const completedAt = Math.max(0, ...sessions
      .filter((item) => aiSessionState(item, now, doneWindowMs) === "done")
      .map((item) => Number(item?.completedAt || 0)));
    return completedAt > 0
      ? `Done — completed ${aiSessionRelativeTime(completedAt, now)}`
      : "Done — completed recently";
  }

  const updatedAt = Math.max(0, ...sessions.map((item) => Number(item?.updatedAt || 0)));
  return updatedAt > 0
    ? `Idle — last activity ${aiSessionRelativeTime(updatedAt, now)}`
    : "Idle — not currently running";
}

export function aiSessionArchiveActionLabel(session, archived = false) {
  if (archived) {
    return session?.archiveScope === "provider"
      ? "Restore in Codex and Station"
      : "Restore in Station";
  }
  return session?.provider === "codex"
    ? "Archive in Codex and Station"
    : "Hide from Station";
}

export function formatAiSessionLastRefreshed(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `Last refreshed ${new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)}`;
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
    const waitingOrder = Number(aiSessionTreeWaitingForInput(right))
      - Number(aiSessionTreeWaitingForInput(left));
    if (waitingOrder !== 0) return waitingOrder;
    const leftTime = Math.max(left.updatedAt || 0, ...(left.children || []).map((child) => child.updatedAt || 0));
    const rightTime = Math.max(right.updatedAt || 0, ...(right.children || []).map((child) => child.updatedAt || 0));
    return rightTime - leftTime || String(left.id).localeCompare(String(right.id));
  });
}

export function sortArchivedAiSessions(sessions) {
  return [...(sessions || [])].sort((left, right) => (
    Number(right.archivedAt || 0) - Number(left.archivedAt || 0)
    || String(left.provider).localeCompare(String(right.provider))
    || String(left.id).localeCompare(String(right.id))
  ));
}
