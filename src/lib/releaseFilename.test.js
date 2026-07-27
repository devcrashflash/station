import assert from "node:assert/strict";
import test from "node:test";

import { dmgFilename } from "../../scripts/release-utils.mjs";

test("creates a versioned Station DMG filename with Apple Silicon architecture", () => {
  assert.equal(dmgFilename("0.6.0", "arm64"), "Station_0_6_0_aarch64.dmg");
});

test("creates a versioned Station DMG filename with Intel architecture", () => {
  assert.equal(dmgFilename("0.6.0", "x64"), "Station_0_6_0_x64.dmg");
});

test("keeps prerelease versions recognizable", () => {
  assert.equal(
    dmgFilename("0.6.0-beta.1", "arm64"),
    "Station_0_6_0-beta_1_aarch64.dmg",
  );
});
