import test from "node:test";
import assert from "node:assert/strict";

import { aiPromptWorkspaceOptions } from "./aiPromptThread.js";

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
