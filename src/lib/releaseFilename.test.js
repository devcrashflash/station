import assert from "node:assert/strict";
import test from "node:test";

import { dmgFilename } from "../../scripts/release-utils.mjs";

test("creates a versioned Station DMG filename", () => {
  assert.equal(dmgFilename("0.6.0"), "Station_0_6_0.dmg");
});

test("keeps prerelease versions recognizable", () => {
  assert.equal(dmgFilename("0.6.0-beta.1"), "Station_0_6_0-beta_1.dmg");
});
