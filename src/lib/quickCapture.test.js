import assert from "node:assert/strict";
import test from "node:test";

import { quickCaptureTitle } from "./quickCapture.js";

test("uses the first non-empty line as the quick capture title", () => {
  assert.equal(quickCaptureTitle("\n  Review launcher flow  \nAdd tests"), "Review launcher flow");
});

test("falls back when quick capture input has no title", () => {
  assert.equal(quickCaptureTitle(" \n\t"), "Untitled todo");
});
