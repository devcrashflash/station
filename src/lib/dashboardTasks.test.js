import test from "node:test";
import assert from "node:assert/strict";

import {
  dashboardTaskCreatedAt,
  dashboardTaskProjectName,
  filterDashboardTasks,
  latestDashboardTasks,
  sortDashboardTasks,
} from "./dashboardTasks.js";

test("dashboard tasks sort newest first with deterministic timestamp ties", () => {
  const tasks = [
    { id: "b", createdAt: 200 },
    { id: "newest", createdAt: 300 },
    { id: "a", createdAt: 200 },
  ];

  assert.deepEqual(sortDashboardTasks(tasks).map((task) => task.id), ["newest", "a", "b"]);
  assert.deepEqual(tasks.map((task) => task.id), ["b", "newest", "a"]);
});

test("dashboard tasks put missing timestamps last and apply limits", () => {
  const tasks = Array.from({ length: 25 }, (_, index) => ({
    id: `task-${String(index).padStart(2, "0")}`,
    createdAt: index === 0 ? null : index,
  }));

  assert.equal(latestDashboardTasks(tasks, 20).length, 20);
  assert.equal(latestDashboardTasks(tasks, 3).length, 3);
  assert.deepEqual(latestDashboardTasks(tasks, 3).map((task) => task.createdAt), [24, 23, 22]);
  assert.equal(sortDashboardTasks(tasks).at(-1).id, "task-00");
});

test("dashboard tasks exclude locally completed tasks before sorting and limiting", () => {
  const tasks = [
    { id: "older-open", createdAt: 100, status: "open" },
    { id: "newest-done", createdAt: 400, status: "done" },
    { id: "newer-open", createdAt: 300, status: "open" },
    { id: "oldest-open", createdAt: 50 },
  ];

  assert.deepEqual(
    filterDashboardTasks(tasks).map((task) => task.id),
    ["older-open", "newer-open", "oldest-open"],
  );
  assert.deepEqual(
    latestDashboardTasks(tasks, 2).map((task) => task.id),
    ["newer-open", "older-open"],
  );
});

test("dashboard tasks keep provider-backed tasks with externally completed statuses", () => {
  const tasks = [
    { id: "local-done", status: "done", createdAt: 300 },
    {
      id: "github-closed",
      status: "closed",
      sourceProvider: "github",
      sourceKind: "github_issue",
      createdAt: 200,
    },
    {
      id: "trello-done",
      status: "done",
      sourceProvider: "trello",
      sourceKind: "trello_card",
      createdAt: 100,
    },
  ];

  assert.deepEqual(
    latestDashboardTasks(tasks).map((task) => task.id),
    ["github-closed", "trello-done"],
  );
});

test("dashboard task metadata resolves project names and missing values", () => {
  const projects = [{ id: "project-1", name: "Studio" }];

  assert.equal(dashboardTaskProjectName({ projectId: "project-1" }, projects), "Studio");
  assert.equal(dashboardTaskProjectName({ projectId: "missing" }, projects), "Unassigned");
  assert.equal(dashboardTaskProjectName({}, projects), "Unassigned");
  assert.equal(dashboardTaskCreatedAt({}), "Creation date unavailable");
});
