import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { normalizeProjectColor } from "./projectAvatar.js";
import { parseSmartInput } from "./smartInputParser.js";

const STORAGE_KEY = "dev-crash-flash-ai-studio-state";

const defaultState = {
  projects: [],
  connections: [],
  projectConnections: {},
  resources: [],
  localResources: [],
  tasks: [],
  taskLinks: [],
  taskRelations: [],
  pullRequests: [],
};

export const api = {
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
  createTaskFromInput: (payload) =>
    call("create_task_from_input", payload, () => local.createTaskFromInput(payload)),
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
};

async function call(command, payload, fallback) {
  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    return invoke(command, payload);
  }

  return fallback();
}

function readState() {
  try {
    return { ...defaultState, ...JSON.parse(localStorage.getItem(STORAGE_KEY)) };
  } catch {
    return { ...defaultState };
  }
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

const local = {
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
        item.provider === input.provider && item.kind === input.kind && item.externalId === externalId,
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

  checkoutPullRequestForReview() {
    throw new Error("Review checkout requires the desktop app.");
  },

  loadReviewDiff() {
    throw new Error("Loading review diffs requires the desktop app.");
  },

  loadReviewDiffFile() {
    throw new Error("Loading review diffs requires the desktop app.");
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
        return {
          task: enrichTask(state, existingTask),
          resource: null,
          parsed: parsedPayload,
          projectRequired: false,
          created: false,
        };
      }
    }

    let resource = null;
    let targetProjectId = projectId ?? null;
    if (parsed.kind === "trello_board") {
      resource = state.resources.find(
        (item) =>
          item.provider === "trello" &&
          item.kind === "trello_board" &&
          item.externalId === parsed.externalId,
      );
      targetProjectId = resource?.projectId ?? targetProjectId;
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

    if (parsed.kind === "trello_board" && !resource) {
      resource = {
        id: id("resource"),
        projectId: targetProjectId,
        provider: "trello",
        kind: "trello_board",
        externalId: parsed.externalId,
        url: parsed.url,
        name: parsed.title,
        iconUrl: null,
        connectionId: null,
      };
      state.resources.push(resource);
    }

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
      });
    }

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
    const existingIndex = state.taskLinks.findIndex((item) => item.taskId === payload.taskId);
    if (existingIndex >= 0) {
      state.taskLinks[existingIndex] = {
        ...state.taskLinks[existingIndex],
        ...payload,
      };
    } else {
      state.taskLinks.push(payload);
    }
    const task = state.tasks.find((item) => item.id === payload.taskId);
    if (task) {
      task.sourceUrl = payload.url;
      task.updatedAt = now();
    }
    writeState(state);
  },

  listTaskLinks({ taskId }) {
    return (readState().taskLinks || []).filter((item) => item.taskId === taskId).slice(0, 1);
  },

  refreshTaskExternalDetails({ taskId }) {
    const state = readState();
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) throw new Error("Task not found");
    const links = (state.taskLinks || []).filter((item) => item.taskId === taskId).slice(0, 1);
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
};
