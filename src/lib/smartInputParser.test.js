import test from "node:test";
import assert from "node:assert/strict";
import { parseSmartInput, plainTextTaskBody } from "./smartInputParser.js";

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

test("parses GitHub issue links", () => {
  const parsed = parseSmartInput("https://github.com/acme/app/issues/43");

  assert.equal(parsed.kind, "github_issue");
  assert.equal(parsed.provider, "github");
  assert.equal(parsed.externalId, "acme/app#43");
  assert.equal(parsed.repoUrl, "https://github.com/acme/app");
});

test("parses GitLab merge request links", () => {
  const parsed = parseSmartInput("https://gitlab.example.com/group/app/-/merge_requests/17");

  assert.equal(parsed.kind, "merge_request");
  assert.equal(parsed.provider, "gitlab");
  assert.equal(parsed.externalId, "group/app!17");
  assert.equal(parsed.repoUrl, "https://gitlab.example.com/group/app");
});

test("parses GitLab issue links", () => {
  const parsed = parseSmartInput("https://gitlab.example.com/group/app/-/issues/18");

  assert.equal(parsed.kind, "gitlab_issue");
  assert.equal(parsed.provider, "gitlab");
  assert.equal(parsed.externalId, "group/app!18");
  assert.equal(parsed.repoUrl, "https://gitlab.example.com/group/app");
});

test("parses GitLab.com merge request links", () => {
  const parsed = parseSmartInput("https://gitlab.com/group/subgroup/app/-/merge_requests/19");

  assert.equal(parsed.kind, "merge_request");
  assert.equal(parsed.provider, "gitlab");
  assert.equal(parsed.externalId, "group/subgroup/app!19");
  assert.equal(parsed.repoUrl, "https://gitlab.com/group/subgroup/app");
});

test("parses generic urls as external task links", () => {
  const parsed = parseSmartInput("https://example.com/docs/auth-flow");

  assert.equal(parsed.kind, "url");
  assert.equal(parsed.provider, null);
  assert.equal(parsed.externalId, "https://example.com/docs/auth-flow");
  assert.equal(parsed.title, "auth flow");
});

test("removes a matching opening title from a plain-text task body", () => {
  assert.equal(
    plainTextTaskBody("Review onboarding\n\nAdd tests", "Review onboarding"),
    "Add tests",
  );
});

test("removes a Tasks-prefixed opening title from a plain-text task body", () => {
  assert.equal(
    plainTextTaskBody(
      "Tasks: Create Task should not add title as description\n\nMy task",
      "Create Task should not add title as description",
    ),
    "My task",
  );
});

test("returns an empty body when plain-text input contains only its title", () => {
  assert.equal(plainTextTaskBody("Review onboarding", "Review onboarding"), "");
});

test("normalizes leading whitespace and CRLF when removing a plain-text title", () => {
  assert.equal(
    plainTextTaskBody("\r\n  Review   onboarding  \r\n\r\n  Add tests  \r\n", "Review onboarding"),
    "Add tests",
  );
});

test("preserves a nonmatching opening line in a plain-text task body", () => {
  assert.equal(
    plainTextTaskBody("Background context\n\nAdd tests", "Review onboarding"),
    "Background context\n\nAdd tests",
  );
});
