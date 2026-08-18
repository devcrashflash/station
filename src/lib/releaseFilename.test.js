import assert from "node:assert/strict";
import test from "node:test";

import {
  dmgFilename,
  validateReleaseVersion,
  validateUpdaterManifest,
} from "../../scripts/release-utils.mjs";

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

test("accepts only stable release tags matching every version source", () => {
  assert.equal(validateReleaseVersion("0.10.6", {
    package: "0.10.6",
    tauri: "0.10.6",
    cargo: "0.10.6",
  }), "0.10.6");
  assert.throws(
    () => validateReleaseVersion("v0.10.6", { package: "0.10.6" }),
    /stable x\.y\.z/,
  );
  assert.throws(
    () => validateReleaseVersion("0.10.5", { package: "0.10.5" }),
    /first updater-enabled version 0\.10\.6/,
  );
  assert.throws(
    () => validateReleaseVersion("0.9.9", { package: "0.9.9" }),
    /first updater-enabled version/,
  );
  assert.equal(validateReleaseVersion("1.0.0", { package: "1.0.0" }), "1.0.0");
  assert.throws(
    () => validateReleaseVersion("0.10.6", { package: "0.10.5" }),
    /package=0\.10\.5/,
  );
});

test("validates both macOS updater entries against release assets", () => {
  const manifest = {
    version: "0.10.6",
    platforms: {
      "darwin-aarch64": {
        signature: "signed-arm",
        url: "https://github.com/devcrashflash/station/releases/download/0.10.6/Station_aarch64.app.tar.gz",
      },
      "darwin-x86_64": {
        signature: "signed-intel",
        url: "https://github.com/devcrashflash/station/releases/download/0.10.6/Station_x64.app.tar.gz",
      },
    },
  };
  const assets = new Set(["Station_aarch64.app.tar.gz", "Station_x64.app.tar.gz"]);
  assert.equal(validateUpdaterManifest(manifest, assets, "0.10.6"), manifest);
  assert.throws(
    () => validateUpdaterManifest(manifest, new Set(["Station_aarch64.app.tar.gz"]), "0.10.6"),
    /missing release asset Station_x64/,
  );
});
