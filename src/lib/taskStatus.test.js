import test from "node:test";
import assert from "node:assert/strict";

import {
  isProviderBackedTask,
  isTaskDone,
  taskStatusBadgeLabel,
  taskStatusBadgeStyle,
} from "./taskStatus.js";

test("detects provider-backed task statuses", () => {
  assert.equal(isProviderBackedTask({ sourceProvider: "trello", sourceKind: "trello_card" }), true);
  assert.equal(isProviderBackedTask({ sourceProvider: "github", sourceKind: "github_issue" }), true);
  assert.equal(isProviderBackedTask({ sourceProvider: "github", sourceKind: "pull_request" }), true);
  assert.equal(isProviderBackedTask({ sourceProvider: "gitlab", sourceKind: "gitlab_issue" }), true);
  assert.equal(isProviderBackedTask({ sourceProvider: "gitlab", sourceKind: "merge_request" }), true);
  assert.equal(isProviderBackedTask({ sourceProvider: "gitlab", sourceKind: "gitlab_repo" }), false);
  assert.equal(isProviderBackedTask({ sourceProvider: null, sourceKind: null }), false);
});

test("uses local done state for plain tasks", () => {
  assert.equal(isTaskDone({ status: "done" }), true);
  assert.equal(isTaskDone({ status: "open" }), false);
});

test("treats closed GitHub pull requests and GitLab merge requests as done", () => {
  assert.equal(isTaskDone({ status: "open", sourceProvider: "github", sourceKind: "pull_request" }), false);
  assert.equal(isTaskDone({ status: "merged", sourceProvider: "github", sourceKind: "pull_request" }), true);
  assert.equal(isTaskDone({ status: " CLOSED ", sourceProvider: "github", sourceKind: "pull_request" }), true);
  assert.equal(isTaskDone({ status: "opened", sourceProvider: "gitlab", sourceKind: "merge_request" }), false);
  assert.equal(isTaskDone({ status: "MERGED", sourceProvider: "gitlab", sourceKind: "merge_request" }), true);
  assert.equal(isTaskDone({ status: "closed", sourceProvider: "gitlab", sourceKind: "merge_request" }), true);
});

test("keeps other provider-backed tasks out of the local done state", () => {
  assert.equal(isTaskDone({ status: "closed", sourceProvider: "github", sourceKind: "github_issue" }), false);
  assert.equal(isTaskDone({ status: "Done", sourceProvider: "trello", sourceKind: "trello_card" }), false);
});

test("shows new badge for open tasks without provider state", () => {
  assert.equal(taskStatusBadgeLabel({ status: "open" }), "new");
  assert.equal(taskStatusBadgeLabel({ status: "done" }), "done");
  assert.equal(
    taskStatusBadgeLabel({ status: "open", sourceProvider: "github", sourceKind: "github_issue" }),
    "open",
  );
});

test("uses readable Trello list colors only for Trello card badges", () => {
  assert.deepEqual(
    taskStatusBadgeStyle({
      sourceProvider: "trello",
      sourceKind: "trello_card",
      statusColor: "#f2d600",
    }),
    { backgroundColor: "#f2d600", color: "#111827" },
  );
  assert.equal(
    taskStatusBadgeStyle({
      sourceProvider: "trello",
      sourceKind: "trello_card",
      statusColor: "not-a-color",
    }),
    undefined,
  );
  assert.equal(
    taskStatusBadgeStyle({
      sourceProvider: "github",
      sourceKind: "github_issue",
      statusColor: "#f2d600",
    }),
    undefined,
  );
});
