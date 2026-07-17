import test from "node:test";
import assert from "node:assert/strict";

import { ErrorBoundary } from "../components/common/ErrorBoundary.js";
import {
  createLatestRequestGuard,
  isClosedReviewState,
  normalizeReviewDiffFile,
  normalizeReviewDiffResult,
  normalizeReviewDrafts,
} from "./reviewSession.js";

const validResult = {
  path: "/tmp/repository",
  branch: "origin/review/pr-393",
  baseRef: "origin/3.0",
  headSha: "f2d23d538e9e1b5ef82df44fac5f3dd5085aab45",
  files: ["config/services.xml", "src/Product.php", "composer.json"],
  currentFile: {
    path: "config/services.xml",
    oldPath: "config/services.xml",
    newPath: "config/services.xml",
    diff: "@@ -1 +1 @@\n-<old/>\n+<new/>",
  },
};

test("normalizes valid review data and supplies file path fallbacks", () => {
  assert.deepEqual(normalizeReviewDiffFile({ path: "src/Product.php", diff: "@@ -1 +1 @@" }), {
    path: "src/Product.php",
    oldPath: "src/Product.php",
    newPath: "src/Product.php",
    diff: "@@ -1 +1 @@",
  });
  assert.deepEqual(normalizeReviewDiffResult(validResult), validResult);
});

test("rejects malformed and incomplete review responses before rendering", () => {
  assert.throws(() => normalizeReviewDiffResult(null), /invalid review response/);
  assert.throws(() => normalizeReviewDiffResult({ ...validResult, files: null }), /changed-file list/);
  assert.throws(() => normalizeReviewDiffResult({ ...validResult, currentFile: null }), /first changed-file diff/);
  assert.throws(
    () => normalizeReviewDiffResult({ ...validResult, headSha: "" }),
    /reviewed commit SHA/,
  );
  assert.throws(
    () => normalizeReviewDiffResult({ ...validResult, currentFile: { path: "other.php", diff: "" } }),
    /outside its changed-file list/,
  );
});

test("normalizes draft lists and rejects non-list payloads", () => {
  assert.deepEqual(normalizeReviewDrafts([{ id: "draft-1" }, null, "bad"]), [{ id: "draft-1" }]);
  assert.throws(() => normalizeReviewDrafts({}), /invalid review-draft response/);
});

test("latest request guard makes obsolete responses harmless", () => {
  const guard = createLatestRequestGuard();
  const first = guard.begin();
  const second = guard.begin();
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.isCurrent(second), true);
  guard.invalidate();
  assert.equal(guard.isCurrent(second), false);
});

test("only closed and merged provider states suppress review", () => {
  assert.equal(isClosedReviewState("merged"), true);
  assert.equal(isClosedReviewState(" CLOSED "), true);
  assert.equal(isClosedReviewState("open"), false);
  assert.equal(isClosedReviewState("opened"), false);
  assert.equal(isClosedReviewState(null), false);
});

test("error boundary replaces a failed view with its recovery fallback", () => {
  const error = new Error("forced review renderer failure");
  const boundary = new ErrorBoundary({
    children: "review",
    fallback: ({ error: caught }) => `Recovered: ${caught.message}`,
  });
  boundary.state = ErrorBoundary.getDerivedStateFromError(error);

  assert.equal(boundary.render(), "Recovered: forced review renderer failure");
});
