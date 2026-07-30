import assert from "node:assert/strict";
import test from "node:test";

import { filterSmartInboxItems } from "./smartInboxSearch.js";

test("returns the original items for blank Smart Inbox searches", () => {
  const items = [{ id: "one", title: "First" }];
  assert.equal(filterSmartInboxItems("todos", items, ""), items);
  assert.equal(filterSmartInboxItems("todos", items, "   "), items);
});

test("filters todos by identifying text while preserving order", () => {
  const todos = [
    { id: "one", title: "Capture invoice", rawText: "Accounting follow-up" },
    { id: "two", title: "Read notes", fileName: "ROADMAP.md", filePath: "/work/ROADMAP.md" },
    { id: "three", title: "Accounting review" },
  ];
  assert.deepEqual(
    filterSmartInboxItems("todos", todos, "ACCOUNTING").map((item) => item.id),
    ["one", "three"],
  );
  assert.deepEqual(
    filterSmartInboxItems("todos", todos, "roadmap.md").map((item) => item.id),
    ["two"],
  );
});

test("filters tasks by title and project name", () => {
  const tasks = [
    { id: "one", title: "Fix login", projectId: "station" },
    { id: "two", title: "Ship release", projectId: "website" },
    { id: "three", title: "Document login", projectId: "station" },
  ];
  const projects = [
    { id: "station", name: "Station" },
    { id: "website", name: "Website" },
  ];
  assert.deepEqual(
    filterSmartInboxItems("tasks", tasks, "station", projects).map((item) => item.id),
    ["one", "three"],
  );
  assert.deepEqual(
    filterSmartInboxItems("tasks", tasks, "release", projects).map((item) => item.id),
    ["two"],
  );
});

test("filters latest files by filename, directory, and path", () => {
  const files = [
    { path: "/work/design/mockup.png", name: "mockup.png", directoryName: "Design", relativePath: "mockup.png" },
    { path: "/work/docs/readme.md", name: "readme.md", directoryName: "Docs", relativePath: "docs/readme.md" },
  ];
  assert.deepEqual(
    filterSmartInboxItems("latest-files", files, "DESIGN").map((item) => item.name),
    ["mockup.png"],
  );
  assert.deepEqual(
    filterSmartInboxItems("latest-files", files, "/work/docs").map((item) => item.name),
    ["readme.md"],
  );
});

test("filters provider items by title, context, number, and connection", () => {
  const items = [
    { id: "one", title: "Fix auth", repoPath: "openai/station", number: 42, connectionName: "Work GitHub" },
    { id: "two", title: "Update docs", contextPath: "team/website", contextDetail: "Frontend", number: 7, connectionName: "GitLab" },
  ];
  assert.deepEqual(
    filterSmartInboxItems("github", items, "#42").map((item) => item.id),
    ["one"],
  );
  assert.deepEqual(
    filterSmartInboxItems("gitlab", items, "frontend").map((item) => item.id),
    ["two"],
  );
  assert.deepEqual(filterSmartInboxItems("trello", items, "missing"), []);
});
