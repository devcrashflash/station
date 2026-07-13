import test from "node:test";
import assert from "node:assert/strict";

import {
  api,
  isPullRequestResource,
  normalizeBaseUrl,
  normalizeRepoUrl,
  repoUrlFromPullRequestUrl,
  selectBestConnection,
  validateConnectionForTest,
} from "./api.js";
import {
  DEFAULT_PROJECT_COLOR,
  getProjectInitial,
  normalizeProjectColor,
} from "./projectAvatar.js";
import { parseSmartInput } from "./smartInputParser.js";

const connections = [
  {
    id: "gitlab_com",
    provider: "gitlab",
    name: "GitLab.com",
    baseUrl: "https://gitlab.com",
  },
  {
    id: "gitlab_self",
    provider: "gitlab",
    name: "Self-hosted GitLab",
    baseUrl: "https://gitlab.example.org",
  },
  {
    id: "github",
    provider: "github",
    name: "GitHub",
    baseUrl: "https://github.com",
  },
];

test("selects enabled connection by provider and host", () => {
  const parsed = parseSmartInput("https://gitlab.example.org/acme/app/-/merge_requests/7");

  const connection = selectBestConnection(
    connections,
    ["gitlab_com", "gitlab_self", "github"],
    parsed,
  );

  assert.equal(connection.id, "gitlab_self");
});

test("does not select disabled matching connections", () => {
  const parsed = parseSmartInput("https://gitlab.example.org/acme/app/-/merge_requests/7");

  const connection = selectBestConnection(connections, ["gitlab_com", "github"], parsed);

  assert.equal(connection.id, "gitlab_com");
});

test("does not cross provider boundaries", () => {
  const parsed = parseSmartInput("https://github.com/acme/app/pull/42");

  const connection = selectBestConnection(connections, ["gitlab_com", "gitlab_self"], parsed);

  assert.equal(connection, null);
});

test("validates local connection test requirements", () => {
  assert.equal(
    validateConnectionForTest({ provider: "github", baseUrl: "https://github.com", token: "" }),
    "Token is required.",
  );
  assert.equal(
    validateConnectionForTest({ provider: "trello", token: "token" }),
    "Trello API key is required.",
  );
  assert.equal(validateConnectionForTest({ provider: "trello", apiKey: "key", token: "token" }), "");
  assert.equal(
    validateConnectionForTest({
      provider: "gitlab",
      baseUrl: "https://gitlab.example.org",
      token: "token",
    }),
    "",
  );
});

test("normalizes base urls without a scheme", () => {
  assert.equal(normalizeBaseUrl("gitlab.example.org"), "https://gitlab.example.org");
  assert.equal(normalizeBaseUrl("https://gitlab.example.org/"), "https://gitlab.example.org");
  assert.equal(normalizeBaseUrl("http://gitlab.example.org"), "http://gitlab.example.org");
});

test("normalizes repository urls for local resource matching", () => {
  assert.equal(normalizeRepoUrl("https://github.com/Owner/Repo.git/"), "github.com/owner/repo");
  assert.equal(normalizeRepoUrl("git@github.com:Owner/Repo.git"), "github.com/owner/repo");
  assert.equal(normalizeRepoUrl("ssh://git@gitlab.example.org/group/app.git"), "gitlab.example.org/group/app");
});

test("detects pull request resources and derives repo urls", () => {
  assert.equal(isPullRequestResource({ kind: "pull_request" }), true);
  assert.equal(isPullRequestResource({ kind: "merge_request" }), true);
  assert.equal(isPullRequestResource({ kind: "github_issue" }), false);
  assert.equal(
    repoUrlFromPullRequestUrl("https://github.com/owner/repo/pull/42"),
    "https://github.com/owner/repo",
  );
  assert.equal(
    repoUrlFromPullRequestUrl("https://gitlab.example.org/group/app/-/merge_requests/7"),
    "https://gitlab.example.org/group/app",
  );
});

test("local fallback stores and updates project colors", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const project = await api.createProject({ name: "Access", color: "#16A34A" });
  assert.equal(project.color, "#16a34a");

  const updated = await api.updateProject({ id: project.id, color: "#dc2626" });
  assert.equal(updated.color, "#dc2626");
});

test("local fallback review request feed is transient", async () => {
  let stored = JSON.stringify({
    smartInboxTodos: [{
      id: "smart_inbox_todo_1",
      kind: "text",
      title: "Existing todo",
      rawText: "Existing todo",
      createdAt: 1,
      updatedAt: 1,
    }],
    pullRequests: [{
      id: "pr_1",
      projectId: "project_1",
      provider: "github",
      repoUrl: "https://github.com/acme/app",
      prUrl: "https://github.com/acme/app/pull/1",
      title: "Tracked elsewhere",
    }],
  });
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const result = await api.listSmartInboxProviderItems({ provider: "github" });
  const state = JSON.parse(stored);

  assert.deepEqual(result, { items: [], warnings: [], syncRuns: [] });
  assert.equal(state.smartInboxTodos.length, 1);
  assert.equal(state.pullRequests.length, 1);
});

test("local fallback discovers, disables, and retains smart inbox source settings", async () => {
  let stored = JSON.stringify({
    connections: [{ id: "connection_1", provider: "github", name: "GitHub" }],
    smartInboxProviderItems: [{
      provider: "github",
      connectionId: "connection_1",
      connectionName: "GitHub",
      sourceId: "acme/app",
      sourceName: "acme/app",
      externalId: "acme/app#42",
      title: "Review me",
      url: "https://github.com/acme/app/pull/42",
    }],
  });
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => { stored = value; },
  };

  const discovered = await api.listSmartInboxProviderSources({ provider: "github" });
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].enabled, true);

  await api.updateSmartInboxProviderSources({
    provider: "github",
    changes: [{ connectionId: "connection_1", sourceId: "acme/app", enabled: false }],
  });

  const state = JSON.parse(stored);
  assert.deepEqual(state.smartInboxProviderItems, []);
  assert.equal(state.smartInboxProviderSources[0].enabled, false);
  assert.equal((await api.listSmartInboxProviderSources({ provider: "github" })).length, 1);
  assert.deepEqual((await api.listSmartInboxProviderItems({ provider: "github" })).items, []);
});

test("local fallback keeps matching source names independent across connections", async () => {
  let stored = JSON.stringify({
    connections: [
      { id: "connection_1", provider: "gitlab", name: "GitLab One" },
      { id: "connection_2", provider: "gitlab", name: "GitLab Two" },
    ],
    smartInboxProviderItems: ["connection_1", "connection_2"].map((connectionId, index) => ({
      provider: "gitlab",
      connectionId,
      connectionName: `GitLab ${index + 1}`,
      sourceId: "acme/app",
      sourceName: "acme/app",
      externalId: `acme/app!${index + 1}`,
      title: `Review ${index + 1}`,
      url: `https://gitlab-${index + 1}.example/acme/app/-/merge_requests/${index + 1}`,
    })),
  });
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => { stored = value; },
  };

  assert.equal((await api.listSmartInboxProviderSources({ provider: "gitlab" })).length, 2);
  await api.updateSmartInboxProviderSources({
    provider: "gitlab",
    changes: [{ connectionId: "connection_1", sourceId: "acme/app", enabled: false }],
  });

  const sources = await api.listSmartInboxProviderSources({ provider: "gitlab" });
  assert.equal(sources.find(({ connectionId }) => connectionId === "connection_1").enabled, false);
  assert.equal(sources.find(({ connectionId }) => connectionId === "connection_2").enabled, true);
  assert.equal((await api.listSmartInboxProviderItems({ provider: "gitlab" })).items.length, 1);
});

test("local fallback normalizes legacy project colors", async () => {
  let stored = JSON.stringify({
    projects: [{ id: "project_1", name: "Access", icon: "FolderKanban" }],
  });
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const projects = await api.listProjects();

  assert.equal(projects[0].color, DEFAULT_PROJECT_COLOR);
  assert.equal(JSON.parse(stored).projects[0].color, DEFAULT_PROJECT_COLOR);
});

test("local fallback stores multiple local resources for the same repo and filters by repo", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const project = await api.createProject({ name: "Access" });
  const first = await api.saveLocalResource({
    projectId: project.id,
    path: "/work/access",
    expectedProvider: "github",
    expectedRepoUrl: "https://github.com/owner/repo",
  });
  const second = await api.saveLocalResource({
    projectId: project.id,
    path: "/tmp/access",
    expectedProvider: "github",
    expectedRepoUrl: "git@github.com:owner/repo.git",
  });
  await api.saveLocalResource({
    projectId: project.id,
    path: "/tmp/other",
    expectedProvider: "gitlab",
    expectedRepoUrl: "https://gitlab.example.org/group/app",
  });

  const matches = await api.listLocalResources({
    projectId: project.id,
    repoUrl: "https://github.com/owner/repo.git",
  });

  assert.equal(matches.length, 2);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(new Set(matches.map((item) => item.path)), new Set(["/work/access", "/tmp/access"]));
});

test("local fallback stores directories with derived names", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const directory = await api.saveDirectory({ path: "/work/customer-portal" });

  assert.match(directory.id, /^directory_/);
  assert.equal(directory.path, "/work/customer-portal");
  assert.equal(directory.name, "customer-portal");
  assert.equal(typeof directory.createdAt, "number");
  assert.equal(typeof directory.updatedAt, "number");
});

test("local fallback updates duplicate directories instead of duplicating them", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const first = await api.saveDirectory({ path: "/work/customer-portal" });
  const second = await api.saveDirectory({ path: "/work/customer-portal" });
  const directories = await api.listDirectories();

  assert.equal(first.id, second.id);
  assert.equal(directories.length, 1);
  assert.equal(directories[0].path, "/work/customer-portal");
});

test("local fallback deletes selected directories", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const first = await api.saveDirectory({ path: "/work/customer-portal" });
  const second = await api.saveDirectory({ path: "/work/design-system" });

  await api.deleteDirectory({ id: first.id });

  const directories = await api.listDirectories();
  assert.deepEqual(directories.map((directory) => directory.id), [second.id]);
});

test("local fallback cannot inspect recent configured directory files", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  await api.saveDirectory({ path: "/work/customer-portal" });

  assert.deepEqual(await api.listRecentDirectoryFiles(), []);
});

test("local fallback stores text smart inbox todos without creating tasks", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const todo = await api.createSmartInboxTodo({
    kind: "text",
    rawText: "Review onboarding",
  });

  assert.match(todo.id, /^smart_inbox_todo_/);
  assert.equal(todo.title, "Review onboarding");
  assert.equal(todo.rawText, "Review onboarding");
  assert.deepEqual(await api.listTasks({ projectId: null }), []);
});

test("local fallback stores link smart inbox todos without creating resources", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  await api.createSmartInboxTodo({
    kind: "text",
    title: "Trello card",
    rawText: "https://trello.com/c/card123/review-auth",
  });

  const state = JSON.parse(stored);
  assert.equal(state.smartInboxTodos.length, 1);
  assert.deepEqual(state.tasks || [], []);
  assert.deepEqual(state.resources || [], []);
});

test("local fallback stores file smart inbox todos without reading file content", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const todo = await api.createSmartInboxTodo({
    kind: "file",
    filePath: "/tmp/archive.zip",
    fileName: "archive.zip",
    mimeType: "application/zip",
  });

  assert.equal(todo.kind, "file");
  assert.equal(todo.title, "archive.zip");
  assert.equal(todo.filePath, "/tmp/archive.zip");
  assert.equal(todo.mimeType, "application/zip");
  assert.equal(todo.fileMissing, false);
  assert.deepEqual(await api.listTasks({ projectId: null }), []);
});

test("local fallback reuses duplicate file smart inbox todos by path", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };
  const originalNow = Date.now;
  let timestamp = 1000;
  Date.now = () => timestamp++;
  try {
    const first = await api.createSmartInboxTodo({
      kind: "file",
      filePath: "/tmp/archive.zip",
      fileName: "archive.zip",
      mimeType: "application/zip",
    });
    const duplicate = await api.createSmartInboxTodo({
      kind: "file",
      filePath: "  /tmp/archive.zip  ",
      fileName: "archive-latest.zip",
      mimeType: "application/octet-stream",
    });

    const todos = await api.listSmartInboxTodos();
    assert.equal(duplicate.id, first.id);
    assert.equal(todos.length, 1);
    assert.equal(todos[0].fileName, "archive-latest.zip");
    assert.equal(todos[0].filePath, "/tmp/archive.zip");
    assert.ok(todos[0].updatedAt > first.updatedAt);
  } finally {
    Date.now = originalNow;
  }
});

test("local fallback duplicate file todo moves to top", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };
  const originalNow = Date.now;
  let timestamp = 2000;
  Date.now = () => timestamp++;
  try {
    const first = await api.createSmartInboxTodo({
      kind: "file",
      filePath: "/tmp/first.txt",
      fileName: "first.txt",
      mimeType: "text/plain",
    });
    const second = await api.createSmartInboxTodo({
      kind: "file",
      filePath: "/tmp/second.txt",
      fileName: "second.txt",
      mimeType: "text/plain",
    });

    await api.createSmartInboxTodo({
      kind: "file",
      filePath: "/tmp/first.txt",
      fileName: "first.txt",
      mimeType: "text/plain",
    });

    const todos = await api.listSmartInboxTodos();
    assert.equal(todos.length, 2);
    assert.equal(todos[0].id, first.id);
    assert.equal(todos[1].id, second.id);
  } finally {
    Date.now = originalNow;
  }
});

test("local fallback allows repeated text smart inbox todos", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const first = await api.createSmartInboxTodo({
    kind: "text",
    rawText: "Review onboarding",
  });
  const second = await api.createSmartInboxTodo({
    kind: "text",
    rawText: "Review onboarding",
  });

  const todos = await api.listSmartInboxTodos();
  assert.equal(todos.length, 2);
  assert.notEqual(first.id, second.id);
});

test("local fallback updates smart inbox todos without creating tasks", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };
  const originalNow = Date.now;
  let timestamp = 3000;
  Date.now = () => timestamp++;
  try {
    const textTodo = await api.createSmartInboxTodo({
      kind: "text",
      rawText: "Original todo",
    });
    const fileTodo = await api.createSmartInboxTodo({
      kind: "file",
      filePath: "/tmp/archive.zip",
      fileName: "archive.zip",
      mimeType: "application/zip",
    });

    const updatedText = await api.updateSmartInboxTodo({
      id: textTodo.id,
      rawText: "\n  Updated todo\nKeep these details",
    });
    const updatedFile = await api.updateSmartInboxTodo({
      id: fileTodo.id,
      title: "  Release archive\nKeep for deployment  ",
    });

    assert.equal(updatedText.title, "Updated todo");
    assert.equal(updatedText.rawText, "\n  Updated todo\nKeep these details");
    assert.equal(updatedText.createdAt, textTodo.createdAt);
    assert.ok(updatedText.updatedAt > textTodo.updatedAt);
    assert.equal(updatedFile.title, "Release archive\nKeep for deployment");
    assert.equal(updatedFile.filePath, fileTodo.filePath);
    assert.equal(updatedFile.fileName, fileTodo.fileName);
    assert.equal(updatedFile.mimeType, fileTodo.mimeType);
    assert.equal(updatedFile.createdAt, fileTodo.createdAt);
    assert.equal((await api.listSmartInboxTodos())[0].id, fileTodo.id);
    assert.deepEqual(await api.listTasks({ projectId: null }), []);
  } finally {
    Date.now = originalNow;
  }
});

test("local fallback validates kind-specific smart inbox todo updates", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const textTodo = await api.createSmartInboxTodo({ kind: "text", rawText: "Text todo" });
  const fileTodo = await api.createSmartInboxTodo({
    kind: "file",
    filePath: "/tmp/file.txt",
    fileName: "file.txt",
  });

  await assert.rejects(
    api.updateSmartInboxTodo({ id: textTodo.id, rawText: "   " }),
    /content cannot be blank/i,
  );
  await assert.rejects(
    api.updateSmartInboxTodo({ id: textTodo.id, title: "Wrong field" }),
    /only update rawText/i,
  );
  await assert.rejects(
    api.updateSmartInboxTodo({ id: fileTodo.id, title: "" }),
    /title cannot be blank/i,
  );
  await assert.rejects(
    api.updateSmartInboxTodo({ id: fileTodo.id, rawText: "Wrong field" }),
    /only update title/i,
  );
  await assert.rejects(
    api.updateSmartInboxTodo({ id: "missing", rawText: "Missing" }),
    /not found/i,
  );
});

test("local fallback deletes smart inbox todos without touching tasks", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const project = await api.createProject({ name: "Access" });
  await api.createTaskFromInput({
    input: "Existing task",
    parsed: {
      kind: "text",
      provider: null,
      externalId: null,
      url: null,
      title: "Existing task",
      repoUrl: null,
    },
    projectId: project.id,
  });
  const todo = await api.createSmartInboxTodo({
    kind: "text",
    rawText: "Later",
  });

  await api.deleteSmartInboxTodo({ id: todo.id });

  assert.deepEqual(await api.listSmartInboxTodos(), []);
  assert.equal((await api.listTasks({ projectId: project.id })).length, 1);
});

test("local fallback promotion sequence can create a task then remove the todo", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const project = await api.createProject({ name: "Access" });
  const todo = await api.createSmartInboxTodo({
    kind: "text",
    rawText: "Review onboarding",
  });
  const result = await api.createTaskFromInput({
    input: todo.rawText,
    parsed: {
      kind: "text",
      provider: null,
      externalId: null,
      url: null,
      title: todo.title,
      repoUrl: null,
    },
    projectId: project.id,
  });
  await api.deleteSmartInboxTodo({ id: todo.id });

  assert.equal(result.created, true);
  assert.deepEqual(await api.listSmartInboxTodos(), []);
  assert.equal((await api.listTasks({ projectId: project.id })).length, 1);
});

test("normalizes project avatar display values", () => {
  assert.equal(normalizeProjectColor("#7C3AED"), "#7c3aed");
  assert.equal(normalizeProjectColor("invalid"), DEFAULT_PROJECT_COLOR);
  assert.equal(getProjectInitial(" access"), "A");
  assert.equal(getProjectInitial(""), "?");
});

test("local fallback flags missing project trello connection on refresh", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const project = await api.createProject({ name: "Access" });
  const result = await api.createTaskFromInput({
    input: "Review auth",
    parsed: {
      kind: "text",
      provider: null,
      externalId: null,
      url: null,
      title: "Review auth",
      repoUrl: null,
    },
    projectId: project.id,
  });
  await api.linkTaskResource({
    taskId: result.task.id,
    provider: "trello",
    kind: "trello_card",
    externalId: "card123",
    url: "https://trello.com/c/card123/review-auth",
  });

  const refreshed = await api.refreshTaskExternalDetails({ taskId: result.task.id });

  assert.equal(refreshed.connectionRequired, true);
  assert.equal(refreshed.task.body, "Review auth");
  assert.equal(refreshed.notice, "Please add a Trello connection to this project.");
});

test("local fallback leaves unsupported refresh links unchanged", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const project = await api.createProject({ name: "Access" });
  const result = await api.createTaskFromInput({
    input: "Review issue",
    parsed: {
      kind: "text",
      provider: null,
      externalId: null,
      url: null,
      title: "Review issue",
      repoUrl: null,
    },
    projectId: project.id,
  });
  await api.linkTaskResource({
    taskId: result.task.id,
    provider: "external",
    kind: "external_url",
    externalId: "https://example.com/docs/12",
    url: "https://example.com/docs/12",
  });

  const refreshed = await api.refreshTaskExternalDetails({ taskId: result.task.id });

  assert.equal(refreshed.connectionRequired, false);
  assert.equal(refreshed.task.body, "Review issue");
  assert.equal(refreshed.links[0].kind, "external_url");
});

test("local fallback enriches tasks with source metadata and requires github connections for refresh", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const project = await api.createProject({ name: "Access" });
  const result = await api.createTaskFromInput({
    input: "Review issue",
    parsed: {
      kind: "text",
      provider: null,
      externalId: null,
      url: null,
      title: "Review issue",
      repoUrl: null,
    },
    projectId: project.id,
  });
  await api.linkTaskResource({
    taskId: result.task.id,
    provider: "github",
    kind: "github_issue",
    externalId: "owner/repo#12",
    url: "https://github.com/owner/repo/issues/12",
  });

  const tasks = await api.listTasks({ projectId: project.id });
  assert.equal(tasks[0].sourceProvider, "github");
  assert.equal(tasks[0].sourceKind, "github_issue");

  const refreshed = await api.refreshTaskExternalDetails({ taskId: result.task.id });
  assert.equal(refreshed.connectionRequired, true);
  assert.equal(refreshed.notice, "Please add a GitHub connection to this project.");
});

test("local fallback enriches gitlab tasks and requires gitlab connections for refresh", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const project = await api.createProject({ name: "Access" });
  const result = await api.createTaskFromInput({
    input: "Review merge request",
    parsed: {
      kind: "merge_request",
      provider: "gitlab",
      externalId: "owner/repo!12",
      url: "https://gitlab.com/owner/repo/-/merge_requests/12",
      title: "Review merge request",
      repoUrl: "https://gitlab.com/owner/repo",
    },
    projectId: project.id,
  });

  const tasks = await api.listTasks({ projectId: project.id });
  assert.equal(tasks[0].sourceProvider, "gitlab");
  assert.equal(tasks[0].sourceKind, "merge_request");

  const refreshed = await api.refreshTaskExternalDetails({ taskId: result.task.id });
  assert.equal(refreshed.connectionRequired, true);
  assert.equal(refreshed.notice, "Please add a GitLab connection to this project.");
});

test("local fallback auto-connects github repo resources from provider tasks", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const project = await api.createProject({ name: "Access" });
  await api.createTaskFromInput({
    input: "Review issue",
    parsed: {
      kind: "github_issue",
      provider: "github",
      externalId: "owner/repo#12",
      url: "https://github.com/owner/repo/issues/12",
      title: "Review issue",
      repoUrl: "https://github.com/owner/repo",
    },
    projectId: project.id,
  });
  await api.createTaskFromInput({
    input: "Review pull request",
    parsed: {
      kind: "pull_request",
      provider: "github",
      externalId: "owner/repo#13",
      url: "https://github.com/owner/repo/pull/13",
      title: "Review pull request",
      repoUrl: "https://github.com/owner/repo",
    },
    projectId: project.id,
  });

  const resources = await api.listProjectResources({ projectId: project.id });

  assert.equal(resources.length, 1);
  assert.equal(resources[0].provider, "github");
  assert.equal(resources[0].kind, "github_repo");
  assert.equal(resources[0].externalId, "github.com/owner/repo");
  assert.equal(resources[0].url, "https://github.com/owner/repo");
});

test("local fallback auto-connects gitlab repos per project", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const firstProject = await api.createProject({ name: "Access" });
  const secondProject = await api.createProject({ name: "Portal" });
  const parsed = {
    kind: "merge_request",
    provider: "gitlab",
    externalId: "group/app!12",
    url: "https://gitlab.example.org/group/app/-/merge_requests/12",
    title: "Review merge request",
    repoUrl: "https://gitlab.example.org/group/app",
  };
  await api.createTaskFromInput({
    input: "Review merge request",
    parsed,
    projectId: firstProject.id,
  });
  await api.createTaskFromInput({
    input: "Review issue",
    parsed: {
      ...parsed,
      kind: "gitlab_issue",
      externalId: "group/app!14",
      url: "https://gitlab.example.org/group/app/-/issues/14",
      title: "Review issue",
    },
    projectId: firstProject.id,
  });
  await api.createTaskFromInput({
    input: "Review another merge request",
    parsed: {
      ...parsed,
      externalId: "group/app!13",
      url: "https://gitlab.example.org/group/app/-/merge_requests/13",
    },
    projectId: secondProject.id,
  });

  const firstResources = await api.listProjectResources({ projectId: firstProject.id });
  const secondResources = await api.listProjectResources({ projectId: secondProject.id });

  assert.equal(firstResources.length, 1);
  assert.equal(secondResources.length, 1);
  assert.equal(firstResources[0].kind, "gitlab_repo");
  assert.equal(secondResources[0].kind, "gitlab_repo");
  assert.equal(firstResources[0].externalId, "gitlab.example.org/group/app");
  assert.equal(secondResources[0].externalId, "gitlab.example.org/group/app");
  assert.notEqual(firstResources[0].id, secondResources[0].id);
});

test("local fallback preserves provider task status when update omits status", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const project = await api.createProject({ name: "Access" });
  const result = await api.createTaskFromInput({
    input: "Review pull request",
    parsed: {
      kind: "pull_request",
      provider: "github",
      externalId: "owner/repo#12",
      url: "https://github.com/owner/repo/pull/12",
      title: "Review pull request",
      repoUrl: "https://github.com/owner/repo",
    },
    projectId: project.id,
  });
  await api.updateTask({ id: result.task.id, status: "merged" });

  const updated = await api.updateTask({
    id: result.task.id,
    title: "Review pull request copy",
    body: "Updated body",
  });

  assert.equal(updated.status, "merged");
  assert.equal(updated.sourceProvider, "github");
  assert.equal(updated.sourceKind, "pull_request");
});

test("local fallback deletes tasks with links and relations", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const project = await api.createProject({ name: "Access" });
  const parent = await api.createTaskFromInput({
    input: "Review onboarding",
    parsed: {
      kind: "text",
      provider: null,
      externalId: null,
      url: null,
      title: "Review onboarding",
      repoUrl: null,
    },
    projectId: project.id,
  });
  const child = await api.createTaskFromInput({
    input: "Update docs",
    parsed: {
      kind: "text",
      provider: null,
      externalId: null,
      url: null,
      title: "Update docs",
      repoUrl: null,
    },
    projectId: project.id,
  });

  await api.linkTaskResource({
    taskId: parent.task.id,
    provider: "trello",
    kind: "trello_card",
    externalId: "card123",
    url: "https://trello.com/c/card123/review",
  });
  await api.saveTaskRelation({
    sourceTaskId: parent.task.id,
    targetTaskId: child.task.id,
    relationType: "related",
  });

  await api.deleteTask({ id: parent.task.id });

  assert.deepEqual(
    (await api.listTasks({ projectId: project.id })).map((task) => task.id),
    [child.task.id],
  );
  assert.equal((await api.listTaskLinks({ taskId: parent.task.id })).length, 0);
  assert.equal((await api.listTaskRelations({ taskId: child.task.id })).length, 0);
});

test("local fallback creates task relations and rejects duplicates/self-relations", async () => {
  let stored = "";
  global.localStorage = {
    getItem: () => stored,
    setItem: (_key, value) => {
      stored = value;
    },
  };

  const project = await api.createProject({ name: "Access", icon: "FolderKanban" });
  const parent = await api.createTaskFromInput({
    input: "Review onboarding",
    parsed: {
      kind: "text",
      provider: null,
      externalId: null,
      url: null,
      title: "Review onboarding",
      repoUrl: null,
    },
    projectId: project.id,
  });
  const child = await api.createTaskFromInput({
    input: "Update docs",
    parsed: {
      kind: "text",
      provider: null,
      externalId: null,
      url: null,
      title: "Update docs",
      repoUrl: null,
    },
    projectId: project.id,
  });

  await api.linkTaskResource({
    taskId: parent.task.id,
    provider: "trello",
    kind: "trello_card",
    externalId: "card123",
    url: "https://trello.com/c/card123/review",
    files: [
      {
        id: "attachment_1",
        name: "Design spec.pdf",
        url: "https://trello.com/1/cards/card123/attachments/attachment_1/download/spec.pdf",
        source: "trello",
        contentType: "application/pdf",
        bytes: 2048,
        createdAt: "2026-07-09T10:00:00.000Z",
      },
    ],
  });
  const trelloLinks = await api.listTaskLinks({ taskId: parent.task.id });
  assert.equal(trelloLinks[0].files.length, 1);
  assert.equal(trelloLinks[0].files[0].name, "Design spec.pdf");
  assert.equal(trelloLinks[0].files[0].source, "trello");

  await api.linkTaskResource({
    taskId: parent.task.id,
    provider: "github",
    kind: "github_issue",
    externalId: "owner/repo#12",
    url: "https://github.com/owner/repo/issues/12",
  });
  const links = await api.listTaskLinks({ taskId: parent.task.id });
  assert.equal(links.length, 1);
  assert.equal(links[0].kind, "github_issue");
  assert.deepEqual(links[0].files, []);

  const relation = await api.saveTaskRelation({
    sourceTaskId: parent.task.id,
    targetTaskId: child.task.id,
    relationType: "sub_task",
  });
  const duplicate = await api.saveTaskRelation({
    sourceTaskId: parent.task.id,
    targetTaskId: child.task.id,
    relationType: "sub_task",
  });

  assert.equal(relation.id, duplicate.id);
  assert.equal(relation.relatedTask.id, child.task.id);
  const relations = await api.listTaskRelations({ taskId: parent.task.id });
  assert.equal(relations.length, 1);
  assert.equal(relations[0].relatedTask.title, "Update docs");

  const updated = await api.saveTaskRelation({
    id: relation.id,
    sourceTaskId: parent.task.id,
    targetTaskId: child.task.id,
    relationType: "related",
  });
  assert.equal(updated.id, relation.id);
  assert.equal(updated.relationType, "related");

  await assert.rejects(
    () =>
      api.saveTaskRelation({
        sourceTaskId: parent.task.id,
        targetTaskId: parent.task.id,
        relationType: "related",
      }),
    /itself/,
  );
});
