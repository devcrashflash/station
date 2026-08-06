import assert from "node:assert/strict";
import test from "node:test";

import { buildAllSmartInboxItems } from "./smartInboxAll.js";
import { filterAllSmartInboxItems } from "./smartInboxSearch.js";

test("builds a newest-first Smart Inbox feed from every category", () => {
  const items = buildAllSmartInboxItems({
    todos: [{ id: "todo", updatedAt: 200 }],
    tasks: [{ id: "task", createdAt: 500 }],
    files: [{ path: "/work/file.md", modifiedAt: 400 }],
    providerItems: {
      github: { items: [{ externalId: "github", sortAt: 600 }] },
      gitlab: { items: [{ externalId: "gitlab", updatedAt: 300 }] },
      trello: { items: [{ externalId: "trello", createdAt: 100 }] },
    },
  });

  assert.deepEqual(items.map(({ category }) => category), [
    "github",
    "tasks",
    "latest-files",
    "gitlab",
    "todos",
    "trello",
  ]);
});

test("uses timestamp fallbacks and keeps equal or missing timestamps deterministic", () => {
  const items = buildAllSmartInboxItems({
    todos: [
      { id: "todo-missing" },
      { id: "todo-new", createdAt: "2026-08-02T10:00:00Z" },
    ],
    tasks: [{ id: "task-missing" }],
    providerItems: {
      github: { items: [{ externalId: "provider-new", sortAt: "invalid", reviewRequestedAt: "2026-08-02T10:00:00Z" }] },
    },
  });

  assert.deepEqual(items.map(({ key }) => key), [
    "todos:todo-new",
    "github:provider-new",
    "todos:todo-missing",
    "tasks:task-missing",
  ]);
});

test("searches aggregate items using their category-specific fields", () => {
  const projects = [{ id: "project-1", name: "Station" }];
  const items = buildAllSmartInboxItems({
    todos: [{ id: "todo", title: "Write notes" }],
    tasks: [{ id: "task", title: "Ship release", projectId: "project-1" }],
    files: [{ path: "/work/design.png", name: "design.png", directoryName: "Assets" }],
    providerItems: {
      gitlab: { items: [{ externalId: "mr", title: "Refactor feed", number: 42 }] },
    },
  });

  assert.equal(filterAllSmartInboxItems(items, "station", projects)[0].category, "tasks");
  assert.equal(filterAllSmartInboxItems(items, "design", projects)[0].category, "latest-files");
  assert.equal(filterAllSmartInboxItems(items, "!42", projects)[0].category, "gitlab");
  assert.equal(filterAllSmartInboxItems(items, "missing", projects).length, 0);
  assert.equal(filterAllSmartInboxItems(items, "  ", projects), items);
});
