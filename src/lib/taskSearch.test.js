import assert from "node:assert/strict";
import test from "node:test";

import { filterTasksByTitle } from "./taskSearch.js";

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
