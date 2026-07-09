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
  });
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
