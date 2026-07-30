import assert from "node:assert/strict";
import test from "node:test";

import {
  cycleProjectIndex,
  filterProjectChoices,
} from "./projectSwitcher.js";

const projects = [
  { id: "alpha", name: "Alpha" },
  { id: "beta", name: "Beta 2" },
  { id: "gamma", name: "Gamma" },
];

test("filters project names case-insensitively while preserving sidebar order", () => {
  const sidebarOrder = [projects[2], projects[0], projects[1]];
  assert.deepEqual(filterProjectChoices(sidebarOrder, "a").map((project) => project.id), ["gamma", "alpha", "beta"]);
  assert.deepEqual(filterProjectChoices(projects, "ALP").map((project) => project.id), ["alpha"]);
  assert.deepEqual(filterProjectChoices(projects, "2").map((project) => project.id), ["beta"]);
  assert.deepEqual(filterProjectChoices(projects, "missing"), []);
});

test("cycles choices in both directions and handles empty lists", () => {
  assert.equal(cycleProjectIndex(0, 3), 1);
  assert.equal(cycleProjectIndex(2, 3), 0);
  assert.equal(cycleProjectIndex(0, 3, -1), 2);
  assert.equal(cycleProjectIndex(-1, 3), 0);
  assert.equal(cycleProjectIndex(0, 0), -1);
});
