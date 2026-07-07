import { invoke } from "@tauri-apps/api/core";
import { parseSmartInput } from "./smartInputParser";

const STORAGE_KEY = "dev-crash-flash-ai-studio-state";

const defaultState = {
  projects: [],
  connections: [],
  resources: [],
  tasks: [],
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
  createTaskFromInput: (payload) =>
    call("create_task_from_input", payload, () => local.createTaskFromInput(payload)),
  listTasks: (payload) => call("list_tasks", payload, () => local.listTasks(payload)),
  updateTask: (payload) => call("update_task", payload, () => local.updateTask(payload)),
  linkTaskResource: (payload) => call("link_task_resource", payload, () => local.linkTaskResource(payload)),
  listTaskLinks: (payload) => call("list_task_links", payload, () => local.listTaskLinks(payload)),
  listConnections: () => call("list_connections", {}, local.listConnections),
  saveConnection: (payload) => call("save_connection", { input: payload }, () => local.saveConnection(payload)),
  deleteConnection: (payload) => call("delete_connection", payload, () => local.deleteConnection(payload)),
  listPullRequests: (payload) => call("list_pull_requests", payload, () => local.listPullRequests(payload)),
  savePullRequest: (payload) => call("save_pull_request", { input: payload }, () => local.savePullRequest(payload)),
  updatePullRequestReviewState: (payload) =>
    call("update_pull_request_review_state", payload, () => local.updatePullRequestReviewState(payload)),
};

async function call(command, payload, fallback) {
  if (window.__TAURI_INTERNALS__) {
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

const local = {
  listProjects() {
    return readState().projects;
  },

  createProject({ name, icon }) {
    const state = readState();
    const timestamp = now();
    const project = {
      id: id("project"),
      name: name?.trim() || "Untitled project",
      icon: normalizeIcon(icon),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.projects.push(project);
    writeState(state);
    return project;
  },

  updateProject({ id: projectId, name, icon }) {
    const state = readState();
    const project = state.projects.find((item) => item.id === projectId);
    if (!project) throw new Error("Project not found");
    project.name = name ?? project.name;
    project.icon = icon ?? project.icon;
    project.updatedAt = now();
    writeState(state);
    return project;
  },

  deleteProject({ id: projectId }) {
    const state = readState();
    state.projects = state.projects.filter((item) => item.id !== projectId);
    state.resources = state.resources.filter((item) => item.projectId !== projectId);
    state.tasks = state.tasks.filter((item) => item.projectId !== projectId);
    state.pullRequests = state.pullRequests.filter((item) => item.projectId !== projectId);
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

  createTaskFromInput({ input, projectId }) {
    const state = readState();
    const parsed = parseSmartInput(input);
    const parsedPayload = {
      kind: parsed.kind,
      provider: parsed.provider,
      externalId: parsed.externalId,
      url: parsed.url,
      title: parsed.title,
    };

    if (parsed.kind !== "text" && parsed.provider && parsed.externalId) {
      const existingLink = state.taskLinks?.find(
        (link) =>
          link.provider === parsed.provider &&
          link.kind === parsed.kind &&
          link.externalId === parsed.externalId,
      );
      const existingTask = existingLink && state.tasks.find((task) => task.id === existingLink.taskId);
      if (existingTask) {
        return {
          task: existingTask,
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

    if (parsed.provider && parsed.externalId) {
      state.taskLinks = state.taskLinks || [];
      state.taskLinks.push({
        taskId: task.id,
        provider: parsed.provider,
        kind: parsed.kind,
        externalId: parsed.externalId,
        url: parsed.url,
      });
    }

    writeState(state);
    return {
      task,
      resource,
      parsed: parsedPayload,
      projectRequired: false,
      created: true,
    };
  },

  listTasks({ projectId }) {
    return readState().tasks.filter((task) => !projectId || task.projectId === projectId);
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
    return task;
  },

  linkTaskResource(payload) {
    const state = readState();
    state.taskLinks = state.taskLinks || [];
    if (
      !state.taskLinks.some(
        (item) =>
          item.taskId === payload.taskId &&
          item.provider === payload.provider &&
          item.kind === payload.kind &&
          item.externalId === payload.externalId,
      )
    ) {
      state.taskLinks.push(payload);
      writeState(state);
    }
  },

  listTaskLinks({ taskId }) {
    return (readState().taskLinks || []).filter((item) => item.taskId === taskId);
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
    writeState(state);
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

    Object.assign(pullRequest, input, {
      id: pullRequest.id,
      updatedAt: timestamp,
    });
    writeState(state);
    return pullRequest;
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
