import test from "node:test";
import assert from "node:assert/strict";
import { parseSmartInput } from "./smartInputParser.js";

test("parses plain text as a task", () => {
  assert.deepEqual(parseSmartInput("Review the onboarding PR"), {
    kind: "text",
    provider: null,
    externalId: null,
    url: null,
    title: "Review the onboarding PR",
  });
});

test("parses Trello board links", () => {
  const parsed = parseSmartInput("https://trello.com/b/abc123/project-board");

  assert.equal(parsed.kind, "trello_board");
  assert.equal(parsed.provider, "trello");
  assert.equal(parsed.externalId, "abc123");
  assert.equal(parsed.title, "project board");
});

test("parses Trello card links", () => {
  const parsed = parseSmartInput("https://trello.com/c/card123/review-auth-flow");

  assert.equal(parsed.kind, "trello_card");
  assert.equal(parsed.provider, "trello");
  assert.equal(parsed.externalId, "card123");
  assert.equal(parsed.title, "review auth flow");
});

test("parses GitHub pull request links", () => {
  const parsed = parseSmartInput("https://github.com/acme/app/pull/42");

  assert.equal(parsed.kind, "pull_request");
  assert.equal(parsed.provider, "github");
  assert.equal(parsed.externalId, "acme/app#42");
  assert.equal(parsed.repoUrl, "https://github.com/acme/app");
});

test("parses GitLab merge request links", () => {
  const parsed = parseSmartInput("https://gitlab.example.com/group/app/-/merge_requests/17");

  assert.equal(parsed.kind, "merge_request");
  assert.equal(parsed.provider, "gitlab");
  assert.equal(parsed.externalId, "group/app!17");
  assert.equal(parsed.repoUrl, "https://gitlab.example.com/group/app");
});
