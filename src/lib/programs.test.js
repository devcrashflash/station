import assert from "node:assert/strict";
import test from "node:test";

import {
  filterPrograms,
  highlightedProgramId,
  movedProgramId,
  normalizeProgramSearch,
  numberedProgram,
  programMatchScore,
} from "./programs.js";

const programs = [
  { id: "code", name: "Visual Studio Code" },
  { id: "studio", name: "Android Studio" },
  { id: "safari", name: "Safari" },
  { id: "cafe", name: "Café Manager" },
];

test("normalizes program searches case- and accent-insensitively", () => {
  assert.equal(normalizeProgramSearch("  CAFÉ   Manager "), "cafe manager");
  assert.equal(programMatchScore(programs[3], "cafe manager"), 0);
});

test("ranks exact, prefix, token-prefix, and substring matches", () => {
  assert.equal(programMatchScore({ name: "Code" }, "code"), 0);
  assert.equal(programMatchScore({ name: "Code Runner" }, "code"), 1);
  assert.equal(programMatchScore({ name: "Visual Studio Code" }, "vis co"), 2);
  assert.equal(programMatchScore({ name: "Xcode" }, "code"), 3);
  assert.equal(programMatchScore({ name: "Safari" }, "code"), null);
});

test("filters by relevance and alphabetizes equal matches", () => {
  assert.deepEqual(filterPrograms(programs, "studio").map(({ id }) => id), ["studio", "code"]);
  assert.deepEqual(filterPrograms(programs, "").map(({ id }) => id), ["studio", "cafe", "safari", "code"]);
});

test("keeps or repairs the highlighted program after filtering", () => {
  assert.equal(highlightedProgramId(programs, "safari"), "safari");
  assert.equal(highlightedProgramId(programs, "missing"), "code");
  assert.equal(highlightedProgramId([], "missing"), null);
});

test("moves program selection with wrapping", () => {
  assert.equal(movedProgramId(programs, "code", 1), "studio");
  assert.equal(movedProgramId(programs, "code", -1), "cafe");
  assert.equal(movedProgramId([], null, 1), null);
});

test("number selection is available only without a search query", () => {
  assert.equal(numberedProgram(programs, "2", "")?.id, "studio");
  assert.equal(numberedProgram(programs, "2", "code"), null);
  assert.equal(numberedProgram(programs, "0", ""), null);
});
