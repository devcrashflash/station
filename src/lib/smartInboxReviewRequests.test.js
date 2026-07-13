import test from "node:test";
import assert from "node:assert/strict";

import { reviewRequestInput, reviewRequestSubtitle } from "./smartInboxReviewRequests.js";

test("review request click input is only the provider url", () => {
  assert.equal(
    reviewRequestInput({
      title: "Review checkout flow",
      url: " https://github.com/acme/app/pull/42 ",
      repoPath: "acme/app",
      number: "42",
    }),
    "https://github.com/acme/app/pull/42",
  );
});

test("review request subtitle labels provider numbers", () => {
  assert.equal(
    reviewRequestSubtitle({
      provider: "gitlab",
      connectionName: "Work GitLab",
      repoPath: "group/app",
      number: "17",
    }),
    "group/app · !17 · Work GitLab",
  );
});

test("review request subtitle shows the ordering timestamp when available", () => {
  assert.match(
    reviewRequestSubtitle({
      provider: "github",
      connectionName: "GitHub",
      repoPath: "owner/repo",
      number: "42",
      sortAt: Date.UTC(2026, 6, 13, 9, 30),
      sortSource: "review_requested",
    }),
    /^owner\/repo · #42 · GitHub · Review requested /,
  );
});

test("trello card subtitle shows board, list, and connection", () => {
  assert.equal(
    reviewRequestSubtitle({
      provider: "trello",
      connectionName: "Work Trello",
      contextPath: "Studio",
      contextDetail: "Doing",
    }),
    "Studio · Doing · Work Trello",
  );
});
