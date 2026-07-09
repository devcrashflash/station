import test from "node:test";
import assert from "node:assert/strict";

import { isProviderBackedTask, isTaskDone } from "./taskStatus.js";

test("detects provider-backed task statuses", () => {
  assert.equal(isProviderBackedTask({ sourceProvider: "trello", sourceKind: "trello_card" }), true);
  assert.equal(isProviderBackedTask({ sourceProvider: "github", sourceKind: "github_issue" }), true);
  assert.equal(isProviderBackedTask({ sourceProvider: "github", sourceKind: "pull_request" }), true);
  assert.equal(isProviderBackedTask({ sourceProvider: "gitlab", sourceKind: "gitlab_issue" }), true);
  assert.equal(isProviderBackedTask({ sourceProvider: "gitlab", sourceKind: "merge_request" }), true);
  assert.equal(isProviderBackedTask({ sourceProvider: "gitlab", sourceKind: "gitlab_repo" }), false);
  assert.equal(isProviderBackedTask({ sourceProvider: null, sourceKind: null }), false);
});

test("only plain done tasks use local done state", () => {
  assert.equal(isTaskDone({ status: "done" }), true);
  assert.equal(isTaskDone({ status: "closed", sourceProvider: "github", sourceKind: "github_issue" }), false);
  assert.equal(isTaskDone({ status: "Done", sourceProvider: "trello", sourceKind: "trello_card" }), false);
});
