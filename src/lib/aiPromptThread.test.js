import test from "node:test";
import assert from "node:assert/strict";

import { aiPromptWorkspaceOptions, compactWorkspacePath } from "./aiPromptThread.js";

test("returns linked repository choices", () => {
  const options = aiPromptWorkspaceOptions([
    { id: "repo_1", name: "App", path: "/work/app", repoUrl: "https://github.com/acme/app" },
  ]);

  assert.deepEqual(options, [
    {
      id: "repository:repo_1",
      kind: "repository",
      name: "App",
      path: "/work/app",
      detail: "https://github.com/acme/app",
    },
  ]);
});

test("ignores linked repositories without paths", () => {
  assert.deepEqual(aiPromptWorkspaceOptions([{ id: "repo" }]), []);
});

test("does not include configured directories", () => {
  assert.deepEqual(
    aiPromptWorkspaceOptions([], [{ id: "dir", name: "Notes", path: "/work/notes" }]),
    [],
  );
});

test("compacts paths inside the current user's home directory", () => {
  assert.equal(
    compactWorkspacePath("/Users/alex/Projects/station", "/Users/alex"),
    "~/Projects/station",
  );
  assert.equal(compactWorkspacePath("/Users/alex", "/Users/alex/"), "~");
});

test("does not compact paths outside the current user's home directory", () => {
  assert.equal(
    compactWorkspacePath("/Users/alexander/Projects/station", "/Users/alex"),
    "/Users/alexander/Projects/station",
  );
  assert.equal(compactWorkspacePath("/work/station", "~"), "/work/station");
});
