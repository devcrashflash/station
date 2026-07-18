import test from "node:test";
import assert from "node:assert/strict";

import { Prism } from "./prism.js";
import { classifyDiffLine, diffLanguageForPath, diffPaths, parseDiffLines, selectCommentRange, selectedCodeText } from "./reviewDiff.js";

test("classifies unified diff lines without treating file headers as changes", () => {
  assert.deepEqual(classifyDiffLine("diff --git a/app.js b/app.js"), {
    type: "metadata",
    marker: "",
    content: "diff --git a/app.js b/app.js",
  });
  assert.equal(classifyDiffLine("--- a/app.js").type, "metadata");
  assert.equal(classifyDiffLine("+++ b/app.js").type, "metadata");
  assert.equal(classifyDiffLine("index 123..456 100644").type, "metadata");
  assert.equal(classifyDiffLine("@@ -1,2 +1,3 @@").type, "hunk");
});

test("separates change and context markers from code content", () => {
  assert.deepEqual(classifyDiffLine("+const added = true;"), {
    type: "addition",
    marker: "+",
    content: "const added = true;",
  });
  assert.deepEqual(classifyDiffLine("-const removed = false;"), {
    type: "deletion",
    marker: "-",
    content: "const removed = false;",
  });
  assert.deepEqual(classifyDiffLine(" const unchanged = null;"), {
    type: "context",
    marker: " ",
    content: "const unchanged = null;",
  });
  assert.deepEqual(classifyDiffLine(""), {
    type: "context",
    marker: "",
    content: "",
  });
});

test("recognizes the no-newline marker", () => {
  assert.equal(classifyDiffLine("\\ No newline at end of file").type, "no-newline");
});

test("preserves the exact raw text when markers and content are recombined", () => {
  const lines = [
    "diff --git a/app.js b/app.js",
    "@@ -1 +1 @@",
    "-const value = false;",
    "+const value = true;",
    " const unchanged = null;",
    "\\ No newline at end of file",
    "",
  ];

  for (const line of lines) {
    const parsed = classifyDiffLine(line);
    assert.equal(`${parsed.marker}${parsed.content}`, line);
  }
});

test("maps common file extensions to Prism languages", () => {
  assert.equal(diffLanguageForPath("src/App.jsx"), "jsx");
  assert.equal(diffLanguageForPath("src/app.test.tsx"), "tsx");
  assert.equal(diffLanguageForPath("config/settings.JSON"), "json");
  assert.equal(diffLanguageForPath("styles/main.css"), "css");
  assert.equal(diffLanguageForPath("docs/readme.md"), "markdown");
  assert.equal(diffLanguageForPath("templates/icon.svg"), "markup");
  assert.equal(diffLanguageForPath("src/Controller.php"), "php");
});

test("registers PHP syntax highlighting with Prism", () => {
  const highlighted = Prism.highlight(
    '<?php function greet(string $name): string { return strtoupper("Hello"); }',
    Prism.languages.php,
    "php",
  );

  assert.match(highlighted, /token keyword/);
  assert.match(highlighted, /token variable/);
  assert.match(highlighted, /token string/);
  assert.match(highlighted, /token function/);
});

test("falls back to plain text for unsupported and extensionless files", () => {
  assert.equal(diffLanguageForPath("archive.data"), "plain");
  assert.equal(diffLanguageForPath("Dockerfile"), "plain");
  assert.equal(diffLanguageForPath(""), "plain");
});

test("tracks old and new line numbers across multiple hunks", () => {
  const lines = parseDiffLines([
    "@@ -2,3 +2,4 @@",
    " unchanged",
    "-removed",
    "+added",
    "+another",
    "@@ -20 +21 @@",
    " context",
  ].join("\n"));

  assert.deepEqual(
    lines.filter((line) => line.commentable).map(({ oldLine, newLine, side }) => ({ oldLine, newLine, side })),
    [
      { oldLine: 2, newLine: 2, side: "RIGHT" },
      { oldLine: 3, newLine: null, side: "LEFT" },
      { oldLine: null, newLine: 3, side: "RIGHT" },
      { oldLine: null, newLine: 4, side: "RIGHT" },
      { oldLine: 20, newLine: 21, side: "RIGHT" },
    ],
  );
});

test("does not expose metadata or no-newline markers as commentable lines", () => {
  const lines = parseDiffLines("--- a/file.js\n+++ b/file.js\n@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file");
  assert.equal(lines.filter((line) => line.commentable).length, 2);
  assert.equal(lines.at(-1).commentable, false);
});

test("extracts renamed and deleted diff paths", () => {
  assert.deepEqual(diffPaths("--- a/old.js\n+++ b/new.js", "new.js"), {
    oldPath: "old.js",
    newPath: "new.js",
  });
  assert.deepEqual(diffPaths("--- a/deleted.js\n+++ /dev/null", "deleted.js"), {
    oldPath: "deleted.js",
    newPath: "deleted.js",
  });
});

test("selects mixed multiline ranges in either direction within one hunk", () => {
  const lines = parseDiffLines("@@ -5,3 +5,3 @@\n context\n-old\n+new\n@@ -20 +20 @@\n later");
  const forward = selectCommentRange(lines, 1, 3);
  const backward = selectCommentRange(lines, 3, 1);
  assert.deepEqual([forward.firstIndex, forward.lastIndex], [1, 3]);
  assert.deepEqual([backward.firstIndex, backward.lastIndex], [1, 3]);
  assert.deepEqual(forward.lines.map((line) => line.type), ["context", "deletion", "addition"]);
});

test("clamps multiline ranges at hunk boundaries", () => {
  const lines = parseDiffLines("@@ -1 +1 @@\n-first\n+second\n@@ -10 +10 @@\n later");
  const range = selectCommentRange(lines, 1, lines.length - 1);
  assert.deepEqual([range.firstIndex, range.lastIndex], [1, 2]);
});

test("copies selected code without diff markers or line numbers", () => {
  const lines = parseDiffLines("@@ -5,2 +5,2 @@\n const oldValue = 1;\n-  return oldValue;\n+  return newValue;");
  const range = selectCommentRange(lines, 1, 3);

  assert.equal(selectedCodeText(range), "const oldValue = 1;\n  return oldValue;\n  return newValue;");
  assert.equal(selectedCodeText(null), "");
});
