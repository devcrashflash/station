import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { formatLocalDate, localDayBounds, sortActivities } from "./activity.js";
import { EMAIL_DESKTOP_REQUIRED_MESSAGE, OCR_DESKTOP_REQUIRED_MESSAGE } from "./ocr.js";
import { AI_PROMPT_ICON_IDS } from "./aiPromptIcons.js";
import { AI_PROMPT_MODES, normalizeAiPromptMode } from "./aiPromptMode.js";
import {
  aiSessionCanArchive,
  DEFAULT_AI_SESSION_SETTINGS,
  normalizeAiSessionSettings,
  sortArchivedAiSessions,
} from "./aiSessions.js";
import { normalizeExternalLabelColor } from "./externalLabels.js";
import { normalizeProjectColor } from "./projectAvatar.js";
import { parseSmartInput } from "./smartInputParser.js";
import {
  DEFAULT_TERMINAL_SHORTCUTS,
  normalizeTerminalShortcuts,
  terminalShortcutConflict,
} from "./terminalShortcuts.js";

const STORAGE_KEY = "devcrashflash-station-state";
const LEGACY_STORAGE_KEY = "dev-crash-flash-ai-studio-state";

const defaultState = {
  projects: [],
  connections: [],
  aiPrompts: [],
  directories: [],
  projectConnections: {},
  resources: [],
  localResources: [],
  tasks: [],
  smartInboxTodos: [],
  smartInboxProviderItems: [],
  smartInboxProviderSources: [],
  taskLinks: [],
  taskRelations: [],
  pullRequests: [],
  reviewCommentDrafts: [],
  activities: [],
  activitySyncRuns: [],
  calendarAccounts: [],
  calendarEvents: [],
  calendarSyncRuns: [],
  browserSettings: {
    detectedBrowserBundleId: null,
    browserBundleId: null,
  },
  commandSettings: {
    reviewEnabled: true,
  },
  aiSessionSettings: { ...DEFAULT_AI_SESSION_SETTINGS },
  aiSessionArchives: [],
  terminalSettings: {
    newTabDirectory: null,
    newPaneDirectory: null,
    inactivePaneOpacity: 0.65,
    closeTerminalsOnAppExit: false,
    copyOnSelection: true,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontFace: null,
    fontWeight: 400,
    fontStyle: "normal",
    fontSize: 13,
    lineHeight: 100,
    horizontalSpacing: 100,
    scrollbackLines: 10_000,
    shortcuts: { ...DEFAULT_TERMINAL_SHORTCUTS },
    profileDirectory: "~",
  },
};

export const api = {
  quickCaptureSettings: () => call("quick_capture_settings", {}, () => ({
    enabled: false,
    shortcut: "CommandOrControl+Shift+Space",
    defaultShortcut: "CommandOrControl+Shift+Space",
    supported: false,
    registered: false,
    error: null,
  })),
  saveQuickCaptureSettings: (payload) => call("save_quick_capture_settings", { input: payload }, () => ({
    enabled: false,
    shortcut: "CommandOrControl+Shift+Space",
    defaultShortcut: "CommandOrControl+Shift+Space",
    supported: false,
    registered: false,
    error: "Quick capture requires the desktop app.",
  })),
  hideQuickCapture: ({ restoreFocus = false } = {}) =>
    call("hide_quick_capture", { restoreFocus }, () => null),
  resizeQuickCapture: ({ surface }) =>
    call("resize_quick_capture", { surface }, () => null),
  listPrograms: () => call("list_programs", {}, () => []),
  programIcon: ({ id }) => call("program_icon", { id }, () => null),
  launchProgram: ({ id }) => call("launch_program", { id }, () => {
    throw new Error("Launching programs requires the desktop app.");
  }),
  listBrowserSettings: () => call("list_browser_settings", {}, local.listBrowserSettings),
  saveBrowserSettings: (payload) =>
    call("save_browser_settings", { input: payload }, () => local.saveBrowserSettings(payload)),
  listCommandSettings: () => call("list_command_settings", {}, local.listCommandSettings),
  saveCommandSettings: (payload) =>
    call("save_command_settings", { input: payload }, () => local.saveCommandSettings(payload)),
  listTerminalSettings: () => call("list_terminal_settings", {}, local.listTerminalSettings),
  listTerminalFonts: () => call("list_terminal_fonts", {}, local.listTerminalFonts),
  saveTerminalSettings: (payload) =>
    call("save_terminal_settings", { input: payload }, () => local.saveTerminalSettings(payload)),
  listAiSessionSettings: () =>
    call("list_ai_session_settings", {}, local.listAiSessionSettings),
  saveAiSessionSettings: (payload) =>
    call("save_ai_session_settings", { input: payload }, () => local.saveAiSessionSettings(payload)),
  listAiSessions: ({ since, settings }) =>
    call("list_ai_sessions", { since, settings: normalizeAiSessionSettings(settings) }, local.listAiSessions),
  setAiSessionDockBadgeCount: ({ count }) =>
    call("set_ai_session_dock_badge", { count }, () => null),
  archiveAiSession: ({ session }) =>
    call("archive_ai_session", { session }, () => local.archiveAiSession(session)),
  restoreAiSession: ({ provider, sessionId }) =>
    call("restore_ai_session", { provider, sessionId }, () => local.restoreAiSession(provider, sessionId)),
  openAiSessionDesktop: ({ provider, sessionId }) =>
    call("open_ai_session_desktop", { provider, sessionId }, () => {
      throw new Error("Opening AI sessions requires the desktop app.");
    }),
  openAiSessionTerminal: ({ provider, sessionId, cwd }) =>
    call("open_ai_session_terminal", { provider, sessionId, cwd }, () => {
      throw new Error("Opening AI sessions requires the desktop app.");
    }),
  listProjects: () => call("list_projects", {}, local.listProjects),
  createProject: (payload) => call("create_project", payload, () => local.createProject(payload)),
  updateProject: (payload) => call("update_project", payload, () => local.updateProject(payload)),
  deleteProject: (payload) => call("delete_project", payload, () => local.deleteProject(payload)),
  listProjectResources: (payload) =>
    call("list_project_resources", payload, () => local.listProjectResources(payload)),
  connectResource: (payload) => call("connect_resource", { input: payload }, () => local.connectResource(payload)),
  disconnectResource: (payload) => call("disconnect_resource", payload, () => local.disconnectResource(payload)),
  listLocalResources: (payload) => call("list_local_resources", payload, () => local.listLocalResources(payload)),
  saveLocalResource: (payload) =>
    call("save_local_resource", { input: payload }, () => local.saveLocalResource(payload)),
  deleteLocalResource: (payload) => call("delete_local_resource", payload, () => local.deleteLocalResource(payload)),
  checkoutPullRequestForReview: (payload) =>
    call("checkout_pull_request_for_review", payload, () => local.checkoutPullRequestForReview(payload)),
  loadReviewDiff: (payload) => call("load_review_diff", payload, () => local.loadReviewDiff(payload)),
  loadReviewDiffFile: (payload) =>
    call("load_review_diff_file", payload, () => local.loadReviewDiffFile(payload)),
  listReviewCommentDrafts: (payload) =>
    call("list_review_comment_drafts", payload, () => local.listReviewCommentDrafts(payload)),
  saveReviewCommentDraft: (payload) =>
    call("save_review_comment_draft", { input: payload }, () => local.saveReviewCommentDraft(payload)),
  deleteReviewCommentDraft: (payload) =>
    call("delete_review_comment_draft", payload, () => local.deleteReviewCommentDraft(payload)),
  submitReviewComments: (payload) =>
    call("submit_review_comments", payload, () => local.submitReviewComments(payload)),
  chooseLocalResourceDirectory: async () => {
    if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) {
      throw new Error("Choosing local resource directories requires the desktop app.");
    }
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  },
  listDirectories: () => call("list_directories", {}, local.listDirectories),
  saveDirectory: (payload) => call("save_directory", { input: payload }, () => local.saveDirectory(payload)),
  deleteDirectory: (payload) => call("delete_directory", payload, () => local.deleteDirectory(payload)),
  listRecentDirectoryFiles: () => call("list_recent_directory_files", {}, local.listRecentDirectoryFiles),
  chooseDirectory: async () => {
    if (typeof window === "undefined" || !window.__TAURI_INTERNALS__) {
      throw new Error("Choosing directories requires the desktop app.");
    }
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  },
  createTaskFromInput: (payload) =>
    call("create_task_from_input", payload, () => local.createTaskFromInput(payload)),
  listSmartInboxProviderItems: (payload) =>
    call("list_smart_inbox_provider_items", payload, () => local.listSmartInboxProviderItems(payload)),
  syncSmartInboxProviderItems: (payload) =>
    call("sync_smart_inbox_provider_items", payload, () => local.listSmartInboxProviderItems(payload)),
  listSmartInboxProviderSources: (payload) =>
    call("list_smart_inbox_provider_sources", payload, () => local.listSmartInboxProviderSources(payload)),
  updateSmartInboxProviderSources: (payload) =>
    call("update_smart_inbox_provider_sources", payload, () => local.updateSmartInboxProviderSources(payload)),
  listSmartInboxTodos: () => call("list_smart_inbox_todos", {}, local.listSmartInboxTodos),
  createSmartInboxTodo: (payload) =>
    call("create_smart_inbox_todo", { input: payload }, () => local.createSmartInboxTodo(payload)),
  updateSmartInboxTodo: (payload) =>
    call("update_smart_inbox_todo", { input: payload }, () => local.updateSmartInboxTodo(payload)),
  deleteSmartInboxTodo: (payload) =>
    call("delete_smart_inbox_todo", payload, () => local.deleteSmartInboxTodo(payload)),
  ocrImageFile: (payload) => call("ocr_image_file", payload, () => local.ocrImageFile()),
  ocrImageBytes: (payload) => call("ocr_image_bytes", payload, () => local.ocrImageFile()),
  readEmailFile: (payload) => call("read_email_file", payload, () => local.readEmailFile()),
  readEmailBytes: (payload) => call("read_email_bytes", payload, () => local.readEmailFile()),
  readAppleMailMessage: (payload) => call("read_apple_mail_message", payload, () => local.readEmailFile()),
  listTasks: (payload) => call("list_tasks", payload, () => local.listTasks(payload)),
  updateTask: (payload) => call("update_task", payload, () => local.updateTask(payload)),
  deleteTask: (payload) => call("delete_task", payload, () => local.deleteTask(payload)),
  listTaskTrelloBoards: (payload) =>
    call("list_task_trello_boards", payload, () => local.listTaskTrelloBoards(payload)),
  listTrelloBoardTemplates: (payload) =>
    call("list_trello_board_templates", payload, () => local.listTrelloBoardTemplates(payload)),
  convertTaskToTrelloTicket: (payload) =>
    call("convert_task_to_trello_ticket", payload, () => local.convertTaskToTrelloTicket(payload)),
  linkTaskResource: (payload) => call("link_task_resource", payload, () => local.linkTaskResource(payload)),
  listTaskLinks: (payload) => call("list_task_links", payload, () => local.listTaskLinks(payload)),
  refreshTaskExternalDetails: (payload) =>
    call("refresh_task_external_details", payload, () => local.refreshTaskExternalDetails(payload)),
  listTaskRelations: (payload) => call("list_task_relations", payload, () => local.listTaskRelations(payload)),
  saveTaskRelation: (payload) =>
    call("save_task_relation", { input: payload }, () => local.saveTaskRelation(payload)),
  deleteTaskRelation: (payload) => call("delete_task_relation", payload, () => local.deleteTaskRelation(payload)),
  listConnections: () => call("list_connections", {}, local.listConnections),
  saveConnection: (payload) => {
    const input = normalizeConnectionInput(payload);
    return call("save_connection", { input }, () => local.saveConnection(input));
  },
  deleteConnection: (payload) => call("delete_connection", payload, () => local.deleteConnection(payload)),
  testConnection: (payload) => call("test_connection", payload, () => local.testConnection(payload)),
  listAiPrompts: () => call("list_ai_prompts", {}, local.listAiPrompts),
  saveAiPrompt: (payload) => call("save_ai_prompt", { input: payload }, () => local.saveAiPrompt(payload)),
  deleteAiPrompt: (payload) => call("delete_ai_prompt", payload, () => local.deleteAiPrompt(payload)),
  inspectAiPromptBranches: (payload) => call("inspect_ai_prompt_branches", { input: payload }, () => {
    throw new Error("Inspecting AI Prompt branches requires the desktop app.");
  }),
  openAiPromptThread: (payload) => call("open_ai_prompt_thread", { input: payload }, () => {
    throw new Error("Opening an AI Prompt thread requires the desktop app.");
  }),
  listProjectConnections: (payload) =>
    call("list_project_connections", payload, () => local.listProjectConnections(payload)),
  setProjectConnections: (payload) =>
    call("set_project_connections", payload, () => local.setProjectConnections(payload)),
  listActivities: (payload) => {
    const input = activityRequestPayload(payload);
    return call("list_activities", input, () => local.listActivities(input));
  },
  syncActivities: (payload) => {
    const input = activityRequestPayload(payload);
    return call("sync_activities", input, () => local.syncActivities(input));
  },
  resolveTrelloTickets: (payload) =>
    call("resolve_trello_tickets", { input: payload }, () => local.resolveTrelloTickets(payload)),
  listCalendarAccounts: () => call("list_calendar_accounts", {}, local.listCalendarAccounts),
  connectGoogleAccount: ({ accountId = null } = {}) => call("connect_google_account", { accountId }, () => {
    throw new Error("Google sign-in requires the desktop app.");
  }),
  cancelGoogleAccountConnection: () => call("cancel_google_account_connection", {}, () => null),
  updateCalendarService: (payload) => call("update_calendar_service", { input: payload }, () => local.updateCalendarService(payload)),
  saveCalendarSubscription: (payload) => call("save_calendar_subscription", { input: payload }, () => {
    throw new Error("Secret calendar URLs can only be stored securely in the desktop app.");
  }),
  saveCalDavAccount: (payload) => call("save_caldav_account", { input: payload }, () => local.saveCalDavAccount(payload)),
  refreshCalendarCollections: ({ accountId }) => call("refresh_calendar_collections", { accountId }, () => local.refreshCalendarCollections({ accountId })),
  updateCalendarCollections: ({ selections }) => call("update_calendar_collections", { selections }, () => local.updateCalendarCollections({ selections })),
  testCalendarAccount: ({ accountId }) => call("test_calendar_account", { accountId }, () => local.testCalendarAccount({ accountId })),
  deleteCalendarAccount: ({ accountId }) => call("delete_calendar_account", { accountId }, () => local.deleteCalendarAccount({ accountId })),
  listCalendarEvents: (payload) => {
    const input = activityRequestPayload(payload);
    return call("list_calendar_events", input, () => local.listCalendarEvents(input));
  },
  syncCalendarEvents: (payload) => {
    const input = activityRequestPayload(payload);
    return call("sync_calendar_events", input, () => local.syncCalendarEvents(input));
  },
};

async function call(command, payload, fallback) {
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    return invoke(command, payload);
  }

  return fallback();
}

function readState() {
  try {
    const storedState = localStorage.getItem(STORAGE_KEY);
    const legacyState = storedState === null ? localStorage.getItem(LEGACY_STORAGE_KEY) : null;
    const parsed = JSON.parse(storedState ?? legacyState);
    let migrated = legacyState !== null;
    if (!Array.isArray(parsed?.aiPrompts) && Array.isArray(parsed?.aiAgents)) {
      parsed.aiPrompts = parsed.aiAgents.map(({ type, ...agent }) => ({
        ...agent,
        agentType: agent.agentType || type,
        icon: AI_PROMPT_ICON_IDS.includes(agent.icon) ? agent.icon : "sparkles",
        mode: normalizeAiPromptMode(agent.agentType || type, agent.mode),
        promptText: agent.promptText || "",
      }));
      delete parsed.aiAgents;
      migrated = true;
    }
    if (Array.isArray(parsed?.aiPrompts)) {
      parsed.aiPrompts = parsed.aiPrompts.map((prompt) => {
        const icon = AI_PROMPT_ICON_IDS.includes(prompt.icon) ? prompt.icon : "sparkles";
        const mode = normalizeAiPromptMode(prompt.agentType, prompt.mode);
        if (icon === prompt.icon && mode === prompt.mode) return prompt;
        migrated = true;
        return { ...prompt, icon, mode };
      });
    }
    if (migrated) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
    }
    return { ...freshDefaultState(), ...parsed };
  } catch {
    return freshDefaultState();
  }
}

function freshDefaultState() {
  return {
    ...defaultState,
    projects: [],
    connections: [],
    aiPrompts: [],
    directories: [],
    projectConnections: {},
    resources: [],
    localResources: [],
    tasks: [],
    smartInboxTodos: [],
    smartInboxProviderItems: [],
    smartInboxProviderSources: [],
    taskLinks: [],
    taskRelations: [],
    pullRequests: [],
    reviewCommentDrafts: [],
    activities: [],
    activitySyncRuns: [],
    calendarAccounts: [],
    calendarEvents: [],
    calendarSyncRuns: [],
    browserSettings: { ...defaultState.browserSettings },
    commandSettings: { ...defaultState.commandSettings },
    aiSessionSettings: { ...defaultState.aiSessionSettings },
    aiSessionArchives: [],
    terminalSettings: { ...defaultState.terminalSettings },
  };
}

function writeState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function id(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function now() {
  return Date.now();
}

function activityRequestPayload(payload) {
  const date = payload?.date || formatLocalDate();
  const bounds = localDayBounds(date);
  return {
    date,
    ...bounds,
  };
}

function normalizeIcon(icon) {
  return icon?.trim() || "FolderKanban";
}

function normalizeProject(project) {
  return {
    ...project,
    icon: normalizeIcon(project.icon),
    color: normalizeProjectColor(project.color),
  };
}

function directoryNameFromPath(path) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) || path;
}

export function toParsedPayload(parsed) {
  return {
    kind: parsed.kind,
    provider: parsed.provider ?? null,
    externalId: parsed.externalId ?? null,
    url: parsed.url ?? null,
    title: parsed.title,
    repoUrl: parsed.repoUrl ?? null,
  };
}

export function selectBestConnection(connections, enabledConnectionIds, parsed) {
  const enabled = new Set(enabledConnectionIds);
  const parsedHost = hostFromUrl(parsed.url) || hostFromUrl(parsed.repoUrl);
  return connections
    .filter((connection) => enabled.has(connection.id) && connection.provider === parsed.provider)
    .map((connection) => ({
      connection,
      score: connectionScore(connection, parsedHost),
    }))
    .sort((left, right) => right.score - left.score)
    .at(0)?.connection || null;
}

export function validateConnectionForTest(connection) {
  if (connection?.provider !== "trello" && !connection?.baseUrl?.trim()) return "Base URL is required.";
  if (!connection?.token?.trim()) return "Token is required.";
  if (connection.provider === "trello" && !connection.apiKey?.trim()) {
    return "Trello API key is required.";
  }
  return "";
}

export function validateAiPromptForTest(prompt, prompts = []) {
  const agentType = prompt?.agentType?.trim() || "";
  if (!["codex", "claude"].includes(agentType)) return "AI Prompt agent must be Codex or Claude.";
  if (!AI_PROMPT_ICON_IDS.includes(prompt?.icon)) return "AI Prompt icon is not supported.";
  if (!AI_PROMPT_MODES.includes(prompt?.mode)) return "AI Prompt mode must be Agent or Plan.";
  if (agentType === "claude" && prompt.mode !== "agent") return "Claude AI Prompts only support Agent mode.";

  const name = prompt?.name?.trim() || "";
  if (!name) return "AI Prompt name is required.";
  const normalizedName = name.toLocaleLowerCase();
  if (prompts.some((item) => item.id !== prompt?.id && item.name?.trim().toLocaleLowerCase() === normalizedName)) {
    return "An AI Prompt with this name already exists.";
  }
  return "";
}

function normalizeConnectionInput(input) {
  return {
    ...input,
    apiKey: input.provider === "trello" ? input.apiKey : null,
    baseUrl: input.provider === "trello" ? "https://api.trello.com" : normalizeBaseUrl(input.baseUrl),
  };
}

export function normalizeBaseUrl(value) {
  const trimmed = value?.trim().replace(/\/+$/, "") || "";
  if (!trimmed || trimmed.startsWith("https://") || trimmed.startsWith("http://")) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function connectionScore(connection, parsedHost) {
  const connectionHost = hostFromUrl(connection.baseUrl);
  if (parsedHost && connectionHost && parsedHost === connectionHost) return 3;
  if (connection.provider === "github" && parsedHost === "github.com") return 2;
  if (connection.provider === "trello" && parsedHost === "trello.com") return 2;
  return 1;
}

function hostFromUrl(value) {
  if (!value) return "";
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return value.replace(/^https?:\/\//, "").split(/[/:?#]/)[0]?.toLowerCase() || "";
  }
}

export function normalizeRepoUrl(value) {
  let input = value?.trim().replace(/\/+$/, "") || "";
  if (!input) return "";

  if (input.startsWith("git@") || (input.includes("@") && input.includes(":") && !input.includes("://"))) {
    const [, rest = ""] = input.split("@");
    const [host = "", path = ""] = rest.split(":");
    input = `${host}/${path}`;
  } else if (input.startsWith("ssh://")) {
    const rest = input.slice("ssh://".length);
    input = rest.includes("@") ? rest.split("@").slice(1).join("@") : rest;
  } else {
    input = input.replace(/^https?:\/\//, "");
  }

  input = input.split(/[?#]/)[0].replace(/\/+$/, "");
  if (input.endsWith(".git")) {
    input = input.slice(0, -4);
  }

  const normalized = input
    .split("/")
    .filter(Boolean)
    .join("/")
    .toLowerCase();
  return normalized.split("/").length >= 3 ? normalized : "";
}

export function repoUrlFromPullRequestUrl(value) {
  const parsed = parseSmartInput(value || "");
  return parsed.repoUrl || "";
}

export function isPullRequestResource(resource) {
  return resource?.kind === "pull_request" || resource?.kind === "merge_request";
}

function providerFromRepoUrl(repoUrl) {
  const host = normalizeRepoUrl(repoUrl).split("/")[0] || "";
  return host === "github.com" || host.endsWith(".github.com") ? "github" : "gitlab";
}

function displayRepoUrl(repoUrl) {
  const normalized = normalizeRepoUrl(repoUrl);
  return normalized ? `https://${normalized}` : repoUrl;
}

function repoResourceName(repoUrl) {
  const normalized = normalizeRepoUrl(repoUrl);
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length >= 3) {
    return parts.slice(1).join("/");
  }
  return repoUrl || "Repository";
}

function parentResourceFromParsed(parsed) {
  if (parsed?.kind === "trello_board" && parsed.externalId) {
    return {
      provider: "trello",
      kind: "trello_board",
      externalId: parsed.externalId,
      url: parsed.url,
      name: parsed.title || `Trello board ${parsed.externalId}`,
      iconUrl: null,
      connectionId: null,
    };
  }

  if (parsed?.provider === "github" && ["github_issue", "pull_request"].includes(parsed.kind)) {
    const externalId = normalizeRepoUrl(parsed.repoUrl || "");
    if (!externalId) return null;
    return {
      provider: "github",
      kind: "github_repo",
      externalId,
      url: displayRepoUrl(parsed.repoUrl),
      name: repoResourceName(parsed.repoUrl),
      iconUrl: null,
      connectionId: null,
    };
  }

  if (parsed?.provider === "gitlab" && ["gitlab_issue", "merge_request"].includes(parsed.kind)) {
    const externalId = normalizeRepoUrl(parsed.repoUrl || "");
    if (!externalId) return null;
    return {
      provider: "gitlab",
      kind: "gitlab_repo",
      externalId,
      url: displayRepoUrl(parsed.repoUrl),
      name: repoResourceName(parsed.repoUrl),
      iconUrl: null,
      connectionId: null,
    };
  }

  return null;
}

function upsertProjectResource(state, projectId, input) {
  if (!projectId || !input?.provider || !input?.kind || !input?.externalId) return null;
  state.resources = state.resources || [];
  const existing = state.resources.find(
    (item) =>
      item.projectId === projectId &&
      item.provider === input.provider &&
      item.kind === input.kind &&
      item.externalId === input.externalId,
  );

  if (existing) {
    return existing;
  }

  const resource = {
    id: id("resource"),
    projectId,
    ...input,
    iconUrl: input.iconUrl ?? null,
    connectionId: input.connectionId ?? null,
  };
  state.resources.push(resource);
  return resource;
}

function normalizeTaskFiles(files) {
  if (!Array.isArray(files)) return [];
  return files
    .map((file) => ({
      id: file?.id || file?.url || id("file"),
      name: file?.name || file?.url || "File",
      url: file?.url || "",
      source: file?.source || "local",
      contentType: file?.contentType ?? null,
      bytes: Number.isFinite(file?.bytes) ? file.bytes : null,
      createdAt: file?.createdAt ?? null,
    }))
    .filter((file) => file.url);
}

function normalizeTaskComments(comments) {
  if (!Array.isArray(comments)) return [];
  return comments
    .map((comment) => ({
      id: comment?.id || "",
      kind: comment?.kind || "comment",
      author: comment?.author || "Unknown author",
      body: comment?.body || "",
      createdAt: comment?.createdAt ?? null,
      updatedAt: comment?.updatedAt ?? null,
      url: comment?.url ?? null,
      discussionId: comment?.discussionId ?? null,
      replyToId: comment?.replyToId ?? null,
      codeContext: comment?.codeContext ?? null,
    }))
    .filter((comment) => comment.id && comment.body.trim());
}

function normalizeTaskLink(link) {
  return {
    ...link,
    files: normalizeTaskFiles(link?.files),
    comments: normalizeTaskComments(link?.comments),
    labels: (Array.isArray(link?.labels) ? link.labels : [])
      .map((label) => ({
        name: String(label?.name || "").trim(),
        color: normalizeExternalLabelColor(label?.color),
      }))
      .filter((label, index, labels) => (
        label.name && labels.findIndex((candidate) => candidate.name === label.name) === index
      )),
  };
}

function normalizeSmartInboxTodo(todo) {
  return {
    id: todo.id,
    kind: todo.kind === "file" ? "file" : "text",
    title: todo.title?.trim() || (todo.kind === "file" ? "File" : "Untitled todo"),
    rawText: todo.rawText ?? null,
    filePath: todo.filePath ?? null,
    fileName: todo.fileName ?? null,
    mimeType: todo.mimeType ?? null,
    fileMissing: Boolean(todo.fileMissing),
    createdAt: Number.isFinite(todo.createdAt) ? todo.createdAt : now(),
    updatedAt: Number.isFinite(todo.updatedAt) ? todo.updatedAt : now(),
  };
}

function smartInboxTodoTitle(input) {
  const kind = input?.kind === "file" ? "file" : "text";
  if (input?.title?.trim()) return input.title.trim();
  if (kind === "file") {
    return input?.fileName?.trim() || fileNameFromPath(input?.filePath) || "File";
  }
  return firstLine(input?.rawText) || "Untitled todo";
}

function smartInboxTodoFilePath(input) {
  return input?.kind === "file" ? input?.filePath?.trim() || "" : "";
}

function fileNameFromPath(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).at(-1) || "";
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).find((line) => line.trim())?.trim() || "";
}

function enrichTask(state, task) {
  const link = (state.taskLinks || []).find((item) => item.taskId === task.id);
  return {
    ...task,
    sourceProvider: link?.provider ?? null,
    sourceKind: link?.kind ?? null,
  };
}

function enrichTasks(state, tasks) {
  return tasks.map((task) => enrichTask(state, task));
}

function latestProjectTaskForProviderItem(state, item, taskKind) {
  if (!taskKind) return null;

  const linkedTaskIds = new Set(
    (state.taskLinks || [])
      .filter((link) => (
        link.provider === item.provider &&
        link.kind === taskKind &&
        link.externalId === item.externalId
      ))
      .map((link) => link.taskId),
  );
  const task = (state.tasks || [])
    .filter((candidate) => candidate.projectId && linkedTaskIds.has(candidate.id))
    .sort((left, right) => (
      (right.updatedAt || 0) - (left.updatedAt || 0) || left.id.localeCompare(right.id)
    ))
    .at(0);

  return task ? enrichTask(state, task) : null;
}

function supportsExternalRefresh(link) {
  return (
    (link?.provider === "trello" && link?.kind === "trello_card") ||
    (link?.provider === "github" && ["github_issue", "pull_request"].includes(link?.kind)) ||
    (link?.provider === "gitlab" && ["gitlab_issue", "merge_request"].includes(link?.kind))
  );
}

function providerConnectionRequiredNotice(provider) {
  const labels = {
    github: "GitHub",
    gitlab: "GitLab",
    trello: "Trello",
  };

  return `Please add a ${labels[provider] || provider} connection to this project.`;
}

function activityMatchesBounds(activity, startAt, endAt) {
  return activity.occurredAt >= startAt && activity.occurredAt < endAt;
}

function activitySyncRunMatches(run, date) {
  return run.date === date;
}

function discoverLocalSmartInboxSources(state, provider) {
  state.smartInboxProviderSources = state.smartInboxProviderSources || [];
  const timestamp = now();
  for (const item of state.smartInboxProviderItems || []) {
    if (item.provider !== provider || !item.connectionId || !item.sourceId) continue;
    const existing = state.smartInboxProviderSources.find((source) => (
      source.provider === provider &&
      source.connectionId === item.connectionId &&
      source.sourceId === item.sourceId
    ));
    if (existing) {
      existing.sourceName = item.sourceName || existing.sourceName;
      existing.connectionName = item.connectionName || existing.connectionName;
      continue;
    }
    state.smartInboxProviderSources.push({
      provider,
      connectionId: item.connectionId,
      connectionName: item.connectionName || state.connections.find(({ id }) => id === item.connectionId)?.name || provider,
      sourceId: item.sourceId,
      sourceName: item.sourceName || item.sourceId,
      enabled: true,
      discoveredAt: timestamp,
      updatedAt: timestamp,
    });
  }
}

function localActivityResult(state, { date, startAt, endAt }) {
  return {
    activities: sortActivities((state.activities || []).filter((activity) => activityMatchesBounds(activity, startAt, endAt))),
    syncRuns: (state.activitySyncRuns || []).filter((run) => activitySyncRunMatches(run, date)),
  };
}

function localCalendarResult(state, { date, startAt, endAt }) {
  const enabledIds = new Set((state.calendarAccounts || []).flatMap((account) =>
    (account.calendars || []).filter((calendar) => account.provider !== "google" || calendar.enabled).map((calendar) => calendar.id)));
  return {
    events: (state.calendarEvents || [])
      .filter((event) => enabledIds.has(event.collectionId) && event.startAt < endAt && event.endAt > startAt)
      .sort((left, right) => Number(right.allDay) - Number(left.allDay) || left.startAt - right.startAt),
    syncRuns: (state.calendarSyncRuns || []).filter((run) => run.date === date),
  };
}

const local = {
  listTerminalFonts() {
    return [];
  },

  listAiSessionSettings() {
    return normalizeAiSessionSettings(readState().aiSessionSettings);
  },

  saveAiSessionSettings(input) {
    const state = readState();
    state.aiSessionSettings = normalizeAiSessionSettings(input);
    writeState(state);
    return state.aiSessionSettings;
  },

  listAiSessions() {
    const archivedSessions = (readState().aiSessionArchives || []).map((session) => ({
      ...session,
      archiveScope: session.archiveScope === "provider" ? "provider" : "station",
    }));
    return {
      sessions: [],
      archivedSessions: sortArchivedAiSessions(archivedSessions),
      warnings: [],
    };
  },

  archiveAiSession(session) {
    const validTreeIds = (candidate) => (
      /^[A-Za-z0-9_-]{1,128}$/.test(candidate?.id || "")
      && (candidate.children || []).every(validTreeIds)
    );
    if (!["codex", "claude"].includes(session?.provider)) {
      throw new Error("Unsupported AI session provider.");
    }
    if (!validTreeIds(session)) {
      throw new Error("Invalid AI session identifier.");
    }
    if (session?.parentId || session?.kind !== "session") {
      throw new Error("Only top-level AI sessions can be archived.");
    }
    if (!aiSessionCanArchive(session)) {
      throw new Error("Running sessions and sessions waiting for input cannot be archived.");
    }
    const state = readState();
    const archived = JSON.parse(JSON.stringify({
      ...session,
      archivedAt: now(),
      archiveScope: "station",
    }));
    state.aiSessionArchives = (state.aiSessionArchives || []).filter((candidate) => (
      candidate.provider !== archived.provider || candidate.id !== archived.id
    ));
    state.aiSessionArchives.push(archived);
    writeState(state);
    return archived;
  },

  restoreAiSession(provider, sessionId) {
    if (!["codex", "claude"].includes(provider)) {
      throw new Error("Unsupported AI session provider.");
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId || "")) {
      throw new Error("Invalid AI session identifier.");
    }
    const state = readState();
    state.aiSessionArchives = (state.aiSessionArchives || []).filter((candidate) => (
      candidate.provider !== provider || candidate.id !== sessionId
    ));
    writeState(state);
    return null;
  },

  listTerminalSettings() {
    const settings = { ...defaultState.terminalSettings, ...readState().terminalSettings };
    const storedLineHeight = Number(settings.lineHeight);
    const storedHorizontalSpacing = Number(settings.horizontalSpacing);
    const storedScrollbackLines = Number(settings.scrollbackLines);
    settings.lineHeight = Number.isFinite(storedLineHeight)
      ? Math.round(Math.min(200, Math.max(100, storedLineHeight <= 2 ? storedLineHeight * 100 : storedLineHeight)))
      : defaultState.terminalSettings.lineHeight;
    settings.horizontalSpacing = Number.isFinite(storedHorizontalSpacing)
      ? Math.round(Math.min(200, Math.max(100, storedHorizontalSpacing <= 2 ? storedHorizontalSpacing * 100 : storedHorizontalSpacing)))
      : defaultState.terminalSettings.horizontalSpacing;
    settings.scrollbackLines = Number.isInteger(storedScrollbackLines)
      ? Math.min(100_000, Math.max(0, storedScrollbackLines))
      : defaultState.terminalSettings.scrollbackLines;
    settings.shortcuts = normalizeTerminalShortcuts(settings.shortcuts);
    return settings;
  },

  saveTerminalSettings(input) {
    const state = readState();
    const requestedOpacity = Number(input.inactivePaneOpacity);
    const requestedFontSize = Number(input.fontSize);
    const requestedLineHeight = Number(input.lineHeight);
    const requestedHorizontalSpacing = Number(input.horizontalSpacing);
    const requestedScrollbackLines = Number(
      input.scrollbackLines ?? state.terminalSettings?.scrollbackLines ?? defaultState.terminalSettings.scrollbackLines,
    );
    const requestedFontWeight = Number(input.fontWeight);
    const requestedShortcuts = input.shortcuts ?? state.terminalSettings?.shortcuts ?? defaultState.terminalSettings.shortcuts;
    const shortcutConflict = terminalShortcutConflict(requestedShortcuts);
    if (shortcutConflict) {
      throw new Error(shortcutConflict.invalid
        ? "Terminal shortcuts must include Command, Control, Option, or Alt with another key."
        : shortcutConflict.reserved
          ? "Terminal shortcuts cannot replace Cmd/Ctrl+T, Cmd/Ctrl+W, or Cmd/Ctrl+0–9."
          : "Each terminal action must use a unique shortcut.");
    }
    const shortcuts = normalizeTerminalShortcuts(requestedShortcuts);
    state.terminalSettings = {
      newTabDirectory: input.newTabDirectory?.trim() || null,
      newPaneDirectory: input.newPaneDirectory?.trim() || null,
      inactivePaneOpacity: Number.isFinite(requestedOpacity)
        ? Math.min(0.95, Math.max(0.2, requestedOpacity))
        : 0.65,
      closeTerminalsOnAppExit: input.closeTerminalsOnAppExit
        ?? state.terminalSettings?.closeTerminalsOnAppExit
        ?? false,
      copyOnSelection: input.copyOnSelection
        ?? state.terminalSettings?.copyOnSelection
        ?? true,
      fontFamily: input.fontFamily?.trim() || defaultState.terminalSettings.fontFamily,
      fontFace: null,
      fontWeight: Number.isFinite(requestedFontWeight)
        ? Math.min(900, Math.max(100, requestedFontWeight))
        : defaultState.terminalSettings.fontWeight,
      fontStyle: input.fontStyle === "italic" ? "italic" : "normal",
      fontSize: Number.isFinite(requestedFontSize)
        ? Math.min(32, Math.max(8, requestedFontSize))
        : defaultState.terminalSettings.fontSize,
      lineHeight: Number.isFinite(requestedLineHeight)
        ? Math.round(Math.min(200, Math.max(100, requestedLineHeight <= 2 ? requestedLineHeight * 100 : requestedLineHeight)))
        : defaultState.terminalSettings.lineHeight,
      horizontalSpacing: Number.isFinite(requestedHorizontalSpacing)
        ? Math.round(Math.min(200, Math.max(100, requestedHorizontalSpacing <= 2 ? requestedHorizontalSpacing * 100 : requestedHorizontalSpacing)))
        : defaultState.terminalSettings.horizontalSpacing,
      scrollbackLines: Number.isInteger(requestedScrollbackLines)
        ? Math.min(100_000, Math.max(0, requestedScrollbackLines))
        : defaultState.terminalSettings.scrollbackLines,
      shortcuts,
      profileDirectory: state.terminalSettings?.profileDirectory || "~",
    };
    writeState(state);
    return state.terminalSettings;
  },

  listBrowserSettings() {
    return {
      detectedBrowserBundleId: null,
      browserBundleId: readState().browserSettings?.browserBundleId || null,
    };
  },

  saveBrowserSettings(input) {
    const state = readState();
    state.browserSettings = {
      detectedBrowserBundleId: null,
      browserBundleId: input.browserBundleId?.trim() || null,
    };
    writeState(state);
    return state.browserSettings;
  },

  listCommandSettings() {
    return {
      reviewEnabled: readState().commandSettings?.reviewEnabled !== false,
    };
  },

  saveCommandSettings(input) {
    const state = readState();
    state.commandSettings = {
      reviewEnabled: input?.reviewEnabled !== false,
    };
    writeState(state);
    return state.commandSettings;
  },

  listProjects() {
    const state = readState();
    const projects = state.projects.map(normalizeProject);
    if (JSON.stringify(projects) !== JSON.stringify(state.projects)) {
      state.projects = projects;
      writeState(state);
    }
    return projects;
  },

  createProject({ name, icon, color }) {
    const state = readState();
    const timestamp = now();
    const project = {
      id: id("project"),
      name: name?.trim() || "Untitled project",
      icon: normalizeIcon(icon),
      color: normalizeProjectColor(color),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.projects.push(project);
    writeState(state);
    return project;
  },

  updateProject({ id: projectId, name, icon, color }) {
    const state = readState();
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) throw new Error("Project not found");
    project.name = name ?? project.name;
    project.icon = icon ?? project.icon;
    project.color = color === undefined ? normalizeProjectColor(project.color) : normalizeProjectColor(color);
    project.updatedAt = now();
    writeState(state);
    return normalizeProject(project);
  },

  deleteProject({ id: projectId }) {
    const state = readState();
    state.projects = state.projects.filter((item) => item.id !== projectId);
    state.resources = state.resources.filter((item) => item.projectId !== projectId);
    state.localResources = (state.localResources || []).filter((item) => item.projectId !== projectId);
    state.tasks = state.tasks.filter((item) => item.projectId !== projectId);
    state.taskRelations = (state.taskRelations || []).filter((relation) => {
      const source = state.tasks.find((task) => task.id === relation.sourceTaskId);
      const target = state.tasks.find((task) => task.id === relation.targetTaskId);
      return source && target;
    });
    state.pullRequests = state.pullRequests.filter((item) => item.projectId !== projectId);
    delete state.projectConnections?.[projectId];
    writeState(state);
  },

  listProjectResources({ projectId }) {
    return readState().resources.filter((item) => item.projectId === projectId);
  },

  connectResource(input) {
    const state = readState();
    const externalId = input.externalId?.trim() || input.url;
    const existing = state.resources.find(
      (item) =>
        item.projectId === input.projectId &&
        item.provider === input.provider &&
        item.kind === input.kind &&
        item.externalId === externalId,
    );

    if (existing) {
      return existing;
    }

    const resource = {
      id: id("resource"),
      ...input,
      externalId,
      iconUrl: input.iconUrl ?? null,
      connectionId: input.connectionId ?? null,
    };
    state.resources.push(resource);
    writeState(state);
    return resource;
  },

  disconnectResource({ id: resourceId }) {
    const state = readState();
    state.resources = state.resources.filter((item) => item.id !== resourceId);
    writeState(state);
  },

  listLocalResources({ projectId, repoUrl }) {
    const normalizedRepoUrl = normalizeRepoUrl(repoUrl || "");
    return (readState().localResources || []).filter((item) => {
      if (item.projectId !== projectId) return false;
      return !normalizedRepoUrl || normalizeRepoUrl(item.repoUrl) === normalizedRepoUrl;
    });
  },

  saveLocalResource(input) {
    const expectedRepoUrl = input.expectedRepoUrl || input.repoUrl;
    const normalizedRepoUrl = normalizeRepoUrl(expectedRepoUrl || "");
    if (!normalizedRepoUrl) {
      throw new Error("Saving local resource directories requires the desktop app.");
    }
    if (!input.path?.trim()) {
      throw new Error("Local resource path is required.");
    }

    const state = readState();
    state.localResources = state.localResources || [];
    const timestamp = now();
    const path = input.path.trim();
    const existing = state.localResources.find(
      (item) => item.projectId === input.projectId && item.path === path,
    );
    const resource = existing || {
      id: id("local_resource"),
      projectId: input.projectId,
      createdAt: timestamp,
    };
    Object.assign(resource, {
      provider: input.expectedProvider || providerFromRepoUrl(expectedRepoUrl),
      repoUrl: displayRepoUrl(expectedRepoUrl),
      path,
      name: input.name?.trim() || path.split(/[\\/]/).filter(Boolean).at(-1) || displayRepoUrl(expectedRepoUrl),
      updatedAt: timestamp,
    });
    if (!existing) {
      state.localResources.push(resource);
    }
    writeState(state);
    return resource;
  },

  deleteLocalResource({ id: resourceId }) {
    const state = readState();
    state.localResources = (state.localResources || []).filter((item) => item.id !== resourceId);
    writeState(state);
  },

  listDirectories() {
    return [...(readState().directories || [])].sort((left, right) => right.updatedAt - left.updatedAt);
  },

  saveDirectory(input) {
    const path = input.path?.trim();
    if (!path) {
      throw new Error("Directory path is required.");
    }

    const state = readState();
    state.directories = state.directories || [];
    const timestamp = now();
    const existing = state.directories.find((item) => item.path === path);
    const directory = existing || {
      id: id("directory"),
      createdAt: timestamp,
    };

    Object.assign(directory, {
      path,
      name: directoryNameFromPath(path),
      updatedAt: timestamp,
    });

    if (!existing) {
      state.directories.push(directory);
    }

    writeState(state);
    return directory;
  },

  deleteDirectory({ id: directoryId }) {
    const state = readState();
    state.directories = (state.directories || []).filter((item) => item.id !== directoryId);
    writeState(state);
  },

  listRecentDirectoryFiles() {
    return [];
  },

  listSmartInboxProviderItems({ provider }) {
    const state = readState();
    discoverLocalSmartInboxSources(state, provider);
    const disabledSources = new Set((state.smartInboxProviderSources || [])
      .filter((source) => source.provider === provider && source.enabled === false)
      .map((source) => `${source.connectionId}:${source.sourceId}`));
    const taskKind = {
      github: "pull_request",
      gitlab: "merge_request",
      trello: "trello_card",
    }[provider];
    return {
      items: (state.smartInboxProviderItems || [])
        .filter((item) => (
          item.provider === provider &&
          !disabledSources.has(`${item.connectionId}:${item.sourceId}`)
        ))
        .map((item) => ({
          ...item,
          linkedTask: latestProjectTaskForProviderItem(state, item, taskKind),
        })),
      warnings: [],
      syncRuns: [],
    };
  },

  listSmartInboxProviderSources({ provider }) {
    const state = readState();
    discoverLocalSmartInboxSources(state, provider);
    writeState(state);
    return (state.smartInboxProviderSources || [])
      .filter((source) => source.provider === provider)
      .sort((left, right) => (
        left.connectionName.localeCompare(right.connectionName) || left.sourceName.localeCompare(right.sourceName)
      ));
  },

  updateSmartInboxProviderSources({ provider, changes = [] }) {
    const state = readState();
    discoverLocalSmartInboxSources(state, provider);
    for (const change of changes) {
      const source = state.smartInboxProviderSources.find((item) => (
        item.provider === provider &&
        item.connectionId === change.connectionId &&
        item.sourceId === change.sourceId
      ));
      if (!source) throw new Error("Smart inbox source not found.");
      source.enabled = change.enabled === true;
      source.updatedAt = now();
      if (!source.enabled) {
        state.smartInboxProviderItems = (state.smartInboxProviderItems || []).filter((item) => !(
          item.provider === provider &&
          item.connectionId === change.connectionId &&
          item.sourceId === change.sourceId
        ));
      }
    }
    writeState(state);
    return local.listSmartInboxProviderSources({ provider });
  },

  listSmartInboxTodos() {
    const state = readState();
    state.smartInboxTodos = (state.smartInboxTodos || []).map(normalizeSmartInboxTodo);
    writeState(state);
    return [...state.smartInboxTodos].sort((left, right) => (
      right.updatedAt - left.updatedAt || right.createdAt - left.createdAt
    ));
  },

  createSmartInboxTodo(input) {
    const state = readState();
    state.smartInboxTodos = (state.smartInboxTodos || []).map(normalizeSmartInboxTodo);
    const timestamp = now();
    const filePath = smartInboxTodoFilePath(input);
    const existing = filePath
      ? state.smartInboxTodos.find((todo) => todo.kind === "file" && todo.filePath?.trim() === filePath)
      : null;

    if (existing) {
      existing.title = smartInboxTodoTitle(input);
      existing.fileName = input?.fileName ?? existing.fileName ?? null;
      existing.mimeType = input?.mimeType ?? existing.mimeType ?? null;
      existing.updatedAt = timestamp;
      const todo = normalizeSmartInboxTodo(existing);
      Object.assign(existing, todo);
      writeState(state);
      return todo;
    }

    const todo = normalizeSmartInboxTodo({
      id: id("smart_inbox_todo"),
      kind: input?.kind,
      title: smartInboxTodoTitle(input),
      rawText: input?.rawText ?? null,
      filePath: filePath || (input?.filePath ?? null),
      fileName: input?.fileName ?? null,
      mimeType: input?.mimeType ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    state.smartInboxTodos.push(todo);
    writeState(state);
    return todo;
  },

  updateSmartInboxTodo(input) {
    const state = readState();
    state.smartInboxTodos = (state.smartInboxTodos || []).map(normalizeSmartInboxTodo);
    const todo = state.smartInboxTodos.find((item) => item.id === input?.id);
    if (!todo) {
      throw new Error("Smart inbox todo not found.");
    }

    if (todo.kind === "text") {
      if (Object.prototype.hasOwnProperty.call(input || {}, "title")) {
        throw new Error("Text todos can only update rawText.");
      }
      if (typeof input?.rawText !== "string" || !input.rawText.trim()) {
        throw new Error("Todo content cannot be blank.");
      }
      todo.rawText = input.rawText;
      todo.title = firstLine(input.rawText);
    } else {
      if (Object.prototype.hasOwnProperty.call(input || {}, "rawText")) {
        throw new Error("File todos can only update title.");
      }
      if (typeof input?.title !== "string" || !input.title.trim()) {
        throw new Error("Todo title cannot be blank.");
      }
      todo.title = input.title.trim();
    }

    todo.updatedAt = now();
    const updated = normalizeSmartInboxTodo(todo);
    Object.assign(todo, updated);
    writeState(state);
    return updated;
  },

  deleteSmartInboxTodo({ id: todoId }) {
    const state = readState();
    state.smartInboxTodos = (state.smartInboxTodos || []).filter((todo) => todo.id !== todoId);
    writeState(state);
  },

  checkoutPullRequestForReview() {
    throw new Error("Review checkout requires the desktop app.");
  },

  loadReviewDiff() {
    throw new Error("Loading review diffs requires the desktop app.");
  },

  loadReviewDiffFile() {
    throw new Error("Loading review diffs requires the desktop app.");
  },

  listReviewCommentDrafts({ taskId }) {
    return (readState().reviewCommentDrafts || [])
      .filter((draft) => draft.taskId === taskId)
      .sort((left, right) => left.createdAt - right.createdAt);
  },

  saveReviewCommentDraft(input) {
    const body = input?.body?.trim() || "";
    if (!body) throw new Error("Review comment cannot be blank.");
    if (!input?.taskId) throw new Error("Task is required.");
    if (!["overall", "inline"].includes(input.kind)) throw new Error("Review draft kind is invalid.");
    if (input.kind === "inline" && (!input.path || !["LEFT", "RIGHT"].includes(input.side))) {
      throw new Error("Inline review draft position is invalid.");
    }

    const state = readState();
    state.reviewCommentDrafts = state.reviewCommentDrafts || [];
    const timestamp = now();
    let draft = state.reviewCommentDrafts.find((item) => item.id === input.id);
    if (!draft && input.kind === "overall") {
      draft = state.reviewCommentDrafts.find((item) => item.taskId === input.taskId && item.kind === "overall");
    }
    if (!draft) {
      draft = { id: id("review_draft"), taskId: input.taskId, createdAt: timestamp };
      state.reviewCommentDrafts.push(draft);
    }
    Object.assign(draft, {
      kind: input.kind,
      body,
      path: input.kind === "inline" ? input.path : null,
      oldPath: input.kind === "inline" ? input.oldPath || input.path : null,
      newPath: input.kind === "inline" ? input.newPath || input.path : null,
      startOldLine: input.kind === "inline" ? input.startOldLine ?? input.oldLine ?? null : null,
      startNewLine: input.kind === "inline" ? input.startNewLine ?? input.newLine ?? null : null,
      startSide: input.kind === "inline" ? input.startSide || input.side : null,
      oldLine: input.kind === "inline" ? input.oldLine ?? null : null,
      newLine: input.kind === "inline" ? input.newLine ?? null : null,
      side: input.kind === "inline" ? input.side : null,
      headSha: input.kind === "inline" ? input.headSha || null : null,
      lastError: null,
      updatedAt: timestamp,
    });
    writeState(state);
    return draft;
  },

  deleteReviewCommentDraft({ id: draftId }) {
    const state = readState();
    state.reviewCommentDrafts = (state.reviewCommentDrafts || []).filter((draft) => draft.id !== draftId);
    writeState(state);
  },

  submitReviewComments() {
    throw new Error("Publishing review comments requires the desktop app.");
  },

  ocrImageFile() {
    throw new Error(OCR_DESKTOP_REQUIRED_MESSAGE);
  },

  readEmailFile() {
    throw new Error(EMAIL_DESKTOP_REQUIRED_MESSAGE);
  },

  createTaskFromInput({ input, parsed: providedParsed, projectId }) {
    const state = readState();
    const parsed = providedParsed || toParsedPayload(parseSmartInput(input));
    const parsedPayload = parsed;

    if (parsed.kind !== "text" && parsed.externalId) {
      const existingLink = state.taskLinks?.find(
        (link) =>
          link.provider === (parsed.provider || "external") &&
          link.kind === parsed.kind &&
          link.externalId === parsed.externalId,
      );
      const existingTask = existingLink && state.tasks.find((task) => task.id === existingLink.taskId);
      if (existingTask) {
        const resource = upsertProjectResource(
          state,
          existingTask.projectId,
          parentResourceFromParsed(parsed),
        );
        if (resource) {
          writeState(state);
        }
        return {
          task: enrichTask(state, existingTask),
          resource,
          parsed: parsedPayload,
          projectRequired: false,
          created: false,
        };
      }
    }

    let resource = null;
    let targetProjectId = projectId ?? null;
    if (parsed.kind === "trello_board" && !targetProjectId) {
      const matches = state.resources.filter(
        (item) =>
          item.provider === "trello" &&
          item.kind === "trello_board" &&
          item.externalId === parsed.externalId,
      );
      if (matches.length === 1) {
        resource = matches[0];
        targetProjectId = resource.projectId;
      }
    }

    if (!targetProjectId) {
      return {
        task: null,
        resource: null,
        parsed: parsedPayload,
        projectRequired: true,
        created: false,
      };
    }

    resource = upsertProjectResource(state, targetProjectId, parentResourceFromParsed(parsed));

    if (parsed.kind === "trello_board") {
      writeState(state);
      return {
        task: null,
        resource,
        parsed: parsedPayload,
        projectRequired: false,
        created: false,
        notice: "Resource connected.",
      };
    }

    const timestamp = now();
    const task = {
      id: id("task"),
      projectId: targetProjectId,
      title: parsed.title,
      body: input.trim(),
      status: "open",
      sourceUrl: parsed.url,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.tasks.push(task);

    if (parsed.externalId) {
      state.taskLinks = state.taskLinks || [];
      const connection = targetProjectId
        ? selectBestConnection(state.connections, state.projectConnections?.[targetProjectId] || [], parsed)
        : null;
      state.taskLinks.push({
        taskId: task.id,
        provider: parsed.provider || "external",
        kind: parsed.kind,
        externalId: parsed.externalId,
        url: parsed.url,
        connectionId: connection?.id || null,
        externalTitle: null,
        externalBody: null,
        externalState: null,
        fetchedAt: null,
        files: [],
        comments: [],
        labels: [],
      });
    }

    resource = resource || upsertProjectResource(state, targetProjectId, parentResourceFromParsed(parsed));
    writeState(state);
    return {
      task: enrichTask(state, task),
      resource,
      parsed: parsedPayload,
      projectRequired: false,
      created: true,
      notice: null,
    };
  },

  listTasks({ projectId }) {
    const state = readState();
    return enrichTasks(state, state.tasks.filter((task) => !projectId || task.projectId === projectId));
  },

  updateTask({ id: taskId, title, body, status, projectId }) {
    const state = readState();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("Task not found");
    task.title = title ?? task.title;
    task.body = body ?? task.body;
    task.status = status ?? task.status;
    task.projectId = projectId ?? task.projectId;
    task.updatedAt = now();
    writeState(state);
    return enrichTask(state, task);
  },

  deleteTask({ id: taskId }) {
    const state = readState();
    if (!state.tasks.some((task) => task.id === taskId)) {
      throw new Error("Task not found");
    }
    state.tasks = state.tasks.filter((task) => task.id !== taskId);
    state.taskLinks = (state.taskLinks || []).filter((link) => link.taskId !== taskId);
    state.taskRelations = (state.taskRelations || []).filter(
      (relation) => relation.sourceTaskId !== taskId && relation.targetTaskId !== taskId,
    );
    state.reviewCommentDrafts = (state.reviewCommentDrafts || []).filter(
      (draft) => draft.taskId !== taskId,
    );
    writeState(state);
  },

  listTaskTrelloBoards({ taskId }) {
    const state = readState();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("Task not found.");
    if (!task.projectId) return [];
    return state.resources
      .filter((resource) => (
        resource.projectId === task.projectId &&
        resource.provider === "trello" &&
        resource.kind === "trello_board"
      ))
      .sort((left, right) => left.name.localeCompare(right.name));
  },

  listTrelloBoardTemplates() {
    throw new Error("Loading Trello templates requires the desktop app.");
  },

  convertTaskToTrelloTicket() {
    throw new Error("Creating Trello tickets requires the desktop app.");
  },

  linkTaskResource(payload) {
    const state = readState();
    state.taskLinks = state.taskLinks || [];
    const normalizedPayload = normalizeTaskLink(payload);
    const existingIndex = state.taskLinks.findIndex((item) => item.taskId === payload.taskId);
    if (existingIndex >= 0) {
      state.taskLinks[existingIndex] = normalizeTaskLink({
        ...state.taskLinks[existingIndex],
        ...normalizedPayload,
      });
    } else {
      state.taskLinks.push(normalizedPayload);
    }
    const task = state.tasks.find((item) => item.id === payload.taskId);
    if (task) {
      task.sourceUrl = payload.url;
      task.updatedAt = now();
    }
    writeState(state);
  },

  listTaskLinks({ taskId }) {
    return (readState().taskLinks || [])
      .filter((item) => item.taskId === taskId)
      .slice(0, 1)
      .map(normalizeTaskLink);
  },

  refreshTaskExternalDetails({ taskId }) {
    const state = readState();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("Task not found");
    const links = (state.taskLinks || [])
      .filter((item) => item.taskId === taskId)
      .slice(0, 1)
      .map(normalizeTaskLink);
    const link = links[0];

    if (!supportsExternalRefresh(link)) {
      return {
        task: enrichTask(state, task),
        links,
        notice: null,
        connectionRequired: false,
      };
    }

    const enabledConnectionIds = new Set(state.projectConnections?.[task.projectId] || []);
    const hasProjectConnection = state.connections.some(
      (connection) => enabledConnectionIds.has(connection.id) && connection.provider === link.provider,
    );

    if (!hasProjectConnection) {
      return {
        task: enrichTask(state, task),
        links,
        notice: providerConnectionRequiredNotice(link.provider),
        connectionRequired: true,
      };
    }

    return {
      task: enrichTask(state, task),
      links,
      notice: "Live external refresh requires the desktop app.",
      connectionRequired: false,
    };
  },

  listTaskRelations({ taskId }) {
    const state = readState();
    return (state.taskRelations || [])
      .filter((relation) => relation.sourceTaskId === taskId || relation.targetTaskId === taskId)
      .map((relation) => {
        const relatedTaskId = relation.sourceTaskId === taskId ? relation.targetTaskId : relation.sourceTaskId;
        const relatedTask = state.tasks.find((task) => task.id === relatedTaskId);
        return {
          ...relation,
          relatedTask: relatedTask ? enrichTask(state, relatedTask) : null,
        };
      })
      .filter((relation) => relation.relatedTask);
  },

  saveTaskRelation({ id: relationId, sourceTaskId, targetTaskId, relationType }) {
    if (sourceTaskId === targetTaskId) {
      throw new Error("A task cannot be related to itself");
    }
    if (!["related", "sub_task"].includes(relationType)) {
      throw new Error("Unsupported task relation type");
    }
    const state = readState();
    if (!state.tasks.some((task) => task.id === sourceTaskId)) throw new Error("Source task not found");
    if (!state.tasks.some((task) => task.id === targetTaskId)) throw new Error("Target task not found");
    state.taskRelations = state.taskRelations || [];

    if (relationId) {
      const existing = state.taskRelations.find((item) => item.id === relationId);
      if (!existing) throw new Error("Task relation not found");
      const duplicate = state.taskRelations.find(
        (item) =>
          item.id !== relationId &&
          item.sourceTaskId === sourceTaskId &&
          item.targetTaskId === targetTaskId &&
          item.relationType === relationType,
      );
      if (duplicate) {
        state.taskRelations = state.taskRelations.filter((item) => item.id !== relationId);
        writeState(state);
        return {
          ...duplicate,
          relatedTask: state.tasks.find((task) => task.id === duplicate.targetTaskId),
        };
      }

      Object.assign(existing, {
        sourceTaskId,
        targetTaskId,
        relationType,
      });
      writeState(state);
      return {
        ...existing,
        relatedTask: state.tasks.find((task) => task.id === targetTaskId),
      };
    }

    let relation = state.taskRelations.find(
      (item) =>
        item.sourceTaskId === sourceTaskId &&
        item.targetTaskId === targetTaskId &&
        item.relationType === relationType,
    );
    if (!relation) {
      relation = {
        id: id("relation"),
        sourceTaskId,
        targetTaskId,
        relationType,
        createdAt: now(),
      };
      state.taskRelations.push(relation);
      writeState(state);
    }
    const relatedTask = state.tasks.find((task) => task.id === targetTaskId);
    return { ...relation, relatedTask };
  },

  deleteTaskRelation({ id: relationId }) {
    const state = readState();
    state.taskRelations = (state.taskRelations || []).filter((relation) => relation.id !== relationId);
    writeState(state);
  },

  listConnections() {
    return readState().connections;
  },

  saveConnection(input) {
    const state = readState();
    const timestamp = now();
    let connection = state.connections.find((item) => item.id === input.id);
    if (!connection) {
      connection = {
        id: id("connection"),
        createdAt: timestamp,
      };
      state.connections.push(connection);
    }

    Object.assign(connection, input, {
      id: connection.id,
      updatedAt: timestamp,
    });
    writeState(state);
    return connection;
  },

  deleteConnection({ id: connectionId }) {
    const state = readState();
    state.connections = state.connections.filter((item) => item.id !== connectionId);
    state.projectConnections = Object.fromEntries(
      Object.entries(state.projectConnections || {}).map(([projectId, connectionIds]) => [
        projectId,
        connectionIds.filter((id) => id !== connectionId),
      ]),
    );
    state.resources = state.resources.map((resource) =>
      resource.connectionId === connectionId ? { ...resource, connectionId: null } : resource,
    );
    state.smartInboxProviderItems = (state.smartInboxProviderItems || [])
      .filter((item) => item.connectionId !== connectionId);
    state.smartInboxProviderSources = (state.smartInboxProviderSources || [])
      .filter((source) => source.connectionId !== connectionId);
    writeState(state);
  },

  listAiPrompts() {
    return [...(readState().aiPrompts || [])].sort((left, right) => (
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) || left.id.localeCompare(right.id)
    ));
  },

  saveAiPrompt(input) {
    const state = readState();
    state.aiPrompts = state.aiPrompts || [];
    const validationMessage = validateAiPromptForTest(input, state.aiPrompts);
    if (validationMessage) throw new Error(validationMessage);

    const timestamp = now();
    let prompt = state.aiPrompts.find((item) => item.id === input.id);
    if (!prompt) {
      prompt = {
        id: id("ai_prompt"),
        createdAt: timestamp,
      };
      state.aiPrompts.push(prompt);
    }

    Object.assign(prompt, {
      agentType: input.agentType.trim(),
      name: input.name.trim(),
      icon: input.icon,
      mode: input.mode,
      promptText: input.promptText?.trim() || "",
      updatedAt: timestamp,
    });
    writeState(state);
    return prompt;
  },

  deleteAiPrompt({ id: promptId }) {
    const state = readState();
    state.aiPrompts = (state.aiPrompts || []).filter((prompt) => prompt.id !== promptId);
    writeState(state);
  },

  testConnection({ id: connectionId }) {
    const connection = readState().connections.find((item) => item.id === connectionId);
    if (!connection) throw new Error("Connection not found");
    const validationMessage = validateConnectionForTest(connection);
    if (validationMessage) {
      return {
        ok: false,
        message: validationMessage,
        accountName: null,
      };
    }
    return {
      ok: false,
      message: "Live connection testing requires the desktop app.",
      accountName: null,
    };
  },

  listProjectConnections({ projectId }) {
    return readState().projectConnections?.[projectId] || [];
  },

  setProjectConnections({ projectId, connectionIds }) {
    const state = readState();
    state.projectConnections = state.projectConnections || {};
    state.projectConnections[projectId] = connectionIds;
    writeState(state);
    return connectionIds;
  },

  listActivities(payload) {
    return localActivityResult(readState(), payload);
  },

  syncActivities(payload) {
    const state = readState();
    const timestamp = now();
    state.activitySyncRuns = state.activitySyncRuns || [];
    const nextRuns = (state.connections || []).map((connection) => ({
      connectionId: connection.id,
      connectionName: connection.name,
      provider: connection.provider,
      date: payload.date,
      status: "failed",
      warning: "Remote activity sync requires the desktop app.",
      syncedAt: timestamp,
    }));
    state.activitySyncRuns = [
      ...(state.activitySyncRuns || []).filter((run) => run.date !== payload.date),
      ...nextRuns,
    ];
    writeState(state);
    return localActivityResult(state, payload);
  },

  resolveTrelloTickets({ urls = [] } = {}) {
    return {
      tickets: [],
      warnings: urls.length > 0
        ? ["Loading linked Trello ticket details requires the desktop app."]
        : [],
    };
  },

  listCalendarAccounts() {
    return readState().calendarAccounts || [];
  },

  updateCalendarService({ accountId, enabled }) {
    const state = readState();
    const account = (state.calendarAccounts || []).find((item) => item.id === accountId);
    if (!account) throw new Error("Calendar account not found.");
    if (account.provider !== "google") throw new Error("Only Google accounts have optional Calendar access.");
    account.calendarEnabled = enabled;
    account.updatedAt = now();
    writeState(state);
    return account;
  },

  saveCalDavAccount(input) {
    const state = readState();
    const timestamp = now();
    let account = (state.calendarAccounts || []).find((item) => item.id === input.id);
    if (!account) {
      account = { id: id("calendar_account"), provider: "caldav", authType: "basic", calendars: [], createdAt: timestamp };
      state.calendarAccounts = [...(state.calendarAccounts || []), account];
    }
    Object.assign(account, { name: input.name, serverUrl: input.serverUrl, username: input.username, hasCredential: true, updatedAt: timestamp });
    writeState(state);
    return account;
  },

  refreshCalendarCollections({ accountId }) {
    const account = (readState().calendarAccounts || []).find((item) => item.id === accountId);
    if (!account) throw new Error("Calendar account not found.");
    return account;
  },

  updateCalendarCollections({ selections }) {
    const state = readState();
    const byId = new Map(selections.map((selection) => [selection.id, selection]));
    for (const account of state.calendarAccounts || []) {
      account.calendars = (account.calendars || []).map((calendar) => byId.has(calendar.id) ? { ...calendar, ...byId.get(calendar.id), enabled: account.provider === "google" ? byId.get(calendar.id).enabled : true } : calendar);
    }
    writeState(state);
    return state.calendarAccounts || [];
  },

  testCalendarAccount({ accountId }) {
    const account = (readState().calendarAccounts || []).find((item) => item.id === accountId);
    if (!account) throw new Error("Calendar account not found.");
    return `Connected. Found ${(account.calendars || []).length} calendars.`;
  },

  deleteCalendarAccount({ accountId }) {
    const state = readState();
    const collectionIds = new Set((state.calendarAccounts || []).find((item) => item.id === accountId)?.calendars?.map((item) => item.id) || []);
    state.calendarAccounts = (state.calendarAccounts || []).filter((item) => item.id !== accountId);
    state.calendarEvents = (state.calendarEvents || []).filter((event) => !collectionIds.has(event.collectionId));
    writeState(state);
  },

  listCalendarEvents(payload) {
    return localCalendarResult(readState(), payload);
  },

  syncCalendarEvents(payload) {
    return localCalendarResult(readState(), payload);
  },
};
