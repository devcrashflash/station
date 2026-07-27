import test from "node:test";
import assert from "node:assert/strict";
import {
  aiPromptModeLabel,
  defaultAiPromptMode,
  normalizeAiPromptMode,
} from "./aiPromptMode.js";

test("defaults new Codex prompts to Plan and Claude prompts to Agent", () => {
  assert.equal(defaultAiPromptMode("codex"), "plan");
  assert.equal(defaultAiPromptMode("claude"), "agent");
});

test("normalizes legacy and provider-incompatible AI Prompt modes", () => {
  assert.equal(normalizeAiPromptMode("codex"), "plan");
  assert.equal(normalizeAiPromptMode("codex", "agent"), "agent");
  assert.equal(normalizeAiPromptMode("claude"), "agent");
  assert.equal(normalizeAiPromptMode("claude", "plan"), "agent");
});

test("formats supported AI Prompt mode labels", () => {
  assert.equal(aiPromptModeLabel("agent"), "Agent");
  assert.equal(aiPromptModeLabel("plan"), "Plan");
});
