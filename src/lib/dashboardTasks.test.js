import test from "node:test";
import assert from "node:assert/strict";

import {
  dashboardTaskCreatedAt,
  dashboardTaskProjectName,
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

test("dashboard task metadata resolves project names and missing values", () => {
  const projects = [{ id: "project-1", name: "Studio" }];

  assert.equal(dashboardTaskProjectName({ projectId: "project-1" }, projects), "Studio");
  assert.equal(dashboardTaskProjectName({ projectId: "missing" }, projects), "Unassigned");
  assert.equal(dashboardTaskProjectName({}, projects), "Unassigned");
  assert.equal(dashboardTaskCreatedAt({}), "Creation date unavailable");
});
