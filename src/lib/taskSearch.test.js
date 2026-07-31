import assert from "node:assert/strict";
import test from "node:test";

import {
  filterTasksByTitle,
  orderTasksByCompletion,
  preserveTaskOrder,
} from "./taskSearch.js";

const tasks = [
  { id: "first", title: "Fix login flow" },
  { id: "second", title: "Update documentation" },
  { id: "third", title: "Investigate Login timeout" },
];

test("returns every task for blank and whitespace-only queries", () => {
  assert.equal(filterTasksByTitle(tasks, ""), tasks);
  assert.equal(filterTasksByTitle(tasks, "   "), tasks);
});

test("filters task titles case-insensitively while preserving order", () => {
  assert.deepEqual(
    filterTasksByTitle(tasks, "LOGIN").map((task) => task.id),
    ["first", "third"],
  );
  assert.deepEqual(
    filterTasksByTitle(tasks, "doc").map((task) => task.id),
    ["second"],
  );
});

test("returns no tasks when no title matches", () => {
  assert.deepEqual(filterTasksByTitle(tasks, "missing"), []);
});

test("orders open tasks before done tasks while preserving each group's order", () => {
  const unorderedTasks = [
    { id: "done-first", status: "done" },
    { id: "open-first", status: "open" },
    { id: "done-second", status: "done" },
    { id: "open-second" },
  ];

  assert.deepEqual(
    orderTasksByCompletion(unorderedTasks).map((task) => task.id),
    ["open-first", "open-second", "done-first", "done-second"],
  );
  assert.deepEqual(
    unorderedTasks.map((task) => task.id),
    ["done-first", "open-first", "done-second", "open-second"],
  );
});

test("keeps provider-backed tasks in the open group regardless of external status", () => {
  const unorderedTasks = [
    { id: "local-done", status: "done" },
    {
      id: "trello-done",
      status: "done",
      sourceProvider: "trello",
      sourceKind: "trello_card",
    },
    {
      id: "github-closed",
      status: "closed",
      sourceProvider: "github",
      sourceKind: "github_issue",
    },
  ];

  assert.deepEqual(
    orderTasksByCompletion(unorderedTasks).map((task) => task.id),
    ["trello-done", "github-closed", "local-done"],
  );
});

test("orders search-filtered tasks with matching done tasks last", () => {
  const searchableTasks = [
    { id: "done-login", title: "Document login", status: "done" },
    { id: "unrelated", title: "Update dependencies", status: "open" },
    { id: "open-login", title: "Fix login", status: "open" },
  ];

  assert.deepEqual(
    orderTasksByCompletion(filterTasksByTitle(searchableTasks, "login")).map((task) => task.id),
    ["open-login", "done-login"],
  );
});

test("preserves the opened task order when statuses update", () => {
  const openedTasks = orderTasksByCompletion([
    { id: "done", status: "done" },
    { id: "open", status: "open" },
  ]);
  const taskIds = openedTasks.map((task) => task.id);
  const updatedTasks = [
    { id: "done", status: "done" },
    { id: "open", status: "done" },
  ];

  assert.deepEqual(
    preserveTaskOrder(updatedTasks, taskIds).map((task) => task.id),
    ["open", "done"],
  );
});

test("sorts a newly opened task collection and appends later additions without moving rows", () => {
  const openedTasks = [
    { id: "done", status: "done" },
    { id: "open", status: "open" },
  ];
  const replacementTasks = [
    { id: "other-done", status: "done" },
    { id: "other-open", status: "open" },
  ];

  assert.deepEqual(
    preserveTaskOrder(openedTasks).map((task) => task.id),
    ["open", "done"],
  );
  assert.deepEqual(
    preserveTaskOrder([...openedTasks, { id: "new", status: "open" }], ["open", "done"])
      .map((task) => task.id),
    ["open", "done", "new"],
  );
  assert.deepEqual(
    preserveTaskOrder(replacementTasks, ["open", "done"]).map((task) => task.id),
    ["other-open", "other-done"],
  );
});
