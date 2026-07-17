import assert from "node:assert/strict";
import test from "node:test";

import {
  externalLabelForeground,
  externalLabelStyle,
  normalizeExternalLabelColor,
} from "./externalLabels.js";

test("normalizes valid external label colors", () => {
  assert.equal(normalizeExternalLabelColor(" #ABC "), "#aabbcc");
  assert.equal(normalizeExternalLabelColor("#61BD4F"), "#61bd4f");
  assert.equal(normalizeExternalLabelColor("red"), null);
  assert.equal(normalizeExternalLabelColor("#12345g"), null);
});

test("selects readable text for provider label colors", () => {
  assert.equal(externalLabelForeground("#f2d600"), "#111827");
  assert.equal(externalLabelForeground("#344563"), "#ffffff");
  assert.equal(externalLabelForeground(null), null);
});

test("returns no custom style when a label has no usable color", () => {
  assert.deepEqual(externalLabelStyle("#0079bf"), {
    backgroundColor: "#0079bf",
    color: "#ffffff",
  });
  assert.equal(externalLabelStyle(null), undefined);
});
