import assert from "node:assert/strict";
import test from "node:test";

import { createReadmeDemoState, seedReadmeDemoState } from "../demo/readmeDemoState.js";

test("builds a populated README fixture relative to the capture day", () => {
  const day = new Date(2026, 8, 24, 16, 0, 0);
  const state = createReadmeDemoState(day);

  assert.equal(state.projects[0].name, "Launchpad");
  assert.ok(state.tasks.length >= 4);
  assert.ok(state.smartInboxTodos.length >= 2);
  assert.ok(state.smartInboxProviderItems.some((item) => item.provider === "github"));
  assert.ok(state.activities.every((item) => new Date(item.occurredAt).getDate() === day.getDate()));
  assert.ok(state.calendarEvents.every((item) => new Date(item.startAt).getDate() === day.getDate()));
  assert.ok(JSON.stringify(state).includes("/Users/demo/"));
  assert.ok(!JSON.stringify(state).includes("alexanderschranz"));
});

test("seeds only the Station storage key and light theme", () => {
  const values = new Map([["unrelated", "keep-me"]]);
  const storage = {
    setItem(key, value) {
      values.set(key, value);
    },
  };

  seedReadmeDemoState(storage, new Date(2026, 8, 24));

  assert.equal(values.get("unrelated"), "keep-me");
  assert.equal(values.get("dcf-theme-preference-v1"), "light");
  assert.equal(JSON.parse(values.get("devcrashflash-station-state")).projects[0].id, "project_launchpad");
});
