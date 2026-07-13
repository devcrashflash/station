import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { formatLocalDate, localDayBounds, sortActivities } from "./activity.js";
import { EMAIL_DESKTOP_REQUIRED_MESSAGE, OCR_DESKTOP_REQUIRED_MESSAGE } from "./ocr.js";
import { normalizeProjectColor } from "./projectAvatar.js";
import { parseSmartInput } from "./smartInputParser.js";

const STORAGE_KEY = "dev-crash-flash-ai-studio-state";

const defaultState = {
  projects: [],
  connections: [],
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
  activities: [],
  activitySyncRuns: [],
  browserSettings: {
    detectedBrowserBundleId: null,
    browserBundleId: null,
  },
};

export const api = {
  openBlankBrowserTab: () => call("open_blank_browser_tab", {}, () => null),
  listBrowserSettings: () => call("list_browser_settings", {}, local.listBrowserSettings),
  saveBrowserSettings: (payload) =>
    call("save_browser_settings", { input: payload }, () => local.saveBrowserSettings(payload)),
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
  listProjectConnections: (payload) =>
    call("list_project_connections", payload, () => local.listProjectConnections(payload)),
  setProjectConnections: (payload) =>
    call("set_project_connections", payload, () => local.setProjectConnections(payload)),
  listPullRequests: (payload) => call("list_pull_requests", payload, () => local.listPullRequests(payload)),
  savePullRequest: (payload) => call("save_pull_request", { input: payload }, () => local.savePullRequest(payload)),
  updatePullRequestReviewState: (payload) =>
    call("update_pull_request_review_state", payload, () => local.updatePullRequestReviewState(payload)),
  listActivities: (payload) => {
    const input = activityRequestPayload(payload);
    return call("list_activities", input, () => local.listActivities(input));
  },
  syncActivities: (payload) => {
    const input = activityRequestPayload(payload);
    return call("sync_activities", input, () => local.syncActivities(input));
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
    return { ...freshDefaultState(), ...JSON.parse(localStorage.getItem(STORAGE_KEY)) };
  } catch {
    return freshDefaultState();
  }
}

function freshDefaultState() {
  return {
    ...defaultState,
    projects: [],
    connections: [],
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
    activities: [],
    activitySyncRuns: [],
    browserSettings: { ...defaultState.browserSettings },
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

function normalizeTaskLink(link) {
  return {
    ...link,
    files: normalizeTaskFiles(link?.files),
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

const local = {
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
    const linkedTrelloCardIds = new Set(
      (state.taskLinks || [])
        .filter((link) => link.provider === "trello" && link.kind === "trello_card")
        .map((link) => link.externalId),
    );
    return {
      items: (state.smartInboxProviderItems || []).filter((item) => (
        item.provider === provider &&
        !disabledSources.has(`${item.connectionId}:${item.sourceId}`) &&
        (provider !== "trello" || !linkedTrelloCardIds.has(item.externalId))
      )),
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
    writeState(state);
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

  listPullRequests({ projectId }) {
    return readState().pullRequests.filter((item) => item.projectId === projectId);
  },

  savePullRequest(input) {
    const state = readState();
    const timestamp = now();
    let pullRequest = state.pullRequests.find(
      (item) => item.id === input.id || item.prUrl === input.prUrl,
    );

    if (!pullRequest) {
      pullRequest = {
        id: id("pr"),
        createdAt: timestamp,
      };
      state.pullRequests.push(pullRequest);
    }

    const connection = selectBestConnection(
      state.connections,
      state.projectConnections?.[input.projectId] || [],
      input.parsed || {},
    );

    Object.assign(pullRequest, input, {
      id: pullRequest.id,
      connectionId: connection?.id || input.connectionId || null,
      updatedAt: timestamp,
    });
    writeState(state);
    return { pullRequest, notice: connection ? null : "No enabled connection matched this external link." };
  },

  updatePullRequestReviewState({ id: pullRequestId, status, reviewNotes, testState }) {
    const state = readState();
    const pullRequest = state.pullRequests.find((item) => item.id === pullRequestId);
    if (!pullRequest) throw new Error("Pull request not found");
    pullRequest.status = status ?? pullRequest.status;
    pullRequest.reviewNotes = reviewNotes ?? pullRequest.reviewNotes;
    pullRequest.testState = testState ?? pullRequest.testState;
    pullRequest.updatedAt = now();
    writeState(state);
    return pullRequest;
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
};
